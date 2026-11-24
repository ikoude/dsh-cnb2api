// dsh-cnb2api — 在 DSH 里使用自己 CNB 工作区的 cnb2api 网关。
//
// 解决的问题只有一个：**工作区地址会变，而且工作区会被停掉**。
// 平台每次重启工作区都换一个随机子域，停掉后不再响应；插件在后台盯住这两件事。
//
// 落点（都在插件详情页与工具里，不占对话区）：
//   · 工具      cnb2api_status / cnb2api_start / cnb2api_quota
//   · 路由      GET  /cnb2api/status      界面读的只读快照
//               POST /cnb2api/start       界面上的「启动」按钮
//   · 网关      独立端口（默认 41729）的 OpenAI 兼容端点，地址永不改变；
//               同时把基址/密钥/模型写进「设置 → 模型」的官方供应商
//   · 界面      plugins.bundle.config     插件详情页里的配置表单
//               plugins.detail.section    同一页里的状态区块
//               shell.overlay             可拖动的悬浮球
//
// 结构上刻意分成四层，各管一段，互不越界：
//   lib/address.mjs  字符串变换（地址、打码、仓库）
//   lib/quota.mjs    额度账目（三个接口 → 一笔账）
//   lib/state.mjs    事实 → 状态码/徽标
//   lib/monitor.mjs  一个账号的巡检与启动
//   lib/gateway.mjs  固定端口网关：鉴权、流式转发、故障转移
//   lib/publish.mjs  把网关写进官方供应商配置
//   lib/index.mjs    本文件：把上面几层接到 DSH 上

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { API_BASE, createClient } from './cnb.mjs';
import { randomBytes } from 'node:crypto';
import { Monitor, fingerprint } from './monitor.mjs';
import { actionOf, badgeOf, detailParts, stateOf } from './state.mjs';
import { consumption, describeBonus, formatAmount, noticeVars, remainPercentOf, renderNotice, settleQuota } from './quota.mjs';
import { parseRepo } from './address.mjs';
import { TEXT } from './text.mjs';
import { createGateway, DEFAULT_HOST, DEFAULT_PORT, isLoopbackHost } from './gateway.mjs';
import { canServe, creditStateOf, modelsOf, pickBest } from './models.mjs';
import { publish, routeProfile, ROUTE_ID as PUBLISHED_ROUTE } from './publish.mjs';
import { buildBackup, mergeAccounts, parseBackup, SCOPE } from './backup.mjs';
import { davGet, davPut } from './webdav.mjs';

export const name = 'cnb2api';
// 不再 inject 'llm'：插件不实现协议层了，只发布一条官方供应商配置。
export const inject = ['tools', 'webServer'];

const TAG = '[cnb2api]';
/** 余额警戒线的缺省值：可用低于 5% 时提示。 */
const LOW_CREDIT_DEFAULT = 5;
/** 余额保底线的缺省值：可用低于 1% 时停止使用该账号。 */
const CREDIT_FLOOR_DEFAULT = 1;
const BASE = '/cnb2api';

const log = (line) => {
  console.error(`${TAG} ${line}`);
};

/**
 * 插件配置。
 *
 * `accounts` 与全局项都标了 `.volatile()`：设置页只接受 volatile 字段的写入
 * （非 volatile 字段写入会让宿主重启整条 entry，settings 层直接拒绝）。
 * 代价是 volatile 写入不重启 entry，所以这里靠 {@link reconcile} 盯住配置变化。
 */
export const Config = z.object({
  accounts: z.array(z.object({
    token: z.string().required().description('CNB 访问令牌 · CNB 头像 → 访问令牌'),
    repo: z.string().required().description('组织/仓库，例如 acme/gateway'),
    proxyKey: z.string().description('该仓库 .cnb.yml 中 env 的 PROXY_KEY，网关转发时作为上游密钥'),
    branch: z.string().description('启动用的分支，留空取全局值'),
    port: z.natural().description('网关端口，留空取全局值'),
  })).default([]).volatile(),
  apiBase: z.string().default(API_BASE).volatile(),
  branch: z.string().default('main').volatile(),
  port: z.natural().default(9001).volatile(),
  checkSeconds: z.natural().min(30).default(120).volatile(),
  autoStart: z.boolean().default(true).volatile(),
  locale: z.string().default('auto').volatile(),
  // 供应商暴露给「设置 → 模型」的模型清单，逗号分隔
  models: z.string().default('deepseek-v4.1-flash').volatile(),
  // 网关：插件对外提供固定不变的本机/局域网地址
  gatewayHost: z.string().default(DEFAULT_HOST).volatile()
    .description('监听地址 · 0.0.0.0 局域网可用，127.0.0.1 仅本机'),
  gatewayPort: z.natural().default(DEFAULT_PORT).volatile()
    .description('监听端口 · 被占用会顺延'),
  gatewayKey: z.string().default('').volatile()
    .description('访问密钥 · 客户端用它调用网关，监听局域网时必填'),
  autoPublish: z.boolean().default(true).volatile()
    .description('自动写入「设置 → 模型」的供应商，省得手动填'),
  // 余额警戒线：可用额度低于这个百分比时提前提示
  lowCreditPercent: z.natural().max(100).default(5).volatile()
    .description('余额警戒线（%）· 可用低于此值时在对话里提前提示'),
  // 保底线：低于它**完全不用**这个账号（硬停，区别于只提示的警戒线）
  creditFloorPercent: z.natural().max(100).default(1).volatile()
    .description('余额保底线（%）· 可用低于此值时停止使用该账号，防止任务中途超用'),
  // WebDAV 备份目标：地址、账号、密码、文件名
  webdavUrl: z.string().default('').volatile()
    .description('WebDAV 地址 · 目录或完整文件路径'),
  webdavUser: z.string().default('').volatile()
    .description('WebDAV 用户名 · 留空表示匿名'),
  webdavPassword: z.string().default('').volatile()
    .description('WebDAV 密码 · 保存在本机 profile，不随备份导出'),
  autoBackup: z.boolean().default(false).volatile()
    .description('保存配置后自动上传备份到 WebDAV · 还原仍需手动'),
  // 自定义提醒文案；空串表示用界面内置的默认句子
  lowCreditMessage: z.string().default('').volatile()
    .description('余额不足提示文案 · 可用变量 {account} {percent} {used} {frozen} {consumed} {remain} {total} {threshold} {unit}'),
});

