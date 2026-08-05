// 会话作用域对话状态机（前端原语）：以 sessionId 为作用域，统一承载
// chat:* 事件消费（按 sessionId 过滤）、乐观气泡、回声去重与 busy/pending 态。
//
// 由代码原生车道（code-native-lane.js）提取上提：单会话部分（createConversationState
// /applyChatEvent/hydrateConversation/appendLocalUserMessage 等）与 lane 原实现逐行同源，
// 本模块在其上加「会话作用域 store」——会话注册、事件过滤、多会话状态缓存——供
// 代码页（CodexAcpView 原生车道）以及后续聊天页共用。渲染统一走
// projectConversation → projectDeepSeekConversation → ConversationTimeline。
//
// state.items 是 bridge chatItems 的兼容子集：user / assistant(text) / reasoning /
// tool / user_input / plan_card / careful_blocked / system。与 bridge 的差异：assistant 保留
// 原始 markdown 文本（bridge 存预渲染 html），渲染层用 ConversationMarkdown。

import { projectDeepSeekConversation } from './deepseek-conversation.js';
import { composePlanMarkdown, lastPlanSnapshotFromItems } from './plan-card.js';

/// store 消费的 engine chat 事件全集；payload 一律带 session_id（后端 forwarder 打 tag）。
export const SESSION_CHAT_EVENTS = [
  'chat:user_message',
  'chat:turn_started',
  'chat:reasoning_start',
  'chat:reasoning_delta',
  'chat:reasoning_done',
  'chat:delta',
  'chat:tool_start',
  'chat:tool_delta',
  'chat:tool_end',
  'chat:shell_task_status',
  'chat:compaction',
  'chat:usage',
  'chat:user_input_required',
  'chat:plan_ready',
  'chat:plan_resolved',
  'chat:transient_error',
  'chat:done',
];

// ── 单会话对话状态（原 native lane，逐行同源）─────────────────────────────

export function createConversationState() {
  return {
    hydrated: false,
    items: [],
    busy: false,
    thinking: null,
    tokens: { input: 0, max: 0 },
    timeline: [],
    streamId: 0,
    streamText: '',
    toolMeta: {},
    seq: 0,
  };
}

function nextId(state) {
  state.seq += 1;
  return state.seq;
}

function timeStr() {
  return new Date().toTimeString().slice(0, 5);
}

function visibleUserTurnIndex(state) {
  const count = state.items.filter(item => item && item.type === 'user').length;
  return Math.max(0, count - 1);
}

function openTimelineStart(state, withinMs = 0) {
  const open = [...state.timeline]
    .reverse()
    .find(event => event.event === 'user_start'
      && !state.timeline.some(other => other.event === 'assistant_done' && other.turn_id === event.turn_id));
  if (!open) return null;
  if (withinMs > 0 && Math.abs(Date.now() - Number(open.timestamp || 0)) > withinMs) return null;
  return open;
}

function recordTurnStarted(state, turnId) {
  state.timeline.push({
    turn_id: turnId || `ui_native_${Date.now()}`,
    event: 'user_start',
    timestamp: Date.now(),
    ui_turn_index: visibleUserTurnIndex(state),
  });
}

function recordTurnCompleted(state, payload) {
  const open = openTimelineStart(state);
  if (!open) return;
  state.timeline.push({
    turn_id: open.turn_id,
    event: 'assistant_done',
    timestamp: Date.now(),
    status: payload && payload.status || (payload && payload.error ? 'Failed' : 'Completed'),
    error: payload && payload.error || null,
    ui_turn_index: open.ui_turn_index,
  });
}

function finalizeStream(state) {
  if (!state.streamId) return;
  const item = state.items.find(candidate => candidate.id === state.streamId);
  if (item) item.streaming = false;
  state.streamId = 0;
  state.streamText = '';
}

function finalizeReasoning(state) {
  const completedAt = Date.now();
  for (const item of state.items) {
    if (item && item.type === 'reasoning' && item.streaming) {
      item.streaming = false;
      item.completedAt = completedAt;
    }
  }
}

