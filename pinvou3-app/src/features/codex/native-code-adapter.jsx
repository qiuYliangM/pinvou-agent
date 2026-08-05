// 原生（品悟 Engine）代码会话的 CodexAcpView adapter。
//
// 从 CodexAcpView 的 isNativeAgent 三元分流收编而来：会话作用域对话状态
// （session-conversation store 挂接、chat:* 事件消费、乐观气泡）、底栏控件
// （模型/工具/知识库/模式，全部直调 per-session 命令、显式 sessionId，不读
// bridge 聊天 active 绑定）、发送/停止/用户输入卡与 deepseek 投影项渲染。
// 视图主体只消费本 adapter 与 acp-code-adapter 的统一接口；确属 UI 差异的分歧
// 集中在 capabilities 声明，不再散落三元。
//
// Plan 审批卡：chat:plan_ready → 方案卡（NativePlanCard，步骤列表 + 三键）；
// [就这么干] = accept_plan（切 Yolo + 注入执行指令，Rust 侧补 turn 前
// checkpoint）、[改改] = 预填「修订方案:」继续讨论、[算了] = discard_plan
// （不切模式）。全部显式 sessionId 直调命令，不经 bridge 全局 active 绑定。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invokeTauri as invoke } from '../../platform/tauri/client.js';
import { useSessionConversation } from '../conversation/useSessionConversation.js';
import { ConversationMarkdown } from '../conversation/ConversationTimeline.jsx';
import { QuestionChoiceCard } from '../conversation/QuestionChoiceCard.jsx';
import { hasPendingPlanCard } from '../conversation/session-conversation.js';
import { nativeTimelineSeedEntries } from './agent-log.js';
import { visibleUserModels } from '../../shared/model-options.js';

// 草稿附件键：与 CodexAcpView 的 DRAFT_ATTACHMENT_KEY 一致（草稿 → 新会话的附件移交）。
const DRAFT_ATTACHMENT_KEY = '__codex_draft__';

// 原生（品悟 Engine）会话的选择确认卡：chat:user_input_required → submit_user_input。
// 选项归一化逻辑与主聊天 UserInputCard 对齐（allow_free_text / multi_select），
// 但提交走显式 sessionId，不依赖 bridge 全局 activeSession。
function isFreeTextPlaceholderOption(option) {
  const label = String(option?.label || '').trim();
  return /^(?:其他|其它|other)(?:\s*[\(（][^()（）]*[\)）])?$/i.test(label);
}

function NativeUserInputCard({ item, responding, onSubmitAnswers, onCancelInput, copy, conversationCopy }) {
  const questions = (item.questions || []).map((question, index) => {
    const allowOther = question.allow_free_text !== false;
    return {
      id: question.id || `question-${index + 1}`,
      header: question.header || `Q${index + 1}`,
      question: question.question || '',
      options: (question.options || [])
        .filter(option => !allowOther || !isFreeTextPlaceholderOption(option))
        .map(option => ({
          value: option.label,
          label: option.label,
          description: option.description || '',
        })),
      allowOther,
      multiSelect: Boolean(question.multi_select),
      required: !question.multi_select,
    };
  });
  const actionable = !item.resolved;

  function submit(groups) {
    const answers = groups.flatMap(group => group.answers.map(answer => ({
      id: group.questionId,
      label: answer.other ? (conversationCopy && conversationCopy.otherAnswer) || answer.label : answer.label,
      value: String(answer.value),
    })));
    onSubmitAnswers(item.toolCallId, answers);
  }

  return (
    <QuestionChoiceCard
      title={copy.choiceTitle}
      questions={questions}
      resolved={!actionable}
      submitting={responding}
      submitLabel={copy.submit}
      cancelLabel={copy.cancel}
      otherAnswerLabel={conversationCopy && conversationCopy.otherAnswer}
      inputPlaceholder={conversationCopy && conversationCopy.inputPlaceholder}
      statusText={!actionable
        ? (item.cardState === 'cancelled' ? copy.canceled : copy.submitted)
        : ''}
      onSubmit={submit}
      onCancel={actionable ? () => onCancelInput(item.toolCallId) : undefined}
    />
  );
}

