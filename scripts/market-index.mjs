#!/usr/bin/env node
/**
 * 生成插件市场索引（format 1）。
 *
 * 为什么用脚本而不是手写 JSON：
 *  - name / version / engines.dsh 必须和 package.json 一致，手写迟早走样；
 *  - title / description 直接复用 locale/*.json，避免两处文案分叉；
 *  - git 源要求**完整 40 位 commit**，这里强制校验，免得填成分支名。
 *
 * 用法：
 *   node scripts/market-index.mjs --repo https://github.com/OWNER/dsh-cnb2api
 *   node scripts/market-index.mjs            # 已有 git 仓库时自动取 remote 与 HEAD
 *
 * 可选：--commit <40位sha> --version <x.y.z> --out <文件> --index-title <标题>
 *       --type npm（改用 npm 源，此时不需要 --commit）
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 解析 --key value 形式的参数。 */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) { out[key] = true; continue; }
    out[key] = next;
    i += 1;
  }
  return out;
}

/** 跑一个 git 命令，失败返回空串（没有仓库时不报错）。 */
function git(args) {
  try {
    // 没有 git 仓库时 git 会往 stderr 打 fatal，这里只取 stdout、静音 stderr
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** 读一份 locale 的 meta，缺文件时返回空对象。 */
function localeMeta(file) {
  const full = path.join(root, 'locale', file);
  if (!existsSync(full)) return {};
  try {
    return JSON.parse(readFileSync(full, 'utf8')).meta ?? {};
  } catch {
    return {};
  }
}

const args = parseArgs(process.argv.slice(2));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const sourceType = args.type === 'npm' ? 'npm' : 'git';
const version = String(args.version || pkg.version);
const repoUrl = String(
  args.repo
  || pkg.repository?.url
  || git(['config', '--get', 'remote.origin.url'])
  || '',
).replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git@([^:]+):/, 'https://$1/');
const commit = String(args.commit || git(['rev-parse', 'HEAD']) || '');
const publishTimestamp = Number(args.timestamp || git(['log', '-1', '--format=%ct']) || Math.floor(Date.now() / 1000));

if (!repoUrl) {
  console.error('缺少仓库地址：用 --repo https://github.com/OWNER/REPO 指定，或在 package.json 里写 repository.url。');
  process.exit(1);
}
if (sourceType === 'git' && !/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`git 源必须钉完整 40 位 commit，当前是「${commit || '(空)'}」。`);
  process.exit(1);
}

// title / description 直接复用 locale，避免和插件内文案分叉
const zh = localeMeta('zh.json');
const en = localeMeta('en.json');
const title = { zh: zh.title ?? pkg.name, en: en.title ?? zh.title ?? pkg.name };
const description = {
  zh: zh.description ?? pkg.description ?? '',
  en: en.description ?? zh.description ?? pkg.description ?? '',
};

const index = {
  format: 1,
  title: args['index-title'] ? { zh: String(args['index-title']), en: String(args['index-title']) } : { zh: 'CNB2API 插件', en: 'CNB2API plugins' },
  plugins: [{
    name: pkg.name,
    title,
    description,
    author: typeof pkg.author === 'string' ? pkg.author : pkg.author?.name,
    homepage: repoUrl,
    repository: { url: repoUrl },
    metadata: { keywords: pkg.keywords ?? [], labels: [] },
    versions: [{
      version,
      publishTimestamp,
      source: sourceType === 'npm'
        ? { type: 'npm' }
        : { type: 'git', url: repoUrl, commit },
      engines: { dsh: pkg.engines?.dsh ?? '*' },
    }],
  }],
};

const outFile = path.resolve(root, String(args.out || 'market-index.json'));
writeFileSync(outFile, `${JSON.stringify(index, null, 2)}\n`);
console.log(`已写入 ${path.relative(root, outFile)}`);
console.log(`  ${pkg.name}@${version} · ${sourceType}${sourceType === 'git' ? ` · ${commit.slice(0, 12)}…` : ''}`);
