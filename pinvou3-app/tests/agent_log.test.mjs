// 会话级 agent log 纯逻辑测试：环形缓冲容量、原生/ACP 事件映射、
// turn 耗时配对、工具生命周期收口、脱敏（load_skill 全文 / 敏感键）、
// 历史种子（原生 timing_events / ACP timeline 回放）与幂等重建。
import assert from 'node:assert/strict';
import {
  AGENT_LOG_CAPACITY,
  buildAcpSeedEntries,
  createAgentLogStore,
  nativeTimelineSeedEntries,
  redactSensitiveFields,
  summarizeToolArgs,
  summarizeToolOutput,
} from '../src/features/codex/agent-log.js';

// ── 摘要与脱敏 ───────────────────────────────────────────────────────

{
  // 敏感键的字符串值替换为 ***，非敏感键与嵌套结构保留。
  const redacted = redactSensitiveFields({
    command: 'ls',
    api_key: 'sk-123456',
    nested: { authorization: 'Bearer x', note: 'ok' },
    list: [{ token: 't' }, 'plain'],
  });
  assert.equal(redacted.command, 'ls');
  assert.equal(redacted.api_key, '***');
  assert.equal(redacted.nested.authorization, '***');
  assert.equal(redacted.nested.note, 'ok');
  assert.equal(redacted.list[0].token, '***');
  assert.equal(redacted.list[1], 'plain');
}

{
  // 参数摘要：紧凑 JSON + 脱敏；超长截断。
  const args = summarizeToolArgs('exec_shell', { command: 'echo hi', password: 'pw' });
  assert.equal(args.redacted, false);
  assert.ok(args.text.includes('"command":"echo hi"'));
  assert.ok(args.text.includes('"password":"***"'));
  const long = summarizeToolArgs('write_file', { content: 'x'.repeat(500) });
  assert.ok(long.text.length <= 221);
  assert.ok(long.text.endsWith('…'));
}

{
  // load_skill 结果不落 SKILL.md 全文（bridge 脱敏先例）；其余工具正常摘要。
  const skill = summarizeToolOutput('load_skill', '# SKILL 全文...');
  assert.equal(skill.redacted, true);
  assert.equal(skill.text, '');
  const normal = summarizeToolOutput('exec_shell', 'ok\n');
  assert.equal(normal.redacted, false);
  assert.equal(normal.text, 'ok\n');
}

// ── 原生事件映射 ─────────────────────────────────────────────────────

{
  const log = createAgentLogStore();
  // turn 开始/终态配对出耗时。
  log.recordNativeEvent('s', 'chat:turn_started', { session_id: 's' });
  await new Promise(resolve => setTimeout(resolve, 5));
  log.recordNativeEvent('s', 'chat:done', { session_id: 's', status: 'Completed', error: null });
  const entries = log.list('s');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'turn');
  assert.equal(entries[0].phase, 'start');
  assert.equal(entries[1].phase, 'end');
  assert.equal(entries[1].status, 'Completed');
  assert.ok(entries[1].durationMs >= 0);
}

{
  const log = createAgentLogStore();
  // 工具生命周期：start 建条目，end 原地收口状态与结果。
  log.recordNativeEvent('s', 'chat:tool_start', { id: 't1', name: 'exec_shell', args: { command: 'ls' } });
  log.recordNativeEvent('s', 'chat:tool_end', { id: 't1', success: true, output: 'file.ts' });
  log.recordNativeEvent('s', 'chat:tool_start', { id: 't2', name: 'write_file', args: {} });
  log.recordNativeEvent('s', 'chat:tool_end', { id: 't2', success: false, output: 'denied' });
  const entries = log.list('s').filter(entry => entry.kind === 'tool');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].status, 'done');
  assert.equal(entries[0].resultSummary, 'file.ts');
  assert.equal(entries[1].status, 'failed');
}

{
  const log = createAgentLogStore();
  // careful 拦截：metadata.safety_level=dangerous && blocked → 状态 blocked。
  log.recordNativeEvent('s', 'chat:tool_start', { id: 't1', name: 'exec_shell', args: { command: 'rm -rf /' } });
  log.recordNativeEvent('s', 'chat:tool_end', {
    id: 't1', success: false, output: 'blocked',
    metadata: { safety_level: 'dangerous', blocked: true },
  });
  const entry = log.list('s').find(item => item.kind === 'tool');
  assert.equal(entry.status, 'blocked');
}

