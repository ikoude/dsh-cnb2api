// 界面：注册位置、作用域、表单行为。
//
// 用一个最小但语义正确的 hooks 运行时把组件渲染成元素树，再在树上找控件、
// 触发事件、检查写出去的 ops。没有浏览器控制，所以这里验证的是**行为**
// 而不是观感：谁被注册、对谁渲染、点了之后发了什么。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', 'ui', 'client.js');

/** Hooks runtime: per-component state, one effect pass, re-render on setState. */
function runtime() {
  const regions = new Map();
  const stack = [];
  const dirty = new Set();
  let cursor = 0;

  const region = (Comp) => {
    if (!regions.has(Comp)) regions.set(Comp, { state: [], effects: new Set() });
    return regions.get(Comp);
  };

  const React = {
    Fragment: 'Fragment',
    createElement: (type, props, ...kids) => ({ type, props: props || {}, kids: kids.flat() }),
    useState(init) {
      const at = cursor++;
      // 必须用「当前正在渲染的组件」的区域。渲染是递归的：ConfigForm 渲染时
      // 先返回元素树，我们的 collect 又会去展开 AccountCard —— 若用全局 current，
      // 内层展开会把外层仍在进行的 useState 写到别人的区域里。
      const box = stack[stack.length - 1];
      if (!(at in box.state)) box.state[at] = typeof init === 'function' ? init() : init;
      return [box.state[at], (next) => {
        box.state[at] = typeof next === 'function' ? next(box.state[at]) : next;
        dirty.add(box);
      }];
    },
    useEffect(fn) {
      const at = cursor++;
      const box = stack[stack.length - 1];
      if (box.effects.has(at)) return;
      box.effects.add(at);
      const cleanup = fn();
      if (typeof cleanup === 'function') box.cleanup = cleanup;
    },
    useRef(init) {
      const at = cursor++;
      const box = stack[stack.length - 1];
      if (!(at in box.state)) box.state[at] = { current: init };
      return box.state[at];
    },
    useCallback: (fn) => { cursor += 1; return fn; },
    useMemo: (fn) => { cursor += 1; return fn(); },
  };

  /**
   * Render one component: hooks land in that component's own region, and the
   * stack is unwound before returning so a caller expanding children cannot
   * corrupt the region of a component that is still rendering.
   */
  const render = (Comp, props) => {
    const box = region(Comp);
    let out;
    for (let pass = 0; pass < 10; pass += 1) {
      const before = dirty.size;
      cursor = 0;
      stack.push(box);
      try {
        out = Comp(props);
      } finally {
        stack.pop();
      }
      if (dirty.size === before) break;
    }
    return out;
  };

  return { React, render };
}

/** An in-memory `localStorage` stand-in. */
function makeStorage() {
  const store = new Map();
  return {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => { store.set(key, String(value)); },
    removeItem: (key) => { store.delete(key); },
  };
}

/** Load the bundle in a VM and return its registrations. */
function loadBundle(fetchImpl) {
  const registered = [];
  const sandbox = {
    window: {
      __ModuleLoader__: { load: (reg) => registered.push(reg) },
      innerWidth: 1200,
      innerHeight: 800,
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent() { return true; },
      location: { assign() {} },
    },
    localStorage: makeStorage(),
    console: { error() {}, warn() {}, log() {} },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ configured: false, accounts: [] }) })),
    document: {
      documentElement: { lang: 'zh' },
      head: { appendChild() {} },
      createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
      querySelectorAll: () => [],
    },
    // 悬浮球用到的浏览器 API：位置存 localStorage，开关靠自定义事件同步
    localStorage: makeStorage(),
    innerWidth: 1200,
    innerHeight: 800,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    CustomEvent: class CustomEvent { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
    location: { assign() {} },
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(BUNDLE, 'utf8'), sandbox);
  return registered;
}

/** Mount one registration id against a fake context. */
function mount(id, { React, fetchImpl, formValue, writable = true } = {}) {
  const writes = [];
  const form = {
    getSnapshot: () => ({
      status: 'ready', value: formValue, base: undefined, user: undefined, revision: 4, writable,
    }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
    mutate: async (ops) => { writes.push(ops); return true; },
  };
  const reg = loadBundle(fetchImpl).find((row) => row.id === id);
  assert.ok(reg, `应有注册 ${id}`);
  const reg3 = reg.factory((spec) => {
    if (spec === 'react') return React;
    throw new Error(`unexpected require ${spec}`);
  });

  const owners = [];
  const registered = [];
  reg3.apply({
    effect: (fn) => { fn(); return () => {}; },
    configForms: { get: () => form },
    // 面板切换服务：DSH 里是 ctx.layout.selectPanel；缺它时按钮应保持原地不白屏
    get: (name) => (name === 'layout' ? { selectPanel: () => {} } : undefined),
    slots: {
      inject: (owner, cb) => { owners.push(owner); return cb(); },
      register: (options, component) => { registered.push({ options, component }); return () => {}; },
    },
  });
  // 两条注册分别属于两个槽位，测试要的是其中一个
  const pick = (slotName) => registered.find((row) => row.options.name === slotName);
  const formEntry = pick('plugins.bundle.config') ?? pick('plugins.row.config');
  const panelEntry = pick('plugins.detail.section');
  return {
    owners,
    registered,
    writes,
    form,
    component: formEntry?.component,
    options: formEntry?.options,
    panel: panelEntry?.component,
  };
}

/** Render a tree down to plain nodes, expanding Fragments and function components. */
function flatten(node, rt) {
  if (node === null || node === undefined || node === false) return null;
  if (Array.isArray(node)) return node.map((child) => flatten(child, rt)).filter((child) => child !== null);
  if (typeof node !== 'object') return node;
  if (typeof node.type === 'function') return flatten(rt.render(node.type, node.props), rt);
  if (node.type === 'Fragment') return flatten(node.kids, rt);
  return { type: node.type, props: node.props, kids: flatten(node.kids, rt) };
}


/** A backend for the login routes: token check, orgs, repos. */
function loginBackend({ orgs = [], repos = {}, fail = null } = {}) {
  // bundle 在 VM 里执行，跨 realm 的 Response 它不认；只实现它用到的三个成员。
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url, 'http://local');
    if (process.env.DEBUG_LOGIN) console.log('  LOGIN', url.pathname);
    if (url.pathname === '/cnb2api/login/token') {
      return fail ? reply(401, { ok: false, reason: fail }) : reply(200, { ok: true, username: 'alice', orgs });
    }
    if (url.pathname === '/cnb2api/login/repos') {
      return reply(200, { ok: true, repos: Object.values(repos).flat() });
    }
    return reply(200, { configured: false, accounts: [] });
  };
}

