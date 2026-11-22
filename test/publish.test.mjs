// 发布：把网关写成 DSH 官方的一个「自定义供应商」。
//
// 这里最容易出错的是「写谁」和「怎么写」：
// - 写别人的命名空间，整段替换会把用户自己配的供应商一起删掉；
// - 密钥必须进凭据库，不能落进配置文件。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CREDENTIAL_REF, PROVIDER_NS, ROUTE_API, ROUTE_ID, publish, routeProfile,
} from '../lib/publish.mjs';

/** 记录调用的设置服务桩。 */
function settingsStub({ refuse = null } = {}) {
  const calls = [];
  return {
    calls,
    async mutate(ns, ops, revision) {
      calls.push({ ns, ops, revision });
      if (refuse) throw new Error(refuse);
      return { ns };
    },
  };
}

/** 记录调用的凭据服务桩。 */
function credentialsStub({ refuse = null } = {}) {
  const stored = new Map();
  const unsetCalls = [];
  return {
    stored,
    unsetCalls,
    async set(ref, value) {
      if (refuse) throw new Error(refuse);
      stored.set(ref, value);
    },
    async unset(ref) { unsetCalls.push(ref); },
  };
}

test('路由配置：说 OpenAI 协议、基址、密钥引用、模型清单', () => {
  const profile = routeProfile({ baseURL: 'http://127.0.0.1:41729/v1', models: ['m1', 'm2'] });
  assert.equal(profile.api, ROUTE_API);
  assert.equal(profile.baseURL, 'http://127.0.0.1:41729/v1');
  assert.equal(profile.apiKeyEnv, CREDENTIAL_REF);
  assert.deepEqual(profile.models.map((row) => row.id), ['m1', 'm2']);
});

test('路由配置：不写容量，让 pi-ai 的 1M/128k 缺省生效', () => {
  // 自己填 128000 会把 DSH 的压缩阈值压到 54272（窗口 − 输出 − 65536），
  // 稍长的会话就开始压缩；pi-ai 缺省给的阈值是 800000，实际上不会触发。
  const profile = routeProfile({ baseURL: 'http://x/v1', models: ['m'] });
  assert.equal(profile.contextWindow, undefined);
  assert.equal(profile.defaultContextWindow, undefined);
  assert.equal(profile.models[0].contextWindow, undefined);
  assert.equal(profile.models[0].maxTokens, undefined);
});

test('发布：密钥进凭据库，配置里只留引用名', async () => {
  const settings = settingsStub();
  const credentials = credentialsStub();
  const result = await publish({
    settingsController: settings,
    credentials,
    profile: routeProfile({ baseURL: 'http://127.0.0.1:41729/v1', models: ['m'] }),
    key: 'sk-secret-value',
  });
  assert.equal(result.state, 'published');
  assert.equal(credentials.stored.get(CREDENTIAL_REF), 'sk-secret-value');
  const written = settings.calls[0].ops[0].value;
  assert.equal(written.apiKeyEnv, CREDENTIAL_REF);
  // 配置里不能出现明文密钥
  assert.equal(JSON.stringify(written).includes('sk-secret-value'), false);
});

test('发布：按路径写，不整段覆盖 providers', async () => {
  // providers 里还躺着用户自己配的供应商，整段替换会把它们全删掉。
  const settings = settingsStub();
  await publish({
    settingsController: settings,
    credentials: credentialsStub(),
    profile: routeProfile({ baseURL: 'http://x/v1', models: ['m'] }),
    key: 'sk-1',
  });
  const { ns, ops } = settings.calls[0];
  assert.equal(ns, PROVIDER_NS);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].op, 'set');
  assert.deepEqual(ops[0].path, ['providers', ROUTE_ID]);
});

test('发布：关掉开关时只删除自己那条，并清掉凭据', async () => {
  const settings = settingsStub();
  const credentials = credentialsStub();
  const result = await publish({
    settingsController: settings,
    credentials,
    profile: null,
  });
  assert.equal(result.state, 'removed');
  assert.deepEqual(settings.calls[0].ops, [{ op: 'unset', path: ['providers', ROUTE_ID] }]);
  assert.deepEqual(credentials.unsetCalls, [CREDENTIAL_REF], '撤回路由时不该留下没人引用的密钥');
});

test('发布：没有设置服务时说清楚只能手动填', async () => {
  const result = await publish({ settingsController: undefined, credentials: credentialsStub(), profile: { a: 1 }, key: 'k' });
  assert.equal(result.state, 'unsupported');
  assert.match(result.reason, /手动/);
});

test('发布：没有凭据服务时拒绝，不把密钥写进配置', async () => {
  const settings = settingsStub();
  const result = await publish({
    settingsController: settings,
    credentials: undefined,
    profile: routeProfile({ baseURL: 'http://x/v1', models: ['m'] }),
    key: 'sk-1',
  });
  assert.equal(result.state, 'unsupported');
  assert.equal(settings.calls.length, 0, '不能退而求其次写明文密钥');
});

test('发布：写入被拒时把原因原样交出来', async () => {
  const result = await publish({
    settingsController: settingsStub({ refuse: '这个 profile 不允许改写配置' }),
    credentials: credentialsStub(),
    profile: routeProfile({ baseURL: 'http://x/v1', models: ['m'] }),
    key: 'sk-1',
  });
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /不允许改写/);
});

test('发布：没有密钥就不写，免得留一条用不了的配置', async () => {
  const settings = settingsStub();
  const result = await publish({
    settingsController: settings,
    credentials: credentialsStub(),
    profile: routeProfile({ baseURL: 'http://x/v1', models: ['m'] }),
    key: '',
  });
  assert.equal(result.state, 'failed');
  assert.equal(settings.calls.length, 0);
});
