// 运行中消息队列（queue/steer）纯逻辑测试：入队/插队/移除/清理、
// drain 的自动发送、互斥、停口窗口、可重试错误与 blocked 语义。
import assert from 'node:assert/strict';
import {
  createMessageQueueStore,
  createQueueDrainController,
  isRetriableQueueSendError,
  queueEntryPreviewText,
  QUEUE_DRAIN_MAX_ATTEMPTS,
  QUEUE_DRAIN_RETRY_DELAY_MS,
  QUEUE_DRAIN_SETTLE_MS,
} from '../src/features/conversation/message-queue.js';

function flushMicrotasks() {
  return new Promise(resolve => setImmediate(resolve));
}

// ── store：入队/插队/移除/清理 ─────────────────────────────────────────

{
  const queue = createMessageQueueStore();
  const a = queue.enqueue('s1', { message: '第一条' });
  const b = queue.enqueue('s1', { message: '第二条' });
  const c = queue.enqueue('s2', { message: '别的会话' });
  assert.equal(queue.size('s1'), 2);
  assert.equal(queue.peek('s1').id, a.id);
  assert.deepEqual(queue.list('s1').map(entry => entry.message), ['第一条', '第二条']);

  // steer 插队：队首被抢占，既有顺序不变。
  const steer = queue.enqueueFront('s1', { message: '插队' });
  assert.deepEqual(queue.list('s1').map(entry => entry.message), ['插队', '第一条', '第二条']);
  assert.equal(queue.peek('s1').id, steer.id);

  // 移除中间条目不影响其余顺序。
  assert.equal(queue.remove('s1', a.id).message, '第一条');
  assert.deepEqual(queue.list('s1').map(entry => entry.id), [steer.id, b.id]);
  assert.equal(queue.remove('s1', 9999), null);
  assert.equal(queue.peek('s2').id, c.id);

  // 清空与 retain 清理。
  queue.clear('s2');
  assert.equal(queue.size('s2'), 0);
  queue.retainSessions(['s1']);
  assert.equal(queue.size('s1'), 2);
  assert.equal(queue.size('s2'), 0);
}

// onChange 在每次变更时触发。
{
  const queue = createMessageQueueStore();
  let changes = 0;
  queue.onChange = () => { changes += 1; };
  queue.enqueue('s', { message: 'x' });
  queue.enqueueFront('s', { message: 'y' });
  queue.remove('s', 1);
  queue.clear('s');
  assert.equal(changes, 4);
}

// 快照隔离：list 返回副本，改副本不影响队列。
{
  const queue = createMessageQueueStore();
  queue.enqueue('s', { message: 'x' });
  const snapshot = queue.list('s');
  snapshot.pop();
  assert.equal(queue.size('s'), 1);
}

// 预览：消息首行 / 空消息退化附件名 / 仅引用。
{
  assert.equal(queueEntryPreviewText({ message: '第一行\n第二行' }), '第一行');
  assert.equal(queueEntryPreviewText({ message: '\n\n  \n正文' }), '正文');
  assert.equal(queueEntryPreviewText({ message: '', attachmentNames: ['a.ts', 'b.ts'] }), '📎 a.ts, b.ts');
  assert.equal(queueEntryPreviewText({ message: '', references: ['src/x'] }), '@src/x');
  assert.equal(queueEntryPreviewText({ message: '' }), '');
}

// 可重试错误匹配：turn 锁释放窗口 / ACP 忙窗；永久错误不匹配。
{
  assert.ok(isRetriableQueueSendError('reserve chat turn: session_turn_in_progress'));
  assert.ok(isRetriableQueueSendError('session_turn_in_progress'));
  assert.ok(isRetriableQueueSendError('ACP 会话仍在生成'));
  assert.ok(isRetriableQueueSendError('ACP 会话仍在同步，请稍候再发送'));
  assert.ok(!isRetriableQueueSendError('empty message'));
  assert.ok(!isRetriableQueueSendError(''));
  assert.ok(!isRetriableQueueSendError(null));
}

// ── drain 控制器 ─────────────────────────────────────────────────────

