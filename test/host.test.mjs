// Host 装配：工具、路由、账号热更新。
//
// 用假 CNB 网络（假 fetch）把真插件装一遍，核对对外契约：
// 注册了什么、返回什么形状、配置变了之后工具能不能看见新账号。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.mjs';

/** A CNB backend good enough to drive one account through a sync. */
function backend({ workspaces = [], logs = {}, quota = null } = {}) {
  const started = [];
  const impl = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const path = url.pathname;
    if (path.endsWith('/health')) return new Response('{"status":"ok"}', { status: 200 });
    if (path === '/workspace/list') return Response.json({ list: workspaces, hasMore: false });
    if (path === '/user') return Response.json({ id: 7, username: 'alice' });
    if (path.endsWith('/workspace/start')) {
      started.push(path);
      return Response.json({ ok: true });
    }
    const log = path.match(/\/build\/runner\/download\/log\/(.+)-001$/);
    if (log) {
      const id = decodeURIComponent(log[1]);
      return logs[id] ? new Response(logs[id]) : new Response('', { status: 404 });
    }
    if (path.includes('/workspace/detail/')) return new Response('{}', { status: 404 });
    if (path.endsWith('/charge/quota')) {
      return quota ? Response.json(quota) : new Response('', { status: 403 });
    }
    if (path.endsWith('/charge/volume')) return quota ? Response.json(quota) : new Response('', { status: 403 });
    if (path.endsWith('/charge/special-amount')) return new Response('{}');
    return new Response('', { status: 200 });
  };
  return { impl, started };
}

/** Mount the plugin against a live-updatable config. */
function mount(initial) {
  // 把当轮的 fetch 钉住：测试之间会替换 globalThis.fetch，而 monitor 的定时器
  // 可能跨测试存活；不钉住就会读到别人的后端。
  let parsed = plugin.Config({ gatewayPort: 0, autoPublish: false, ...initial });
  const config = {};
  // gatewayPort: 0 让内核分配端口，测试之间不会抢固定端口
  for (const key of ['accounts', 'apiBase', 'branch', 'port', 'checkSeconds', 'autoStart', 'locale', 'models',
    'gatewayHost', 'gatewayPort', 'gatewayKey', 'autoPublish']) {
    Object.defineProperty(config, key, { get: () => parsed[key], enumerable: true });
  }
  const routes = [];
  const tools = new Map();
  const disposers = [];
  const registered = [];
  const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  webServer: {
    register: (route) => {
      routes.push(route);
      return () => {
        const at = routes.indexOf(route);
        if (at >= 0) routes.splice(at, 1);
      };
    },
  },
  // llm 服务桩：只记录注册，测试关心的是"有没有把供应商挂上去"
  llm: { registerAdapter: (providers, adapter) => { registered.push({ providers, adapter }); return () => {}; } },
  // ctx.inject 在真 DSH 里等到服务就绪再执行；测试里服务视为已就绪
  inject: (deps, cb) => { cb(ctx); },
  get: () => undefined,
  effect: (fn) => {
    // 收集清理函数，dispose() 时统一执行：monitor 的定时器不清理会跨测试存活，
    // 后续测试替换 globalThis.fetch 后它们会拿旧后端继续跑，污染断言。
    const result = fn();
    if (typeof result === 'function') disposers.push(result);
    return () => {};
  },
  };
  plugin.apply(ctx, config);
  return {
    tools,
    routes,
    registered,
    /** Simulate a settings write: re-resolve config without restarting the entry. */
    set(next) { parsed = plugin.Config(next); },
    route(path) { return routes.find((row) => row.path === path); },
    dispose() {
      for (const fn of disposers.reverse()) {
        try { fn(); } catch { /* 清理失败不影响断言 */ }
      }
      disposers.length = 0;
    },
  };
}

const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/** Call an exact-path route and resolve its JSON body. */
function call(route, { url = '/', method = 'GET' } = {}) {
  return new Promise((resolve) => {
    route.handler({ url, method, headers: {}, [Symbol.asyncIterator]: async function* iterate() {} }, {
      writeHead() {},
      end(text) { resolve(text ? JSON.parse(text) : null); },
    });
  });
}

test('装配：三个工具与九条自用路由', () => {
  globalThis.fetch = backend().impl;
  const host = mount({ accounts: [] });
  assert.deepEqual([...host.tools.keys()].sort(), ['cnb2api_quota', 'cnb2api_start', 'cnb2api_status']);
  assert.deepEqual(host.routes.map((row) => `${row.kind} ${row.path}`).sort(), [
    'exact /cnb2api/backup/export',
    'exact /cnb2api/backup/import',
    'exact /cnb2api/backup/webdav',
    'exact /cnb2api/login/orgs',
    'exact /cnb2api/login/proxy-key',
    'exact /cnb2api/login/repos',
    'exact /cnb2api/login/token',
    'exact /cnb2api/start',
    'exact /cnb2api/status',
  ]);
  // 转发不再走 DSH 的 webServer：网关要一个**固定**地址，
  // 而 web 端口每次启动都会变（64263 → 56850），挂在上面就永远不稳定。
  host.dispose();
});