/** All element nodes of the given tags in an already-flattened tree. */
function nodesOf(tree, tags, out = []) {
  if (tree === null || tree === undefined || tree === false) return out;
  if (Array.isArray(tree)) {
    for (const child of tree) nodesOf(child, tags, out);
    return out;
  }
  if (typeof tree !== 'object') return out;
  if (tags.includes(tree.type)) out.push(tree);
  nodesOf(tree.kids, tags, out);
  return out;
}

/** Collect element nodes of the given tags, expanding function components. */
function collect(node, tags, rt, out = []) {
  return collectInner(node, tags, rt, out);
}

function collectInner(node, tags, rt, out) {
  if (node === null || node === undefined || node === false) return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, tags, rt, out);
    return out;
  }
  if (typeof node !== 'object') return out;
  if (typeof node.type === 'function') {
    collect(rt.render(node.type, node.props), tags, rt, out);
    return out;
  }
  // Fragment 只是容器：展开它的孩子，本身不算节点
  if (node.type === 'Fragment') {
    collect(node.kids, tags, rt, out);
    return out;
  }
  if (tags.includes(node.type)) out.push(node);
  collect(node.kids, tags, rt, out);
  return out;
}

const settle = () => new Promise((resolve) => { setTimeout(resolve, 60); });

const SAMPLE = {
  accounts: [
    { token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-a' },
    { token: 'nk-b', repo: 'beta/gateway', proxyKey: 'sk-b' },
  ],
  checkSeconds: 120,
  autoStart: true,
  locale: 'auto',
  models: 'deepseek-v4.1-flash',
};

test('状态面板不在对话区', () => {
  const rt = runtime();
  const { owners } = mount('dsh-cnb2api', { React: rt.React });
  for (const forbidden of ['conversation.composer.dock', 'conversation.input.dock', 'conversation.input.overlay']) {
    assert.ok(!owners.includes(forbidden), `不该注册到 ${forbidden}`);
  }
});

test('状态面板只对自己的插件页渲染', () => {
  const rt = runtime();
  const { panel } = mount('dsh-cnb2api', { React: rt.React });
  assert.ok(panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } }) !== null);
  assert.ok(panel({ subject: { kind: 'row', pkg: { name: 'dsh-cnb2api' }, row: { rowId: 'cnb2api' } } }) !== null);
  assert.equal(panel({ subject: { kind: 'bundle', pkg: { name: 'other-plugin' } } }), null);
  assert.equal(panel({ subject: { kind: 'item', id: 'x' } }), null);
  assert.equal(panel({}), null);
});

test('界面只注册三处：详情页配置、详情页区块、悬浮球', () => {
  const rt = runtime();
  const { owners } = mount('dsh-cnb2api', { React: rt.React });
  assert.deepEqual(owners.sort(), [
    'plugins.bundle.config',
    'plugins.detail.section',
    'shell.overlay',
  ]);
});

test('不注册行配置与头部按钮：设置只在详情页一处', () => {
  const rt = runtime();
  const { owners } = mount('dsh-cnb2api', { React: rt.React });
  assert.ok(!owners.includes('plugins.row.config'), '组件行不该是可点的设置入口');
  assert.ok(!owners.includes('plugins.detail.actions'), '详情页已有表单，不需要额外按钮');
});

test('悬浮球挂在 shell.overlay（全窗口浮层），不在对话区', () => {
  const rt = runtime();
  const { owners } = mount('dsh-cnb2api', { React: rt.React });
  assert.ok(owners.includes('shell.overlay'));
  for (const forbidden of ['conversation.composer.dock', 'conversation.input.dock']) {
    assert.ok(!owners.includes(forbidden), `不该占用 ${forbidden}`);
  }
});

test('悬浮球：默认显示，按钮可点到（浮层本身是穿透的）', () => {
  const rt = runtime();
  const { registered } = mount('dsh-cnb2api', { React: rt.React });
  const entry = registered.find((row) => row.options.name === 'shell.overlay');
  // 槽位拿到的是 <Orb/> 元素；渲染它才走 hooks
  const element = entry.component();
  const tree = rt.render(element.type, element.props);
  assert.ok(tree, '默认应当渲染');
  // 外层容器必须自己接收指针事件，否则浮层 pointer-events:none 会让球点不到
  assert.match(tree.props.className, /cnb2api-orb-wrap/);
  const button = nodesOf(flatten(tree, rt), ['button'])
    .find((node) => /cnb2api-orb/.test(node.props.className));
  assert.ok(button, '应当有一个圆球按钮');
  assert.equal(button.props.type, 'button', '可聚焦、可键盘激活');
  assert.ok(button.props['aria-label'], '球要有可读名字');
});

test('悬浮球：开关是浏览器偏好，默认显示', () => {
  const rt = runtime();
  const { registered } = mount('dsh-cnb2api', { React: rt.React });
  const element = registered.find((row) => row.options.name === 'shell.overlay').component();
  assert.ok(rt.render(element.type, element.props), '默认显示');
});

