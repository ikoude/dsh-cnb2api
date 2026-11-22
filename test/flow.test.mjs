// 端到端行为：真 apply() + 真 Monitor + 真 gateway（独立端口），只把网络换成假后端。
//
// 前面几层的测试都是「单层契约」；这里验证它们串起来之后真的能跑通一条链路：
//   状态接口 → 网关转发到工作区 → 工作区 402 时换账号 → 低于保底线时拒绝。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 造一个假网络：CNB OpenAPI + 若干工作区网关。
 * @param {object} net - 状态（可变，测试中途改它来模拟故障）。
 * @returns {Function} fetch 实现。
 */
function fakeNet(net, realFetch) {
  return async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? String(input)));
    const path = url.pathname;
    const host = url.hostname;

    // 测试自己对「本地网关」发起的请求必须走真实网络，否则永远到不了真网关
    if (host === '127.0.0.1' || host === 'localhost') return realFetch(input, init);

    // ---- 工作区网关：<sub>-9001.cnb.run ----
    if (host.endsWith('.cnb.run')) {
      const ws = net.workspaces[host] ?? { status: 200 };
      net.hits.push({ host, path });
      if (path === '/health') return new Response('{"status":"ok"}', { status: 200 });
      if (path === '/v1/models') {
        if (ws.status !== 200) return Response.json({ error: { message: 'quota' } }, { status: ws.status });
        return Response.json({ object: 'list', data: [{ id: ws.model || 'm-1' }] });
      }
      if (path === '/v1/chat/completions') {
        const body = new ReadableStream({
          start(controller) {
            const enc = new TextEncoder();
            controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
            controller.enqueue(enc.encode('data: [DONE]\n\n'));
            controller.close();
          },
        });
        return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
      }
      return new Response('', { status: 404 });
    }

    // ---- CNB OpenAPI ----
    if (path === '/workspace/list') return Response.json({ list: net.records, hasMore: false });
    if (path === '/user') return Response.json({ id: 7, username: 'alice' });
    if (path === '/user/repos') return Response.json([]);
    if (path === '/user/groups') return Response.json([]);
    if (path.endsWith('/workspace/start')) return Response.json({ ok: true });
    const log = path.match(/\/build\/runner\/download\/log\/(.+)-001$/);
    if (log) return new Response(net.logs[decodeURIComponent(log[1])] ?? '', { status: 200 });
    if (path.includes('/workspace/detail/')) return new Response('{}', { status: 404 });
    if (path.endsWith('/charge/quota')) {
      return Response.json({ credit_in_milli: { total: 1_000_000 } });
    }
    if (path.endsWith('/charge/volume')) {
      return Response.json({
        credit_in_milli: 1_000_000 - net.creditMilli,
        freeze_credit_in_milli: 0,
      });
    }
    if (path.endsWith('/charge/special-amount')) return Response.json({});
    return new Response('', { status: 200 });
  };
}

/** 装一遍真插件。 */
function mount(initial) {
  let parsed = plugin.Config({ gatewayHost: '127.0.0.1', gatewayPort: 0, autoPublish: false, ...initial });
  const config = {};
  for (const key of Object.keys(parsed)) {
    Object.defineProperty(config, key, { get: () => parsed[key], enumerable: true });
  }
  const routes = [];
  const tools = new Map();
  const disposers = [];
  const ctx = {
    tools: { register: (tool) => tools.set(tool.name, tool) },
    webServer: {
      register: (route) => {
        routes.push(route);
        const off = () => { const i = routes.indexOf(route); if (i >= 0) routes.splice(i, 1); };
        return off;
      },
    },
    get: () => undefined,
    effect: (fn) => {
      const result = fn();
      if (typeof result === 'function') disposers.push(result);
      return () => {};
    },
  };
  plugin.apply(ctx, config);
  return {
    tools,
    route: (p) => routes.find((r) => r.path === p),
    set(next) { parsed = plugin.Config({ ...parsed, ...next }); },
    async dispose() {
      for (const fn of disposers.reverse()) { try { await fn(); } catch { /* ignore */ } }
      disposers.length = 0;
    },
  };
}

/** 调 exact 路由，拿到 JSON。 */
function call(route) {
  return new Promise((resolve) => {
    route.handler(
      { url: '/', method: 'GET', headers: {}, [Symbol.asyncIterator]: async function* () {} },
      { writeHead() {}, end(text) { resolve(text ? JSON.parse(text) : null); } },
    );
  });
}

/** 等网关开始监听。 */
async function waitListening(host) {
  for (let i = 0; i < 60; i += 1) {
    const body = await call(host.route('/cnb2api/status'));
    if (body?.gateway?.listening) return body;
    await sleep(50);
  }
  throw new Error('网关没有在 3 秒内开始监听');
}

