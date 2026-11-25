// Host 与 UI 的重复纯逻辑护栏。
//
// 状态面板是浏览器 bundle（手写单文件，不能 import lib/*），所以 renderNotice、
// 数值格式化、状态文案表在两侧各有一份。这里用一致性断言防止它们悄悄走散：
// 改了一边而没改另一边时，测试会先失败。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatAmount, renderNotice } from '../lib/quota.mjs';
import { TEXT } from '../lib/text.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BUNDLE = path.join(HERE, '..', 'ui', 'client.js');
const source = fs.readFileSync(BUNDLE, 'utf8');

/**
 * 从 bundle 里取出一个顶层函数声明并求值成函数。
 * @param {string} name - 函数名。
 * @returns {Function} 函数。
 */
function extractFunction(name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `bundle 里应有 ${name}`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        const src = source.slice(start, i + 1);
        // 包成表达式再求值：`function name(){}` → `(function name(){})`
        return new Function(`return (${src})`)();
      }
    }
  }
  assert.fail(`无法解析 ${name} 的函数体`);
}

/** 从某个语言表里取出 state 段的键。 */
function uiStateKeys(lang) {
  const marker = lang === 'zh' ? '    const ZH = {' : '    const EN = {';
  const tableStart = source.indexOf(marker);
  assert.ok(tableStart >= 0, `应有 ${lang} 文案表`);
  const tableEnd = source.indexOf('\n    };', tableStart);
  const table = source.slice(tableStart, tableEnd);
  const blockStart = table.indexOf('      state: {');
  assert.ok(blockStart >= 0, `${lang} 表里应有 state 段`);
  const blockEnd = table.indexOf('\n      },', blockStart);
  const block = table.slice(blockStart, blockEnd);
  return [...block.matchAll(/(\w+):\s*'/g)].map((match) => match[1]).sort();
}

test('UI renderLowCredit 与宿主 renderNotice 行为一致（含未知占位符原样保留）', () => {
  const uiRender = extractFunction('renderLowCredit');
  const vars = {
    account: 'acme/gateway', unit: 'cr', used: '1157', frozen: '0',
    consumed: '1157', remain: '9', total: '1166', percent: '99.23', threshold: '5',
  };
  const templates = [
    '{account} 额度告急：已用 {consumed}/{total} {unit}（{percent}%），仅剩 {remain}',
    '{remaim} 写错了要原样保留，{unknown} 也是',
    '纯文本没有占位符',
    '',
    null,
  ];
  for (const template of templates) {
    assert.equal(uiRender(template, vars), renderNotice(template, vars), `模板不一致：${template}`);
  }
});

test('UI formatNum 与宿主 formatAmount 只差千分位分组，四舍五入一致', () => {
  const uiFormat = extractFunction('formatNum');
  for (const n of [0, 1, 1.04, 1.05, 9.99, 1166, 1166.04, 1234567.85]) {
    assert.equal(
      uiFormat(n).replace(/,/g, ''),
      formatAmount(n),
      `数值格式化不一致：${n}`,
    );
  }
});

test('宿主 TEXT 与 UI 状态文案表的键集一致（两种语言）', () => {
  assert.deepEqual(uiStateKeys('zh'), Object.keys(TEXT.zh.state).sort());
  assert.deepEqual(uiStateKeys('en'), Object.keys(TEXT.en.state).sort());
});