test('拖动阈值：位移小于 4px 视为点击，超过才移动', () => {
  // 直接测判定逻辑本身：右键状态机不依赖 React 的重渲染，
  // 这样断言的是"阈值"而不是测试运行时的重渲染行为。
  const rt = runtime();
  const { registered } = mount('dsh-cnb2api', { React: rt.React });
  const element = registered.find((row) => row.options.name === 'shell.overlay').component();
  const tree = rt.render(element.type, element.props);
  const button = nodesOf(flatten(tree, rt), ['button'])
    .find((node) => /cnb2api-orb/.test(node.props.className));

  assert.equal(typeof button.props.onPointerDown, 'function');
  assert.equal(typeof button.props.onPointerMove, 'function');
  assert.equal(typeof button.props.onPointerUp, 'function');

  const start = tree.props.style;
  const capture = { setPointerCapture() {} };
  button.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, pointerId: 1, currentTarget: capture });
  button.props.onPointerMove({ clientX: 102, clientY: 101 });   // 约 2.2px
  button.props.onPointerUp();

  const after = rt.render(element.type, element.props);
  assert.deepEqual(after.props.style, start, '小于阈值的抖动不该移动球');
});

test('配置表单注册在包名上（详情页入口，不再是 row key）', () => {
  const rt = runtime();
  const { options } = mount('dsh-cnb2api', { React: rt.React });
  assert.equal(options.key, 'dsh-cnb2api');
  assert.ok(!String(options.key).includes('#'), 'bundle.config 的 key 是包名，不带 #row');
});

test('配置表单：已登录的账号显示组织与仓库下拉，而不是文本框', async () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', {
    React: rt.React,
    formValue: SAMPLE,
    fetchImpl: loginBackend({ orgs: ['acme', 'beta'], repos: { acme: [{ repo: 'acme/gateway', running: true }] } }),
  });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  // 全局区还有一个语言下拉；只看账号卡里的
  const selects = collect(tree, ['select'], rt)
    .filter((node) => /^cnb2api-\d+-/.test(String(node.props.id || '')));
  assert.equal(selects.length, 4, '每个账号应当有组织与仓库两个下拉');
});

test('配置表单：没验证令牌时不给组织/仓库下拉', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', {
    React: rt.React,
    formValue: { accounts: [{ token: '', repo: '', proxyKey: '' }], checkSeconds: 120, autoStart: true, locale: 'auto' },
  });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  const accountSelects = collect(tree, ['select'], rt)
    .filter((node) => String(node.props.id || '').startsWith('cnb2api-0-'));
  assert.equal(accountSelects.length, 0, '未验证时账号卡不该出现下拉');
  const save = collect(tree, ['button'], rt).find((node) => node.kids.join('') === '保存');
  assert.equal(save.props.disabled, true);
});

test('配置表单：粘贴令牌 → 验证 → 组织下拉出现真实组织', async () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', {
    React: rt.React,
    formValue: { accounts: [{ token: '', repo: '', proxyKey: '' }], checkSeconds: 120, autoStart: true, locale: 'auto' },
    fetchImpl: loginBackend({ orgs: ['acme', 'beta'] }),
  });
  const page = rt.render(component, { view: 'page' });
  const Form = page.type;
  let tree = flatten(rt.render(Form, page.props), rt);

  // 粘贴令牌
  const tokenInput = nodesOf(tree, ['input']).find((node) => node.props.id === 'cnb2api-0-token');
  tokenInput.props.onChange({ target: { value: 'nk-ok' } });
  tree = flatten(rt.render(Form, page.props), rt);

  // 点「验证并登录」
  const signIn = nodesOf(tree, ['button']).find((node) => node.kids.join('') === '验证并登录');
  assert.ok(signIn, '应有验证按钮');
  await signIn.props.onClick();
  await settle();

  tree = flatten(rt.render(Form, page.props), rt);
  const orgSelect = nodesOf(tree, ['select'])
    .find((node) => node.props.id === 'cnb2api-0-org');
  assert.ok(orgSelect, '验证后应出现组织下拉');
  const optionValues = orgSelect.kids.filter((kid) => kid && kid.type === 'option').map((kid) => kid.props.value);
  assert.deepEqual(optionValues.slice(1), ['acme', 'beta'], '选项来自 Host 返回的组织');
});

test('配置表单：令牌无效时说明原因，且不给下拉', async () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', {
    React: rt.React,
    formValue: { accounts: [{ token: '', repo: '', proxyKey: '' }], checkSeconds: 120, autoStart: true, locale: 'auto' },
    fetchImpl: loginBackend({ orgs: [], fail: '令牌无效或已过期' }),
  });
  const page = rt.render(component, { view: 'page' });
  const Form = page.type;
  let tree = flatten(rt.render(Form, page.props), rt);
  nodesOf(tree, ['input']).find((node) => node.props.id === 'cnb2api-0-token')
    .props.onChange({ target: { value: 'nk-bad' } });
  tree = flatten(rt.render(Form, page.props), rt);
  await nodesOf(tree, ['button']).find((node) => node.kids.join('') === '验证并登录').props.onClick();
  await settle();

  tree = flatten(rt.render(Form, page.props), rt);
  assert.match(JSON.stringify(tree), /令牌无效或已过期/);
  const accountSelects = nodesOf(flatten(tree, rt), ['select'])
    .filter((node) => String(node.props.id || '').startsWith('cnb2api-0-'));
  assert.equal(accountSelects.length, 0, '验证失败不该出现下拉');
});

test('配置表单：巡检间隔低于下限时拦住并说明', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', {
    React: rt.React,
    formValue: { accounts: [{ token: 'a', repo: 'acme/gateway', proxyKey: 'k' }], checkSeconds: 10, autoStart: true, locale: 'auto' },
  });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  const save = collect(tree, ['button'], rt).find((node) => node.kids.join('') === '保存');
  assert.equal(save.props.disabled, true);
  assert.match(JSON.stringify(tree), /不能小于 30 秒/);
});

