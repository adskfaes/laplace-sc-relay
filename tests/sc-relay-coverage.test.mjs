import assert from 'node:assert/strict';
import test from 'node:test';
import { comparableMessages, createCoverage, findDuplicate } from '../laplace-sc-relay/recent-chat.js';
import '../laplace-sc-relay/message-format.js';

const parts = ['【今晚开心】', '【喝杯热茶】', '【明天再见】'];
const match = comparableMessages('今晚开心喝杯热茶明天再见', parts, '【', '】');
const packet = (id, text, time = 1000) => ({ id, text, time });

test('defaults use 40 characters including wrappers and a 1.5 second interval', () => {
  const { defaults, splitMessage } = globalThis.LaplaceScFormat;
  assert.equal(defaults.limit, 40);
  assert.equal(defaults.interval, 1500);
  const text = '甲'.repeat(38) + '乙';
  assert.deepEqual(splitMessage(text, defaults), ['【' + '甲'.repeat(38) + '】', '【乙】']);
  assert.ok(splitMessage(text, defaults, 20).every((part) => part.length <= 20));
  assert.ok(splitMessage(text, { ...defaults, limit: 24 }).every((part) => part.length <= 24));
});

test('complete SC can cover a task before or during a multi-part submission', () => {
  const coverage = createCoverage(match, 10000);
  coverage.observe(packet('full', '【今晚开心 喝杯热茶明天再见】'), 1);
  assert.equal(coverage.covered, true);
});

test('one short matching phrase does not stop a multi-part SC', () => {
  const coverage = createCoverage(comparableMessages('谢谢喝杯热茶', ['【谢谢】', '【喝杯热茶】'], '【', '】'), 10000);
  coverage.observe(packet('short', '【谢谢】'));
  assert.equal(coverage.covered, false);
  assert.equal(coverage.suspicion(1100, 0), null);
});

test('matching symbols make a distinctive four-character first part sufficient to pause', () => {
  const coverage = createCoverage(match, 10000);
  coverage.observe(packet('plain', '今晚开心'));
  assert.equal(coverage.suspicion(1100, 0), null);
  coverage.observe(packet('framed', '【今晚开心】', 1200));
  assert.equal(coverage.suspicion(1300, 0), 'first-part');
  assert.equal(coverage.covered, false);
  assert.equal(coverage.suspicion(1300, 1), null);
  assert.equal(coverage.suspicion(11201, 0), null);
});

test('distinctive plain first parts pause, while repeated characters and near matches do not', () => {
  const text = '未来还会继续精彩';
  const coverage = createCoverage(comparableMessages(text + '欢迎常来聊天', ['【' + text + '】', '【欢迎常来聊天】'], '【', '】'), 10000);
  coverage.observe(packet('near', '未来还会继续精采'));
  assert.equal(coverage.suspicion(1100, 0), null);
  coverage.observe(packet('exact', text));
  assert.equal(coverage.suspicion(1100, 0), 'first-part');
  const repetitive = createCoverage(comparableMessages('哈哈哈哈哈哈加油', ['【哈哈哈哈哈哈】', '【加油】'], '【', '】'), 10000);
  repetitive.observe(packet('repeat', '【哈哈哈哈哈哈】'));
  assert.equal(repetitive.suspicion(1100, 0), null);
});

test('two distinctive parts with an unissued part are suspected until the full ordered sequence appears', () => {
  const coverage = createCoverage(match, 10000);
  coverage.observe(packet('a', parts[0]), 1);
  coverage.observe(packet('noise', '无关弹幕', 1250), 1);
  coverage.observe(packet('b', '喝杯热茶', 1500), 1);
  assert.equal(coverage.covered, false);
  assert.equal(coverage.suspicion(1600, 1), 'sequence');
  coverage.observe(packet('c', parts[2], 1800), 1);
  assert.equal(coverage.covered, true);
});

test('only the current task’s issued parts are confirmed through the receipt path', () => {
  const coverage = createCoverage(match, 10000);
  parts.forEach((part, index) => coverage.observe(packet(String(index), part, 1000 + index), index + 1));
  assert.equal(coverage.covered, false);
  assert.equal(coverage.suspicion(1030, 3), null);
  const single = createCoverage(comparableMessages('谢谢', ['【谢谢】'], '【', '】'), 10000);
  single.observe(packet('self', '【谢谢】'), 1);
  assert.equal(single.covered, false);
});

test('old, out-of-order or repeated event IDs do not make up a complete sequence', () => {
  const coverage = createCoverage(match, 10000);
  coverage.observe(packet('third-first', parts[2]));
  coverage.observe(packet('a', parts[0], 1250));
  coverage.observe(packet('b', parts[1], 1300));
  assert.equal(coverage.covered, false);
  coverage.observe(packet('c', parts[2], 14000));
  assert.equal(coverage.covered, false);
  const repeat = createCoverage(comparableMessages('相同一段相同一段', ['相同一段', '相同一段'], '', ''), 10000);
  repeat.observe(packet('same-id', '相同一段'));
  repeat.observe(packet('same-id', '相同一段', 1100));
  assert.equal(repeat.covered, false);
  repeat.observe(packet('another-id', '相同一段', 1200));
  assert.equal(repeat.covered, true);
});

test('an 80% match remains separate from exact coverage', () => {
  const expected = comparableMessages('青山白云河', ['【青山白云】', '【河】'], '【', '】');
  const event = packet('near', '青山白云湖');
  assert.equal(findDuplicate([event], expected.variants, 80), 80);
  const coverage = createCoverage(expected, 10000);
  coverage.observe(event);
  assert.equal(coverage.covered, false);
});
