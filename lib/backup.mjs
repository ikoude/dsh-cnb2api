// cnb2api · 账号备份与还原
//
// 只做纯数据变换：把账号/设置打包成一份可移植的文档，再解回来。
// 不碰配置、不联网 —— 写配置由界面走已有的 mutate 路径，传输由 webdav.mjs 负责。
//
// 为什么默认加密：备份里最值钱的东西是 `token` 和 `proxyKey`，都是明文凭据。
// 文件一旦落到网盘、聊天工具或别人的电脑上，等于把账号交出去。口令加密后
// 即使文件泄露，没有口令也解不开。

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/** 备份格式标识，防止把别的 JSON 当备份导入。 */
export const BACKUP_FORMAT = 'cnb2api-backup';
/** 当前格式版本。将来改结构时用它决定怎么读旧文件。 */
export const BACKUP_VERSION = 1;

/** 备份范围。 */
export const SCOPE = { accounts: 'accounts', settings: 'settings', all: 'all' };

/** 可以进备份的全局设置字段白名单 —— 只收用户可配、且跨机器有意义的项。 */
const SETTINGS_FIELDS = [
  'checkSeconds', 'autoStart', 'locale',
  'gatewayHost', 'gatewayPort', 'autoPublish',
  'lowCreditPercent', 'creditFloorPercent', 'lowCreditMessage',
  'models', 'branch', 'port',
];

/** 账号字段白名单：备份只带这些，别的一律丢弃（避免把界面用的 _id 之类写进文件）。 */
const ACCOUNT_FIELDS = ['token', 'repo', 'proxyKey', 'branch', 'port'];

/** scrypt 参数：N=16384 在浏览器/Node 上都在 100ms 量级，足够挡住离线爆破。 */
const KDF = { name: 'scrypt', N: 16384, r: 8, p: 1, keylen: 32 };
const SALT_BYTES = 16;
const IV_BYTES = 12;

/**
 * 只保留账号里允许的字段，并把端口转成正整数。
 * @param {object} row - 任意来源的账号对象。
 * @returns {object} 干净的账号。
 */
function cleanAccount(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return {};
  const out = {};
  for (const key of ACCOUNT_FIELDS) {
    if (!(key in row)) continue;
    if (key === 'port') {
      const port = Number(row.port);
      if (Number.isFinite(port) && port > 0) out.port = Math.round(port);
      continue;
    }
    const value = String(row[key] ?? '').trim();
    if (value) out[key] = value;
  }
  return out;
}

/**
 * 只保留设置里允许的字段。
 * @param {object} settings - 全局设置。
 * @returns {object} 干净的设置。
 */
function cleanSettings(settings) {
  const out = {};
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) return out;
  for (const key of SETTINGS_FIELDS) {
    if (!(key in settings)) continue;
    const value = settings[key];
    if (value === undefined || value === null) continue;
    out[key] = key === 'checkSeconds' || key === 'gatewayPort' || key === 'lowCreditPercent'
      || key === 'creditFloorPercent' || key === 'port'
      ? Number(value)
      : typeof value === 'boolean' ? value : String(value);
  }
  return out;
}

/**
 * 打包一份备份文档。
 * @param {object} input - 打包输入。
 * @param {string} input.scope - {@link SCOPE} 之一。
 * @param {object[]} [input.accounts] - 账号列表。
 * @param {object} [input.settings] - 全局设置。
 * @param {string} [input.password] - 口令；给了就加密。
 * @returns {object} 可直接 JSON.stringify 的文档。
 */
