// 备份与还原：打包、口令加解密、合并策略。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BACKUP_FORMAT, SCOPE, buildBackup, mergeAccounts, parseBackup } from '../lib/backup.mjs';
import { davTarget } from '../lib/webdav.mjs';

const ACCOUNTS = [
  { token: 'nk-a', repo: 'acme/gateway', proxyKey: 'sk-a', branch: 'main', port: 9001 },
  { token: 'nk-b', repo: 'beta/gateway', proxyKey: 'sk-b' },
];
const SETTINGS = { checkSeconds: 120, gatewayPort: 41729, models: 'deepseek-v4.1-flash', autoStart: true, gatewayKey: 'sk-cnb-secret' };

test('明文备份：可往返，且只带白名单字段', () => {
  const doc = buildBackup({ scope: SCOPE.all, accounts: ACCOUNTS, settings: SETTINGS });
  assert.equal(doc.format, BACKUP_FORMAT);
  assert.equal(doc.encrypted, false);
  assert.equal(doc.data.accounts.length, 2);
  // 网关密钥不进备份
  assert.equal('gatewayKey' in doc.data.settings, false);
  const parsed = parseBackup(JSON.stringify(doc));
  assert.equal(parsed.accounts[0].repo, 'acme/gateway');
  assert.equal(parsed.settings.gatewayPort, 41729);
});

test('加密备份：口令正确才解得开，口令错报明确错误', () => {
  const doc = buildBackup({ scope: SCOPE.accounts, accounts: ACCOUNTS, password: 'hunter2' });
  assert.equal(doc.encrypted, true);
  // 密文里不能出现明文令牌
  assert.equal(JSON.stringify(doc.data).includes('nk-a'), false);
  const parsed = parseBackup(JSON.stringify(doc), 'hunter2');
  assert.equal(parsed.accounts.length, 2);
  assert.throws(() => parseBackup(JSON.stringify(doc), 'wrong'), /口令不对/);
  assert.throws(() => parseBackup(JSON.stringify(doc)), /需要口令/);
});

test('范围选择：只账号 / 只设置 / 两者', () => {
  const onlyAccounts = parseBackup(buildBackup({ scope: SCOPE.accounts, accounts: ACCOUNTS, settings: SETTINGS }));
  assert.deepEqual(Object.keys(onlyAccounts.settings), []);
  const onlySettings = parseBackup(buildBackup({ scope: SCOPE.settings, settings: SETTINGS }));
  assert.equal(onlySettings.accounts.length, 0);
  assert.equal(onlySettings.settings.checkSeconds, 120);
});

test('拒绝非备份文件与更高版本', () => {
  assert.throws(() => parseBackup('{"hello":1}'), /不是 cnb2api 的备份文件/);
  assert.throws(() => parseBackup('not json'), /需要 cnb2api 导出的 JSON/);
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 99 })), /比当前插件新/);
});

test('合并：同仓库覆盖、新仓库追加、现有未涉及保留', () => {
  const existing = [
    { token: 'old-1', repo: 'acme/gateway', proxyKey: 'sk-old' },
    { token: 'keep', repo: 'keep/gateway' },
  ];
  const incoming = [
    { token: 'new-1', repo: 'acme/gateway', proxyKey: 'sk-new' },
    { token: 'new-2', repo: 'beta/gateway' },
  ];
  const out = mergeAccounts(existing, incoming);
  assert.equal(out.added, 1);
  assert.equal(out.replaced, 1);
  assert.equal(out.accounts.length, 3, '现有未涉及的账号要保留');
  assert.equal(out.accounts.find((r) => r.repo === 'acme/gateway').token, 'new-1');
  assert.equal(out.accounts.some((r) => r.repo === 'keep/gateway'), true);
});

test('合并按仓库名大小写不敏感去重', () => {
  const out = mergeAccounts([{ token: 'a', repo: 'Acme/Gateway' }], [{ token: 'b', repo: 'acme/gateway' }]);
  assert.equal(out.accounts.length, 1);
  assert.equal(out.replaced, 1);
});

test('WebDAV 目标地址：目录补文件名，拒绝非 http 协议', () => {
  assert.equal(davTarget('https://dav.example.com/backups/'), 'https://dav.example.com/backups/cnb2api-backup.json');
  assert.equal(davTarget('https://dav.example.com/backups/my.json'), 'https://dav.example.com/backups/my.json');
  assert.throws(() => davTarget('ftp://x/y'), /只支持 http/);
  assert.throws(() => davTarget(''), /先填 WebDAV 地址/);
});

test('畸形输入不崩：空条目、非对象设置、缺版本、非法 scope', () => {
  assert.equal(buildBackup({ scope: SCOPE.all, accounts: [null, 3, {}], settings: null }).data.accounts.length, 0);
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT })), /缺少版本号/);
  assert.throws(() => parseBackup(JSON.stringify({ format: BACKUP_FORMAT, version: 'x' })), /不是数字/);
  assert.throws(() => parseBackup(JSON.stringify({
    format: BACKUP_FORMAT, version: 1, scope: 'bogus',
    data: { accounts: [{ token: 'a', repo: 'a/b' }] },
  })), /范围 .* 不认识/);
  // 原型键不能绕过范围校验：不会被当成 SCOPE 里的值
  assert.equal(buildBackup({ scope: 'constructor', accounts: ACCOUNTS }).scope, SCOPE.all);
});

test('加密参数被篡改时给出明确错误，不抛原始 RangeError', () => {
  const doc = buildBackup({ scope: SCOPE.accounts, accounts: ACCOUNTS, password: 'pw' });
  const huge = JSON.parse(JSON.stringify(doc));
  huge.kdf.N = 1e9;
  assert.throws(() => parseBackup(huge, 'pw'), /加密参数超出允许范围/);
  const badName = JSON.parse(JSON.stringify(doc));
  badName.cipher.name = 'aes-128-cbc';
  assert.throws(() => parseBackup(badName, 'pw'), /不支持的加密算法/);
  const badSalt = JSON.parse(JSON.stringify(doc));
  badSalt.kdf.salt = '!!!not-base64!!!';
  assert.throws(() => parseBackup(badSalt, 'pw'), /不是合法 base64/);
});

test('合并：现有重复仓库去重、保留额外字段、repo 大小写归一', () => {
  const out = mergeAccounts(
    [{ token: 'a', repo: 'Acme/Gateway', proxyKey: 'ka', _id: 'keep-me' },
      { token: 'dup', repo: 'acme/gateway' }],
    [{ token: 'b', repo: 'ACME/GATEWAY' }],
  );
  assert.equal(out.accounts.length, 1, '现有的重复仓库要合并成一条');
  assert.equal(out.accounts[0]._id, 'keep-me', '额外的界面字段要保留');
  assert.equal(out.accounts[0].token, 'b', '同仓库以备份为准');
  assert.equal(out.accounts[0].repo, 'acme/gateway', 'repo 归一为小写');
  assert.equal(out.replaced, 1);
});

test('WebDAV 地址拒绝 # 片段与 ? 查询', () => {
  assert.throws(() => davTarget('https://dav.example.com/a.json#frag'), /不要带 # 片段/);
  assert.throws(() => davTarget('https://dav.example.com/a.json?x=1'), /不要带 \? 查询参数/);
});
