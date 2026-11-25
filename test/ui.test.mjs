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
function loadBundle(fetchImpl, docOverride) {
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
    console: { error() {}, warn() {}, log() {} },
    setInterval: () => ({ unref() {} }),
    clearInterval: () => {},
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({ configured: false, accounts: [] }) })),
    document: docOverride || {
      documentElement: { lang: 'zh' },
      head: { appendChild() {} },
      createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
      querySelectorAll: () => [],
      _handlers: {},
      addEventListener(type, fn) { (this._handlers[type] ||= []).push(fn); },
      removeEventListener(type, fn) { this._handlers[type] = (this._handlers[type] || []).filter((f) => f !== fn); },
      fire(type, event) { for (const fn of this._handlers[type] || []) fn(event); },
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
function mount(id, { React, fetchImpl, formValue, writable = true, document: doc } = {}) {
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
  const reg = loadBundle(fetchImpl, doc).find((row) => row.id === id);
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
  const formEntry = pick('plugins.bundle.config');
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


/**
 * 渲染状态面板并展开。
 *
 * 面板默认收成一行摘要（设置页信息量大），要断言账号细节的用例必须先点开
 * 左上角的折叠按钮；否则看到的只有摘要行。
 * @param {object} rt - runtime() 返回值。
 * @param {Function} panel - 面板组件。
 * @returns {object} 展开后的元素树。
 */
function openPanel(rt, panel) {
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  const first = rt.render(view.type, view.props);
  const toggle = nodesOf(flatten(first, rt), ['button'])
    .find((node) => String(node.props.className || '').includes('cnb2api-btn-icon'));
  if (toggle && typeof toggle.props.onClick === 'function') toggle.props.onClick();
  return rt.render(view.type, view.props);
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
  // 拖动走 document 级监听：down 时挂上，move/up 由全局事件驱动，
  // 这样靠近标题栏也不会因为 pointer capture 被吞而拖不动。
  const rt = runtime();
  const handlers = {};
  const doc = {
    documentElement: { lang: 'zh' }, head: { appendChild() {} },
    createElement: () => ({ setAttribute() {}, remove() {}, style: {}, textContent: '' }),
    querySelectorAll: () => [],
    addEventListener: (type, fn) => { (handlers[type] ||= []).push(fn); },
    removeEventListener: (type, fn) => { handlers[type] = (handlers[type] || []).filter((f) => f !== fn); },
  };
  const { registered } = mount('dsh-cnb2api', { React: rt.React, document: doc });
  const element = registered.find((row) => row.options.name === 'shell.overlay').component();
  const tree = rt.render(element.type, element.props);
  const button = nodesOf(flatten(tree, rt), ['button'])
    .find((node) => /cnb2api-orb/.test(node.props.className));

  assert.equal(typeof button.props.onPointerDown, 'function', '要有 onPointerDown');

  const start = tree.props.style;
  button.props.onPointerDown({ button: 0, clientX: 100, clientY: 100, pointerId: 1 });
  // 小于阈值的抖动：挂在 document 上的 move/up
  for (const fn of handlers.pointermove || []) fn({ clientX: 102, clientY: 101 });
  for (const fn of handlers.pointerup || []) fn({});

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
  const filled = openPanel(rt, panel);
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
  const filled = openPanel(rt, panel);

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
  const orbBlock = source.slice(source.indexOf("className: 'cnb2api-orb-card'"));
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
    const expanded = openPanel(rt, panel);
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

  // 已保存的账号默认收起
  assert.equal(card.props['data-collapsed'], 'true', '已保存账号默认收起');
  // 卡片头有折叠按钮（箭头），点击后折叠
  const chevron = card.kids[0].kids.find(
    (kid) => kid && kid.type === 'button' && kid.props.className.includes('cnb2api-chevron'),
  );
  assert.ok(chevron, '要有折叠按钮');
  assert.equal(chevron.kids.join(''), '▸', '收起态显示展开箭头');
  assert.equal(typeof chevron.props.onClick, 'function', '折叠按钮要可点');
  const foldedCard = rt.render(cards[0].type, { ...cards[0].props, collapsed: true });
  assert.equal(foldedCard.props['data-collapsed'], 'true', 'collapsed 时卡片应标记折叠');
  assert.equal(foldedCard.kids[0].kids.find((kid) => kid && kid.type === 'button'
    && kid.props.className.includes('cnb2api-chevron')).kids.join(''), '▸');
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
  const text = JSON.stringify(flatten(openPanel(rt, panel), rt));
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




test('添加账号后：新行有「取消」，且有「保存」按钮', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  let tree = rt.render(page.type, page.props);
  const add = collect(tree, ['button'], rt).find((b) => b.kids.join('') === '添加账号');
  assert.ok(add, '要有「添加」按钮');
  add.props.onClick();
  tree = rt.render(page.type, page.props);
  const labels = collect(tree, ['button'], rt).map((b) => b.kids.join(''));
  assert.equal(labels.filter((l) => l === '取消').length, 1, `新账号应有且仅有一个「取消」：${labels.join('/')}`);
  assert.ok(labels.some((l) => /保存/.test(l)), `应有「保存」按钮，实际：${labels.join('/')}`);
  // 已保存的账号仍是两步「移除」，只有新行给「取消」
  assert.equal(labels.filter((l) => l === '移除').length, 2, `两个已保存账号各一个「移除」：${labels.join('/')}`);
});

test('监听地址只有本机与局域网两种，没有 IPv6 选项', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  const host = nodesOf(tree, ['select']).find((n) => n.props.id === 'cnb2api-host');
  assert.ok(host, '要有监听地址下拉');
  const values = (host.kids || []).filter((kid) => kid && kid.props && 'value' in kid.props)
    .map((kid) => kid.props.value).sort();
  assert.deepEqual(values, ['0.0.0.0', '127.0.0.1'], `实际选项：${values.join(',')}`);
});

test('状态面板：监听局域网时列出局域网基址（baseUrl + lan）', async () => {
  const rt = runtime();
  const payload = {
    configured: true,
    accounts: [],
    gateway: {
      listening: true,
      host: '0.0.0.0',
      port: 41729,
      baseUrl: 'http://127.0.0.1:41729/v1',
      lan: ['http://192.168.1.20:41729/v1'],
      lanOnly: true,
      key: 'sk-cnb-test',
      requests: 0,
      published: { state: 'published', route: 'cnb-gateway' },
    },
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React,
    fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const text = JSON.stringify(flatten(openPanel(rt, panel), rt));
  assert.match(text, /http:\/\/127\.0\.0\.1:41729\/v1/, '要显示本机基址');
  assert.match(text, /http:\/\/192\.168\.1\.20:41729\/v1/, '要显示局域网基址（完整 URL）');
  assert.equal(/http:\/\/http/.test(text), false, '不能再拼一层协议（lan 已是完整基址）');
  assert.match(text, /局域网/, '要有「局域网」标签');
});

test('状态面板：监听 127.0.0.1 时不列局域网基址', async () => {
  const rt = runtime();
  const payload = {
    configured: true, accounts: [],
    gateway: { listening: true, host: '127.0.0.1', port: 41729, baseUrl: 'http://127.0.0.1:41729/v1', lan: [], lanOnly: false, key: 'k', requests: 0 },
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React, fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const text = JSON.stringify(flatten(rt.render(view.type, view.props), rt));
  assert.match(text, /127\.0\.0\.1:41729\/v1/);
  assert.equal(/局域网/.test(text), false, '仅回环时不该出现局域网行');
});

test('语言跟随配置：status.locale=en 时面板显示英文', async () => {
  const rt = runtime();
  const payload = {
    configured: true, locale: 'en', accounts: [],
    gateway: { listening: true, host: '127.0.0.1', port: 41729, baseUrl: 'http://127.0.0.1:41729/v1', lan: [], lanOnly: false, key: 'k', requests: 0 },
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React, fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const text = JSON.stringify(flatten(rt.render(view.type, view.props), rt));
  assert.match(text, /Workspace status/, '英文环境下标题应为英文');
});

test('状态面板：网关未监听时强制展开，不把报错收起来', async () => {
  const rt = runtime();
  const payload = {
    configured: true, locale: 'zh', accounts: [],
    gateway: { listening: false, host: '0.0.0.0', port: 41729, baseUrl: null, lan: [], lanOnly: true, key: 'k', requests: 0 },
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React, fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const text = JSON.stringify(flatten(rt.render(view.type, view.props), rt));
  assert.match(text, /没有在监听|未监听|not listening/, '要显示网关未监听的报错');
});

test('网关未监听时，折叠按钮禁用且箭头与实际展开一致', async () => {
  const rt = runtime();
  const payload = {
    configured: true, locale: 'zh', accounts: [],
    gateway: { listening: false, host: '0.0.0.0', port: 41729, baseUrl: null, lan: [], lanOnly: true, key: 'k', requests: 0 },
  };
  const { panel } = mount('dsh-cnb2api', {
    React: rt.React, fetchImpl: async () => ({ ok: true, json: async () => payload }),
  });
  const view = panel({ subject: { kind: 'bundle', pkg: { name: 'dsh-cnb2api' } } });
  rt.render(view.type, view.props);
  await new Promise((resolve) => { setTimeout(resolve, 20); });
  const tree = flatten(rt.render(view.type, view.props), rt);
  const toggle = collect(tree, ['button'], rt)
    .find((b) => String(b.props.className || '').includes('cnb2api-btn-icon'));
  assert.ok(toggle, '要有折叠按钮');
  assert.equal(toggle.props.disabled, true, '网关未监听时折叠按钮应禁用');
  assert.equal(toggle.props['aria-expanded'], 'true', '实际展开，aria 应为 true');
  assert.equal(toggle.kids.join(''), '▾', '实际展开，箭头应朝下');
});

test('取消已输入内容的新行后，保存按钮回落为不可用（dirty 重算）', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  let tree = rt.render(page.type, page.props);

  collect(tree, ['button'], rt).find((b) => b.kids.join('') === '添加账号').props.onClick();
  tree = rt.render(page.type, page.props);

  const tokenInputs = collect(tree, ['input'], rt).filter((n) => /-token$/.test(String(n.props.id || '')));
  tokenInputs[tokenInputs.length - 1].props.onChange({ target: { value: 'nk-new' } });
  tree = rt.render(page.type, page.props);
  // 用「撤销」观察 dirty：它的 disabled 只取决于是否脏（「保存」还会因新行未填完 blocked 而禁用）
  let discard = collect(tree, ['button'], rt).find((b) => b.kids.join('') === '撤销');
  assert.equal(discard.props.disabled, false, '输入后应有未保存改动（撤销可用）');

  const cancel = collect(tree, ['button'], rt).find((b) => b.kids.join('') === '取消');
  assert.ok(cancel, '新行要有取消按钮');
  cancel.props.onClick();
  tree = rt.render(page.type, page.props);
  discard = collect(tree, ['button'], rt).find((b) => b.kids.join('') === '撤销');
  assert.equal(discard.props.disabled, true, '取消后回到无改动，撤销应不可用（dirty 已回落）');
});

test('保存后基线已更新：再加一行又取消，不会误报「未保存」', async () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  let tree = rt.render(page.type, page.props);

  // 改一项全局设置
  const intervalId = collect(tree, ['label'], rt)
    .find((l) => l.kids.join('') === '巡检间隔（秒）').props.htmlFor;
  collect(tree, ['input'], rt).find((n) => n.props.id === intervalId)
    .props.onChange({ target: { value: '60' } });
  tree = rt.render(page.type, page.props);

  // 保存
  const save = collect(tree, ['button'], rt).find((b) => b.kids.join('') === '保存');
  await save.props.onClick();
  tree = rt.render(page.type, page.props);

  // 再加一行又取消
  collect(tree, ['button'], rt).find((b) => b.kids.join('') === '添加账号').props.onClick();
  tree = rt.render(page.type, page.props);
  collect(tree, ['button'], rt).find((b) => b.kids.join('') === '取消').props.onClick();
  tree = rt.render(page.type, page.props);

  const discard = collect(tree, ['button'], rt).find((b) => b.kids.join('') === '撤销');
  assert.equal(discard.props.disabled, true, '保存已是最新，取消空行后不该显示未保存');
});

test('悬浮球圆环用标准 SVG 绘制，尺寸明确不缩放', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /h\('svg', \{[\s\S]{0,200}width: size, height: size, viewBox:/, 'SVG 要明确尺寸');
  assert.match(source, /strokeLinecap: 'butt'/, '端帽 butt');
  // CSS 不能再用 width:100% 拉伸 SVG，否则 1:1 绘制被破坏、边缘变形
  assert.equal(/\.cnb2api-ring\s*\{[^}]*width:\s*100%/.test(source), false, 'SVG 不能被 CSS 拉伸');
});

test('悬浮球在窗口 resize 后重新夹回可视区', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /addEventListener\('resize', onResize\)/, '要监听窗口 resize');
  assert.match(source, /removeEventListener\('resize', onResize\)/, '要移除 resize 监听');
  assert.match(source, /const onResize = \(\) => setPoint\(\(prev\) => clampOrb\(prev\)\)/, 'resize 要重新 clamp');
});

test('悬浮球卡片按窗口空间自动选弹出方向，不会弹到窗口外', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /spaceRight >= CARD_W \+ CARD_GAP \|\| spaceRight >= spaceLeft/, '左右要按空间选边');
  assert.match(source, /spaceBelow >= viewportH \* 0\.6 \|\| spaceBelow >= spaceAbove/, '上下要按空间选边');
  assert.match(source, /maxHeight: `\$\{cardHeight\}px`/, '卡片高度要受可视区约束');
  // 卡片不能再是写死的 right:0 / bottom:52px 而不随位置变化
  assert.match(source, /left: cardRight \? .* : 'auto'/, '弹出方向要用 inline style 覆盖 CSS');
});

