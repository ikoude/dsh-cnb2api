// 额度账目：三个接口算成一笔账。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumption,
  describeBonus,
  noticeVars,
  renderNotice,
  formatAmount,
  isExhausted,
  parseBonus,
  settle,
  settleQuota,
  toNumber,
} from '../lib/quota.mjs';

test('数值解析兼容器件包装与缺失', () => {
  assert.equal(toNumber(42), 42);
  assert.equal(toNumber({ total: 42 }), 42);
  assert.equal(toNumber(null), null);
  assert.equal(toNumber(undefined), null);
  assert.equal(toNumber('abc'), null);
});

test('金额显示不拖 .0，小数留一位', () => {
  assert.equal(formatAmount(1200), '1200');
  assert.equal(formatAmount(1200.0), '1200');
  assert.equal(formatAmount(66.66), '66.7');
  assert.equal(formatAmount(0), '0');
});

test('赠送额度：已过期要标出来，不能继续当可用', () => {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const live = parseBonus({ credit: 600, credit_desc: '新用户', credit_expire: '2026-12-31T00:00:00Z' }, 'credit', 'credit', now);
  assert.equal(live.amount, 600);
  assert.equal(live.label, '新用户');
  assert.equal(live.expired, false);

  const dead = parseBonus({ credit: 600, credit_desc: '新用户', credit_expire: '2026-01-01T00:00:00Z' }, 'credit', 'credit', now);
  assert.equal(dead.expired, true);
  assert.match(describeBonus({ bonus: 600, bonusLabel: '新用户', bonusExpired: true }), /已过期/);

  assert.equal(parseBonus(null, 'credit'), null);
  assert.equal(parseBonus({ credit: 0 }, 'credit'), null);
});

test('永不过期的赠送（9999 年）当成没有期限', () => {
  const bonus = parseBonus({ compute_develop_corehour: 20, compute_develop_expire: '9999-12-31T00:00:00Z' }, 'compute_develop_corehour', 'compute_develop');
  assert.equal(bonus.expiresAt, null);
  assert.equal(bonus.expired, false);
});

test('总额已含赠送：基数要减掉，避免同一笔算两遍', () => {
  const bonus = { amount: 600, label: '赠送', expiresAt: null, expired: false };
  const ledger = settle({ total: 1_800_000, used: 1_200_000, frozen: 0, bonus, scale: 1000 });
  assert.equal(ledger.total, 1800, '总额按 1/1000 换算');
  assert.equal(ledger.bonus, 600);
  assert.equal(ledger.base, 1200, '基数 = 总额 - 赠送');
  assert.equal(ledger.used, 1200);
  assert.equal(ledger.remain, 600);
  assert.equal(Math.round(ledger.usedPercent), 67);
});

test('上游报多了一点时百分比钳在 100，进度条不会画出边界', () => {
  // 实测数据：已用 1166.04 / 总额 1166（结算延迟）
  const ledger = settle({ total: 1_166_000, used: 1_166_040, frozen: 0, bonus: null, scale: 1000 });
  assert.equal(ledger.remain, 0);
  assert.equal(ledger.usedPercent, 100);
  assert.ok(ledger.usedPercent <= 100);
});

test('超支时可用显示 0 而不是负数', () => {
  const ledger = settle({ total: 1000, used: 1500, frozen: 200, bonus: null, scale: 1 });
  assert.equal(ledger.remain, 0);
  assert.equal(ledger.frozen, 200);
});

test('总额缺失时不算账（调用方据此不显示这一项）', () => {
  assert.equal(settle({ total: null, used: 1, frozen: 0, bonus: null, scale: 1000 }), null);
  assert.equal(settle({ total: undefined, used: 1, frozen: 0, bonus: null, scale: 1000 }), null);
});

test('已用量缺失时不瞎猜：used 为 null、百分比为 null', () => {
  const ledger = settle({ total: 2000, used: null, frozen: 0, bonus: null, scale: 1 });
  assert.equal(ledger.used, null);
  assert.equal(ledger.usedPercent, null);
  assert.equal(ledger.remain, 2000);
});

test('三个接口清单一笔账：credits 与核时口径不同但算法同一套', () => {
  const out = settleQuota({
    quota: { credit_in_milli: { total: 1_166_000 }, dev_in_sec: { total: 4_406_400 } },
    volume: { credit_in_milli: 1_166_000, freeze_credit_in_milli: 0, dev_in_sec: 3_600 },
    special: {},
  });
  assert.equal(out.credit.total, 1166);
  assert.equal(out.credit.remain, 0);
  assert.equal(out.coreHours.total, 1224);
  assert.equal(out.coreHours.used, 1);
  assert.deepEqual(out.failures, []);
});

test('接口部分失败时保留能算的那一半，并记下原因', () => {
  const out = settleQuota({
    quota: { credit_in_milli: { total: 500_000 } },
    volume: null,
    special: null,
  }, ['volume → HTTP 500']);
  assert.equal(out.credit.total, 500);
  assert.equal(out.credit.used, null, 'volume 失败时已用量未知，不能当 0');
  assert.equal(out.coreHours, undefined);
  assert.deepEqual(out.failures, ['volume → HTTP 500']);
});

test('余额为 0 判为用尽', () => {
  assert.equal(isExhausted({ remain: 0 }), true);
  assert.equal(isExhausted({ remain: 0.1 }), false);
  assert.equal(isExhausted(null), false);
});