/// 发送前乐观插入用户气泡并记录 turn 起点；chat 命令同步失败时用
/// removeLocalUserMessage 回滚。返回临时 item id。
export function appendLocalUserMessage(state, text) {
  const id = nextId(state);
  state.items.push({ id, type: 'user', text: String(text || ''), time: timeStr(), localEchoTs: Date.now() });
  recordTurnStarted(state);
  state.busy = true;
  state.thinking = { active: true, startedAt: Date.now(), phase: 'thinking', toolName: null };
  return id;
}

export function removeLocalUserMessage(state, id) {
  state.items = state.items.filter(item => item.id !== id);
  // 该 turn 未被 engine 接纳（不会有 assistant_done），把乐观记录的 user_start 一并回滚。
  const open = openTimelineStart(state);
  if (open) state.timeline = state.timeline.filter(event => event !== open);
  state.busy = false;
  state.thinking = null;
}

/// chat:* 事件 → 会话状态。payload 一律带 session_id（后端 forwarder 打 tag）。
/// 返回是否有可视变化；无变化时 React 侧不必 bump 渲染。
export function applyChatEvent(state, name, payload) {
  const p = payload || {};
  switch (name) {
    case 'chat:user_message': {
      const content = String(p.content || '');
      if (!content) return false;
      const lastUser = [...state.items].reverse().find(item => item && item.type === 'user');
      if (lastUser) {
        // 本地乐观插入已覆盖：文本一致，或刚发送（本地气泡带 📎 附件名等展示
        // 修饰，与后端回声文本不同）30 秒内视为同一消息的回声。
        if (lastUser.text === content
          || (lastUser.localEchoTs && Date.now() - lastUser.localEchoTs < 30000)) {
          delete lastUser.localEchoTs;
          return false;
        }
      }
      state.items.push({ id: nextId(state), type: 'user', text: content, time: timeStr() });
      recordTurnStarted(state);
      state.busy = true;
      state.thinking = { active: true, startedAt: Date.now(), phase: 'thinking', toolName: null };
      return true;
    }
    case 'chat:turn_started': {
      state.busy = true;
      if (!state.thinking || !state.thinking.active) {
        state.thinking = { active: true, startedAt: Date.now(), phase: 'thinking', toolName: null };
      }
      // 本地乐观插入 / chat:user_message 已记录起点时，60 秒内复用不重复记。
      if (!openTimelineStart(state, 60000)) recordTurnStarted(state, p.turn_id);
      return true;
    }
    case 'chat:reasoning_start': {
      finalizeStream(state);
      finalizeReasoning(state);
      state.items.push({
        id: nextId(state),
        type: 'reasoning',
        text: '',
        streaming: true,
        startedAt: Date.now(),
        completedAt: null,
      });
      return true;
    }
    case 'chat:reasoning_delta': {
      const text = String(p.text || '');
      if (!text) return false;
      let item = [...state.items].reverse().find(candidate => (
        candidate && candidate.type === 'reasoning' && candidate.streaming
      ));
      if (!item) {
        applyChatEvent(state, 'chat:reasoning_start', p);
        item = state.items[state.items.length - 1];
      }
      item.text += text;
      return true;
    }
    case 'chat:reasoning_done': {
      finalizeReasoning(state);
      state.items = state.items.filter(item => !(
        item && item.type === 'reasoning' && !item.streaming && !item.text
      ));
      return true;
    }
    case 'chat:delta': {
      const text = String(p.text || '');
      if (!text) return false;
      finalizeReasoning(state);
      state.streamText += text;
      const existing = state.items.find(item => item.id === state.streamId);
      if (existing) {
        existing.text = state.streamText;
        existing.streaming = true;
      } else {
        state.streamId = nextId(state);
        state.items.push({
          id: state.streamId,
          type: 'assistant',
          text: state.streamText,
          time: timeStr(),
          streaming: true,
        });
      }
      return true;
    }
    case 'chat:tool_start': {
      if (!p.id) return false;
      state.toolMeta[p.id] = { name: p.name, args: p.args };
      finalizeReasoning(state);
      finalizeStream(state);
      state.thinking = { active: true, startedAt: state.thinking?.startedAt || Date.now(), phase: 'tool', toolName: p.name || null };
      // request_user_input 不渲染工具卡，等 chat:user_input_required 的选择卡片。
      if (p.name === 'request_user_input') return true;
      if (state.items.some(item => item && item.type === 'tool' && item.toolId === p.id)) return false;
      state.items.push({
        id: nextId(state),
        type: 'tool',
        toolId: p.id,
        name: p.name || '',
        args: p.args,
        output: null,
        success: null,
        state: 'running',
      });
      return true;
    }
    case 'chat:tool_delta': {
      const item = [...state.items].reverse().find(candidate => (
        candidate && candidate.type === 'tool' && candidate.toolId === p.id
      ));
      if (!item || !p.content) return false;
      item.output = String(item.output || '') + String(p.content);
      return true;
    }
    case 'chat:tool_end': {
      const meta = state.toolMeta[p.id];
      delete state.toolMeta[p.id];
      state.thinking = state.busy
        ? { active: true, startedAt: state.thinking?.startedAt || Date.now(), phase: 'thinking', toolName: null }
        : null;
      if (meta && meta.name === 'request_user_input') {
        const card = [...state.items].reverse().find(item => (
          item && item.type === 'user_input' && item.toolCallId === p.id && !item.resolved
        ));
        if (card) {
          card.resolved = true;
          card.cardState = p.success ? 'submitted' : 'cancelled';
        }
        return true;
      }
      const item = [...state.items].reverse().find(candidate => (
        candidate && candidate.type === 'tool' && candidate.toolId === p.id
      ));
      if (item) {
        item.output = typeof p.output === 'string' ? p.output : JSON.stringify(p.output);
        item.success = Boolean(p.success);
        item.state = 'done';
      }
      // Careful 拦截：metadata.safety_level==='dangerous' 且 blocked → 拦截提示卡。
      const md = p.metadata;
      if (md && md.safety_level === 'dangerous' && md.blocked) {
        state.items.push({ id: nextId(state), type: 'careful_blocked', args: meta && meta.args, metadata: md, time: timeStr() });
      }
      return true;
    }
    case 'chat:usage': {
      const input = Number(p.input_tokens || 0);
      if (input <= 0) return false;
      state.tokens = { input, max: state.tokens.max };
      return true;
    }
    case 'chat:user_input_required': {
      const questions = Array.isArray(p.questions) ? p.questions : [];
      if (!p.id || !questions.length) return false;
      if (state.items.some(item => item && item.type === 'user_input' && item.toolCallId === p.id)) return false;
      state.items.push({
        id: nextId(state),
        type: 'user_input',
        toolCallId: p.id,
        questions,
        resolved: false,
        cardState: 'active',
        time: timeStr(),
      });
      return true;
    }
    case 'chat:plan_ready': {
      // Plan 模式 turn 收口：方案审批卡（语义对齐聊天页 bridge 的 plan_card，
      // resolution 是代码，本地化文案在渲染层按 codexCopy 映射）。
      const planId = String(p.plan_id || '').trim();
      if (planId && state.items.some(item => (
        item && item.type === 'plan_card' && String(item.planId || '') === planId
      ))) return false;
      // 新方案出现 → 旧的 active 方案卡冻结为「已被新方案覆盖」。
      for (const item of state.items) {
        if (item && item.type === 'plan_card' && item.cardState === 'active') {
          item.cardState = 'resolved';
          item.resolution = 'superseded';
          item.resolved = true;
        }
      }
      const snapshots = { plan: p.plan_snapshot || null, todos: p.todos_snapshot || null };
      state.items.push({
        id: nextId(state),
        type: 'plan_card',
        planId: planId || null,
        plan: snapshots.plan,
        todos: snapshots.todos,
        planMarkdown: composePlanMarkdown(snapshots),
        cardState: planId ? 'active' : 'resolved',
        resolution: planId ? null : 'historical',
        resolved: !planId,
        time: timeStr(),
      });
      return true;
    }
    case 'chat:plan_resolved': {
      // 方案在别处被收口（如远程控制 discard）：本地未收口的同 ticket 卡同步冻结。
      const planId = String(p.plan_id || '').trim();
      if (!planId) return false;
      let changed = false;
      for (const item of state.items) {
        if (item && item.type === 'plan_card' && String(item.planId || '') === planId && !item.resolved) {
          item.cardState = 'resolved';
          item.resolution = 'discarded';
          item.resolved = true;
          changed = true;
        }
      }
      return changed;
    }
    case 'chat:transient_error': {
      if (!p.error) return false;
      const notice = `⚠️ ${p.error}`;
      if (state.items.some(item => item && item.type === 'system' && item.text === notice)) return false;
      state.items.push({ id: nextId(state), type: 'system', text: notice, time: timeStr() });
      return true;
    }
    case 'chat:shell_task_status': {
      // 后台 shell 任务终态（语义对齐 bridge finishBackgroundToolItem）：
      // 把对应工具卡更新为最终状态并合并 stdout/stderr 尾段。
      const item = [...state.items].reverse().find(candidate => (
        candidate && candidate.type === 'tool' && candidate.toolId === p.tool_id
      ));
      if (!item) return false;
      const status = String(p.status || 'Failed');
      const success = status === 'Completed';
      item.success = success;
      item.state = success ? 'done' : 'failed';
      item.exitCode = p.exit_code ?? null;
      const tail = [p.stdout_tail, p.stderr_tail && `[STDERR] ${p.stderr_tail}`]
        .filter(Boolean)
        .join('\n');
      if (tail) item.output = item.output ? `${item.output}\n${tail}` : tail;
      return true;
    }
    case 'chat:compaction': {
      // 压缩事件渲染为系统提示项；三语文案在渲染层按 compactPhase 组装。
      const phase = String(p.phase || 'done');
      state.items.push({
        id: nextId(state),
        type: 'system',
        compactPhase: phase,
        text: String(p.message || ''),
        time: timeStr(),
      });
      return true;
    }
    case 'chat:done': {
      finalizeReasoning(state);
      finalizeStream(state);
      recordTurnCompleted(state, p);
      state.busy = false;
      state.thinking = null;
      if (p.error) {
        state.items.push({ id: nextId(state), type: 'system', text: `⚠️ ${p.error}`, time: timeStr() });
      }
      return true;
    }
    default:
      return false;
  }
}