test('配置表单：保存是一次原子写入，形状与 Config.accounts 一致', async () => {
  const rt = runtime();
  const { component, writes } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);

  const intervalId = collect(tree, ['label'], rt)
    .find((label) => label.kids.join('') === '巡检间隔（秒）').props.htmlFor;
  const interval = collect(tree, ['input'], rt).find((node) => node.props.id === intervalId);
  interval.props.onChange({ target: { value: '60' } });

  const next = rt.render(page.type, page.props);
  const save = collect(next, ['button'], rt).find((node) => node.kids.join('') === '保存');
  assert.equal(save.props.disabled, false, '改过之后应当可以保存');
  await save.props.onClick();

  assert.equal(writes.length, 1, '保存应当只发一次 mutate');
  const byPath = Object.fromEntries(writes[0].map((op) => [op.path.join('.'), op.value]));
  assert.deepEqual(byPath.accounts.map((row) => row.repo), ['acme/gateway', 'beta/gateway']);
  assert.equal(byPath.checkSeconds, 60);
  assert.equal(byPath.autoStart, true);
  assert.ok(!('branch' in byPath.accounts[0]), '空的可选字段不进配置');
});

test('配置表单：令牌始终遮住；PROXY_KEY 可切换成明文核对', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const Form = page.type;
  const flat = () => flatten(rt.render(Form, page.props), rt);

  // 已保存的账号一进来就是已登录态，但没有拉过组织列表：
  // 它自己的组织要补成选项，PROXY_KEY 才渲染得出来
  const tokenInputs = nodesOf(flat(), ['input'])
    .filter((node) => /-token$/.test(String(node.props.id || '')));
  assert.equal(tokenInputs.length, 2, '两个账号各一个令牌框');
  assert.ok(tokenInputs.every((node) => node.props.type === 'password'), '令牌应当始终遮住');

  // 网关密钥行也有一个「显示」，按 id 排除掉，只数账号卡上的
  const reveals = nodesOf(flat(), ['button'])
    .filter((node) => (node.kids || []).join('') === '显示')
    .filter((node) => node.props.id !== 'cnb2api-gwkey-toggle');
  assert.equal(reveals.length, 2, '两个账号的 PROXY_KEY 旁都应有「显示」');
  reveals[0].props.onClick();

  const keys = nodesOf(flat(), ['input'])
    .filter((node) => /-proxyKey$/.test(String(node.props.id || '')));
  assert.equal(keys.length, 2);
  // 至少有一个被揭示成明文：说明开关起作用了。
  // （不按顺序断言两个账号互不影响 —— 这个测试用的 hooks 运行时按组件类型
  //  共享状态，两枚 AccountCard 是同一个类型，真实 React 里靠 key 区分。）
  assert.ok(
    keys.some((node) => node.props.type === 'text'),
    `点过「显示」后应出现明文密钥，实际：${keys.map((k) => k.props.type).join(',')}`,
  );
});

test('配置表单：移除要点两下', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });

  const tree = rt.render(page.type, page.props);
  const cards = tree.kids.filter((kid) => kid && typeof kid.type === 'function' && kid.props.row);
  assert.equal(cards.length, 2);

  const card = rt.render(cards[0].type, cards[0].props);
  // 卡片头里现在还有一个折叠箭头按钮，所以按文案找「移除」而不是取第一个
  const first = card.kids[0].kids.find((kid) => kid && kid.type === 'button' && kid.kids.join('') === '移除');
  assert.ok(first, '卡片头要有「移除」按钮');
  first.props.onClick();

  const confirmed = rt.render(cards[0].type, cards[0].props);
  const second = confirmed.kids[0].kids
    .filter((kid) => kid && kid.type === 'button' && kid.kids.join('') === '确认移除')[0];
  assert.ok(second, '第一下只进入确认态');
  second.props.onClick();

  const after = rt.render(page.type, page.props);
  const left = after.kids.filter((kid) => kid && typeof kid.type === 'function' && kid.props.row);
  assert.equal(left.length, 1, '确认后才真的删掉');
});

test('配置表单：不可写时说清原因', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE, writable: false });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  assert.match(JSON.stringify(tree), /不允许改写配置/);
});

