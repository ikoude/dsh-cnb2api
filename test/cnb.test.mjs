// CNB 客户端：请求、错误翻译、工作区筛选。
//
// 用假 fetch 打这一层：要验证的是「怎么发、怎么翻译错误、怎么筛」，
// 而不是真的连上 CNB。

import test from 'node:test';
import assert from 'node:assert/strict';
import { ScopeError, createClient, explainScopes, parseMissingScopes, REQUIRED_SCOPES } from '../lib/cnb.mjs';

/** 建一个按路径分发的假 fetch，并记录请求。 */
function fakeFetch(routes) {
  const seen = [];
  const impl = async (url, init = {}) => {
    const parsed = new URL(url);
    seen.push({ path: parsed.pathname, search: parsed.search, init, url });
    const handler = routes[parsed.pathname] || routes['*'];
    if (!handler) return new Response('not found', { status: 404 });
    return handler(parsed, init);
  };
  return { impl, seen };
}

test('带令牌发请求；路径拼接正确', async () => {
  const { impl, seen } = fakeFetch({ '/workspace/list': () => Response.json({ list: [] }) });
  const client = createClient({ fetch: impl, baseUrl: 'https://api.cnb.cool' });
  await client.request('nk-abc', '/workspace/list?page=1');
  assert.equal(seen[0].url, 'https://api.cnb.cool/workspace/list?page=1');
  assert.equal(seen[0].init.headers.Authorization, 'Bearer nk-abc');
});

test('没有令牌时直接失败，不发请求', async () => {
  const { impl, seen } = fakeFetch({});
  const client = createClient({ fetch: impl });
  await assert.rejects(() => client.request('', '/workspace/list'), /令牌/);
  assert.equal(seen.length, 0);
});

test('403 带 Missing scopes 抛 ScopeError，并说清后果', async () => {
  const { impl } = fakeFetch({
    '/workspace/list': () => new Response('Missing required scopes: repo-cnb-trigger:r', { status: 403 }),
  });
  const client = createClient({ fetch: impl });
  await assert.rejects(
    () => client.request('nk', '/workspace/list'),
    (error) => {
      assert.ok(error instanceof ScopeError);
      assert.deepEqual([...error.scopes], ['repo-cnb-trigger:r']);
      assert.match(error.message, /取不到地址/);
      return true;
    },
  );
});

