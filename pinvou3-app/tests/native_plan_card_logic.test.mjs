import assert from 'node:assert/strict';
import {
  composePlanMarkdown,
  lastPlanSnapshotFromItems,
  planSnapshotFromToolArgs,
} from '../src/features/conversation/plan-card.js';
import {
  applyChatEvent,
  createConversationState,
  markPlanResolved,
  reopenPlanCard,
  restorePendingPlan,
} from '../src/features/conversation/session-conversation.js';

// ── composePlanMarkdown：与聊天页 bridge 同契约 ─────────────────────
{
  const markdown = composePlanMarkdown({
    plan: { explanation: '分两步走', items: [{ step: '改 a.rs', status: 'pending' }, { step: '跑测试', status: 'in_progress' }] },
    todos: { items: [{ content: '补单测', status: 'completed' }] },
  });
  assert.ok(markdown.includes('**方案：**'));
  assert.ok(markdown.includes('分两步走'));
  assert.ok(markdown.includes('1. ○ 改 a.rs'));
  assert.ok(markdown.includes('2. ◎ 跑测试'));
  assert.ok(markdown.includes('**细分待办：**'));
  assert.ok(markdown.includes('1. ● 补单测'));
}
// 空快照 → 兜底文案（accept_plan 指令不能是空串）。
assert.equal(composePlanMarkdown({ plan: null, todos: null }), '（plan 为空）');
assert.equal(composePlanMarkdown(null), '（plan 为空）');
// 仅 todos 无 plan 也能拼。
assert.ok(composePlanMarkdown({ todos: { items: [{ content: 'x', status: 'pending' }] } }).includes('1. ○ x'));

// ── planSnapshotFromToolArgs：update_plan 参数 → 快照 ───────────────
assert.deepEqual(
  planSnapshotFromToolArgs({ explanation: 'e', items: [{ step: 's1', status: 'pending' }, { step: 's2' }] }),
  { explanation: 'e', items: [{ step: 's1', status: 'pending' }, { step: 's2', status: 'pending' }] },
);
// 形状不符 → null。
assert.equal(planSnapshotFromToolArgs(null), null);
assert.equal(planSnapshotFromToolArgs('str'), null);
assert.equal(planSnapshotFromToolArgs({ items: 'not-array' }), null);
assert.equal(planSnapshotFromToolArgs({ items: [{ step: '' }] }), null);
assert.equal(planSnapshotFromToolArgs({ items: [] }), null);

// ── lastPlanSnapshotFromItems：取最后一次 update_plan ───────────────
{
  const items = [
    { type: 'tool', name: 'update_plan', args: { items: [{ step: '旧方案' }] } },
    { type: 'assistant', text: '...' },
    { type: 'tool', name: 'update_plan', args: { items: [{ step: '新方案' }] } },
    { type: 'tool', name: 'read_file', args: {} },
  ];
  const snapshot = lastPlanSnapshotFromItems(items);
  assert.equal(snapshot.items[0].step, '新方案');
}
assert.equal(lastPlanSnapshotFromItems([{ type: 'tool', name: 'read_file', args: {} }]), null);
assert.equal(lastPlanSnapshotFromItems([]), null);
assert.equal(lastPlanSnapshotFromItems(null), null);

// ── chat:plan_ready → plan_card ─────────────────────────────────────
function planReadyPayload(overrides = {}) {
  return {
    session_id: 's1',
    plan_id: 'turn-1',
    plan_snapshot: { explanation: 'e', items: [{ step: 's1', status: 'pending' }] },
    todos_snapshot: null,
    ...overrides,
  };
}

{
  const state = createConversationState();
  const changed = applyChatEvent(state, 'chat:plan_ready', planReadyPayload());
  assert.equal(changed, true);
  assert.equal(state.items.length, 1);
  const card = state.items[0];
  assert.equal(card.type, 'plan_card');
  assert.equal(card.planId, 'turn-1');
  assert.equal(card.cardState, 'active');
  assert.equal(card.resolved, false);
  assert.equal(card.resolution, null);
  assert.ok(card.planMarkdown.includes('1. ○ s1'));
  // 同 ticket 重复事件幂等。
  assert.equal(applyChatEvent(state, 'chat:plan_ready', planReadyPayload()), false);
  assert.equal(state.items.length, 1);
}

