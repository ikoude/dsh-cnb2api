// cnb2api · CNB OpenAPI
//
// 一层薄封装：发请求、把错误翻成人话、把响应收成调用方要的形状。
// 不持有账号状态 —— 令牌与仓库都由调用方传入，所以这里没有闭包里的"当前账号"。
//
// 三条实测得出的口径（写错任何一条都会得到错误结论）：
//
// 1. `/workspace/list` 的 `slug` 参数会**漏记录**。实测某仓库在平台上共 5 条
//    （1 running + 4 closed），带 slug 只回 1 条 —— 那 4 条的 repo_url 指向别的
//    组织，被服务端当成"不属于这个 slug"滤掉了。所以拉全量、本地按仓库筛。
// 2. `/{repo}` 对存在的私有仓库可能回 403（缺详情权限），所以**只有 404 才代表
//    仓库不存在**，403 说明仓库在、只是看不了。
// 3. 只有 403 且带 `Missing required scopes:` 才是权限问题；其余 403 是业务拒绝。

import { findGatewayUrl, findGatewayUrlInLog, parseRepo } from './address.mjs';

/** 默认 API 地址。 */
export const API_BASE = 'https://api.cnb.cool';

/**
 * 权限不足。单独一个类型，因为调用方处理方式完全不同：
 * 读日志缺权限 = 插件不可用；启动缺权限 = 只损失自动重启。
 */
export class ScopeError extends Error {
  /**
   * @param {string} message - 人话描述。
   * @param {string[]} scopes - 缺少的 scope 列表。
   */
  constructor(message, scopes) {
    super(message);
    this.name = 'ScopeError';
    this.scopes = scopes;
    this.permission = true;
  }
}

/** scope → 用途与后果。缺权限时据此说清「该勾哪个、会影响什么」。 */
export const SCOPES = {
  'repo-cnb-trigger:r': {
    what: '读启动日志',
    why: '工作区地址只能从启动日志的 PROXY_URI= 一行取到。',
    without: '取不到地址，插件不可用',
  },
  'account-engage:r': {
    what: '列出工作区',
    why: '要先知道有哪些工作区，才能读对应日志。',
    without: '找不到工作区，插件不可用',
  },
  'repo-cnb-trigger:rw': {
    what: '启动工作区',
    why: '工作区被平台停掉后自动拉起。',
    without: '地址仍可跟随，但停了不会自动启动',
  },
  'group-resource:r': {
    what: '组织额度',
    why: '显示 AI credits 与核时，并在额度用尽时拦住不必要的启动。',
    without: '不显示额度；启动前不再拦截（查不到即放行）',
  },
  'repo-cnb-detail:r': {
    what: '工作区详情',
    why: '优先从详情取地址，比读整份日志快。',
    without: '回退到读日志，略慢',
  },
};

/** 缺了就不能工作的 scope。 */
export const REQUIRED_SCOPES = ['repo-cnb-trigger:r', 'account-engage:r'];

/**
 * 从 403 响应体里取出缺哪些 scope。
 * @param {string} body - 响应正文。
 * @returns {string[]|null} scope 列表；不是权限报文时返回 null。
 */
export function parseMissingScopes(body) {
  const hit = String(body || '').match(/Missing required scopes?:\s*([a-z0-9:,\s_-]+)/i);
  if (!hit) return null;
  return hit[1].split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
}

/**
 * 把缺少的 scope 组成一句可执行的说明。
 * @param {string[]} scopes - 缺少的 scope。
 * @returns {string} 人话。
 */
export function explainScopes(scopes) {
  const known = scopes.map((scope) => {
    const info = SCOPES[scope];
    return info ? `${scope}（${info.what}）：${info.without}` : scope;
  });
  return `令牌缺少权限 · ${known.join('；')} · 在 CNB 头像 → 访问令牌 → 编辑 中勾选后重试`;
}

/**
 * 建一个绑定到某个 API 地址的客户端。
 * @param {object} [options] - 客户端选项。
 * @param {string} [options.baseUrl] - API 根地址。
 * @param {typeof fetch} [options.fetch] - 注入用（测试）。
 * @returns {object} 客户端方法集。
 */
