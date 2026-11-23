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
  const ctx = {
  tools: { register() {} },
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  // 可选服务（设置/凭据/配置编辑器）在没有时应当降级
  get: () => undefined,
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
  // alice 是用户名，但名下没有仓库 → 不该混进组织列表
  assert.deepEqual([...reply.body.orgs].sort(), ['acme', 'beta', 'gamma']);
  assert.deepEqual(reply.body.orgDetails.map((o) => o.name).sort(), ['acme', 'beta', 'gamma']);
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

test('登录：用户名名下有仓库时才作为「个人空间」出现', async () => {
  globalThis.fetch = backend({ repos: [{ path: 'alice/notes' }, { path: 'acme/gateway' }] });
  const reply = await post(mount()('/cnb2api/login/token'), { token: 'nk-good' });
  const names = reply.body.orgs.sort();
  assert.deepEqual(names, ['acme', 'alice']);
  const mine = reply.body.orgDetails.find((o) => o.name === 'alice');
  assert.equal(mine.personal, true, '应标为个人空间');
  const acme = reply.body.orgDetails.find((o) => o.name === 'acme');
  assert.equal(acme.personal, false);
});


test('PROXY_KEY 校验：上游非鉴权错误翻成人话，不再抛 ReferenceError', async () => {
  // 这条分支从 0.9.8 起引用了不存在的 explainUpstreamError，
  // 只要上游回 400/429/5xx 整个路由就会 ReferenceError。走完整路由覆盖它。
  const repo = 'acme/gateway';
  const gateway = 'https://abc123-41729.cnb.run';
  const base = backend({
    repos: [{ path: repo }],
    workspaces: [{ sn: 'ws-1', status: 'running', slug: repo }],
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    // 工作区详情给出网关地址
    if (url.pathname.includes('/workspace/detail/')) {
      return Response.json({ webide: `${gateway}/x` });
    }
    // 探测：健康检查通过，模型接口回 500
    if (url.origin === new URL(gateway).origin) {
      if (url.pathname === '/health') return Response.json({ status: 'ok' });
      if (url.pathname === '/v1/models') {
        return new Response('{"message":"boom"}', { status: 500 });
      }
    }
    return base(input, init);
  };
  const reply = await post(mount()('/cnb2api/login/proxy-key'), {
    token: 'nk-good', repo, proxyKey: 'sk-test',
  });
  assert.equal(reply.code, 200);
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.reason, /网关内部错误 · HTTP 500/, `实际：${reply.body.reason}`);
  assert.match(reply.body.reason, /boom/);
});

test('PROXY_KEY 校验：上游 OpenAI 风格嵌套 error 不渲染成 [object Object]', async () => {
  const repo = 'acme/gateway';
  const gateway = 'https://abc123-41729.cnb.run';
  const base = backend({ repos: [{ path: repo }], workspaces: [{ sn: 'ws-1', status: 'running', slug: repo }] });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    if (url.pathname.includes('/workspace/detail/')) return Response.json({ webide: `${gateway}/x` });
    if (url.origin === new URL(gateway).origin) {
      if (url.pathname === '/health') return Response.json({ status: 'ok' });
      if (url.pathname === '/v1/models') return new Response('{"error":{"message":"bad gateway upstream"}}', { status: 502 });
    }
    return base(input, init);
  };
  const reply = await post(mount()('/cnb2api/login/proxy-key'), { token: 'nk-good', repo, proxyKey: 'sk-test' });
  assert.equal(reply.body.ok, false);
  assert.match(reply.body.reason, /bad gateway upstream/);
  assert.equal(/object Object/.test(reply.body.reason), false);
});

test('登录只查一次 /user：身份在组织/额度查询之间复用', async () => {
  const calls = [];
  const base = backend({
    repos: [{ path: 'alice/notes' }, { path: 'acme/gateway' }],
    groups: [{ path: 'gamma' }],
  });
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    calls.push(url.pathname);
    return base(input, init);
  };
  const reply = await post(mount()('/cnb2api/login/token'), { token: 'nk-good' });
  assert.equal(reply.code, 200);
  const userCalls = calls.filter((p) => p === '/user').length;
  assert.equal(userCalls, 1, `/user 应只查一次，实际 ${userCalls} 次：${calls.join(',')}`);
});
