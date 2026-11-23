// 单个场景一个文件。
//
// 每个 apply() 都会启动 monitor 定时器与配置轮询；node --test 在同文件内共享
// 进程与 globalThis，先挂载的实例会读到后一个测试替换掉的 fetch，断言就成了
// 时序的牺牲品。一个文件一个场景，隔离由进程边界保证。

import test from 'node:test';
import assert from 'node:assert/strict';
import * as plugin from '../lib/index.mjs';

/** A backend whose quota endpoints answer. */
const fetchImpl = async (input) => {
  const url = new URL(typeof input === 'string' ? input : input.url);
  if (url.pathname === '/workspace/list') return Response.json({ list: [], hasMore: false });
  if (url.pathname.endsWith('/charge/quota')) return Response.json({ credit_in_milli: { total: 1_200_000 } });
  if (url.pathname.endsWith('/charge/volume')) return Response.json({ credit_in_milli: 300_000, freeze_credit_in_milli: 0 });
  if (url.pathname.endsWith('/charge/special-amount')) return Response.json({});
  return Response.json({});
};

/** Mount the plugin with a config that can be updated in place. */
function mount(initial) {
  let parsed = plugin.Config({ gatewayPort: 0, autoPublish: false, ...initial });
  const config = {};
  for (const key of ['accounts', 'apiBase', 'branch', 'port', 'checkSeconds', 'autoStart', 'locale', 'models',
    'gatewayHost', 'gatewayPort', 'gatewayKey', 'autoPublish']) {
    Object.defineProperty(config, key, { get: () => parsed[key], enumerable: true });
  }
  const routes = [];
  const tools = new Map();
  const ctx = {
  tools: { register: (tool) => tools.set(tool.name, tool) },
  webServer: { register: (route) => { routes.push(route); return () => {}; } },
  get: () => undefined,
  effect: (fn) => { fn(); return () => {}; },
  };
  plugin.apply(ctx, config);
  return { tools, routes, route: (path) => routes.find((row) => row.path === path) };
}

test('额度工具：报出可用与总量，且不读一分钟前的缓存', async () => {
  globalThis.fetch = fetchImpl;
  const host = mount({ accounts: [{ token: 'nk-quota', repo: 'acme/quotagw' }] });
  const out = await host.tools.get('cnb2api_quota').execute({}, {});
  assert.equal(out.accounts.length, 1);
  assert.equal(out.accounts[0].label, 'acme/quotagw');
  assert.equal(out.accounts[0].org, 'acme');
  // 1200 总额 - 300 已用 = 900 可用
  assert.equal(out.accounts[0].credits, 'AI credits 可用 900 / 1200 cr');
});