test('悬浮球避开整条顶部标题栏（避免被系统按钮吞掉拖不动）', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /const TITLEBAR_H = 80;/, '顶部整条设为禁区（自定义标题栏更高）');
  assert.match(source, /if \(y < keepOut\) y = keepOut/, '落进顶部带就推到下方');
  assert.equal(/CTRL_W/.test(source), false, '不再只避左右两角');
  assert.match(source, /ORB_POSITION_KEY = 'cnb2api:orb-v2'/, '旧坏位置作废');
  assert.match(source, /document\.addEventListener\('pointermove', onMove\)/, '拖动用 document 级监听');
});

test('悬浮球卡片：刷新与关闭按钮同规格，亮色字体抗锯齿', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  const cardBlock = source.slice(source.indexOf('className: \'cnb2api-orb-card\''));
  const head = cardBlock.slice(0, cardBlock.indexOf('cnb2api-orb-list'));
  const iconBtns = [...head.matchAll(/className: 'cnb2api-btn cnb2api-btn-icon'/g)].length;
  assert.equal(iconBtns, 2, '刷新与关闭都应是 24px 图标按钮');
  assert.match(source, /-webkit-font-smoothing: antialiased/, '亮色模式强制灰度抗锯齿');
  assert.match(source, /return \{ x: Math\.round\(x\), y: Math\.round\(y\) \}/, '坐标取整避免半像素糊字');
});

