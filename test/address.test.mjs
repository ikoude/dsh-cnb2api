// 地址与仓库：纯字符串变换。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fillPort, findGatewayUrl, findGatewayUrlInLog, hostOf, maskHost, maskUrl, orgOf, parseRepo } from '../lib/address.mjs';

test('模板端口会被替换成真实端口', () => {
  assert.equal(fillPort('https://abc-{{port}}.cnb.run', 9001), 'https://abc-9001.cnb.run');
  assert.equal(fillPort('https://abc-{{ PORT }}.cnb.run', 8080), 'https://abc-8080.cnb.run');
  assert.equal(fillPort('', 9001), null);
  assert.equal(fillPort(null, 9001), null);
});

test('从文本里认网关地址，且不会误认 cnb.cool 的控制台地址', () => {
  // 只取到主机，不带路径：调用方要的是网关根地址，自己拼 /v1
  assert.equal(findGatewayUrl('https://abc123-9001.cnb.run/v1', 9001), 'https://abc123-9001.cnb.run');
  // 详情接口返回的控制台地址不含 cnb.run 子域
  assert.equal(findGatewayUrl('https://cnb.cool/acme/gw/-/workspace/vscode-web/sn-001', 9001), null);
  assert.equal(findGatewayUrl('', 9001), null);
  assert.equal(findGatewayUrl(null, 9001), null);
});

test('日志里取最后一条地址（热重启会打印多次）', () => {
  const log = [
    'starting...',
    'PROXY_URI=https://first111-9001.cnb.run',
    'restart',
    'PROXY_URI="https://second22-9001.cnb.run"',
  ].join('\n');
  assert.equal(findGatewayUrlInLog(log, 9001), 'https://second22-9001.cnb.run');
});

test('日志里的模板端口也会被替换，且忽略不像网关的地址', () => {
  assert.equal(findGatewayUrlInLog('PROXY_URI=https://abc-{{port}}.cnb.run', 9001), 'https://abc-9001.cnb.run');
  assert.equal(findGatewayUrlInLog('PROXY_URI=https://not-a-gateway.example.com', 9001), null);
  assert.equal(findGatewayUrlInLog('no address here', 9001), null);
  assert.equal(findGatewayUrlInLog('', 9001), null);
});

test('主机名打码保留前四位、端口与域名', () => {
  assert.equal(maskHost('860lo2zlkf-9001.cnb.run'), '860l****-9001.cnb.run');
  assert.equal(maskHost('a.cnb.run'), 'a.cnb.run');
  assert.equal(maskHost(''), '');
  assert.equal(maskUrl('https://860lo2zlkf-9001.cnb.run/v1'), '860l****-9001.cnb.run');
  assert.equal(maskUrl(null), '');
  assert.equal(hostOf('https://860lo2zlkf-9001.cnb.run/v1'), '860lo2zlkf-9001.cnb.run');
});

test('仓库写法归一成 org/repo', () => {
  const cases = [
    ['https://cnb.cool/acme/gateway', 'acme/gateway'],
    ['https://cnb.cool/acme/gateway/-/tree/main', 'acme/gateway'],
    ['git@cnb.cool:acme/gateway.git', 'acme/gateway'],
    ['cnb.cool/acme/gateway', 'acme/gateway'],
    ['/acme/gateway', 'acme/gateway'],
    ['acme/gateway.git', 'acme/gateway'],
    ['gateway', 'gateway'],
    ['', ''],
    ['   ', ''],
  ];
  for (const [input, want] of cases) {
    assert.equal(parseRepo(input), want, `parseRepo(${JSON.stringify(input)})`);
  }
});

test('取组织名', () => {
  assert.equal(orgOf('acme/gateway'), 'acme');
  assert.equal(orgOf('acme/gateway/sub'), 'acme');
  assert.equal(orgOf('gateway'), '');
  assert.equal(orgOf(''), '');
});