{
  const log = createAgentLogStore();
  // load_skill：日志保留调用痕迹，结果按占位脱敏。
  log.recordNativeEvent('s', 'chat:tool_start', { id: 't1', name: 'load_skill', args: { name: 'pptx' } });
  log.recordNativeEvent('s', 'chat:tool_end', { id: 't1', success: true, output: '# 全文' });
  const entry = log.list('s').find(item => item.kind === 'tool');
  assert.equal(entry.resultRedacted, true);
  assert.equal(entry.resultSummary, '');
  assert.ok(entry.argsSummary.includes('pptx'));
}

{
  const log = createAgentLogStore();
  // plan / 错误 / 压缩事件。
  log.recordNativeEvent('s', 'chat:plan_ready', { plan_id: 'p1', plan_snapshot: { items: [1, 2, 3] } });
  log.recordNativeEvent('s', 'chat:plan_resolved', { plan_id: 'p1' });
  log.recordNativeEvent('s', 'chat:transient_error', { error: '网络抖动' });
  log.recordNativeEvent('s', 'chat:compaction', { phase: 'done', message: 'ok' });
  const kinds = log.list('s').map(entry => `${entry.kind}:${entry.phase || ''}`);
  assert.deepEqual(kinds, ['plan:ready', 'plan:resolved', 'error:', 'note:done']);
  assert.equal(log.list('s')[0].planItems, 3);
  // 不消费的事件（delta/usage 等）不入日志。
  assert.equal(log.recordNativeEvent('s', 'chat:delta', { text: 'x' }), null);
  assert.equal(log.recordNativeEvent('s', 'chat:usage', { input_tokens: 10 }), null);
}

// ── ACP 事件映射 ─────────────────────────────────────────────────────

{
  const log = createAgentLogStore();
  log.recordAcpEvent('s', { sessionId: 's', seq: 1, timestamp: 1000, event: { type: 'turn_started', data: {} } });
  log.recordAcpEvent('s', {
    sessionId: 's', seq: 2, timestamp: 1100,
    event: { type: 'tool_call', data: { update: { toolCallId: 'c1', title: 'Run ls', kind: 'execute', status: 'in_progress', rawInput: { command: 'ls' } } } },
  });
  log.recordAcpEvent('s', {
    sessionId: 's', seq: 3, timestamp: 1200,
    event: { type: 'tool_call_update', data: { update: { toolCallId: 'c1', status: 'completed', rawOutput: 'done.txt' } } },
  });
  log.recordAcpEvent('s', { sessionId: 's', seq: 4, timestamp: 1500, event: { type: 'turn_completed', data: { status: 'completed' } } });
  const entries = log.list('s');
  assert.deepEqual(entries.map(entry => entry.kind), ['turn', 'tool', 'turn']);
  assert.equal(entries[0].phase, 'start');
  assert.equal(entries[1].status, 'done');
  assert.equal(entries[1].resultSummary, 'done.txt');
  assert.equal(entries[2].durationMs, 500);
  assert.equal(entries[2].status, 'completed');
  // 高频消息事件不入日志。
  assert.equal(log.recordAcpEvent('s', { sessionId: 's', seq: 5, timestamp: 1600, event: { type: 'agent_message_chunk', data: {} } }), null);
}

// ── 环形缓冲容量 ─────────────────────────────────────────────────────

{
  const log = createAgentLogStore({ capacity: 5 });
  for (let index = 0; index < 8; index += 1) {
    log.record('s', { kind: 'note', summary: `n${index}`, at: index + 1 });
  }
  const entries = log.list('s');
  assert.equal(entries.length, 5);
  assert.deepEqual(entries.map(entry => entry.summary), ['n3', 'n4', 'n5', 'n6', 'n7']);
  // 默认容量 = 200。
  assert.equal(AGENT_LOG_CAPACITY, 200);
}

// 容量淘汰按事件时间：回放的历史种子先淘汰，实时事件保留。
{
  const log = createAgentLogStore({ capacity: 3 });
  log.record('s', { kind: 'note', summary: 'live', at: 100 });
  log.replaceSeeded('s', [
    { kind: 'turn', phase: 'end', at: 1, status: 'Completed' },
    { kind: 'turn', phase: 'end', at: 2, status: 'Completed' },
    { kind: 'turn', phase: 'end', at: 3, status: 'Completed' },
  ]);
  const entries = log.list('s');
  assert.equal(entries.length, 3);
  assert.ok(entries.some(entry => entry.summary === 'live'));
}

// ── 历史种子 ─────────────────────────────────────────────────────────

