// 上游错误正文 → 一句话：取字段、截断、状态码提示。
//
// 以前这段逻辑散在网关与 Host 两处，容易各改各的；收敛到 lib/upstream.mjs 后
// 这里锁住行为，避免日后又分叉。

import test from 'node:test';
import assert from 'node:assert/strict';
import { explainUpstreamStatus, pickMessage } from '../lib/upstream.mjs';

test('pickMessage：优先取 JSON 里的常见 message 字段', () => {
  assert.equal(pickMessage('{"error":{"message":"unknown model: foo"}}'), 'unknown model: foo');
  assert.equal(pickMessage('{"message":"boom"}'), 'boom');
  assert.equal(pickMessage('{"msg":"限流"}'), '限流');
  assert.equal(pickMessage('{"reason":"no credit"}'), 'no credit');
});

test('pickMessage：error 是字符串或对象时都不渲染成 [object Object]', () => {
  assert.equal(pickMessage('{"error":"bad key"}'), 'bad key');
  assert.equal(pickMessage('{"error":{"code":402,"type":"limit"}}'), '{"code":402,"type":"limit"}');
});

test('pickMessage：非 JSON 正文压缩空白并截断；空正文返回空串', () => {
  assert.equal(pickMessage('  line1\n\n  line2  '), 'line1 line2');
  assert.equal(pickMessage(''), '');
  assert.equal(pickMessage(null), '');
  assert.equal(pickMessage(undefined), '');
  const long = 'x'.repeat(500);
  assert.equal(pickMessage(long).length, 300);
  // 自定义上限也要生效
  assert.equal(pickMessage(long, 10).length, 10);
});

test('explainUpstreamStatus：状态码给出对应提示，并带上正文原话', () => {
  assert.match(explainUpstreamStatus(402, '{"error":{"message":"AI 积分已用尽"}}'), /额度不足/);
  assert.match(explainUpstreamStatus(402, '{"error":{"message":"AI 积分已用尽"}}'), /AI 积分已用尽/);
  assert.match(explainUpstreamStatus(429, ''), /请求过于频繁/);
  assert.match(explainUpstreamStatus(500, ''), /网关内部错误/);
  assert.match(explainUpstreamStatus(400, '{"message":"bad"}'), /网关返回错误/);
  // 没有正文时不留「 · 」尾巴
  assert.equal(explainUpstreamStatus(500, ''), '网关内部错误 · HTTP 500');
});
