// cnb2api · 一个账号的监视器
//
// 每个账号一个实例，负责三件事，别的一概不管：
//   1. 周期性查明工作区的三项事实：在不在跑、地址是多少、额度还剩多少；
//   2. 停掉了就拉起来（先查额度，用尽则不拉）；
//   3. 对外提供一份只读快照，界面与工具都读它。
//
// 与上一版最大的区别：快照里是**原始事实**（lifecycle / reachable / creditExhausted /
// broken / starting），不是拼好的字符串。结论由 lib/state.mjs 从事实推出，
// 所以界面、工具、日志三处说同一件事，不会各算一套。

import { maskHost, hostOf } from './address.mjs';
import { isExhausted, remainPercentOf, settleQuota } from './quota.mjs';
import { LIFECYCLE, lifecycleOf } from './state.mjs';

/** 巡检最小间隔：再密也不会有新信息，只会给 CNB 接口压力。 */
const MIN_INTERVAL_SECONDS = 30;

/** 启动提交后的冷却：工作区从提交到 running 要几十秒，不设冷却会打成连发。 */
export const START_COOLDOWN_MS = 60_000;

/** 同一份额度结论的复用期，避免一次巡检里重复打三个接口。 */
const QUOTA_TTL_MS = 60_000;

/** 就绪后多久重新探一次地址健康（避免每读一次界面就打一次网关）。 */
const HEALTH_TTL_MS = 15_000;

/**
 * 一个账号的监视器。
 *
 * 状态字段直接放在实例上（不做 Proxy、不用 AsyncLocalStorage）：一个实例只服务
 * 一个账号，调用方拿到实例就拿到了它的全部状态，没有"当前账号"这种隐式上下文。
 */
export class Monitor {
  /**
   * @param {object} account - 账号配置。
   * @param {string} account.token - CNB 访问令牌。
   * @param {string} account.repo - `org/repo`。
   * @param {string} [account.proxyKey] - 该仓库网关的 PROXY_KEY。
   * @param {string} [account.branch] - 启动用的分支。
   * @param {number} [account.port] - 网关端口。
   * @param {object} deps - 依赖。
   * @param {object} deps.cnb - lib/cnb.mjs 的客户端。
   * @param {object} deps.settings - 取当前设置的回调集合。
   * @param {(line: string) => void} [deps.log] - 日志。
   */
  constructor(account, deps) {
    this.token = String(account.token || '').trim();
    this.repo = String(account.repo || '').trim();
    this.proxyKey = String(account.proxyKey || '').trim();
    this.branch = String(account.branch || '').trim();
    this.port = Number(account.port) || 0;

    this.cnb = deps.cnb;
    this.settings = deps.settings || (() => ({}));
    this.log = deps.log || (() => {});

    /** 身份：令牌指纹 + 仓库，配置热更新时用它判断是不是同一个账号。 */
    this.identity = `${fingerprint(this.token)}@${this.repo}`;

    // ---- 事实与展示素材 ----
    this.resetFacts();

    // ---- 内部节流 ----
    this.lastStartAt = 0;
    this.lastStartBlockedReason = null;
    this.quotaCache = null;
    this.lastHealthAt = 0;
    this.timer = null;
    this.inFlight = null;
    this.startInFlight = null;
    this.quotaInFlight = null;
    this.warned = new Set();
  }

  /**
   * 把「查出来的结论」全部清空。
   *
   * 构造器和「换凭据」共用同一份清单 —— 之前换凭据只清了 url/quotaCache，
   * 留下了 creditExhausted、lifecycle 等旧账号的结论，切换瞬间界面会显示
   * 上一个账号的状态。
   * @returns {void}
   */
  resetFacts() {
    this.lifecycle = LIFECYCLE.absent;
    this.url = null;
    this.reachable = false;
    this.creditExhausted = false;
    this.broken = false;
    this.starting = false;
    this.noWorkspace = false;
    this.username = '';
    this.workspaceId = null;
    this.workspaceBranch = '';
    this.runningSince = 0;
    this.lastError = null;
    this.lastCheckedAt = 0;
    this.warned = new Set();
  }

