// 多账号选择：按"能不能真用"排序，而不是"第一个看起来在跑"。
//
// 典型情形就是额度分散在不同组织 —— 一个用尽后另外几个都回 402，
// 只按顺序挑第一个会让"另一个还有额度"这件事完全用不上。

import test from 'node:test';
import assert from 'node:assert/strict';
import { availabilityOf, canServe, creditStateOf, pickBest } from '../lib/models.mjs';

/** Build a monitor-shaped object. */
const mon = (repo, {
  reachable = true, url = `https://${repo}.cnb.run`, broken = false, remain = null, total = null,
} = {}) => ({
  repo,
  url: reachable ? url : null,
  reachable,
  broken,
  quotaCache: remain === null ? null : { ledger: { credit: { remain, ...(total === null ? {} : { total }) } } },
});

test('额度还有的账号优先于额度用尽的', () => {
  const empty = mon('a/empty', { remain: 0 });
  const rich = mon('b/rich', { remain: 500 });
  assert.equal(pickBest([empty, rich]).repo, 'b/rich', '应当跳过额度为 0 的账号');
});

test('额度都没用尽时，余额多的优先', () => {
  const some = mon('a/some', { remain: 100 });
  const lots = mon('b/lots', { remain: 900 });
  assert.equal(pickBest([some, lots]).repo, 'b/lots');
});

test('额度未知的排在已知之后，但仍优于用尽的', () => {
  const unknown = mon('a/unknown', { remain: null });
  const known = mon('b/known', { remain: 50 });
  const empty = mon('c/empty', { remain: 0 });
  assert.equal(pickBest([unknown, known]).repo, 'b/known', '已知余额优先于未知');
  assert.equal(pickBest([empty, unknown]).repo, 'a/unknown', '未知仍好过用尽 —— 没查过不等于没有');
});

test('不可达的账号排在最后', () => {
  const down = mon('a/down', { reachable: false });
  const empty = mon('b/empty', { remain: 0 });
  assert.equal(pickBest([down, empty]).repo, 'b/empty', '能连上但额度用尽，好过连不上');
});

test('配置有问题的账号排最后', () => {
  const broken = mon('a/broken', { broken: true, remain: 999 });
  const fine = mon('b/fine', { remain: 1 });
  assert.equal(pickBest([broken, fine]).repo, 'b/fine');
});

test('空列表返回 null，不抛异常', () => {
  assert.equal(pickBest([]), null);
  assert.equal(pickBest(null), null);
});

test('可用性分档：tier 越小越优先', () => {
  assert.equal(availabilityOf(mon('a', { remain: 10 })).tier, 0);
  assert.equal(availabilityOf(mon('a', { remain: 0 })).tier, 1);
  assert.equal(availabilityOf(mon('a', { reachable: false })).tier, 2);
});

// —— 保底线：低于它就完全不用这个账号 ——

test('保底线：低于线的不接活，等于线及以上的可以', () => {
  // 用户设 1%：剩 0.5% 时停手，剩 1% 时还算可用（严格小于才停）。
  assert.equal(canServe(mon('a', { remain: 5.83, total: 1166 }), 1), false);
  assert.equal(canServe(mon('a', { remain: 11.66, total: 1166 }), 1), true);
  assert.equal(creditStateOf(mon('a', { remain: 5.83, total: 1166 }), 1).belowFloor, true);
});

test('保底线为 0 时等于不设保底', () => {
  assert.equal(canServe(mon('a', { remain: 0.01, total: 1166 }), 0), true);
});

test('额度未知时不因保底线被拦', () => {
  // 拿不到数字就断言「不够」，会把能用的账号挡在外面 ——
  // 这和「拦住能用的比放过注定失败的更糟」是同一个判断。
  assert.equal(canServe(mon('a', { remain: null }), 1), true);
});

test('低于保底线的账号降到最低优先级', () => {
  const low = mon('a/low', { remain: 5.83, total: 1166 });     // 0.5%
  const ok = mon('b/ok', { remain: 100, total: 1166 });       // 8.6%
  assert.equal(pickBest([low, ok], { floorPercent: 1 }).repo, 'b/ok');
  // 只有它一个时，不设保底仍会选它（保底是路由策略，不是 pickBest 的硬筛）
  assert.equal(pickBest([low], { floorPercent: 1 }).repo, 'a/low');
});

test('不可达优先于低于保底线（连不上更糟）', () => {
  const down = mon('a/down', { reachable: false });
  const low = mon('b/low', { remain: 5.83, total: 1166 });
  assert.equal(availabilityOf(down, 1).tier, 2);
  assert.equal(availabilityOf(low, 1).tier, 1);
});
