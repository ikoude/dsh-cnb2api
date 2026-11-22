/**
 * 模型清单与账号排序。
 *
 * 插件不再实现 LLM 协议层，但还留着两件事：网关要报模型清单、
 * 多账号要按可用性挑一个。
 *
 * @module dsh-cnb2api/models
 */

import { remainPercentOf } from './quota.mjs';

/** 一个账号也没有时给出的模型清单（用户还没配好，但选择器不该是空的）。 */
const EMPTY_MODELS = [{ id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' }];

/**
 * 一个账号距「保底线」还有多远，用于排序与硬停判定。
 *
 * **保底线与警戒线是两件事**：
 * - 警戒线（`lowCreditPercent`）只是提示，账号照常接活；
 * - 保底线（`creditFloorPercent`）是**硬停**：低于它就完全不用这个账号，
 *   宁可没有额度可用，也不让任务跑到一半把余额吃穿。
 *
 * 额度未知时**不拦**：拿不到数字就断言「不够」，会把能用的账号挡在外面，
 * 这和「拦住能用的比放过注定失败的更糟」是同一个判断。
 * @param {object} monitor - 监视器。
 * @param {number} floorPercent - 保底线（%）；0 表示不设保底。
 * @returns {{usable: boolean, known: boolean, ratio: number|null, belowFloor: boolean}} 状态。
 */
export function creditStateOf(monitor, floorPercent = 0) {
  const usable = !!monitor?.url && monitor?.reachable === true && monitor?.broken !== true;
  const credit = monitor?.quotaCache?.ledger?.credit;
  // 「额度已知」只看 remain 是否拿到了 —— 这是排序一直用的口径，
  // 不能因为 total 缺失就把已知余额当成未知（会打乱既有优先级）。
  const known = !!credit && credit.remain !== null && credit.remain !== undefined
    && Number.isFinite(Number(credit.remain));
  // 比值只在 total 有效时才算；没有 total 就没法比较保底线，此时不判停用。
  const ratio = remainPercentOf(credit);
  const belowFloor = ratio !== null && floorPercent > 0 && ratio < floorPercent;
  return { usable, known, ratio, belowFloor };
}

/**
 * 这个账号现在能不能接活（含保底硬停）。
 * @param {object} monitor - 监视器。
 * @param {number} floorPercent - 保底线（%）。
 * @returns {boolean} 能接活时为 true。
 */
export function canServe(monitor, floorPercent = 0) {
  const state = creditStateOf(monitor, floorPercent);
  return state.usable && !state.belowFloor;
}

/**
 * 给一个账号的可用性打分，用于多账号排序。
 *
 * 多账号的典型情形是额度分散在不同组织：一个用尽后其余都回 402，
 * 所以「可用」必须包含「额度还有」，否则会把请求引向注定失败的账号。
 * @param {object} monitor - 监视器。
 * @param {number} [floorPercent] - 保底线（%）：低于它的账号降到最低优先级。
 * @returns {{tier: number, left: number}} tier 越小越优先；left 越大越优先。
 */
export function availabilityOf(monitor, floorPercent = 0) {
  const state = creditStateOf(monitor, floorPercent);
  if (!state.usable) return { tier: 2, left: -1 };          // 不可达 / 配置有问题
  if (state.belowFloor) return { tier: 1, left: -1 };       // 可达但低于保底线
  if (!state.known) return { tier: 0, left: -1 };           // 额度未知，排在已知之后
  const remain = Number(monitor.quotaCache.ledger.credit.remain);
  if (remain <= 0) return { tier: 1, left: -1 };             // 用尽
  return { tier: 0, left: Math.max(0, remain) };
}

/**
 * 从若干账号里挑最该用的那个。
 * @param {object[]} monitors - 监视器列表。
 * @param {{floorPercent?: number}} [options] - 排序选项。
 * @returns {object|null} 选中的监视器。
 */
export function pickBest(monitors, options = {}) {
  if (!Array.isArray(monitors) || monitors.length === 0) return null;
  const floorPercent = Number(options.floorPercent) || 0;
  return [...monitors]
    .map((monitor) => ({ monitor, ...availabilityOf(monitor, floorPercent) }))
    .sort((a, b) => a.tier - b.tier || b.left - a.left)[0].monitor;
}

/**
 * 「设置 → 模型」里暴露的模型 id。
 * @param {object} config - 设置（或行配置）。
 * @returns {string[]} 模型 id；
 */
export function modelsOf(config) {
  const raw = String(config?.models || '');
  const list = raw.split(',').map((id) => id.trim()).filter(Boolean);
  return list.length > 0 ? list : EMPTY_MODELS.map((m) => m.id);
}