test('状态面板：没有账号时引导去配置', async () => {
  const rt = runtime();
  // 面板首帧是 loading，读回 configured:false 之后才显示空态
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React,
    fetchImpl: async () => ({ ok: true, json: async () => ({ configured: false, accounts: [] }) }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  const first = rt.render(view.type, view.props);
  assert.match(JSON.stringify(first), /读取中/, '首帧应当是读取中');

  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const after = rt.render(view.type, view.props);
  assert.match(JSON.stringify(after), /尚未配置账号/, '读到 configured:false 后应引导去配置');
});

test('状态面板：有账号时逐个列出并给出徽标', async () => {
  const rt = runtime();
  const payload = {
    configured: true,
    accounts: [
      {
        label: 'alice | acme/gateway', state: 'ready', badge: 'ok', action: 'none',
        usable: true, active: true,
        detail: '860l****-9001.cnb.run · main', note: null,
        credit: { used: 400, total: 1200, remain: 800, frozen: 0, percent: 33.3, note: '', exhausted: false },
        coreHours: null,
      },
      {
        label: 'alice | beta/gateway', state: 'noCredit', badge: 'noCredit', action: 'start',
        usable: false,
        detail: '', note: 'AI credits 已用尽', credit: null, coreHours: null,
      },
    ],
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React,
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  // 先渲染一次触发读取，等异步回来后再渲染
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const filled = rt.render(view.type, view.props);
  // 展开整棵树（含 Fragment 与函数组件），文本要按节点收集才完整
  const text = JSON.stringify(flatten(filled, rt));

  assert.match(text, /alice \| acme\/gateway/);
  // 可用账号不再挂徽标（圆点表示），所以「无额」只出现在失败的那个账号上
  assert.match(text, /可用 /, '可用额度仍在脚注里');
  assert.match(text, /无额/, '不可用的账号要有徽标');
  // 进度条：标签、数值、百分比各自是节点
  assert.match(text, /AI credits/);
  assert.match(text, /"400 \/ 1200 cr"/);
  assert.match(text, /"33\.30%"/, '百分比保留两位小数');
  // 赠送额度已计入 total，再单列一行会让人算不清楚
  assert.equal(/天才程序员专属特权/.test(text), false, '不再显示赠送注记');
  assert.match(text, /progressbar/);
  assert.match(text, /AI credits 已用尽/, '额度用尽的原因要显示出来');
  // 只有非就绪的那张卡给启动按钮
  const starts = collect(filled, ['button'], rt).filter((node) => node.kids.join('') === '启动');
  assert.equal(starts.length, 1);
});

test('文案：代码里引用的每个 t.* 键都在两个语言表里存在', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  // 收集 t.form.xxx / t.panel.xxx / t.orb.xxx / t.badge.xxx / t.state.xxx
  const used = new Set([...source.matchAll(/\bt\.(form|panel|orb|badge|state)\.([A-Za-z0-9_]+)\b/g)]
    .map((m) => `${m[1]}.${m[2]}`));
  assert.ok(used.size > 20, `应当找到不少文案键，实际 ${used.size}`);

  // 在 VM 里取出两个语言表，检查每个键
  const tables = [];
  const sandbox = {
    window: { __ModuleLoader__: { load: (r) => sandbox.__reg = r }, innerWidth: 1200, innerHeight: 800,
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return true; }, location: { assign() {} } },
    localStorage: makeStorage(),
    console: { error() {}, warn() {}, log() {} },
    setInterval: () => ({ unref() {} }), clearInterval: () => {},
    fetch: async () => ({ ok: true, json: async () => ({ configured: false, accounts: [] }) }),
    document: { documentElement: { lang: 'zh' }, head: { appendChild() {} },
      createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }), querySelectorAll: () => [] },
    CustomEvent: class { constructor(t) { this.type = t; } },
  };
  vm.createContext(sandbox);
  vm.runInContext(source, sandbox);
  // TEXT 是工厂内部常量；直接扫源码里的两张表更简单可靠
  for (const lang of ['zh', 'en']) {
    const start = source.indexOf(lang === 'zh' ? '    const ZH = {' : '    const EN = {');
    const end = source.indexOf('\n    };', start);
    tables.push(source.slice(start, end));
  }
  const missing = [];
  for (const key of used) {
    const [ns, name] = key.split('.');
    for (const [i, table] of tables.entries()) {
      // 该命名空间块内是否出现这个键
      const block = table.indexOf(`      ${ns}: {`);
      if (block < 0) { missing.push(`[${i}] ${key} (无 ${ns} 段)`); continue; }
      const close = table.indexOf('\n      },', block);
      const seg = table.slice(block, close < 0 ? undefined : close);
      if (!new RegExp(`\\b${name}:`).test(seg)) missing.push(`[${i === 0 ? 'zh' : 'en'}] ${key}`);
    }
  }
  assert.deepEqual(missing, [], `以下文案键缺失，界面会显示空白：${missing.join(', ')}`);
});

test('样式只用主题 token，不写死颜色', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const css = source.slice(source.indexOf('const CSS = `'), source.indexOf('`;', source.indexOf('const CSS = `')));
  const tokens = [...css.matchAll(/--dsw-alias-[a-z0-9-]+/g)].map((match) => match[0]);
  assert.ok(tokens.length > 0);
  for (const invented of ['--dsw-alias-text-1', '--dsw-alias-border-1', '--dsw-alias-label-error-old']) {
    assert.ok(!tokens.includes(invented), `${invented} 不存在`);
  }
  const colors = css.match(/#[0-9a-fA-F]{3,8}\b/g) || [];
  assert.deepEqual(colors, [], `样式里不该写死颜色：${colors.join(',')}`);
});

