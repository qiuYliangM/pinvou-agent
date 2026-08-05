// 运行中消息队列（代码页 queue/steer 的纯逻辑，阶段二·会话控制）：以 sessionId
// 为作用域的待发送队列 + turn 终态后的自动 drain 控制器。进程内状态，重载即丢
// （对齐 VSCode 运行中 queue：只保证本进程内的顺序与投递，不做持久化）。
//
// 三语义（对齐 VSCode agent 模式）：
// - queue：turn 进行中发送 → 消息入队尾；turn 终态后按序自动发送；
// - steer（插队）：enqueueFront + 停当前 turn（视图层复用 cancel 链路，含后台
//   任务清理），终态事件到达后由 drain 发送队首 —— 即 VSCode 的 "Stop and Send"；
// - stop：仅停 turn，不动队列（视图层 adapter.cancel，不经本模块）。
//
// drain 竞态防线：
// - draining 互斥：同一时间最多一个发送在途，effect 重入不会双发；
// - settle 窗口：发送成功后短暂停口。ACP 车道 busy 由 turn_started 事件异步
//   翻转，等事件落地再放行下一条，避免忙窗内连发被后端拒绝；窗口结束自动补一
//   次 drain，快速结束的短 turn 不会漏发；
// - 可重试错误（chat:done 已发但 turn 锁尚未释放的 session_turn_in_progress /
//   ACP「仍在生成」）延迟重试；达到上限或永久错误时队首标记 blocked、队列暂停，
//   错误已由发送链路上报，用户可手动移除该条后队列自动恢复。

export const QUEUE_DRAIN_RETRY_DELAY_MS = 400;
export const QUEUE_DRAIN_SETTLE_MS = 800;
export const QUEUE_DRAIN_MAX_ATTEMPTS = 3;

/// turn 终态瞬间的锁释放窗口错误（可重试）：原生 = chat:done 发出后
/// terminal_closing 尚未收口（reserve chat turn: session_turn_in_progress）；
/// ACP = prompt 忙窗「ACP 会话仍在生成」/ 配置同步窗「ACP 会话仍在同步」。
/// 其余错误按永久失败处理。
export function isRetriableQueueSendError(error) {
  const text = String(error || '');
  return text.includes('session_turn_in_progress')
    || text.includes('reserve chat turn')
    || text.includes('仍在生成')
    || text.includes('仍在同步');
}

/// 队列条目的一行预览（composer 队列列表用）：消息首行，空消息退化为附件名。
export function queueEntryPreviewText(entry) {
  const message = String((entry && entry.message) || '');
  const firstLine = message.split('\n').find(line => line.trim()) || '';
  if (firstLine) return firstLine;
  const names = Array.isArray(entry && entry.attachmentNames) ? entry.attachmentNames.filter(Boolean) : [];
  if (names.length) return `📎 ${names.join(', ')}`;
  const references = Array.isArray(entry && entry.references) ? entry.references : [];
  if (references.length) return `@${references[0]}`;
  return '';
}

/// 以 sessionId 为作用域的待发送消息队列。可变对象，不做 React 绑定；
/// onChange 由使用方挂版本号重渲染（与 session-conversation store 同一风格）。
/// 条目：{ id, message, attachments, attachmentNames, references, createdAt,
/// attempts, blocked } —— attachments 是 composer 的就绪附件对象（含 result），
/// references 是入队时的工作区引用快照，drain 时原样交回发送链路。
export function createMessageQueueStore() {
  const queues = new Map(); // sessionId -> entry[]
  let nextId = 0;

  function notify() {
    if (typeof store.onChange === 'function') store.onChange();
  }

  function insert(sessionId, fields, front) {
    if (!sessionId) return null;
    const entry = {
      id: ++nextId,
      message: String((fields && fields.message) || ''),
      attachments: Array.isArray(fields && fields.attachments) ? fields.attachments : [],
      attachmentNames: Array.isArray(fields && fields.attachmentNames) ? fields.attachmentNames : [],
      references: Array.isArray(fields && fields.references) ? [...fields.references] : [],
      createdAt: Date.now(),
      attempts: 0,
      blocked: false,
    };
    const queue = queues.get(sessionId) || [];
    if (front) queue.unshift(entry);
    else queue.push(entry);
    queues.set(sessionId, queue);
    notify();
    return entry;
  }

  const store = {
    // 使用方挂版本号重渲染（React 层在挂载后赋值）。
    onChange: null,

    /// 入队尾（queue 语义）。返回条目。
    enqueue: (sessionId, fields) => insert(sessionId, fields, false),

    /// 入队首（steer 插队语义）：先于既有排队消息发送。返回条目。
    enqueueFront: (sessionId, fields) => insert(sessionId, fields, true),

    /// 移除指定条目（用户单条移除 / drain 成功后出队）。返回被移除的条目。
    remove(sessionId, id) {
      const queue = queues.get(sessionId);
      if (!queue) return null;
      const index = queue.findIndex(entry => entry.id === id);
      if (index < 0) return null;
      const [entry] = queue.splice(index, 1);
      if (!queue.length) queues.delete(sessionId);
      notify();
      return entry;
    },

    /// 队首（不出队）。
    peek(sessionId) {
      const queue = queues.get(sessionId);
      return queue && queue.length ? queue[0] : null;
    },

    /// 队列快照（渲染用，副本）。
    list: (sessionId) => [...(queues.get(sessionId) || [])],

    size: (sessionId) => (queues.get(sessionId) || []).length,

    /// 清空指定会话的队列。
    clear(sessionId) {
      if (queues.delete(sessionId)) notify();
    },

    /// 以 sessions 列表为准清理已消失会话的队列，避免无界增长。
    retainSessions(sessionIds) {
      const managed = new Set(sessionIds || []);
      let changed = false;
      for (const id of queues.keys()) {
        if (!managed.has(id)) {
          queues.delete(id);
          changed = true;
        }
      }
      if (changed) notify();
    },
  };

  return store;
}