  /** 界面上显示的账号名：`用户 | 组织/仓库`。 */
  get label() {
    return this.username ? `${this.username} | ${this.repo}` : this.repo || '未配置';
  }

  /** 巡检间隔（秒），受 30 秒下限保护。 */
  get intervalSeconds() {
    return Math.max(MIN_INTERVAL_SECONDS, Number(this.settings()?.checkSeconds) || 120);
  }

  /** 工作区停止后是否自动拉起。 */
  get autoStart() {
    return this.settings()?.autoStart !== false;
  }

  /** 网关端口：账号上没写就用全局设置。 */
  get gatewayPort() {
    return this.port || Number(this.settings()?.port) || 9001;
  }

  /** 启动用的分支：账号上没写就用全局设置。 */
  get startBranch() {
    return this.branch || String(this.settings()?.branch || '') || 'main';
  }

  /**
   * 只记一次同一类警告。
   *
   * **键和文案分开**：之前去重键就是整条消息，而保底线提示把实时百分比
   * 拼在消息里，每轮都不一样 → 去重形同虚设，每两分钟刷一行。
   * @param {string} key - 稳定标识（同一类问题始终相同）。
   * @param {string} [message] - 要打印的文案，默认同 key。
   */
  warnOnce(key, message) {
    const text = message === undefined ? key : message;
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.log(`[${this.label}] ${text}`);
  }

  /** 清掉去重记录，让下一次警告能再出现（状态恢复后调用）。 */
  clearWarnings() {
    this.warned.clear();
  }

