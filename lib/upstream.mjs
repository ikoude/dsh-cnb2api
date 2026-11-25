// cnb2api · 上游错误正文 → 一句可读的话
//
// 网关转发失败、PROXY_KEY 校验、CNB API 报错都会拿到一段上游正文：可能是 JSON、
// HTML 错误页或堆栈。取字段与截断的逻辑以前散在三处，容易各改各的而走散，
// 现在收敛到这里。

/** 默认截断长度：够看清原因，又不会把整页 HTML 糊到界面上。 */
const LIMIT = 300;

/**
 * 从一段上游正文里取出可读信息。
 *
 * 优先用 JSON 里的常见字段（`message` / `msg` / `reason` / OpenAI 风格
 * `error.message`，以及 `error` 本身是字符串或对象的情况），取不到就按纯文本
 * 压缩空白后截断。
 * @param {string} text - 上游响应体文本。
 * @param {number} [limit] - 最大长度。
 * @returns {string} 可读片段，空正文返回空串。
 */
export function pickMessage(text, limit = LIMIT) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed) return '';
  try {
    const parsed = JSON.parse(trimmed);
    const raw = parsed?.message ?? parsed?.msg ?? parsed?.reason
      ?? parsed?.error?.message ?? parsed?.error;
    // error 可能是对象：JSON.stringify 好过渲染成 [object Object]
    const message = typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw);
    if (message.trim()) return message.trim().slice(0, limit);
  } catch { /* 不是 JSON，按纯文本处理 */ }
  return trimmed.replace(/\s+/g, ' ').slice(0, limit);
}

/**
 * 把上游状态码与正文合成一句人话（供 PROXY_KEY 校验失败等场景显示）。
 * @param {number} status - 上游 HTTP 状态码。
 * @param {string} text - 上游响应体文本。
 * @param {number} [limit] - 正文截断长度。
 * @returns {string} 形如 `额度不足 · HTTP 402 · ...`。
 */
export function explainUpstreamStatus(status, text, limit = LIMIT) {
  const detail = pickMessage(text, limit);
  const hint = status === 402 ? '额度不足'
    : status === 408 || status === 425 ? '网关超时'
      : status === 429 ? '请求过于频繁，稍后再试'
        : status >= 500 ? '网关内部错误' : '网关返回错误';
  return `${hint} · HTTP ${status}${detail ? ` · ${detail}` : ''}`;
}
