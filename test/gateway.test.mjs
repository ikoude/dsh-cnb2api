// 网关：固定地址的 OpenAI 兼容端点，把会变的工作区地址藏在后面。
//
// 这一层决定「官方供应商标里填的那个地址还能不能用」，所以测试盯着三件事：
// 鉴权（局域网暴露不能裸奔）、流式（不能整体缓冲）、换账号（额度用尽要能兜住）。

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { classifyFailure, createGateway, isLoopbackHost, lanAddresses } from '../lib/gateway.mjs';

/**
 * 一个假工作区网关。
 * @param {object} options - 行为开关。
 * @returns {Promise<{url: string, close: Function, hits: object[]}>} 上游。
 */
async function upstreamServer({ models = ['deepseek-v4.1-flash'], status = 200 } = {}) {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push({ url: request.url, auth: request.headers.authorization, headers: { ...request.headers } });
    if (status !== 200) {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end('{"error":"nope"}');
      return;
    }
    if (request.url.startsWith('/v1/models')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ object: 'list', data: models.map((id) => ({ id })) }));
      return;
    }
    // 分两块发，中间停一下：一次性发完就看不出有没有缓冲
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'A' } }] })}\n\n`);
    setTimeout(() => {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'B' } }] })}\n\n`);
      response.write('data: [DONE]\n\n');
      response.end();
    }, 80);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 造一个能用的监视器桩。
 * @param {string} url - 上游地址。
 * @param {object} extra - 覆盖字段。
 * @returns {object} 监视器。
 */
function monitorStub(url, extra = {}) {
  // identity 跟着上游地址走：同一份测试里造多个账号时，它们必须在
  // 冷却簿里是不同条目，否则一个的成功会把另一个的失败记录清掉。
  const identity = extra.identity ?? new URL(url).port;
  return {
    identity,
    label: `acme-${identity}/cnb2api`,
    repo: `acme-${identity}/cnb2api`,
    url,
    reachable: true,
    broken: false,
    starting: false,
    creditExhausted: false,
    lastError: null,
    proxyKey: 'sk-upstream',
    async probe() { return true; },
    async sync() {},
    async waitUntilReady() { return true; },
    ...extra,
  };
}

/**
 * 起一个网关。
 * @param {object} options - 监视器与密钥等。
 * @returns {Promise<object>} 网关。
 */
async function gatewayOn(options) {
  const gateway = createGateway({
    pickMonitor: options.pickMonitor ?? (() => options.monitor),
    fallbacks: options.fallbacks ?? (() => []),
    getKey: () => options.key ?? 'sk-local',
    getHost: () => '127.0.0.1',
    getPort: () => 0,
    ...(options.maxBodyBytes === undefined ? {} : { maxBodyBytes: options.maxBodyBytes }),
    ...(options.noticeTemplate === undefined ? {} : { noticeTemplate: options.noticeTemplate }),
    ...(options.threshold === undefined ? {} : { threshold: options.threshold }),
    ...(options.unavailableReason === undefined ? {} : { unavailableReason: options.unavailableReason }),
    ...(options.upstreamTimeoutMs === undefined ? {} : { upstreamTimeoutMs: options.upstreamTimeoutMs }),
    ...(options.upstreamIdleMs === undefined ? {} : { upstreamIdleMs: options.upstreamIdleMs }),
    log: () => {},
  });
  await gateway.start();
  return gateway;
}

