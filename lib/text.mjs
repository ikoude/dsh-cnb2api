// cnb2api · Host 侧的状态词
//
// 只有 agent 工具（cnb2api_status 等）会用到：把 `stateOf()` 的稳定状态码
// 翻成一句人话返回给 agent。界面文案在 ui/client.js 里各自维护，不共用这份。
// 语言由插件设置 `locale` 决定（auto/中文用 zh，显式 en 用 en）。

/** 各语言的状态词，键是 state.mjs 里的稳定状态码。 */
export const TEXT = {
  zh: {
    state: {
      ready: '就绪',
      noCredit: '额度用尽',
      unreachable: '地址不通',
      stopped: '已停止',
      absent: '无工作区',
      starting: '启动中',
      misconfigured: '配置有问题',
      unknown: '识别中',
    },
  },
  en: {
    state: {
      ready: 'Ready',
      noCredit: 'No credit',
      unreachable: 'Unreachable',
      stopped: 'Stopped',
      absent: 'No workspace',
      starting: 'Starting',
      misconfigured: 'Misconfigured',
      unknown: 'Checking',
    },
  },
};