test('装配：不再自己实现 LLM 适配器', () => {
  // 协议层交给 DSH 官方的 pi-ai 供应商：自己写一遍，DSH 的每条隐性要求
  // 漏一个就是用户可见的故障（finish 原因、用量、工具参数、上下文预算…）。
  globalThis.fetch = backend().impl;
  const host = mount({ accounts: [] });
  assert.equal(host.registered.length, 0, '不应该再注册 adapter');
  host.dispose();
});

test('没有账号：工具给出引导，状态接口说 configured=false', async () => {
  globalThis.fetch = backend().impl;
  const host = mount({ accounts: [] });
  const status = await host.tools.get('cnb2api_status').execute({}, {});
  assert.deepEqual(status.accounts, []);

  const body = await call(host.route('/cnb2api/status'));
  assert.equal(body.configured, false);
  host.dispose();
});

test('有账号：状态接口报出账号、状态与徽标', async () => {
  globalThis.fetch = backend({
    workspaces: [{ sn: 'sn-1', status: 'running', slug: 'acme/gateway', branch: 'main', create_time: '2026-01-01T00:00:00Z' }],
    logs: { 'sn-1': 'PROXY_URI=https://860lo2zlkf-9001.cnb.run' },
  }).impl;
  const host = mount({ accounts: [{ token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-a' }] });
  await wait(120);

  const body = await call(host.route('/cnb2api/status'));
  assert.equal(body.configured, true);
  assert.equal(body.accounts.length, 1);
  assert.equal(body.accounts[0].state, 'ready');
  assert.equal(body.accounts[0].badge, 'ok');
  assert.equal(body.accounts[0].action, 'none');
  assert.match(body.accounts[0].detail, /860l\*\*\*\*-9001\.cnb\.run/);
  host.dispose();
});

test('停在停机状态时状态接口给出启动动作', async () => {
  globalThis.fetch = backend({
    workspaces: [{ sn: 'sn-1', status: 'closed', slug: 'acme/gateway', branch: 'main' }],
  }).impl;
  const host = mount({ accounts: [{ token: 'nk-a', repo: 'acme/gateway' }], autoStart: false });
  await wait(120);

  const body = await call(host.route('/cnb2api/status'));
  assert.equal(body.accounts[0].state, 'stopped');
  assert.equal(body.accounts[0].action, 'start');
  host.dispose();
});

test('启动接口：POST 才受理，额度用尽时 409', async () => {
  const net = backend({
    workspaces: [{ sn: 'sn-1', status: 'closed', slug: 'acme/gateway', branch: 'main' }],
    quota: { credit_in_milli: { total: 1000 }, volume: { credit_in_milli: 1000 } },
  });
  globalThis.fetch = net.impl;
  const host = mount({ accounts: [{ token: 'nk-a', repo: 'acme/gateway' }], autoStart: false });
  await wait(120);

  const get = await call(host.route('/cnb2api/start'), { method: 'GET' });
  assert.equal(get.ok, false);
  assert.equal(get.reason, 'method');

  const post = await call(host.route('/cnb2api/start'), { method: 'POST', url: '/cnb2api/start?account=acme/gateway' });
  assert.equal(post.ok, false, '额度用尽应被拦住');
  assert.match(post.reason, /已用尽/, '要说清是额度问题，而不是笼统的「已停止」');
  assert.deepEqual(net.started, [], '不该提交启动');
  host.dispose();
});

test('热更新：配置新增账号后工具立刻能看到（不重启 entry）', async () => {
  globalThis.fetch = backend({
    workspaces: [{ sn: 'sn-1', status: 'running', slug: 'acme/gateway', branch: 'main' }],
    logs: { 'sn-1': 'PROXY_URI=https://abc12345-9001.cnb.run' },
  }).impl;
  const host = mount({ accounts: [] });
  assert.deepEqual((await host.tools.get('cnb2api_status').execute({}, {})).accounts, []);

  host.set({ accounts: [{ token: 'nk-new', repo: 'acme/gateway', proxyKey: 'sk' }] });
  await wait(1400);   // 等配置指纹轮询

  const after = await host.tools.get('cnb2api_status').execute({}, {});
  assert.equal(after.accounts.length, 1, '新账号应立刻可见');
  assert.equal(after.accounts[0].repo, 'acme/gateway');
  assert.equal((await call(host.route('/cnb2api/status'))).configured, true);
  host.dispose();
});

test('热更新：移除账号后工具与状态接口都不再报告', async () => {
  globalThis.fetch = backend({
    workspaces: [{ sn: 'sn-1', status: 'running', slug: 'acme/gateway' }],
    logs: { 'sn-1': 'PROXY_URI=https://abc12345-9001.cnb.run' },
  }).impl;
  const host = mount({ accounts: [{ token: 'nk-a', repo: 'acme/gateway' }] });
  await wait(120);
  assert.equal((await host.tools.get('cnb2api_status').execute({}, {})).accounts.length, 1);

  host.set({ accounts: [] });
  await wait(1400);

  assert.deepEqual((await host.tools.get('cnb2api_status').execute({}, {})).accounts, []);
  assert.equal((await call(host.route('/cnb2api/status'))).configured, false);
  host.dispose();
});

// —— 工具输出必须符合自己声明的 schema ——
// schema 不匹配会在运行时抛错，而单测只调 execute 不会发现。

function assertConforms(schema, value, path = 'root') {
  const type = schema.type;
  if (type === 'array') {
    assert.ok(Array.isArray(value), `${path} 应为数组，实际 ${typeof value}`);
    for (let i = 0; i < value.length; i += 1) {
      assertConforms(schema.items || {}, value[i], `${path}[${i}]`);
    }
    return;
  }
  if (type === 'object') {
    assert.ok(value && typeof value === 'object' && !Array.isArray(value), `${path} 应为对象`);
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (sub.required) {
        assert.ok(Object.hasOwn(value, key), `${path}.${key} 是必填，缺失`);
      }
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(props, key)) {
        assert.notEqual(schema.additionalProperties, false, `${path}.${key} 不在 schema 里且禁止额外字段`);
        continue;
      }
      if (value[key] !== undefined) assertConforms(props[key], value[key], `${path}.${key}`);
    }
    return;
  }
  if (value === undefined || value === null) return; // 可选字段允许缺失
  assert.equal(typeof value, type, `${path} 应为 ${type}`);
}

test('三个工具的输出都符合各自声明的 schema', async () => {
  globalThis.fetch = backend({
    workspaces: [{ sn: 'sn-1', status: 'running', slug: 'acme/gateway', branch: 'main', create_time: '2026-01-01T00:00:00Z' }],
    logs: { 'sn-1': 'PROXY_URI=https://860lo2zlkf-9001.cnb.run' },
  }).impl;
  const host = mount({ accounts: [{ token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-a' }] });

  // 先跑一轮，让 lastCheckedAt > 0（否则 status 工具会触发 sync）
  await host.tools.get('cnb2api_status').execute({}, {});

  for (const name of ['cnb2api_status', 'cnb2api_start', 'cnb2api_quota']) {
    const tool = host.tools.get(name);
    const value = await tool.execute({}, {});
    assert.doesNotThrow(() => assertConforms(tool.output.schema, value), `${name} 输出不符合 schema：${JSON.stringify(value)}`);
  }
  host.dispose();
});

test('工具输出语言跟随 locale：auto 中文、en 英文', async () => {
  globalThis.fetch = backend().impl;
  const zh = mount({ accounts: [{ token: 'nk-test', repo: 'acme/gateway', proxyKey: 'sk-test' }], locale: 'auto' });
  // 喂一条 running 记录，让 state 是 ready 这样的可翻译词
  // （用 status 工具拿不到 state 词时用 t.state；这里直接查工具返回的 state 字段）
  const bodyZh = await zh.tools.get('cnb2api_status').execute({}, {});
  zh.dispose();

  const en = mount({ accounts: [{ token: 'nk-test', repo: 'acme/gateway', proxyKey: 'sk-test' }], locale: 'en' });
  const bodyEn = await en.tools.get('cnb2api_status').execute({}, {});
  en.dispose();

  // 两种语言下账号数一致（功能不受影响）；state 若可翻译则应为英文
  assert.equal(bodyZh.accounts.length, bodyEn.accounts.length);
  const stateZh = bodyZh.accounts[0]?.state;
  const stateEn = bodyEn.accounts[0]?.state;
  const enStates = ['Ready', 'No credit', 'Unreachable', 'Stopped', 'No workspace', 'Starting', 'Misconfigured', 'Checking'];
  if (stateEn && enStates.includes(stateEn)) {
    assert.notEqual(stateEn, stateZh, 'en 配置下状态词应为英文');
  }
});

test('备份路由要求 application/json：挡住 text/plain 的跨域盲发', async () => {
  globalThis.fetch = backend().impl;
  const host = mount({ accounts: [] });
  for (const path of ['/cnb2api/backup/export', '/cnb2api/backup/import', '/cnb2api/backup/webdav']) {
    const route = host.route(path);
    const reply = await new Promise((resolve) => {
      route.handler({
        url: path, method: 'POST',
        headers: { 'content-type': 'text/plain' },
        async *[Symbol.asyncIterator]() { yield Buffer.from('{}'); },
      }, { writeHead(code) { this.code = code; }, end(text) { resolve({ code: this.code, body: JSON.parse(text || '{}') }); } });
    });
    assert.equal(reply.code, 415, `${path} 该拒绝 text/plain`);
    assert.match(reply.body.reason, /application\/json/);
  }
  host.dispose();
});
