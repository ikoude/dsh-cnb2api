/**
 * dsh-cnb2api — browser half.
 *
 * Three registrations, all on the Plugins page rather than in the chat:
 *
 *   plugins.bundle.config    the configuration form, on the plugin's own detail page
 *   plugins.detail.section   the workspace status panel, below that page
 *   shell.overlay            the draggable floating ball (per-browser toggle)
 *
 * Nothing renders in the conversation area: workspace state is something you go
 * and look at, not a permanent row under every message.
 */

window.__ModuleLoader__.load({
  id: 'dsh-cnb2api',
  factory: (require) => {
    const React = require('react');
    const {
      createElement: h, Fragment, useState, useEffect, useRef, useCallback,
    } = React;

    const PACKAGE = 'dsh-cnb2api';
    /** Host plugin entry id — the configuration namespace. */
    const ENTRY = 'cnb2api';
    /** How often the panel re-reads the snapshot while it is open. */
    const POLL_MS = 12000;

    // ---------------------------------------------------------------- text

    const ZH = {
      orb: {
        used: '已用',
        close: '收起',
        openDetails: '打开插件页',
      },
      panel: {
        title: '工作区状态',
        empty: '尚未配置账号 · 在「设置 → 插件 → CNB2API」的详情页里填写 CNB 访问令牌与组织/仓库',
        loading: '读取中…',
        failed: '读不到状态',
        stale: '上次读数',
        refresh: '刷新',
        start: '启动',
        starting: '启动中…',
        started: '已提交启动 · 网关通常 30–90 秒内就绪',
        startFailed: '启动失败',
        exhausted: '已用尽',
        frozen: '冻结',
        remaining: '可用',
        frozenHint: '预扣：已从额度中扣除，停止工作区后计入已用，不返还',
        credits: 'AI credits',
        coreHours: '核时',
        activeAccount: '当前',
        usable: '可用',
        unusable: '不可用',
        cooling: '冷却',
        onlyOne: '只有这一个账号能接住请求',
        lowCredit: '额度即将耗尽 · 请补额度',
        noneUsable: '没有账号能接住请求 · 补足额度或修好令牌',
        gateway: '网关',
        accountsUnit: '个账号',
        usableUnit: '个可用',
        gatewayBase: '基址',
        gatewayLan: '局域网',
        gatewayKey: '访问密钥',
        gatewayCopy: '复制',
        gatewayCopied: '已复制',
        gatewayRequests: '累计请求',
        gatewayPublishOn: '已接入「设置 → 模型」',
        gatewayPublishOff: '未自动接入 · 用上面的基址与密钥自己填',
        gatewayPublishFailed: '自动接入失败',
        gatewayDown: '网关没有在监听',
      },
      state: {
        ready: '就绪', noCredit: '额度用尽', unreachable: '地址不通', stopped: '已停止',
        absent: '无工作区', starting: '启动中', misconfigured: '配置有问题', unknown: '识别中',
      },
      badge: {
        ok: '可用', noCredit: '无额', offline: '掉线', stopped: '停止',
        absent: '未建', starting: '启动', error: '异常', checking: '识别', unknown: '未知',
      },
      form: {
        title: 'CNB 账号',
        accounts: 'CNB 账号',
        orb: '显示悬浮球',
        orbHint: '在窗口角落显示一个可拖动的圆球，显示总额度使用比例',
        intervalHint: '最少 30 秒；越短越及时，也越费 CNB 接口',
        localeHint: '影响插件界面与 agent 工具输出的语言',
        empty: '还没有账号。点「添加账号」，先粘贴令牌并点「验证并登录」，再从列表里选组织与仓库，填好 PROXY_KEY，最后按「保存」。',
        add: '添加账号',
        intro: '每个账号是一个 CNB 用户加一个组织/仓库。先验证令牌，组织与仓库都从列表里选 —— 手填的组织名或仓库名不会报错，只会接到别的工作区去。',
        remove: '移除',
        cancelAdd: '取消',
        removeConfirm: '确认移除',
        removeNote: '保存后才会删掉',
        cancel: '取消',
        token: 'CNB 访问令牌',
        tokenHint: 'CNB 头像 → 访问令牌，通常不以 sk- 开头；粘贴后点「验证并登录」',
        signIn: '验证并登录',
        signingIn: '验证中…',
        signedIn: '令牌可用 · 下面从列表里选组织与仓库',
        recheck: '重新验证',
        tokenRejected: '这个令牌不能用',
        org: '组织',
        orgHint: '列出令牌能访问的组织',
        pickOrg: '选择组织…',
        personal: '个人空间',
        quotaUnknown: '额度未知',
        noOrgs: '这个令牌没有可访问的组织',
        repoHint: '列出该组织下的仓库；带「运行中」的说明已有工作区',
        pickRepo: '选择仓库…',
        noRepos: '该组织下没有仓库',
        loadingRepos: '读取仓库中…',
        running: '运行中',

        repo: '组织/仓库',
        proxyKey: 'PROXY_KEY',
        proxyKeyHint: '该仓库 .cnb.yml 里 env 的 PROXY_KEY，通常以 sk- 开头',
        more: '更多',
        collapse: '收起',
        expand: '展开',
        collapseAll: '收起全部',
        expandAll: '展开全部',
        branch: '分支',
        branchHint: '留空则用下面的全局分支',
        port: '网关端口',
        portHint: '留空则用下面的全局端口',
        show: '显示',
        hide: '隐藏',
        keyCheck: '验证密钥',
        keyChecking: '验证中…',
        keyOk: '密钥可用',
        keyBad: '密钥不可用',
        save: '保存',
        saving: '保存中…',
        discard: '撤销',
        saved: '已保存',
        saveFailed: '保存失败',
        unsaved: '有未保存的修改',
        blockedHint: '有必填项未填或校验未通过，请检查标红处后再保存',
        loading: '读取配置中…',
        readonly: '这个 profile 不允许改写配置，只能在 cordis.patch.yml 里改。',
        needToken: '填写这个账号的 CNB 访问令牌',
        needProxyKey: '填写这个仓库的 PROXY_KEY',
        dupRepo: '同一个仓库只能有一个账号',
        intervalMin: '巡检间隔不能小于 30 秒',
        general: '全局',
        groupCheck: '巡检',
        groupGateway: '网关',
        groupCredit: '余额与提示',
        groupOther: '其它',
        checkSeconds: '巡检间隔（秒）',
        gatewayHost: '监听地址',
        gatewayHostHint: '0.0.0.0 局域网内其它设备也能用；127.0.0.1 只有本机能用',
        hostLocal: '127.0.0.1 · 本机',
        hostLan: '0.0.0.0 · 局域网',
        gatewayPort: '监听端口',
        gatewayPortHint: '被占用会自动顺延，实际端口看插件页',
        gatewayKey: '访问密钥',
        gatewayKeyHint: '客户端用它调用网关。留空会自动生成一个',
        gatewayRegenerate: '重新生成',
        lowCreditPercent: '余额警戒线（%）',
        lowCreditPercentHint: '可用额度低于这个比例时在对话里提前提示',
        lowCreditBad: '警戒线要在 1–100 之间',
        creditFloorPercent: '余额保底线（%）',
        creditFloorPercentHint: '可用低于此比例时停止使用该账号，防止任务中途超用；0 表示不设保底',
        floorBad: '保底线要在 1–100 之间（0 表示不设保底）',
        belowFloor: '已停用',
        lowCreditMessage: '不足时的提示文案',
        lowCreditMessageHint: '留空则用上面那句默认文案',
        lowCreditExample: '示例',
        varLegend: {
          account: '账号',
          percent: '已耗百分比',
          used: '已结算消耗',
          frozen: '预扣（冻结）',
          consumed: '已用+预扣',
          remain: '剩余可用',
          total: '总额（含赠送）',
          threshold: '警戒线',
          unit: '单位',
        },
        models: '模型清单',
        modelsHint: '逗号分隔；写进 DSH 供应商的可选模型，网关不校验，填错会由上游报错',
        modelsBad: '模型清单不能为空',
        autoPublish: '自动接入「设置 → 模型」',
        autoPublishHint: '打开后把固定基址和密钥写进官方供应商，不用手填；关闭则自己填',
        portBad: '端口要在 1–65535 之间',
        autoStart: '工作区停止后自动启动',
        autoStartHint: '额度用尽时不会启动；额度恢复后自动接上',
        locale: '面板语言',
        localeAuto: '跟随界面',
        secrets: '令牌与 PROXY_KEY 存在本机 profile 的 cordis.patch.yml 里。多人共用这台机器时注意文件权限。',
      },
    };

    const EN = {
      orb: {
        used: 'used',
        close: 'Collapse',
        openDetails: 'Open plugin page',
      },
      panel: {
        title: 'Workspace status',
        empty: 'No account yet · add a CNB access token and an org/repo on the CNB2API page (Settings → Plugins)',
        loading: 'Loading…',
        failed: 'Status unavailable',
        stale: 'last reading',
        refresh: 'Refresh',
        start: 'Start',
        starting: 'Starting…',
        started: 'Start submitted · the gateway is usually ready within 30–90 seconds',
        startFailed: 'Start failed',
        credits: 'AI credits',
        exhausted: 'used up',
        frozen: 'frozen',
        remaining: 'left',
        frozenHint: 'Pre-charged: already deducted, booked as used when the workspace stops — not refunded',
        coreHours: 'Core-hours',
        activeAccount: 'Now',
        usable: 'Usable',
        unusable: 'Unusable',
        cooling: 'Cooling',
        onlyOne: 'Only this account can serve requests',
        lowCredit: 'Credit almost gone · top up',
        noneUsable: 'No account can serve requests · top up credit or fix the token',
        gateway: 'Gateway',
        accountsUnit: 'accounts',
        usableUnit: 'usable',
        gatewayBase: 'Base URL',
        gatewayLan: 'LAN',
        gatewayKey: 'Access key',
        gatewayCopy: 'Copy',
        gatewayCopied: 'Copied',
        gatewayRequests: 'Requests',
        gatewayPublishOn: 'Published to Settings → Models',
        gatewayPublishOff: 'Not published · fill the base URL and key yourself',
        gatewayPublishFailed: 'Publish failed',
        gatewayDown: 'The gateway is not listening',
      },
      state: {
        ready: 'Ready', noCredit: 'No credit', unreachable: 'Unreachable', stopped: 'Stopped',
        absent: 'No workspace', starting: 'Starting', misconfigured: 'Misconfigured', unknown: 'Checking',
      },
      badge: {
        ok: 'Ready', noCredit: 'No credit', offline: 'Offline', stopped: 'Stopped',
        absent: 'None', starting: 'Starting', error: 'Error', checking: 'Checking', unknown: 'Unknown',
      },
      form: {
        title: 'CNB accounts',
        accounts: 'CNB accounts',
        orb: 'Show floating ball',
        orbHint: 'A draggable ring in the corner showing total quota usage',
        intervalHint: 'Minimum 30s; shorter is fresher but costs more requests',
        localeHint: 'Affects this plugin\u2019s UI and the language of agent tool output',
        intro: 'Each account is one CNB user plus one org/repo. Verify the token first, then pick both from lists — a mistyped organisation or repository does not fail, it silently attaches to a different workspace.',
        empty: 'No account yet. Choose Add account, paste the token and press Verify, pick an organisation and repository from the lists, fill in the PROXY_KEY, then Save.',
        add: 'Add account',
        remove: 'Remove',
        cancelAdd: 'Cancel',
        removeConfirm: 'Confirm',
        removeNote: 'removed on save',
        cancel: 'Cancel',
        token: 'CNB access token',
        tokenHint: 'CNB avatar → Access tokens; normally not starting with sk-. Paste it, then Verify.',
        signIn: 'Verify and sign in',
        signingIn: 'Verifying…',
        signedIn: 'Token works · pick an organisation and repository below',
        recheck: 'Verify again',
        tokenRejected: 'This token cannot be used',
        org: 'Organisation',
        orgHint: 'Organisations this token can reach',
        pickOrg: 'Choose an organisation…',
        personal: 'personal',
        quotaUnknown: 'credit unknown',
        noOrgs: 'This token reaches no organisation',
        repoHint: 'Repositories in that organisation; “running” means it already has a workspace',
        pickRepo: 'Choose a repository…',
        noRepos: 'No repository in that organisation',
        loadingRepos: 'Loading repositories…',
        running: 'running',

        repo: 'Org/repo',
        proxyKey: 'PROXY_KEY',
        proxyKeyHint: 'env PROXY_KEY of that repository\u2019s .cnb.yml; normally starts with sk-',
        more: 'More',
        collapse: 'Collapse',
        expand: 'Expand',
        collapseAll: 'Collapse all',
        expandAll: 'Expand all',
        branch: 'Branch',
        branchHint: 'Empty uses the global branch below',
        port: 'Gateway port',
        portHint: 'Empty uses the global port below',
        show: 'Show',
        hide: 'Hide',
        keyCheck: 'Test key',
        keyChecking: 'Testing…',
        keyOk: 'Key works',
        keyBad: 'Key rejected',
        save: 'Save',
        saving: 'Saving…',
        discard: 'Discard',
        saved: 'Saved',
        saveFailed: 'Save failed',
        unsaved: 'Unsaved changes',
        blockedHint: 'Fill required fields or fix the highlighted errors before saving',
        loading: 'Loading configuration…',
        readonly: 'This profile does not allow configuration writes; edit cordis.patch.yml instead.',
        needToken: 'Fill in this account\u2019s CNB access token',
        needProxyKey: 'Fill in this repository\u2019s PROXY_KEY',
        dupRepo: 'One account per repository',
        intervalMin: 'The check interval cannot be less than 30 seconds',
        general: 'General',
        groupCheck: 'Monitoring',
        groupGateway: 'Gateway',
        groupCredit: 'Credit & alerts',
        groupOther: 'Other',
        checkSeconds: 'Check interval (seconds)',
        gatewayHost: 'Listen address',
        gatewayHostHint: '0.0.0.0 also serves other devices on the LAN; 127.0.0.1 is this machine only',
        hostLocal: '127.0.0.1 · local',
        hostLan: '0.0.0.0 · LAN',
        gatewayPort: 'Listen port',
        gatewayPortHint: 'Falls forward when taken; the plugin page shows the actual one',
        gatewayKey: 'Access key',
        gatewayKeyHint: 'Clients call the gateway with it. Leave empty to generate one',
        gatewayRegenerate: 'Regenerate',
        lowCreditPercent: 'Credit alert line (%)',
        lowCreditPercentHint: 'Warn before a conversation when available credit falls below this',
        lowCreditBad: 'The alert line must be between 1 and 100',
        creditFloorPercent: 'Credit floor (%)',
        creditFloorPercentHint: 'Stop using this account below this share, so a task cannot overrun; 0 disables it',
        floorBad: 'The floor must be 1–100 (0 disables it)',
        belowFloor: 'Paused',
        lowCreditMessage: 'Warning text',
        lowCreditMessageHint: 'Leave empty to use the default sentence above',
        lowCreditExample: 'Example',
        varLegend: {
          account: 'account',
          percent: 'used share',
          used: 'settled usage',
          frozen: 'pre-charged hold',
          consumed: 'used + hold',
          remain: 'credit left',
          total: 'total (incl. bonus)',
          threshold: 'alert line',
          unit: 'unit',
        },
        models: 'Models',
        modelsHint: 'Comma-separated; published as the provider’s model list. Not validated here — a wrong id fails upstream',
        modelsBad: 'The model list cannot be empty',
        autoPublish: 'Publish to Settings → Models',
        autoPublishHint: 'Writes the fixed base URL and key into the official provider so you need not type them',
        portBad: 'The port must be between 1 and 65535',
        autoStart: 'Restart a stopped workspace automatically',
        autoStartHint: 'Skipped while credits are used up; resumes when they return',
        locale: 'Panel language',
        localeAuto: 'Follow the UI',
        secrets: 'Tokens and PROXY_KEYs live in this profile\u2019s cordis.patch.yml. Check file permissions when the machine is shared.',
      },
    };

    /** Pick the table for the page's language, read at render time. */
    // 语言：显式配置（zh/en）优先，auto/未知时跟随浏览器 lang。
    // 这样「插件设置里选中文/英文」是真的生效，而不是死开关。
    const table = (pref) => {
      const wanted = String(pref || '').toLowerCase();
      const lang = wanted === 'zh' || wanted === 'en'
        ? wanted
        : (String(document.documentElement.lang || 'zh').toLowerCase().startsWith('en') ? 'en' : 'zh');
      return lang === 'en' ? EN : ZH;
    };

    // ---------------------------------------------------------------- styles

    /**
     * Theme tokens only, so a renamed token degrades the look but never breaks
     * rendering. Sizes follow the host's settings pages: 28px controls,
     * 32px inputs, 12/13px type.
     */
    const CSS = `
.cnb2api { display: flex; flex-direction: column; gap: 10px; font-size: 14px; color: var(--dsw-alias-label-primary); }
.cnb2api * { box-sizing: border-box; }
.cnb2api-sec {
  display: flex; flex-direction: column; gap: 8px;
  padding-top: 10px; margin-top: 8px;
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
.cnb2api-head { display: flex; align-items: center; gap: 8px; }
.cnb2api-title { margin: 0; flex: 1; min-width: 0; font-size: 14px; font-weight: 600; color: var(--dsw-alias-label-secondary); }
.cnb2api-hint { font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-quaternary); }
.cnb2api-hint[data-bad="true"] { color: var(--dsw-alias-label-error); }
.cnb2api-hint[data-ok="true"] { color: var(--dsw-alias-state-success-primary); }
.cnb2api-note { margin: 0; font-size: 13px; line-height: 1.55; color: var(--dsw-alias-label-tertiary); }
.cnb2api-note[data-tone="error"] { color: var(--dsw-alias-label-error); }
.cnb2api-note[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.cnb2api-note[data-tone="warn"] { color: var(--dsw-alias-state-warn-label); }

.cnb2api-btn {
  display: inline-flex; align-items: center; justify-content: center;
  height: 28px; padding: 0 10px; border: none; border-radius: var(--dsw-radius-sm);
  font: inherit; font-size: 12px; line-height: 18px; cursor: pointer;
  color: var(--dsw-alias-label-primary); background: transparent;
}
.cnb2api-btn:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.cnb2api-btn:disabled { cursor: not-allowed; opacity: 0.4; }
.cnb2api-btn[data-v="primary"] { background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.cnb2api-btn[data-v="primary"]:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.cnb2api-btn[data-v="outline"] { box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3); }
.cnb2api-btn[data-v="danger"] { color: var(--dsw-alias-label-error); }
.cnb2api-btn[data-v="danger"]:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover-danger); }
/* 图标按钮：只占图标大小，别在标题行里和文字按钮抢体量 */
.cnb2api-btn-icon { width: 24px; height: 24px; padding: 0; color: var(--dsw-alias-label-tertiary); }
.cnb2api-btn-icon:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.cnb2api-icon { font-size: 14px; line-height: 1; }

.cnb2api-card[data-collapsed="true"] > :not(.cnb2api-cardhead) { display: none; }
.cnb2api-card[data-collapsed="true"] { gap: 0; }
.cnb2api-chevron { width: 18px; height: 18px; font-size: 10px; color: var(--dsw-alias-label-tertiary); }
.cnb2api-card {
  display: flex; flex-direction: column; gap: 10px;
  padding: 12px 14px; border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3); background: var(--dsw-alias-bg-layer-1);
}
.cnb2api-cardhead { display: flex; align-items: center; gap: 6px; }
.cnb2api-cardname { flex: 1; min-width: 0; font-weight: 600; font-size: 13px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.cnb2api-field { display: flex; flex-direction: column; gap: 4px; }
.cnb2api-label { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cnb2api-input {
  width: 100%; height: 32px; padding: 0 8px; font: inherit; font-size: 13px;
  border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md);
  background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); outline: none;
}
.cnb2api-input:focus { border-color: var(--dsw-alias-state-business-primary); }
select.cnb2api-input { appearance: none; padding-right: 26px; cursor: pointer;
  background-image: none; }
select.cnb2api-input:disabled { cursor: not-allowed; color: var(--dsw-alias-label-dimmed); }
.cnb2api-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.cnb2api-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.cnb2api-secret { display: flex; align-items: center; gap: 6px; }
.cnb2api-secret .cnb2api-input { flex: 1; min-width: 0; }
.cnb2api-count {
  flex: none; min-width: 22px; padding: 0 7px; border-radius: 10px;
  font-size: 11px; line-height: 18px; text-align: center;
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-tertiary);
}
.cnb2api-empty {
  padding: 14px; border-radius: var(--dsw-radius-md);
  border: 0.5px dashed var(--dsw-alias-border-l3);
  font-size: 12px; line-height: 1.7; color: var(--dsw-alias-label-tertiary);
}
.cnb2api-subhead {
  font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary);
  padding: 10px 0 2px; letter-spacing: .02em;
}
.cnb2api-setting {
  display: flex; align-items: center; gap: 12px;
  padding: 6px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.cnb2api-setting:last-child { border-bottom: none; }
/* 模板类设置独占整行：标签在上，输入与变量在下，避免窄面板里左标签被挤到换行 */
.cnb2api-setting-block { display: flex; flex-direction: column; align-items: stretch; gap: 8px; }
.cnb2api-setting-main { display: flex; flex-direction: column; gap: 2px; flex: 1; min-width: 0; }
.cnb2api-setting-label { font-size: 12px; color: var(--dsw-alias-label-primary); }
.cnb2api-keyrow { display: flex; align-items: center; gap: 6px; flex: none; }
.cnb2api-keyrow .cnb2api-input { width: 210px; }
.cnb2api-gwrow {
  display: flex; align-items: center; gap: 8px; padding: 6px 0; min-width: 0;
}
.cnb2api-gwlabel {
  flex: none; width: 64px; font-size: 12px; color: var(--dsw-alias-label-secondary);
}
.cnb2api-code {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 12px;
  color: var(--dsw-alias-label-primary);
  background: var(--dsw-alias-bg-layer-2); border-radius: var(--dsw-radius-s, 6px);
  padding: 4px 8px;
}
.cnb2api-input-num { width: auto; min-width: 84px; max-width: 120px; flex: none; }
.cnb2api-input-host { width: 172px; max-width: 62vw; flex: none; }
.cnb2api-input-wide { width: 300px; max-width: 46vw; flex: none; text-align: left; }
/* 纵向区块里的输入框铺满整行（低额度提示专用） */
.cnb2api-input-block { width: 100%; max-width: none; flex: none; text-align: left; }
/* 模板输入 + 变量图例 + 示例，纵向堆叠在控件一侧 */
.cnb2api-stack { display: flex; flex-direction: column; gap: 8px; align-items: stretch; width: 100%; }
.cnb2api-vars { display: flex; flex-wrap: wrap; gap: 6px 14px; justify-content: flex-start; }
.cnb2api-var { display: inline-flex; align-items: baseline; gap: 4px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.cnb2api-var code {
  font-family: var(--dsw-alias-font-mono, ui-monospace, monospace); font-size: 11px;
  color: var(--dsw-alias-label-secondary);
  background: var(--dsw-alias-bg-layer-2); border-radius: 3px; padding: 1px 4px;
}
.cnb2api-var-desc { color: var(--dsw-alias-label-quaternary); }
.cnb2api-example {
  display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap; justify-content: flex-start;
  font-size: 11px; color: var(--dsw-alias-label-secondary); text-align: left;
}
.cnb2api-switch {
  flex: none; appearance: none; width: 34px; height: 20px; border-radius: 10px;
  background: var(--dsw-alias-border-l3); position: relative; cursor: pointer;
  transition: background .15s ease; margin: 0;
}
.cnb2api-switch::after {
  content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px;
  border-radius: 50%; background: var(--dsw-alias-bg-layer-1);
  transition: transform .15s ease;
}
.cnb2api-switch:checked { background: var(--dsw-alias-state-business-primary); }
.cnb2api-switch:checked::after { transform: translateX(14px); }
.cnb2api-switch:disabled { opacity: .4; cursor: not-allowed; }
.cnb2api-foot {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
  padding: 8px 0; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

.cnb2api-orb-wrap { position: absolute; pointer-events: auto; z-index: 1; }
.cnb2api-orb {
  position: relative; display: flex; align-items: center; justify-content: center;
  box-sizing: border-box;
  width: 44px; height: 44px; padding: 0; margin: 0;
  /* 正圆：没有边框，靠环本身与阴影成形。带 border 会同时吃掉内容宽度，
     在小尺寸下看得出方角。 */
  border: none; border-radius: 50%;
  -webkit-appearance: none; appearance: none;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  box-shadow: var(--dsw-shadow-lv2);
  cursor: grab; overflow: visible;
  touch-action: none; user-select: none;
}
.cnb2api-orb:focus-visible {
  outline: 2px solid var(--dsw-alias-state-business-primary);
  outline-offset: 2px;
}
.cnb2api-orb:active { cursor: grabbing; }
.cnb2api-orb:hover { color: var(--dsw-alias-label-primary); }
.cnb2api-orb-dot {
  position: absolute; top: 3px; right: 3px; width: 8px; height: 8px; border-radius: 50%;
  box-shadow: 0 0 0 1.5px var(--dsw-alias-bg-layer-1);
  background: var(--dsw-alias-label-quaternary);
}
.cnb2api-ring {
  position: absolute; inset: 0; width: 44px; height: 44px; pointer-events: none;
  /* SVG 有自己的 viewBox 与物理尺寸，1:1 绘制不缩放，避免小尺寸下拉伸导致的锯齿/变形。
     shape-rendering 留默认（auto）：浏览器对 stroke 做原生抗锯齿，最稳。 */
}
.cnb2api-ring-track { stroke: var(--dsw-alias-border-l2); }
.cnb2api-ring-fill { stroke: var(--dsw-alias-state-business-primary); transition: stroke-dasharray .3s ease; }
.cnb2api-ring[data-tone="ok"] .cnb2api-ring-fill { stroke: var(--dsw-alias-state-success-primary); }
.cnb2api-ring[data-tone="warn"] .cnb2api-ring-fill { stroke: var(--dsw-alias-state-warn-primary); }
.cnb2api-ring[data-tone="error"] .cnb2api-ring-fill { stroke: var(--dsw-alias-state-error-primary); }
.cnb2api-orb-text {
  position: relative; font-size: 11px; font-weight: 600;
  font-variant-numeric: tabular-nums; color: inherit; pointer-events: none;
}
.cnb2api-orb[data-tone="ok"] { color: var(--dsw-alias-state-success-primary); }
.cnb2api-orb[data-tone="ok"] .cnb2api-orb-dot { background: var(--dsw-alias-state-success-primary); }
.cnb2api-orb[data-tone="warn"] { color: var(--dsw-alias-state-warn-primary); }
.cnb2api-orb[data-tone="warn"] .cnb2api-orb-dot { background: var(--dsw-alias-state-warn-primary); }
.cnb2api-orb[data-tone="error"] { color: var(--dsw-alias-label-error); }
.cnb2api-orb[data-tone="error"] .cnb2api-orb-dot { background: var(--dsw-alias-state-error-primary); }
.cnb2api-orb-card {
  position: absolute; right: 0; bottom: 52px;
  display: flex; flex-direction: column; gap: 8px;
  width: 320px; max-height: 60vh;
  /* 不再整卡滚动：头（标题+刷新+关闭）和尾（打开插件页）固定在两端，
     只有中间的账号列表滚动。否则滚到底就看不到关闭按钮了。 */
  overflow: hidden;
  padding: 12px 14px; border-radius: var(--dsw-radius-md);
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: var(--dsw-alias-bg-layer-1);
  box-shadow: var(--dsw-shadow-lv3);
  font-size: 12px; color: var(--dsw-alias-label-primary);
  /* 亮色下浅色小字在子像素渲染会发虚：强制灰度抗锯齿，文字更利落 */
  -webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale;
  text-rendering: geometricPrecision;
}
.cnb2api-orb-card > .cnb2api-head { flex: none; }
/* 亮色下发虚的根源是最浅一档的 11px quaternary 小字：
   在悬浮球卡片内统一提一档对比度与字号，暗色也仍然协调。 */
.cnb2api-orb-card .cnb2api-meter-foot { font-size: 12px; color: var(--dsw-alias-label-secondary); }
.cnb2api-orb-card .cnb2api-detail { color: var(--dsw-alias-label-secondary); }
.cnb2api-orb-card .cnb2api-row[data-usable="false"] .cnb2api-detail { color: var(--dsw-alias-label-secondary); }
.cnb2api-orb-card .cnb2api-meter-label,
.cnb2api-orb-card .cnb2api-meter-pct { color: var(--dsw-alias-label-secondary); }
/* 底部按钮撑满宽度并与卡片内边距对齐，成为一条清楚的「出口」 */
.cnb2api-orb-open {
  flex: none; width: 100%; height: 30px; margin-top: 2px;
  color: var(--dsw-alias-label-secondary);
}
/* 账号列表是唯一的滚动区。min-height: 0 是 flex 子项能滚动的必要条件。 */
.cnb2api-orb-list {
  flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column;
  margin: 0 -6px; padding: 0 6px;
}
.cnb2api-row {
  display: flex; flex-direction: column; gap: 3px;
  padding: 8px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.cnb2api-row:last-child { border-bottom: none; }
.cnb2api-rowhead { display: flex; align-items: center; gap: 8px; }
.cnb2api-name { flex: 1; min-width: 0; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnb2api-detail { font-size: 12px; color: var(--dsw-alias-label-tertiary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cnb2api-row[data-active="true"] .cnb2api-detail { color: var(--dsw-alias-label-secondary); }
.cnb2api-meter { display: flex; flex-direction: column; gap: 3px; margin-top: 2px; }
.cnb2api-meter-head { display: flex; align-items: baseline; gap: 8px; font-size: 12px; }
.cnb2api-meter-label { color: var(--dsw-alias-label-secondary); }
.cnb2api-meter-value { flex: 1; min-width: 0; color: var(--dsw-alias-label-primary); font-variant-numeric: tabular-nums; }
.cnb2api-meter-pct { color: var(--dsw-alias-label-tertiary); font-variant-numeric: tabular-nums; }
/*
 * 用尽时整行文字降到次级色，而不是只把「已用尽」标红 ——
 * 半红半黑看着像渲染了一半，而且「额度用完」是常态不是故障，
 * 红色留给真正的错误（令牌失效、配置错误）。
 */
.cnb2api-meter[data-dead="true"] .cnb2api-meter-value,
.cnb2api-meter[data-dead="true"] .cnb2api-meter-pct,
.cnb2api-meter[data-dead="true"] .cnb2api-meter-label { color: var(--dsw-alias-label-tertiary); }
.cnb2api-meter-dead { color: var(--dsw-alias-label-tertiary); }
.cnb2api-meter-none { flex: 1; color: var(--dsw-alias-label-quaternary); }
.cnb2api-meter-foot { display: flex; gap: 10px; flex-wrap: wrap; font-size: 11px; color: var(--dsw-alias-label-quaternary); }
.cnb2api-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l2); overflow: hidden; }
.cnb2api-bar-fill { display: block; height: 100%; border-radius: 2px; background: var(--dsw-alias-state-business-primary); }
/* 剩余不足 10%：用警示色提醒，但仍然不是红色 —— 红留给真正的故障 */
/*
 * 进度条只有两种状态：正常（蓝）、用尽（灰空槽）。
 * 不再按「已用 > 90%」变橙 —— 那会把「快满了」这个常态渲染成告警，
 * 而真正需要提醒的是「剩余不足 10%」，那句话单独用文字说。
 */
.cnb2api-bar[data-dead="true"] .cnb2api-bar-fill { background: var(--dsw-alias-border-l3); }
/*
 * 用尽的账号：**只降文字色**，不要整体变淡。
 *
 * 整体变淡会连进度条、边框、按钮一起失去分量，整块看起来像被禁用
 * （点了会没反应那种），而这里的「启动」按钮恰恰是能点的。改成分层的文字色：
 * 名字降到 secondary（仍然读得清），说明文字降到 tertiary。
 * 不做 hover 提亮 —— 颜色本身就是稳定的层级，不该跟着鼠标跳。
 */
.cnb2api-row[data-usable="false"] .cnb2api-name { color: var(--dsw-alias-label-secondary); }
.cnb2api-row[data-usable="false"] .cnb2api-detail { color: var(--dsw-alias-label-quaternary); }

.cnb2api-row[data-active="true"] .cnb2api-name {
  color: var(--dsw-alias-label-primary); font-weight: 600;
}
/*
 * 圆点只表达「能不能用」，尺寸在所有行里保持一致。
 * 不给「当前」那行加光晕 —— 8px 的圆点套 3px 外环会让它视觉上大 75%，
 * 一眼看去像两种不同规格的东西；而「当前」已经有徽标 + 加粗名字在说。
 */
.cnb2api-badge {
  display: inline-flex; align-items: center; justify-content: center;
  flex: none; box-sizing: border-box; height: 22px; padding: 0 6px;
  border-radius: 4px; font-size: 10px; line-height: 1; text-align: center; white-space: nowrap;
  border: 1px solid var(--dsw-alias-border-l2); color: var(--dsw-alias-label-tertiary);
}
/* 行内的「启动」按钮跟着徽标一起收到 22px：两者并排，差 10px 会很显眼 */
.cnb2api-rowhead .cnb2api-btn { height: 22px; padding: 0 8px; font-size: 12px; line-height: 1; }
.cnb2api-badge[data-tone="ok"] { border-color: var(--dsw-alias-state-success-primary); color: var(--dsw-alias-state-success-primary); }
/* 「无额」是常态不是异常：用中性色。橙色留给真的需要注意的那一条。 */
.cnb2api-badge[data-tone="muted"] { border-color: var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); }
/* 「当前在用」用业务色：它说的是一件正在发生的事，不是状态标签 */
.cnb2api-badge[data-tone="active"] {
  border-color: var(--dsw-alias-state-success-primary);
  color: var(--dsw-alias-state-success-primary);
}
/* 可用性圆点：一眼看出哪些账号真能接住请求 */
.cnb2api-dot {
  flex: none; width: 8px; height: 8px; border-radius: 50%;
  background: var(--dsw-alias-state-success-primary);
}
.cnb2api-dot[data-usable="false"] { background: var(--dsw-alias-border-l3); }
/*
 * 当前在用的账号：靠「当前」徽标 + 加粗账号名表达。
 * 不铺整行底色（深色主题下 bg-layer-2 与卡片底几乎同色，像一块没对齐的污渍），
 * 也不放大圆点（同一列元素尺寸应一致）。
 */
.cnb2api-badge[data-tone="warn"] { border-color: var(--dsw-alias-state-warn-primary); color: var(--dsw-alias-state-warn-label); }
.cnb2api-badge[data-tone="error"] { border-color: var(--dsw-alias-state-error-primary); color: var(--dsw-alias-label-error); }
`;

    /** Inject the stylesheet once per page and remove it on teardown. */
    function useStyles(ctx) {
      ctx.effect(() => {
        const style = document.createElement('style');
        style.setAttribute('data-plugin', PACKAGE);
        style.textContent = CSS;
        document.head.appendChild(style);
        return () => style.remove();
      }, 'cnb2api styles');
    }

    // ---------------------------------------------------------------- panel

    /** Poll the Host snapshot while the panel is mounted. */
    function useSnapshot(enabled = true) {
      const [view, setView] = useState({ phase: 'loading', data: null, error: null });

      const read = useCallback(async () => {
        try {
          const response = await fetch('/cnb2api/status?probe=1', { headers: { accept: 'application/json' } });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          setView({ phase: 'ready', data, error: null });
        } catch (error) {
          setView((prev) => (prev.data
            ? { phase: 'stale', data: prev.data, error: String(error?.message || error) }
            : { phase: 'error', data: null, error: String(error?.message || error) }));
        }
      }, []);

      useEffect(() => {
        if (!enabled) return undefined;
        let live = true;
        const tick = () => { if (live) read(); };
        tick();
        const timer = setInterval(tick, POLL_MS);
        return () => { live = false; clearInterval(timer); };
      }, [read, enabled]);

      return { ...view, reload: read };
    }

    /**
     * 组织候选归一：优先用宿主给的 `orgDetails`（含每个组织的额度），
     * 退回纯名字数组（旧版宿主或测试桩）。
     * @param {object} body - 登录接口返回。
     * @returns {Array<{name: string, personal: boolean, credit: object|null}>} 候选。
     */
    function normalizeOrgs(body) {
      const details = Array.isArray(body?.orgDetails) ? body.orgDetails : null;
      if (details && details.length > 0) {
        return details.map((row) => ({
          name: String(row.name),
          personal: row.personal === true,
          credit: row.credit || null,
        }));
      }
      return (Array.isArray(body?.orgs) ? body.orgs : []).map((name) => ({
        name: String(name), personal: false, credit: null,
      }));
    }

    /**
     * 组织下拉的标签：标出「个人空间」并带上该组织的可用额度 ——
     * 不知道每个组织还剩多少额度，就没法判断该选哪个。
     * @param {object} org - 归一后的组织。
     * @param {object} t - 文案表。
     * @returns {string} 下拉标签。
     */
    function orgLabel(org, t) {
      const base = org.personal ? `${org.name} (${t.form.personal})` : org.name;
      const remain = Number(org.credit?.remain);
      const total = Number(org.credit?.total);
      // 额度字段缺失或是字符串垃圾时不要渲染出 NaN，退回「额度未知」
      if (!org.credit || !Number.isFinite(remain) || !Number.isFinite(total)) {
        return `${base} · ${t.form.quotaUnknown}`;
      }
      const lead = org.credit.exhausted ? t.panel.exhausted : t.panel.remaining;
      return `${base} · ${lead} ${formatNum(remain)}/${formatNum(total)} cr`;
    }

    /** One account row inside the panel. */
    function AccountRow({ account, t, onStart, busy, compact = false }) {
      /**
       * One quota meter: a labelled bar plus the numbers behind it.
       *
       * Numbers keep one decimal (dropped when whole) because real data has
       * `1166.04 / 1166` — rounding here would make the reading look impossible.
       */
      const meter = (label, ledger, unit) => {
        if (!ledger) return null;
        if (ledger.unavailable) {
          return h('div', { className: 'cnb2api-meter' },
            h('div', { className: 'cnb2api-meter-head' },
              h('span', { className: 'cnb2api-meter-label' }, label),
              h('span', { className: 'cnb2api-meter-none' }, ledger.unavailable)));
        }
        const show = (value) => {
          if (value === null || value === undefined) return '—';
          const rounded = Math.round(Number(value) * 10) / 10;
          return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
        };
        const total = Number(ledger.total) || 0;
        const used = Number(ledger.used) || 0;
        // 与 total/used 一样先强转：宿主若把百分比传成字符串，
        // Number.isFinite 会直接判为「无数据」，进度条静默归零。
        const percentRaw = Number(ledger.percent);
        const percent = Number.isFinite(percentRaw) ? Math.min(100, Math.max(0, percentRaw)) : null;
        const dead = ledger.exhausted;
        return h('div', { className: 'cnb2api-meter', 'data-dead': dead ? 'true' : undefined },
          h('div', { className: 'cnb2api-meter-head' },
            h('span', { className: 'cnb2api-meter-label' }, label),
            h('span', { className: 'cnb2api-meter-value' },
              dead ? h('span', { className: 'cnb2api-meter-dead' }, t.panel.exhausted + ' · ') : null,
              `${show(used)} / ${show(total)} ${unit}`),
            percent !== null
              ? h('span', { className: 'cnb2api-meter-pct' }, `${percent.toFixed(2)}%`)
              : null),
          h('div', {
            className: 'cnb2api-bar',
            role: 'progressbar',
            'aria-valuenow': percent === null ? 0 : Math.round(percent),
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-label': label,
            'data-dead': dead ? 'true' : undefined,
          },
            h('span', { className: 'cnb2api-bar-fill', style: { width: `${percent === null ? 0 : percent}%` } })),
          h('div', { className: 'cnb2api-meter-foot' },
            // 冻结是**预扣**：那一刻就已经不可用，停止后划进已用、不返还。
            // 所以只报 remain（它已经扣过冻结），再把冻结单独说明。
            h('span', { title: ledger.frozen > 0 ? t.panel.frozenHint : undefined },
              `${t.panel.remaining} ${show(ledger.remain)} ${unit}`
              + (ledger.frozen > 0 ? ` · ${t.panel.frozen} ${show(ledger.frozen)}` : '')),
            // 不再显示「天才程序员专属特权 +666」：赠送已计入 total，
            // 进度条和「可用」都包含它，再单独列一行只会让人算不清楚。
            null));
      };

      // remainingMs 缺失时不能拿 undefined 去算，否则 NaN 会让冷却徽标永不显示
      const coolingMs = Number(account.cooling?.remainingMs) || 0;
      const coolingLeft = coolingMs > 0 ? Math.ceil(coolingMs / 1000) : 0;
      return h('div', {
        className: 'cnb2api-row',
        'data-active': account.active ? 'true' : undefined,
        'data-usable': account.usable === false ? 'false' : 'true',
      },
        h('div', { className: 'cnb2api-rowhead' },
          // 可用性圆点：一眼看出谁能真的接住请求
          h('span', {
            className: 'cnb2api-dot',
            'data-usable': account.usable === false || account.belowFloor ? 'false' : 'true',
            title: account.belowFloor ? t.form.belowFloor
              : account.usable === false ? t.panel.unusable : t.panel.usable,
          }),
          h('span', { className: 'cnb2api-name', title: account.label }, account.label),
          // 「当前在用」保留：它说的是「现在走这个账号」，圆点只说「能不能用」，
          // 两句不同的话。但不必是绿框 —— 已有的绿圆点会把注意力带过去。
          account.active
            ? h('span', { className: 'cnb2api-badge', 'data-tone': 'active' }, t.panel.activeAccount)
            : null,
          // 「可用」不再单独出徽标：圆点已经说了。徽标只留给异常（冷却）。
          coolingLeft > 0
            ? h('span', {
              className: 'cnb2api-badge',
              'data-tone': 'warn',
              title: account.cooling.reason || '',
            }, `${t.panel.cooling} ${coolingLeft}s`)
            : null,
          // 低于保底线：明确告诉用户「不是坏了，是我们主动停的」
          account.belowFloor
            ? h('span', {
              className: 'cnb2api-badge',
              'data-tone': 'muted',
              title: t.form.creditFloorPercentHint,
            }, t.form.belowFloor)
            : null,
          // 状态徽标只在**异常**时出现：可用这件事圆点已经说了，
          // 再挂一个绿框「可用」是同一句话讲两遍，还把行挤满。
          // 低于保底线时也不挂：那是我们主动停的，不是它坏了 ——
          // 否则会同时出现「就绪」和「已停用」，自相矛盾。
          account.usable === false && !account.belowFloor
            ? h('span', {
              className: 'cnb2api-badge',
              'data-tone': account.state === 'misconfigured' ? 'error' : 'muted',
              title: account.note || '',
            }, t.badge[account.badge] || account.badge)
            : null,
          account.action === 'start'
            ? h('button', {
              className: 'cnb2api-btn',
              'data-v': 'outline',
              // 只要有按钮在忙就全禁：并发点两个账号会提交两次工作区创建
              disabled: !!busy,
              onClick: () => onStart(account.label),
            }, busy === account.label ? t.panel.starting : t.panel.start)
            : null),
        // 窄卡片（悬浮球）省掉工作区地址与状态两行：340px 宽放不下，
        // 而且球面要的是「哪个能用」，不是排查细节。
        !compact && account.detail ? h('div', { className: 'cnb2api-detail' }, account.detail) : null,
        compact ? null : h('div', { className: 'cnb2api-detail' }, t.state[account.state] || account.state),
        account.note ? h('p', { className: 'cnb2api-note' }, account.note) : null,
        // 唯一可用且余额低于 10% 时说一句：不然用户会在不知情时撞上额度用尽
        // 宿主渲染好的自定义文案优先；没配就用界面内置的默认句子。
        // 只在「当前」账号上提示：四个账号都低于线时逐行刷提示会把界面吵死，
        // 而真正相关的只有接住请求的那一个。
        account.active && account.lowCredit
          ? h('p', { className: 'cnb2api-note', 'data-tone': 'warn' },
            account.lowCreditText || t.panel.lowCredit)
          : null,
        // 额度条一律显示，用尽也显示：它是「还剩多少」唯一的图形化表达，
        // 缺了它四张卡的结构就参差不齐。
        compact
          ? meter(t.panel.credits, account.credit, 'cr')
          : h(Fragment, null,
            meter(t.panel.credits, account.credit, 'cr'),
            meter(t.panel.coreHours, account.coreHours, 'h')));
    }

    /** The workspace panel contributed to the plugin's own detail page. */
    /**
     * 复制按钮。网关基址和密钥要粘到别的客户端里，选中再复制很别扭。
     * @param {object} props - text 与 t。
     * @returns {object} 元素。
     */
    function CopyButton({ text, t }) {
      const [done, setDone] = useState(false);
      const timer = useRef(null);
      // 组件卸载后不能再 setState；连续点击也不能堆一串定时器
      useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
      return h('button', {
        type: 'button',
        className: 'cnb2api-btn',
        'data-v': 'outline',
        disabled: !text,
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(text);
            setDone(true);
            if (timer.current) clearTimeout(timer.current);
            timer.current = setTimeout(() => { setDone(false); timer.current = null; }, 1500);
          } catch {
            setDone(false);
          }
        },
      }, done ? t.panel.gatewayCopied : t.panel.gatewayCopy);
    }

    function StatusPanel() {
      const { phase, data, error, reload } = useSnapshot();
      const t = table(data?.locale);
      const [busy, setBusy] = useState(null);
      const [note, setNote] = useState(null);
      const [showGatewayKey, setShowGatewayKey] = useState(false);
      // 状态面板可折叠：默认展开，点箭头收成一行摘要（账号/可用/网关），
      // 需要看细节时再展开。
      const [open, setOpen] = useState(true);

      const start = async (label) => {
        setBusy(label);
        setNote(null);
        try {
          // fetch only rejects on transport failure, so a quota refusal (409) must
          // be read from the body — otherwise the UI would claim success.
          const response = await fetch(`/cnb2api/start?account=${encodeURIComponent(label)}`, { method: 'POST' });
          const body = await response.json().catch(() => ({}));
          if (!response.ok || body.ok === false) {
            setNote({ tone: 'error', text: `${t.panel.startFailed} · ${body.reason || `HTTP ${response.status}`}` });
          } else {
            setNote({ tone: 'ok', text: t.panel.started });
          }
        } catch (err) {
          setNote({ tone: 'error', text: `${t.panel.startFailed} · ${err?.message || err}` });
        } finally {
          setBusy(null);
          reload();
        }
      };

      /** 收起时的一行摘要：几个账号、几个可用、网关在哪。 */
      const brief = () => {
        if (!data) return t.panel.loading;
        const list = data.accounts || [];
        const usable = list.filter((a) => a.usable !== false && !a.belowFloor).length;
        const gw = data.gateway || {};
        const where = gw.baseUrl || '';
        return `${list.length} ${t.panel.accountsUnit} · ${usable} ${t.panel.usableUnit}`
          + (where ? ` · ${where}` : '');
      };
      // 加载/错误/未配置/网关未监听都必须把话说完，不能被收起
      const forcedOpen = phase !== 'ready' || !data?.configured || data?.gateway?.listening === false;
      const expanded = open || forcedOpen;
      const chrome = (children) => h('section', { className: 'cnb2api cnb2api-sec' },
        h('div', { className: 'cnb2api-head' },
          h('button', {
            type: 'button',
            className: 'cnb2api-btn cnb2api-btn-icon',
            // 强制展开（加载/错误/未配置/网关未监听）时禁用按钮，glyph 与 aria 跟随实际展开态，
            // 否则会出现「箭头显示已收起、内容却还展开」的矛盾
            title: expanded ? t.form.collapse : t.form.expand,
            'aria-expanded': expanded ? 'true' : 'false',
            disabled: forcedOpen,
            onClick: () => setOpen((prev) => !prev),
          }, expanded ? '▾' : '▸'),
          h('h3', { className: 'cnb2api-title' }, t.panel.title),
          h('button', { className: 'cnb2api-btn', onClick: reload }, t.panel.refresh)),
        expanded
          ? children
          : h('p', { className: 'cnb2api-note' }, brief()));

      if (phase === 'loading') return chrome(h('p', { className: 'cnb2api-note' }, t.panel.loading));
      if (phase === 'error') {
        return chrome(h('p', { className: 'cnb2api-note', 'data-tone': 'error' }, `${t.panel.failed} · ${error || ''}`));
      }
      if (!data?.configured) return chrome(h('p', { className: 'cnb2api-note' }, t.panel.empty));

      const list = data.accounts || [];
      const usableCount = list.filter((row) => row.usable !== false).length;
      // 只在「几乎没有选择」时才提：0 个是故障，1 个是脆弱，2 个以上属于正常。
      const summary = usableCount === 0
        ? t.panel.noneUsable
        : usableCount === 1 && list.length > 1
          ? t.panel.onlyOne
          : null;

      return chrome(h(Fragment, null,
        summary
          ? h('p', {
            className: 'cnb2api-note',
            'data-tone': usableCount === 0 ? 'error' : undefined,
          }, `${summary} · ${usableCount} / ${list.length}`)
          : null,
        list.map((account) => h(AccountRow, {
          key: account.label,
          account,
          t,
          busy,
          onStart: start,
        })),
        data.gateway
          ? h('div', { className: 'cnb2api-sec' },
            h('div', { className: 'cnb2api-head' },
              h('h3', { className: 'cnb2api-title' }, t.panel.gateway)),
            !data.gateway.listening
              ? h('p', { className: 'cnb2api-note', 'data-tone': 'error' }, t.panel.gatewayDown)
              : h(Fragment, null,
                h('div', { className: 'cnb2api-gwrow' },
                  h('span', { className: 'cnb2api-gwlabel' }, t.panel.gatewayBase),
                  h('code', { className: 'cnb2api-code' }, data.gateway.baseUrl || ''),
                  h(CopyButton, { text: data.gateway.baseUrl || '', t })),
                // 局域网地址由宿主 gateway.lan 给出；监听 127.0.0.1 时列表为空不显示
                // gateway.lan 已经是拼好的完整基址（http://<ip>:<port>/v1），直接显示
                ...(data.gateway.lanOnly && (data.gateway.lan || []).length > 0
                  ? data.gateway.lan.map((url, at) => h('div', {
                    className: 'cnb2api-gwrow', key: `lan-${at}`,
                  },
                    h('span', { className: 'cnb2api-gwlabel' }, t.panel.gatewayLan),
                    h('code', { className: 'cnb2api-code' }, url),
                    h(CopyButton, { text: url, t })))
                  : []),
                h('div', { className: 'cnb2api-gwrow' },
                  h('span', { className: 'cnb2api-gwlabel' }, t.panel.gatewayKey),
                  h('code', { className: 'cnb2api-code' },
                    showGatewayKey ? (data.gateway.key || '') : '••••••••••••'),
                  h('button', {
                    type: 'button',
                    className: 'cnb2api-btn',
                    'data-v': 'outline',
                    onClick: () => setShowGatewayKey((prev) => !prev),
                  }, showGatewayKey ? t.form.hide : t.form.show),
                  h(CopyButton, { text: data.gateway.key || '', t })),
                h('p', {
                  className: 'cnb2api-note',
                  'data-tone': data.published?.state === 'published' ? 'ok'
                    : data.published?.state === 'failed' ? 'error' : undefined,
                }, data.published?.state === 'published'
                  ? `${t.panel.gatewayPublishOn} · ${data.published.route || ''}`.trim()
                  : data.published?.state === 'failed'
                    ? `${t.panel.gatewayPublishFailed} · ${data.published.reason || ''}`
                    : t.panel.gatewayPublishOff),
                h('p', { className: 'cnb2api-hint' },
                  `${t.panel.gatewayRequests} ${data.gateway.requests || 0}`)))
          : null,
        phase === 'stale'
          ? h('p', { className: 'cnb2api-note', 'data-tone': 'error' }, `${t.panel.failed} · ${t.panel.stale}`)
          : null,
        note ? h('p', { className: 'cnb2api-note', 'data-tone': note.tone }, note.text) : null));
    }

    // ---------------------------------------------------------------- form

    /**
     * Number for display: one decimal at most, thousands grouped.
     * @param {number} value - raw number.
     * @returns {string} display text.
     */
    function formatNum(value) {
      const rounded = Math.round(Number(value) * 10) / 10;
      const text = Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
      const [whole, fraction] = text.split('.');
      const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return fraction ? `${grouped}.${fraction}` : grouped;
    }

    /**
     * 按变量渲染提醒文案，用于配置页的实时示例。
     *
     * 规则与宿主 `renderNotice` 一致：未知占位符**原样保留**，这样用户能看到
     * 自己写错的 `{remaim}`。两边都改时记得对齐。
     * @param {string} template - 文案模板。
     * @param {object} vars - 变量表。
     * @returns {string} 渲染结果。
     */
    function renderLowCredit(template, vars) {
      if (!template) return '';
      return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
        (Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole));
    }

    /** An empty account draft. Every field is optional here so typing is never blocked. */
    // 每行一个稳定 id：用数组下标当 React key 时，删掉第 0 行会让后一行
    // 复用它的组件实例，把上一个账号的用户名/组织/密钥校验结果显示到新行上。
    let draftSeq = 0;
    const nextDraftId = () => `d${(draftSeq += 1)}`;
    const blank = () => ({ _id: nextDraftId(), _isNew: true, token: '', repo: '', proxyKey: '', branch: '', port: '' });

    /** Normalize one stored account into a draft. */
    const toDraft = (raw) => ({
      _id: nextDraftId(),
      token: String(raw?.token ?? ''),
      repo: String(raw?.repo ?? ''),
      proxyKey: String(raw?.proxyKey ?? ''),
      branch: String(raw?.branch ?? ''),
      port: raw?.port === undefined || raw?.port === null ? '' : String(raw.port),
    });

    /**
     * Per-row validation. A repository used twice marks BOTH rows: the user decides
     * which one to change, so flagging only the later one would leave the first
     * looking correct.
     */
    function validate(rows) {
      const counts = new Map();
      for (const row of rows) {
        const repo = row.repo.trim().toLowerCase();
        if (repo) counts.set(repo, (counts.get(repo) || 0) + 1);
      }
      return rows.map((row) => {
        const repo = row.repo.trim().toLowerCase();
        return {
          token: !row.token.trim(),
          repoEmpty: !repo,
          repoDup: !!repo && (counts.get(repo) || 0) > 1,
          proxyKey: !row.proxyKey.trim(),
        };
      });
    }

    const anyBad = (problems) => problems.some((p) => p.token || p.repoEmpty || p.repoDup || p.proxyKey);

    /** Serialize drafts into the shape `Config.accounts` accepts. */
    function toAccounts(rows) {
      return rows.map((row) => {
        // 注意不要把界面用的 _id 写进配置
        const account = { token: row.token.trim(), repo: row.repo.trim(), proxyKey: row.proxyKey.trim() };
        if (row.branch.trim()) account.branch = row.branch.trim();
        const port = Number(row.port);
        if (Number.isFinite(port) && port > 0) account.port = port;
        return account;
      });
    }

    /** 由配置值构造表单里的 general 状态（字符串化，便于输入框绑定）。 */
    function generalFromValue(value = {}) {
      return {
        checkSeconds: String(Number(value.checkSeconds) || 120),
        autoStart: value.autoStart !== false,
        locale: String(value.locale || 'auto'),
        gatewayHost: String(value.gatewayHost || '0.0.0.0'),
        gatewayPort: String(Number(value.gatewayPort) || 41729),
        gatewayKey: String(value.gatewayKey || ''),
        autoPublish: value.autoPublish !== false,
        lowCreditPercent: String(Number(value.lowCreditPercent) || 5),
        lowCreditMessage: String(value.lowCreditMessage || ''),
        models: String(value.models || 'deepseek-v4.1-flash'),
        creditFloorPercent: String(value.creditFloorPercent == null ? 1 : Number(value.creditFloorPercent)),
      };
    }

    /** general 状态的持久化投影，与 save() 写入的字段一致：用来判断「有没有真的改动」。 */
    function projectGeneral(g) {
      if (!g) return null;
      return {
        checkSeconds: Number(g.checkSeconds) || 120,
        autoStart: g.autoStart !== false,
        locale: g.locale || 'auto',
        gatewayHost: g.gatewayHost || '0.0.0.0',
        gatewayPort: Number(g.gatewayPort) || 41729,
        gatewayKey: String(g.gatewayKey || ''),
        autoPublish: g.autoPublish !== false,
        lowCreditPercent: Number(g.lowCreditPercent) || 5,
        lowCreditMessage: String(g.lowCreditMessage || ''),
        models: String(g.models || '').trim(),
        creditFloorPercent: Number(g.creditFloorPercent) || 0,
      };
    }

    /** POST JSON to a Host route and return the parsed body (never throws on HTTP status). */
    async function postJson(path, payload) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      return { ok: response.ok && body.ok !== false, status: response.status, body };
    }

    /** A labelled `<select>`; one option per entry, with a placeholder while empty. */
    function Select({ label, hint, bad, value, options, placeholder, disabled, onChange, inputId, empty }) {
      return h('div', { className: 'cnb2api-field' },
        h('label', { className: 'cnb2api-label', htmlFor: inputId }, label),
        h('select', {
          id: inputId,
          className: 'cnb2api-input',
          value,
          disabled: disabled || options.length === 0,
          'aria-invalid': bad ? 'true' : undefined,
          onChange: (event) => onChange(event.target.value),
        },
          h('option', { value: '' }, options.length === 0 ? empty : placeholder),
          options.map((option) => h('option', {
            key: option.value,
            value: option.value,
          }, option.label))),
        hint ? h('span', { className: 'cnb2api-hint', 'data-bad': bad ? 'true' : undefined }, hint) : null);
    }

    /**
     * One account card.
     *
     * The order is the order of the facts: paste the token, prove it works, then
     * pick from what it can actually reach. Typing an org and a repo from memory
     * does not fail loudly — it silently attaches to whatever matches — so both
     * are chosen from live lists instead of typed.
     */
    function AccountCard({ index, row, problem, t, disabled, onChange, onRemove, onCancel, collapsed, onToggleCollapse }) {
      const id = (suffix) => `cnb2api-${index}-${suffix}`;
      const [more, setMore] = useState(false);
      const [confirming, setConfirming] = useState(false);
      // Login progress: idle → checking → ready (or failed with a message).
      const [auth, setAuth] = useState({ phase: row.repo ? 'ready' : 'idle', message: null, username: null });
      const [orgs, setOrgs] = useState([]);
      const [repos, setRepos] = useState([]);
      const [busy, setBusy] = useState(null);
      const [showKey, setShowKey] = useState(false);
      // PROXY_KEY 的验证结果：密钥填错在别处不会暴露，只能靠"问一次网关"
      const [keyCheck, setKeyCheck] = useState({ phase: 'idle', message: null });

      // Any edit withdraws the pending removal.
      useEffect(() => { setConfirming(false); }, [row.token, row.repo, row.proxyKey]);

      const org = String(row.repo || '').split('/')[0] || '';

      /** Step 1: prove the token, then load the organisations it can reach. */
      const signIn = async () => {
        setBusy('token');
        setAuth({ phase: 'checking', message: null, username: null });
        try {
          const { ok, body } = await postJson('/cnb2api/login/token', { token: row.token.trim() });
          if (!ok) {
            setAuth({ phase: 'failed', message: body.reason || t.form.tokenRejected, username: null });
            setOrgs([]);
            setRepos([]);
            return;
          }
          setAuth({ phase: 'ready', message: null, username: body.username });
          setOrgs(normalizeOrgs(body));
          // A repo already saved is kept; its org list just needs to include it.
          if (row.repo) await loadRepos(org);
        } catch (error) {
          setAuth({ phase: 'failed', message: String(error?.message || error), username: null });
        } finally {
          setBusy(null);
        }
      };

      /** Step 3: repositories of the chosen organisation. */
      const loadRepos = async (group) => {
        if (!group) {
          setRepos([]);
          return;
        }
        setBusy('repos');
        try {
          const { ok, body } = await postJson('/cnb2api/login/repos', { token: row.token.trim(), org: group });
          setRepos(ok ? (body.repos || []) : []);
        } catch {
          setRepos([]);
        } finally {
          setBusy(null);
        }
      };

      const signedIn = auth.phase === 'ready';
      // 已保存的账号一进来就是「已登录」态，但还没拉过组织列表；
      // 把它自己的组织补进选项，界面才不会是一片空的。
      const orgOptions = orgs.length > 0
        ? orgs
        : (org ? [{ name: org }] : []);
      const name = row.repo || `${t.form.title} ${index + 1}`;

      return h('div', {
        className: 'cnb2api-card',
        // 折叠靠 CSS 隐藏除卡片头以外的子元素：不用重排整段 body 的结构
        'data-collapsed': collapsed ? 'true' : undefined,
      },
        h('div', { className: 'cnb2api-cardhead' },
          h('button', {
            type: 'button',
            className: 'cnb2api-btn cnb2api-btn-icon cnb2api-chevron',
            'aria-expanded': collapsed ? 'false' : 'true',
            title: collapsed ? t.form.expand : t.form.collapse,
            onClick: onToggleCollapse,
          }, collapsed ? '▸' : '▾'),
          h('span', { className: 'cnb2api-cardname', title: name }, name),
          signedIn && auth.username
            ? h('span', { className: 'cnb2api-hint' }, auth.username)
            : null,
          confirming ? h('span', { className: 'cnb2api-hint' }, t.form.removeNote) : null,
          // 新加的行还没保存：给一个「取消」，点了直接丢掉，不用走两步移除确认
          row._isNew && typeof onCancel === 'function'
            ? h('button', {
              type: 'button',
              className: 'cnb2api-btn',
              'data-v': 'outline',
              disabled,
              onClick: onCancel,
            }, t.form.cancelAdd)
            : null,
          // 已保存的行才需要「移除」（两步确认，避免误删）
          row._isNew && typeof onCancel === 'function'
            ? null
            : h('button', {
              type: 'button',
              className: 'cnb2api-btn',
              'data-v': confirming ? 'danger' : undefined,
              disabled,
              onClick: () => (confirming ? onRemove() : setConfirming(true)),
            }, confirming ? t.form.removeConfirm : t.form.remove),
          confirming
            ? h('button', {
              type: 'button',
              className: 'cnb2api-btn',
              disabled,
              onClick: () => setConfirming(false),
            }, t.form.cancel)
            : null),

        // ---- step 1: token ----
        h('div', { className: 'cnb2api-field' },
          h('label', { className: 'cnb2api-label', htmlFor: id('token') }, t.form.token),
          h('span', { className: 'cnb2api-secret' },
            h('input', {
              id: id('token'),
              className: 'cnb2api-input',
              type: 'password',
              value: row.token,
              placeholder: 'nk…',
              disabled: disabled || busy === 'token',
              spellCheck: false,
              autoComplete: 'off',
              'aria-invalid': problem.token || auth.phase === 'failed' ? 'true' : undefined,
              onChange: (event) => {
                onChange({ token: event.target.value });
                // 令牌一改，之前的组织/仓库就不再可信
                setAuth({ phase: 'idle', message: null, username: null });
                setOrgs([]);
                setRepos([]);
              },
            }),
            h('button', {
              type: 'button',
              className: 'cnb2api-btn',
              'data-v': signedIn ? 'outline' : 'primary',
              disabled: disabled || busy === 'token' || !row.token.trim(),
              onClick: signIn,
            }, busy === 'token' ? t.form.signingIn : signedIn ? t.form.recheck : t.form.signIn)),
          h('span', {
            className: 'cnb2api-hint',
            'data-bad': auth.phase === 'failed' || problem.token ? 'true' : undefined,
          },
          auth.phase === 'failed'
            ? auth.message
            : problem.token
              ? t.form.needToken
              : signedIn
                ? t.form.signedIn
                : t.form.tokenHint)),

        // ---- step 2: organisation ----
        signedIn
          ? h(Select, {
            inputId: id('org'),
            label: t.form.org,
            hint: orgOptions.length === 0 ? t.form.noOrgs : t.form.orgHint,
            bad: false,
            value: org,
            empty: t.form.noOrgs,
            placeholder: t.form.pickOrg,
            // 只有「唯一候选且当前已选中」时才禁用；新账号 org 为空时仍要能选，
            // 否则单组织账号永远填不出仓库
            disabled: disabled || (orgOptions.length === 1 && org === orgOptions[0].name),
            options: orgOptions.map((item) => ({ value: item.name, label: orgLabel(item, t) })),
            onChange: (value) => {
              // 换组织就清掉仓库：旧仓库不属于新组织
              onChange({ repo: value });
              loadRepos(value);
            },
          })
          : null,

        // ---- step 3: repository ----
        signedIn && org
          ? h(Select, {
            inputId: id('repo'),
            label: t.form.repo,
            hint: problem.repoDup
              ? t.form.dupRepo
              : busy === 'repos'
                ? t.form.loadingRepos
                : repos.length === 0
                  ? t.form.noRepos
                  : t.form.repoHint,
            bad: problem.repoEmpty || problem.repoDup,
            value: row.repo,
            empty: t.form.noRepos,
            placeholder: t.form.pickRepo,
            disabled: disabled || busy === 'repos',
            options: repos.map((entry) => ({
              value: entry.repo,
              label: entry.running ? `${entry.repo} · ${t.form.running}` : entry.repo,
            })),
            onChange: (value) => onChange({ repo: value }),
          })
          : null,

        // ---- step 4: the repository's own key ----
        signedIn && org
          ? h('div', { className: 'cnb2api-field' },
            h('label', { className: 'cnb2api-label', htmlFor: id('proxyKey') }, t.form.proxyKey),
            h('span', { className: 'cnb2api-secret' },
              h('input', {
                id: id('proxyKey'),
                className: 'cnb2api-input',
                type: showKey ? 'text' : 'password',
                value: row.proxyKey,
                placeholder: 'sk-…',
                disabled,
                spellCheck: false,
                autoComplete: 'off',
                'aria-invalid': problem.proxyKey ? 'true' : undefined,
                onChange: (event) => onChange({ proxyKey: event.target.value }),
              }),
              h('button', {
                type: 'button',
                className: 'cnb2api-btn',
                disabled,
                'aria-pressed': showKey ? 'true' : 'false',
                // 40 位密钥靠肉眼核对是不可能的，给一个揭示开关
                onClick: () => setShowKey((prev) => !prev),
              }, showKey ? t.form.hide : t.form.show),
              h('button', {
                type: 'button',
                className: 'cnb2api-btn',
                'data-v': 'outline',
                disabled: disabled || keyCheck.phase === 'checking' || !row.proxyKey.trim(),
                onClick: async () => {
                  setKeyCheck({ phase: 'checking', message: null });
                  try {
                    const { body } = await postJson('/cnb2api/login/proxy-key', {
                      token: row.token.trim(), repo: row.repo.trim(), proxyKey: row.proxyKey.trim(),
                    });
                    setKeyCheck(body.ok
                      ? { phase: 'ok', message: t.form.keyOk }
                      : { phase: 'failed', message: body.reason || t.form.keyBad });
                  } catch (error) {
                    setKeyCheck({ phase: 'failed', message: String(error?.message || error) });
                  }
                },
              }, keyCheck.phase === 'checking' ? t.form.keyChecking : t.form.keyCheck)),
            h('span', {
              className: 'cnb2api-hint',
              'data-bad': problem.proxyKey || keyCheck.phase === 'failed' ? 'true' : undefined,
              'data-ok': keyCheck.phase === 'ok' ? 'true' : undefined,
            },
            keyCheck.phase === 'ok' || keyCheck.phase === 'failed'
              ? keyCheck.message
              : problem.proxyKey ? t.form.needProxyKey : t.form.proxyKeyHint))
          : null,

        signedIn
          ? h('div', null,
            h('button', {
              type: 'button',
              className: 'cnb2api-btn',
              onClick: () => setMore((prev) => !prev),
              'aria-expanded': more ? 'true' : 'false',
            }, t.form.more),
            more
              ? h(Fragment, null,
                h('div', { className: 'cnb2api-field' },
                  h('label', { className: 'cnb2api-label', htmlFor: id('branch') }, t.form.branch),
                  h('input', {
                    id: id('branch'),
                    className: 'cnb2api-input',
                    value: row.branch,
                    placeholder: 'main',
                    disabled,
                    onChange: (event) => onChange({ branch: event.target.value }),
                  }),
                  h('span', { className: 'cnb2api-hint' }, t.form.branchHint)),
                h('div', { className: 'cnb2api-field' },
                  h('label', { className: 'cnb2api-label', htmlFor: id('port') }, t.form.port),
                  h('input', {
                    id: id('port'),
                    className: 'cnb2api-input',
                    value: row.port,
                    placeholder: '9001',
                    disabled,
                    onChange: (event) => onChange({ port: event.target.value.replace(/[^\d]/g, '') }),
                  }),
                  h('span', { className: 'cnb2api-hint' }, t.form.portHint)))
              : null)
          : null);
    }

    /** The configuration form for this plugin row. */
    function ConfigForm({ form }) {
      const orb = useOrbVisibility();
      const [snapshot, setSnapshot] = useState(() => form.getSnapshot());
      const [rows, setRows] = useState(null);
      const [general, setGeneral] = useState(null);
      const t = table(general?.locale);
      // 折叠的账号卡（下标集合）。账号多时用「收起全部」把页面压短。
      const [folded, setFolded] = useState(() => new Set());
      const [dirty, setDirty] = useState(false);
      const [saving, setSaving] = useState(false);
      const [note, setNote] = useState(null);
      // 提示只显示在「用户刚点的那条保存栏」上，避免上下两条各显示一遍「已保存」
      const [noteBar, setNoteBar] = useState('top');
      // 密钥默认遮住：配置页可能被投屏或截图
      const [showGatewayKey, setShowGatewayKey] = useState(false);
      const seededAt = useRef(undefined);
      const dirtyRef = useRef(false);
      // 已保存配置的基线：取消新增行等操作后据此重算 dirty，避免假的「未保存」
      const baselineRef = useRef(null);
      dirtyRef.current = dirty;

      useEffect(() => {
        const unsubscribe = form.subscribe(() => setSnapshot(form.getSnapshot()));
        setSnapshot(form.getSnapshot());
        return unsubscribe;
      }, [form]);

      // Seed from the Host only when a new revision arrives, and never over
      // edits the user made while a save was in flight.
      useEffect(() => {
        if (snapshot.status !== 'ready' || snapshot.value === undefined) return;
        if (seededAt.current === snapshot.revision) return;
        seededAt.current = snapshot.revision;
        if (dirtyRef.current) {
          setNote({ tone: 'ok', text: t.form.unsaved });
          return;
        }
        const value = snapshot.value || {};
        const seeded = (Array.isArray(value.accounts) ? value.accounts : []).map(toDraft);
        setRows(seeded);
        // 已保存的账号默认收起；新添加的账号由「添加账号」按钮展开
        setFolded(new Set(seeded.map((item) => item._id)));
        const nextGeneral = generalFromValue(value);
        setGeneral(nextGeneral);
        // 记下已保存基线：取消新增行后可据此把 dirty 正确回落
        baselineRef.current = { accounts: toAccounts(seeded), general: projectGeneral(nextGeneral) };
        setDirty(false);
      }, [snapshot]);

      const edit = (index, patch) => {
        setRows((prev) => prev.map((row, at) => (at === index ? { ...row, ...patch } : row)));
        setDirty(true);
        setNote(null);
      };

      /** 取消新增行后，按「剩余草稿 vs 已保存基线」重算 dirty，避免假的「未保存」。 */
      const recomputeDirty = (nextRows) => {
        const base = baselineRef.current;
        if (!base || !general) return;
        const sameAccounts = JSON.stringify(toAccounts(nextRows)) === JSON.stringify(base.accounts);
        const sameGeneral = JSON.stringify(projectGeneral(general)) === JSON.stringify(base.general);
        setDirty(!(sameAccounts && sameGeneral));
      };

      const discard = () => {
        const value = form.getSnapshot().value || {};
        const seeded = (Array.isArray(value.accounts) ? value.accounts : []).map(toDraft);
        setRows(seeded);
        // 已保存的账号默认收起；新添加的账号由「添加账号」按钮展开
        setFolded(new Set(seeded.map((item) => item._id)));
        const nextGeneral = generalFromValue(value);
        setGeneral(nextGeneral);
        // 记下已保存基线：取消新增行后可据此把 dirty 正确回落
        baselineRef.current = { accounts: toAccounts(seeded), general: projectGeneral(nextGeneral) };
        setDirty(false);
        setNote(null);
      };

      if (snapshot.status === 'loading' || rows === null) {
        return h('div', { className: 'cnb2api' }, h('p', { className: 'cnb2api-note' }, t.form.loading));
      }
      if (snapshot.status === 'unavailable') {
        return h('div', { className: 'cnb2api' }, h('p', { className: 'cnb2api-note' }, t.form.readonly));
      }

      const problems = validate(rows);
      const intervalTooLow = Number(general.checkSeconds) > 0 && Number(general.checkSeconds) < 30;
      const port = Number(general.gatewayPort);
      const portBad = !(Number.isInteger(port) && port >= 1 && port <= 65535);
      const lowBad = !(Number(general.lowCreditPercent) >= 1 && Number(general.lowCreditPercent) <= 100);
      const modelsBad = String(general.models || '').trim().length === 0;
      const floor = Number(general.creditFloorPercent);
      const floorBad = !(Number.isFinite(floor) && floor >= 0 && floor <= 100);
      const blocked = anyBad(problems) || intervalTooLow || portBad || lowBad || floorBad || modelsBad;
      const writable = snapshot.writable && !saving;

      const save = async () => {
        if (blocked) return;
        setSaving(true);
        setNote(null);
        try {
          // One atomic write: the account list plus the general settings shown here.
          const accepted = await form.mutate([
            { op: 'set', path: ['accounts'], value: toAccounts(rows) },
            { op: 'set', path: ['checkSeconds'], value: Number(general.checkSeconds) || 120 },
            { op: 'set', path: ['autoStart'], value: general.autoStart !== false },
            { op: 'set', path: ['locale'], value: general.locale || 'auto' },
            { op: 'set', path: ['gatewayHost'], value: general.gatewayHost || '0.0.0.0' },
            { op: 'set', path: ['gatewayPort'], value: Number(general.gatewayPort) || 41729 },
            { op: 'set', path: ['gatewayKey'], value: String(general.gatewayKey || '') },
            { op: 'set', path: ['autoPublish'], value: general.autoPublish !== false },
            { op: 'set', path: ['lowCreditPercent'], value: Number(general.lowCreditPercent) || 5 },
            { op: 'set', path: ['lowCreditMessage'], value: String(general.lowCreditMessage || '') },
            { op: 'set', path: ['models'], value: String(general.models || '').trim() },
            { op: 'set', path: ['creditFloorPercent'], value: Number(general.creditFloorPercent) || 0 },
          ]);
          if (accepted) {
            // 保存成功后把草稿按已保存重建：否则新增行仍带 _isNew，
            // 界面上会显示「取消」（无两步确认）而不是「移除」。
            setRows((prev) => prev.map((row) => ({ ...row, _isNew: false })));
            // 同步把基线推到刚保存的状态：否则 seed effect 若因 dirty 时序被跳过，
            // 基线会停留在保存前，「保存后再加行又取消」会误报「未保存」。
            baselineRef.current = { accounts: toAccounts(rows), general: projectGeneral(general) };
            setDirty(false);
            setNote({ tone: 'ok', text: t.form.saved });
          } else {
            setNote({ tone: 'error', text: t.form.saveFailed });
          }
        } catch (error) {
          setNote({ tone: 'error', text: `${t.form.saveFailed} · ${error?.message || error}` });
        } finally {
          setSaving(false);
        }
      };

      // 「保存 / 撤销」和「添加账号」同一行：加完账号手就在这儿，不用再去页面底部找。
      // 底部（全局设置之后）还会再渲染一条相同的保存栏，方便改完下面的设置就近保存。
      // bar: 'top'（账号区）或 'bottom'（全局设置之后）。两条栏各渲染一次，
      // 但「已保存/失败」这类瞬时提示只出现在用户刚点的那一条上。
      const saveButtons = (bar) => [
        h('button', {
          type: 'button',
          className: 'cnb2api-btn',
          'data-v': 'primary',
          disabled: !writable || blocked || !dirty,
          onClick: () => { setNoteBar(bar); save(); },
        }, saving ? t.form.saving : t.form.save),
        h('button', {
          type: 'button',
          className: 'cnb2api-btn',
          'data-v': 'outline',
          disabled: !writable || !dirty,
          onClick: () => { setNoteBar(bar); discard(); },
        }, t.form.discard),
        // 被禁用时说明原因：否则用户只看到一个灰按钮，以为什么都没有（持续状态，两条都显示）
        blocked && writable ? h('span', { className: 'cnb2api-note' }, t.form.blockedHint) : null,
        note && noteBar === bar ? h('span', { className: 'cnb2api-note', 'data-tone': note.tone }, note.text) : null,
        !snapshot.writable ? h('span', { className: 'cnb2api-note' }, t.form.readonly) : null,
      ];

      return h('div', { className: 'cnb2api' },
        h('p', { className: 'cnb2api-note' }, t.form.intro),

        // 账号区：标题 + 计数，让人一眼看到「配了几个」
        h('div', { className: 'cnb2api-head' },
          h('h3', { className: 'cnb2api-title' }, t.form.accounts),
          h('span', { className: 'cnb2api-count' }, rows.length),
          rows.length > 1
            ? h('button', {
              type: 'button',
              className: 'cnb2api-btn',
              onClick: () => setFolded(
                folded.size >= rows.length ? new Set() : new Set(rows.map((row) => row._id)),
              ),
            }, folded.size >= rows.length ? t.form.expandAll : t.form.collapseAll)
            : null),

        rows.length === 0 ? h('div', { className: 'cnb2api-empty' }, t.form.empty) : null,
        rows.map((row, index) => h(AccountCard, {
          key: row._id,
          index,
          row,
          problem: problems[index],
          t,
          disabled: !writable,
          collapsed: folded.has(row._id),
          onToggleCollapse: () => setFolded((prev) => {
            const next = new Set(prev);
            if (next.has(row._id)) next.delete(row._id); else next.add(row._id);
            return next;
          }),
          onChange: (patch) => edit(index, patch),
          onCancel: () => {
            // 取消新增行：移除草稿后按基线重算 dirty（输入过内容也不该留下假的「未保存」）
            const nextRows = rows.filter((_, at) => at !== index);
            setRows(nextRows);
            setFolded((prev) => { const next = new Set(prev); next.delete(row._id); return next; });
            recomputeDirty(nextRows);
            setNote(null);
          },
          onRemove: () => {
            setRows((prev) => prev.filter((_, at) => at !== index));
            // 顺手把这一行从折叠集合里删掉，免得「展开全部/收起全部」的判断被幽灵 id 影响
            setFolded((prev) => { const next = new Set(prev); next.delete(row._id); return next; });
            setDirty(true);
            setNote(null);
          },
        })),
        h('div', { className: 'cnb2api-foot' },
          h('button', {
            type: 'button',
            className: 'cnb2api-btn',
            'data-v': 'outline',
            disabled: !writable,
            onClick: () => {
              const row = blank();
              setRows((prev) => [...prev, row]);
              // 新加的行一定展开，否则用户点「添加」看不到输入框
              setFolded((prev) => { const next = new Set(prev); next.delete(row._id); return next; });
              // 空行还没改任何配置，不点亮保存；填了内容由 edit() 置脏
              setNote(null);
            },
          }, t.form.add),
          ...saveButtons('top')),

        // 全局设置：行式布局（左标签、右控件），比纵向堆叠紧凑，也更容易扫读
        h('div', { className: 'cnb2api-sec' },
          h('div', { className: 'cnb2api-head' }, h('h3', { className: 'cnb2api-title' }, t.form.general)),

          h('div', { className: 'cnb2api-subhead' }, t.form.groupCheck),
          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-interval' }, t.form.checkSeconds),
              h('span', {
                className: 'cnb2api-hint',
                'data-bad': intervalTooLow ? 'true' : undefined,
              }, intervalTooLow ? t.form.intervalMin : t.form.intervalHint),
            ),
            h('input', {
              id: 'cnb2api-interval',
              className: 'cnb2api-input cnb2api-input-num',
              type: 'number',
              min: 30,
              step: 10,
              value: general.checkSeconds,
              disabled: !writable,
              'aria-invalid': intervalTooLow ? 'true' : undefined,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, checkSeconds: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            })),

          h('div', { className: 'cnb2api-subhead' }, t.form.groupGateway),
          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-host' }, t.form.gatewayHost),
              h('span', { className: 'cnb2api-hint' }, t.form.gatewayHostHint),
            ),
            h('select', {
              id: 'cnb2api-host',
              className: 'cnb2api-input cnb2api-input-host',
              value: general.gatewayHost,
              disabled: !writable,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, gatewayHost: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            },
            h('option', { value: '127.0.0.1' }, t.form.hostLocal),
            h('option', { value: '0.0.0.0' }, t.form.hostLan))),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-gwport' }, t.form.gatewayPort),
              h('span', {
                className: 'cnb2api-hint',
                'data-bad': portBad ? 'true' : undefined,
              }, portBad ? t.form.portBad : t.form.gatewayPortHint),
            ),
            h('input', {
              id: 'cnb2api-gwport',
              className: 'cnb2api-input cnb2api-input-num',
              type: 'number',
              min: 1024,
              max: 65535,
              step: 1,
              value: general.gatewayPort,
              disabled: !writable,
              'aria-invalid': portBad ? 'true' : undefined,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, gatewayPort: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            })),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-gwkey' }, t.form.gatewayKey),
              h('span', { className: 'cnb2api-hint' }, t.form.gatewayKeyHint),
            ),
            h('div', { className: 'cnb2api-keyrow' },
              h('input', {
                id: 'cnb2api-gwkey',
                className: 'cnb2api-input',
                type: showGatewayKey ? 'text' : 'password',
                value: general.gatewayKey,
                placeholder: 'sk-cnb-…',
                autoComplete: 'off',
                spellCheck: false,
                disabled: !writable,
                onChange: (event) => {
                  setGeneral((prev) => ({ ...prev, gatewayKey: event.target.value }));
                  setDirty(true);
                  setNote(null);
                },
              }),
              h('button', {
                type: 'button',
                className: 'cnb2api-btn',
                id: 'cnb2api-gwkey-toggle',
                'data-v': 'outline',
                disabled: !writable,
                onClick: () => setShowGatewayKey((prev) => !prev),
              }, showGatewayKey ? t.form.hide : t.form.show),
              h('button', {
                type: 'button',
                className: 'cnb2api-btn',
                'data-v': 'outline',
                disabled: !writable,
                onClick: () => {
                  // 生成放在浏览器侧：省一个接口，也不必信任宿主给的随机数
                  const bytes = new Uint8Array(18);
                  crypto.getRandomValues(bytes);
                  const text = btoa(String.fromCharCode(...bytes))
                    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
                  setGeneral((prev) => ({ ...prev, gatewayKey: `sk-cnb-${text}` }));
                  setDirty(true);
                  setNote(null);
                },
              }, t.form.gatewayRegenerate))),

          h('div', { className: 'cnb2api-subhead' }, t.form.groupCredit),
          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-floor' }, t.form.creditFloorPercent),
              h('span', {
                className: 'cnb2api-hint',
                'data-bad': floorBad ? 'true' : undefined,
              }, floorBad ? t.form.floorBad : t.form.creditFloorPercentHint),
            ),
            h('input', {
              id: 'cnb2api-floor',
              className: 'cnb2api-input cnb2api-input-num',
              type: 'number',
              min: 0,
              max: 100,
              step: 1,
              value: general.creditFloorPercent,
              disabled: !writable,
              'aria-invalid': floorBad ? 'true' : undefined,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, creditFloorPercent: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            })),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-low' }, t.form.lowCreditPercent),
              h('span', {
                className: 'cnb2api-hint',
                'data-bad': lowBad ? 'true' : undefined,
              }, lowBad ? t.form.lowCreditBad : t.form.lowCreditPercentHint),
            ),
            h('input', {
              id: 'cnb2api-low',
              className: 'cnb2api-input cnb2api-input-num',
              type: 'number',
              min: 1,
              max: 100,
              step: 1,
              value: general.lowCreditPercent,
              disabled: !writable,
              'aria-invalid': lowBad ? 'true' : undefined,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, lowCreditPercent: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            })),

          h('div', { className: 'cnb2api-setting cnb2api-setting-block' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-lowmsg' }, t.form.lowCreditMessage),
              h('span', { className: 'cnb2api-hint' }, t.form.lowCreditMessageHint),
            ),
            h('div', { className: 'cnb2api-stack' },
              h('input', {
                id: 'cnb2api-lowmsg',
                className: 'cnb2api-input cnb2api-input-block',
                type: 'text',
                value: general.lowCreditMessage,
                placeholder: t.panel.lowCredit,
                disabled: !writable,
                spellCheck: false,
                onChange: (event) => {
                  setGeneral((prev) => ({ ...prev, lowCreditMessage: event.target.value }));
                  setDirty(true);
                  setNote(null);
                },
              }),
              // 变量逐个说明：只列名字用户不知道怎么用
              h('div', { className: 'cnb2api-vars' },
                Object.entries(t.form.varLegend).map(([name, meaning]) =>
                  h('span', { className: 'cnb2api-var' },
                    h('code', null, `{${name}}`),
                    h('span', { className: 'cnb2api-var-desc' }, meaning)))),
              // 示例：用一组接近真实的数字渲染当前文案，边打边看效果
              h('div', { className: 'cnb2api-example' },
                h('span', { className: 'cnb2api-hint' }, `${t.form.lowCreditExample}：`),
                h('span', null, renderLowCredit(
                  general.lowCreditMessage || t.panel.lowCredit,
                  {
                    account: 'acme/gateway',
                    percent: '99.23',
                    used: '1157',
                    frozen: '0',
                    consumed: '1157',
                    remain: '9',
                    total: '1166',
                    threshold: String(general.lowCreditPercent || 5),
                    unit: 'cr',
                  },
                ))))),

          h('div', { className: 'cnb2api-subhead' }, t.form.groupOther),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-models' }, t.form.models),
              h('span', {
                className: 'cnb2api-hint',
                'data-bad': modelsBad ? 'true' : undefined,
              }, modelsBad ? t.form.modelsBad : t.form.modelsHint),
            ),
            h('input', {
              id: 'cnb2api-models',
              className: 'cnb2api-input cnb2api-input-wide',
              type: 'text',
              value: general.models,
              disabled: !writable,
              spellCheck: false,
              placeholder: 'deepseek-v4.1-flash',
              'aria-invalid': modelsBad ? 'true' : undefined,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, models: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            })),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-autopublish' }, t.form.autoPublish),
              h('span', { className: 'cnb2api-hint' }, t.form.autoPublishHint),
            ),
            h('input', {
              id: 'cnb2api-autopublish',
              type: 'checkbox',
              className: 'cnb2api-switch',
              role: 'switch',
              checked: general.autoPublish !== false,
              disabled: !writable,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, autoPublish: event.target.checked }));
                setDirty(true);
                setNote(null);
              },
            })),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-autostart' }, t.form.autoStart),
              h('span', { className: 'cnb2api-hint' }, t.form.autoStartHint),
            ),
            h('input', {
              id: 'cnb2api-autostart',
              type: 'checkbox',
              className: 'cnb2api-switch',
              role: 'switch',
              checked: general.autoStart !== false,
              disabled: !writable,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, autoStart: event.target.checked }));
                setDirty(true);
                setNote(null);
              },
            })),

          // 悬浮球开关：纯浏览器偏好，点了立刻生效，不走「保存」
          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-orb-show' }, t.form.orb),
              h('span', { className: 'cnb2api-hint' }, t.form.orbHint),
            ),
            h('input', {
              id: 'cnb2api-orb-show',
              type: 'checkbox',
              className: 'cnb2api-switch',
              role: 'switch',
              checked: orb.value,
              onChange: (event) => (event.target.checked ? orb.show() : orb.hide()),
            })),

          h('div', { className: 'cnb2api-setting' },
            h('div', { className: 'cnb2api-setting-main' },
              h('label', { className: 'cnb2api-setting-label', htmlFor: 'cnb2api-locale' }, t.form.locale),
              h('span', { className: 'cnb2api-hint' }, t.form.localeHint),
            ),
            h('select', {
              id: 'cnb2api-locale',
              className: 'cnb2api-input cnb2api-input-num',
              value: general.locale,
              disabled: !writable,
              onChange: (event) => {
                setGeneral((prev) => ({ ...prev, locale: event.target.value }));
                setDirty(true);
                setNote(null);
              },
            },
            h('option', { value: 'auto' }, t.form.localeAuto),
            h('option', { value: 'zh' }, '中文'),
            h('option', { value: 'en' }, 'English')))),

        // 全局设置底部也放一条保存栏：改完下面的设置就近保存，不用滚回顶部
        h('div', { className: 'cnb2api-foot' }, ...saveButtons('bottom')),

        h('p', { className: 'cnb2api-hint' }, t.form.secrets));
    }

    // ---------------------------------------------------------------- orb

    /** localStorage key of the orb visibility switch. */
    const ORB_VISIBLE_KEY = 'cnb2api:orb-visible';
    /** Same-tab change notification; `storage` events only fire across tabs. */
    const ORB_EVENT = 'cnb2api:orb-visible-change';

    /** Read the orb switch; absent means on. */
    function readOrbVisible() {
      try {
        return localStorage.getItem(ORB_VISIBLE_KEY) !== '0';
      } catch {
        return true;
      }
    }

    /** Write the orb switch and notify listeners in this tab. */
    function writeOrbVisible(visible) {
      try {
        localStorage.setItem(ORB_VISIBLE_KEY, visible ? '1' : '0');
      } catch { /* 存储不可用时只在本次会话生效 */ }
      window.dispatchEvent(new CustomEvent(ORB_EVENT, { detail: visible }));
    }

    /** Live orb visibility, shared by the orb and the form's switch. */
    function useOrbVisibility() {
      const [value, setValue] = useState(readOrbVisible);
      useEffect(() => {
        const sync = () => setValue(readOrbVisible());
        window.addEventListener(ORB_EVENT, sync);
        window.addEventListener('storage', sync);
        return () => {
          window.removeEventListener(ORB_EVENT, sync);
          window.removeEventListener('storage', sync);
        };
      }, []);
      return {
        value,
        show: () => { writeOrbVisible(true); setValue(true); },
        hide: () => { writeOrbVisible(false); setValue(false); },
      };
    }

    /** Where the orb sits when the user has not dragged it. */
    const ORB_POSITION_KEY = 'cnb2api:orb-v2';
    const ORB_SIZE = 44;
    const ORB_MARGIN = 16;

    /**
     * Keep a point inside the window, leaving room for the orb itself.
     * @param {{x: number, y: number}} point - requested top-left.
     * @returns {{x: number, y: number}} clamped point.
     */
    function clampOrb(point) {
      const width = window.innerWidth || 0;
      const height = window.innerHeight || 0;
      let x = Math.min(Math.max(ORB_MARGIN, point.x), Math.max(ORB_MARGIN, width - ORB_SIZE - ORB_MARGIN));
      let y = Math.min(Math.max(ORB_MARGIN, point.y), Math.max(ORB_MARGIN, height - ORB_SIZE - ORB_MARGIN));
      // 整条顶部都是标题栏/系统控制区（macOS 红黄绿、Windows 最小化/最大化/关闭）。
      // 球一旦进入，原生窗口会吞掉 pointer 事件 —— 表现为「球拖不动」，
      // 同时按钮也被挡住。所以不论横向在哪，只要落在顶部带就推到它下方。
      // 不依赖 UA 探测，跨平台一致。
      const TITLEBAR_H = 80;
      // 矮窗口时上界比标题栏还低，禁区不能把球推到窗口外
      const upper = Math.max(ORB_MARGIN, height - ORB_SIZE - ORB_MARGIN);
      const keepOut = Math.min(TITLEBAR_H + ORB_MARGIN, upper);
      if (y < keepOut) y = keepOut;
      // 落到整像素：半像素定位会让卡片的浅色小字在亮色下发虚
      return { x: Math.round(x), y: Math.round(y) };
    }

    /** Read the saved orb position, or the default (bottom-right). */
    function initialOrbPoint() {
      try {
        const saved = JSON.parse(localStorage.getItem(ORB_POSITION_KEY) || 'null');
        if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) return clampOrb(saved);
      } catch { /* 存储不可用就用默认位置 */ }
      return clampOrb({
        x: (window.innerWidth || 1200) - ORB_SIZE - ORB_MARGIN,
        y: (window.innerHeight || 800) - ORB_SIZE - ORB_MARGIN,
      });
    }

    /**
     * Ring progress used by the floating ball.
     *
     * The ball answers one question at a glance — "how much of the quota is
     * gone?" — so it shows a single arc rather than a number. The number stays
     * in the tooltip and in the expanded card, where there is room for it.
     *
     * Aggregates across accounts by summing used and total (quota is per
     * organisation, so several accounts in one org would double-count; the
     * result is labelled as an aggregate, never per account).
     * @param {object} props - ring props.
     * @returns {object} svg element.
     */
    function Ring({ percent, tone, size = 44 }) {
      const stroke = 4;
      // 半径留 1px：描边落在 viewBox 内不被裁掉半条
      const radius = (size - stroke) / 2 - 1;
      const circumference = 2 * Math.PI * radius;
      const clamped = Math.min(100, Math.max(0, Number(percent) || 0));
      const dash = (clamped / 100) * circumference;
      return h('svg', {
        width: size, height: size, viewBox: `0 0 ${size} ${size}`,
        className: 'cnb2api-ring', 'data-tone': tone, 'aria-hidden': 'true',
      },
        h('circle', {
          className: 'cnb2api-ring-track', cx: size / 2, cy: size / 2, r: radius,
          fill: 'none', strokeWidth: stroke,
        }),
        h('circle', {
          className: 'cnb2api-ring-fill', cx: size / 2, cy: size / 2, r: radius,
          fill: 'none', strokeWidth: stroke,
          // butt 端帽：避免 round 在小尺寸甩出圆头看着像画错一截
          strokeLinecap: 'butt',
          strokeDasharray: `${dash} ${circumference}`,
          transform: `rotate(-90 ${size / 2} ${size / 2})`,
        }));
    }

    /**
     * The floating ball.
     *
     * Lives in `shell.overlay`, the frame-wide layer above every column that is
     * click-through by default — so the orb opts back into pointer events and
     * never blocks the app underneath. It answers one question at a glance
     * ("is the gateway usable right now?") without opening the Plugins page.
     *
     * Drag: a pointer down that moves more than a few pixels is a drag and is
     * saved; a press that does not move is a click and opens the summary. The
     * threshold exists because a plain click also fires after a tiny drag.
     */
    function Orb({ onOpen }) {
      const visibility = useOrbVisibility();
      const visible = visibility.value;
      // 悬浮球收起时不再每 12 秒查一次状态：省请求，也让后台安静
      const { phase, data, reload } = useSnapshot(visible);
      const t = table(data?.locale);
      const [point, setPoint] = useState(initialOrbPoint);
      const pointRef = useRef(point);
      pointRef.current = point;
      // 拖动会话：防重入、记最后一帧位置、供卸载时清理监听
      const dragSession = useRef(null);
      const [open, setOpen] = useState(false);
      const [busy, setBusy] = useState(null);
      const [note, setNote] = useState(null);

      // 用户调整 DSH 窗口大小后，把球重新夹回可视区：否则停在旧坐标上，
      // 窗口缩小后球就跑到窗口外/被挡住，看不见也点不到。
      useEffect(() => {
        const onResize = () => setPoint((prev) => clampOrb(prev));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      if (!visible) return null;

      const accounts = data?.accounts || [];
      // 球面显示「最卡住的那一环」：异常 > 无额 > 掉线 > 停止 > 未知 > 可用
      const worst = ['misconfigured', 'noCredit', 'unreachable', 'stopped', 'absent', 'starting', 'unknown', 'ready']
        .find((state) => accounts.some((account) => account.state === state));
      const tone = !data?.configured ? 'error'
        : worst === 'ready' || worst === undefined ? 'ok'
          : worst === 'noCredit' || worst === 'starting' ? 'warn'
            : worst === 'misconfigured' ? 'error' : 'muted';
      const badgeText = !data?.configured ? t.badge.error : (t.badge[accounts.find((a) => a.state === worst)?.badge] || t.badge.unknown);

      // 总额度使用率：consumed（已用 + 冻结）对总额。
      // 冻结那一刻就已经不可用了，只算 used 会让球面严重低估消耗。
      // 只统计拿得到额度的账号；一个都没有时不画弧，也不谎报 0%。
      let consumed = 0;
      let total = 0;
      for (const account of accounts) {
        const credit = account.credit;
        if (!credit || credit.unavailable) continue;
        consumed += Number(credit.consumed ?? credit.used) || 0;
        total += Number(credit.total) || 0;
      }
      const percent = total > 0 ? Math.min(100, (consumed / total) * 100) : null;
      const tooltip = percent === null
        ? `${t.panel.title} · ${badgeText}`
        : `${t.orb.used} ${Math.floor(percent)}% · ${formatNum(consumed)} / ${formatNum(total)} cr`;

      const start = async (label) => {
        setBusy(label);
        setNote(null);
        try {
          const response = await fetch(`/cnb2api/start?account=${encodeURIComponent(label)}`, { method: 'POST' });
          const body = await response.json().catch(() => ({}));
          setNote(response.ok && body.ok !== false
            ? { tone: 'ok', text: t.panel.started }
            : { tone: 'error', text: `${t.panel.startFailed} · ${body.reason || `HTTP ${response.status}`}` });
        } catch (error) {
          setNote({ tone: 'error', text: `${t.panel.startFailed} · ${error?.message || error}` });
        } finally {
          setBusy(null);
          reload();
        }
      };

      // 拖动：在 document 上监听 move/up，而不是靠 setPointerCapture。
      // Electron 的自定义标题栏会吞掉 pointer capture，球一旦靠近顶部就再也收不到
      // move 事件 —— 表现为「拖不动、点不动」。全局监听不受此影响。
      // 把当前会话的全局监听一次性摘掉（重入/抬起/卸载共用）
      const detachDrag = () => {
        const session = dragSession.current;
        if (!session) return;
        document.removeEventListener('pointermove', session.onMove);
        document.removeEventListener('pointerup', session.onUp);
        document.removeEventListener('pointercancel', session.onUp);
        dragSession.current = null;
      };

      const onPointerDown = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        // 已有会话（双指/触摸+鼠标）先清掉旧的，避免两套监听互相 toggle 打开状态
        detachDrag();
        const origin = { ...pointRef.current };
        let last = origin;
        let moved = false;
        const onMove = (move) => {
          if (move.pointerId !== undefined && move.pointerId !== event.pointerId) return;
          const dx = move.clientX - event.clientX;
          const dy = move.clientY - event.clientY;
          if (!moved && Math.hypot(dx, dy) < 4) return;
          moved = true;
          last = clampOrb({ x: origin.x + dx, y: origin.y + dy });
          setPoint(last);
        };
        const onUp = (up) => {
          if (up && up.pointerId !== undefined && up.pointerId !== event.pointerId) return;
          detachDrag();
          if (moved) {
            // 落最后一帧，不依赖可能落后一帧的 pointRef
            try { localStorage.setItem(ORB_POSITION_KEY, JSON.stringify(last)); } catch { /* 忽略 */ }
          } else {
            setOpen((prev) => !prev);
          }
        };
        dragSession.current = { onMove, onUp };
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
      };

      // 组件在拖动中被卸载（插件重载/profile 切换）时兜底摘监听
      useEffect(() => () => detachDrag(), []);

      const style = { left: `${point.x}px`, top: `${point.y}px` };

      // 卡片弹出方向：按球在窗口里的位置选空间更大的一侧，避免贴边时弹到窗口外被遮挡。
      const CARD_GAP = 8;
      const CARD_W = 320;
      const viewportW = window.innerWidth || 1200;
      const viewportH = window.innerHeight || 800;
      const spaceRight = viewportW - (point.x + ORB_SIZE) - ORB_MARGIN;
      const spaceLeft = point.x - ORB_MARGIN;
      const spaceBelow = viewportH - (point.y + ORB_SIZE) - ORB_MARGIN;
      const spaceAbove = point.y - ORB_MARGIN;
      // 够宽就放右边；不够则在左右中选空间大的一边
      const cardRight = spaceRight >= CARD_W + CARD_GAP || spaceRight >= spaceLeft;
      // 够高就放下面；不够则在上下中选空间大的一边（向下优先，符合直觉）
      const cardBelow = spaceBelow >= viewportH * 0.6 || spaceBelow >= spaceAbove;
      const cardWidth = Math.max(240, Math.min(CARD_W, (cardRight ? spaceRight : spaceLeft) - CARD_GAP));
      const cardHeight = Math.max(180, Math.min(viewportH * 0.6,
        (cardBelow ? spaceBelow : spaceAbove) - CARD_GAP));
      const cardStyle = {
        left: cardRight ? `${ORB_SIZE + CARD_GAP}px` : 'auto',
        right: cardRight ? 'auto' : `${ORB_SIZE + CARD_GAP}px`,
        top: cardBelow ? `${ORB_SIZE + CARD_GAP}px` : 'auto',
        bottom: cardBelow ? 'auto' : `${ORB_SIZE + CARD_GAP}px`,
        width: `${cardWidth}px`,
        maxHeight: `${cardHeight}px`,
      };

      return h('div', { className: 'cnb2api-orb-wrap', style },
        h('button', {
          type: 'button',
          className: 'cnb2api-orb',
          'data-tone': tone,
          'aria-label': tooltip,
          'aria-expanded': open ? 'true' : 'false',
          title: tooltip,
          onPointerDown,
        },
          h(Ring, { percent: percent === null ? 0 : percent, tone, size: ORB_SIZE }),
          h('span', { className: 'cnb2api-orb-text' },
            // 球面只有 44px，两位小数塞不下也读不出。但也不能四舍五入 ——
            // 98.35 会进位成 100%，看起来像已经用尽。未到 100 一律向下取整。
            percent === null ? '—' : `${Math.floor(percent)}%`),
          h('span', { className: 'cnb2api-orb-dot', 'data-tone': tone })),

        open
          ? h('div', {
            className: 'cnb2api-orb-card', role: 'dialog', 'aria-label': t.panel.title,
            style: cardStyle,
          },
            h('div', { className: 'cnb2api-head' },
              h('h3', { className: 'cnb2api-title' }, t.panel.title),
              h('button', {
                className: 'cnb2api-btn cnb2api-btn-icon',
                title: t.panel.refresh,
                'aria-label': t.panel.refresh,
                onClick: reload,
              }, h('span', { className: 'cnb2api-icon', 'aria-hidden': 'true' }, '↻')),
              h('button', {
                className: 'cnb2api-btn cnb2api-btn-icon',
                title: t.orb.close,
                'aria-label': t.orb.close,
                onClick: () => setOpen(false),
              }, h('span', { className: 'cnb2api-icon', 'aria-hidden': 'true' }, '×'))),

            // 只有这一块滚动：标题栏和底部按钮都留在原地，
            // 否则滚到底就找不到关闭按钮了。
            h('div', { className: 'cnb2api-orb-list' },
              phase === 'error'
                ? h('p', { className: 'cnb2api-note', 'data-tone': 'error' }, `${t.panel.failed} · ${t.orb.openDetails}`)
                : !data?.configured
                  ? h('p', { className: 'cnb2api-note' }, t.panel.empty)
                  // 和插件页用同一个组件。之前这里是一份手写的重复实现，
                  // 结果它显示的分子是「可用」而不是「已用」（0 / 1166），
                  // 而且错过了后面几版的样式改动 —— 两套卡片必然走散。
                  : accounts.map((account) => h(AccountRow, {
                    key: account.label,
                    account,
                    t,
                    compact: true,
                    busy,
                    onStart: start,
                  })),
              note ? h('p', { className: 'cnb2api-note', 'data-tone': note.tone }, note.text) : null),
            h('button', {
              className: 'cnb2api-btn cnb2api-orb-open',
              'data-v': 'outline',
              onClick: onOpen,
            }, t.orb.openDetails))
          : null);
    }

    // ---------------------------------------------------------------- wiring

    return {
      inject: ['slots', 'configForms'],
      apply(ctx) {
        useStyles(ctx);

        /**
         * Switch the central panel through the layout service.
         *
         * Not a URL change: the settings and plugin pages are main panels inside one
         * page app, so assigning `location` leaves the app and shows a blank screen.
         * Optional: a profile without the layout service simply keeps the current
         * panel instead of navigating into nothing.
         * @param {string} panelId - registered main-panel key.
         */
        const openPanel = (panelId) => {
          const layout = ctx.get?.('layout') ?? ctx.layout;
          if (!layout?.selectPanel) {
            // 没有布局服务时不要假装成功：告诉用户自己去点哪里
            console.warn('[cnb2api] 这个 profile 没有 layout 服务，无法切换到插件页');
            return;
          }
          try {
            layout.selectPanel(panelId);
          } catch (error) {
            // 面板没注册（例如插件管理器未加载）时保持原地，不白屏；
            // 但要留下痕迹，否则"点了没反应"无从查起
            console.warn(`[cnb2api] 切换到 "${panelId}" 面板失败：${error?.message || error}`);
          }
        };

        // Workspace panel: only on our own bundle or row page. This slot is visible
        // on every plugin page, so anything else must render nothing.
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'cnb2api-status',
          order: 10,
        }, ({ subject }) => {
          if (subject?.kind !== 'bundle' && subject?.kind !== 'row') return null;
          if (subject.pkg?.name !== PACKAGE) return null;
          return h(StatusPanel, null);
        }));

        // Floating ball: frame-wide overlay, above every column. Entries here must
        // opt into pointer events themselves — the layer is click-through — so the
        // orb only ever covers its own 44px.
        //
        // The switch lives in `localStorage` rather than the Host config: it is a
        // per-browser display preference, and a Host round-trip would mean the orb
        // disappears a second after the click. The config form exposes the same
        // switch so it can be turned back on from the plugin page.
        // apply() 里不能调 hook（它不在任何组件的渲染期里）。订阅与状态都放进
        // Orb 内部，这里只给一个「点开后去哪」的回调。
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'cnb2api-orb',
          order: 20,
        }, () => h(Orb, {
          onOpen: () => openPanel('plugins'),
        })));

        // 配置只有一个入口：**插件详情页**（plugins.bundle.config，key = 包名）。
        //
        // 不再注册 plugins.row.config：那会把设置放进「包含的组件 → cnb2api」，
        // 用户得先进组件才能配；而且行标题会变成可点入口，多一套重复的表单。
        // 也不注册 plugins.detail.actions 的「配置」按钮：人都已经在详情页、
        // 表单就在眼前，再放一个按钮只会让人以为要跳转。
        const form = ctx.configForms.get(ENTRY);
        ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({
          name: 'plugins.bundle.config',
          key: PACKAGE,
        }, ({ view }) => (view === 'summary'
          ? table((form.getSnapshot?.()?.value || {}).locale).form.title
          : h(ConfigForm, { form }))));

      },
    };
  },
});