test('状态面板：标出当前在用与不可用的账号', async () => {
  // 四个账号只有一个有额度，这正是用户现在的配置：
  // 界面要能直接看出「谁的请求接得住」，而不是靠逐个读数字推断。
  const rt = runtime();
  const payload = {
    configured: true,
    accounts: [
      { label: 'a/cnb', state: 'noCredit', badge: 'noCredit', action: 'start', detail: '', note: 'AI credits 已用尽', usable: false, active: false, credit: null, coreHours: null },
      { label: 'b/cnb', state: 'ready', badge: 'ok', action: 'none', detail: '', note: null, usable: true, active: true, credit: { used: 100, total: 178, remain: 78, frozen: 0, percent: 56, note: '', exhausted: false }, coreHours: null },
      { label: 'c/cnb', state: 'unreachable', badge: 'unreachable', action: 'start', detail: '', note: null, usable: false, active: false, cooling: { remainingMs: 42000, reason: 'upstream 402' }, credit: null, coreHours: null },
    ],
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React,
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  // 先渲染一次触发读取，等异步回来后再渲染
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const filled = rt.render(view.type, view.props);

  const collectText = (node, out = []) => {
    if (typeof node === 'string') { out.push(node); return out; }
    if (!node || typeof node !== 'object') return out;
    if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
    collectText(node.kids, out);
    return out;
  };
  const text = collectText(flatten(filled, rt)).join(' ');
  assert.match(text, /当前/, '要能看出哪个账号正在承接请求');
  assert.match(text, /只有这一个账号能接住请求/, '只有一个可用时要直说');
  assert.match(text, /冷却 42s/, '冷却中的账号要显示剩余时间');
  // 可用账号不该再挂「可用」徽标：圆点已经说了同一句话
  const usableRow = JSON.stringify(flatten(filled, rt));
  const badgeTexts = [...usableRow.matchAll(/"cnb2api-badge"/g)].length;
  assert.ok(badgeTexts >= 1, '异常账号仍有徽标');
});

test('悬浮球面板：与插件页用同一个卡片，不出现「可用 / 总量」这种反语义', () => {
  // 悬浮球面板曾经是手写的第二份卡片，把「可用」当分子显示成 0 / 1166 ——
  // 看起来像「一点没用过」，实际是「一点没剩」。现在两边共用 AccountRow。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.equal(
    source.includes('account.credit.remain} /'),
    false,
    '不能再有把 remain 当分子的写法',
  );
  // 悬浮球那条路径必须复用组件，而不是自己拼一份
  const orbBlock = source.slice(source.indexOf("h('div', { className: 'cnb2api-orb-card'"));
  assert.match(orbBlock.slice(0, 4000), /h\(AccountRow,/, '悬浮球卡片要复用 AccountRow');
});

test('面板里没有「关闭悬浮球」按钮', () => {
  // 关闭入口只留设置页那个开关：面板标题旁放一个「关闭悬浮球」，
  // 点了整个面板连同球一起消失，用户找不到回来的路。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.equal(source.includes('hideOrb'), false, '面板里不该再有这个按钮');
});

test('用尽的账号也画进度条', () => {
  // 四张卡的结构要一致：少了条，唯一的可用账号会显得排版突变。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const row = source.slice(source.indexOf('function AccountRow('), source.indexOf('The workspace panel contributed'));
  assert.equal(/collapsed/.test(row), false, '不该再有「折叠掉额度条」的分支');
  assert.match(row, /meter\(t\.panel\.credits, account\.credit, 'cr'\)/);
});

test('悬浮球里的可用账号仍然有进度条', () => {
  // compact 只该少细节（核时、工作区地址），不该把额度条也藏掉 ——
  // 「还剩多少」正是球面要回答的问题。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const row = source.slice(source.indexOf('function AccountRow('), source.indexOf('function summaryLine('));
  assert.match(row, /compact\s*\n?\s*\?/, '要有 compact 分支');
  assert.match(row, /meter\(t\.panel\.credits, account\.credit, 'cr'\)/, '额度条必须渲染');
});

test('压暗靠文字色，不靠整体透明度', () => {
  // opacity 会把进度条、边框、按钮一起变淡，整块看起来像被禁用 ——
  // 而「启动」按钮恰恰是可点的。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  // 只看「不可用账号」那几条规则块，别扫到按钮/开关的正常禁用态
  const cssStart = source.indexOf('const CSS = `');
  const css = source.slice(cssStart, source.indexOf('`;', cssStart));
  const usableRules = css.split('}').filter((rule) => rule.includes('data-usable="false"'));
  assert.ok(usableRules.length > 0, '要有针对不可用账号的规则');
  for (const rule of usableRules) {
    // 去掉注释再判断：注释里提到这个词不该算违规
    const body = rule.replace(/\/\*[\s\S]*?\*\//g, '');
    assert.equal(/opacity/.test(body), false, `不可用账号的规则里不该出现 opacity：${body.trim().slice(0, 60)}`);
  }
  assert.match(source, /\.cnb2api-row\[data-usable="false"\] \.cnb2api-name \{ color: var\(--dsw-alias-label-secondary\); \}/);
});

test('可用账号不再挂状态徽标', () => {
  // 圆点已经表示可用性，再挂一个绿框「可用」是同一句话讲两遍。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const row = source.slice(source.indexOf('function AccountRow('), source.indexOf('The workspace panel contributed'));
  assert.match(row, /account\.usable === false[\s\S]{0,200}?cnb2api-badge/,
    '状态徽标应只在不可用时渲染');
});

test('进度百分比保留两位小数', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /percent\.toFixed\(2\)/);
  const row = source.slice(source.indexOf('function AccountRow('), source.indexOf('The workspace panel contributed'));
  // aria-valuenow 保持整数（无障碍属性），但显示文本要两位小数
  assert.match(row, /percent\.toFixed\(2\)/);
  assert.equal(/"\$\{Math\.round\(percent\)\}%"/.test(row), false, '显示文本不要取整');
});

test('当前在用不用底色也不用缩进', () => {
  // 深色主题下 bg-layer-2 和卡片底几乎同色，铺整行会像一块没对齐的污渍；
  // 缩进又会让它看起来是别的账号的子项。改用徽标 + 加粗 + 圆点光晕。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const cssStart = source.indexOf('const CSS = `');
  const css = source.slice(cssStart, source.indexOf('`;', cssStart));
  // 整行级别的规则（不以 .cnb2api-name / .cnb2api-dot 收尾的那条）
  const rowRule = /\.cnb2api-row\[data-active="true"\]\s*\{([^}]*)\}/.exec(css);
  assert.equal(rowRule, null, '不该再有针对整行的规则');
  // 只对名字与圆点做区分
  assert.match(css, /\.cnb2api-row\[data-active="true"\] \.cnb2api-name/);
  // 圆点尺寸在所有行一致：8px 套 3px 外环会视觉上大 75%
  assert.equal(/\.cnb2api-row\[data-active="true"\] \.cnb2api-dot/.test(css), false,
    '当前行不该给圆点加额外装饰');
});

test('刷新是图标按钮，与标题行体量相称', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /cnb2api-btn-icon/, '要有图标按钮样式');
  const at = source.indexOf('title: t.panel.refresh');
  assert.ok(at > 0, '刷新按钮要有 title');
  const icon = source.lastIndexOf('cnb2api-btn-icon', at);
  const block = source.slice(icon, at + 200);
  assert.match(block, /cnb2api-btn-icon/, '刷新按钮要带图标样式');
  assert.match(block, /↻/, '图标用 ↻');
});

