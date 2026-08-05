// 原生（品悟 Engine）代码会话的 CodexAcpView adapter。
//
// 从 CodexAcpView 的 isNativeAgent 三元分流收编而来：会话作用域对话状态
// （session-conversation store 挂接、chat:* 事件消费、乐观气泡）、底栏控件
// （模型/工具/知识库/模式，全部直调 per-session 命令、显式 sessionId，不读
// bridge 聊天 active 绑定）、发送/停止/用户输入卡与 deepseek 投影项渲染。
// 视图主体只消费本 adapter 与 acp-code-adapter 的统一接口；确属 UI 差异的分歧
// 集中在 capabilities 声明，不再散落三元。
//
// Plan 降级说明：本期不接 plan_snapshot/accept_plan，切 Plan 后方案以文本/普通
// 工具卡呈现。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invokeTauri as invoke } from '../../platform/tauri/client.js';
import { useSessionConversation } from '../conversation/useSessionConversation.js';
import { ConversationMarkdown } from '../conversation/ConversationTimeline.jsx';
import { QuestionChoiceCard } from '../conversation/QuestionChoiceCard.jsx';
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
}) {
  // 会话作用域对话状态机：chat:* 事件按受管理 sessionId 过滤推进，后台会话的
  // turn 也能继续推进，切回不丢流式内容；version 驱动重渲染。
  const { store, version, bumpVersion } = useSessionConversation({
    onChatEvent: (name, _payload, result) => {
      if (!result.accepted) return;
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
    await refreshNativeControls(id);
    if (isStale()) return null;
    bumpVersion();
    return null;
  }

  /// 原生（品悟 Engine）发送：草稿态先建会话（强制临时工作区），随后走 chat 命令；
  /// 用户气泡乐观插入会话状态，chat 命令同步失败（空消息 / turn 占用等）时回滚。
  async function send(message, readyAttachments) {
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
      const referencePrefix = workspaceReferences.length
        ? `${workspaceReferences.map(path => `@${path}`).join(' ')}\n\n`
        : '';
      const displayText = message + (readyAttachments.length
        ? `${message ? '\n' : ''}📎 ${readyAttachments.map(attachment => attachment.basename).join(', ')}`
        : '');
      const optimisticId = store.appendLocalUserMessage(targetId, displayText);
      bumpVersion();
      autoScrollRef.current = true;
      setShowScrollBottom(false);
      setDraft('');
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
      updateAttachments(targetId, current => current.filter(
        attachment => !readyAttachments.some(ready => ready.id === attachment.id),
      ));
      setWorkspaceReferenceDrafts(current => ({ ...current, [targetId]: [] }));
    } catch (err) {
      showError(err);
      setDraft(message);
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

  // 原生车道 deepseek 投影项渲染：agent_message 用会话状态保存的原始 markdown；
  // user_input 走选择确认卡；careful_blocked 是拦截提示（无需交互）；system 是引擎
  // 透传提示。reasoning / tool_group 由 ConversationTimeline 默认渲染。
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
