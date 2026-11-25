/**
 * 本地/局域网网关：一个长期稳定的 OpenAI 兼容端点。
 *
 * **为什么需要它**：CNB 工作区地址每次重启都会变（`xxx-9001.cnb.run` 换域名），
 * 而 DSH 的官方供应商卡片只认一个固定 baseURL。这个网关把「会变的地址」
 * 藏在后面：调用方只记 `http://<host>:<port>/v1`，地址跟随、账号切换、
 * 额度耗尽换人都发生在这里。
 *
 * 监听 0.0.0.0 等于把「花你的额度」这件事开放给整个局域网，所以**没有密钥
 * 就不许监听非回环地址**，且每个请求都要带 `Authorization: Bearer <key>`。
 *
 * @module dsh-cnb2api/gateway
 */

import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { noticeVars, remainPercentOf, renderNotice } from './quota.mjs';
import { pickMessage } from './upstream.mjs';

/** 默认端口：高位、少见，避开开发常用端口。 */
export const DEFAULT_PORT = 41729;
/** 默认监听地址：局域网可用。 */
export const DEFAULT_HOST = '0.0.0.0';
/** 端口被占用时依次尝试的数量。 */
const PORT_TRIES = 10;
/**
 * 上游请求的硬上限。
 *
 * 没有它的话，上游一卡住，这个请求就永远挂着 —— 而「永远挂着」比报错更糟：
 * 调用方既拿不到结果也无法重试，只能等超时或手动中断。
 * 180 秒与 monitor 的单次请求超时一致；流式响应的空闲由 Node 自身处理。
 */
const UPSTREAM_TIMEOUT_MS = 180_000;
/**
 * 响应体的**空闲**上限：多久没有一个字节就认为上游死了。
 *
 * 不能用「整个请求的总时长」来限制：模型回答可能持续好几分钟，
 * 按总时长掐会在半句话处把流切断。只有「长时间没有任何数据」才是异常。
 */
const UPSTREAM_IDLE_MS = 120_000;
/**
 * 请求体上限。
 *
 * 对话请求可能带图片（base64），但无限增长会直接把宿主进程的内存吃穿。
 * 64MiB 足够容纳多张图 + 长历史，同时是个明确的上界。
 */
const MAX_BODY_BYTES = 64 * 1024 * 1024;
/**
 * 账号失败后的冷却时长。
 *
 * 一个账号额度用尽或令牌失效后，接下来一分钟里的每个请求都还排在第一位，
 * 于是每次都要先撞一次失败再换人 —— 用户付出的是「每一轮对话都多一次往返」。
 * 冷却让它在期内降到最后，但**不排除**：额度可能刚好恢复，令牌可能刚好修好。
 */
const COOLDOWN_MS = 60_000;
/** 连续多少次失败进入冷却。 */
const COOLDOWN_AFTER = 1;
/**
 * 这些状态码说明「这个账号本身不行」，换一个还有意义。
 *
 * 401 密钥不对、402 额度用尽、403 没权限、429 限流、5xx 上游故障。
 * 400/422 是请求本身的问题 —— 换账号只会把同一个错误放大成几份。
 */
const RETRYABLE_STATUS = new Set([401, 402, 403, 408, 425, 429, 500, 502, 503, 504, 522, 524]);

/**
 * 值得换账号的状态码：所有 5xx 加上面那几个。
 * 网关前面的 CDN 会自己发明状态码（522 连接超时、524 响应超时），
 * 逐个枚举必然漏，所以按范围判断。
 * @param {number} status - 状态码。
 * @returns {boolean} 是否可重试。
 */
function retryable(status) {
  if (RETRYABLE_STATUS.has(status)) return true;
  return status >= 500 && status < 600;
}
/**
 * 连接层的错误码：请求**还没有拿到响应**时发生，换账号是安全的。
 *
 * 一旦响应头已经发给调用方，就不能再换人了 —— 那会在同一条流里写两遍。
 */