export function buildBackup({ scope, accounts = [], settings = {}, password = '' }) {
  const wanted = Object.hasOwn(SCOPE, scope) ? SCOPE[scope] : SCOPE.all;
  const payload = {};
  if (wanted === SCOPE.accounts || wanted === SCOPE.all) {
    payload.accounts = accounts.map(cleanAccount).filter((row) => row.token && row.repo);
  }
  if (wanted === SCOPE.settings || wanted === SCOPE.all) {
    payload.settings = cleanSettings(settings);
  }
  const doc = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    scope: wanted,
  };
  if (!password) {
    return { ...doc, encrypted: false, data: payload };
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = scryptSync(password, salt, KDF.keylen, { N: KDF.N, r: KDF.r, p: KDF.p });
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(payload), 'utf8'), cipher.final()]);
  return {
    ...doc,
    encrypted: true,
    kdf: { name: KDF.name, N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64') },
    cipher: { name: 'aes-256-gcm', iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') },
    data: body.toString('base64'),
  };
}

/**
 * 严格解码 base64：Buffer.from 对坏字符很宽容，会静默产生乱码。
 * @param {unknown} value - 待解码字符串。
 * @param {number} bytes - 期望字节数。
 * @param {string} label - 出错时的字段名。
 * @returns {Buffer} 解码结果。
 */
function decodeBase64(value, bytes, label) {
  const text = String(value ?? '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) {
    throw new Error(`备份文件损坏 · ${label} 不是合法 base64`);
  }
  const buf = Buffer.from(text, 'base64');
  if (buf.length !== bytes) {
    throw new Error(`备份文件损坏 · ${label} 长度不对`);
  }
  return buf;
}

/**
 * 解析并校验一份备份文档。
 *
 * 错误信息要能直接显示给用户：说明是「不是备份文件」「口令错了」还是「版本太新」。
 * @param {string|object} input - 文件内容（JSON 文本或已解析对象）。
 * @param {string} [password] - 口令。
 * @returns {{scope: string, accounts: object[], settings: object, exportedAt: string}} 解析结果。
 * @throws {Error} 格式不符、版本不支持或口令错误。
 */
export function parseBackup(input, password = '') {
  let doc;
  try {
    doc = typeof input === 'string' ? JSON.parse(input) : input;
  } catch {
    throw new Error('这不是备份文件 · 需要 cnb2api 导出的 JSON');
  }
  if (!doc || doc.format !== BACKUP_FORMAT) {
    throw new Error('这不是 cnb2api 的备份文件');
  }
  if (doc.version === undefined || doc.version === null || doc.version === '') {
    throw new Error('备份文件缺少版本号 · 不是有效的 cnb2api 备份');
  }
  if (!Number.isFinite(Number(doc.version))) {
    throw new Error('备份版本号不是数字 · 文件可能已损坏');
  }
  if (Number(doc.version) > BACKUP_VERSION) {
    throw new Error(`备份版本 ${String(doc.version)} 比当前插件新 · 先升级插件`);
  }
  let payload;
  if (doc.encrypted) {
    if (!password) throw new Error('这份备份已加密 · 需要口令');
    // 算法名也要认：将来换了算法不能拿旧代码硬解
    if (doc.kdf?.name !== KDF.name) throw new Error(`不支持的密钥派生算法 · ${String(doc.kdf?.name)}`);
    if (doc.cipher?.name !== 'aes-256-gcm') throw new Error(`不支持的加密算法 · ${String(doc.cipher?.name)}`);
    const N = Number(doc.kdf?.N);
    const r = Number(doc.kdf?.r);
    const p = Number(doc.kdf?.p);
    // scrypt 参数来自不可信文件：N 过大会直接抛 RangeError 或吃满内存，必须先夹住
    if (!Number.isSafeInteger(N) || N < 1024 || N > 65536
      || !Number.isSafeInteger(r) || r < 1 || r > 32
      || !Number.isSafeInteger(p) || p < 1 || p > 16) {
      throw new Error('备份文件损坏 · 加密参数超出允许范围');
    }
    const salt = decodeBase64(doc.kdf?.salt, SALT_BYTES, 'salt');
    const iv = decodeBase64(doc.cipher?.iv, IV_BYTES, 'iv');
    const tag = decodeBase64(doc.cipher?.tag, 16, 'tag');
    const bodyText = String(doc.data || '');
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(bodyText) || bodyText.length % 4 !== 0) {
      throw new Error('备份文件损坏 · 密文不是合法 base64');
    }
    try {
      const key = scryptSync(password, salt, KDF.keylen, { N, r, p });
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const text = Buffer.concat([
        decipher.update(Buffer.from(bodyText, 'base64')),
        decipher.final(),
      ]).toString('utf8');
      payload = JSON.parse(text);
    } catch {
      // GCM 校验失败几乎只有一种原因：口令不对（或文件被改过）
      throw new Error('口令不对，或备份文件被损坏');
    }
  } else {
    payload = doc.data || {};
  }
  const accounts = Array.isArray(payload.accounts)
    ? payload.accounts.map(cleanAccount).filter((row) => row.token && row.repo)
    : [];
  const settings = cleanSettings(payload.settings || {});
  if (doc.scope !== undefined && !Object.hasOwn(SCOPE, doc.scope)) {
    throw new Error(`备份文件里的范围 ${String(doc.scope)} 不认识`);
  }
  const scope = Object.hasOwn(SCOPE, doc.scope) ? doc.scope : SCOPE.all;
  if (scope !== SCOPE.settings && accounts.length === 0) {
    throw new Error('备份里没有可用的账号');
  }
  return { scope, accounts, settings, exportedAt: String(doc.exportedAt || '') };
}

/**
 * 把备份里的账号合并到现有列表。
 *
 * 默认「合并」：按 repo 对齐，同仓库以备份为准，新仓库追加，现有但备份没有的保留。
 * 需要完全覆盖时由调用方先把现有列表传空。
 * @param {object[]} existing - 现有账号。
 * @param {object[]} incoming - 备份里的账号。
 * @returns {{accounts: object[], added: number, replaced: number}} 合并结果与计数。
 */
export function mergeAccounts(existing, incoming) {
  const current = [];
  const byRepo = new Map();
  const keyOf = (row) => String(row?.repo || '').trim().toLowerCase();
  // 现有列表也按 repo 去重（大小写不敏感）：重复仓库会让「同仓库覆盖」只命中最后一条，
  // 还原后仍剩两条同仓库账号。保留第一次出现的那条。
  for (const source of Array.isArray(existing) ? existing : []) {
    if (!source || typeof source !== 'object') continue;
    const key = keyOf(source);
    if (key && byRepo.has(key)) continue;
    const row = { ...source };
    if (key) {
      // 匹配用的 key 与落盘的 repo 保持一致，避免大小写变体日后再次重复
      row.repo = String(row.repo).trim().toLowerCase();
      byRepo.set(key, current.length);
    }
    current.push(row);
  }
  let added = 0;
  let replaced = 0;
  for (const row of Array.isArray(incoming) ? incoming : []) {
    if (!row || typeof row !== 'object') continue;
    const key = keyOf(row);
    if (!key) continue;
    const normalized = { ...row, repo: key };
    const at = byRepo.get(key);
    if (at === undefined) {
      byRepo.set(key, current.length);
      current.push(normalized);
      added += 1;
    } else {
      // 同仓库以备份为准，但保留现有条目里备份没覆盖的额外字段
      // （比如界面用的 _id，丢了会让折叠状态串位）
      current[at] = { ...current[at], ...normalized };
      replaced += 1;
    }
  }
  return { accounts: current, added, replaced };
}
