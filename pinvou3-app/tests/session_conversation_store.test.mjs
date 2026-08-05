#!/usr/bin/env node
// session-conversation.js 会话作用域 store 的纯逻辑回归：事件按 sessionId 过滤、
// 回声去重、乐观气泡与多会话隔离。风格对齐 code_native_lane.test.mjs：
// 把模块复制到临时 type:module 目录再导入。
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const temp = mkdtempSync(path.join(tmpdir(), 'pinvou3-session-conversation-'));
writeFileSync(path.join(temp, 'package.json'), '{"type":"module"}\n');
mkdirSync(path.join(temp, 'conversation'), { recursive: true });
for (const file of ['conversation-model.js', 'deepseek-conversation.js', 'plan-card.js', 'session-conversation.js']) {
  copyFileSync(path.join(root, 'src', 'features', 'conversation', file), path.join(temp, 'conversation', file));
}

try {
  const {
    SESSION_CHAT_EVENTS,
    createSessionConversationStore,
  } = await import(`${pathToFileURL(path.join(temp, 'conversation', 'session-conversation.js')).href}?t=${Date.now()}`);

  assert.equal(SESSION_CHAT_EVENTS.length, 17, 'store 消费的 chat 事件全集与车道一致');
  assert.ok(SESSION_CHAT_EVENTS.includes('chat:user_message') && SESSION_CHAT_EVENTS.includes('chat:done'));
  assert.ok(SESSION_CHAT_EVENTS.includes('chat:plan_ready') && SESSION_CHAT_EVENTS.includes('chat:plan_resolved'));

  // ── 事件按 sessionId 过滤：未注册会话的事件被丢弃 ────────────────
  const store = createSessionConversationStore();
  store.registerSession('s1');
  assert.equal(store.isManaged('s1'), true);
  assert.equal(store.isManaged('s2'), false);
  const dropped = store.handleChatEvent('chat:user_message', { session_id: 's2', content: '别的会话' });
  assert.equal(dropped.accepted, false, '未注册会话事件被过滤');
  assert.equal(store.peekState('s2'), null, '被过滤事件不创建会话状态');
  const missingId = store.handleChatEvent('chat:done', {});
  assert.equal(missingId.accepted, false, '缺 session_id 的事件同样丢弃');
  assert.equal(store.peekState('s1'), null, '尚无事件的受管理会话不提前占位');

  // ── 乐观气泡 + chat 命令同步失败回滚（经 store 会话作用域入口）────
  const optimisticId = store.appendLocalUserMessage('s1', '修复登录页样式');
  let state = store.getState('s1');
  assert.equal(state.busy, true, '乐观插入后即 busy');
  assert.equal(state.items.filter(item => item.type === 'user').length, 1);
  store.removeLocalUserMessage('s1', optimisticId);
  assert.equal(state.items.length, 0, '回滚清除乐观气泡');
  assert.equal(state.busy, false);
  assert.equal(state.timeline.length, 0, 'user_start 一并回滚');

  // ── 回声去重：文本一致，或 30 秒窗口内的展示修饰回声 ─────────────
  store.appendLocalUserMessage('s1', '本地一句\n📎 a.png');
  const echo = store.handleChatEvent('chat:user_message', { session_id: 's1', content: '本地一句' });
  assert.equal(echo.accepted, true);
  assert.equal(echo.changed, false, '30 秒窗口内的回声按本地气泡去重');
  assert.equal(state.items.filter(item => item.type === 'user').length, 1);
  const remote = store.handleChatEvent('chat:user_message', { session_id: 's1', content: '手机端来的' });
  assert.equal(remote.changed, true, '窗口外的新消息正常落气泡');
  assert.equal(state.items.filter(item => item.type === 'user').length, 2);

  // ── 多会话隔离：s1 的事件不影响 s3 ──────────────────────────────
  store.registerSession('s3');
  store.handleChatEvent('chat:delta', { session_id: 's1', text: '你好' });
  store.handleChatEvent('chat:done', { session_id: 's1', status: 'Completed' });
  assert.equal(store.getState('s1').busy, false);
  assert.equal(store.getState('s3').items.length, 0, 's1 的流式内容不串到 s3');
  assert.equal(store.getState('s3').busy, false);
  const projection = store.project('s1');
  assert.equal(projection.turns.length >= 1, true, 's1 投影出回合');

  // ── 用户输入卡：事件出卡 → 提交收口 ─────────────────────────────
  store.handleChatEvent('chat:user_input_required', {
    session_id: 's3',
    id: 'call-1',
    questions: [{ id: 'q1', header: '方案', question: '选哪个？', options: [{ label: 'A' }] }],
  });
  const s3 = store.getState('s3');
  assert.equal(s3.items.filter(item => item.type === 'user_input').length, 1);
  assert.equal(store.markUserInputResolved('s3', 'call-1', 'submitted'), true);
  assert.equal(s3.items[0].resolved, true);
  assert.equal(store.markUserInputResolved('s3', 'call-1', 'submitted'), false, '已收口卡片幂等');

  // ── hydration 经 store；已注册后台会话保留 live busy ────────────
  store.hydrate('s3', { messages: [{ role: 'user', content: [{ type: 'text', text: '写个脚本' }] }] }, []);
  assert.equal(store.getState('s3').hydrated, true);
  assert.equal(store.getState('s3').busy, false);

  // ── retainSessions：以列表为准重建白名单并清理已删除会话 ─────────
  store.registerSession('s4');
  store.appendLocalUserMessage('s4', '待清理');
  store.retainSessions(['s1']);
  assert.equal(store.isManaged('s4'), false);
  assert.equal(store.isManaged('s3'), false);
  assert.equal(store.peekState('s4'), null, '已删除会话的状态被清理');
  assert.equal(store.peekState('s3'), null);
  assert.notEqual(store.peekState('s1'), null, '保留会话的状态不受影响');
  assert.equal(
    store.handleChatEvent('chat:delta', { session_id: 's4', text: 'x' }).accepted,
    false,
    '清理后 s4 的事件不再被接受',
  );

  console.log('session_conversation_store.test.mjs: all assertions passed');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