/// turn 终态后的自动发送控制器。框架无关：忙碌/挂起判定与发送由使用方按调用
/// 注入（lane 参数，视图层绑定到当前 adapter），本身可独立单测。
/// lane = {
///   isBusy(sessionId)：同步忙碌源（原生 = session-conversation store.busy，
///     ACP = turn_started/completed 维护的 busyRef）。adapter.send 绑定的是当前
///     查看会话，视图层对非当前会话一律按“忙”上报，防止发往错误的会话；
///   isHoldback(sessionId)：发送挂起（原生 = plan 审批卡未收口；审批周期视为
///     未完成的交互周期，队列等待用户决策）；
///   send(sessionId, entry) → Promise<{ ok, error? }>：走 adapter 既有发送链路
///     （chat_with_reservation / codex_acp_prompt，checkpoint 钩子照常触发）。
/// }
/// 定时器补调（settle/重试）沿用发起调用的 lane —— 车道与发起时一致，不会
/// 因切会话串到另一车道的 adapter。
export function createQueueDrainController({
  queue,
  onChange,
  now = () => Date.now(),
  schedule = (fn, ms) => setTimeout(fn, ms),
}) {
  let draining = false;
  let settleUntil = 0;

  function notify() {
    if (typeof onChange === 'function') onChange();
  }

  /// 终态/入队/切会话/移除后尝试发送队首。可安全高频调用：忙碌、挂起、
  /// 在途、停口窗口内都会直接返回；永不 reject。
  async function maybeDrain(sessionId, lane = {}) {
    if (!sessionId || draining) return;
    if (now() < settleUntil) return;
    let busy = true;
    let holdback = false;
    try {
      busy = lane.isBusy ? Boolean(lane.isBusy(sessionId)) : false;
      holdback = lane.isHoldback ? Boolean(lane.isHoldback(sessionId)) : false;
    } catch {
      return; // 判定源异常时宁可不发，下一触发点再试
    }
    if (busy || holdback) return;
    const entry = queue.peek(sessionId);
    if (!entry || entry.blocked || entry.attempts >= QUEUE_DRAIN_MAX_ATTEMPTS) return;
    if (typeof lane.send !== 'function') return;
    draining = true;
    try {
      const result = await lane.send(sessionId, entry);
      if (result && result.ok) {
        queue.remove(sessionId, entry.id);
        // 停口窗口：等 turn_started 事件落地（busy 翻转）再放行下一条；
        // 窗口结束补一次 drain，短 turn 在窗口内结束也不漏发。
        settleUntil = now() + QUEUE_DRAIN_SETTLE_MS;
        schedule(() => { maybeDrain(sessionId, lane); }, QUEUE_DRAIN_SETTLE_MS + 50);
        notify();
        return;
      }
      entry.attempts += 1;
      if (isRetriableQueueSendError(result && result.error)
        && entry.attempts < QUEUE_DRAIN_MAX_ATTEMPTS) {
        schedule(() => { maybeDrain(sessionId, lane); }, QUEUE_DRAIN_RETRY_DELAY_MS);
      } else {
        // 永久失败或重试耗尽：队首阻塞、队列暂停（保序，不让后续消息插队），
        // 错误已由发送链路上报；用户移除该条后下一触发点自动恢复。
        entry.blocked = true;
      }
      notify();
    } catch {
      entry.attempts += 1;
      entry.blocked = true;
      notify();
    } finally {
      draining = false;
    }
  }

  return {
    maybeDrain,
    isDraining: () => draining,
  };
}
