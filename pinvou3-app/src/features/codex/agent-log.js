// 会话级 agent log（代码页「运行日志」的纯逻辑，阶段二·可观测）：环形缓冲
// （每会话上限 200 条）按时间序列记录关键事件 —— turn 开始/终态（含耗时）、
// 工具调用（名称+参数摘要+结果状态）、plan 事件、checkpoint 创建/回滚、错误。
//
// 数据源：
// - 原生车道：chat:* 事件流（recordNativeEvent，挂在会话作用域 store 的同一
//   事件入口；checkpoint 创建/回滚由视图层 diff 列表与 restore 回调直写 record）；
// - ACP 车道：acp:event 事件流（recordAcpEvent）。
// 历史种子（重载后日志不空）：原生 = timing_events 的 turn 边界
// （nativeTimelineSeedEntries，一轮一条终态条目），ACP = 持久化 timeline 全量
// 回放（buildAcpSeedEntries）；工具参数等实时细节不回放。
//
// 脱敏：沿用 bridge 先例 —— load_skill 的结果不落 SKILL.md 全文（redacted
// 标记，渲染层出占位文案，对齐 bridge 的 skillContentHidden）；参数/结果一律
// 截断为摘要；敏感键（token/secret/password/key/authorization/cookie 等）
// 的字符串值以 *** 代替。
//
// store 是可变对象，不做 React 绑定；onChange 由使用方挂版本号重渲染
// （与 session-conversation store 同一风格）。

export const AGENT_LOG_CAPACITY = 200;

const SENSITIVE_KEY_RE = /(token|secret|password|passwd|api[-_]?key|apikey|authorization|cookie|credential)/i;
const SUMMARY_MAX_LENGTH = 220;
const REDACT_MAX_DEPTH = 4;

/// 摘要化：字符串直接截断；对象先脱敏再紧凑 JSON 后截断。
function stringifySummary(value) {
  let text;
  if (typeof value === 'string') text = value;
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  text = String(text || '');
  if (text.length > SUMMARY_MAX_LENGTH) return `${text.slice(0, SUMMARY_MAX_LENGTH)}…`;
  return text;
}

/// 递归脱敏：敏感键的字符串值替换为 ***（深度兜底防循环/过深结构）。
export function redactSensitiveFields(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth >= REDACT_MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map(item => redactSensitiveFields(item, depth + 1));
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY_RE.test(key) && typeof item === 'string'
        ? '***'
        : redactSensitiveFields(item, depth + 1);
    }
    return out;
  }
  return value;
}

/// 工具参数摘要（工具卡同款来源，脱敏 + 截断）。
export function summarizeToolArgs(_name, args) {
  if (args === null || args === undefined) return { text: '', redacted: false };
  return { text: stringifySummary(redactSensitiveFields(args)), redacted: false };
}

/// 工具结果摘要。load_skill 沿用 bridge 脱敏先例：返回是 SKILL.md 全文，
/// 日志同样不落全文，由渲染层出占位文案（redacted 标记）。
export function summarizeToolOutput(name, output) {
  if (name === 'load_skill') return { text: '', redacted: true };
  if (output === null || output === undefined) return { text: '', redacted: false };
  return { text: stringifySummary(redactSensitiveFields(output)), redacted: false };
}

function mapAcpToolStatus(status) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed') return 'done';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  return 'running';
}

/// 原生 timing_events（user_start/assistant_done）→ 历史种子：每个已收口的
/// turn 一条终态条目（含真实时间戳与耗时）。未配对的 user_start 不回放 ——
/// 中断的 turn 由实时 chat:done 收口，不在历史里伪造。
export function nativeTimelineSeedEntries(timeline) {
  const entries = [];
  const openByTurnId = new Map();
  for (const event of timeline || []) {
    if (!event || !event.turn_id) continue;
    if (event.event === 'user_start') {
      openByTurnId.set(event.turn_id, event);
    } else if (event.event === 'assistant_done') {
      const open = openByTurnId.get(event.turn_id) || null;
      const startedAt = open ? Number(open.timestamp) || null : null;
      const completedAt = Number(event.timestamp) || Date.now();
      entries.push({
        kind: 'turn',
        phase: 'end',
        at: completedAt,
        status: event.status || null,
        error: event.error || null,
        durationMs: startedAt ? Math.max(0, completedAt - startedAt) : null,
      });
      openByTurnId.delete(event.turn_id);
    }
  }
  return entries;
}

