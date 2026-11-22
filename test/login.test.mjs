// 登录发现：令牌 → 组织 → 仓库。
//
// 这三条路由只做查询，不写配置。它们的价值在于把「记不住的组织名与仓库名」
// 换成从真实数据里选，所以测试盯的是：令牌校验、以及候选从哪来。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.mjs';

/** A CNB backend that answers only the endpoints login uses. */
function backend({ user = { id: 7, username: 'alice' }, repos = [], groups = [], workspaces = [], tokenFails = false } = {}) {
  return async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    const path = url.pathname;
    if (path === '/user') {
      return tokenFails ? new Response('', { status: 401 }) : Response.json(user);
    }
    if (path === '/user/repos') return Response.json({ list: repos, hasMore: false });
    if (path === '/user/groups') return Response.json({ list: groups, hasMore: false });
    if (path === '/workspace/list') return Response.json({ list: workspaces, hasMore: false });
    return Response.json({});
  };
}

/** Mount the plugin and return a lookup of its routes by path. */
function mount(initial = { accounts: [] }) {
  const parsed = plugin.Config(initial);
  const config = {};
  for (const key of ['accounts', 'apiBase', 'branch', 'port', 'checkSeconds', 'autoStart', 'locale']) {
    Object.defineProperty(config, key, { get: () => parsed[key], enumerable: true });
  }
  const routes = [];
  const registered = [];
  const ctx = {
  tools: { register() {} },
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  // 可选服务（设置/凭据/配置编辑器）在没有时应当降级
  get: () => undefined,
  // llm 服务桩：只记录注册，测试关心的是"有没有把供应商挂上去"
  llm: { registerAdapter: (providers, adapter) => { registered.push({ providers, adapter }); return () => {}; } },
  // ctx.inject 在真 DSH 里等到服务就绪再执行；测试里服务视为已就绪
  inject: (deps, cb) => { cb(ctx); },
  effect: (fn) => { fn(); return () => {}; },
  };
  plugin.apply(ctx, config);
  return (path) => routes.find((row) => row.path === path);
}

/** POST a JSON body to a route and resolve its parsed reply. */
function post(route, body, method = 'POST') {
  const payload = Buffer.from(JSON.stringify(body));
  return new Promise((resolve) => {
    route.handler({
      url: route.path,
      method,
      headers: { 'content-type': 'application/json' },
      async *[Symbol.asyncIterator]() { yield payload; },
    }, {
      writeHead(code) { this.code = code; },
      end(text) { resolve({ code: this.code, body: JSON.parse(text || '{}') }); },
    });
  });
}

test('登录：令牌可用时返回用户名与可访问的组织', async () => {
  globalThis.fetch = backend({
    repos: [{ path: 'acme/gateway' }, { path: 'beta/tools' }],
    groups: [{ path: 'gamma' }],
  });
  const reply = await post(mount()('/cnb2api/login/token'), { token: 'nk-good' });
  assert.equal(reply.code, 200);
  assert.equal(reply.body.ok, true);
  assert.equal(reply.body.username, 'alice');
  assert.deepEqual([...reply.body.orgs].sort(), ['acme', 'alice', 'beta', 'gamma']);
});

test('登录：令牌无效时 401 并说明怎么修', async () => {
  globalThis.fetch = backend({ tokenFails: true });
  const reply = await post(mount()('/cnb2api/login/token'), { token: 'nk-bad' });
  assert.equal(reply.code, 401);
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.reason, /令牌无效|已过期/);
});

test('登录：把 PROXY_KEY 当令牌填时立刻点明', async () => {
  globalThis.fetch = backend();
  const reply = await post(mount()('/cnb2api/login/token'), { token: 'sk-looks-like-proxy' });
  assert.equal(reply.code, 400);
  assert.match(reply.body.reason, /PROXY_KEY/);
});

test('登录：空令牌被拒，不发请求', async () => {
  let called = 0;
  globalThis.fetch = async () => { called += 1; return Response.json({}); };
  const reply = await post(mount()('/cnb2api/login/token'), { token: '   ' });
  assert.equal(reply.code, 400);
  assert.equal(called, 0);
});

test('登录：GET 不被受理', async () => {
  globalThis.fetch = backend();
  const reply = await post(mount()('/cnb2api/login/token'), {}, 'GET');
  assert.equal(reply.code, 405);
  assert.equal(reply.body.reason, 'method');
});

test('登录：某个组织的仓库列表标出哪些已有工作区在运行', async () => {
  globalThis.fetch = backend({
    repos: [{ path: 'acme/gateway' }, { path: 'acme/new-one' }, { path: 'acme/idle' }],
    workspaces: [
      { sn: 'a', status: 'running', slug: 'acme/gateway' },
      { sn: 'b', status: 'closed', slug: 'acme/idle' },
      // 别的组织的记录不该出现在这里
      { sn: 'c', status: 'running', slug: 'beta/gateway' },
    ],
  });
  const reply = await post(mount()('/cnb2api/login/repos'), { token: 'nk', org: 'acme' });
  assert.equal(reply.code, 200);
  const repos = Object.fromEntries(reply.body.repos.map((row) => [row.repo, row.running]));
  assert.equal(repos['acme/gateway'], true, '在跑的标为运行中');
  assert.equal(repos['acme/idle'], false, '有工作区但没在跑');
  assert.equal(repos['acme/new-one'], false, '还没跑过的仓库也要列出');
  assert.equal('beta/gateway' in repos, false, '别的组织不该混进来');
});

test('登录：运行中的仓库排在前面', async () => {
  globalThis.fetch = backend({
    repos: [{ path: 'acme/aaa-first-alphabetically' }, { path: 'acme/zzz-running' }],
    workspaces: [{ sn: 'a', status: 'running', slug: 'acme/zzz-running' }],
  });
  const reply = await post(mount()('/cnb2api/login/repos'), { token: 'nk', org: 'acme' });
  assert.equal(reply.body.repos[0].repo, 'acme/zzz-running');
});

test('登录：缺组织时拒绝而不是猜一个', async () => {
  globalThis.fetch = backend();
  const reply = await post(mount()('/cnb2api/login/repos'), { token: 'nk' });
  assert.equal(reply.code, 400);
  assert.match(reply.body.reason, /组织/);
});

test('登录：组织列表可以单独重取', async () => {
  globalThis.fetch = backend({ repos: [{ path: 'acme/gateway' }], groups: [{ path: 'delta' }] });
  const reply = await post(mount()('/cnb2api/login/orgs'), { token: 'nk-good' });
  assert.equal(reply.code, 200);
  assert.ok(reply.body.orgs.includes('acme'));
  assert.ok(reply.body.orgs.includes('delta'));
});
