// cnb2api · 额度账目
//
// CNB 的额度接口分三个，字段口径各不相同，合起来才算得出一笔账：
//   GET /{org}/-/charge/quota           总额，形如 { credit_in_milli: { total } }
//   GET /{org}/-/charge/volume          已用量与冻结量，扁平数字
//   GET /{org}/-/charge/special-amount  赠送/特权额度，单独一个数
//
// 两个容易算错的地方，也是这一层存在的理由：
//   1. quota.total **已经包含** special-amount，减一次才能得到真实基数，
//      否则同一笔赠送被算两遍；
//   2. 单位不统一：credit 以 1/1000 计，核时以秒计，而特权值又是显示单位。
//
// 这一层不联网，只把「接口给了什么」算成「界面上显示什么」。

/** 每单位和原始值的换算：credit 以毫计，核时以秒计。 */
export const SCALE = { credit: 1000, devHours: 3600 };

/**
 * 取数值，兼容 `{ total }` 包装。
 * @param {unknown} value - 原始字段。
 * @returns {number|null} 有限数值，或 null 表示缺失。
 */
export function toNumber(value) {
  if (value === null || value === undefined) return null;
  const raw = typeof value === 'object' ? Number(value.total) : Number(value);
  return Number.isFinite(raw) ? raw : null;
}

/**
 * 保留一位小数，整数不拖 `.0`。
 * @param {number} value - 数值。
 * @returns {string} 显示用文本。
 */