function messageText(blocks) {
  return blocks
    .filter(block => block && block.type === 'text' && block.text)
    .map(block => String(block.text))
    .join('\n')
    .trim();
}

/// SavedSession messages → state.items（hydration 是 rerenderFromMessages 的精简版：
/// 覆盖 user / assistant text / thinking / tool_use+tool_result / request_user_input；
/// persona、成品卡等主聊天专属形态不在代码会话出现，不做还原。历史方案卡不还原
/// （update_plan 本身已作为工具卡呈现）；仍挂起的方案 ticket 由
/// `restorePendingPlan` 按消息流里最后一次 update_plan 参数单独重建）。
export function hydrateConversation(state, saved, timelineEvents = []) {
  // 同窗口切回正在跑的会话时，state 已被 chat:* 事件推进过：磁盘快照（只落已提交
  // 内容）会滞后于实时状态，hydration 后保留 busy，由后续事件继续推进；冷启动
  // 首次 hydration 时 state 无任何 live 痕迹，未配对的 user_start 只能按中断展示。
  const hadLiveTurn = Boolean(
    state.busy
      || state.streamId
      || (state.thinking && state.thinking.active)
      || Object.keys(state.toolMeta).length > 0,
  );
  const messages = saved && Array.isArray(saved.messages) ? saved.messages : [];
  const resultById = {};
  for (const message of messages) {
    const blocks = Array.isArray(message && message.content) ? message.content : [];
    for (const block of blocks) {
      if (block && block.type === 'tool_result') {
        resultById[block.tool_use_id] = { content: block.content, is_error: Boolean(block.is_error) };
      }
    }
  }
  state.items = [];
  state.streamId = 0;
  state.streamText = '';
  state.toolMeta = {};
  for (const message of messages) {
    const role = message && message.role;
    const raw = message && message.content;
    const blocks = Array.isArray(raw)
      ? raw
      : (typeof raw === 'string' && raw ? [{ type: 'text', text: raw }] : []);
    if (role === 'user') {
      const text = messageText(blocks);
      if (text) state.items.push({ id: nextId(state), type: 'user', text, time: '' });
      for (const block of blocks) {
        if (!block || block.type !== 'tool_result') continue;
        const item = [...state.items].reverse().find(candidate => (
          candidate && candidate.type === 'tool' && candidate.toolId === block.tool_use_id
        ));
        if (item) {
          item.output = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
          item.success = !block.is_error;
          item.state = 'done';
        }
      }
      continue;
    }
    if (role !== 'assistant') continue;
    let textBuf = '';
    const flushText = () => {
      if (!textBuf) return;
      state.items.push({ id: nextId(state), type: 'assistant', text: textBuf, time: '', streaming: false });
      textBuf = '';
    };
    for (const block of blocks) {
      if (!block) continue;
      if (block.type === 'text') {
        textBuf += block.text || '';
      } else if (block.type === 'thinking') {
        flushText();
        const reasoning = String(block.thinking || block.text || '');
        if (reasoning) {
          state.items.push({ id: nextId(state), type: 'reasoning', text: reasoning, streaming: false, startedAt: null, completedAt: null });
        }
      } else if (block.type === 'tool_use') {
        flushText();
        if (block.name === 'request_user_input') {
          const questions = (block.input && block.input.questions) || [];
          if (Array.isArray(questions) && questions.length) {
            const result = resultById[block.id];
            state.items.push({
              id: nextId(state),
              type: 'user_input',
              toolCallId: block.id,
              questions,
              resolved: true,
              cardState: result && result.is_error ? 'cancelled' : 'submitted',
              time: '',
            });
          }
          continue;
        }
        state.items.push({
          id: nextId(state),
          type: 'tool',
          toolId: block.id,
          name: block.name || '',
          args: block.input,
          output: null,
          success: null,
          state: 'pending',
        });
      }
    }
    flushText();
  }
  // 未被 tool_result 回填的工具卡按失败收尾，避免历史里残留"执行中"。
  for (const item of state.items) {
    if (item && item.type === 'tool' && item.state !== 'done') {
      item.state = 'done';
      item.success = item.success === null ? false : item.success;
    }
  }
  state.timeline = Array.isArray(timelineEvents) ? [...timelineEvents] : [];
  state.busy = hadLiveTurn;
  if (!state.busy) state.thinking = null;
  state.hydrated = true;
  return state;
}