{
  // 原生 timing_events：每个已收口 turn 一条终态条目；未配对的 user_start 不回放。
  const seeds = nativeTimelineSeedEntries([
    { turn_id: 't1', event: 'user_start', timestamp: 1000 },
    { turn_id: 't1', event: 'assistant_done', timestamp: 1600, status: 'Completed' },
    { turn_id: 't2', event: 'user_start', timestamp: 2000 },
    { turn_id: 't3', event: 'user_start', timestamp: 3000 },
    { turn_id: 't3', event: 'assistant_done', timestamp: 3100, status: 'Failed', error: 'boom' },
  ]);
  assert.equal(seeds.length, 2);
  assert.equal(seeds[0].durationMs, 600);
  assert.equal(seeds[0].status, 'Completed');
  assert.equal(seeds[1].error, 'boom');
}

{
  // ACP timeline 全量回放：与实时记录同一映射，含 turn/工具/plan。
  const timeline = [
    { sessionId: 's', seq: 1, timestamp: 1000, event: { type: 'turn_started', data: {} } },
    { sessionId: 's', seq: 2, timestamp: 1100, event: { type: 'tool_call', data: { update: { toolCallId: 'c1', title: 'Edit', kind: 'edit', status: 'completed', rawInput: { path: 'a.ts' } } } } },
    { sessionId: 's', seq: 3, timestamp: 1200, event: { type: 'plan', data: { update: { entries: [{}, {}] } } } },
    { sessionId: 's', seq: 4, timestamp: 1400, event: { type: 'turn_completed', data: { status: 'completed' } } },
  ];
  const seeds = buildAcpSeedEntries(timeline);
  assert.deepEqual(seeds.map(entry => entry.kind), ['turn', 'tool', 'plan', 'turn']);
  assert.equal(seeds[1].status, 'done');
  assert.equal(seeds[2].planItems, 2);
  assert.equal(seeds[3].durationMs, 400);
  assert.ok(seeds.every(entry => entry.seeded === true));
  // id 由目标 store 分配（种子不带 id）。
  assert.ok(seeds.every(entry => entry.id === undefined));
}

{
  // replaceSeeded 幂等：重复重建不叠加；实时条目保留。
  const log = createAgentLogStore();
  log.recordNativeEvent('s', 'chat:turn_started', {});
  log.recordNativeEvent('s', 'chat:done', { status: 'Completed' });
  const live = log.size('s');
  const seeds = [{ kind: 'turn', phase: 'end', at: 1, status: 'Completed' }];
  log.replaceSeeded('s', seeds);
  assert.equal(log.size('s'), live + 1);
  log.replaceSeeded('s', seeds);
  assert.equal(log.size('s'), live + 1);
  assert.equal(log.list('s').filter(entry => entry.seeded).length, 1);
  // 新历史（更少种子）重建后旧种子被清掉。
  log.replaceSeeded('s', []);
  assert.equal(log.list('s').filter(entry => entry.seeded).length, 0);
  assert.equal(log.size('s'), live);
}

{
  // 与实时条目重叠的历史不回放：seed.at 不早于最早实时条目时跳过（同一 turn
  // 进程内已被实时记录，重放会重复）；更早的历史正常回填。
  const log = createAgentLogStore();
  log.record('s', { kind: 'note', summary: 'live', at: 1000 });
  log.replaceSeeded('s', [
    { kind: 'turn', phase: 'end', at: 100, status: 'Completed' },
    { kind: 'turn', phase: 'end', at: 1500, status: 'Completed' },
  ]);
  const entries = log.list('s');
  assert.equal(entries.filter(entry => entry.seeded).length, 1);
  assert.equal(entries.find(entry => entry.seeded).at, 100);
  // 再次重建（实时下限不变）：重叠段仍不回放，幂等。
  log.replaceSeeded('s', [
    { kind: 'turn', phase: 'end', at: 100, status: 'Completed' },
    { kind: 'turn', phase: 'end', at: 1500, status: 'Completed' },
  ]);
  assert.equal(log.list('s').filter(entry => entry.seeded).length, 1);
}

{
  // retainSessions 清理已消失会话。
  const log = createAgentLogStore();
  log.record('a', { kind: 'note', summary: 'x' });
  log.record('b', { kind: 'note', summary: 'y' });
  log.retainSessions(['a']);
  assert.equal(log.size('a'), 1);
  assert.equal(log.size('b'), 0);
}

console.log('agent log tests passed');