export function formatAmount(value) {
  const rounded = Math.round(Number(value) * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

/**
 * 解析赠送额度三元组。
 *
 * CNB 会把**已过期**的赠送也返回，所以必须带出过期标记，否则界面会继续
 * 声称「+666 可用」。核时的字段名有个坑：值叫 `compute_develop_corehour`，
 * 说明与过期时间却叫 `compute_develop_desc` / `compute_develop_expire`。
 * @param {object|null} special - special-amount 响应。
 * @param {string} key - 值字段名。
 * @param {string} [labelKey] - 说明与过期时间的字段前缀，默认同 key。
 * @param {number} [now] - 判定过期的时间点。
 * @returns {{amount: number, label: string|null, expiresAt: string|null, expired: boolean}|null}
 */
export function parseBonus(special, key, labelKey = key, now = Date.now()) {
  if (!special || typeof special !== 'object') return null;
  const raw = Number(special[key]);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const label = String(special[`${labelKey}_desc`] ?? '').trim();
  const rawExpire = String(special[`${labelKey}_expire`] ?? '').trim();
  // 9999 表示永不过期，当成没有期限
  const expiresAt = rawExpire && !/^9999/.test(rawExpire) ? rawExpire : null;
  const deadline = expiresAt ? Date.parse(expiresAt) : NaN;
  const expired = Number.isFinite(deadline) && deadline < now;
  return { amount: raw, label: label || null, expiresAt, expired };
}

/**
 * 把一组原始计数算成一笔可显示的额度。
 *
 * @param {object} input - 算账的输入。
 * @param {number|null} input.total - 总额（原始单位，已含赠送）。
 * @param {number|null} input.used - 已用（原始单位）。
 * @param {number|null} input.frozen - 冻结（原始单位）。
 * @param {object|null} input.bonus - {@link parseBonus} 的结果。
 * @param {number} input.scale - 每显示单位对应的原始单位。
 * @returns {{
 *   total: number, used: number|null, frozen: number, remain: number,
 *   base: number, bonus: number|null, bonusLabel: string|null,
 *   bonusExpiresAt: string|null, bonusExpired: boolean,
 *   usedPercent: number|null - 已用 + 冻结 占总额的百分比（冻结已不可用，必须计入）
 * }|null} 总额缺失时返回 null —— 调用方据此决定「不显示这一项」。
 */
export function settle({ total, used, frozen, bonus, scale }) {
  if (total === null || total === undefined) return null;
  const spent = used ?? 0;
  const held = frozen ?? 0;
  // 赠送已计入 total，基数要减掉，否则同一笔赠送被算两遍。
  // 扣成负数说明上游字段不一致，按 0 处理。
  const bonusRaw = bonus ? bonus.amount * scale : 0;
  const base = Math.max(0, total - bonusRaw);
  // 超支时可用显示 0，而不是负数：负数会让「还剩多少」这个问题变得没法回答
  const remain = Math.max(0, total - spent - held);
  return {
    total: total / scale,
    used: used === null || used === undefined ? null : used / scale,
    frozen: held / scale,
    remain: remain / scale,
    base: base / scale,
    bonus: bonus ? bonus.amount : null,
    bonusLabel: bonus ? bonus.label : null,
    bonusExpiresAt: bonus ? bonus.expiresAt : null,
    bonusExpired: bonus ? bonus.expired : false,
    // 进度条用「已用 + 冻结」：冻结在那一刻已经不可用了，只算 used
    // 会严重低估（实测 41% vs 真实 96%）。
    // 上游可能报出比总额多一点（结算延迟），百分比钳在 0–100：
    // 进度条拿到 100.003 会画出边界外的部分。
    usedPercent: used === null || used === undefined || total === 0
      ? null
      : Math.min(100, Math.max(0, ((spent + held) / total) * 100)),
  };
}

/**
 * 把三个接口的响应算成一笔额度。
 * @param {object} responses - 三个接口的响应，任一可能为 null（请求失败）。
 * @param {string[]} [failures] - 失败原因。
 * @returns {{credit?: object, coreHours?: object, failures: string[]}}
 */
export function settleQuota({ quota, volume, special }, failures = []) {
  const out = { failures };
  const credit = settle({
    total: toNumber(quota?.credit_in_milli),
    used: toNumber(volume?.credit_in_milli),
    frozen: toNumber(volume?.freeze_credit_in_milli),
    bonus: parseBonus(special, 'credit'),
    scale: SCALE.credit,
  });
  if (credit) out.credit = credit;

  const coreHours = settle({
    total: toNumber(quota?.dev_in_sec),
    used: toNumber(volume?.dev_in_sec),
    frozen: toNumber(volume?.freeze_dev_in_sec),
    bonus: parseBonus(special, 'compute_develop_corehour', 'compute_develop'),
    scale: SCALE.devHours,
  });
  if (coreHours) out.coreHours = coreHours;
  return out;
}

/**
 * 赠送额度的一句话说明；没有赠送时返回空串，避免出现「赠送 +0」这种噪音。
 * @param {object} ledger - {@link settle} 的结果。
 * @returns {string} 说明文本。
 */
export function describeBonus(ledger) {
  if (!ledger || ledger.bonus === null || ledger.bonus === undefined) return '';
  const label = ledger.bonusLabel || '赠送';
  if (ledger.bonusExpired) return `${label} +${formatAmount(ledger.bonus)} 已过期`;
  const until = ledger.bonusExpiresAt ? ` · 有效期至 ${String(ledger.bonusExpiresAt).slice(0, 10)}` : '';
  return `${label} +${formatAmount(ledger.bonus)}${until}`;
}

/**
 * 一笔额度的三个口径：已耗、预扣、账面可用。
 *
 * **冻结不是押金。** 实测（停掉工作区前后对比）确认：
 *
 *   停止前  used=477.94  frozen=642.71  remain=45.35
 *   停止后  used=1124.33 frozen=0       remain=41.67
 *
 * 冻结归零的同时 used 涨了 646 —— 不是退还，是**划账**：冻结那一刻就已经
 * 从额度里扣掉了，停止时只是换个科目名。所以：
 *
 *   consumed = used + frozen        真实消耗，进度条必须用这个
 *   remain   = total − consumed     账面可用，用户真正能再用的
 *
 * 用 used 单独算进度条会严重低估：上面那个时刻 used/total 是 41%，
 * 而真实消耗是 96%。
 * @param {object|null} ledger - {@link settle} 的结果。
 * @returns {{consumed: number|null, used: number|null, frozen: number, remain: number|null}} 三个口径。
 */
export function consumption(ledger) {
  if (!ledger || ledger.total === null || ledger.total === undefined) {
    return { consumed: null, used: null, frozen: 0, remain: null };
  }
  const used = ledger.used ?? 0;
  const frozen = ledger.frozen ?? 0;
  const consumed = used + frozen;
  return {
    consumed,
    used,
    frozen,
    remain: Math.max(0, ledger.total - consumed),
  };
}

/**
 * 剩余占总额的百分比（用于警戒线 / 保底线判定）。
 * @param {object|null} credit - 额度。
 * @returns {number|null} 0–100 的百分比，拿不到总额时 null。
 */
export function remainPercentOf(credit) {
  if (!credit) return null;
  const total = Number(credit.total);
  if (!Number.isFinite(total) || total <= 0) return null;
  const remain = Number(credit.remain);
  if (!Number.isFinite(remain)) return null;
  return Math.min(100, Math.max(0, (remain / total) * 100));
}

/**
 * 提醒文案里可用的变量。
 *
 * 文案由用户自定义，但数字必须是我们算的 —— 让用户自己拼「剩多少」
 * 一定会拼错（`used` 含不含冻结？`remain` 扣没扣预扣？）。
 * @param {object} input - 取值来源。
 * @param {string} [input.account] - 账号标识。
 * @param {object|null} input.ledger - {@link settle} 的结果。
 * @param {number} [input.threshold] - 警戒线（%）。
 * @param {string} [input.unit] - 单位，默认 `cr`。
 * @returns {object|null} 变量表；拿不到额度时 null。
 */
export function noticeVars({ account = '', ledger, threshold = 5, unit = 'cr' }) {
  const credit = ledger?.credit;
  if (!credit || !Number.isFinite(credit.total) || credit.total <= 0) return null;
  const used = credit.used ?? 0;
  const frozen = credit.frozen ?? 0;
  const consumed = used + frozen;
  const percent = (consumed / credit.total) * 100;
  // 三个显示值必须自洽：{consumed} + {remain} 要等于 {total}。
  // 各自独立四舍五入会破坏它（1157.1 + 9 = 1166.1 ≠ 1166），
  // 而用户把三个数写在同一句话里，一眼就能看出不对。
  // 所以先定下 total 与 consumed 的显示值，再由它们相减得到 remain。
  const totalText = Number(formatAmount(credit.total));
  const consumedText = Number(formatAmount(consumed));
  const remainText = formatAmount(Math.max(0, totalText - consumedText));
  return {
    account,
    unit,
    used: formatAmount(used),
    frozen: formatAmount(frozen),
    consumed: formatAmount(consumedText),
    remain: remainText,
    total: formatAmount(totalText),
    percent: percent.toFixed(2),
    threshold: formatAmount(threshold),
  };
}

/**
 * 用变量渲染自定义文案。
 *
 * 未知占位符**原样保留**：用户写错 `{remaim}` 时应当在自己填的文案里看见它，
 * 而不是被悄悄替换成空串 —— 那会变成一句读不通的话，且无从追查。
 * @param {string} template - 含 `{name}` 占位符的文案。
 * @param {object} vars - 变量表。
 * @returns {string} 渲染结果；模板为空时返回空串。
 */
export function renderNotice(template, vars) {
  if (!template) return '';
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    (vars && Object.hasOwn(vars, key) ? String(vars[key]) : whole));
}

/**
 * 笔账是否已经用完。
 * @param {object|null} ledger - {@link settle} 的结果。
 * @returns {boolean} 可用为 0 时 true。
 */
export function isExhausted(ledger) {
  return !!ledger && ledger.remain <= 0;
}
