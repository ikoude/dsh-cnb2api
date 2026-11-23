// 监视器：巡检、启动闸门、并发合并。
//
// 用假的 CNB 客户端（不是假 fetch）把 monitor 的行为钉住：
// 这一层只关心「拿到哪些事实、做哪些决定」，网络细节归 lib/cnb.mjs。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Monitor, START_COOLDOWN_MS, fingerprint } from '../lib/monitor.mjs';
import { LIFECYCLE } from '../lib/state.mjs';

/** 一个可编排的假 CNB 客户端。 */
function fakeCnb(over = {}) {
  const calls = { start: [], quota: 0, resolve: 0, health: 0 };
  const state = {
    record: null,
    exists: true,
    url: 'https://860lo2zlkf-9001.cnb.run',
    healthy: true,
    creditRemain: 500,
    ...over,
  };
  return {
    calls,
    state,
    describe: (error) => (error?.permission ? error.message : String(error?.message || error)),
    async pickWorkspace() {
      return state.record;
    },
    repoOfRecord: (record) => record?.slug || '',
    async repoExists() {
      return state.exists;
    },
    async resolveUrl() {
      calls.resolve += 1;
      return state.url;
    },
    async healthy() {
      calls.health += 1;
      return state.healthy;
    },
    async startWorkspace(token, repo, branch) {
      calls.start.push({ repo, branch });
    },
    async readQuota() {
      calls.quota += 1;
      if (state.creditRemain === null) return { quota: null, volume: null, special: null, failures: ['quota → HTTP 403'] };
      return {
        quota: { credit_in_milli: { total: 1_000_000 } },
        volume: { credit_in_milli: 1_000_000 - state.creditRemain * 1000, freeze_credit_in_milli: 0 },
        special: null,
        failures: [],
      };
    },
    async whoAmI() {
      return { id: '1', username: 'alice' };
    },
  };
}

const settings = (over = {}) => () => ({ checkSeconds: 120, autoStart: true, port: 9001, branch: 'main', ...over });

const makeMonitor = (cnb, account = {}, settingsOver = {}) => new Monitor(
  { token: 'nk-test', repo: 'acme/gateway', proxyKey: 'sk-test', ...account },
  { cnb, settings: settings(settingsOver), log: () => {} },
);

test('在跑且可达：lifecycle=running、reachable=true，不启动', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'running', branch: 'main', create_time: '2026-01-01T00:00:00Z' } });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(monitor.lifecycle, LIFECYCLE.running);
  assert.equal(monitor.reachable, true);
  assert.equal(monitor.url, 'https://860lo2zlkf-9001.cnb.run');
  assert.deepEqual(cnb.calls.start, [], '在跑就不该启动');
});

test('在跑但持不通：地址保留、reachable=false（不是「已停止」）', async () => {
  const cnb = fakeCnb({
    record: { sn: 'sn-1', status: 'running', branch: 'main' },
    healthy: false,
  });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(monitor.lifecycle, LIFECYCLE.running);
  assert.equal(monitor.reachable, false);
  assert.ok(monitor.url, '地址要留着：下一轮可能就通了');
});

test('停机且额度充足：自动启动一次', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed', branch: 'main' } });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(cnb.calls.start.length, 1);
  assert.equal(monitor.starting, true);
  assert.equal(monitor.url, null, '停机后旧地址作废');
});

test('停机但额度用尽：不启动，并说明原因', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: 0 });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.deepEqual(cnb.calls.start, [], '额度用尽时不该提交启动');
  assert.equal(monitor.starting, false, '没启动就不能标「正在启动」');
  assert.match(monitor.lastError, /已用尽/);
});

test('余额低于保底线时不启动：把余量留着，别为一次任务烧穿', async () => {
  // 总额 1000，剩 5 → 0.5%，低于保底线 1%
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: 5 });
  const monitor = makeMonitor(cnb, {}, { creditFloorPercent: 1 });
  await monitor.sync();

  assert.deepEqual(cnb.calls.start, [], '低于保底线不该提交启动');
  assert.match(monitor.lastStartBlockedReason, /保底线/);
  assert.match(monitor.lastStartBlockedReason, /0\.50%/);
});

test('刚好等于保底线仍然启动（严格小于才停）', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: 10 });
  const monitor = makeMonitor(cnb, {}, { creditFloorPercent: 1 });
  await monitor.sync();
  assert.equal(cnb.calls.start.length, 1, '1% 不低于 1%，应照常启动');
});

test('保底线设为 0 等于不设保底', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: 3 });
  const monitor = makeMonitor(cnb, {}, { creditFloorPercent: 0 });
  await monitor.sync();
  assert.equal(cnb.calls.start.length, 1);
});

test('额度查不到（403）时照常启动 —— 拦住能用的比放过 402 更糟', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: null });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(cnb.calls.start.length, 1);
});

test('关了自动启动也会查额度：面板要能说清为什么起不来', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: 0 });
  const monitor = makeMonitor(cnb, {}, { autoStart: false });
  await monitor.sync();

  assert.deepEqual(cnb.calls.start, [], '不该自动启动');
  assert.equal(cnb.calls.quota, 1, '仍要查一次额度');
  assert.equal(monitor.creditExhausted, true, '额度用尽这个事实要拿到');
});