// —— 冻结是预扣，不是押金（实测结论） ——

test('进度条必须把冻结算进消耗', () => {
  // 实测：停工作区前 used=477.94 frozen=642.71 remain=45.35，
  // 停止后 used=1124.33 frozen=0 remain=41.67 —— 冻结归零、used 涨了 646，
  // 说明冻结那一刻就已从额度扣掉，停止时只是换个科目名，不返还。
  //
  // 只算 used 的话进度条报 41%，而真实消耗是 96% —— 用户以为还剩 59%。
  const ledger = settle({
    total: 1_166_000, used: 477_940, frozen: 642_710, bonus: null, scale: 1000,
  });
  assert.ok(ledger.usedPercent > 96, `进度条应为 96% 左右，实际 ${ledger.usedPercent}`);
  assert.ok(ledger.usedPercent <= 100);
});

test('可再用额度 = 总额 − 已用 − 冻结', () => {
  // remain 三个数自洽：477.94 + 642.71 + 45.35 = 1166
  const ledger = settle({
    total: 1_166_000, used: 477_940, frozen: 642_710, bonus: null, scale: 1000,
  });
  const view = consumption(ledger);
  assert.equal(Math.round(view.consumed * 100) / 100, 1120.65);
  assert.equal(Math.round(view.remain * 100) / 100, 45.35);
});

test('没有冻结时消耗就是已用', () => {
  const ledger = settle({ total: 1_166_000, used: 100_000, frozen: 0, bonus: null, scale: 1000 });
  const view = consumption(ledger);
  assert.equal(view.consumed, 100);
  assert.equal(view.remain, 1066);
});

test('冻结超过余额时不给负数', () => {
  const ledger = settle({ total: 1_166_000, used: 500_000, frozen: 5_000_000, bonus: null, scale: 1000 });
  const view = consumption(ledger);
  assert.equal(view.remain, 0);
  assert.ok(view.consumed > 0);
});

test('没有总额时不做除法', () => {
  assert.deepEqual(consumption(null), { consumed: null, used: null, frozen: 0, remain: null });
  assert.deepEqual(consumption({ total: null }), { consumed: null, used: null, frozen: 0, remain: null });
});

// —— 自定义提醒文案 ——

// noticeVars 读的是 settleQuota 的形状（多一层 .credit），
// 所以这里把 settle 的结果包成同样的形状。
const led = (input) => ({ credit: settle(input) });

test('提醒变量：数字由我们算，不让用户自己拼', () => {
  // 用户最容易搞错「含不含冻结」。所以文案只写占位符，数字一律由这里给。
  const ledger = led({ total: 1_166_000, used: 473_040, frozen: 684_690, bonus: null, scale: 1000 });
  const vars = noticeVars({ account: 'qdirs/cnb2api', ledger, threshold: 5 });
  assert.equal(vars.account, 'qdirs/cnb2api');
  assert.equal(vars.used, '473');
  assert.equal(vars.frozen, '684.7');
  assert.equal(vars.consumed, '1157.7');
  assert.equal(vars.remain, '8.3');
  assert.equal(vars.percent, '99.29');
  assert.equal(vars.threshold, '5');
  assert.equal(vars.unit, 'cr');
});

test('提醒变量：consumed + remain 恰好等于 total（同句数字必须自洽）', () => {
  // 独立四舍五入会破坏等式（1157.1 + 9 = 1166.1 ≠ 1166），
  // 而这三个数常被写进同一句话，一眼就看出不对。
  for (const [used, frozen, remain, total] of [
    [1124.33, 32.77, 8.95, 1166],
    [473.04, 684.69, 8.27, 1166],
    [0, 0, 1166, 1166],
  ]) {
    const vars = noticeVars({ account: 'x', ledger: { credit: { used, frozen, remain, total } }, threshold: 5 });
    const sum = Number(vars.consumed) + Number(vars.remain);
    assert.equal(sum, Number(vars.total), `consumed ${vars.consumed} + remain ${vars.remain} 应等于 ${vars.total}`);
  }
});

test('提醒文案：按变量替换', () => {
  const vars = { account: 'a/b', remain: '8.3', unit: 'cr', percent: '99.29' };
  assert.equal(
    renderNotice('{account} 只剩 {remain} {unit}（已用 {percent}%）', vars),
    'a/b 只剩 8.3 cr（已用 99.29%）',
  );
});

test('提醒文案：未知占位符原样保留，不悄悄清空', () => {
  // 用户写错 {remaim} 时应当在自己填的文案里看见它，
  // 否则会得到一句读不通的话且无从追查。
  assert.equal(renderNotice('剩 {remaim} 啦', { remain: '8' }), '剩 {remaim} 啦');
});

test('提醒文案：空模板返回空串，由界面回落到默认句子', () => {
  assert.equal(renderNotice('', { remain: '1' }), '');
  assert.equal(renderNotice(undefined, { remain: '1' }), '');
});

test('提醒变量：拿不到额度时返回 null', () => {
  assert.equal(noticeVars({ ledger: null }), null);
  assert.equal(noticeVars({ ledger: { credit: null } }), null);
  assert.equal(noticeVars({ ledger: led({ total: 0, used: 0, frozen: 0, bonus: null, scale: 1000 }) }), null);
});