/**
 * 拆开 volatile 视图，拿到普通值。
 * @param {unknown} value - 可能是 volatile 视图。
 * @returns {unknown} 普通值。
 */
function unwrap(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value;
}

/**
 * 读当前设置。
 * @param {object} config - 行的配置。
 * @returns {object} 普通值设置。
 */
function readSettings(config) {
  return {
    apiBase: String(unwrap(config?.apiBase) ?? API_BASE),
    branch: String(unwrap(config?.branch) ?? '') || 'main',
    port: Number(unwrap(config?.port)) || 9001,
    checkSeconds: Number(unwrap(config?.checkSeconds)) || 120,
    autoStart: unwrap(config?.autoStart) !== false,
    locale: String(unwrap(config?.locale) ?? 'auto'),
    models: String(unwrap(config?.models) ?? ''),
    gatewayHost: String(unwrap(config?.gatewayHost) ?? '') || DEFAULT_HOST,
    // 0 是合法值（让内核分配端口），不能用 || 吞掉
    gatewayPort: Number.isFinite(Number(unwrap(config?.gatewayPort)))
      ? Number(unwrap(config?.gatewayPort))
      : DEFAULT_PORT,
    gatewayKey: String(unwrap(config?.gatewayKey) ?? ''),
    autoPublish: unwrap(config?.autoPublish) !== false,
    lowCreditPercent: Number(unwrap(config?.lowCreditPercent)) || LOW_CREDIT_DEFAULT,
    lowCreditMessage: String(unwrap(config?.lowCreditMessage) ?? ''),
    webdavUrl: String(unwrap(config?.webdavUrl) ?? ''),
    webdavUser: String(unwrap(config?.webdavUser) ?? ''),
    webdavPassword: String(unwrap(config?.webdavPassword) ?? ''),
    autoBackup: unwrap(config?.autoBackup) === true,
    creditFloorPercent: Number.isFinite(Number(unwrap(config?.creditFloorPercent)))
      ? Math.min(100, Math.max(0, Number(unwrap(config?.creditFloorPercent))))
      : CREDIT_FLOOR_DEFAULT,
  };
}

/**
 * 读当前账号列表，顺带归一仓库写法。
 * @param {object} config - 行的配置。
 * @returns {object[]} 账号（token/repo/proxyKey/branch/port）。
 */
function readAccounts(config) {
  const list = unwrap(config?.accounts);
  if (!Array.isArray(list)) return [];
  return list
    .filter((row) => row && typeof row === 'object')
    .map((row) => ({
      token: String(row.token || '').trim(),
      repo: parseRepo(row.repo),
      proxyKey: String(row.proxyKey || '').trim(),
      branch: String(row.branch || '').trim(),
      port: Number(row.port) || 0,
    }));
}

/**
 * 挂载插件。
 * @param {object} ctx - cordis 上下文。
 * @param {object} config - 行的配置。
 */