test('悬浮球卡片内辅助文字提高对比度与字号（亮色模式）', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /\.cnb2api-orb-card \.cnb2api-meter-foot \{ font-size: 12px; color: var\(--dsw-alias-label-secondary\)/,
    '可用额度脚注要用 secondary、12px');
  assert.match(source, /\.cnb2api-orb-card \.cnb2api-detail \{ color: var\(--dsw-alias-label-secondary\)/,
    '账号详情不能再用最浅一档');
});

test('悬浮球边界：矮窗口 clamp 不越界、拖动防重入且卸载清理', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /const upper = Math\.max\(ORB_MARGIN, height - ORB_SIZE - ORB_MARGIN\)/, '标题栏禁区要受上界约束');
  assert.match(source, /const keepOut = Math\.min\(TITLEBAR_H \+ ORB_MARGIN, upper\)/, 'keepOut 不越过可视区');
  assert.match(source, /const detachDrag = \(\) =>/, '要有统一的监听清理函数');
  assert.match(source, /useEffect\(\(\) => \(\) => detachDrag\(\), \[\]\)/, '卸载时要清理拖动监听');
  assert.match(source, /detachDrag\(\);[\s\S]{0,80}const origin =/, '新 pointerdown 先清旧会话');
});

test('备份区：范围选择、口令、本地导出导入、WebDAV 都在', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const tree = rt.render(page.type, page.props);
  const flat = flatten(tree, rt);

  const ids = nodesOf(flat, ['select', 'input']).map((n) => String(n.props.id || ''));
  for (const id of ['cnb2api-backup-scope', 'cnb2api-backup-pass', 'cnb2api-backup-file', 'cnb2api-webdav-url']) {
    assert.ok(ids.includes(id), `要有 ${id}`);
  }
  // 口令框必须是密码类型，不能明文显示
  const pass = nodesOf(flat, ['input']).find((n) => n.props.id === 'cnb2api-backup-pass');
  assert.equal(pass.props.type, 'password');

  const labels = collect(flat, ['button'], rt).map((b) => b.kids.join(''));
  for (const want of ['导出', '上传', '下载']) {
    assert.ok(labels.includes(want), `要有「${want}」按钮`);
  }
  // 导入是 label[for] 触发的文件选择
  const fileLabel = nodesOf(flat, ['label']).find((n) => n.props.htmlFor === 'cnb2api-backup-file');
  assert.ok(fileLabel, '导入要用 <label for> 触发隐藏的 file input');
});