function createHarness({ isBusy = () => false, isHoldback = () => false, send } = {}) {
  const queue = createMessageQueueStore();
  const scheduled = [];
  const sent = [];
  const lane = {
    isBusy,
    isHoldback,
    send: send || (async (sessionId, entry) => {
      sent.push({ sessionId, message: entry.message });
      return { ok: true };
    }),
  };
  const controller = createQueueDrainController({
    queue,
    onChange: () => {},
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
  });
  return { queue, controller, lane, scheduled, sent };
}

// turn 终态后自动按序发送（queue 语义）。
{
  const { queue, controller, lane, sent } = createHarness();
  queue.enqueue('s', { message: 'A' });
  queue.enqueue('s', { message: 'B' });
  await controller.maybeDrain('s', lane);
  assert.deepEqual(sent.map(item => item.message), ['A']);
  assert.equal(queue.size('s'), 1); // B 等 A 的 turn 终态后再发
}

// 忙碌/挂起时不发送。
{
  const { queue, controller, lane, sent } = createHarness({ isBusy: () => true });
  queue.enqueue('s', { message: 'A' });
  await controller.maybeDrain('s', lane);
  assert.equal(sent.length, 0);
  assert.equal(queue.size('s'), 1);
}
{
  const { queue, controller, lane, sent } = createHarness({ isHoldback: () => true });
  queue.enqueue('s', { message: 'A' });
  await controller.maybeDrain('s', lane);
  assert.equal(sent.length, 0);
  assert.equal(queue.size('s'), 1);
}

// 竞态：入队时 turn 已终态（渲染期 busy 为旧值）→ 立即补 drain 即发送。
{
  let busy = true;
  const { queue, controller, lane, sent } = createHarness({ isBusy: () => busy });
  queue.enqueue('s', { message: 'A' });
  await controller.maybeDrain('s', lane); // 仍忙：不发
  assert.equal(sent.length, 0);
  busy = false; // 终态事件落地
  await controller.maybeDrain('s', lane);
  assert.deepEqual(sent.map(item => item.message), ['A']);
}

// 发送成功进入停口窗口：窗口内不再 drain，窗口结束的补调继续发。
{
  let now = 1000;
  const queue = createMessageQueueStore();
  const scheduled = [];
  const sent = [];
  const lane = {
    isBusy: () => false,
    isHoldback: () => false,
    send: async (sessionId, entry) => { sent.push(entry.message); return { ok: true }; },
  };
  const controller = createQueueDrainController({
    queue,
    onChange: () => {},
    now: () => now,
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
  });
  queue.enqueue('s', { message: 'A' });
  queue.enqueue('s', { message: 'B' });
  await controller.maybeDrain('s', lane);
  assert.deepEqual(sent, ['A']);
  await controller.maybeDrain('s', lane); // 停口窗口内：不发
  assert.deepEqual(sent, ['A']);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, QUEUE_DRAIN_SETTLE_MS + 50);
  now += QUEUE_DRAIN_SETTLE_MS + 60;
  await scheduled[0].fn(); // 窗口结束补 drain → 发 B（沿用发起调用的 lane）
  assert.deepEqual(sent, ['A', 'B']);
}

// 可重试错误：延迟重试后成功，条目正常出队不 blocked。
{
  let failures = 1;
  const queue = createMessageQueueStore();
  const scheduled = [];
  const sent = [];
  const lane = {
    isBusy: () => false,
    isHoldback: () => false,
    send: async (_sessionId, entry) => {
      if (failures > 0) { failures -= 1; return { ok: false, error: 'reserve chat turn: session_turn_in_progress' }; }
      sent.push(entry.message);
      return { ok: true };
    },
  };
  const controller = createQueueDrainController({
    queue,
    onChange: () => {},
    schedule: (fn, ms) => { scheduled.push({ fn, ms }); },
  });
  queue.enqueue('s', { message: 'A' });
  await controller.maybeDrain('s', lane);
  assert.equal(sent.length, 0);
  assert.equal(queue.size('s'), 1);
  assert.equal(queue.peek('s').attempts, 1);
  assert.equal(queue.peek('s').blocked, false);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, QUEUE_DRAIN_RETRY_DELAY_MS);
  await scheduled[0].fn();
  assert.deepEqual(sent, ['A']);
  assert.equal(queue.size('s'), 0);
}