/// state → ConversationTimeline 使用的 turn 投影。
export function projectConversation(state, sessionId) {
  return projectDeepSeekConversation({
    chatItems: state ? state.items : [],
    busy: Boolean(state && state.busy),
    thinking: state ? state.thinking : null,
    tokens: state ? state.tokens : null,
    sessionId,
    timelineEvents: state ? state.timeline : [],
  });
}

/// 用户输入卡提交/取消后的本地收口（与 chat:tool_end 的收口语义一致）。
export function markUserInputResolved(state, toolCallId, cardState) {
  const card = state && [...state.items].reverse().find(item => (
    item && item.type === 'user_input' && item.toolCallId === toolCallId && !item.resolved
  ));
  if (!card) return false;
  card.resolved = true;
  card.cardState = cardState;
  return true;
}

/// 方案卡本地收口：accept/discard 调用前后把卡片置为终态（resolution ∈
/// 'accepted' | 'discarded' | 'historical'）。按 planId 定位（不限未收口卡），
/// 乐观标记后 plan_not_active 再改判历史卡也走这里。
export function markPlanResolved(state, planId, resolution) {
  const card = state && [...state.items].reverse().find(item => (
    item && item.type === 'plan_card' && String(item.planId || '') === String(planId || '')
  ));
  if (!card) return false;
  card.cardState = 'resolved';
  card.resolution = resolution;
  card.resolved = true;
  return true;
}