export function apply(ctx, config) {
  const settings = () => readSettings(config);

  /** 首次运行生成的访问密钥（见 accessKey）。 */
  const generatedKey = `sk-cnb-${randomBytes(18).toString('base64url')}`;
  /**
   * 取一个可选服务。老版本 Host 的 ctx 可能没有 get()，缺服务时应当降级，
   * 而不是在后台抛一个没人接的 TypeError。
   * @param {string} name - 服务名。
   * @returns {object|undefined} 服务实例。
   */
  const service = (name) => (typeof ctx.get === 'function' ? ctx.get(name) : undefined);
  const cnb = createClient({ baseUrl: settings().apiBase });

  /** 正在监视的账号：identity → Monitor。 */
  const monitors = new Map();

  /**
   * 按当前配置对齐监视器：新增的上岗、移除的下岗、换凭据的重置。
   */
  function reconcile() {
    const wanted = new Map();
    for (const account of readAccounts(config)) {
      const monitor = new Monitor(account, {
        cnb,
        settings,
        log: (line) => log(line),
      });
      wanted.set(monitor.identity, monitor);
    }

    for (const [identity, monitor] of monitors) {
      if (wanted.has(identity)) continue;
      monitor.stop();
      monitors.delete(identity);
      log(`已停止监视 · ${monitor.label}`);
    }

    for (const [identity, next] of wanted) {
      const current = monitors.get(identity);
      if (!current) {
        monitors.set(identity, next);
        ctx.effect(() => {
          next.start().catch(() => {});
          return () => next.stop();
        }, `cnb2api monitor ${identity}`);
        log(`开始监视 · ${next.label || next.repo}`);
        continue;
      }
      // 身份相同但凭据可能变了：PROXY_KEY 不影响 CNB 侧，其余变了就作废旧结论
      if (current.token !== next.token || current.repo !== next.repo
        || current.branch !== next.branch || current.port !== next.port) {
        current.replaceCredentials(next);
        current.sync('credentials').catch(() => {});
      }
      current.proxyKey = next.proxyKey;
    }
  }

  reconcile();

  // volatile 写入不重启 entry，所以自己盯配置。比对指纹而不是深比较：只比字符串。
  let lastSignature = JSON.stringify({ accounts: readAccounts(config), ...settings() });
  let lastTarget = '';
  const watcher = setInterval(() => {
    const signature = JSON.stringify({ accounts: readAccounts(config), ...settings() });
    if (signature === lastSignature) return;
    lastSignature = signature;
    try {
      reconcile();
    } catch (error) {
      log(`配置更新失败 · ${error.message}`);
    }
    // 监听地址变了要重新绑定，端口顺延也会变
    const target = `${settings().gatewayHost}:${settings().gatewayPort}`;
    if (lastTarget !== '' && target !== lastTarget) {
      lastTarget = target;
      gateway.restart()
        .then(() => {
          // 端口变了 → 基址变了 → 已发布的那条要重写。把签名清掉，
          // 下一次状态请求的 ensurePublished 会重新发布。
          // （不在这里直接写：apply 创建的定时器继承了 HMR 事务上下文，
          //   写配置会被拒；由请求处理发起的写入才是干净的。）
          publishedSignature = '';
          log('网关已按新地址重启 · 下次页面刷新时重新接入「设置 → 模型」');
        })
        .catch((error) => { published = { state: 'failed', reason: String(error?.message || error) }; });
      return;
    }
    lastTarget = target;
  }, 1000);
  watcher.unref?.();
  ctx.effect(() => () => clearInterval(watcher), 'cnb2api config watcher');

  if (monitors.size === 0) {
    log('尚未配置账号 · 在「设置 → 插件 → CNB2API」详情页填写令牌与仓库');
  }

  /**
   * 把监视器快照算成界面/工具要的形状。
   * @param {Monitor} monitor - 监视器。
   * @returns {object} 展示用状态。
   */
  function describe(monitor) {
    const snap = monitor.snapshot();
    const state = stateOf({
      lifecycle: snap.lifecycle,
      reachable: snap.reachable,
      creditExhausted: snap.creditExhausted,
      broken: snap.broken,
      starting: snap.starting,
    });
    return {
      ...snap,
      state,
      badge: badgeOf(state),
      action: actionOf({
        lifecycle: snap.lifecycle,
        broken: snap.broken,
        starting: snap.starting,
      }),
      detail: detailParts({
        url: snap.url,
        branch: snap.branch,
        workspaceId: snap.workspaceId,
        runningSince: snap.runningSince,
      }),
    };
  }

  /** 挑选账号：支持 `org/repo`、显示名，或省略表示全部。 */
  function pick(wanted) {
    const list = [...monitors.values()];
    const target = String(wanted || '').trim();
    if (!target) return list;
    return list.filter((monitor) => monitor.repo === target || monitor.label === target);
  }

  // ---------- 工具 ----------

  ctx.tools.register(defineTool({
    name: 'cnb2api_status',
    description: '查看 cnb2api 工作区状态：在不在运行、网关地址是否可达、所属仓库与工作区编号。',
    parameters: {
      account: { type: 'string', description: '只看某个账号，填 org/repo 或账号名；省略则看全部。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                state: { type: 'string', required: true },
                repo: { type: 'string' },
                host: { type: 'string' },
                workspaceId: { type: 'string' },
                branch: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.accounts.length === 0
          ? '尚未配置 CNB 账号'
          : value.accounts.map((row) => `${row.label} · ${row.state}${row.note ? ` · ${row.note}` : ''}`).join('\n'),
      }],
    },
    async execute(args) {
      const rows = [];
      for (const monitor of pick(args.account)) {
        // 首次查询可能还没跑过一轮：给一次机会，别只回「未知」
        if (monitor.lastCheckedAt === 0) await monitor.sync('tool').catch(() => {});
        const view = describe(monitor);
        // 工具输出跟随插件语言设置：auto/未知仍用中文，显式 en 才切英文。
        // 这样 locale 设置不只影响界面，也影响 agent 读到的状态词。
        const t = String(settings().locale).toLowerCase() === 'en' ? TEXT.en : TEXT.zh;
        rows.push({
          label: view.label,
          state: t.state[view.state] || view.state,
          ...(view.repo ? { repo: view.repo } : {}),
          ...(view.host ? { host: view.host } : {}),
          ...(view.workspaceId ? { workspaceId: String(view.workspaceId) } : {}),
          ...(view.branch ? { branch: view.branch } : {}),
          ...(view.lastError ? { note: view.lastError } : {}),
        });
      }
      return { accounts: rows };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cnb2api_start',
    description:
      '启动 cnb2api 工作区。工作区已停止时使用；从提交到网关可用约 30–90 秒。'
      + '组织 AI credits 已用尽时会拒绝并说明原因，额度恢复后巡检会自动启动。',
    parameters: {
      account: { type: 'string', description: '只启动某个账号，填 org/repo 或账号名；省略则启动全部。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          results: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                ready: { type: 'boolean', required: true },
                message: { type: 'string', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.results.length === 0
          ? '尚未配置 CNB 账号'
          : value.results.map((row) => `${row.label} · ${row.message}`).join('\n'),
      }],
    },
    async execute(args, exec) {
      const results = [];
      for (const monitor of pick(args.account)) {
        const view = describe(monitor);
        if (view.state === 'ready') {
          results.push({ label: view.label, ready: true, message: `已就绪 · ${view.host || ''}`.trim() });
          continue;
        }
        // 显式启动不信任旧结论：额度现查一次
        const started = await monitor.startIfAllowed('manual', true);
        if (!started) {
          results.push({
            label: view.label,
            ready: false,
            message: monitor.lastError || '启动失败',
          });
          continue;
        }
        const ready = await monitor.waitUntilReady(90_000, exec?.signal);
        results.push({
          label: view.label,
          ready,
          message: ready
            ? `已就绪 · ${monitor.snapshot().host || ''}`.trim()
            : `已提交启动 · ${monitor.lastError || '等待网关就绪'}`,
        });
      }
      return { results };
    },
  }));

  ctx.tools.register(defineTool({
    name: 'cnb2api_quota',
    description: '查询账号所属组织的 AI credits 与核时（core-hours）余量。额度按组织计算，同组织的多个仓库共用一份。',
    parameters: {
      account: { type: 'string', description: '只查某个账号，填 org/repo 或账号名；省略则查全部。' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                label: { type: 'string', required: true },
                org: { type: 'string' },
                credits: { type: 'string' },
                coreHours: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.accounts.length === 0
          ? '尚未配置 CNB 账号'
          : value.accounts.map((row) => `${row.label} · ${row.note || [row.credits, row.coreHours].filter(Boolean).join(' · ')}`).join('\n'),
      }],
    },
    async execute(args) {
      const rows = [];
      for (const monitor of pick(args.account)) {
        const org = monitor.repo.split('/')[0];
        // 用户明确要数字时不读缓存：给一个一分钟前的旧值比报错更糟
        const ledger = await monitor.quota(true).catch((error) => ({ failures: [String(error?.message || error)] }));
        const credits = ledger.credit
          ? `AI credits 可用 ${formatAmount(ledger.credit.remain)} / ${formatAmount(ledger.credit.total)} cr`
          : null;
        const coreHours = ledger.coreHours
          ? `核时 可用 ${formatAmount(ledger.coreHours.remain)} / ${formatAmount(ledger.coreHours.total)} h`
          : null;
        rows.push({
          label: monitor.label,
          ...(org ? { org } : {}),
          ...(credits ? { credits } : {}),
          ...(coreHours ? { coreHours } : {}),
          ...(credits || coreHours
            ? {}
            : { note: `查不到额度 · ${ledger.failures?.[0] || '令牌可能缺少 group-resource:r'}` }),
        });
      }
      return { accounts: rows };
    },
  }));

  // ---------- 供应商（设置 → 模型） ----------
  //
  // 接进 ctx.llm 之后，CNB2API 就和内置供应商一样出现在「设置 → 模型」里：
  // 用户选它、选模型、开聊。地址每次请求现取，所以重启工作区不需要改配置。
  //
  // 没配账号时也注册：选择器里有个明确的入口，比"这个供应商凭空消失"好，
  // 真选它时会收到可读的「还没配置账号」。

  /**
   * 当前该用哪个账号。
   *
   * 低于保底线的账号**不返回**：网关拿不到可用账号时会明确拒绝，
   * 而不是把钱花在一个只剩零点几个百分点的账号上。
   * @returns {object|null} 监视器，或 null 表示没有可用账号。
   */
  const pickMonitor = () => {
    const floor = settings().creditFloorPercent;
    const best = pickBest([...monitors.values()], { floorPercent: floor });
    return best && canServe(best, floor) ? best : null;
  };

  /**
   * 首选之外、还能一试的备份账号。
   *
   * 用在一个账号刚被上游以 402 拒绝时：换一个还有额度的账号重试，
   * 比把 402 直接抛给用户有用得多 —— 这正是多账号的价值。
   * @param {object} exclude - 已经失败的监视器。
   * @returns {object[]} 按可用性排好序的其余账号。
   */
  const fallbacks = (exclude) => {
    const floor = settings().creditFloorPercent;
    return [...monitors.values()]
      .filter((monitor) => monitor !== exclude)
      // canServe 同时管了「可达」与「高于保底线」
      .filter((monitor) => canServe(monitor, floor));
  };

  // ---------- 网关 ----------
  //
  // 插件不再实现 LLM 协议层：那部分交给 DSH 官方的 pi-ai 供应商实现，
  // 这里只提供一个**地址永不改变**的 OpenAI 兼容端点，把会变的
  // 工作区地址、账号切换、额度换人都藏在后面。

  /**
   * 当前访问密钥：配置里有就用配置的，没有就用本次生成的。
   * 首次运行时生成并写回配置，重启不变；监听 0.0.0.0 时没有密钥
   * 等于把额度开放给整个局域网，所以必须有。
   * @returns {string} 密钥。
   */
  const accessKey = () => String(settings().gatewayKey || '').trim() || generatedKey;

  /**
   * 把生成的密钥写回配置，让它跨重启稳定。
   * @param {string} key - 密钥。
   * @returns {Promise<boolean>} 是否写成功。
   */
  async function persistKey(key) {
    const entry = ctx.fiber?.entry;
    const editor = service('configEditor');
    if (!entry || !editor || typeof editor.edit !== 'function') return false;
    await editor.edit(entry, (current) => ({ ...current, gatewayKey: key }));
    return true;
  }

  const gateway = createGateway({
    pickMonitor,
    fallbacks,
    getKey: accessKey,
    getHost: () => settings().gatewayHost,
    getPort: () => settings().gatewayPort,
    // 余额口径全部跟着设置走，免得插件里还有第二份「5%」被写死
    threshold: () => settings().lowCreditPercent,
    noticeTemplate: () => settings().lowCreditMessage,
    unavailableReason: () => {
      if (monitors.size === 0) return '尚未配置 CNB 账号 · 在插件设置里添加一个';
      const floor = settings().creditFloorPercent;
      if (floor > 0) {
        return `所有账号余额均低于保底线 ${floor}% · 已停止使用以避免超用`
          + '（可在插件设置里调低保底线或补充额度）';
      }
      return '没有可用账号 · 检查工作区是否在运行、令牌权限是否足够';
    },
    log,
  });

  /** 发布状态：界面要显示「已接入 / 需手动填 / 失败原因」。 */
  let published = { state: 'pending' };
  let publishedSignature = '';


  /**
   * 把当前网关发布成官方供应商。
   *
   * 只在「基址 / 密钥 / 模型清单」真的变了才写：每次巡检都写一遍会把
   * pi-ai 那条配置反复重载，正在进行的对话会被打断。
   * @returns {Promise<void>} 完成。
   */
  async function syncPublished() {
    const current = settings();
    if (!current.autoPublish) {
      // 关掉开关就把写进去的那条路由撤掉，别留一条指向已停网关的配置
      if (published.state === 'published') {
        await publish({
          settingsController: service('settingsController'),
          credentials: service('credentials'),
          profile: null,
        });
        publishedSignature = '';
        log('已移除「设置 → 模型」里的自动接入');
      }
      if (published.state !== 'off') published = { state: 'off' };
      return;
    }
    if (!gateway.status().listening) return;
    const baseURL = gateway.baseUrl('127.0.0.1');
    const models = modelsOf(current);
    const signature = JSON.stringify({ baseURL, models, key: accessKey() });
    if (signature === publishedSignature) return;
    // 写配置会开一个 HMR 事务。插件自己正在被 HMR 重载时（disable/enable、
    // 升级），那个事务还没结束，nested 写入会被拒绝 —— 等一会儿再试。
    const result = await publish({
      settingsController: service('settingsController'),
      credentials: service('credentials'),
      profile: routeProfile({ baseURL, models }),
      key: accessKey(),
    });
    if (result.state === 'failed' && /HMR transactions/i.test(result.reason || '')) {
      throw new Error(result.reason);
    }
    published = result;
    if (result.state === 'published') {
      publishedSignature = signature;
      log(`已接入「设置 → 模型」· ${PUBLISHED_ROUTE} · ${baseURL}`);
    } else if (result.state === 'failed' || result.state === 'unsupported') {
      log(`自动接入未完成 · ${result.reason}`);
    }
  }

  /**
   * 发布检查：把网关登记成一官方供应商。
   *
   * 由此刻的调用者发起 —— 状态接口的请求处理、或用户点保存。
   * **不能在 apply() 里发起**：写配置在 DSH 内部是 `hmr.runExclusive(...)`，
   * HMR 用 AsyncLocalStorage 标记「正在重载」的上下文，标记会沿整条异步链
   * 传播（实测连 apply 里创建的 setTimeout 回调都带着它），所以「延后一点」
   * 并不成立。而 HTTP 请求由网关服务在自己的上下文里发起，是干净的。
   * @returns {Promise<void>} 完成。
   */
  let publishing = false;
  async function ensurePublished() {
    if (publishing || !gateway.status().listening) return;
    publishing = true;
    try {
      if (!String(settings().gatewayKey || '').trim()) {
        await persistKey(generatedKey);
      }
      await syncPublished();
    } catch (error) {
      log(`自动接入失败 · ${error?.message || error}`);
    } finally {
      publishing = false;
    }
  }

  ctx.effect(() => {
    let stop = false;
    (async () => {
      try {
        await gateway.start();
      } catch (error) {
        log(`网关启动失败 · ${error?.message || error}`);
        published = { state: 'failed', reason: String(error?.message || error) };
        return;
      }
      if (stop) return;
      const where = gateway.status();
      log(`网关地址固定为 http://127.0.0.1:${where.port}/v1 · 监听 ${where.host}`);
      // 写配置留到第一次状态查询：apply() 处在 HMR 事务里，任何从它发起的
      // 异步链都带着「正在重载」的标记，写配置会被拒。
    })();
    return () => {
      stop = true;
      gateway.stop().catch(() => {});
    };
  }, 'cnb2api gateway');

  /**
   * 把上游网关的非鉴权错误翻成一句人话，供 PROXY_KEY 校验失败时显示。
   *
   * 上游返回的响应体不可信（可能是 HTML 错误页、堆栈），只取前 300 字，
   * 并且优先用 JSON 里的 message 字段，避免整页 HTML 糊在配置页上。
   * @param {number} status - 上游 HTTP 状态码。
   * @param {string} text - 上游响应体文本。
   * @returns {string} 人话。
   */
  function explainUpstreamError(status, text) {
    let detail = '';
    try {
      const body = JSON.parse(text);
      // 兼容几种常见形状：{message} / {msg} / OpenAI 风格 {error:{message}}，
      // 以及 error 本身就是字符串或对象的情况，避免渲染成 [object Object]
      const raw = body?.message ?? body?.msg ?? body?.error?.message ?? body?.error;
      detail = (typeof raw === 'string' ? raw : raw == null ? '' : JSON.stringify(raw)).slice(0, 300);
    } catch {
      detail = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    }
    const hint = status === 402 ? '额度不足'
      : status === 408 || status === 425 ? '网关超时'
        : status === 429 ? '请求过于频繁，稍后再试'
          : status >= 500 ? '网关内部错误' : '网关返回错误';
    return `${hint} · HTTP ${status}${detail ? ` · ${detail}` : ''}`;
  }

  /**
   * 组织候选 + 每个组织的额度，供「选组织」时一并显示。
   *
   * 用户不知道每个组织还有多少 AI credits，就没法判断该选哪个；把这步查询
   * 和候选一起返回，下拉里直接能看到「可用 / 总额」。
   * @param {string} token - CNB 访问令牌。
   * @param {object} [knownMe] - 调用方已经查到的身份，省掉一次 `/user`。
   * @returns {Promise<{orgs: string[], orgDetails: object[], username: string|null}>} 候选与额度。
   */
  async function describeOrgs(token, knownMe) {
    const me = knownMe ?? await cnb.whoAmI(token).catch(() => null);
    const username = me?.username || null;
    // 用户名已经知道了就传下去：listOrgs 内部只在没拿到时才自己查 `/user`。
    const orgs = await cnb.listOrgs(token, username);
    const orgDetails = await Promise.all(orgs.map(async (name) => {
      let credit = null;
      try {
        const raw = await cnb.readQuota(token, name, 6000);
        const ledger = settleQuota(raw, raw.failures);
        if (ledger.credit) {
          credit = {
            remain: ledger.credit.remain,
            total: ledger.credit.total,
            exhausted: ledger.credit.remain <= 0,
          };
        }
      } catch { /* 额度取不到不影响选组织 */ }
      return { name, personal: username !== null && name === username, credit };
    }));
    return { orgs, orgDetails, username };
  }

  // ---------- 路由 ----------

  /**
   * 只读快照接口。界面按需拉，不推进巡检 —— 推进节奏由 checkSeconds 决定，
   * 但允许 `?probe=1` 轻推一次（有节流），否则点了「启动」要等满一个周期才看见变化。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/status`,
    handler: async (request, response) => {
      let probe = false;
      try {
        probe = new URL(request.url || '/', 'http://localhost').searchParams.get('probe') === '1';
      } catch { /* 保持默认 */ }
      if (probe) {
        for (const monitor of monitors.values()) {
          if (Date.now() - monitor.lastCheckedAt > 5000) monitor.sync('probe').catch(() => {});
        }
      }
      // 额度：有缓存就先用（界面不该被三个接口拖住），同时后台补一次。
      // 每笔账都完整给出（已用/总额/可用/冻结/赠送/百分比），并带上取不到时的原因 ——
      // 只给一个 null，用户分不清是"没有额度"还是"查不到"。
      // 网关此刻会优先把请求交给谁 —— 界面上要能直接看到这件事，
      // 否则「四个账号但只有 qdirs 有额度」这件事只能靠逐个读数字推断。
      // 必须用与网关完全相同的判定（含保底线），否则界面会标「当前」
      // 而网关根本不派活给它。pickMonitor 就是这个判定。
      const active = pickMonitor();
      const cooling = gateway.status().cooling ?? {};
      /**
       * 这笔额度是否低于警戒线。
       * @param {object|null} ledger - 额度账目。
       * @returns {boolean} 低于警戒线时为 true。
       */
      function lowCreditOf(ledger) {
        // 用与保底线/网关同一个口径，避免三处各算一套后走散
        const pct = remainPercentOf(ledger?.credit);
        return pct !== null && pct < settings().lowCreditPercent;
      }

      const accounts = [];
      for (const monitor of monitors.values()) {
        const view = describe(monitor);
        const cached = monitor.quotaCache?.ledger;
        if (!cached) monitor.quota().catch(() => {});
        const ledger = cached || (await monitor.quota().catch(() => null));
        const quotaNote = ledger?.failures?.length ? ledger.failures[0] : null;
        const chill = cooling[monitor.identity] ?? null;
        accounts.push({
          label: view.label,
          repo: view.repo,
          state: view.state,
          badge: view.badge,
          action: view.action,
          detail: view.detail.join(' · '),
          note: view.lastError,
          lastCheckedAt: view.lastCheckedAt,
          // 这个账号现在能不能真接住请求（网关的判定，不是界面猜的）
          active: monitor === active,
          // 「能用」= 可达 && 未故障 && 不低于保底线。
          // 不含保底线的话，界面会说「可用」但网关根本不会派活给它。
          usable: canServe(monitor, settings().creditFloorPercent),
          cooling: chill ? { remainingMs: chill.remainingMs, reason: chill.reason } : null,
          // 低于警戒线：界面与对话提示共用这一个判定，避免两处口径不一
          lowCredit: lowCreditOf(ledger),
          // 低于保底线：网关不会再把这个账号派活
          belowFloor: creditStateOf(monitor, settings().creditFloorPercent).belowFloor,
          // 自定义文案的渲染结果；空串表示用界面内置的默认句子
          lowCreditText: lowCreditOf(ledger)
            ? renderNotice(settings().lowCreditMessage,
              noticeVars({ account: view.label, ledger, threshold: settings().lowCreditPercent }))
            : '',
          credit: ledger?.credit ? ledgerView(ledger.credit) : { unavailable: quotaNote || '还没有取到额度' },
          coreHours: ledger?.coreHours ? ledgerView(ledger.coreHours) : { unavailable: quotaNote || '还没有取到额度' },
        });
      }
      // 请求处理上下文是干净的，由它来推进「写密钥 + 登记供应商」
      ensurePublished().catch(() => {});
      const status = gateway.status();
      const key = accessKey();
      const body = {
        configured: monitors.size > 0,
        accounts,
        // 网关：地址永不改变，客户端只用这一个基址
        gateway: {
          listening: status.listening,
          host: status.host,
          port: status.port,
          baseUrl: status.listening ? status.baseUrl : null,
          lan: status.listening ? status.lan : [],
          lanOnly: !isLoopbackHost(status.host),
          // 密钥要能看见，否则用户没法填进别的客户端；只在这里给界面
          key,
          keyGenerated: !String(settings().gatewayKey || '').trim(),
          requests: status.requests,
          refused: status.refused,
          failures: status.failures,
          failovers: status.failovers,
          // 冷却中的账号：排查「为什么这次慢」时能直接看到
          cooling: status.cooling,
        },
        // 官方供应商的接入状态：「已接入」/「只能手动填」/「失败原因」
        published,
        models: modelsOf(settings()),
        // 界面语言：让状态面板/悬浮球按插件设置里的语言显示（而不只是浏览器 lang）
        locale: settings().locale,
        autoPublish: settings().autoPublish,
        lowCreditPercent: settings().lowCreditPercent,
        lowCreditMessage: settings().lowCreditMessage,
        creditFloorPercent: settings().creditFloorPercent,
      };
      sendJson(response, 200, body);
    },
  }), 'cnb2api status route');

  // ---------- 登录（令牌 → 组织 → 仓库） ----------
  //
  // 手填组织名与仓库名不现实：记不住，填错又不报错，只会静默接到别的工作区去。
  // 所以分成三步，每一步都拿真实数据回填下拉：
  //   POST /cnb2api/login/token   { token }        → 令牌是否可用，并给出可访问的组织
  //   POST /cnb2api/login/orgs    { token }        → 组织列表（含个人空间）
  //   POST /cnb2api/login/repos   { token, org }   → 该组织下的仓库，标出是否在运行
  //
  // 这三条只做查询，不写配置。写配置仍然由表单的「保存」完成 ——
  // 用户看到候选、选好、确认之后才落盘，中间不留半成品账号。

  /**
   * 备份相关路由的入口守卫。
   *
   * 这两件事值得单独做：`/backup/webdav` 会让 Host 代发任意 URL 请求，
   * 而 `text/plain` 的「简单请求」不触发预检 —— 恶意网页能盲发一次跨域 POST，
   * 让 Host 去访问用户没打算访问的地址。要求 `application/json` 能挡住这类请求
   * （带这个头的跨域请求必须先过 CORS 预检）。
   * @param {object} request - HTTP 请求。
   * @param {object} response - HTTP 响应。
   * @returns {boolean} 是否可以继续处理；false 表示已经回了错误。
   */
  function guardMutation(request, response) {
    const type = String(request.headers?.['content-type'] || '').toLowerCase();
    if (!type.includes('application/json')) {
      sendJson(response, 415, { ok: false, reason: '需要 Content-Type: application/json' });
      return false;
    }
    return true;
  }

  /** 读请求体里的 JSON；空体或坏 JSON 都返回空对象。 */
  const readBody = async (request) => {
    const chunks = [];
    try {
      for await (const chunk of request) chunks.push(chunk);
    } catch {
      // 请求被中断（客户端断开）时读取会抛错；返回空对象让调用方走「缺字段」分支，
      // 不要让整个 handler 变成未处理的 rejection（响应会挂在那里）。
      return {};
    }
    if (chunks.length === 0) return {};
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
      return {};
    }
  };

  /** 校验令牌：能读到身份就说明可用。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/login/token`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      const { token } = await readBody(request);
      const value = String(token || '').trim();
      if (!value) {
        sendJson(response, 400, { ok: false, reason: '令牌不能为空' });
        return;
      }
      if (/^sk-/.test(value)) {
        // 最常见的填错：把 PROXY_KEY 当令牌
        sendJson(response, 400, {
          ok: false,
          reason: '这个值以 sk- 开头，是 PROXY_KEY，不是 CNB 访问令牌',
        });
        return;
      }
      const me = await cnb.whoAmI(value);
      if (!me) {
        sendJson(response, 401, {
          ok: false,
          reason: '令牌无效或已过期 · 在 CNB 头像 → 访问令牌 重新生成',
        });
        return;
      }
      const orgs = await describeOrgs(value, me);
      sendJson(response, 200, {
        ok: true,
        username: me.username || null,
        userId: me.id || null,
        orgs: orgs.orgs,
        orgDetails: orgs.orgDetails,
      });
    },
  }), 'cnb2api login token');

  /** 组织列表（独立一步，便于刷新或令牌换了以后重取）。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/login/orgs`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      const { token } = await readBody(request);
      const value = String(token || '').trim();
      if (!value) {
        sendJson(response, 400, { ok: false, reason: '先填令牌' });
        return;
      }
      const orgs = await describeOrgs(value);
      sendJson(response, 200, { ok: true, orgs: orgs.orgs, orgDetails: orgs.orgDetails });
    },
  }), 'cnb2api login orgs');

  /**
   * 验证一个仓库的 PROXY_KEY 是否被网关接受。
   *
   * 这一步值得单独做：密钥填错不会在别处暴露 —— 账号状态看着正常、额度也读得到，
   * 只有真正发起一次模型请求才会 401。在这里先问一次，比等到对话失败再查便宜得多。
   *
   * 用 `/v1/models` 探测：它需要鉴权、但不需要额度，也不会消耗 token。
   * @returns {Promise<void>}
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/login/proxy-key`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      const { token, repo, proxyKey } = await readBody(request);
      const accessToken = String(token || '').trim();
      const slug = parseRepo(repo);
      const key = String(proxyKey || '').trim();
      if (!accessToken || !slug || !key) {
        sendJson(response, 400, { ok: false, reason: '需要令牌、仓库与 PROXY_KEY' });
        return;
      }
      // 借一个临时监视器现取地址：用它自己的解析链路，和真正请求时一致
      const probe = new Monitor({ token: accessToken, repo: slug }, { cnb, settings, log: () => {} });
      await probe.sync('proxy-key-check').catch(() => {});
      if (!probe.url || !probe.reachable) {
        sendJson(response, 409, {
          ok: false,
          reason: probe.creditExhausted
            ? '工作区额度用尽，暂时无法验证密钥'
            : (probe.lastError || '工作区网关不可用，暂时无法验证密钥'),
        });
        return;
      }
      try {
        const upstream = await fetch(`${probe.url}/v1/models`, {
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(12000),
        });
        if (upstream.ok) {
          sendJson(response, 200, { ok: true });
          return;
        }
        if (upstream.status === 401 || upstream.status === 403) {
          sendJson(response, 200, {
            ok: false,
            reason: '网关拒绝了这个密钥 · 核对仓库 .cnb.yml 里 env 的 PROXY_KEY',
          });
          return;
        }
        sendJson(response, 200, {
          ok: false,
          reason: explainUpstreamError(upstream.status, await upstream.text().catch(() => '')),
        });
      } catch (error) {
        sendJson(response, 200, { ok: false, reason: `无法连接网关 · ${error.message}` });
      }
    },
  }), 'cnb2api login proxy-key');

  /** 某组织下的仓库；标出哪些已经在运行，方便一眼选出真正在跑网关的那个。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/login/repos`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      const { token, org } = await readBody(request);
      const value = String(token || '').trim();
      const group = String(org || '').trim();
      if (!value) {
        sendJson(response, 400, { ok: false, reason: '先填令牌' });
        return;
      }
      if (!group) {
        sendJson(response, 400, { ok: false, reason: '先选组织' });
        return;
      }
      const repos = await cnb.listOrgRepos(value, group);
      sendJson(response, 200, { ok: true, repos });
    },
  }), 'cnb2api login repos');

  /** 界面上的「启动」。只提交，不等冷启动 —— 进度由状态快照体现。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/start`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      let wanted = '';
      try {
        wanted = new URL(request.url || '/', 'http://localhost').searchParams.get('account') || '';
      } catch { /* 保持空 */ }
      const list = pick(wanted);
      const monitor = list[0];
      if (!monitor) {
        sendJson(response, 404, { ok: false, reason: 'unknown-account' });
        return;
      }
      // 手动启动：额度必须现查，别用上一轮巡检的结论
      await monitor.quota(true).catch(() => {});
      const started = await monitor.startIfAllowed('manual', true);
      if (!started) {
        sendJson(response, 409, {
          ok: false,
          reason: monitor.lastStartBlockedReason || monitor.lastError || '启动失败',
        });
        return;
      }
      monitor.sync('after-start').catch(() => {});
      sendJson(response, 200, { ok: true, account: monitor.label });
    },
  }), 'cnb2api start route');

  // ---------- 备份与还原 ----------
  //
  // 界面把当前草稿发过来打包（导出），或把文件内容发过来解包（导入）。
  // 写配置仍由界面走它自己的 mutate 路径 —— 这里只做纯数据变换，
  // 避免在 Host 侧再造一条「写账号配置」的通路。

  /** 打包：{scope, password?, accounts?, settings?} → 备份文档。 */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/backup/export`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      if (!guardMutation(request, response)) return;
      // readBody 对空体/坏 JSON 返回 {}，不会抛错；缺字段在下面按默认值处理
      const body = await readBody(request);
      const scope = String(body?.scope || SCOPE.all);
      // hasOwn：否则 'constructor' / '__proto__' 这类原型键会被当成合法范围
      if (!Object.hasOwn(SCOPE, scope)) {
        sendJson(response, 400, { ok: false, reason: '未知的备份范围' });
        return;
      }
      try {
        const doc = buildBackup({
          scope,
          accounts: Array.isArray(body?.accounts) ? body.accounts : [],
          settings: body?.settings && typeof body.settings === 'object' ? body.settings : {},
          password: String(body?.password || ''),
        });
        sendJson(response, 200, { ok: true, doc, encrypted: doc.encrypted === true });
      } catch (error) {
        sendJson(response, 400, { ok: false, reason: String(error?.message || error) });
      }
    },
  }), 'cnb2api backup export');

  /**
   * 解包：{content, password?} → 账号与设置，并给出合并预览。
   *
   * 这里**不写配置**，只回报「会新增几条、覆盖几条」，让界面先确认再落盘。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/backup/import`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      if (!guardMutation(request, response)) return;
      const body = await readBody(request);
      try {
        const parsed = parseBackup(String(body?.content || ''), String(body?.password || ''));
        // 合并预览：拿界面传来的现有账号算，不读 Host 自己的配置（界面才是草稿的真相）
        const existing = Array.isArray(body?.existing) ? body.existing : [];
        const merged = mergeAccounts(existing, parsed.accounts);
        sendJson(response, 200, {
          ok: true,
          scope: parsed.scope,
          accounts: parsed.accounts,
          settings: parsed.settings,
          exportedAt: parsed.exportedAt,
          added: merged.added,
          replaced: merged.replaced,
          merged: merged.accounts,
        });
      } catch (error) {
        sendJson(response, 200, { ok: false, reason: String(error?.message || error) });
      }
    },
  }), 'cnb2api backup import');

  /**
   * WebDAV：{action: 'upload'|'download', url, username?, password?, content?}。
   *
   * 由 Host 代发请求：WebDAV 服务器普遍不带 CORS 头，浏览器直连会被拦。
   */
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: `${BASE}/backup/webdav`,
    handler: async (request, response) => {
      if (String(request.method).toUpperCase() !== 'POST') {
        sendJson(response, 405, { ok: false, reason: 'method' });
        return;
      }
      if (!guardMutation(request, response)) return;
      const body = await readBody(request);
      const action = String(body?.action || '');
      const url = String(body?.url || '').trim();
      const username = String(body?.username || '');
      const password = String(body?.password || '');
      try {
        if (action === 'upload') {
          const result = await davPut({ url, username, password, content: String(body?.content || '') });
          sendJson(response, 200, { ok: true, url: result.url, bytes: result.bytes });
          return;
        }
        if (action === 'download') {
          const result = await davGet({ url, username, password });
          sendJson(response, 200, { ok: true, url: result.url, content: result.content });
          return;
        }
        sendJson(response, 400, { ok: false, reason: 'action 只能是 upload 或 download' });
      } catch (error) {
        sendJson(response, 200, { ok: false, reason: String(error?.message || error) });
      }
    },
  }), 'cnb2api backup webdav');

  log(`已就绪 · ${monitors.size} 个账号 · 工具 cnb2api_status / cnb2api_start / cnb2api_quota`
    + ` · 网关 ${settings().gatewayHost}:${settings().gatewayPort}/v1 · 快照 ${BASE}/status`);
}

/**
 * 把一笔额度转成界面要的形状。
 *
 * 数字原样给出（保留精度），由界面决定显示几位：后台四舍五入会让
 * 「1166.04 / 1166」这种真实情况变成看起来不可能的「1166 / 1166」。
 * @param {object} ledger - {@link settle} 的结果。
 * @returns {object} 界面消费的形状。
 */
function ledgerView(ledger) {
  const view = consumption(ledger);
  return {
    used: ledger.used,
    total: ledger.total,
    remain: ledger.remain,
    frozen: ledger.frozen,
    // 真实消耗 = 已用 + 冻结。冻结那一刻就从额度里扣掉了，
    // 进度条必须用它，否则会严重低估（实测 41% vs 真实 96%）。
    consumed: view.consumed,
    percent: ledger.usedPercent,
    bonus: ledger.bonus,
    exhausted: ledger.remain <= 0,
    note: describeBonus(ledger),
  };
}

/**
 * 发一段 JSON。
 * @param {object} response - node 响应。
 * @param {number} status - 状态码。
 * @param {object} value - 正文。
 */
function sendJson(response, status, value) {
  const text = JSON.stringify(value);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  response.end(text);
}

