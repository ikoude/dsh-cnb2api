// 状态推导：事实 → 状态码 / 徽标 / 动作。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LIFECYCLE,
  STATE,
  actionOf,
  badgeOf,
  detailParts,
  formatUptime,
  lifecycleOf,
  stateOf,
} from '../lib/state.mjs';

const facts = (over) => ({
  lifecycle: LIFECYCLE.running,
  reachable: true,
  creditExhausted: false,
  broken: false,
  starting: false,
  known: true,
  ...over,
});

test('平台记录归成生命周期事实', () => {
  assert.equal(lifecycleOf(null), LIFECYCLE.absent);
  assert.equal(lifecycleOf({ status: 'running' }), LIFECYCLE.running);
  assert.equal(lifecycleOf({ status: 'closed' }), LIFECYCLE.stopped);
  assert.equal(lifecycleOf({ status: 'building' }), LIFECYCLE.pending);
  assert.equal(lifecycleOf({ status: 'whatever' }), LIFECYCLE.stopped);
});

test('正常路径：在跑 + 通 + 有额度 = 就绪', () => {
  assert.equal(stateOf(facts()), STATE.ready);
  assert.equal(badgeOf(STATE.ready), 'ok');
  assert.equal(actionOf(facts()), 'none');
});

test('在跑但地址不通 = 地址不通，不是「已停止」', () => {
  assert.equal(stateOf(facts({ reachable: false })), STATE.unreachable);
  assert.equal(badgeOf(STATE.unreachable), 'offline');
});

test('额度归零压过运行状态：在跑也没用，请求会被上游拒绝', () => {
  assert.equal(stateOf(facts({ creditExhausted: true })), STATE.noCredit);
  assert.equal(stateOf(facts({ lifecycle: LIFECYCLE.stopped, reachable: false, creditExhausted: true })), STATE.noCredit);
  assert.equal(badgeOf(STATE.noCredit), 'noCredit');
});

test('配置有问题（令牌 / 权限 / 仓库）优先于一切', () => {
  assert.equal(stateOf(facts({ broken: true })), STATE.misconfigured);
  assert.equal(stateOf(facts({ broken: true, creditExhausted: true, lifecycle: LIFECYCLE.absent })), STATE.misconfigured);
  assert.equal(badgeOf(STATE.misconfigured), 'error');
  assert.equal(actionOf(facts({ broken: true })), 'none', '配置有问题时给了启动按钮也没用');
});

test('停机与从没建过是两种状态：前者给启动按钮，后者说清原因', () => {
  assert.equal(stateOf(facts({ lifecycle: LIFECYCLE.stopped, reachable: false })), STATE.stopped);
  assert.equal(actionOf(facts({ lifecycle: LIFECYCLE.stopped, reachable: false })), 'start');

  assert.equal(stateOf(facts({ lifecycle: LIFECYCLE.absent, reachable: false })), STATE.absent);
  assert.equal(badgeOf(STATE.absent), 'absent');
  assert.equal(actionOf(facts({ lifecycle: LIFECYCLE.absent, reachable: false })), 'start');
});

test('启动中是过渡态，不再给启动按钮', () => {
  assert.equal(stateOf(facts({ lifecycle: LIFECYCLE.pending, reachable: false, starting: true })), STATE.starting);
  assert.equal(actionOf(facts({ lifecycle: LIFECYCLE.pending, starting: true })), 'none');
});

test('启动中但额度已归零：先说额度，因为等也等不出来', () => {
  assert.equal(stateOf(facts({ lifecycle: LIFECYCLE.pending, starting: true, creditExhausted: true })), STATE.noCredit);
});

test('运行中的工作区不给启动按钮', () => {
  assert.equal(actionOf(facts({ lifecycle: LIFECYCLE.running, reachable: false })), 'none');
});

test('运行时长只到小时', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  assert.equal(formatUptime(Date.parse('2026-01-02T11:30:00Z'), now), '30m');
  assert.equal(formatUptime(Date.parse('2026-01-02T04:00:00Z'), now), '8h');
  assert.equal(formatUptime(Date.parse('2026-01-01T06:00:00Z'), now), '1d6h');
  assert.equal(formatUptime(0, now), '');
});

test('详情段只写拿得到的，缺的整段省掉', () => {
  const now = Date.parse('2026-01-02T12:00:00Z');
  assert.deepEqual(
    detailParts({ url: 'https://860lo2zlkf-9001.cnb.run', branch: 'main', workspaceId: 'sn-1' }),
    ['860l****-9001.cnb.run', 'main', '实例 sn-1'],
  );
  assert.deepEqual(detailParts({ url: null, branch: '', workspaceId: null }), []);
  assert.deepEqual(
    detailParts({ url: null, branch: null, workspaceId: 'sn-2', runningSince: Date.parse('2026-01-02T04:00:00Z'), now }),
    ['实例 sn-2', '运行 8h'],
  );
});

test('每个状态码都有各自的徽标，没有共用兜底', () => {
  const badges = Object.values(STATE).map((state) => badgeOf(state));
  for (const state of Object.values(STATE)) assert.ok(badgeOf(state), `${state} 缺徽标`);
  assert.equal(new Set(badges).size, badges.length, `徽标不该重复：${badges.join(',')}`);
});

test('还没查到结论时显示「识别中」，不是「未知」', () => {
  assert.equal(stateOf({ ...facts({ known: false }), lifecycle: null }), STATE.unknown);
  assert.equal(badgeOf(STATE.unknown), 'checking');
});
