// cnb2api · 工作区状态
//
// 一个工作区只有三个独立的事实：**在不在跑**、**地址通不通**、**额度够不够**。
// 其余一切都是这三者的组合。把它们拆成独立字段（而不是一个 status 字符串），
// 是因为上一版把它们揉成一个状态词，结果每加一个情形都要改一整套判断，
// 界面上还会出现「停机但额度也归零」这种一句话答不完的情况。
//
// 这一层是纯函数：给事实，出结论（状态码 + 徽标 + 一句话）。

import { maskUrl } from './address.mjs';

/** 工作区生命周期事实（来自 CNB 的工作区记录）。 */
export const LIFECYCLE = {
  running: 'running',   // 平台正在运行
  stopped: 'stopped',   // 有实例，当前没跑
  absent: 'absent',     // 该仓库没有任何工作区记录
  pending: 'pending',   // 刚提交启动，还没进入 running
};

/**
 * 把平台的工作区记录归成生命周期事实。
 * @param {object|null} record - /workspace/list 里的一条。
 * @returns {string} 见 {@link LIFECYCLE}。
 */
export function lifecycleOf(record) {
  if (!record) return LIFECYCLE.absent;
  switch (record.status) {
    case 'running': return LIFECYCLE.running;
    case 'building':
    case 'pending':
    case 'starting': return LIFECYCLE.pending;
    default: return LIFECYCLE.stopped;
  }
}

/**
 * 状态码。每个码对应界面上的一句话，且只描述**一件事**。
 *
 * 优先级是「最卡住你的那一环」，因为用户下一个动作取决于它：
 *   证书问题 > 额度用尽 > 地址不通 > 没在跑 > 没建过 > 启动中 > 就绪
 * 额度和运行状态是两件事，但「额度为 0」时启动也白搭，所以它排在运行状态之前。
 */
export const STATE = {
  ready: 'ready',             // 在跑、地址通、额度够
  noCredit: 'noCredit',       // 额度归零：启动与请求都会失败
  unreachable: 'unreachable', // 在跑但地址探不通
  stopped: 'stopped',         // 有实例，没在跑
  absent: 'absent',           // 从没建过工作区
  starting: 'starting',       // 正在启动 / 正在创建
  misconfigured: 'misconfigured', // 令牌、权限、仓库这类硬失败
  unknown: 'unknown',         // 还没查到结论
};

/**
 * 由事实推出状态码。
 * @param {object} facts - 判定依据。
 * @param {string} facts.lifecycle - {@link LIFECYCLE} 之一。
 * @param {boolean} facts.reachable - 地址是否探通（未知时传 false）。
 * @param {boolean} facts.creditExhausted - 组织额度是否归零。
 * @param {boolean} facts.broken - 是否已确认为硬失败（令牌/权限/仓库）。
 * @param {boolean} facts.starting - 是否已提交启动、正在等就绪。
 * @param {boolean} facts.known - 是否已拿到过任何结论。
 * @returns {string} {@link STATE} 之一。
 */
export function stateOf({ lifecycle, reachable, creditExhausted, broken, starting, known }) {
  if (broken) return STATE.misconfigured;
  if (starting || lifecycle === LIFECYCLE.pending) {
    // 启动中还没起来，额度归零的事实依然更该先说：等也是白等
    return creditExhausted ? STATE.noCredit : STATE.starting;
  }
  if (creditExhausted) return STATE.noCredit;
  if (lifecycle === LIFECYCLE.running) return reachable ? STATE.ready : STATE.unreachable;
  if (lifecycle === LIFECYCLE.stopped) return STATE.stopped;
  if (lifecycle === LIFECYCLE.absent) return STATE.absent;
  // 走到这里说明 lifecycle 不是已知值（首轮还没跑完 / 上游给了新枚举）。
  // 之前写成 `known ? unknown : unknown`，两支一样，是个没有意义的三元。
  return STATE.unknown;
}

/** 状态码 → 英文短标识（界面用自己的语言表翻译，这里只给稳定键）。 */
export const STATE_KEYS = Object.keys(STATE);

/**
 * 徽标：两字，回答「现在卡在哪一环」。
 *
 * 和状态码一一对应，但更短：徽标只够放两个字，所以它只取「卡住的那一环」，
 * 不重复状态行里已经说过的细节。
 */
const BADGES = {
  [STATE.ready]: 'ok',
  [STATE.noCredit]: 'noCredit',
  [STATE.unreachable]: 'offline',
  [STATE.stopped]: 'stopped',
  [STATE.absent]: 'absent',
  [STATE.starting]: 'starting',
  [STATE.misconfigured]: 'error',
  [STATE.unknown]: 'checking',
};

/**
 * 状态码对应的徽标标识。
 * @param {string} state - {@link STATE} 之一。
 * @returns {string} 徽标标识（界面据此取文案与配色）。
 */
export function badgeOf(state) {
  return BADGES[state] || BADGES[STATE.unknown];
}

/**
 * 徽标是否需要「启动」按钮：只有「有工作区或没有工作区」且没在跑时才谈得上启动。
 * @param {object} facts - 与 {@link stateOf} 相同的判定依据。
 * @returns {'start'|'none'} 该给什么动作。
 */
export function actionOf({ lifecycle, broken, starting }) {
  if (broken) return 'none';
  if (starting || lifecycle === LIFECYCLE.pending) return 'none';
  return lifecycle === LIFECYCLE.running ? 'none' : 'start';
}

/**
 * 运行时长，只到小时：分钟那一截没人看，还会把行尾顶出卡片。
 * @param {number} since - 创建时间（毫秒时间戳）。
 * @param {number} [now] - 当前时间。
 * @returns {string} 形如 `3h` / `2d5h`，无数据返回空串。
 */
export function formatUptime(since, now = Date.now()) {
  if (!since) return '';
  const minutes = Math.max(0, Math.round((now - since) / 60000));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d${hours % 24}h`;
  if (hours > 0) return `${hours}h`;
  return `${minutes}m`;
}

/**
 * 状态的详细信息段：地址 · 分支 · 实例 · 已运行。
 *
 * 只写拿得到的那几段，缺的整段省掉，不留「· ·」，也不补空白。
 * @param {object} facts - 展示素材。
 * @returns {string[]} 各段文本。
 */
export function detailParts({ url, branch, workspaceId, runningSince, now }) {
  const parts = [];
  if (url) parts.push(maskUrl(url));
  if (branch) parts.push(branch);
  if (workspaceId) parts.push(`实例 ${workspaceId}`);
  const uptime = formatUptime(runningSince, now);
  if (uptime) parts.push(`运行 ${uptime}`);
  return parts;
}