test('端到端：状态 → 网关转发 → 会话流', async () => {
  const net = {
    records: [{ sn: 'sn-1', status: 'running', slug: 'acme/gateway', branch: 'main', create_time: '2026-01-01T00:00:00Z' }],
    logs: { 'sn-1': 'PROXY_URI=https://w1-9001.cnb.run' },
    workspaces: { 'w1-9001.cnb.run': { status: 200, model: 'deepseek-v4.1-flash' } },
    creditMilli: 500_000,
    hits: [],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeNet(net, realFetch);
  const host = mount({
    accounts: [{ token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-up' }],
    gatewayKey: 'sk-flow',
    creditFloorPercent: 1,
  });
  try {
    const status = await waitListening(host);
    assert.equal(status.accounts[0].usable, true, '额度充足时应可用');

    const base = `http://127.0.0.1:${status.gateway.port}`;
    const models = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-flow' } });
    assert.equal(models.status, 200, '网关应转发到工作区');
    assert.match(JSON.stringify(await models.json()), /deepseek-v4\.1-flash/);

    const chat = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-flow', 'content-type': 'application/json' },
      body: JSON.stringify({ stream: true }),
    });
    let text = '';
    for await (const chunk of chat.body) text += Buffer.from(chunk).toString();
    assert.match(text, /\[DONE\]/, '会话流应原样转发');
  } finally {
    await host.dispose();
  }
});

test('端到端：低于保底线时网关拒绝服务', async () => {
  const net = {
    records: [{ sn: 'sn-1', status: 'running', slug: 'acme/gateway', branch: 'main', create_time: '2026-01-01T00:00:00Z' }],
    logs: { 'sn-1': 'PROXY_URI=https://w1-9001.cnb.run' },
    workspaces: { 'w1-9001.cnb.run': { status: 200 } },
    creditMilli: 5_000, // 5 / 1000 = 0.5%，低于保底线 1%
    hits: [],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeNet(net, realFetch);
  const host = mount({
    accounts: [{ token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-up' }],
    gatewayKey: 'sk-flow',
    creditFloorPercent: 1,
  });
  try {
    const status = await waitListening(host);
    assert.equal(status.accounts[0].usable, false, '低于保底线应判为不可用');
    const base = `http://127.0.0.1:${status.gateway.port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-flow' } });
    const text = await response.text();
    assert.equal(response.status, 503, `实际 ${response.status} body=${text}`);
    assert.match(JSON.parse(text).reason, /保底线/);
    // 巡检的 /health 探测会打到工作区，这是正常的；不该出现的是 /v1/* 业务请求
    assert.equal(net.hits.filter((h) => h.path.startsWith('/v1/')).length, 0, '不该把业务请求打到工作区');
  } finally {
    await host.dispose();
  }
});

test('端到端：一个账号 402 时自动换到另一个', async () => {
  const net = {
    records: [
      { sn: 'sn-a', status: 'running', slug: 'a/gw', branch: 'main', create_time: '2026-01-01T00:00:00Z' },
      { sn: 'sn-b', status: 'running', slug: 'b/gw', branch: 'main', create_time: '2026-01-01T00:00:00Z' },
    ],
    logs: { 'sn-a': 'PROXY_URI=https://wa-9001.cnb.run', 'sn-b': 'PROXY_URI=https://wb-9001.cnb.run' },
    workspaces: {
      'wa-9001.cnb.run': { status: 402 },           // A 额度用尽
      'wb-9001.cnb.run': { status: 200, model: 'from-b' },
    },
    creditMilli: 500_000,
    hits: [],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeNet(net, realFetch);
  const host = mount({
    accounts: [
      { token: 'nk-a', repo: 'a/gw', proxyKey: 'sk-a' },
      { token: 'nk-b', repo: 'b/gw', proxyKey: 'sk-b' },
    ],
    gatewayKey: 'sk-flow',
    creditFloorPercent: 1,
  });
  try {
    const status = await waitListening(host);
    const base = `http://127.0.0.1:${status.gateway.port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-flow' } });
    assert.equal(response.status, 200, '应换到还有额度的账号');
    assert.match(JSON.stringify(await response.json()), /from-b/);
    const hosts = new Set(net.hits.map((h) => h.host));
    assert.ok(hosts.has('wa-9001.cnb.run'), '先试过 A');
    assert.ok(hosts.has('wb-9001.cnb.run'), '失败后换了 B');
  } finally {
    await host.dispose();
  }
});

test('端到端：低于保底线时点「启动」立刻被拒，不挂在 90 秒等待上', async () => {
  const net = {
    records: [{ sn: 'sn-1', status: 'closed', slug: 'acme/gateway', branch: 'main', create_time: '2026-01-01T00:00:00Z' }],
    logs: {},
    workspaces: {},
    creditMilli: 5_000, // 0.5% < 1%
    hits: [],
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = fakeNet(net, realFetch);
  const host = mount({
    accounts: [{ token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-up' }],
    gatewayKey: 'sk-flow',
    creditFloorPercent: 1,
  });
  try {
    await waitListening(host);
    const started = Date.now();
    const body = await new Promise((resolve) => {
      host.route('/cnb2api/start').handler(
        { url: '/cnb2api/start?account=acme/gateway', method: 'POST', headers: {}, [Symbol.asyncIterator]: async function* () {} },
        { writeHead() {}, end(t) { resolve(t ? JSON.parse(t) : null); } },
      );
    });
    assert.equal(body.ok, false, '应拒绝启动');
    assert.match(body.reason, /保底线|额度/, `原因应说明额度问题，实际：${body.reason}`);
    assert.ok(Date.now() - started < 5000, '必须立刻返回，不能挂在等待就绪上');
  } finally {
    await host.dispose();
  }
});