const RETRYABLE_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
  'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE', 'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET',
  // AbortSignal.timeout() 抛的是 TimeoutError；换一个账号是合理的
  'ABORT_ERR', 'TimeoutError', 'UND_ERR_ABORTED',
]);
/** 不转发的逐跳头。 */
const HOP_HEADERS = new Set([
  'host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive',
  'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'upgrade',
  'accept-encoding',
]);

/**
 * 恒定时间比较两个字符串。
 * @param {string} a - 其一。
 * @param {string} b - 其二。
 * @returns {boolean} 是否相同。
 */
function sameSecret(a, b) {
  const left = createHash('sha256').update(String(a)).digest();
  const right = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(left, right);
}

/**
 * 请求带的密钥。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @returns {string} 密钥，或空串。
 */
function presentedKey(request) {
  const auth = String(request.headers.authorization || '');
  const bearer = /^bearer\s+(.+)$/i.exec(auth);
  if (bearer) return bearer[1].trim();
  const header = request.headers['x-api-key'];
  if (typeof header === 'string') return header.trim();
  return '';
}

/**
 * 监听地址是否是回环。
 * @param {string} host - 监听地址。
 * @returns {boolean} 是否只在本机。
 */
export function isLoopbackHost(host) {
  return host === '127.0.0.1' || host === '::1' || host === 'localhost';
}

/**
 * 本机的局域网地址，用于把可用 URL 展示给用户。
 * @returns {string[]} IPv4 地址（不含回环）。
 */
export function lanAddresses() {
  const found = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      found.push(entry.address);
    }
  }
  return found;
}

/**
 * 发一个 JSON 响应。
 * @param {import('node:http').ServerResponse} response - 响应。
 * @param {number} status - 状态码。
 * @param {object} body - 响应体。
 * @returns {void}
 */
function sendJson(response, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'access-control-allow-origin': '*',
  });
  response.end(payload);
}

/**
 * 转发时要用的上游请求头。
 * @param {import('node:http').IncomingHttpHeaders} headers - 客户端请求头。
 * @param {string} key - 上游密钥。
 * @returns {Headers} 上游请求头。
 */
function upstreamHeaders(headers, key) {
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (HOP_HEADERS.has(name) || value === undefined) continue;
    // 客户端的密钥只用于访问本网关，上游一律换成工作区自己的 PROXY_KEY
    if (name === 'authorization' || name === 'x-api-key') continue;
    // 路由头是本网关内部的约定，上游不认识它，不该收到
    if (name === 'x-cnb2api-account') continue;
    out.set(name, Array.isArray(value) ? value.join(', ') : String(value));
  }
  // 强制不压缩：转发响应时我们会丢掉上游的 content-encoding 再原样转发字节，
  // 若上游压缩过，字节就是 gzip 而头说没有，客户端会拿到乱码。
  out.set('accept-encoding', 'identity');
  if (key) out.set('authorization', `Bearer ${key}`);
  return out;
}

/**
 * 给一个异步可读流加「空闲超时」。
 *
 * 每次等下一块时开一个定时器；超过 `idleMs` 没有数据就 abort 整个请求。
 * 收到数据就重置 —— 所以「慢但持续」的流不会被误杀，只有真卡死才会。
 * @param {AsyncIterable<Uint8Array>} body - 上游响应体。
 * @param {number} idleMs - 空闲上限（毫秒）。
 * @param {AbortController} controller - 用于中断上游请求。
 * @returns {AsyncGenerator<Uint8Array>} 原始块。
 */
async function* withIdleTimeout(body, idleMs, controller) {
  const iterator = body[Symbol.asyncIterator]();
  let timer;
  try {
    for (;;) {
      const next = iterator.next();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(Object.assign(new Error('upstream idle timeout'), { name: 'TimeoutError' }));
          reject(Object.assign(new Error('upstream idle timeout'), { name: 'TimeoutError' }));
        }, idleMs);
      });
      let result;
      try {
        result = await Promise.race([next, timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) return;
      yield result.value;
    }
  } finally {
    // 提前退出（调用方不再读）时也要让上游停止，否则连接会一直挂着
    iterator.return?.().catch(() => {});
  }
}