  /**
   * 同步一轮：查明事实、必要时拉起工作区。并发调用合并成一次。
   * @param {string} [reason] - 触发原因，只用于日志。
   * @returns {Promise<void>}
   */
  async sync(reason = 'tick') {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.runSync(reason).finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  /**
   * 一轮巡检的实际内容。
   * @param {string} reason - 触发原因。
   * @returns {Promise<void>}
   */
  async runSync(reason) {
    this.lastCheckedAt = Date.now();
    if (!this.token) {
      this.broken = true;
      this.lastError = '尚未填写 CNB 访问令牌';
      return;
    }
    if (!this.repo.includes('/')) {
      this.broken = true;
      this.lastError = this.repo ? `仓库名不完整 · 需要 org/repo，当前是 ${this.repo}` : '尚未填写仓库';
      return;
    }

    try {
      const record = await this.cnb.pickWorkspace(this.token, this.repo);
      this.lifecycle = lifecycleOf(record);

      if (!record) {
        this.clearWorkspace();
        if (!(await this.cnb.repoExists(this.token, this.repo))) {
          this.broken = true;
          this.lastError = `仓库 ${this.repo} 不存在，或令牌无权访问`;
          return;
        }
        this.broken = false;
        // 先记下「本来就没有工作区」这个事实；启动成功会改写 lastError 成「已提交启动」，
        // 但界面上的 note 要能回答问题本身，所以在启动前把原因留在 noWorkspace 里。
        this.lastError = '该仓库还没有工作区';
        if (this.autoStart) {
          this.noWorkspace = true;
          await this.startIfAllowed('create');
        }
        return;
      }

      this.noWorkspace = false;
      this.workspaceId = record.sn || null;
      this.workspaceBranch = record.branch || this.startBranch;
      this.runningSince = parseTime(record.create_time);
      this.broken = false;

      // 刚提交启动、平台还在 building：等它就绪，**绝不再提交一次**。
      // 之前这里落进了「已停止」分支，60 秒冷却一过就重复建工作区。
      if (this.lifecycle === LIFECYCLE.pending) {
        this.starting = true;
        this.url = null;
        this.reachable = false;
        this.lastError = '已提交启动 · 等待工作区就绪';
        if (!this.settings()?.autoStart) await this.quota().catch(() => {});
        return;
      }

      if (this.lifecycle !== LIFECYCLE.running) {
        this.url = null;
        this.reachable = false;
        this.starting = false;
        this.lastError = '工作区已停止';
        if (this.autoStart) {
          // 没拉起来（额度用尽/缺权限）时，原因比「已停止」有用得多 ——
          // 用户看到「已停止」会以为点一下就能起来，实际是额度没了。
          const started = await this.startIfAllowed('restart');
          if (!started) this.lastError = this.lastStartBlockedReason || this.lastError;
        } else {
          // 关了自动启动不代表不用查额度：面板要能回答「为什么起不来」，
          // 「额度用尽」和「缺权限」是两种完全不同的处置。
          await this.quota().catch(() => {});
        }
        return;
      }

      // 在跑：取地址并确认可用
      this.starting = false;
      const url = await this.cnb.resolveUrl(this.token, this.repo, record.sn, this.gatewayPort);
      if (!url) {
        this.reachable = false;
        // 取不到地址有两种原因：日志还没打印 PROXY_URI，或日志接口本身 5xx/超时
        // （urlFromLog 对非权限错误回 null）。文案要把两种都说上，否则
        // 接口故障会被误看成「再等等就好」。
        this.lastError = '工作区在运行，但取不到网关地址 · 日志可能尚未输出，或日志接口暂时不可用';
        return;
      }
      const changed = url !== this.url;
      this.url = url;
      // 地址变了立刻采用，哪怕这会儿还没探通：新工作区起来时代理要几十秒才监听，
      // 因为「暂时不健康」丢掉新地址，会一直卡在已经失效的旧地址上。
      if (changed) this.lastHealthAt = 0;
      this.reachable = await this.probe();
      this.lastError = this.reachable ? null : '工作区在运行，但网关地址连不上';
      if (this.reachable) this.clearWarnings();
      // 在跑也要刷额度：额度耗尽的事实只在 quota() 里更新，而状态结论
      // （stateOf 的 noCredit）依赖它。不刷的话工作区一直跑着时界面会一直
      // 显示「就绪」，直到用户手动点开面板去查。按 TTL 低频刷新即可。
      if (!this.quotaCache || Date.now() - this.quotaCache.at >= QUOTA_TTL_MS) {
        await this.quota().catch(() => {});
      }
    } catch (error) {
      const message = this.cnb.describe(error);
      this.reachable = false;
      this.lastError = message;
      if (error?.permission || error?.status === 401) {
        this.broken = true;
        this.warnOnce(message);
      }
    }
  }

  /** 清掉与具体工作区有关的一切（仓库下一条记录都没有时用）。 */
  clearWorkspace() {
    this.workspaceId = null;
    this.workspaceBranch = '';
    this.runningSince = 0;
    this.url = null;
    this.reachable = false;
    this.starting = false;
  }

  /**
   * 探活，带短期缓存：界面可能频繁读，不必每次都打网关。
   * @param {boolean} [force] - 忽略缓存。
   * @returns {Promise<boolean>} 是否可达。
   */
  async probe(force = false) {
    if (!this.url) return false;
    if (!force && this.reachable && Date.now() - this.lastHealthAt < HEALTH_TTL_MS) return true;
    const ok = await this.cnb.healthy(this.url, 8000);
    this.lastHealthAt = Date.now();
    return ok;
  }

  /**
   * 查额度，带短期缓存。
   * @param {boolean} [force] - 忽略缓存。
   * @returns {Promise<object>} {@link settleQuota} 的结果。
   */
  async quota(force = false) {
    const org = this.repo.split('/')[0];
    if (!org || !this.token) return { failures: ['令牌或仓库尚未配置'] };
    const cached = this.quotaCache;
    if (!force && cached && cached.org === org && Date.now() - cached.at < QUOTA_TTL_MS) {
      return cached.ledger;
    }
    // 同一时刻只允许一次在途查询：一次 miss 会被多个入口同时触发
    // （面板读、工具读、启动闸门读），否则会各打三遍接口、互相覆盖结果。
    if (this.quotaInFlight) return this.quotaInFlight;
    // 记下发起时的账号身份：途中若 replaceCredentials 换了账号，
    // 旧请求回来不能把上一个账号的额度写进缓存（同组织下尤其隐蔽）。
    const generation = this.identity;
    const flight = (async () => {
      const raw = await this.cnb.readQuota(this.token, org, force ? 20000 : 8000);
      const ledger = settleQuota(raw, raw.failures);
      if (generation !== this.identity) return ledger;
      this.quotaCache = { org, at: Date.now(), ledger };
      // 额度归零会改变状态结论，这里顺手更新事实
      this.creditExhausted = isExhausted(ledger.credit);
      return ledger;
    })().finally(() => {
      // 只在「还是自己」时才清空：换号后新查询可能已把引用换成自己的 Promise，
      // 旧查询的 finally 不能把新查询一并清掉，否则单飞去重会短暂失效、多打接口。
      if (this.quotaInFlight === flight) this.quotaInFlight = null;
    });
    this.quotaInFlight = flight;
    return flight;
  }

  /**
   * 拉起工作区：先查额度，用尽则不启动。
   *
   * 「查不到就放行」是刻意的：缺 group-resource:r、接口偶尔抽风，都不能当成额度用尽。
   * 拦住一个本来能用的工作区，比放过一个注定被 402 拒绝的更糟。
   * @param {'create'|'restart'|'manual'} intent - 意图，只用于日志。
   * @param {boolean} [forceQuota] - 不信额度缓存。
   * @returns {Promise<boolean>} 是否已提交启动。
   */
  async startIfAllowed(intent, forceQuota = false) {
    this.lastStartBlockedReason = null;
    // 两道闸都要**同步**占位：冷却检查与 lastStartAt 写入之间隔着两个 await，
    // 并发进入（自动巡检 + 手动工具 + waitUntilReady）会双双看到旧值 → 双发启动。
    if (this.startInFlight) return this.startInFlight;
    if (Date.now() - this.lastStartAt < START_COOLDOWN_MS) return true;
    return this.beginStart(intent, forceQuota);
  }

  /**
   * 真正执行一次启动；由 {@link startIfAllowed} 串行化。
   * @param {string} intent - 触发原因。
   * @param {boolean} forceQuota - 是否强制刷新额度。
   * @returns {Promise<boolean>} 是否已提交启动。
   */
  async beginStart(intent, forceQuota) {
    this.startInFlight = (async () => {
    const ledger = await this.quota(forceQuota).catch(() => null);
    if (isExhausted(ledger?.credit)) {
      this.creditExhausted = true;
      this.lastStartBlockedReason = 'AI credits 已用尽 · 额度恢复后会自动启动';
      this.warnOnce('start-blocked:exhausted', this.lastStartBlockedReason);
      return false;
    }
    // 保底硬停：低于保底线就不再启动。启动本身要烧核时，
    // 而起起来也没多少额度可用 —— 不如把余量留着。
    const floor = Number(this.settings().creditFloorPercent) || 0;
    const ratioPct = remainPercentOf(ledger?.credit);
    if (floor > 0 && ratioPct !== null) {
      if (ratioPct < floor) {
        this.lastStartBlockedReason =
          `余额低于保底线 ${floor}% · 停止使用这个账号（可用 ${ratioPct.toFixed(2)}%）`;
        this.warnOnce('start-blocked:floor', this.lastStartBlockedReason);
        return false;
      }
    }

    try {
      this.log(`[${this.label}] ${intent === 'create' ? '正在创建工作区' : '工作区已停止 · 正在启动'}`);
      await this.cnb.startWorkspace(this.token, this.repo, this.startBranch);
      this.lastStartAt = Date.now();
      this.starting = true;
      this.lastError = '已提交启动 · 网关通常 30–90 秒内就绪';
      return true;
    } catch (error) {
      if (error?.permission) {
        this.lastError = '无法自动启动 · 令牌缺少启动权限';
        this.warnOnce('start-failed:permission', `${this.lastError} · 地址仍会跟随 · 需要 repo-cnb-trigger:rw`);
      } else {
        this.lastError = `启动失败 · ${this.cnb.describe(error)}`;
        // 每轮 tick 都打一行同样的话没有意义，与其他警告一样去重
        this.warnOnce('start-failed', this.lastError);
      }
      return false;
    }
    })().finally(() => { this.startInFlight = null; });
    return this.startInFlight;
  }

  /**
   * 等到就绪：退避轮询，直到拿到可用地址或预算耗尽。
   * @param {number} budgetMs - 预算。
   * @param {AbortSignal} [signal] - 取消信号。
   * @returns {Promise<boolean>} 是否就绪。
   */
  async waitUntilReady(budgetMs, signal) {
    const deadline = Date.now() + budgetMs;
    let gap = 700;
    while (Date.now() < deadline) {
      if (signal?.aborted) return false;
      await this.sync('wait');
      if (this.url && this.reachable) return true;
      if (this.broken) return false;
      if (this.lastStartBlockedReason) return false;
      const left = deadline - Date.now();
      if (left <= 0) break;
      // 可取消的退避：signal 一 abort 就立刻返回，且定时器一定被清掉
      const aborted = await new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          // 正常返回时也要摘掉监听，否则每等一轮就挂一个 listener，
          // 长预算下会堆到 MaxListenersExceededWarning。
          signal?.removeEventListener('abort', onAbort);
          resolve(value);
        };
        const timer = setTimeout(() => finish(false), Math.min(gap, left));
        const onAbort = () => finish(true);
        if (signal) {
          if (signal.aborted) { finish(true); return; }
          signal.addEventListener('abort', onAbort, { once: true });
        }
      });
      if (aborted) return false;
      gap = Math.min(5000, Math.round(gap * 1.7));
    }
    return false;
  }

  /** 启动周期巡检。首次启动时立刻跑一轮，不等第一个周期。 */
  start() {
    if (this.timer) return this.inFlight || undefined;
    const tick = () => {
      this.sync('interval').catch(() => {});
    };
    this.timer = setInterval(tick, this.intervalSeconds * 1000);
    this.timer.unref?.();
    return this.sync('initial');
  }

  /** 停掉周期巡检。 */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 快照：只读、纯数据，界面与工具都读它。
   * @returns {object} 快照。
   */
  snapshot() {
    return {
      label: this.label,
      repo: this.repo,
      lifecycle: this.lifecycle,
      url: this.url,
      host: this.url ? maskHost(hostOf(this.url)) : null,
      reachable: this.reachable,
      creditExhausted: this.creditExhausted,
      broken: this.broken,
      noWorkspace: this.noWorkspace,
      starting: this.starting,
      workspaceId: this.workspaceId,
      branch: this.workspaceBranch || null,
      runningSince: this.runningSince || null,
      lastError: this.lastError,
      lastCheckedAt: this.lastCheckedAt || null,
    };
  }

  /**
   * 换凭据后作废旧结论。
   * @param {object} account - 新配置。
   */
  replaceCredentials(account) {
    this.token = String(account.token || '').trim();
    this.repo = String(account.repo || '').trim();
    this.identity = `${fingerprint(this.token)}@${this.repo}`;
    this.proxyKey = String(account.proxyKey || '').trim();
    this.branch = String(account.branch || '').trim();
    this.port = Number(account.port) || 0;
    // 换凭据 = 换了一个账号：所有「查出来的结论」都要作废。
    // 之前只清了 url/quotaCache，creditExhausted、lifecycle 仍是旧账号的，
    // 切换瞬间界面会显示上一个账号的状态。
    this.resetFacts();
    this.quotaCache = null;
    // 作废在途查询：新账号的 sync 不该复用旧账号的 Promise
    this.quotaInFlight = null;
    this.lastStartAt = 0;
    this.lastStartBlockedReason = null;
  }
}

/**
 * 令牌指纹。不直接存令牌，避免它出现在日志、键名或调试输出里。
 * @param {string} token - 令牌。
 * @returns {string} 稳定短标识。
 */
export function fingerprint(token) {
  const value = String(token || '').trim();
  if (!value) return 'anonymous';
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code, 0x85ebca6b) >>> 0;
  }
  return `k${a.toString(36)}${b.toString(36)}`;
}

/**
 * 解析平台时间，取不到返回 0。
 * @param {unknown} value - 时间字段。
 * @returns {number} 毫秒时间戳。
 */
function parseTime(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