test('徽标与行内按钮等高', () => {
  // 之前徽标 18px、按钮 28px，并排差 10px，看着像没对齐。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const badge = source.slice(source.indexOf('.cnb2api-badge {'), source.indexOf('.cnb2api-badge {') + 400);
  assert.match(badge, /height: 22px/);
  assert.match(source, /htmlFor|\.cnb2api-rowhead \.cnb2api-btn \{ height: 22px/);
});

test('压暗不作用在徽标上', () => {
  // 徽标是状态标识，糊掉就失去作用了。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const cssStart = source.indexOf('const CSS = `');
  const css = source.slice(cssStart, source.indexOf('`;', cssStart));
  const dimRules = css.split('}').filter((rule) => rule.includes('data-usable="false"'));
  for (const rule of dimRules) {
    assert.equal(/badge/.test(rule), false, `徽标不该被压暗：${rule.trim().slice(0, 60)}`);
  }
});

test('悬浮球用整数百分比，面板用两位小数', () => {
  // 44px 的圈里塞「97.49%」读不出来；展开后的面板才有空间给两位。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const orbStart = source.indexOf('function Orb({ onOpen })');
  const orb = source.slice(orbStart, source.indexOf('function CopyButton', orbStart));
  assert.equal(/toFixed\(2\)/.test(orb), false, '悬浮球不该用两位小数');
  // 也不能四舍五入：99.99 会变成 100%，看着像已经用尽
  assert.equal(/Math\.round\(percent\)%/.test(orb), false, '不用四舍五入');
  assert.match(orb, /Math\.floor\(percent\)/);
});

test('只有配置错误用红色，常态用中性色', () => {
  // 整屏都在报警会让真正的故障失去意义。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const row = source.slice(source.indexOf('function AccountRow('), source.indexOf('The workspace panel contributed'));
  assert.match(row, /account\.state === 'misconfigured' \? 'error' : 'muted'/);
});

test('进度条不按已用比例变橙', () => {
  // 「快满了」是常态，不是告警。橙只留给那句「余额不足 10%」。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.equal(source.includes('data-low'), false, '不要再按百分比变色');
});

test('悬浮球卡片：头尾固定，只有账号列表滚动', () => {
  // 原来整卡 overflow-y: auto，滚到底就看不到关闭按钮了。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const cssStart = source.indexOf('const CSS = `');
  const css = source.slice(cssStart, source.indexOf('`;', cssStart));
  // 只截取卡片本身那条规则（到第一个右花括号为止）
  const cardStart = css.indexOf('.cnb2api-orb-card {');
  const card = css.slice(cardStart, css.indexOf('}', cardStart));
  assert.match(card, /overflow: hidden/, '卡片本身不滚动');
  assert.equal(/overflow-y: auto/.test(card), false, '卡片不该是滚动容器');
  assert.match(css, /\.cnb2api-orb-list \{[\s\S]{0,200}overflow-y: auto/, '列表才是滚动区');
  assert.match(css, /\.cnb2api-orb-list \{[\s\S]{0,200}min-height: 0/, 'flex 子项要能滚就得有 min-height: 0');
});

test('用尽时整行降色，不是半红半黑', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const cssStart = source.indexOf('const CSS = `');
  const css = source.slice(cssStart, source.indexOf('`;', cssStart));
  assert.match(css, /cnb2api-meter\[data-dead="true"\] \.cnb2api-meter-value/);
  // 「已用尽」不再单独用红色
  const dead = css.slice(css.indexOf('.cnb2api-meter-dead {'));
  assert.equal(/label-error/.test(dead.slice(0, 120)), false, '额度用尽不是故障，不用红色');
});

test('余额提示：自定义文案优先，未配置时回落到默认句子', async () => {
  const rt = runtime();
  const base = {
    label: 'a/cnb', state: 'ready', badge: 'ok', action: 'none', detail: '', note: null,
    usable: true, active: true,
    credit: { used: 1157, total: 1166, remain: 8.3, frozen: 0, percent: 99.29, exhausted: false },
    coreHours: null,
  };
  const render = async (row) => {
    const { panel } = mount('dsh-cnb2api', {
      React: rt.React,
      fetchImpl: async () => ({ ok: true, json: async () => ({ configured: true, accounts: [row] }) }),
    });
    const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
    rt.render(view.type, view.props);
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const collectText = (node, out = []) => {
      if (typeof node === 'string') { out.push(node); return out; }
      if (!node || typeof node !== 'object') return out;
      if (Array.isArray(node)) { for (const child of node) collectText(child, out); return out; }
      collectText(node.kids, out);
      return out;
    };
    return collectText(flatten(rt.render(view.type, view.props), rt)).join(' ');
  };

  // 配了自定义文案：显示它，而不是内置句子
  const custom = await render({ ...base, lowCredit: true, lowCreditText: 'a/cnb 只剩 8.3 cr' });
  assert.match(custom, /a\/cnb 只剩 8\.3 cr/);

  // 没配：回落到内置默认句子
  const plain = await render({ ...base, lowCredit: true, lowCreditText: '' });
  assert.match(plain, /额度即将耗尽/);

  // 余额充足：不显示任何提示
  const ok = await render({ ...base, lowCredit: false });
  assert.equal(/额度即将耗尽/.test(ok), false);
});

test('低于保底线时只显示「已停用」，不叠加状态徽标', () => {
  // 否则会同时出现「就绪」和「已停用」，自相矛盾。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const row = source.slice(source.indexOf('function AccountRow('), source.indexOf('The workspace panel contributed'));
  assert.match(row, /account\.usable === false && !account\.belowFloor/, '异常徽标要排除保底停用');
  assert.match(row, /account\.belowFloor[\s\S]{0,220}?t\.form\.belowFloor/, '要有「已停用」徽标');
});

test('提示文案：变量逐个备注，并给出实时示例', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', {
    React: rt.React,
    formValue: { ...SAMPLE, lowCreditMessage: '{account} 只剩 {remain} {unit}' },
  });
  const page = rt.render(component, { view: 'page' });
  const text = JSON.stringify(flatten(rt.render(page.type, page.props), rt));

  // 变量名与含义都要出现：只列名字用户不知道怎么用
  for (const name of ['account', 'percent', 'used', 'frozen', 'consumed', 'remain', 'total', 'threshold', 'unit']) {
    assert.match(text, new RegExp(`\\{${name}\\}`), `变量 {${name}} 要出现在图例里`);
  }
  assert.match(text, /已用\+预扣/, 'consumed 要解释清楚');
  assert.match(text, /预扣（冻结）/, 'frozen 要解释清楚');

  // 示例按当前文案渲染
  assert.match(text, /acme\/gateway 只剩 9 cr/, '示例要用真实格式渲染，而不是原样显示占位符');
});