// 原生车道的方案审批卡：chat:plan_ready → 步骤列表 + [就这么干/改改/算了]。
// 视觉对齐聊天页 PlanCard（tool-renderers.jsx，那里锁在闭包里不可 import），
// 按钮回调走显式 sessionId 的 accept_plan/discard_plan，不经 bridge.interaction。
function planStatusSymbol(status) {
  return status === 'completed' ? '●' : status === 'in_progress' ? '◎' : '○';
}

function NativePlanCard({ item, responding, onAccept, onRevise, onDiscard, t, copy }) {
  const active = item.cardState === 'active' && !item.resolved && Boolean(item.planId);
  const statusLabel = {
    accepted: copy.planAccepted,
    discarded: copy.planDiscarded,
    superseded: copy.planSuperseded,
    historical: copy.planHistorical,
  }[item.resolution] || copy.planHistorical;
  const planItems = (item.plan && Array.isArray(item.plan.items) && item.plan.items) || [];
  const todoItems = (item.todos && Array.isArray(item.todos.items) && item.todos.items) || [];
  return (
    <div data-testid="native-plan-card"
      className="rounded-xl border border-[#0B57D0]/20 bg-white px-3.5 py-3 dark:border-[#A8C7FA]/30 dark:bg-white/[0.04]">
      <div className="mb-2 text-[13px] font-semibold text-[#1F1F1F] dark:text-[#E3E3E3]">{t.planReady}</div>
      {planItems.length === 0 && todoItems.length === 0 ? (
        <div className="text-[12px] text-gray-500 dark:text-gray-400">{t.planEmpty}</div>
      ) : (
        <>
          {item.plan && item.plan.explanation && (
            <div className="mb-1.5 text-[12px] text-gray-600 dark:text-gray-300">
              {t.planLabel} · {item.plan.explanation}
            </div>
          )}
          {planItems.length > 0 && (
            <ol className="space-y-0.5 text-[12px] text-gray-600 dark:text-gray-300">
              {planItems.map((step, index) => (
                <li key={index}>{index + 1}. {planStatusSymbol(step.status)} {step.step}</li>
              ))}
            </ol>
          )}
          {todoItems.length > 0 && (
            <>
              <div className="mb-0.5 mt-1.5 text-[11px] font-medium text-gray-400">{t.planTodos}</div>
              <ol className="space-y-0.5 text-[12px] text-gray-600 dark:text-gray-300">
                {todoItems.map((todo, index) => (
                  <li key={index}>{index + 1}. {planStatusSymbol(todo.status)} {todo.content}</li>
                ))}
              </ol>
            </>
          )}
        </>
      )}
      <div className="my-2.5 h-px bg-black/10 dark:bg-white/10" />
      {active ? (
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-[12px] text-gray-500 dark:text-gray-400">{t.planNext}</span>
          <button type="button" data-testid="native-plan-accept" disabled={responding} onClick={onAccept}
            className="h-7 rounded-lg bg-[#007AFF] px-2.5 text-[12px] font-semibold text-white shadow-sm hover:bg-[#006EE6] disabled:opacity-50">
            {t.planGo}
          </button>
          <button type="button" disabled={responding} onClick={onRevise}
            className="h-7 rounded-lg border border-black/[0.08] px-2.5 text-[12px] text-gray-600 hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]">
            {t.planEdit}
          </button>
          <button type="button" data-testid="native-plan-discard" disabled={responding} onClick={onDiscard}
            className="h-7 rounded-lg border border-black/[0.08] px-2.5 text-[12px] text-gray-600 hover:bg-black/[0.04] disabled:opacity-50 dark:border-white/10 dark:text-gray-300 dark:hover:bg-white/[0.06]">
            {t.planDrop}
          </button>
        </div>
      ) : (
        <div className="text-[12px] font-medium text-[#137333] dark:text-[#93D5A6]">{statusLabel}</div>
      )}
    </div>
  );
}