export function createAgentLogStore({ capacity = AGENT_LOG_CAPACITY, onChange } = {}) {
  const buckets = new Map(); // sessionId -> { entries, seq, toolIndex, openTurn }
  const store = { onChange: onChange || null };

  function notify() {
    if (typeof store.onChange === 'function') store.onChange();
  }

  function bucketOf(sessionId) {
    let bucket = buckets.get(sessionId);
    if (!bucket) {
      bucket = { entries: [], seq: 0, toolIndex: new Map(), openTurn: null };
      buckets.set(sessionId, bucket);
    }
    return bucket;
  }

  function pushEntry(bucket, fields) {
    bucket.seq += 1;
    const entry = { id: bucket.seq, at: Number(fields.at) || Date.now(), ...fields };
    bucket.entries.push(entry);
    // 环形淘汰：按事件时间淘汰最旧条目（重放的历史种子不会挤走更新的实时事件）。
    while (bucket.entries.length > capacity) {
      let oldest = 0;
      for (let index = 1; index < bucket.entries.length; index += 1) {
        if (bucket.entries[index].at < bucket.entries[oldest].at) oldest = index;
      }
      bucket.entries.splice(oldest, 1);
    }
    notify();
    return entry;
  }

  /// 直写条目（checkpoint 创建/回滚等视图层事件）。
  store.record = (sessionId, fields) => {
    if (!sessionId || !fields || !fields.kind) return null;
    return pushEntry(bucketOf(sessionId), fields);
  };

  /// 原生车道 chat:* 事件 → 日志条目。payload 带 session_id。
  store.recordNativeEvent = (sessionId, name, payload) => {
    if (!sessionId) return null;
    const p = payload || {};
    const bucket = bucketOf(sessionId);
    const at = Date.now();
    switch (name) {
      case 'chat:turn_started': {
        bucket.openTurn = { startedAt: at };
        return pushEntry(bucket, { kind: 'turn', phase: 'start', at });
      }
      case 'chat:done': {
        const open = bucket.openTurn;
        bucket.openTurn = null;
        return pushEntry(bucket, {
          kind: 'turn',
          phase: 'end',
          at,
          status: p.status || (p.error ? 'Failed' : null),
          error: p.error || null,
          durationMs: open ? Math.max(0, at - open.startedAt) : null,
        });
      }
      case 'chat:tool_start': {
        if (!p.id) return null;
        const args = summarizeToolArgs(p.name, p.args);
        const entry = pushEntry(bucket, {
          kind: 'tool',
          at,
          toolId: p.id,
          name: p.name || '',
          argsSummary: args.text,
          status: 'running',
        });
        bucket.toolIndex.set(p.id, entry);
        return entry;
      }
      case 'chat:tool_end': {
        if (!p.id) return null;
        const meta = p.metadata;
        const blocked = Boolean(meta && meta.safety_level === 'dangerous' && meta.blocked);
        const output = summarizeToolOutput(
          bucket.toolIndex.get(p.id) ? bucket.toolIndex.get(p.id).name : '',
          p.output,
        );
        const entry = bucket.toolIndex.get(p.id) || pushEntry(bucket, {
          kind: 'tool', at, toolId: p.id, name: '', argsSummary: '', status: 'running',
        });
        entry.resultSummary = output.text;
        entry.resultRedacted = output.redacted;
        entry.status = blocked ? 'blocked' : (p.success ? 'done' : 'failed');
        notify();
        return entry;
      }
      case 'chat:shell_task_status': {
        const entry = p.tool_id ? bucket.toolIndex.get(p.tool_id) : null;
        if (!entry) return null;
        entry.status = String(p.status || '') === 'Completed' ? 'done' : 'failed';
        const tail = [p.stdout_tail, p.stderr_tail && `[STDERR] ${p.stderr_tail}`].filter(Boolean).join('\n');
        if (tail) entry.resultSummary = stringifySummary(tail);
        notify();
        return entry;
      }
      case 'chat:plan_ready': {
        const items = p.plan_snapshot && Array.isArray(p.plan_snapshot.items) ? p.plan_snapshot.items.length : 0;
        return pushEntry(bucket, {
          kind: 'plan', phase: 'ready', at, planId: p.plan_id || null, planItems: items,
        });
      }
      case 'chat:plan_resolved': {
        return pushEntry(bucket, { kind: 'plan', phase: 'resolved', at, planId: p.plan_id || null });
      }
      case 'chat:transient_error': {
        if (!p.error) return null;
        return pushEntry(bucket, { kind: 'error', at, summary: String(p.error) });
      }
      case 'chat:compaction': {
        return pushEntry(bucket, {
          kind: 'note', noteKind: 'compaction', phase: p.phase || 'done', at,
          summary: String(p.message || ''),
        });
      }
      default:
        return null;
    }
  };

  /// ACP 车道 acp:event → 日志条目。envelope 带 sessionId/seq/timestamp。
  store.recordAcpEvent = (sessionId, envelope, { seeded = false } = {}) => {
    if (!sessionId || !envelope || !envelope.event) return null;
    const type = envelope.event.type;
    const data = envelope.event.data || {};
    const update = data.update != null ? data.update : data;
    const bucket = bucketOf(sessionId);
    const at = Number(envelope.timestamp) || Date.now();
    switch (type) {
      case 'turn_started': {
        bucket.openTurn = { startedAt: at };
        return pushEntry(bucket, { kind: 'turn', phase: 'start', at, seeded });
      }
      case 'turn_completed': {
        const open = bucket.openTurn;
        bucket.openTurn = null;
        return pushEntry(bucket, {
          kind: 'turn',
          phase: 'end',
          at,
          status: data.status || null,
          error: data.error || null,
          durationMs: open ? Math.max(0, at - open.startedAt) : null,
          seeded,
        });
      }
      case 'tool_call': {
        const toolId = String(update.toolCallId || '');
        if (!toolId) return null;
        const args = update.rawInput !== undefined
          ? summarizeToolArgs(update.title, update.rawInput)
          : { text: '', redacted: false };
        const entry = pushEntry(bucket, {
          kind: 'tool',
          at,
          toolId,
          name: update.title || update.kind || 'tool',
          argsSummary: args.text,
          status: mapAcpToolStatus(update.status),
          seeded,
        });
        bucket.toolIndex.set(toolId, entry);
        return entry;
      }
      case 'tool_call_update': {
        const toolId = String(update.toolCallId || '');
        if (!toolId) return null;
        let entry = bucket.toolIndex.get(toolId);
        if (!entry) {
          entry = pushEntry(bucket, {
            kind: 'tool', at, toolId, name: update.title || update.kind || 'tool',
            argsSummary: '', status: 'running', seeded,
          });
          bucket.toolIndex.set(toolId, entry);
        }
        if (update.title) entry.name = update.title;
        if (update.rawInput !== undefined) entry.argsSummary = summarizeToolArgs(update.title, update.rawInput).text;
        if (update.status) entry.status = mapAcpToolStatus(update.status);
        if (update.rawOutput !== undefined) {
          const output = summarizeToolOutput(entry.name, update.rawOutput);
          entry.resultSummary = output.text;
          entry.resultRedacted = output.redacted;
        }
        notify();
        return entry;
      }
      case 'plan': {
        const items = Array.isArray(update.entries) ? update.entries.length : 0;
        return pushEntry(bucket, { kind: 'plan', phase: 'update', at, planItems: items, seeded });
      }
      case 'permission_requested': {
        const request = data.request || {};
        const toolCall = request.toolCall || {};
        return pushEntry(bucket, {
          kind: 'permission', phase: 'requested', at,
          summary: toolCall.title || '', seeded,
        });
      }
      case 'permission_resolved': {
        return pushEntry(bucket, {
          kind: 'permission', phase: 'resolved', at,
          summary: data.optionId || data.outcome || '', seeded,
        });
      }
      default:
        return null; // 消息流/usage 等高频事件不入日志
    }
  };

  /// 重建历史种子（幂等）：清掉旧种子条目后按最新历史重放，实时条目保留。
  /// 与实时条目重叠的历史（at 不早于最早实时条目）不回放 —— 同一段 turn 在
  /// 进程内已被实时记录，重放会重复。
  store.replaceSeeded = (sessionId, seedEntries) => {
    if (!sessionId) return;
    const bucket = bucketOf(sessionId);
    const liveEntries = bucket.entries.filter(entry => !entry.seeded);
    let liveFloor = null;
    for (const entry of liveEntries) {
      if (liveFloor === null || entry.at < liveFloor) liveFloor = entry.at;
    }
    bucket.entries = liveEntries;
    for (const fields of seedEntries || []) {
      if (liveFloor !== null && Number(fields.at) >= liveFloor) continue;
      pushEntry(bucket, { ...fields, seeded: true });
    }
    notify();
  };

  /// 按事件时间排序的条目快照（渲染用，副本）。
  store.list = (sessionId) => {
    const bucket = buckets.get(sessionId);
    if (!bucket) return [];
    return [...bucket.entries].sort((a, b) => (a.at - b.at) || (a.id - b.id));
  };

  store.size = (sessionId) => {
    const bucket = buckets.get(sessionId);
    return bucket ? bucket.entries.length : 0;
  };

  store.clear = (sessionId) => {
    if (buckets.delete(sessionId)) notify();
  };

  /// 以 sessions 列表为准清理已消失会话的日志，避免无界增长。
  store.retainSessions = (sessionIds) => {
    const managed = new Set(sessionIds || []);
    let changed = false;
    for (const id of buckets.keys()) {
      if (!managed.has(id)) {
        buckets.delete(id);
        changed = true;
      }
    }
    if (changed) notify();
  };

  return store;
}

/// ACP 持久化 timeline → 历史种子：全量事件经同一 recordAcpEvent 映射回放，
/// 与实时记录逻辑单一来源。
export function buildAcpSeedEntries(timeline) {
  const scratch = createAgentLogStore({ capacity: Number.MAX_SAFE_INTEGER });
  for (const envelope of timeline || []) {
    scratch.recordAcpEvent('seed', envelope, { seeded: true });
  }
  return scratch.list('seed').map(({ id, ...fields }) => fields);
}