// 无 plan_id 的事件 → 历史卡（不可操作）。
{
  const state = createConversationState();
  applyChatEvent(state, 'chat:plan_ready', planReadyPayload({ plan_id: '' }));
  const card = state.items[0];
  assert.equal(card.cardState, 'resolved');
  assert.equal(card.resolution, 'historical');
  assert.equal(card.resolved, true);
}

// 新方案出现 → 旧 active 卡冻结为 superseded。
{
  const state = createConversationState();
  applyChatEvent(state, 'chat:plan_ready', planReadyPayload({ plan_id: 'turn-1' }));
  applyChatEvent(state, 'chat:plan_ready', planReadyPayload({ plan_id: 'turn-2' }));
  assert.equal(state.items.length, 2);
  assert.equal(state.items[0].resolution, 'superseded');
  assert.equal(state.items[0].resolved, true);
  assert.equal(state.items[1].cardState, 'active');
}

// ── chat:plan_resolved：多端同步冻结 ────────────────────────────────
{
  const state = createConversationState();
  applyChatEvent(state, 'chat:plan_ready', planReadyPayload({ plan_id: 'turn-1' }));
  const changed = applyChatEvent(state, 'chat:plan_resolved', { session_id: 's1', plan_id: 'turn-1' });
  assert.equal(changed, true);
  assert.equal(state.items[0].resolution, 'discarded');
  assert.equal(state.items[0].resolved, true);
  // 已收口卡不再重复改判。
  assert.equal(applyChatEvent(state, 'chat:plan_resolved', { session_id: 's1', plan_id: 'turn-1' }), false);
  // 空 plan_id 忽略。
  assert.equal(applyChatEvent(state, 'chat:plan_resolved', { session_id: 's1' }), false);
}

// ── markPlanResolved / reopenPlanCard ───────────────────────────────
{
  const state = createConversationState();
  applyChatEvent(state, 'chat:plan_ready', planReadyPayload({ plan_id: 'turn-1' }));
  // accept 乐观标记。
  assert.equal(markPlanResolved(state, 'turn-1', 'accepted'), true);
  assert.equal(state.items[0].resolution, 'accepted');
  // plan_not_active 改判历史卡（已收口卡也能再定位）。
  assert.equal(markPlanResolved(state, 'turn-1', 'historical'), true);
  assert.equal(state.items[0].resolution, 'historical');
  // 失败回滚恢复可操作。
  assert.equal(reopenPlanCard(state, 'turn-1'), true);
  assert.equal(state.items[0].cardState, 'active');
  assert.equal(state.items[0].resolved, false);
  assert.equal(state.items[0].resolution, null);
  // 不存在的 ticket。
  assert.equal(markPlanResolved(state, 'nope', 'accepted'), false);
  assert.equal(reopenPlanCard(null, 'x'), false);
}

// ── restorePendingPlan：重载还原挂起方案卡 ──────────────────────────
{
  const state = createConversationState();
  // 消息流里有 update_plan 工具卡 → 按其参数重建。
  state.items.push({ id: 1, type: 'tool', toolId: 't1', name: 'update_plan', args: { explanation: 'e', items: [{ step: 's1', status: 'pending' }] }, state: 'done' });
  assert.equal(restorePendingPlan(state, 'turn-9'), true);
  const card = state.items[state.items.length - 1];
  assert.equal(card.type, 'plan_card');
  assert.equal(card.planId, 'turn-9');
  assert.equal(card.cardState, 'active');
  assert.equal(card.resolved, false);
  assert.equal(card.plan.items[0].step, 's1');
  assert.ok(card.planMarkdown.includes('s1'));
  // 幂等。
  assert.equal(restorePendingPlan(state, 'turn-9'), false);
  // 空 ticket 不还原。
  assert.equal(restorePendingPlan(createConversationState(), ''), false);
  // 消息流里找不到 update_plan：退化为空方案卡，但仍可操作（能收口 ticket）。
  const empty = createConversationState();
  assert.equal(restorePendingPlan(empty, 'turn-1'), true);
  const degraded = empty.items[0];
  assert.equal(degraded.cardState, 'active');
  assert.equal(degraded.plan, null);
  assert.equal(degraded.planMarkdown, '（plan 为空）');
}

console.log('native_plan_card_logic.test.mjs: all assertions passed');