test('autoStart 关掉时不自动启动，但手动启动仍然可用', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' } });
  const monitor = makeMonitor(cnb, {}, { autoStart: false });
  await monitor.sync();
  assert.deepEqual(cnb.calls.start, [], '关了自动启动就不该动');

  const started = await monitor.startIfAllowed('manual', true);
  assert.equal(started, true);
  assert.equal(cnb.calls.start.length, 1);
});

test('启动冷却：一个周期内不重复提交', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' } });
  const monitor = makeMonitor(cnb);
  await monitor.sync();
  await monitor.sync();
  await monitor.sync();

  assert.equal(cnb.calls.start.length, 1, `冷却期内应只提交一次（${START_COOLDOWN_MS}ms）`);
});

test('一个仓库没有任何工作区：报告「无工作区」并尝试创建', async () => {
  const cnb = fakeCnb({ record: null, exists: true });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(monitor.lifecycle, LIFECYCLE.absent);
  assert.equal(cnb.calls.start.length, 1, '有 autoStart 时应尝试创建');
  assert.equal(monitor.noWorkspace, true, '要记住"本来就没有工作区"这个事实');
  assert.match(monitor.lastError, /已提交启动/, '启动提交后 lastError 变成进度说明');
});

test('仓库不存在：记为配置问题，不去启动', async () => {
  const cnb = fakeCnb({ record: null, exists: false });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(monitor.broken, true);
  assert.match(monitor.lastError, /不存在/);
  assert.deepEqual(cnb.calls.start, []);
});

test('并发 sync 合并成一次巡检', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'running' } });
  const monitor = makeMonitor(cnb);
  await Promise.all([monitor.sync(), monitor.sync(), monitor.sync()]);
  assert.equal(cnb.calls.resolve, 1, '三个并发调用应共用一次识别');
});

test('缺令牌或仓库不完整：直接记为配置问题，不发请求', async () => {
  const cnb = fakeCnb();
  const noToken = new Monitor({ token: '', repo: 'acme/gateway' }, { cnb, settings: settings(), log: () => {} });
  await noToken.sync();
  assert.equal(noToken.broken, true);
  assert.match(noToken.lastError, /令牌/);

  const badRepo = new Monitor({ token: 'nk', repo: 'gateway' }, { cnb, settings: settings(), log: () => {} });
  await badRepo.sync();
  assert.equal(badRepo.broken, true);
  assert.match(badRepo.lastError, /org\/repo/);
});

test('等就绪：地址通了就返回 true', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'running' }, healthy: true });
  const monitor = makeMonitor(cnb);
  assert.equal(await monitor.waitUntilReady(2000), true);
});

test('等就绪：额度被拦住时立即放弃，不白等到超时', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' }, creditRemain: 0 });
  const monitor = makeMonitor(cnb);
  await monitor.startIfAllowed('manual', true);
  const began = Date.now();
  const ready = await monitor.waitUntilReady(30_000);
  assert.equal(ready, false);
  assert.ok(Date.now() - began < 5000, '应当立刻返回，而不是等满 30 秒');
});

test('换凭据后作废旧地址与错误', async () => {
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'running' } });
  const monitor = makeMonitor(cnb);
  await monitor.sync();
  assert.ok(monitor.url);

  monitor.replaceCredentials({ token: 'nk-other', repo: 'acme/gateway', proxyKey: 'sk-2' });
  assert.equal(monitor.url, null);
  assert.equal(monitor.lastError, null);
  assert.equal(monitor.broken, false);
  assert.notEqual(monitor.identity, `${fingerprint('nk-test')}@acme/gateway`, '身份应随令牌变化');
});

test('显示名：查到用户名后是「用户 | 组织/仓库」', () => {
  const monitor = makeMonitor(fakeCnb());
  assert.equal(monitor.label, 'acme/gateway');
  monitor.username = 'alice';
  assert.equal(monitor.label, 'alice | acme/gateway');
});

test('巡检间隔有 30 秒下限', () => {
  assert.equal(makeMonitor(fakeCnb(), {}, { checkSeconds: 5 }).intervalSeconds, 30);
  assert.equal(makeMonitor(fakeCnb(), {}, { checkSeconds: 300 }).intervalSeconds, 300);
});

// —— 审查补充：并发与状态陈旧 ——

test('building / pending 阶段不重复提交启动', async () => {
  // 平台正在 building 时若落进「已停止」分支，60 秒冷却一过就会再建一次工作区。
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'building' } });
  const monitor = makeMonitor(cnb);
  await monitor.sync();

  assert.equal(monitor.lifecycle, LIFECYCLE.pending);
  assert.equal(monitor.starting, true, '应当标为启动中');
  assert.deepEqual(cnb.calls.start, [], '不能重复提交启动');
  assert.match(monitor.lastError, /等待工作区就绪/);
});