/// accept/discard 失败（非 plan_not_active）时把卡片恢复为可操作态。
export function reopenPlanCard(state, planId) {
  const card = state && [...state.items].reverse().find(item => (
    item && item.type === 'plan_card' && String(item.planId || '') === String(planId || '')
  ));
  if (!card) return false;
  card.cardState = 'active';
  card.resolution = null;
  card.resolved = false;
  return true;
}

/// 重载还原挂起的方案卡：chat:plan_ready 不重发，ticket（pending_plan_id）仍在
/// 时按消息流里最后一次 update_plan 的参数重建可操作卡。快照本体不落盘——
/// 若消息流里找不到 update_plan 参数（极端：历史被压缩），卡片退化为空方案卡，
/// 仍可 accept/discard 收口 ticket。
export function restorePendingPlan(state, planId) {
  const ticket = String(planId || '').trim();
  if (!ticket) return false;
  if (state.items.some(item => (
    item && item.type === 'plan_card' && String(item.planId || '') === ticket
  ))) return false;
  const snapshots = { plan: lastPlanSnapshotFromItems(state.items), todos: null };
  state.items.push({
    id: nextId(state),
    type: 'plan_card',
    planId: ticket,
    plan: snapshots.plan,
    todos: null,
    planMarkdown: composePlanMarkdown(snapshots),
    cardState: 'active',
    resolution: null,
    resolved: false,
    time: '',
  });
  return true;
}

