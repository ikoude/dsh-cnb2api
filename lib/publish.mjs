/**
 * 把网关发布成 DSH 官方的一个「自定义供应商」。
 *
 * DSH 的协议层（`@deepseek-ai/dsh-llm-pi-ai`）本来就实现了 OpenAI 兼容供应商，
 * 包含请求/流翻译、图片编码、用量、重试、上下文预算。插件自己再写一遍适配器，
 * 等于把同一件事做第二遍 —— 而且 DSH 的每条隐性要求漏一个就是用户可见的故障。
 *
 * 所以这里只做一件事：把「固定基址 + 密钥 + 模型清单」写进官方那条配置，
 * 让官方实现去干活。
 *
 * @module dsh-cnb2api/publish
 */

/** 写进 `providers` 字典时用的路由名。 */
export const ROUTE_ID = 'cnb-gateway';
/** 凭据引用名：密钥存凭据库，配置文件里只留这个名字。 */
export const CREDENTIAL_REF = 'CNB2API_GATEWAY_KEY';
/** 供应商配置所在的设置命名空间（profile 里那一行的 id）。 */
export const PROVIDER_NS = 'llm-pi-ai';
/** 网关说 OpenAI 的 chat completions 协议。 */
export const ROUTE_API = 'openai-completions';

/**
 * 一条路由的配置。
 *
 * **不写 contextWindow / maxTokens**：pi-ai 的缺省是 1,000,000 / 128,000，
 * DSH 据此算出的压缩阈值是 800,000 —— 也就是实际上不会触发压缩。自己填
 * 128,000 反而会把阈值压到 54,272（`窗口 − 输出 − 65536`），稍长的会话就
 * 开始压缩，压缩区间太小还会失败。真实容量交给用户在官方卡片里改。
 * @param {object} input - 参数。
 * @param {string} input.baseURL - 形如 `http://127.0.0.1:41729/v1`。
 * @param {string[]} input.models - 模型 id。
 * @param {string} [input.displayName] - 显示名。
 * @returns {object} pi-ai 的 provider profile。
 */
export function routeProfile({ baseURL, models, displayName = 'CNB2API' }) {
  return {
    displayName,
    api: ROUTE_API,
    baseURL,
    apiKeyEnv: CREDENTIAL_REF,
    models: models.map((id) => ({ id, name: id })),
  };
}

/**
 * 写入或清除发布的那条路由。
 *
 * 用**按路径写**，不用整段覆盖：`providers` 里还躺着用户自己配的供应商，
 * 整段替换会把它们全删掉。
 * @param {object} deps - 依赖。
 * @param {object} deps.settingsController - DSH 的设置服务。
 * @param {object} deps.credentials - 凭据服务。
 * @param {object|null} deps.profile - 要写入的路由配置；`null` 表示清除。
 * @param {string} [deps.key] - 访问密钥（`profile` 非空时必填）。
 * @returns {Promise<object>} 发布结果。
 */
export async function publish({ settingsController, credentials, profile, key }) {
  if (!settingsController || typeof settingsController.mutate !== 'function') {
    return {
      state: 'unsupported',
      reason: '这个 profile 没有设置服务 · 只能手动填写供应商',
    };
  }
  try {
    if (profile === null) {
      await settingsController.mutate(
        PROVIDER_NS,
        [{ op: 'unset', path: ['providers', ROUTE_ID] }],
        undefined,
      );
      // 一起把凭据删掉：留着一条没人引用的密钥既无意义，也多一处泄漏面。
      // 没有凭据服务时忽略（本来也没写过）。
      if (credentials && typeof credentials.unset === 'function') {
        try { await credentials.unset(CREDENTIAL_REF); } catch { /* 删不掉不影响撤回路由 */ }
      }
      return { state: 'removed' };
    }

    // 密钥进凭据库，不进配置文件
    if (!credentials || typeof credentials.set !== 'function') {
      return {
        state: 'unsupported',
        reason: '这个 profile 没有凭据服务 · 无法安全保存密钥，请手动填写',
      };
    }
    if (!key) {
      return { state: 'failed', reason: '网关还没生成访问密钥' };
    }
    await credentials.set(CREDENTIAL_REF, key);

    await settingsController.mutate(
      PROVIDER_NS,
      [{ op: 'set', path: ['providers', ROUTE_ID], value: profile }],
      undefined,
    );
    return { state: 'published', route: ROUTE_ID, baseURL: profile.baseURL };
  } catch (error) {
    return {
      state: 'failed',
      reason: String(error?.message || error),
    };
  }
}
