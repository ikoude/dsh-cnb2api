// cnb2api · WebDAV 传输
//
// 只做两件事：把一个字符串 PUT 到 WebDAV 路径，或从该路径 GET 回来。
// 不做目录管理、不做 PROPFIND —— 备份是固定文件名，够用即可。
//
// 由 Host 侧代发请求而不是浏览器直连：WebDAV 服务器普遍不带 CORS 头，
// 浏览器里 fetch 会被跨域拦掉；Host 在 Node 里跑，没有这个限制。

/** 默认超时：网盘在大陆可能很慢，但 30s 还传不完的备份文件本来就不该用。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * 把凭据拼成 Basic 认证头。
 * @param {string} username - 用户名。
 * @param {string} password - 密码。
 * @returns {string} 头部值；用户名空时返回空串。
 */
function basicAuth(username, password) {
  if (!username) return '';
  return `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
}

/**
 * 规范化 WebDAV 目标地址。
 *
 * 允许用户只填服务器根地址（`https://dav.example.com/dav`）或直接填到文件
 * （`.../cnb2api-backup.json`）；没带文件名时补上默认文件名。
 * @param {string} baseUrl - 用户填写的地址。
 * @param {string} [fileName] - 文件名。
 * @returns {string} 完整目标 URL。
 * @throws {Error} 协议不是 http/https 或地址非法。
 */
export function davTarget(baseUrl, fileName = 'cnb2api-backup.json') {
  const raw = String(baseUrl || '').trim();
  if (!raw) throw new Error('先填 WebDAV 地址');
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WebDAV 地址不是合法 URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('WebDAV 地址只支持 http / https');
  }
  // fragment 不会发给服务器，留着只会让「显示的地址」和「实际请求的地址」不一致
  if (url.hash) throw new Error('WebDAV 地址不要带 # 片段');
  // query 拼到文件名后会变成 `backup.json?x=1` 这种诡异文件名；明确拒绝
  if (url.search) throw new Error('WebDAV 地址不要带 ? 查询参数');
  // 只填了目录（以 / 结尾）就补默认文件名
  if (url.pathname.endsWith('/')) url.pathname += fileName;
  return url.toString();
}

/**
 * 上传文本到 WebDAV（PUT）。
 * @param {object} input - 上传参数。
 * @param {string} input.url - 服务器地址。
 * @param {string} input.username - 用户名。
 * @param {string} input.password - 密码。
 * @param {string} input.content - 文件内容。
 * @param {number} [input.timeoutMs] - 超时毫秒。
 * @returns {Promise<{url: string, bytes: number}>} 目标地址与字节数。
 * @throws {Error} 网络错误或服务器拒绝。
 */
export async function davPut({ url, username = '', password = '', content, timeoutMs }) {
  const target = davTarget(url);
  const body = String(content ?? '');
  const headers = {
    'content-type': 'application/json; charset=utf-8',
    // 备份文件不大，但显式给长度能让部分服务器跳过 chunked
    'content-length': String(Buffer.byteLength(body, 'utf8')),
  };
  const auth = basicAuth(username, password);
  if (auth) headers.authorization = auth;
  const response = await fetch(target, {
    method: 'PUT',
    headers,
    body,
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`WebDAV 上传失败 · HTTP ${response.status}${text ? ` · ${text.slice(0, 120)}` : ''}`);
  }
  return { url: target, bytes: Buffer.byteLength(body, 'utf8') };
}

/**
 * 从 WebDAV 下载文本（GET）。
 * @param {object} input - 下载参数。
 * @param {string} input.url - 服务器地址。
 * @param {string} input.username - 用户名。
 * @param {string} input.password - 密码。
 * @param {number} [input.timeoutMs] - 超时毫秒。
 * @returns {Promise<{content: string, url: string}>} 文件内容与来源地址。
 * @throws {Error} 404 单独说明（多半是文件名不对或从没上传过）。
 */
export async function davGet({ url, username = '', password = '', timeoutMs }) {
  const target = davTarget(url);
  const headers = { accept: 'application/json, text/plain, */*' };
  const auth = basicAuth(username, password);
  if (auth) headers.authorization = auth;
  const response = await fetch(target, {
    headers,
    signal: AbortSignal.timeout(timeoutMs || DEFAULT_TIMEOUT_MS),
  });
  if (response.status === 404) {
    throw new Error('WebDAV 上没有这个文件 · 检查地址与文件名是否一致');
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`WebDAV 下载失败 · HTTP ${response.status}${text ? ` · ${text.slice(0, 120)}` : ''}`);
  }
  return { content: await response.text(), url: target };
}
