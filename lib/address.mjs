// cnb2api · 地址与取值
//
// 这一层只做字符串变换，不联网、不碰配置，所以能脱离环境单独验证。
//
// 为什么地址需要「解析」而不是「记住」：
//   CNB 工作区每次重启，网关的域名会换成另一串随机子域（<random>-<port>.cnb.run）。
//   平台不会保留旧地址，也不会通知。于是任何缓存的地址在重启后都是错的，
//   唯一可靠的来源是工作区启动日志里的 PROXY_URI= 那一行。

/** `<random>-<port>.cnb.run`，子域可用连字符，端口可以是模板或具体数字。 */
const GATEWAY_HOST = /([a-z0-9][a-z0-9-]*)-(?:\{\{port\}\}|[0-9]+)\.cnb\.run(?![\w.-])/;

/** 日志里打印上游地址的一行；值可能被引号包住（set -x 或手工 echo）。
 *  兼容 `PROXY_URI=` / `PROXY_URI:` / `PROXY_URI =` 几种写法。 */
const LOG_URI = /PROXY_URI\s*[:=]\s*["']?(https?:\/\/\S+)/gi;

/** 日志里的任意网关主机（不带协议也行）；仓库被改成直接 echo 地址时靠它兜底。
 *  由 {@link GATEWAY_HOST} 派生，避免两个同形正则各自漂移。 */
const ANY_HOST = new RegExp(GATEWAY_HOST.source, 'g');

/** 终端颜色码。日志是彩色的，地址可能被 `\x1b[32m` 之类夹住，先剥掉再匹配。 */
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

/**
 * 去掉终端颜色码。
 * @param {string} text - 原始文本。
 * @returns {string} 纯文本。
 */
function plain(text) {
  return String(text ?? '').replace(ANSI, '');
}

/**
 * 把域名模板里的 `{{port}}` 换成真实端口。
 * CNB 注入的环境变量形如 `https://tm5fw16v80-{{port}}.cnb.run`，
 * 原样当域名用会得到含字面量 `{{port}}` 的非法主机名。
 * @param {string} value - 可能含模板的地址。
 * @param {number} port - 网关端口。
 * @returns {string|null} 替换后的地址，空值返回 null。
 */
export function fillPort(value, port) {
  if (!value) return null;
  // 端口没给就保留模板原样：写进 "undefined" 会造出非法主机名
  if (port === undefined || port === null || port === '') return String(value);
  return String(value).replace(/\{\{\s*port\s*\}\}/gi, String(port));
}

/**
 * 从任意文本里取第一个网关地址。
 * @param {string} text - 待检索文本。
 * @param {number} [port] - 网关端口。
 * @returns {string|null} 完整地址（含 https://），没找到返回 null。
 */
export function findGatewayUrl(text, port) {
  const clean = text === null || text === undefined ? '' : plain(text);
  const hit = clean.match(GATEWAY_HOST);
  return hit ? `https://${fillPort(hit[0], port)}` : null;
}

/**
 * 从启动日志里取网关地址。
 *
 * 取**最后**一条：热重启会在同一份日志里再打印一次，前面那条已经失效。
 * @param {string} log - 日志全文。
 * @param {number} [port] - 网关端口。
 * @returns {string|null} 最后一条有效地址。
 */
export function findGatewayUrlInLog(log, port) {
  if (!log) return null;
  const text = plain(log);
  // 先认 PROXY_URI 的几种写法（`=` 与 `:` 都见过），取最后一条。
  const hits = [...text.matchAll(LOG_URI)];
  for (let i = hits.length - 1; i >= 0; i -= 1) {
    const raw = hits[i][1].replace(/["'<>)]/g, '').replace(/[.,;]+$/, '').replace(/\/+$/, '');
    const filled = fillPort(raw, port);
    // 只取正则命中的主机名重建：PROXY_URI 值可能带 /v1 路径或尾部杂字符，
    // 整串返回会让上游地址变成 .../v1/v1/models 这类错误基址。
    const hit = filled.match(GATEWAY_HOST);
    if (hit) return `https://${hit[0]}`;
  }
  // 兜底：仓库的 .cnb.yml 被改成直接打印地址（可能没有 PROXY_URI 前缀、也没有协议），
  // 那就取日志里最后出现的那个网关主机 —— 热重启会多打一次，最后一条才有效。
  const any = [...text.matchAll(ANY_HOST)];
  if (any.length > 0) {
    return `https://${fillPort(any[any.length - 1][0], port)}`;
  }
  return null;
}

/**
 * 取主机名。
 * @param {string} url - 完整地址。
 * @returns {string} 主机名，解析失败时原样返回。
 */
export function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return String(url || '');
  }
}

/**
 * 打码主机名：`860lo2zlkf-9001.cnb.run` → `860l****-9001.cnb.run`。
 *
 * 前四位保留，让自己认得出是哪个工作区；端口与域名保留，让不正常一眼看出来
 * （是不是 9001、是不是 cnb.run）。状态常在截图里传播，完整域名等于公开端点。
 * @param {string} host - 主机名。
 * @returns {string} 打码后的主机名。
 */
export function maskHost(host) {
  const value = String(host || '');
  if (!value) return '';
  const split = value.match(/^([^-]+)-(\d+\..+)$/);
  if (split) return `${split[1].slice(0, 4)}****-${split[2]}`;
  if (value.length <= 10) return value;
  return `${value.slice(0, 4)}****${value.slice(-4)}`;
}

/**
 * 打码整条地址，只留主机名。
 * @param {string} url - 完整地址。
 * @returns {string} 打码结果，空值返回空串。
 */
export function maskUrl(url) {
  return url ? maskHost(hostOf(url)) : '';
}

/**
 * 把用户写法的仓库统一成 `org/repo`。
 *
 * 认得的写法：带协议的地址、树页面地址、SSH 地址、带 .git 后缀、前导斜杠；
 * 只写仓库名（没有组织）时原样返回，由调用方用令牌身份补全。
 * @param {string} input - 用户输入。
 * @returns {string} `org/repo` 或裸仓库名；无法识别返回空串。
 */
export function parseRepo(input) {
  let value = String(input || '').trim();
  if (!value) return '';
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, ''); // 协议
  value = value.replace(/^git@[^:]+:/i, ''); // git@host:
  value = value.replace(/^[^/]+\.[a-z]{2,}\//i, ''); // 域名
  value = value.replace(/^\/+/, '');
  const parts = value.match(/^([^/]+)\/([^/?#]+)/);
  if (!parts) {
    const bare = value.replace(/\.git$/i, '').replace(/[/?#].*$/, '');
    return /^[\w.-]+$/.test(bare) ? bare : '';
  }
  const org = parts[1].replace(/\.git$/i, '');
  const repo = parts[2].replace(/\.git$/i, '');
  return org && repo ? `${org}/${repo}` : '';
}