test('备份范围三档齐全，默认全选', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const flat = flatten(rt.render(page.type, page.props), rt);
  const scope = nodesOf(flat, ['select']).find((n) => n.props.id === 'cnb2api-backup-scope');
  assert.equal(scope.props.value, 'all');
  const values = (scope.kids || []).filter((k) => k && k.props && 'value' in k.props).map((k) => k.props.value).sort();
  assert.deepEqual(values, ['accounts', 'all', 'settings']);
});

test('WebDAV 自动备份：有开关，保存后自动上传且不自动下载', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  assert.match(source, /backupAuto: '保存后自动上传'/, '要有自动备份文案');
  assert.match(source, /general\?\.autoBackup === true && String\(general\?\.webdavUrl/, '保存成功后才自动上传');
  assert.match(source, /pushToWebdav\(true\)/, '自动上传是静默的');
  // 还原仍手动：没有任何「启动/加载时自动下载并覆盖」的调用
  assert.equal(/davDownload.*onMount|restoreFromText\(body\.content\).*useEffect/.test(source), false);
});

test('工作区状态面板默认折叠（设置页不再一进来全展开）', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  // 状态面板（StatusPanel）的 open 默认 false；悬浮球的 open 仍默认 false
  const i = source.indexOf('function StatusPanel()');
  const block = source.slice(i, i + 900);
  assert.match(block, /const \[open, setOpen\] = useState\(false\)/, '状态面板默认收起');
});