/**
 * 读一个请求的 body。
 * @param {import('node:http').IncomingMessage} request - 请求。
 * @returns {Promise<Buffer>} body。
 */
async function readBody(request, limit = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw Object.assign(new Error(`请求体超过 ${Math.round(limit / 1024 / 1024)}MiB 上限`), {
        status: 413,
        tooLarge: true,
      });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * 判断一次失败是否值得换一个账号重试。
 * @param {unknown} error - 抛出的错误。
 * @returns {{retry: boolean, cooldown: boolean}} 是否换人、是否给这个账号记冷却。
 */
export function classifyFailure(error) {
  const status = Number(error?.status);
  if (Number.isFinite(status) && status > 0) {
    return { retry: retryable(status), cooldown: retryable(status) };
  }
  // code 可能是字符串（ECONNRESET）也可能是数字（DOMException 的 23），
  // 超时还会把原因放在 name 里，所以两处都看。
  for (const candidate of [error?.code, error?.name, error?.cause?.code, error?.cause?.name]) {
    if (candidate && RETRYABLE_CODES.has(String(candidate))) return { retry: true, cooldown: true };
  }
  // 其它（调用方主动取消、400、序列化错误…）：换账号也一样
  return { retry: false, cooldown: false };
}

/**
 * 建一个网关。它不持有地址状态，每次请求都问监视器要**现在**能用的那个。
 * @param {object} deps - 依赖。
 * @param {() => object|null} deps.pickMonitor - 取当前要用的监视器。
 * @param {(exclude: object) => object[]} deps.fallbacks - 备用监视器。
 * @param {() => string} deps.getKey - 取访问密钥。
 * @param {() => string} deps.getHost - 取监听地址。
 * @param {() => number} deps.getPort - 取监听端口。
 * @param {(line: string) => void} [deps.log] - 日志。
 * @returns {object} 网关。
 */
export function createGateway({
  pickMonitor,
  fallbacks = () => [],
  getKey = () => '',
  getHost = () => DEFAULT_HOST,
  getPort = () => DEFAULT_PORT,
  threshold = () => 5,
  noticeTemplate = () => '',
  /** 没有任何可用账号时，给调用方一句具体原因（没配 / 全低于保底线…）。 */
  unavailableReason = () => '',
  upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS,
  upstreamIdleMs = UPSTREAM_IDLE_MS,
  maxBodyBytes = MAX_BODY_BYTES,
  log = () => {},
}) {
  let server = null;
  let listening = false;
  let wantStop = false;
  let host = DEFAULT_HOST;
  let port = DEFAULT_PORT;
  const stats = { requests: 0, refused: 0, failures: 0, failovers: 0, startedAt: 0 };
  /**
   * 账号冷却簿：identity → { until, count, reason }。
   *
   * 只降权、不排除：额度可能刚好恢复，令牌可能刚好修好，永久拉黑会让
   * 「修好了却还是不用它」变成一个没法解释的故障。
   */
  const cooldowns = new Map();

  /**
   * 账号的冷却状态。
   * @param {object} monitor - 监视器。
   * @returns {{active: boolean, remainingMs: number, reason: string}} 状态。
   */
  function cooldownOf(monitor) {
    const row = cooldowns.get(monitor?.identity ?? monitor?.label);
    const now = Date.now();
    if (!row || row.until <= now) {
      if (row) cooldowns.delete(monitor?.identity ?? monitor?.label);
      return { active: false, remainingMs: 0, reason: '' };
    }
    return { active: true, remainingMs: row.until - now, reason: row.reason };
  }

  /**
   * 记一次失败；到阈值就进冷却。
   * @param {object} monitor - 监视器。
   * @param {string} reason - 失败原因（给人看）。
   * @returns {void}
   */
  function penalize(monitor, reason) {
    const key = monitor?.identity ?? monitor?.label;
    if (!key) return;
    const row = cooldowns.get(key) ?? { count: 0, until: 0, reason: '' };
    row.count += 1;
    row.reason = reason;
    if (row.count >= COOLDOWN_AFTER) row.until = Date.now() + COOLDOWN_MS;
    cooldowns.set(key, row);
    log(`账号 ${monitor.label} 进入冷却 ${Math.round(COOLDOWN_MS / 1000)}s · ${reason}`);
  }

  /**
   * 一个账号的余额状态。
   * @param {object} monitor - 监视器。
   * @returns {{remain: number, total: number, low: boolean}|null} 状态，取不到时 null。
   */
  function creditState(monitor) {
    const credit = monitor?.quotaCache?.ledger?.credit;
    if (!credit || !Number.isFinite(credit.total) || credit.total <= 0) return null;
    if (!Number.isFinite(credit.remain)) return null;
    const ratio = remainPercentOf(credit) ?? 100;
    const limit = Number(threshold()) || 5;
    const low = ratio < limit;
    return {
      remain: Math.round(credit.remain * 100) / 100,
      total: Math.round(credit.total * 100) / 100,
      low,
      // 自定义文案已渲染；调用方拿到的是成品句子，不必自己拼数字
      notice: low
        ? renderNotice(noticeTemplate(),
          noticeVars({ account: monitor?.label ?? '', ledger: monitor?.quotaCache?.ledger, threshold: limit }))
        : '',
    };
  }

  /**
   * 一次成功就清掉计数：偶发失败不该累积成永久降权。
   * @param {object} monitor - 监视器。
   * @returns {void}
   */
  function reward(monitor) {
    const key = monitor?.identity ?? monitor?.label;
    if (key) cooldowns.delete(key);
  }

  /**
   * 把一次请求转发到一个监视器。
   *
   * 先拿到响应头再决定要不要换账号：4xx/5xx 时 body 很小，读掉重试；
   * 2xx 时**边读边写**，绝不能整体缓冲 —— 缓冲会让流式输出变成等全部生成完
   * 才一次性吐出，对话就"卡住"了。
   * @param {import('node:http').IncomingMessage} request - 请求。
   * @param {import('node:http').ServerResponse} response - 响应。
   * @param {object} monitor - 目标监视器。
   * @param {string} path - 上游路径（含查询）。
   * @param {Buffer} body - 请求体。
   * @returns {Promise<boolean>} 是否已经把响应交给调用方。
   */
  async function forward(request, response, monitor, path, body) {
    // 不在这里重复探测：监视器已经在巡检里维护了地址与可达性，
    // 每个候选再探一次只是浪费一次往返。地址缺失时才补一次 sync。
    if (!monitor.url) {
      await monitor.sync('gateway').catch(() => {});
      if ((!monitor.url || !monitor.reachable) && monitor.starting) {
        await monitor.waitUntilReady(60_000).catch(() => {});
      }
      if (!monitor.url) return false;
    } else if (!monitor.reachable && monitor.starting) {
      await monitor.waitUntilReady(60_000).catch(() => {});
    }
    if (!monitor.reachable && !monitor.url) return false;

    // 超时只管「拿到响应头」这一段。拿到之后立刻清掉定时器，
    // 否则长回答会在这里被拦腰切断（AbortSignal.timeout 会连流一起 abort）。
    const controller = new AbortController();
    const headTimer = setTimeout(() => {
      controller.abort(Object.assign(new Error('upstream timeout'), { name: 'TimeoutError' }));
    }, upstreamTimeoutMs);
    let upstream;
    try {
      upstream = await fetch(`${monitor.url}${path}`, {
        method: request.method,
        headers: upstreamHeaders(request.headers, monitor.proxyKey),
        body: body.length > 0 ? body : undefined,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(headTimer);
    }

    // 值得换一个账号再试的状态：先把小响应读完，把上游的原话带上，
    // 免得用户只看到「502」而不知道是额度问题还是密钥问题。
    if (retryable(upstream.status) || upstream.status === 400 || upstream.status === 422) {
      // 400/422 不换账号（请求本身有问题），但原话要透出去 ——
      // 否则用户只看到"400"，不知道是模型名错了还是参数不认识。
      const text = await upstream.text().catch(() => '');
      const next = Object.assign(new Error(`upstream ${upstream.status}`), {
        status: upstream.status,
        text,
      });
      throw next;
    }

    const headers = {};
    for (const [name, value] of upstream.headers) {
      if (HOP_HEADERS.has(name) || name === 'content-encoding') continue;
      headers[name] = value;
    }
    headers['access-control-allow-origin'] = '*';
    // 余额状态随每个响应带出去：调用方（界面、脚本）在对话开始前
    // 就能看到快到线了，而不是等 402 才反应过来。
    const credit = creditState(monitor);
    if (credit) {
      headers['x-cnb2api-credit-remain'] = String(credit.remain);
      headers['x-cnb2api-credit-total'] = String(credit.total);
      if (credit.low) headers['x-cnb2api-credit-low'] = '1';
      // 自定义提醒：HTTP 头只能是 ASCII，所以做 percent-encoding，
      // 调用方用 decodeURIComponent 还原。没配自定义文案时不下发。
      if (credit.low && credit.notice) {
        headers['x-cnb2api-credit-notice'] = encodeURIComponent(credit.notice);
      }
    }
    response.writeHead(upstream.status, headers);

    if (!upstream.body) {
      response.end();
      return true;
    }
    // 逐块转发：SSE 的实时性就靠这一句。空闲超时防止「上游不说话也不断开」。
    try {
      for await (const chunk of withIdleTimeout(upstream.body, upstreamIdleMs, controller)) {
        if (response.destroyed) break;
        response.write(chunk);
      }
    } catch (error) {
      // 响应头已经发出去了，换账号会在同一条流里写第二份内容。
      // 这里必须**销毁**连接：正常 end() 会让调用方以为「回答就这么短」，
      // 而实际是被截断的 —— 悄悄截断比报错危险得多。
      const broken = Object.assign(new Error(`stream from ${monitor.label} broke: ${error?.message || error}`), {
        status: 502,
        headersSent: true,
      });
      response.destroy(broken);
      throw broken;
    }
    response.end();
    return true;
  }

  /**
   * 处理一次请求。
   * @param {import('node:http').IncomingMessage} request - 请求。
   * @param {import('node:http').ServerResponse} response - 响应。
   * @returns {Promise<void>} 完成。
   */
  async function handle(request, response) {
    stats.requests += 1;
    const url = new URL(request.url || '/', 'http://localhost');

    if (request.method === 'OPTIONS') {
      response.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-headers': 'authorization, content-type, x-api-key, x-cnb2api-account',
        'access-control-allow-methods': 'GET, POST, OPTIONS',
      });
      response.end();
      return;
    }

    const key = String(getKey() || '');
    if (!key) {
      stats.refused += 1;
      sendJson(response, 401, {
        ok: false,
        reason: '网关没有设置访问密钥 · 在插件设置里生成或填写一个',
      });
      return;
    }
    const presented = presentedKey(request);
    if (!presented) {
      stats.refused += 1;
      sendJson(response, 401, {
        ok: false,
        reason: '缺少访问密钥 · 加 Authorization: Bearer <key>，密钥在插件设置里',
      });
      return;
    }
    if (!sameSecret(presented, key)) {
      stats.refused += 1;
      sendJson(response, 401, {
        ok: false,
        reason: '访问密钥不正确 · 用插件设置里显示的那个',
      });
      return;
    }

    const path = `${url.pathname}${url.search}`;
    let body;
    try {
      body = ['GET', 'HEAD'].includes(String(request.method))
        ? Buffer.alloc(0)
        : await readBody(request, maxBodyBytes);
    } catch (error) {
      if (error?.tooLarge) {
        sendJson(response, 413, { ok: false, reason: error.message });
        return;
      }
      throw error;
    }

    // 显式指定账号优先，其次按可用性挑 —— 不能永远取第一个：
    // 多账号下第一个往往正是额度用尽的那个。
    const wanted = String(request.headers['x-cnb2api-account'] || '').trim();
    // pickMonitor 只调一次：它每次都可能返回不同的监视器（额度/状态在变），
    // 调两次会让「首选」和「备用列表的排除项」不是同一个账号。
    const primary = pickMonitor();
    const all = [primary, ...fallbacks(primary)].filter(Boolean);
    const ordered = wanted
      ? [...all].sort((a, b) => Number(b.repo === wanted || b.label === wanted)
        - Number(a.repo === wanted || a.label === wanted))
      : all;
    const candidates = [];
    for (const monitor of ordered) if (!candidates.includes(monitor)) candidates.push(monitor);

    // 显式点名了一个账号，但它当前不可用（低于保底线 / 不可达）：如实拒绝，
    // 不要悄悄改用别的账号 —— 调用方以为走了 A，实际写到了 B 的额度里。
    if (wanted && candidates.length > 0
      && !candidates.some((m) => m.repo === wanted || m.label === wanted)) {
      stats.failures += 1;
      sendJson(response, 503, {
        ok: false,
        reason: `指定的账号 ${wanted} 当前不可用（低于保底线、不可达或未运行）`,
      });
      return;
    }

    if (candidates.length === 0) {
      stats.failures += 1;
      // 「没配账号」和「都低于保底线」是两回事，说清楚用户才知道该去做什么
      const why = String(unavailableReason() || '').trim();
      sendJson(response, 503, {
        ok: false,
        reason: why || '尚未配置 CNB 账号 · 在插件设置里添加一个',
      });
      return;
    }

    // 冷却中的账号排到最后，但仍然会试 —— 额度可能刚好恢复。
    // 显式点名要某个账号时不打乱它的位置：用户的意思比启发式更准。
    const ranked = wanted
      ? candidates
      : [...candidates].sort((a, b) => Number(cooldownOf(a).active) - Number(cooldownOf(b).active));

    let lastError = null;
    let tried = 0;
    let lastMonitor = null;
    for (const monitor of ranked) {
      lastMonitor = monitor;
      try {
        if (await forward(request, response, monitor, path, body)) {
          reward(monitor);
          if (tried > 0) stats.failovers += 1;
          return;
        }
        lastError = new Error(monitor.lastError || '网关地址不可用');
        penalize(monitor, lastError.message);
      } catch (error) {
        lastError = error;
        const verdict = classifyFailure(error);
        if (verdict.cooldown) penalize(monitor, error?.message || String(error));
        // 响应头已经发出去了：换账号会在同一条流里写第二份内容
        if (error?.headersSent) break;
        if (!verdict.retry) break;
        tried += 1;
      }
    }

    stats.failures += 1;
    if (response.headersSent) {
      response.end();
      return;
    }
    const detail = lastError?.text ? pickMessage(lastError.text) : '';
    // 请求本身有错（400/422）时原样返回该状态码：改写成 503 会让调用方
    // 以为是服务不可用、去重试一个注定失败的请求。
    const upstreamStatus = Number(lastError?.status);
    const badRequest = upstreamStatus === 400 || upstreamStatus === 422;
    const status = badRequest ? upstreamStatus : 503;
    sendJson(response, status, {
      ok: false,
      reason: badRequest
        ? `cnb2api 拒绝了这次请求 · ${detail || lastError?.message || ''}`
        : `cnb2api 不可用 · ${lastError?.message || '没有可用账号'}`,
      ...(detail && !badRequest ? { upstream: detail } : {}),
      hint: lastMonitor?.creditExhausted
        ? '额度补足后工作区会自动启动'
        : '检查令牌是否具备 account-engage:r 与 repo-cnb-trigger:r',
    });
  }

  /**
   * 在给定端口上开始监听，占用则顺延。
   * @param {number} attempt - 已经尝试的次数。
   * @returns {Promise<void>} 绑定完成。
   */
  function listen(attempt = 0) {
    const configured = Number(getPort());
    // 0 = 让内核分配空闲端口（测试与「随便找个端口」的场景）
    const wantPort = configured === 0 ? 0 : (configured || DEFAULT_PORT);
    const tryPort = wantPort === 0 ? 0 : wantPort + attempt;
    return new Promise((resolve, reject) => {
      const candidate = http.createServer((request, response) => {
        handle(request, response).catch((error) => {
          stats.failures += 1;
          if (!response.headersSent) {
            sendJson(response, 500, { ok: false, reason: error?.message || 'gateway error' });
          } else {
            response.end();
          }
        });
      });
      candidate.once('error', (error) => {
        if (error?.code === 'EADDRINUSE' && tryPort !== 0 && attempt + 1 < PORT_TRIES) {
          listen(attempt + 1).then(resolve, reject);
          return;
        }
        reject(error);
      });
      candidate.listen(tryPort, host, () => {
        server = candidate;
        // 传 0 时由内核分配，实际端口只能问 socket 要
        port = candidate.address().port;
        listening = true;
        // 不因为这个监听套接字把宿主进程钉住：DSH 自己有事件循环，
        // 而测试/CLI 场景下没它就该能正常退出
        candidate.unref?.();
        resolve();
        // start() 还没返回就被 stop() 了：这里补一次停止，
        // 否则监听套接字会一直活着，进程退不出去
        if (wantStop) {
          wantStop = false;
          candidate.close();
          server = null;
          listening = false;
        }
      });
    });
  }

  return {
    /**
     * 启动网关。
     *
     * 监听非回环地址时**必须有密钥**：没有鉴权的 0.0.0.0 等于把用户的额度
     * 开放给整个局域网。
     * @returns {Promise<{port: number, host: string}>} 实际监听。
     */
    async start() {
      if (listening) return { port, host };
      host = String(getHost() || DEFAULT_HOST);
      if (!isLoopbackHost(host) && !String(getKey() || '')) {
        throw new Error('监听局域网地址前必须先设置访问密钥');
      }
      await listen();
      stats.startedAt = Date.now();
      log(`网关已监听 ${host}:${port}`);
      return { port, host };
    },

    /**
     * 停止网关。
     * @returns {Promise<void>} 完成。
     */
    async stop() {
      if (!server && !listening) {
        // 可能正处在 start() 中间：记下来，绑定完成后立刻关掉
        wantStop = true;
        return;
      }
      const current = server;
      server = null;
      listening = false;
      await new Promise((resolve) => current.close(() => resolve()));
    },

    /** 端口被占用等原因换了端口后重启。 */
    async restart() {
      await this.stop();
      // stop() 在「当前未监听」时只会置 wantStop 标记（那是给 stop-during-start 用的）。
      // 这里是重启，紧接着要 start()，必须清掉该标记，否则 listen 回调会立刻把刚建好的
      // 监听关掉，导致重启后反而不再监听。
      wantStop = false;
      await this.start();
    },

    /**
     * 给调用方用的基址。
     * @param {string} [address] - 指定地址，缺省用回环。
     * @returns {string} 形如 `http://127.0.0.1:41729/v1`。
     */
    baseUrl(address = '127.0.0.1') {
      return `http://${address}:${port}/v1`;
    },

    /**
     * 当前状态。
     * @returns {object} 状态快照。
     */
    status() {
      const cooling = {};
      for (const [key, row] of cooldowns) {
        if (row.until > Date.now()) cooling[key] = { remainingMs: row.until - Date.now(), reason: row.reason };
      }
      return {
        cooling,
        listening,
        host,
        port,
        baseUrl: this.baseUrl(),
        lan: lanAddresses().map((address) => this.baseUrl(address)),
        ...stats,
      };
    },
  };
}