test('403 但不是权限报文时不当作缺权限', async () => {
  const { impl } = fakeFetch({
    '/x': () => new Response('forbidden by policy', { status: 403 }),
  });
  const client = createClient({ fetch: impl });
  await assert.rejects(
    () => client.request('nk', '/x'),
    (error) => {
      assert.equal(error.permission, undefined);
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test('scope 报文解析与解释', () => {
  assert.deepEqual(parseMissingScopes('Missing required scopes: a, b'), ['a', 'b']);
  assert.equal(parseMissingScopes('other error'), null);
  assert.match(explainScopes(['group-resource:r']), /不显示额度/);
  assert.match(explainScopes(['unknown:scope']), /unknown:scope/);
  assert.ok(REQUIRED_SCOPES.includes('repo-cnb-trigger:r'));
});

test('错误翻译成人话', () => {
  const client = createClient({ fetch: async () => new Response('', { status: 500 }) });
  assert.match(client.describe({ status: 401 }), /令牌无效/);
  assert.match(client.describe({ status: 404 }), /不存在/);
  assert.match(client.describe(new Error('The operation was aborted')), /超时/);
  assert.equal(client.describe(new Error('boom')), 'boom');
});

test('工作区列表拉全量，本地按仓库筛', async () => {
  const rows = [
    { sn: 'a', status: 'running', slug: 'acme/gateway' },
    { sn: 'b', status: 'closed', slug: 'acme/other' },
    { sn: 'c', status: 'closed', repo_url: 'https://cnb.cool/acme/gateway.git' },
  ];
  const { impl, seen } = fakeFetch({ '/workspace/list': () => Response.json({ list: rows, hasMore: false }) });
  const client = createClient({ fetch: impl });

  const mine = await client.listWorkspaces('nk', 'acme/gateway');
  // 不带 slug 参数：服务端那个过滤会漏掉已停止的记录
  assert.ok(!seen[0].search.includes('slug'), '不该把 repo 作为 slug 传给服务端');
  assert.deepEqual(mine.map((row) => row.sn), ['a', 'c']);
});

test('仓库归属：slug 优先，缺了退回 repo_url', () => {
  const client = createClient({ fetch: async () => new Response('{}') });
  assert.equal(client.repoOfRecord({ slug: 'acme/gw' }), 'acme/gw');
  assert.equal(client.repoOfRecord({ repo_url: 'https://cnb.cool/acme/gw.git' }), 'acme/gw');
  assert.equal(client.repoOfRecord({}), '');
});

test('挑工作区：优先 running，其次最新', async () => {
  const rows = [
    { sn: 'old', status: 'closed', slug: 'acme/gateway', create_time: '2026-01-01T00:00:00Z' },
    { sn: 'new', status: 'closed', slug: 'acme/gateway', create_time: '2026-03-01T00:00:00Z' },
    { sn: 'run', status: 'running', slug: 'acme/gateway', create_time: '2026-02-01T00:00:00Z' },
  ];
  const { impl } = fakeFetch({ '/workspace/list': () => Response.json({ list: rows, hasMore: false }) });
  const client = createClient({ fetch: impl });
  assert.equal((await client.pickWorkspace('nk', 'acme/gateway')).sn, 'run');

  const { impl: impl2 } = fakeFetch({
    '/workspace/list': () => Response.json({
      list: rows.filter((row) => row.status !== 'running'),
      hasMore: false,
    }),
  });
  const client2 = createClient({ fetch: impl2 });
  assert.equal((await client2.pickWorkspace('nk', 'acme/gateway')).sn, 'new', '全停了就取最新的');
});

test('仓库存在性：只有 404 才判否，403 说明仓库在', async () => {
  const make = (status) => createClient({
    fetch: async () => new Response('', { status }),
  });
  assert.equal(await make(200).repoExists('nk', 'acme/gw'), true);
  assert.equal(await make(403).repoExists('nk', 'acme/gw'), true, '403 说明仓库在、只是看不了详情');
  assert.equal(await make(404).repoExists('nk', 'acme/gw'), false);
});

test('地址优先取详情，取不到再读日志', async () => {
  const { impl, seen } = fakeFetch({
    '/acme/gw/-/workspace/detail/sn-1': () => new Response('{}', { status: 404 }),
    '/acme/gw/-/build/runner/download/log/sn-1-001': () =>
      new Response('PROXY_URI=https://fromlog12-9001.cnb.run'),
  });
  const client = createClient({ fetch: impl });
  const url = await client.resolveUrl('nk', 'acme/gw', 'sn-1', 9001);
  assert.equal(url, 'https://fromlog12-9001.cnb.run');
  assert.equal(seen.length, 2, '详情失败后应回退到日志');
});

test('读日志缺权限必须冒泡，不能吞成「取不到地址」', async () => {
  const { impl } = fakeFetch({
    '/acme/gw/-/build/runner/download/log/sn-1-001': () =>
      new Response('Missing required scopes: repo-cnb-trigger:r', { status: 403 }),
  });
  const client = createClient({ fetch: impl });
  await assert.rejects(
    () => client.urlFromLog('nk', 'acme/gw', 'sn-1', 9001),
    (error) => error instanceof ScopeError,
  );
});

test('健康检查：200 且带 status:ok 才算通', async () => {
  const make = (status, body) => createClient({ fetch: async () => new Response(body, { status }) });
  assert.equal(await make(200, '{"status":"ok"}').healthy('https://x'), true);
  assert.equal(await make(200, '{"status":"starting"}').healthy('https://x'), false);
  assert.equal(await make(503, '{"status":"ok"}').healthy('https://x'), false);
  assert.equal(await createClient({ fetch: async () => { throw new Error('nope'); } }).healthy('https://x'), false);
});

test('额度：三个接口并行，部分失败保留其余', async () => {
  const { impl } = fakeFetch({
    '/acme/-/charge/quota': () => Response.json({ credit_in_milli: { total: 900_000 } }),
    '/acme/-/charge/volume': () => new Response('', { status: 500 }),
    '/acme/-/charge/special-amount': () => Response.json({}),
  });
  const client = createClient({ fetch: impl });
  const out = await client.readQuota('nk', 'acme');
  assert.equal(out.quota.credit_in_milli.total, 900_000);
  assert.equal(out.volume, null);
  assert.equal(out.failures.length, 1);
});

test('identity 接口拿不到时返回 null，不抛', async () => {
  const client = createClient({ fetch: async () => new Response('', { status: 401 }) });
  assert.equal(await client.whoAmI('nk'), null);
});

test('工作区分页兼容 has_more 字段，不会只取第一页', async () => {
  // 上游字段名 hasMore / has_more 都见过；只认 hasMore 会在改名后静默截断，
  // 进而漏掉 running 记录、选错工作区。
  let page = 0;
  const impl = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url);
    page += 1;
    const list = page === 1
      ? Array.from({ length: 100 }, (_, i) => ({ sn: `sn-${i}`, status: 'closed', slug: 'acme/gateway' }))
      : [{ sn: 'sn-last', status: 'running', slug: 'acme/target' }];
    return Response.json({ list, has_more: page < 2 });
  };
  const client = createClient({ baseUrl: 'https://api.example', fetch: impl });
  const rows = await client.listWorkspaces('nk', 'acme/target');
  assert.equal(rows.length, 1, '第二页的记录要能读到');
  assert.equal(rows[0].sn, 'sn-last');
});