export function useNativeCodeAdapter({
  active,
  activeId,
  activeIdRef,
  sessions,
  draftWorkspacePath,
  t,
  bs,
  codexCopy,
  working,
  setWorking,
  responding,
  setResponding,
  setError,
  showError,
  setDraft,
  workspaceReferences,
  updateAttachments,
  setAttachmentDrafts,
  setWorkspaceReferenceDrafts,
  autoScrollRef,
  setShowScrollBottom,
  createSession,
  refreshSessions,
  agentLog,
}) {
  // 会话作用域对话状态机：chat:* 事件按受管理 sessionId 过滤推进，后台会话的
  // turn 也能继续推进，切回不丢流式内容；version 驱动重渲染。
  const { store, version, bumpVersion } = useSessionConversation({
    onChatEvent: (name, _payload, result) => {
      if (!result.accepted) return;
      // 会话级 agent log：与对话状态机同一事件入口记录关键事件（turn/工具/plan/错误）。
      if (agentLog) agentLog.recordNativeEvent(result.sessionId, name, _payload);
      // turn 边界顺手刷新会话列表（标题/时间戳），与 acp:event 的 turn_completed 处理对齐。
      if (name === 'chat:turn_started' || name === 'chat:done') {
        refreshSessions().catch(() => {});
      }
      if (result.changed && result.sessionId === activeIdRef.current) bumpVersion();
    },
  });

  // 以 sessions 列表为准重建受管理会话集合（事件过滤白名单），并清理已删除会话
  // 的状态，避免 store 无界增长。
  useEffect(() => {
    store.retainSessions(
      sessions
        .filter(session => session && session.agent_id === 'pinvou')
        .map(session => session.id),
    );
  }, [sessions, store]);

  // 原生车道底栏控件（模型/工具/知识库/模式）的会话态：按 activeId 经 invoke 自查，
  // 不读 bridge 聊天 active 绑定（bs.currentSessionModelId/modeState/mountedCollection
  // 都绑聊天 active）。草稿态暂存 nativeDraftControls，建会话成功后再应用。
  const [nativeControls, setNativeControls] = useState({ modelId: null, mountedId: null, mode: 'yolo' });
  const [nativeDraftControls, setNativeDraftControls] = useState({});
  // nativeControls 的会话归属：切会话后、refresh 返回前不展示上一会话的控件值。
  const nativeControlsSessionRef = useRef(null);
  // 知识库选择器的集合列表与 embedding 安装态（全局只读查询，不带会话）。
  const [kbCollections, setKbCollections] = useState([]);
  const [kbInstalled, setKbInstalled] = useState(null); // null=未知(不门控)

  // 原生车道才加载知识库集合与 embedding 安装态；embedding 明确未装时选择器禁用。
  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    invoke('kb_collection_list')
      .then(list => { if (alive) setKbCollections(Array.isArray(list) ? list : []); })
      .catch(() => { if (alive) setKbCollections([]); });
    invoke('kb_model_status')
      .then(status => { if (alive) setKbInstalled(status ? Boolean(status.installed) : true); })
      .catch(() => { if (alive) setKbInstalled(true); });
    return () => { alive = false; };
  }, [active]);

  const conversationState = active && activeId ? store.peekState(activeId) : null;
  const projection = useMemo(
    () => (active ? store.project(activeId) : null),
    // version 是会话内容变化的版本号（状态本体是可变对象，靠版本号触发重投影）。
    [active, store, activeId, conversationState, version],
  );
  const turns = projection ? projection.turns : [];
  const busy = Boolean(conversationState && conversationState.busy);
  const sessionReady = !activeId || Boolean(conversationState && conversationState.hydrated);

  /// 拉取原生会话的模型/知识库/模式状态（全部 per-session 命令，显式 sessionId）。
  /// 返回 modeState（loadSession 还原挂起方案卡要用 pending_plan_id）。
  async function refreshNativeControls(sessionId) {
    const [modelId, mountedId, modeState] = await Promise.all([
      invoke('get_session_model_id', { sessionId }).catch(() => null),
      invoke('session_mounted_collection', { sessionId }).catch(() => null),
      invoke('get_mode_state', { sessionId }).catch(() => null),
    ]);
    setNativeControls({
      modelId: modelId || null,
      mountedId: mountedId ?? null,
      mode: (modeState && modeState.mode) || 'yolo',
    });
    nativeControlsSessionRef.current = sessionId;
    return modeState || null;
  }

  /// 草稿态暂存的控件选择在新会话上应用；失败报错不静默（逐个应用，mode 最后）。
  async function applyNativeDraftControls(sessionId) {
    const staged = nativeDraftControls;
    const hasStaged = staged.modelId || staged.mountedId != null || staged.mode;
    if (!hasStaged) return;
    try {
      if (staged.modelId) {
        await invoke('set_session_model', { sessionId, modelId: staged.modelId });
      }
      if (staged.mountedId != null) {
        await invoke('session_mount_collection', { sessionId, collectionId: staged.mountedId });
      }
      if (staged.mode === 'plan') {
        await invoke('set_plan_mode_next', { sessionId });
      }
      setNativeDraftControls({});
    } catch (err) {
      showError(err);
    }
  }

  /// 切模型：set_session_model 会 evict 该会话 engine，会话 busy 时由控件禁用兜底。
  async function switchNativeModel(sessionId, modelId) {
    if (!sessionId) {
      setNativeDraftControls(current => ({ ...current, modelId }));
      return;
    }
    setError('');
    try {
      await invoke('set_session_model', { sessionId, modelId });
      await refreshNativeControls(sessionId);
    } catch (err) { showError(err); }
  }

  async function mountNativeKb(collectionId) {
    if (!activeId) {
      setNativeDraftControls(current => ({ ...current, mountedId: collectionId }));
      return;
    }
    setError('');
    try {
      await invoke('session_mount_collection', { sessionId: activeId, collectionId });
      await refreshNativeControls(activeId);
    } catch (err) { showError(err); }
  }

  async function unmountNativeKb() {
    if (!activeId) {
      setNativeDraftControls(current => ({ ...current, mountedId: null }));
      return;
    }
    setError('');
    try {
      await invoke('session_unmount_collection', { sessionId: activeId });
      await refreshNativeControls(activeId);
    } catch (err) { showError(err); }
  }

  /// Plan↔Yolo：对齐聊天页语义——切回 Yolo 时若 turn 在跑先取消
  /// （用代码车道已有的 cancel_generation 显式 sessionId 调用，不经 bridge）。
  async function switchNativeMode(target, { isPlan, busy: chipBusy } = {}) {
    if (!activeId) {
      setNativeDraftControls(current => ({ ...current, mode: target }));
      return;
    }
    setError('');
    try {
      if (target === 'plan' && !isPlan) {
        await invoke('set_plan_mode_next', { sessionId: activeId });
      } else if (target === 'yolo' && isPlan) {
        if (chipBusy) await invoke('cancel_generation', { sessionId: activeId });
        await invoke('exit_plan_to_yolo', { sessionId: activeId });
      }
      await refreshNativeControls(activeId);
    } catch (err) { showError(err); }
  }

  // 原生（品悟）会话：历史与 turn timeline 来自 SavedSession / timing_events，
  // 不走 ACP 的 timeline / pending / session_info 命令。
  async function loadSession(id, isStale) {
    const [saved, sessionTimeline] = await Promise.all([
      invoke('load_session', { id, setActive: false }),
      invoke('get_session_timeline', { sessionId: id }).catch(() => []),
    ]);
    if (isStale()) return null;
    store.hydrate(id, saved, sessionTimeline || []);
    // agent log 历史种子：timing_events 的 turn 边界回填（幂等重建，实时事件保留）。
    if (agentLog) agentLog.replaceSeeded(id, nativeTimelineSeedEntries(sessionTimeline || []));
    // 会话状态随组件卸载销毁，chat:user_input_required 不重发：经后端 pending
    // 登记还原挂起的确认卡（store 按 toolCallId 幂等去重），
    // 并顺带恢复 turn 进行中的 busy 展示。
    const pendingState = await invoke('get_pending_user_inputs', { sessionId: id })
      .catch(() => null);
    if (isStale()) return null;
    if (pendingState) {
      (pendingState.pending || []).forEach(request => {
        store.handleChatEvent('chat:user_input_required', {
          session_id: id,
          id: request.id,
          questions: request.questions,
        });
      });
      const state = store.getState(id);
      if (pendingState.busy && !state.busy) {
        state.busy = true;
        state.thinking = { active: true, startedAt: Date.now(), phase: 'thinking', toolName: null };
      }
    }
    const modeState = await refreshNativeControls(id);
    // 还原挂起的方案审批卡：chat:plan_ready 不重发；ticket（pending_plan_id）仍在
    // 时按消息流里最后一次 update_plan 的参数重建可操作卡（store 幂等去重）。
    if (!isStale() && modeState && modeState.pending_plan_id) {
      store.restorePendingPlan(id, modeState.pending_plan_id);
    }
    if (isStale()) return null;
    bumpVersion();
    return null;
  }

  /// 原生（品悟 Engine）发送：草稿态先建会话（强制临时工作区），随后走 chat 命令；
  /// 用户气泡乐观插入会话状态，chat 命令同步失败（空消息 / turn 占用等）时回滚。
  /// options.fromQueue = 队列 drain 自动发送：不动用户当前草稿与附件/引用草稿
  /// （入队时已从 composer 摘除），失败不回填草稿，结果经返回值交给 drain 控制器。
  /// options.workspaceReferences = 入队时的引用快照（缺省用当前 composer 值）。
  /// 返回 { ok, error? }：drain 据此决定出队 / 重试 / 阻塞。
  async function send(message, readyAttachments, options = {}) {
    const fromQueue = Boolean(options && options.fromQueue);
    const references = (options && options.workspaceReferences) || workspaceReferences;
    setWorking(true); setError('');
    try {
      let targetId = activeId;
      if (!targetId) {
        const created = await createSession(draftWorkspacePath);
        targetId = created.id;
        // 草稿态暂存的模型/知识库/模式选择先落到新会话（失败会显式报错）。
        await applyNativeDraftControls(targetId);
        setAttachmentDrafts(current => {
          const draftAttachments = current[DRAFT_ATTACHMENT_KEY] || [];
          const next = { ...current, [targetId]: draftAttachments };
          delete next[DRAFT_ATTACHMENT_KEY];
          return next;
        });
        setWorkspaceReferenceDrafts(current => {
          const draftReferences = current[DRAFT_ATTACHMENT_KEY] || [];
          const next = { ...current, [targetId]: draftReferences };
          delete next[DRAFT_ATTACHMENT_KEY];
          return next;
        });
      }
      const referencePrefix = references.length
        ? `${references.map(path => `@${path}`).join(' ')}\n\n`
        : '';
      const displayText = message + (readyAttachments.length
        ? `${message ? '\n' : ''}📎 ${readyAttachments.map(attachment => attachment.basename).join(', ')}`
        : '');
      const optimisticId = store.appendLocalUserMessage(targetId, displayText);
      bumpVersion();
      autoScrollRef.current = true;
      setShowScrollBottom(false);
      if (!fromQueue) setDraft('');
      try {
        await invoke('chat', {
          message: referencePrefix + message,
          attachments: readyAttachments.map(attachment => attachment.result),
          sessionId: targetId,
          restrictTools: false,
        });
      } catch (sendError) {
        store.removeLocalUserMessage(targetId, optimisticId);
        bumpVersion();
        throw sendError;
      }
      if (!fromQueue) {
        updateAttachments(targetId, current => current.filter(
          attachment => !readyAttachments.some(ready => ready.id === attachment.id),
        ));
        setWorkspaceReferenceDrafts(current => ({ ...current, [targetId]: [] }));
      }
      return { ok: true };
    } catch (err) {
      showError(err);
      if (!fromQueue) setDraft(message);
      return { ok: false, error: String(err) };
    } finally {
      setWorking(false);
    }
  }

  async function cancel() {
    if (!activeId) return;
    await invoke('cancel_generation', { sessionId: activeId }).catch(showError);
  }

  /// 原生会话的选择确认卡提交/取消：chat:user_input_required → submit_user_input /
  /// cancel_user_input（显式 sessionId，不经过 bridge 全局 activeSession）。
  async function respondInput(toolCallId, answers) {
    if (!activeId) return;
    setResponding(true); setError('');
    try {
      await invoke('submit_user_input', { toolCallId, answers, sessionId: activeId });
      store.markUserInputResolved(activeId, toolCallId, 'submitted');
      bumpVersion();
    } catch (err) { showError(err); }
    finally { setResponding(false); }
  }

  async function cancelInput(toolCallId) {
    if (!activeId) return;
    setResponding(true); setError('');
    try {
      await invoke('cancel_user_input', { toolCallId, sessionId: activeId });
      store.markUserInputResolved(activeId, toolCallId, 'cancelled');
      bumpVersion();
    } catch (err) { showError(err); }
    finally { setResponding(false); }
  }

  // ── Plan 审批卡（accept_plan / discard_plan，显式 sessionId）────────────
  // 语义对齐聊天页 bridge 的 interaction acceptPlan/discardPlan，但全部直调命令：
  // 乐观收口卡片 → 调用失败时按错误码分流（plan_not_active = ticket 已被别处
  // 消费 → 冻结为历史卡；其余错误 → 卡片恢复可操作并显式报错）。

  /// [✅ 就这么干]：accept_plan = 切 Yolo + 注入「立即执行 + 方案全文」指令；
  /// 用户气泡乐观插入（chat:user_message 回声按 localEchoTs 去重）。
  async function acceptPlan(item) {
    const sessionId = activeId;
    const planId = String((item && item.planId) || '').trim();
    if (!sessionId || !planId) return;
    const echo = t.planGo || '✅ 就这么干';
    setResponding(true); setError('');
    store.markPlanResolved(sessionId, planId, 'accepted');
    const optimisticId = store.appendLocalUserMessage(sessionId, echo);
    autoScrollRef.current = true;
    setShowScrollBottom(false);
    bumpVersion();
    try {
      await invoke('accept_plan', {
        sessionId,
        planId,
        planMarkdown: item.planMarkdown || '',
        displayMessage: echo,
      });
      // accept 后 mode 已切 Yolo：刷新底栏模式控件。
      await refreshNativeControls(sessionId);
    } catch (err) {
      store.removeLocalUserMessage(sessionId, optimisticId);
      if (String(err || '').includes('plan_not_active')) {
        store.markPlanResolved(sessionId, planId, 'historical');
      } else {
        store.reopenPlanCard(sessionId, planId);
        showError(err);
      }
      bumpVersion();
    } finally {
      setResponding(false);
    }
  }

  /// [🚪 算了]：discard_plan 只关卡片不切模式（继续讨论）；后端同时广播
  /// chat:plan_resolved，多端（如远程控制）的同名卡同步冻结。
  async function discardPlan(item) {
    const sessionId = activeId;
    const planId = String((item && item.planId) || '').trim();
    if (!sessionId || !planId) return;
    setResponding(true); setError('');
    store.markPlanResolved(sessionId, planId, 'discarded');
    bumpVersion();
    try {
      await invoke('discard_plan', { sessionId, planId });
    } catch (err) {
      if (String(err || '').includes('plan_not_active')) {
        store.markPlanResolved(sessionId, planId, 'historical');
      } else {
        store.reopenPlanCard(sessionId, planId);
        showError(err);
      }
      bumpVersion();
    } finally {
      setResponding(false);
    }
  }

  /// [✏️ 改改]：不切 phase，仅预填「修订方案:」前缀（对齐底座做法：plan 模式
  /// 下发的新消息自带隐式修订语义）。
  function revisePlan() {
    setDraft(t.planRevisePrefill || '修订方案:');
  }

  // 原生车道 deepseek 投影项渲染：agent_message 用会话状态保存的原始 markdown；
  // user_input 走选择确认卡；plan_card 走方案审批卡；careful_blocked 是拦截提示
  // （无需交互）；system 是引擎透传提示。reasoning / tool_group 由
  // ConversationTimeline 默认渲染。
  function renderItem(item) {
    if (item.type === 'agent_message' && item.legacyItem) {
      return (
        <ConversationMarkdown
          text={item.legacyItem.text}
          onOpenExternal={(url) => invoke('open_user_external_url', { url }).catch(showError)}
        />
      );
    }
    if (item.type === 'user_input' && item.legacyItem) {
      return (
        <NativeUserInputCard
          item={item.legacyItem}
          responding={responding}
          onSubmitAnswers={respondInput}
          onCancelInput={cancelInput}
          copy={codexCopy}
          conversationCopy={t.uiConversation}
        />
      );
    }
    if (item.type === 'plan' && item.extensionType === 'plan_card' && item.legacyItem) {
      return (
        <NativePlanCard
          item={item.legacyItem}
          responding={responding}
          onAccept={() => acceptPlan(item.legacyItem)}
          onRevise={revisePlan}
          onDiscard={() => discardPlan(item.legacyItem)}
          t={t}
          copy={codexCopy}
        />
      );
    }
    if (item.type === 'permission' && item.extensionType === 'careful_blocked') {
      return (
        <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-600 dark:text-red-300">
          {codexCopy.nativeBlockedNotice}
        </div>
      );
    }
    if (item.type === 'system_notice' && item.legacyItem) {
      const legacy = item.legacyItem;
      if (legacy.compactPhase) {
        const label = legacy.compactPhase === 'start'
          ? codexCopy.compactStart
          : legacy.compactPhase === 'fail'
            ? codexCopy.compactFail
            : codexCopy.compactDone;
        return (
          <div className="px-1 text-[11px] text-gray-400">
            {label}{legacy.text ? ` · ${legacy.text}` : ''}
          </div>
        );
      }
      return <div className="px-1 text-[11px] text-gray-400">{legacy.text}</div>;
    }
    return undefined;
  }

  // 底栏控件的展示值（归属保护：refresh 返回前按默认/暂存显示）。
  const modeValue = activeId && nativeControlsSessionRef.current === activeId
    ? nativeControls.mode
    : (activeId ? 'yolo' : (nativeDraftControls.mode || 'yolo'));
  const modelChoices = visibleUserModels((bs && bs.savedModels) || [])
    .map(model => ({ value: model.id, name: model.name || model.id }));
  const sessionModelId = activeId
    ? (nativeControlsSessionRef.current === activeId ? nativeControls.modelId : null)
    : (nativeDraftControls.modelId || null);
  const modelValue = sessionModelId || (bs && bs.activeModelId) || '';
  const mountedId = activeId
    ? (nativeControlsSessionRef.current === activeId ? nativeControls.mountedId : null)
    : (nativeDraftControls.mountedId ?? null);
  const kbChoices = [
    { value: '', name: t.kbMountRemove },
    ...kbCollections.map(collection => ({
      value: String(collection.id),
      name: collection.name,
    })),
  ];

  return {
    kind: 'native',
    store,
    version,
    bumpVersion,
    registerSession: id => store.registerSession(id),
    // 确属 UI 差异的分歧点集中在 capabilities：原生会话没有 ACP 登录/安装状态机
    // （错误由 chat:done 事件内联展示）、没有 ACP 账号菜单与配置组，底栏是原生
    // 模型/知识库/模式控件组；turns 强制走统一 ConversationTimeline 渲染。
    capabilities: {
      runtimeNotice: false,
      accountMenu: false,
      sessionSyncingHint: false,
      acpComposerControls: false,
      nativeComposerControls: true,
      forceUnifiedTurns: true,
      requiresAuthToSend: false,
      // turn 边界 checkpoint 入口（Rust 侧 chat 命令在 turn 开始前打快照）。
      checkpoints: true,
      // 运行中消息 queue/steer 与会话级 agent log（阶段二·会话控制与可观测）。
      messageQueue: true,
      agentLog: true,
      welcomeHints: { active: codexCopy.nativeActiveHint, draft: codexCopy.nativeDraftHint },
    },
    turns,
    busy,
    sessionReady,
    runtimeBusy: false,
    sendDisabled: false,
    attentionCount: 0,
    availableCommands: [],
    configApplying: '',
    workspaceRefreshToken: version,
    // 原生会话没有 ACP 权限/elicitation 登记；统一接口处给空值（不会触达渲染）。
    pendingByTool: {},
    pendingByElicitation: {},
    activeStatus: null,
    respond: undefined,
    respondElicitation: undefined,
    loadSession,
    send,
    cancel,
    renderItem,
    // 队列 drain 的同步判定源：busy 直接读会话作用域 store（事件入口同步推进，
    // 不受渲染帧延迟影响）；holdback = plan 审批卡未收口（审批周期不自动发送）。
    isBusy: id => {
      const state = store.peekState(id);
      return Boolean(state && state.busy);
    },
    isQueueHoldback: id => hasPendingPlanCard(store.peekState(id)),
    composer: {
      modeValue,
      modelValue,
      modelChoices,
      modelDisabled: busy || working,
      modelTitle: busy || working ? t.modelSwitchBusy : undefined,
      mountedValue: mountedId == null ? '' : String(mountedId),
      kbChoices,
      kbDisabled: kbInstalled === false,
      kbTitle: kbInstalled === false ? t.kbMountNoModel : t.kbMountTitle,
      onModeChange: target => switchNativeMode(String(target), { isPlan: modeValue === 'plan', busy }),
      onModelChange: modelId => switchNativeModel(activeId, String(modelId)),
      onKbChange: value => (String(value) === '' ? unmountNativeKb() : mountNativeKb(Number(value))),
    },
  };
}