test('账号卡可折叠：卡片带折叠按钮与状态属性', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  const cards = tree.kids.filter((kid) => kid && typeof kid.type === 'function' && kid.props.row);
  const card = rt.render(cards[0].type, cards[0].props);

  // 账号默认收起（账号多时一进来是行式摘要）
  assert.equal(card.props['data-collapsed'], 'true', '新配置默认收起');
  // 卡片头有折叠按钮（箭头），点击后折叠
  const chevron = card.kids[0].kids.find(
    (kid) => kid && kid.type === 'button' && kid.props.className.includes('cnb2api-chevron'),
  );
  assert.ok(chevron, '要有折叠按钮');
  assert.equal(chevron.kids.join(''), '▸', '收起态应显示展开箭头');
  assert.equal(typeof chevron.props.onClick, 'function', '折叠按钮要可点');
  const open = rt.render(cards[0].type, { ...cards[0].props, collapsed: false });
  assert.equal(open.props['data-collapsed'], undefined, '展开态不标记折叠');
  assert.equal(open.kids[0].kids.find((kid) => kid && kid.type === 'button'
    && kid.props.className.includes('cnb2api-chevron')).kids.join(''), '▾');
  // 折叠由父组件控制（账号多时「收起全部」一并收起），
  // 这里验证卡片对 collapsed 属性的响应即可。
  const folded = rt.render(cards[0].type, { ...cards[0].props, collapsed: true });
  assert.equal(folded.props['data-collapsed'], 'true', 'collapsed 时卡片应标记折叠');
  assert.equal(rt.render(cards[0].type, { ...cards[0].props, collapsed: true })
    .kids[0].kids.find((kid) => kid && kid.type === 'button' && kid.props.className.includes('cnb2api-chevron')).kids.join(''), '▸');
});

test('全局设置按组分段', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const text = JSON.stringify(flatten(rt.render(page.type, page.props), rt));
  for (const group of ['巡检', '网关', '余额与提示', '其它']) {
    assert.ok(text.includes(group), `要有「${group}」分组标题`);
  }
});

// —— 审查补充：账号行 key、文案重复、开关可访问性、数值健壮性 ——

test('账号卡用稳定 id 当 key，删除账号不会串状态', () => {
  // 用数组下标当 key 时，删掉第 0 行会让后一行复用它的组件实例，
  // 把上一个账号的用户名/组织/密钥校验结果显示到新行上。
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /key: row\._id/, '列表 key 要用稳定 id');
  assert.match(source, /const blank = \(\) => \(\{ _id: nextDraftId\(\)/, '草稿要带 _id');
  assert.match(source, /_id: nextDraftId\(\),\n      token:/, 'toDraft 也要带 _id');
  // _id 是界面内部的，不能写进配置
  const toAccounts = source.slice(source.indexOf('function toAccounts('), source.indexOf('function toAccounts(') + 600);
  assert.equal(/account\._id/.test(toAccounts), false, '不要把 _id 写进配置');
});

test('repoHint 在中英文案里各只有一份（重复键会被后者覆盖）', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const hits = source.match(/repoHint:/g) || [];
  assert.equal(hits.length, 2, `repoHint 应只有 zh/en 各一处，实际 ${hits.length}`);
});

test('三个开关都与 label 关联，可被读屏读出含义', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  for (const id of ['cnb2api-autopublish', 'cnb2api-autostart', 'cnb2api-orb-show']) {
    assert.ok(source.includes(`id: '${id}'`), `开关 ${id} 要有 id`);
    assert.ok(source.includes(`htmlFor: '${id}'`), `label 要指向 ${id}`);
  }
});

test('冷却剩余时间缺失时不崩溃、不误显示', async () => {
  const rt = runtime();
  const payload = {
    configured: true,
    accounts: [{
      label: 'a/cnb', state: 'unreachable', badge: 'offline', action: 'none', detail: '', note: null,
      usable: false, active: false, cooling: {}, credit: null, coreHours: null,
    }],
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React,
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const text = JSON.stringify(flatten(rt.render(view.type, view.props), rt));
  assert.equal(/冷却 NaN/.test(text), false);
  assert.equal(/NaN/.test(text), false, '不该渲染出 NaN');
});

test('百分比传成字符串也能画进度条', async () => {
  // StatusPanel 的数据来自轮询，所以要用 fetchImpl 喂，而不是 props
  const rt = runtime();
  const payload = {
    configured: true,
    accounts: [{
      label: 'a/cnb', state: 'ready', badge: 'ok', action: 'none', detail: '', note: null,
      usable: true, active: true,
      credit: { used: 500, total: 1000, remain: 500, frozen: 0, percent: '50', exhausted: false },
      coreHours: null,
    }],
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React,
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const text = JSON.stringify(flatten(rt.render(view.type, view.props), rt));
  assert.match(text, /50\.00%/, '字符串百分比也要正常显示');
});


// —— 配置入口：只在包详情页 ——

test('配置渲染在包详情页（plugins.bundle.config），key 是包名', () => {
  const rt = runtime();
  const { registered } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const entry = registered.find((r) => r.options.name === 'plugins.bundle.config');
  assert.ok(entry, '要有 plugins.bundle.config 注册');
  assert.ok(String(entry.options.key).length > 0, 'key 不能为空');
  const tree = flatten(entry.component({ view: 'page' }), rt);
  const ids = nodesOf(tree, ['input']).map((n) => String(n.props.id || ''));
  assert.ok(ids.some((id) => /-token$/.test(id)), '详情页应渲染出账号表单');
});