export function createClient({ baseUrl = API_BASE, fetch = globalThis.fetch } = {}) {
  const root = String(baseUrl || API_BASE).replace(/\/+$/, '');

  /**
   * 发一个带令牌的请求，非 2xx 抛错。
   * @param {string} token - CNB 访问令牌。
   * @param {string} path - 以 `/` 开头的路径。
   * @param {object} [init] - fetch 选项，另支持 `timeout`。
   * @returns {Promise<Response>} 响应。
   */
  async function request(token, path, init = {}) {
    if (!token) throw new Error('尚未填写 CNB 访问令牌');
    const { timeout, ...rest } = init;
    const response = await fetch(`${root}${path}`, {
      ...rest,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(rest.body ? { 'Content-Type': 'application/json' } : {}),
        ...(rest.headers || {}),
      },
      signal: rest.signal || AbortSignal.timeout(timeout || 20000),
    });
    if (response.ok) return response;
    const body = await response.text().catch(() => '');
    if (response.status === 403) {
      const missing = parseMissingScopes(body);
      if (missing) throw new ScopeError(explainScopes(missing), missing);
    }
    const error = new Error(`${path} → HTTP ${response.status}${body ? ` · ${body.slice(0, 120)}` : ''}`);
    error.status = response.status;
    throw error;
  }

  /**
   * 把异常翻成一句人话。
   * @param {unknown} error - 捕获到的异常。
   * @returns {string} 人话。
   */
  function describe(error) {
    const message = String(error?.message ?? error ?? '');
    if (error?.permission) return message;
    if (error?.status === 401 || /HTTP 401/.test(message)) return '令牌无效或已过期 · 在 CNB 头像 → 访问令牌 重新生成';
    if (error?.status === 404) return '不存在或令牌无权访问';
    if (/timeout|aborted|operation was aborted/i.test(message)) return '请求超时 · 稍后自动重试';
    return message;
  }

  /**
   * 拉全部工作区记录，本地按仓库筛。
   * @param {string} token - 令牌。
   * @param {string} [repo] - 只保留该仓库的记录；省略返回全部。
   * @returns {Promise<object[]>} 工作区记录。
   */
  async function listWorkspaces(token, repo = '') {
    const pageSize = 100;
    const maxPages = 10;
    const all = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      const response = await request(token, `/workspace/list?${query}`);
      const body = await response.json();
      const rows = body.list || body.data || [];
      all.push(...rows);
      if (rows.length === 0) break;
      // 上游字段名不统一：hasMore / has_more 都见过；两者都没给时，
      // 用「这一页不满」作为终止条件。只认 hasMore 会在字段改名后
      // 悄悄只取第一页，进而选错工作区。
      const hasMore = body.hasMore ?? body.has_more;
      if (hasMore === false) break;
      if (hasMore === undefined && rows.length < pageSize) break;
      const total = Number(body.total);
      if (Number.isFinite(total) && all.length >= total) break;
    }
    if (!repo) return all;
    return all.filter((row) => repoOfRecord(row) === repo);
  }

  /**
   * 工作区记录归属哪个仓库：`slug` 优先，缺了才退回 `repo_url`。
   * @param {object} record - 工作区记录。
   * @returns {string} `org/repo`。
   */
  function repoOfRecord(record) {
    const slug = String(record?.slug || '').replace(/^\/+|\/+$/g, '');
    if (slug) return slug;
    const rest = String(record?.repo_url || '')
      .replace(/^https?:\/\/[^/]+\//, '')
      .replace(/\.git$/, '')
      .replace(/\/+$/, '');
    // 只取前两段：repo_url 可能带 `/-/tree/main` 之类的尾巴，
    // 不截断会让按仓库相等过滤失败，整条记录被漏掉。
    return rest.split('/').filter(Boolean).slice(0, 2).join('/');
  }

  /**
   * 挑要用的那条工作区记录。
   *
   * 同一仓库会攒下多条（每次启停各留一条，实测能到 9 条）。优先 running，
   * 其次最新的 —— 最新的重启最快，环境也最接近上次。
   * @param {string} token - 令牌。
   * @param {string} repo - 仓库。
   * @returns {Promise<object|null>} 记录，或 null 表示该仓库没有工作区。
   */
  async function pickWorkspace(token, repo) {
    const rows = await listWorkspaces(token, repo);
    if (rows.length === 0) return null;
    const timeOf = (record) => {
      for (const key of ['create_time', 'createTime', 'created_at', 'updated_at']) {
        const parsed = Date.parse(record?.[key] || '');
        if (Number.isFinite(parsed)) return parsed;
      }
      return 0;
    };
    const running = rows.filter((row) => row.status === 'running');
    const pool = running.length > 0 ? running : rows;
    return pool.sort((a, b) => timeOf(b) - timeOf(a))[0];
  }

  /**
   * 仓库是否存在。只有 404 才判否 —— 403 表示仓库在、只是无权看详情。
   * @param {string} token - 令牌。
   * @param {string} repo - 仓库。
   * @returns {Promise<boolean>} 是否存在。
   */
  async function repoExists(token, repo) {
    if (!repo || !repo.includes('/')) return false;
    try {
      await request(token, `/${repo}`, { timeout: 12000 });
      return true;
    } catch (error) {
      return error?.status !== 404;
    }
  }

  /**
   * 从工作区详情里找地址（快路径）。多数情况下拿不到：详情返回的是
   * cnb.cool 控制台地址，不含 cnb.run 子域。保留它是因为上游可能调整字段。
   * @param {string} token - 令牌。
   * @param {string} repo - 仓库。
   * @param {string} workspaceId - 工作区编号。
   * @param {number} port - 网关端口。
   * @returns {Promise<string|null>} 地址。
   */
  async function urlFromDetail(token, repo, workspaceId, port) {
    try {
      const response = await request(token, `/${repo}/-/workspace/detail/${encodeURIComponent(workspaceId)}`, {
        timeout: 12000,
      });
      const body = await response.json();
      for (const field of ['webide', 'jumpUrl', 'codebuddyweb', 'remoteSsh']) {
        const url = findGatewayUrl(body?.[field], port);
        if (url) return url;
      }
    } catch {
      // 刚启动时详情可能 404，交给日志兜底
    }
    return null;
  }

  /**
   * 从启动日志里找地址（唯一可靠路径）。
   * @param {string} token - 令牌。
   * @param {string} repo - 仓库。
   * @param {string} workspaceId - 工作区编号。
   * @param {number} port - 网关端口。
   * @returns {Promise<string|null>} 地址。
   */
  async function urlFromLog(token, repo, workspaceId, port) {
    try {
      const response = await request(
        token,
        `/${repo}/-/build/runner/download/log/${encodeURIComponent(workspaceId)}-001`,
        { timeout: 30000 },
      );
      return findGatewayUrlInLog(await response.text(), port);
    } catch (error) {
      // 权限问题必须冒泡：这是唯一能取到地址的路子
      if (error?.permission) throw error;
      return null;
    }
  }

  /**
   * 解析工作区地址，快路径优先。
   * @param {string} token - 令牌。
   * @param {string} repo - 仓库。
   * @param {string} workspaceId - 工作区编号。
   * @param {number} port - 网关端口。
   * @returns {Promise<string|null>} 地址。
   */
  async function resolveUrl(token, repo, workspaceId, port) {
    return (await urlFromDetail(token, repo, workspaceId, port))
      || (await urlFromLog(token, repo, workspaceId, port));
  }

  /**
   * 网关自身的健康检查：200 且带 `"status":"ok"`。
   * @param {string} baseUrl - 网关地址。
   * @param {number} [timeoutMs] - 超时。
   * @returns {Promise<boolean>} 是否就绪。
   */
  async function healthy(baseUrl, timeoutMs = 12000) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'manual',
      });
      if (response.status !== 200) return false;
      return /"status"\s*:\s*"ok"/.test(await response.text());
    } catch {
      return false;
    }
  }

  /**
   * 提交启动。
   * @param {string} token - 令牌。
   * @param {string} repo - 仓库。
   * @param {string} branch - 分支。
   * @returns {Promise<void>}
   */
  async function startWorkspace(token, repo, branch) {
    await request(token, `/${repo}/-/workspace/start`, {
      method: 'POST',
      body: JSON.stringify({ branch }),
      timeout: 60000,
    });
  }

  /**
   * 查组织额度。三个接口并行，各自失败只记原因，不影响另外两个。
   * @param {string} token - 令牌。
   * @param {string} org - 组织。
   * @param {number} [timeoutMs] - 单接口超时。
   * @returns {Promise<{quota: object|null, volume: object|null, special: object|null, failures: string[]}>}
   */
  async function readQuota(token, org, timeoutMs = 20000) {
    const failures = [];
    const grab = async (suffix) => {
      try {
        const response = await request(token, `/${org}/-/charge/${suffix}`, { timeout: timeoutMs });
        return await response.json();
      } catch (error) {
        failures.push(describe(error));
        return null;
      }
    };
    const [quota, volume, special] = await Promise.all([
      grab('quota'),
      grab('volume'),
      grab('special-amount'),
    ]);
    return { quota, volume, special, failures };
  }

  /**
   * 列出令牌可访问的仓库。
   * @param {string} token - 令牌。
   * @returns {Promise<string[]|null>} `org/repo` 列表；请求失败返回 null。
   */
  async function listRepos(token) {
    try {
      const response = await request(token, '/user/repos?page=1&page_size=100', { timeout: 15000 });
      const body = await response.json();
      const rows = Array.isArray(body) ? body : (body?.list || []);
      const out = [];
      for (const row of rows) {
        const path = String(row?.path || '').trim()
          || (row?.name && row?.owner ? `${row.owner}/${row.name}` : '')
          || String(row?.name || '');
        const repo = parseRepo(path);
        if (repo && !out.includes(repo)) out.push(repo);
      }
      return out;
    } catch {
      return null;
    }
  }

  /**
   * 列出令牌属于或加入的组织。
   *
   * 合并三处来源，因为单看任何一个都会漏：`/user/repos` 只覆盖有仓库的、
   * `/user` 只有个人空间、`/user/groups` 有时缺个人空间。
   * @param {string} token - 令牌。
   * @returns {Promise<string[]>} 组织名（可能为空）。
   */
  async function listOrgs(token) {
    const orgs = new Set();
    const repos = await listRepos(token);
    for (const repo of repos || []) {
      const org = repo.split('/')[0];
      if (org) orgs.add(org);
    }
    // 用户名只在它自己名下有仓库时才当作一个命名空间列出。
    // 无条件把 /user 的 username 塞进来，会让一个没有任何仓库、也查不到额度的
    // 「个人空间」混在组织列表里，用户看到只会困惑。
    try {
      const response = await request(token, '/user', { timeout: 12000 });
      const me = await response.json();
      const username = String(me?.username || '').trim();
      const ownsRepos = username !== '' && (repos || []).some((repo) => repo.startsWith(`${username}/`));
      if (ownsRepos) orgs.add(username);
    } catch { /* 没有 /user 权限也不致命 */ }
    try {
      const response = await request(token, '/user/groups?page=1&page_size=50', { timeout: 12000 });
      const body = await response.json();
      for (const row of (Array.isArray(body) ? body : (body?.list || []))) {
        const name = row?.path || row?.name;
        if (name) orgs.add(String(name));
      }
    } catch { /* 忽略 */ }
    return [...orgs];
  }

  /**
   * 某个组织下看起来在跑 cnb2api 的仓库。
   *
   * 判断依据是「该仓库有工作区」——不看仓库名。名字不必叫 cnb2api 也能跑网关，
   * 反过来叫 cnb2api 的仓库未必在跑。有工作区的一律列出，并标出是否在运行，
   * 由用户确认哪一个，不替他猜。
   * @param {string} token - 令牌。
   * @param {string} org - 组织名。
   * @returns {Promise<Array<{repo: string, running: boolean}>>} 候选仓库。
   */
  async function listOrgRepos(token, org) {
    const wanted = String(org || '').trim();
    if (!wanted) return [];
    let rows = [];
    try {
      rows = await listWorkspaces(token, '');
    } catch {
      rows = [];
    }
    const byRepo = new Map();
    for (const row of rows) {
      const repo = repoOfRecord(row);
      if (!repo || repo.split('/')[0] !== wanted) continue;
      const running = row.status === 'running';
      const current = byRepo.get(repo);
      // 同一仓库多条记录时，running 优先，其次最新的那条
      if (!current || (running && !current.running)) byRepo.set(repo, { repo, running });
    }
    const out = [...byRepo.values()].sort((a, b) => Number(b.running) - Number(a.running));
    // 组织里还有哪些仓库（哪怕没工作区）也要能看到：新建的仓库可能还没跑过
    const known = await listRepos(token);
    for (const repo of known || []) {
      if (repo.split('/')[0] !== wanted) continue;
      if (out.some((row) => row.repo === repo)) continue;
      out.push({ repo, running: false });
    }
    return out;
  }

  /**
   * 读取令牌身份。
   * @param {string} token - 令牌。
   * @returns {Promise<{id: string, username: string}|null>} 身份，失败返回 null。
   */
  async function whoAmI(token) {
    try {
      const response = await request(token, '/user', { timeout: 12000 });
      const body = await response.json();
      return { id: body?.id ? String(body.id) : '', username: body?.username || '' };
    } catch {
      return null;
    }
  }

  return {
    request,
    describe,
    listWorkspaces,
    repoOfRecord,
    pickWorkspace,
    repoExists,
    urlFromDetail,
    urlFromLog,
    resolveUrl,
    healthy,
    startWorkspace,
    readQuota,
    whoAmI,
    listRepos,
    listOrgs,
    listOrgRepos,
  };
}