// ── 会话作用域 store ─────────────────────────────────────────────────────
//
// 以 sessionId 为作用域管理一组会话的对话状态：
// - registerSession / retainSessions 维护受管理会话集合（事件过滤白名单 +
//   已删除会话的状态清理，避免无界增长）；
// - handleChatEvent 按 sessionId 过滤并推进对应会话状态；
// - 乐观气泡 / hydration / 输入卡收口 / 投影都走会话作用域入口。
// store 本体是可变对象，不做 React 绑定；React 侧由 useSessionConversation
// 挂事件订阅并以版本号触发重渲染（见 useSessionConversation.js）。

export function createSessionConversationStore() {
  const states = new Map();
  const managedIds = new Set();

  function isManaged(sessionId) {
    return managedIds.has(sessionId);
  }

  function registerSession(sessionId) {
    if (sessionId) managedIds.add(sessionId);
  }

  /// 以 sessions 列表为准重建受管理集合，并清理已消失会话的状态。
  function retainSessions(sessionIds) {
    managedIds.clear();
    for (const id of sessionIds || []) registerSession(id);
    for (const id of states.keys()) {
      if (!managedIds.has(id)) states.delete(id);
    }
  }

  /// 取会话状态（懒创建）；仅对受管理会话调用。
  function getState(sessionId) {
    let state = states.get(sessionId);
    if (!state) {
      state = createConversationState();
      states.set(sessionId, state);
    }
    return state;
  }

  /// 取会话状态但不创建（渲染路径用，避免为空会话占位）。
  function peekState(sessionId) {
    return states.get(sessionId) || null;
  }

  /// chat:* 事件入口：按受管理 sessionId 过滤后推进对应会话。
  /// 返回 { accepted, changed, sessionId }；accepted=false 表示事件被过滤。
  function handleChatEvent(name, payload) {
    const sessionId = payload && payload.session_id;
    if (!sessionId || !managedIds.has(sessionId)) {
      return { accepted: false, changed: false, sessionId: sessionId || null };
    }
    const changed = applyChatEvent(getState(sessionId), name, payload);
    return { accepted: true, changed, sessionId };
  }

  return {
    isManaged,
    registerSession,
    retainSessions,
    getState,
    peekState,
    handleChatEvent,
    appendLocalUserMessage(sessionId, text) {
      return appendLocalUserMessage(getState(sessionId), text);
    },
    removeLocalUserMessage(sessionId, id) {
      removeLocalUserMessage(getState(sessionId), id);
    },
    hydrate(sessionId, saved, timelineEvents) {
      return hydrateConversation(getState(sessionId), saved, timelineEvents);
    },
    markUserInputResolved(sessionId, toolCallId, cardState) {
      return markUserInputResolved(getState(sessionId), toolCallId, cardState);
    },
    markPlanResolved(sessionId, planId, resolution) {
      return markPlanResolved(getState(sessionId), planId, resolution);
    },
    reopenPlanCard(sessionId, planId) {
      return reopenPlanCard(getState(sessionId), planId);
    },
    restorePendingPlan(sessionId, planId) {
      return restorePendingPlan(getState(sessionId), planId);
    },
    project(sessionId) {
      return projectConversation(peekState(sessionId), sessionId);
    },
  };
}