// 永久错误：队首 blocked、队列暂停；用户移除后下一条恢复发送。
{
  const send = async () => ({ ok: false, error: 'empty message' });
  const { queue, controller, lane, scheduled } = createHarness({ send });
  queue.enqueue('s', { message: 'A' });
  queue.enqueue('s', { message: 'B' });
  await controller.maybeDrain('s', lane);
  assert.equal(queue.peek('s').blocked, true);
  assert.equal(queue.peek('s').attempts, 1);
  assert.equal(scheduled.length, 0); // 永久失败不自动重试
  await controller.maybeDrain('s', lane); // blocked 队首挡住后续
  assert.equal(queue.size('s'), 2);
  queue.remove('s', queue.peek('s').id); // 用户移除失败条目
  await controller.maybeDrain('s', lane); // 队列自动恢复（B 仍失败，同样 blocked）
  assert.equal(queue.peek('s').message, 'B');
  assert.equal(queue.peek('s').blocked, true);
}

// 重试耗尽（达到上限）也按 blocked 收尾，不无限重试。
{
  const send = async () => ({ ok: false, error: 'session_turn_in_progress' });
  const { queue, controller, lane, scheduled } = createHarness({ send });
  queue.enqueue('s', { message: 'A' });
  await controller.maybeDrain('s', lane);
  for (let index = 0; index < QUEUE_DRAIN_MAX_ATTEMPTS; index += 1) {
    const task = scheduled.shift();
    if (!task) break;
    await task.fn();
  }
  assert.equal(queue.peek('s').attempts, QUEUE_DRAIN_MAX_ATTEMPTS);
  assert.equal(queue.peek('s').blocked, true);
  assert.equal(scheduled.length, 0);
}

// 发送链路抛异常（未按约定返回结果）：blocked 兜底，不 unhandled。
{
  const queue = createMessageQueueStore();
  const lane = {
    isBusy: () => false,
    isHoldback: () => false,
    send: async () => { throw new Error('boom'); },
  };
  const controller = createQueueDrainController({
    queue,
    onChange: () => {},
    schedule: () => {},
  });
  queue.enqueue('s', { message: 'A' });
  await controller.maybeDrain('s', lane);
  assert.equal(queue.peek('s').blocked, true);
}

// 互斥：drain 在途时重入调用直接返回，不会双发。
{
  const queue = createMessageQueueStore();
  const sent = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const lane = {
    isBusy: () => false,
    isHoldback: () => false,
    send: async (_sessionId, entry) => { await gate; sent.push(entry.message); return { ok: true }; },
  };
  const controller = createQueueDrainController({
    queue,
    onChange: () => {},
    schedule: () => {},
  });
  queue.enqueue('s', { message: 'A' });
  const first = controller.maybeDrain('s', lane);
  await flushMicrotasks();
  assert.ok(controller.isDraining());
  await controller.maybeDrain('s', lane); // 在途重入：直接返回
  release();
  await first;
  assert.deepEqual(sent, ['A']);
  assert.ok(!controller.isDraining());
}

// 车道安全：视图层 lane 对非当前查看会话按“忙”上报（adapter.send 绑定当前
// activeId），切走后的定时器补调不会把消息发到错误的会话。
{
  const viewed = { id: 'a' };
  const queue = createMessageQueueStore();
  const sent = [];
  const lane = {
    isBusy: id => id !== viewed.id,
    send: async (_sessionId, entry) => { sent.push(entry.message); return { ok: true }; },
  };
  const controller = createQueueDrainController({
    queue,
    onChange: () => {},
    schedule: () => {},
  });
  queue.enqueue('a', { message: 'A 的消息' });
  viewed.id = 'b'; // 切到 B 后 A 的补调触发
  await controller.maybeDrain('a', lane);
  assert.deepEqual(sent, []);
  assert.equal(queue.size('a'), 1);
}

console.log('session message queue tests passed');