test('并发调用 startIfAllowed 只提交一次启动', async () => {
  // 自动巡检 + 手动工具 + waitUntilReady 可能同时触发。
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'closed' } });
  const monitor = makeMonitor(cnb);
  const [a, b] = await Promise.all([
    monitor.startIfAllowed('restart'),
    monitor.startIfAllowed('restart'),
  ]);
  assert.equal(a, true);
  assert.equal(b, true);
  assert.equal(cnb.calls.start.length, 1, '两次并发只该有一次 POST');
});

test('并发查询额度只打一次接口', async () => {
  // 面板、工具、启动闸门可能同时读额度，cache miss 时不该各打三遍。
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'running' } });
  const monitor = makeMonitor(cnb);
  await monitor.quota(true);
  const before = cnb.calls.quota;
  const [x, y] = await Promise.all([monitor.quota(true), monitor.quota(true)]);
  assert.equal(cnb.calls.quota - before, 1, '并发强制刷新应合并成一次');
  assert.equal(x.credit.total, y.credit.total);
});

test('工作区在跑时也会刷新额度，状态不会长期停在「就绪」', async () => {
  // 额度耗尽的事实只在 quota() 里更新；不刷新的话一直显示就绪。
  const cnb = fakeCnb({
    record: { sn: 'sn-1', status: 'running', slug: 'acme/gateway', create_time: '2026-01-01T00:00:00Z' },
    creditRemain: 0,
  });
  const monitor = makeMonitor(cnb);
  await monitor.sync();
  assert.equal(monitor.creditExhausted, true, '跑着但额度为 0 时必须反映出来');
});

test('换凭据把旧账号的结论全部清掉', async () => {
  const cnb = fakeCnb({
    record: { sn: 'sn-1', status: 'running', slug: 'acme/gateway', create_time: '2026-01-01T00:00:00Z' },
  });
  const monitor = makeMonitor(cnb);
  await monitor.sync();
  assert.ok(monitor.url, '先有一个地址');

  monitor.replaceCredentials({ token: 'nk-other', repo: 'acme/other' });
  assert.equal(monitor.url, null);
  assert.equal(monitor.lifecycle, LIFECYCLE.absent, '旧的生命周期结论要作废');
  assert.equal(monitor.creditExhausted, false);
  assert.equal(monitor.lastCheckedAt, 0);
});

test('换凭据时在途额度查询作废：旧账号的额度不会写进新账号', async () => {
  // 旧账号的 quota 请求故意卡住，期间 replaceCredentials 换成另一个账号，
  // 旧请求回来不能污染新账号的 quotaCache / creditExhausted。
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cnb = fakeCnb({ record: { sn: 'sn-1', status: 'running', branch: 'main', create_time: '2026-01-01T00:00:00Z' } });
  let first = true;
  cnb.readQuota = async () => {
    if (first) { first = false; await gate; return { quota: { credit_in_milli: { total: 1_000_000 } }, volume: { credit_in_milli: 1_000_000, freeze_credit_in_milli: 0 }, special: null, failures: [] }; }
    return { quota: { credit_in_milli: { total: 1_000_000 } }, volume: { credit_in_milli: 200_000, freeze_credit_in_milli: 0 }, special: null, failures: [] };
  };

  const monitor = makeMonitor(cnb);
  const pending = monitor.quota(true);          // 旧账号：卡在 gate 上
  monitor.replaceCredentials({ token: 'nk-other', repo: 'acme/gateway', proxyKey: 'sk-2' });
  release();
  await pending;

  // 旧结果被丢弃，缓存里不该有它
  assert.equal(monitor.quotaCache, null, '旧账号的额度不该写进缓存');

  // 新账号重新查，得到自己的数字（剩 800）
  const ledger = await monitor.quota(true);
  assert.equal(ledger.credit.remain, 800);
});

test('换号后旧查询结束不会清掉新查询的在途引用（单飞去重不失效）', async () => {
  let releaseA;
  const gateA = new Promise((r) => { releaseA = r; });
  let releaseB;
  const gateB = new Promise((r) => { releaseB = r; });
  const cnb = fakeCnb();
  let n = 0;
  cnb.readQuota = async () => {
    n += 1;
    if (n === 1) await gateA; else await gateB;
    return { quota: { credit_in_milli: { total: 1_000_000 } }, volume: { credit_in_milli: 1_000_000, freeze_credit_in_milli: 0 }, special: null, failures: [] };
  };
  const monitor = makeMonitor(cnb);
  const a = monitor.quota(true);                 // 旧账号在途
  monitor.replaceCredentials({ token: 'nk-other', repo: 'acme/gateway', proxyKey: 'sk-2' });
  const b = monitor.quota(true);                 // 新账号在途（引用应为 b）
  const bRef = monitor.quotaInFlight;
  releaseA();                                    // 旧查询结束
  await a;
  assert.equal(monitor.quotaInFlight, bRef, '旧查询的 finally 不该清掉新查询的引用');
  // 此时再查应复用 b，不再发第 3 次
  const calls = n;
  releaseB();
  await b;
  await monitor.quota();                          // 命中缓存或不新增
  assert.ok(n <= 2, `不该发第 3 次 readQuota，实际 ${n} 次（此前 ${calls}）`);
});