test('鉴权：不带密钥、带错密钥都拒绝', async () => {
  const upstream = await upstreamServer();
  const gateway = await gatewayOn({ monitor: monitorStub(upstream.url) });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const bare = await fetch(`${base}/v1/models`);
    assert.equal(bare.status, 401);
    assert.match((await bare.json()).reason, /密钥/);

    const wrong = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer nope' } });
    assert.equal(wrong.status, 401);

    const right = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(right.status, 200);
    assert.deepEqual((await right.json()).data.map((row) => row.id), ['deepseek-v4.1-flash']);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('密钥用 x-api-key 也能给', async () => {
  const upstream = await upstreamServer();
  const gateway = await gatewayOn({ monitor: monitorStub(upstream.url) });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { 'x-api-key': 'sk-local' } });
    assert.equal(response.status, 200);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('转发：客户端密钥不往上游带，上游拿工作区自己的 PROXY_KEY', async () => {
  const upstream = await upstreamServer();
  const gateway = await gatewayOn({ monitor: monitorStub(upstream.url) });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(upstream.hits.at(-1).auth, 'Bearer sk-upstream');
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('流式：边收边发，不整体缓冲', async () => {
  // 整体缓冲会让流式输出变成「全生成完才一次性显示」，对话看起来像卡住。
  const upstream = await upstreamServer();
  const gateway = await gatewayOn({ monitor: monitorStub(upstream.url) });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const started = Date.now();
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-v4.1-flash', stream: true, messages: [] }),
    });
    // 按 SSE 事件计，而不是按 TCP 分块计：两块可能被合进同一个包，
    // 那不代表服务端缓冲了 —— 真正的判据是「首块是否早于末块到达」。
    const arrivals = [];
    let buffer = '';
    for await (const chunk of response.body) {
      buffer += Buffer.from(chunk).toString();
      const events = buffer.split('\n\n').filter((part) => part.trim().length > 0);
      buffer = buffer.slice(buffer.lastIndexOf('\n\n') + 2);
      for (const event of events) arrivals.push({ at: Date.now() - started, text: event });
    }
    assert.ok(arrivals.length >= 2, `至少收到两个 SSE 事件，实际 ${arrivals.length}`);
    // 判据是「首块明显早于末块」，而不是固定阈值：整条链路只要不缓冲，
    // 首块就会贴着 t=0 到达。上游两块的间隔是 80ms，首块若被缓冲会一起等，
    // 两者的差就趋近于 0。实测正常值约 80ms+，留 40ms 的余量给慢机器。
    assert.ok(
      arrivals.at(-1).at - arrivals[0].at >= 40,
      `首块与末块几乎同时到达（${arrivals.at(-1).at - arrivals[0].at}ms），说明被整体缓冲了`,
    );
    assert.match(arrivals.at(-1).text, /\[DONE\]/);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('换账号：上游 402 时自动换一个还有额度的', async () => {
  // 多账号的典型情形：首选刚被上游以 402 拒绝，另一个账号是好的。
  const dead = await upstreamServer({ status: 402 });
  const alive = await upstreamServer();
  const primary = monitorStub(dead.url);
  const backup = monitorStub(alive.url, {
    identity: 'other/cnb2api', label: 'other/cnb2api', repo: 'other/cnb2api', proxyKey: 'sk-2',
  });
  const gateway = await gatewayOn({
    monitor: primary,
    pickMonitor: () => primary,
    fallbacks: () => [backup],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.status, 200);
    assert.equal(dead.hits.length, 1, '先试了首选');
    assert.equal(alive.hits.length, 1, '失败后换了账号');
  } finally {
    await gateway.stop();
    await dead.close();
    await alive.close();
  }
});

test('换账号：其它错误不盲目重试', async () => {
  // 400 是请求本身的问题，换个账号也一样，重试只会把同一个错误放大成两份。
  const bad = await upstreamServer({ status: 400 });
  const alive = await upstreamServer();
  const primary = monitorStub(bad.url);
  const gateway = await gatewayOn({
    monitor: primary,
    pickMonitor: () => primary,
    fallbacks: () => [monitorStub(alive.url)],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.status, 400);
    assert.equal(alive.hits.length, 0, '400 不该换账号');
  } finally {
    await gateway.stop();
    await bad.close();
    await alive.close();
  }
});

test('没有可用账号时给出可读原因', async () => {
  const gateway = await gatewayOn({ monitor: null, pickMonitor: () => null });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.status, 503);
    assert.match((await response.json()).reason, /账号/);
  } finally {
    await gateway.stop();
  }
});

test('端口被占用时顺延，不直接失败', async () => {
  const squatter = http.createServer((_request, response) => response.end('x'));
  const port = await new Promise((resolve) => {
    squatter.listen(0, '127.0.0.1', () => resolve(squatter.address().port));
  });
  const upstream = await upstreamServer();
  const gateway = createGateway({
    pickMonitor: () => monitorStub(upstream.url),
    getKey: () => 'sk-local',
    getHost: () => '127.0.0.1',
    getPort: () => port,
  });
  try {
    await gateway.start();
    // 顺延不等于「+1」：中间那个端口可能被别的进程占着，只要换了、而且更大就行
    assert.notEqual(gateway.status().port, port, '应该换了一个端口');
    assert.ok(gateway.status().port > port, `应从 ${port} 之后顺延，实际 ${gateway.status().port}`);
    assert.ok(gateway.status().port <= port + 10, '不该一路跑太远');
  } finally {
    await gateway.stop();
    await upstream.close();
    await new Promise((resolve) => squatter.close(resolve));
  }
});

test('监听局域网却没有密钥时拒绝启动', async () => {
  // 没有鉴权的 0.0.0.0 等于把用户的额度开放给整个局域网。
  const gateway = createGateway({
    pickMonitor: () => null,
    getKey: () => '',
    getHost: () => '0.0.0.0',
    getPort: () => 0,
  });
  await assert.rejects(() => gateway.start(), /密钥/);
});

test('监听地址判定与局域网地址', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  for (const address of lanAddresses()) {
    assert.match(address, /^\d+\.\d+\.\d+\.\d+$/);
  }
});

test('状态里的 lan 用当前端口拼出完整基址', async () => {
  const upstream = await upstreamServer();
  const gateway = await gatewayOn({ monitor: monitorStub(upstream.url) });
  try {
    const status = gateway.status();
    assert.equal(status.baseUrl, `http://127.0.0.1:${status.port}/v1`);
    for (const lan of status.lan) assert.equal(lan, `http://${new URL(lan).hostname}:${status.port}/v1`);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

// —— 一次请求内的故障转移 ——

test('分类：哪些失败值得换账号', () => {
  // 账号本身的问题 → 换人有用
  for (const status of [401, 402, 403, 429, 500, 502, 503, 504, 522, 524]) {
    assert.equal(classifyFailure({ status }).retry, true, `${status} 应当可重试`);
  }
  // 请求本身的问题 → 换人只会把同一个错误放大成几份
  for (const status of [400, 404, 422]) {
    assert.equal(classifyFailure({ status }).retry, false, `${status} 不该重试`);
  }
  // 连接层错误：请求还没拿到响应，换人安全
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'UND_ERR_SOCKET']) {
    assert.equal(classifyFailure({ cause: { code } }).retry, true, `${code} 应当可重试`);
  }
  assert.equal(classifyFailure({ name: 'AbortError' }).retry, false);
});

test('连接被重置时换一个账号', async () => {
  // 除了 402，网关卡死/拔线也应该换人 —— 否则一个账号抽风就把整轮对话打断。
  const resets = http.createServer((request) => request.socket.destroy());
  await new Promise((resolve) => resets.listen(0, '127.0.0.1', resolve));
  const alive = await upstreamServer();
  const broken = monitorStub(`http://127.0.0.1:${resets.address().port}`);
  const gateway = await gatewayOn({
    monitor: broken,
    pickMonitor: () => broken,
    fallbacks: () => [monitorStub(alive.url)],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.status, 200);
    assert.equal(gateway.status().failovers, 1);
    assert.equal(alive.hits.length, 1);
  } finally {
    await gateway.stop();
    await alive.close();
    await new Promise((resolve) => resets.close(resolve));
  }
});

test('失败的账号进入冷却，下个请求不再先撞它', async () => {
  // 额度用尽的账号会一直失败，每个请求都先试它一遍等于每轮多一次往返。
  const dead = await upstreamServer({ status: 402 });
  const alive = await upstreamServer();
  const primary = monitorStub(dead.url);
  const backup = monitorStub(alive.url);
  const gateway = await gatewayOn({
    monitor: primary,
    pickMonitor: () => primary,
    fallbacks: () => [backup],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const call = () => fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });

    assert.equal((await call()).status, 200);
    assert.equal(dead.hits.length, 1, '第一次先试首选');
    assert.ok(gateway.status().cooling[primary.identity], '首选应进入冷却');

    assert.equal((await call()).status, 200);
    assert.equal(dead.hits.length, 1, '第二次不该再撞它');
  } finally {
    await gateway.stop();
    await dead.close();
    await alive.close();
  }
});

test('冷却只降权不排除：恢复后还能用', async () => {
  // 额度可能刚好补上、令牌可能刚好修好。永久拉黑会让「修好了却不用」
  // 变成一个没法解释的故障。
  const flaky = await upstreamServer({ status: 402 });
  const primary = monitorStub(flaky.url);
  const gateway = await gatewayOn({
    monitor: primary,
    pickMonitor: () => primary,
    fallbacks: () => [],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const call = () => fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal((await call()).status, 503);
    // 冷却期内它仍然是唯一候选，所以照样会被试
    assert.equal((await call()).status, 503);
    assert.equal(flaky.hits.length, 2, '冷却不等于排除');
  } finally {
    await gateway.stop();
    await flaky.close();
  }
});

test('流中途断开要销毁连接，不能悄悄截断', async () => {
  // 正常 end() 会让调用方以为「回答就这么短」，而实际是被截断的。
  const half = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"a":1}\n\n');
    setTimeout(() => request.socket.destroy(), 30);
  });
  await new Promise((resolve) => half.listen(0, '127.0.0.1', resolve));
  const gateway = await gatewayOn({ monitor: monitorStub(`http://127.0.0.1:${half.address().port}`) });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/s`, { headers: { authorization: 'Bearer sk-local' } });
    let broke = false;
    try {
      for await (const _chunk of response.body) { /* 读到断为止 */ }
    } catch { broke = true; }
    assert.equal(broke, true, '调用方必须看到流提前结束');
  } finally {
    await gateway.stop();
    await new Promise((resolve) => half.close(resolve));
  }
});

test('请求本身有错：返回原状态码并带上上游的原话', async () => {
  const bad = http.createServer((request, response) => {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'unknown model: foo' } }));
  });
  await new Promise((resolve) => bad.listen(0, '127.0.0.1', resolve));
  const never = await upstreamServer();
  const primary = monitorStub(`http://127.0.0.1:${bad.address().port}`);
  const gateway = await gatewayOn({
    monitor: primary,
    pickMonitor: () => primary,
    fallbacks: () => [monitorStub(never.url)],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/chat`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.status, 400, '不能改写成 503 —— 那会让调用方去重试一个注定失败的请求');
    assert.match((await response.json()).reason, /unknown model/);
    assert.equal(never.hits.length, 0, '400 不该换账号');
  } finally {
    await gateway.stop();
    await new Promise((resolve) => bad.close(resolve));
    await never.close();
  }
});

test('显式点名账号时不因冷却改变顺序', async () => {
  // 用户的意思是「就用这个」，比启发式更准。
  const first = await upstreamServer();
  const second = await upstreamServer();
  const a = monitorStub(first.url, { identity: 'a', label: 'a', repo: 'a' });
  const b = monitorStub(second.url, { identity: 'b', label: 'b', repo: 'b' });
  const gateway = await gatewayOn({
    monitor: a,
    pickMonitor: () => a,
    fallbacks: () => [b],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    await fetch(`${base}/v1/models`, {
      headers: { authorization: 'Bearer sk-local', 'x-cnb2api-account': 'b' },
    });
    assert.equal(second.hits.length, 1, '点名 b 就该走 b');
    assert.equal(first.hits.length, 0);
  } finally {
    await gateway.stop();
    await first.close();
    await second.close();
  }
});

test('内部路由头不泄漏给上游', async () => {
  // x-cnb2api-account 是本网关的选账号约定，上游不认识它，不该收到。
  const upstream = await upstreamServer();
  const monitor = monitorStub(upstream.url);
  const gateway = await gatewayOn({ monitor });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    // 用这个账号自己的 label 点名，否则会被「点名账号不可用」挡下（另有测试覆盖）
    await fetch(`${base}/v1/models`, {
      headers: { authorization: 'Bearer sk-local', 'x-cnb2api-account': monitor.label },
    });
    const received = upstream.hits.at(-1).headers;
    assert.equal('x-cnb2api-account' in received, false, '不该转发内部路由头');
    assert.equal(received.authorization, 'Bearer sk-upstream');
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('请求体超限时返回 413 而不是吃穿内存', async () => {
  const upstream = await upstreamServer();
  const gateway = await gatewayOn({ monitor: monitorStub(upstream.url), maxBodyBytes: 1024 });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/chat`, {
      method: 'POST',
      headers: { authorization: 'Bearer sk-local', 'content-type': 'application/json' },
      body: 'x'.repeat(4096),
    });
    assert.equal(response.status, 413);
    assert.match((await response.json()).reason, /上限/);
    assert.equal(upstream.hits.length, 0, '超限请求不该打到上游');
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('超时归入可重试，调用方取消则不重试', () => {
  // AbortSignal.timeout() 抛 TimeoutError；换一个账号是合理的。
  assert.equal(classifyFailure(Object.assign(new Error('t'), { name: 'TimeoutError' })).retry, true);
  // 调用方主动取消不该被当成账号故障
  assert.equal(classifyFailure(Object.assign(new Error('a'), { name: 'AbortError' })).retry, false);
});

test('余额低于警戒线时，自定义文案随响应头下发', async () => {
  // 文案里有中文，HTTP 头只能是 ASCII，所以做 percent-encoding。
  const upstream = await upstreamServer();
  const monitor = monitorStub(upstream.url);
  // settleQuota 的形状：ledger.credit.{used,frozen,remain,total}
  monitor.quotaCache = {
    ledger: {
      credit: { used: 1157.7, frozen: 0, remain: 8.3, total: 1166 },
    },
  };
  const gateway = await gatewayOn({
    monitor,
    threshold: () => 5,
    noticeTemplate: () => '{account} 只剩 {remain} {unit}',
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.headers.get('x-cnb2api-credit-low'), '1');
    const notice = decodeURIComponent(response.headers.get('x-cnb2api-credit-notice') || '');
    assert.match(notice, /只剩 8\.3 cr/);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('余额充足时不下发提醒头', async () => {
  const upstream = await upstreamServer();
  const monitor = monitorStub(upstream.url);
  monitor.quotaCache = { ledger: { credit: { used: 100, frozen: 0, remain: 1066, total: 1166 } } };
  const gateway = await gatewayOn({
    monitor,
    threshold: () => 5,
    noticeTemplate: () => 'x {remain}',
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.headers.get('x-cnb2api-credit-low'), null);
    assert.equal(response.headers.get('x-cnb2api-credit-notice'), null);
  } finally {
    await gateway.stop();
    await upstream.close();
  }
});

test('全部账号低于保底线时明确拒绝，不偷偷花钱', async () => {
  // 保底线是硬停：宁可拒绝，也不让任务跑到一半把余额吃穿。
  const gateway = await gatewayOn({
    pickMonitor: () => null,
    monitor: null,
    unavailableReason: () => '所有账号余额均低于保底线 1% · 已停止使用以避免超用',
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, { headers: { authorization: 'Bearer sk-local' } });
    assert.equal(response.status, 503);
    const body = await response.json();
    assert.match(body.reason, /保底线/);
    assert.match(body.reason, /超用/);
  } finally {
    await gateway.stop();
  }
});

test('长回答不会被「总时长」切断（超时只管响应头）', async () => {
  // 这是真 bug：AbortSignal.timeout 会连流一起 abort，模型回答超过 180 秒
  // 就会被拦腰切断。现在超时只管拿到响应头，之后只看「空闲」。
  const slow = http.createServer(async (request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    // 3 块，总耗时 ~360ms，远超 100ms 的「头超时」
    for (let i = 0; i < 3; i += 1) {
      response.write(`data: {"i":${i}}\n\n`);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    response.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve));
  const gateway = await gatewayOn({
    monitor: monitorStub(`http://127.0.0.1:${slow.address().port}`),
    upstreamTimeoutMs: 100,
    upstreamIdleMs: 1000,
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/s`, { headers: { authorization: 'Bearer sk-local' } });
    let text = '';
    for await (const chunk of response.body) text += Buffer.from(chunk).toString();
    assert.match(text, /\[DONE\]/, '流应当完整走完，不该被头超时切断');
  } finally {
    await gateway.stop();
    await new Promise((resolve) => slow.close(resolve));
  }
});

test('上游拿到头之后卡住：空闲超时中断，不无限挂着', async () => {
  const stuck = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"i":0}\n\n');
    // 之后既不写也不断开
  });
  await new Promise((resolve) => stuck.listen(0, '127.0.0.1', resolve));
  const gateway = await gatewayOn({
    monitor: monitorStub(`http://127.0.0.1:${stuck.address().port}`),
    upstreamTimeoutMs: 500,
    upstreamIdleMs: 120,
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/s`, { headers: { authorization: 'Bearer sk-local' } });
    let broke = false;
    try {
      for await (const _chunk of response.body) { /* 读到断 */ }
    } catch { broke = true; }
    assert.equal(broke, true, '空闲超时应让调用方看到流中断');
  } finally {
    await gateway.stop();
    await new Promise((resolve) => stuck.close(resolve));
  }
});

test('显式点名一个不可用账号时如实拒绝，不悄悄改用别的账号', async () => {
  // 否则调用方以为走了 A，实际写到了 B 的额度里。
  const alive = await upstreamServer();
  const only = monitorStub(alive.url, { identity: 'a', label: 'a', repo: 'a' });
  const gateway = await gatewayOn({
    monitor: only,
    pickMonitor: () => only,
    fallbacks: () => [],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/models`, {
      headers: { authorization: 'Bearer sk-local', 'x-cnb2api-account': 'b/not-configured' },
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).reason, /b\/not-configured/);
    assert.equal(alive.hits.length, 0, '不该把请求发给别的账号');
  } finally {
    await gateway.stop();
    await alive.close();
  }
});

test('响应头已发出后流中断：不再换账号重试（否则会写两份内容）', async () => {
  const half = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"i":0}\n\n');
    setTimeout(() => request.socket.destroy(), 30);
  });
  await new Promise((resolve) => half.listen(0, '127.0.0.1', resolve));
  const backup = await upstreamServer();
  const primary = monitorStub(`http://127.0.0.1:${half.address().port}`);
  const gateway = await gatewayOn({
    monitor: primary,
    pickMonitor: () => primary,
    fallbacks: () => [monitorStub(backup.url)],
  });
  try {
    const base = `http://127.0.0.1:${gateway.status().port}`;
    const response = await fetch(`${base}/v1/s`, { headers: { authorization: 'Bearer sk-local' } });
    let broke = false;
    try { for await (const _c of response.body) { /* 读到断 */ } } catch { broke = true; }
    assert.equal(broke, true, '调用方应看到流中断');
    assert.equal(backup.hits.length, 0, '头已发出，不能改用备份账号重写一份');
  } finally {
    await gateway.stop();
    await new Promise((resolve) => half.close(resolve));
    await backup.close();
  }
});