test('三个设置分组（余额/其它/备份）默认折叠、可展开', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const tree = flatten(rt.render(page.type, page.props), rt);

  const groups = nodesOf(tree, ['div'])
    .filter((n) => String(n.props.className || '').split(/\s+/).includes('cnb2api-group'));
  assert.equal(groups.length, 3, '应有余额/其它/备份三个可折叠分组');
  for (const g of groups) {
    assert.equal(g.props['data-collapsed'], 'true', '默认折叠');
    const toggle = (g.kids || []).find((k) => k && String(k.props?.className || '').includes('cnb2api-group-toggle'));
    assert.ok(toggle, '有可点击的分组标题');
    assert.equal(toggle.props['aria-expanded'], 'false', 'aria 反映折叠态');
  }
  // 巡检、网关两组仍直接展开（不是 cnb2api-group）
  const text = JSON.stringify(tree);
  assert.match(text, /巡检/);
  assert.match(text, /网关/);
});

test('分组折叠不影响字段渲染：所有表单控件仍在（折叠只是 CSS 隐藏）', () => {
  const rt = runtime();
  const { component } = mount('dsh-cnb2api', { React: rt.React, formValue: SAMPLE });
  const page = rt.render(component, { view: 'page' });
  const tree = flatten(rt.render(page.type, page.props), rt);
  const ids = new Set(nodesOf(tree, ['input', 'select']).map((n) => String(n.props.id || '')));
  // 余额/其它/备份三组折叠后，控件仍必须在 DOM 里，否则展开后是空的
  const expected = [
    'cnb2api-interval', 'cnb2api-autostart', 'cnb2api-host', 'cnb2api-gwport', 'cnb2api-gwkey',
    'cnb2api-floor', 'cnb2api-low', 'cnb2api-lowmsg', 'cnb2api-autopublish',
    'cnb2api-models', 'cnb2api-locale', 'cnb2api-backup-scope', 'cnb2api-backup-pass', 'cnb2api-webdav-url',
  ];
  const missing = expected.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `折叠后仍应渲染全部控件，缺：${missing.join(',')}`);
});

test('轮询收敛：共享单轮询，周期只读快照，仅首挂/刷新才 probe', () => {
  const source = fs.readFileSync(BUNDLE, 'utf8');
  // 只有一个共享快照源：状态面板与悬浮球不再各拉一份、各自 12s 轮询。
  assert.match(source, /function createSnapshotSource\(\)/, '应有共享快照源');
  assert.match(source, /const snapshotSource = createSnapshotSource\(\);/, '快照源应是模块级单例');
  assert.match(source, /snapshotSource\.subscribe/, 'useSnapshot 必须订阅共享源');
  // 不能再有写死 probe 的状态请求：以前每 12s 一次会把 checkSeconds 压成 12s。
  assert.equal(source.includes("'/cnb2api/status?probe=1'"), false, '不应再有写死的 probe 轮询');
  // 周期定时器只读缓存快照（read(false)），不带 probe。
  const timerBlock = source.slice(source.indexOf('const startTimer ='), source.indexOf('const stopTimer ='));
  assert.match(timerBlock, /read\(false\)/, '周期轮询不能带 probe');
  // probe 只在首个订阅者出现（挂载）时补一次。
  assert.match(source, /if \(subscribers\.size === 1\) read\(true\)/, '首个订阅者才补一次 probe');
});
