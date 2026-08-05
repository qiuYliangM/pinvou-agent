// ACP（Codex/Claude/Kimi 等子进程托管）代码会话的 CodexAcpView adapter。
//
// 从 CodexAcpView 的 isNativeAgent 三元分流收编而来：ACP 事件流（acp:event →
// timeline 投影）、pending 权限/-elicitation、session_info 与草稿态配置快照、
// 运行时安装/登录状态机、发送/停止/权限应答与 deepseek 投影外的 elicitation
// 渲染。视图主体只消费本 adapter 与 native-code-adapter 的统一接口；确属 UI
// 差异的分歧集中在 capabilities 声明，不再散落三元。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { invokeTauri as invoke, listenTauri } from '../../platform/tauri/client.js';
import {
  appendAcpEvent,
  projectAcpTimeline,
  resolveAcpSessionControls,
} from './acp-state.js';
import {
  classifyAcpServiceFailure,
  isAcpAuthenticationFailure,
  runtimeOperationFor,
} from './runtimeNoticeState.js';
import { QuestionChoiceCard } from '../conversation/QuestionChoiceCard.jsx';

const DRAFT_CONTROLS_CACHE_KEY = 'pinvou_codex_draft_controls';
const DRAFT_ATTACHMENT_KEY = '__codex_draft__';

// 草稿态（尚未创建会话）也需要展示模型/权限模式/推理强度等选项：ACP 的配置项是会话级的，
// 这里缓存每个 agent 最近一次会话上报的配置快照，供新会话草稿预展示和预选。
function loadDraftControlsCache() {
  try {
    const value = JSON.parse(localStorage.getItem(DRAFT_CONTROLS_CACHE_KEY) || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function snapshotSessionControls(info) {
  if (!info) return null;
  const snapshot = {
    models: Array.isArray(info.models) ? info.models : [],
    current_model_id: info.current_model_id || '',
    modes: info.modes || null,
    config_options: Array.isArray(info.config_options) ? info.config_options : [],
  };
  if (!snapshot.models.length && !snapshot.modes && !snapshot.config_options.length) return null;
  return snapshot;
}

function rememberDraftControls(agentId, info) {
  const snapshot = snapshotSessionControls(info);
  if (!agentId || !snapshot) return null;
  const cache = { ...loadDraftControlsCache(), [agentId]: snapshot };
  try {
    localStorage.setItem(DRAFT_CONTROLS_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // 缓存写不进去时仅影响下次草稿预展示，本次会话不受影响。
  }
  return snapshot;
}

function configChoices(option) {
  const raw = option && option.options;
  if (!Array.isArray(raw)) return [];
  if (raw.every(item => item && Array.isArray(item.options))) {
    return raw.flatMap(group => group.options || []);
  }
  return raw;
}

function configLabel(option, copy) {
  const labels = copy?.configLabels || {};
  switch (option && option.id) {
    case 'mode': return labels.mode || '';
    case 'collaboration_mode': return labels.collaboration_mode || '';
    case 'model': return labels.model || '';
    case 'reasoning_effort': return labels.reasoning_effort || '';
    case 'fast-mode': return labels['fast-mode'] || '';
    default: return option && option.name || '';
  }
}

function ElicitationCard({ elicitation, pending, onRespond, responding, copy, conversationCopy }) {
  const request = elicitation.request || {};
  const schema = request.requestedSchema || {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = Object.entries(schema.properties || {});
  const otherFields = new Map(fields
    .filter(([, field]) => field && field._meta && field._meta.codex && field._meta.codex.isOtherAnswer)
    .map(([id, field]) => [String(field._meta.codex.questionId || ''), { id, field }]));
  const questions = fields.filter(([, field]) => (
    !(field && field._meta && field._meta.codex && field._meta.codex.isOtherAnswer)
  ));
  const actionable = !!pending && !elicitation.resolved;

  function choices(field) {
    if (Array.isArray(field && field.oneOf)) {
      return field.oneOf.map(option => ({
        value: option && option.const,
        label: option && (option.title || option.const),
        description: option && option.description,
      })).filter(option => option.value != null);
    }
    if (Array.isArray(field && field.enum)) {
      return field.enum.map(value => ({ value, label: String(value), description: '' }));
    }
    return [];
  }

  const normalizedQuestions = questions.map(([id, field]) => {
    const other = otherFields.get(id);
    return {
      id,
      answerKey: id,
      otherAnswerKey: other && other.id,
      header: field.title || id,
      question: field.description || '',
      options: choices(field),
      allowOther: Boolean(other),
      otherPlaceholder: other && (other.field.title || (conversationCopy && conversationCopy.otherPlaceholder)),
      required: required.has(id)
        || Boolean(field && field._meta && field._meta.codex && field._meta.codex.isOther),
      inputType: field.type || 'string',
      secret: Boolean(field && field._meta && field._meta.codex && field._meta.codex.isSecret),
    };
  });

  function submit(groups) {
    const content = {};
    for (const group of groups) {
      const custom = group.answers.find(answer => answer.other);
      if (custom && group.otherAnswerKey) {
        content[group.otherAnswerKey] = custom.value;
      } else if (group.multiSelect) {
        content[group.answerKey] = group.answers.map(answer => answer.value);
      } else if (group.answers[0]) {
        content[group.answerKey] = group.answers[0].value;
      }
    }
    onRespond(elicitation.elicitationId, 'accept', content);
  }

  return (
    <QuestionChoiceCard
      title={copy.choiceTitle}
      description={request.message && request.message !== 'Input requested' ? request.message : ''}
      questions={normalizedQuestions}
      resolved={!actionable}
      submitting={responding}
      submitLabel={copy.submit}
      cancelLabel={copy.cancel}
      otherAnswerLabel={conversationCopy && conversationCopy.otherAnswer}
      inputPlaceholder={conversationCopy && conversationCopy.inputPlaceholder}
      statusText={!actionable
        ? elicitation.resolved
          ? (elicitation.action === 'accept' ? copy.submitted : copy.canceled)
          : copy.inputExpired
        : ''}
      onSubmit={submit}
      onCancel={actionable
        ? () => onRespond(elicitation.elicitationId, 'cancel', {})
        : undefined}
    />
  );
}

export { ElicitationCard };

export function useAcpCodeAdapter({
  active,
  activeId,
  activeIdRef,
  activeAgentId,
  activeAgentIdRef,
  draftAgentId,
  sessions,
  draftWorkspacePath,
  t,
  codexCopy,
  working,
  setWorking,
  responding,
  setResponding,
  setSessionLoading,
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
  const [status, setStatus] = useState(null);
  const [events, setEvents] = useState([]);
  const [pending, setPending] = useState([]);
  const [pendingElicitations, setPendingElicitations] = useState([]);
  const [sessionInfo, setSessionInfo] = useState(null);
  const [sessionInfoSessionId, setSessionInfoSessionId] = useState(null);
  const [configApplying, setConfigApplying] = useState('');
  const [runtimeOperations, setRuntimeOperations] = useState({});
  const [runtimeErrors, setRuntimeErrors] = useState({});
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [dismissedFailureKey, setDismissedFailureKey] = useState('');
  const [draftControlsCache, setDraftControlsCache] = useState(loadDraftControlsCache);
  // 草稿态（会话未创建）下用户预选的配置：{ [agentId]: { model?, mode?, configs: { [id]: value } } }
  const [draftConfigSelections, setDraftConfigSelections] = useState({});

  const projection = useMemo(() => projectAcpTimeline(events), [events]);
  // 草稿态（!activeId）没有会话，退回使用该 agent 缓存的配置快照来预展示选项。
  const draftControlsInfo = !activeId ? draftControlsCache[draftAgentId] || null : null;
  const sessionControlsInfo = sessionInfoSessionId === activeId ? sessionInfo : null;
  const controls = useMemo(
    () => resolveAcpSessionControls(sessionControlsInfo || draftControlsInfo),
    [sessionControlsInfo, draftControlsInfo],
  );
  const draftConfigSelection = draftConfigSelections[draftAgentId] || null;
  const composerControlsVisible = Boolean(sessionControlsInfo || draftControlsInfo);
  // 有会话时以会话上报为准；草稿态优先显示用户预选，其次显示缓存快照里的当前值。
  const composerModelValue = sessionControlsInfo
    ? sessionControlsInfo.current_model_id || ''
    : (draftConfigSelection && draftConfigSelection.model)
      || (draftControlsInfo && draftControlsInfo.current_model_id)
      || '';
  const composerModeValue = sessionControlsInfo
    ? controls.effectiveMode || ''
    : (draftConfigSelection && draftConfigSelection.mode) || controls.effectiveMode || '';
  function composerConfigOptionValue(option) {
    if (sessionControlsInfo) return option.currentValue || '';
    const staged = draftConfigSelection && draftConfigSelection.configs
      ? draftConfigSelection.configs[option.id]
      : undefined;
    return staged !== undefined ? String(staged) : (option.currentValue || '');
  }
  const availableCommands = useMemo(() => {
    const event = [...projection.global].reverse().find(item => item.event && item.event.type === 'available_commands');
    const data = event && event.event && event.event.data || {};
    const update = data.update || data;
    return Array.isArray(update.availableCommands) ? update.availableCommands : [];
  }, [projection.global]);
  const pendingByTool = useMemo(() => Object.fromEntries(pending.map(item => [item.toolCallId, item])), [pending]);
  const pendingByElicitation = useMemo(
    () => Object.fromEntries(pendingElicitations.map(item => [item.elicitationId, item])),
    [pendingElicitations],
  );
  const activeStatus = status?.agent_id === activeAgentId ? status : null;
  const activeRuntimeOperation = runtimeOperationFor(runtimeOperations, activeAgentId);
  const activeRuntimeBusy = Boolean(activeRuntimeOperation);
  const activeRuntimeError = runtimeErrors[activeAgentId] || '';
  const serviceFailure = useMemo(() => {
    const latestCompleted = [...events]
      .reverse()
      .find(envelope => envelope?.event?.type === 'turn_completed');
    return classifyAcpServiceFailure(latestCompleted);
  }, [events]);
  const visibleServiceFailure = serviceFailure?.key === dismissedFailureKey
    ? null
    : serviceFailure;

  const turns = projection.turns;
  const busy = projection.turns.some(turn => turn.status === 'running');
  const sessionReady = !activeId || (sessionInfoSessionId === activeId && Boolean(sessionInfo));

  function applySessionInfo(info, sessionId = activeIdRef.current) {
    if (sessionId !== activeIdRef.current) return info;
    setSessionInfo(info);
    setSessionInfoSessionId(sessionId || null);
    const agentId = activeAgentIdRef.current;
    const snapshot = rememberDraftControls(agentId, info);
    if (snapshot) {
      setDraftControlsCache(current => ({ ...current, [agentId]: snapshot }));
    }
    return info;
  }

  function stageDraftConfigSelection(patch) {
    setDraftConfigSelections(current => {
      const prev = current[draftAgentId] || {};
      const next = {
        model: patch.model !== undefined ? patch.model : prev.model,
        mode: patch.mode !== undefined ? patch.mode : prev.mode,
        configs: { ...(prev.configs || {}), ...(patch.configs || {}) },
      };
      return { ...current, [draftAgentId]: next };
    });
  }

  // 首次发送创建会话后，把草稿态预选的模型/权限模式/配置应用到新会话。
  // 以新会话实际上报的 config_options 为准自适应：走 config 的项用 set_config_option，
  // 否则退回 set_model/set_mode；与当前值相同或会话未暴露的项跳过。
  async function applyDraftConfigSelections(targetId, info) {
    const staged = draftConfigSelections[draftAgentId];
    if (!staged) return info;
    let current = info || null;
    const currentOptionValue = (configId) => {
      const options = current && Array.isArray(current.config_options) ? current.config_options : [];
      const option = options.find(item => item && item.id === configId);
      return option ? String(option.currentValue ?? '') : null;
    };
    try {
      if (staged.model) {
        const viaConfig = currentOptionValue('model') !== null;
        const currentValue = viaConfig
          ? currentOptionValue('model')
          : String(current && current.current_model_id || '');
        if (String(staged.model) !== currentValue) {
          current = viaConfig
            ? await invoke('set_codex_acp_config_option', { sessionId: targetId, configId: 'model', valueId: staged.model })
            : await invoke('set_codex_acp_model', { sessionId: targetId, modelId: staged.model });
        }
      }
      if (staged.mode) {
        const viaConfig = currentOptionValue('mode') !== null;
        const currentValue = viaConfig
          ? currentOptionValue('mode')
          : String(current && current.modes && current.modes.currentModeId || '');
        if (String(staged.mode) !== currentValue) {
          current = viaConfig
            ? await invoke('set_codex_acp_config_option', { sessionId: targetId, configId: 'mode', valueId: staged.mode })
            : await invoke('set_codex_acp_mode', { sessionId: targetId, modeId: staged.mode });
        }
      }
      for (const [configId, valueId] of Object.entries(staged.configs || {})) {
        const optionValue = currentOptionValue(configId);
        if (optionValue === null || optionValue === String(valueId)) continue;
        current = await invoke('set_codex_acp_config_option', { sessionId: targetId, configId, valueId });
      }
    } catch (err) {
      showError(err);
    }
    return current;
  }

  async function refreshStatus(agentId = activeAgentId, recheck = false) {
    // recheck=true 强制后端忽略缓存重新探测（「重新检测」按钮）；轮询不传，保持读缓存。
    const next = await invoke('get_acp_agent_status', recheck ? { agentId, recheck: true } : { agentId });
    if (next?.agent_id === activeAgentIdRef.current) setStatus(next);
    return next;
  }

  function resetConversation() {
    setEvents([]);
    setPending([]);
    setPendingElicitations([]);
    setSessionInfo(null);
    setSessionInfoSessionId(null);
  }

  /// 仅清 session_info（loadSession 起始处用）：timeline/pending 保留到新数据
  /// 到达，避免切会话闪烁。
  function resetSessionInfo() {
    setSessionInfo(null);
    setSessionInfoSessionId(null);
  }

  async function loadSession(id, isStale) {
    const [timeline, permissions, elicitations] = await Promise.all([
      invoke('get_codex_acp_timeline', { sessionId: id }),
      invoke('get_codex_acp_pending_permissions', { sessionId: id }),
      invoke('get_codex_acp_pending_elicitations', { sessionId: id }),
    ]);
    if (isStale()) return null;
    setEvents(timeline || []);
    setPending(permissions || []);
    setPendingElicitations(elicitations || []);
    const session = sessions.find(item => item.id === id);
    const runtime = await invoke('get_acp_agent_status', {
      agentId: session?.agent_id || draftAgentId,
    });
    if (isStale()) return null;
    if (runtime?.agent_id === activeAgentIdRef.current) setStatus(runtime);
    if (runtime.installed && runtime.node_supported) {
      try {
        const info = await invoke('get_codex_acp_session_info', { sessionId: id });
        if (isStale()) return null;
        return applySessionInfo(info, id);
      } catch (err) {
        if (!isStale()) showError(err);
      }
    }
    return null;
  }

  async function send(message, readyAttachments) {
    setWorking(true); setError('');
    try {
      let targetId = activeId;
      if (!targetId) {
        const created = await createSession(draftWorkspacePath);
        targetId = created.id;
        const appliedInfo = await applyDraftConfigSelections(targetId, created.info);
        if (appliedInfo && appliedInfo !== created.info) applySessionInfo(appliedInfo, targetId);
        setDraftConfigSelections(current => {
          const next = { ...current };
          delete next[draftAgentId];
          return next;
        });
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
      autoScrollRef.current = true;
      setShowScrollBottom(false);
      setDraft('');
      await invoke('codex_acp_prompt', {
        sessionId: targetId,
        message,
        attachments: readyAttachments.map(attachment => attachment.result),
        workspaceReferences,
      });
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
    await invoke('cancel_codex_acp', { sessionId: activeId }).catch(showError);
  }

  async function respond(toolCallId, optionId) {
    if (!activeId) return;
    setResponding(true); setError('');
    try {
      await invoke('respond_codex_acp_permission', { sessionId: activeId, toolCallId, optionId });
      setPending(current => current.filter(item => item.toolCallId !== toolCallId));
    } catch (err) { showError(err); }
    finally { setResponding(false); }
  }

  async function respondElicitation(elicitationId, action, content) {
    if (!activeId) return;
    setResponding(true); setError('');
    try {
      await invoke('respond_codex_acp_elicitation', {
        sessionId: activeId,
        elicitationId,
        action,
        content,
      });
      setPendingElicitations(current => current.filter(
        item => item.elicitationId !== elicitationId,
      ));
    } catch (err) { showError(err); }
    finally { setResponding(false); }
  }

  async function changeModel(modelId) {
    if (!modelId || activeRuntimeBusy) return;
    if (!activeId) {
      stageDraftConfigSelection({ model: modelId });
      return;
    }
    setWorking(true); setConfigApplying('model');
    try { applySessionInfo(await invoke('set_codex_acp_model', { sessionId: activeId, modelId })); }
    catch (err) { showError(err); }
    finally { setWorking(false); setConfigApplying(''); }
  }

  async function changeConfig(configId, valueId) {
    if (activeRuntimeBusy) return;
    if (!activeId) {
      stageDraftConfigSelection({ configs: { [configId]: valueId } });
      return;
    }
    setWorking(true); setConfigApplying(configId); setError('');
    try {
      applySessionInfo(await invoke('set_codex_acp_config_option', {
        sessionId: activeId, configId, valueId,
      }));
    } catch (err) { showError(err); }
    finally { setWorking(false); setConfigApplying(''); }
  }

  async function changeMode(modeId) {
    if (!modeId || activeRuntimeBusy) return;
    if (!activeId) {
      stageDraftConfigSelection({ mode: modeId });
      return;
    }
    setWorking(true); setConfigApplying('mode'); setError('');
    try {
      applySessionInfo(await invoke('set_codex_acp_mode', { sessionId: activeId, modeId }));
    } catch (err) { showError(err); }
    finally { setWorking(false); setConfigApplying(''); }
  }

  function beginRuntimeOperation(agentId, operation) {
    setRuntimeOperations(current => ({ ...current, [agentId]: operation }));
    setRuntimeErrors(current => ({ ...current, [agentId]: '' }));
  }

  function finishRuntimeOperation(agentId, operation) {
    setRuntimeOperations(current => {
      if (current[agentId] !== operation) return current;
      const next = { ...current };
      delete next[agentId];
      return next;
    });
  }

  function showRuntimeError(agentId, nextError) {
    console.error(`${agentId} runtime operation failed:`, nextError);
    const message = codexCopy.showRawErrors ? String(nextError) : codexCopy.operationFailed;
    setRuntimeErrors(current => ({ ...current, [agentId]: message }));
  }

  async function install(actionOverride = null) {
    const agentId = activeAgentId;
    beginRuntimeOperation(agentId, 'install');
    setError('');
    const poll = window.setInterval(() => refreshStatus(agentId).catch(() => {}), 500);
    try {
      const payload = { agent: agentId };
      if (typeof actionOverride === 'string' && actionOverride) payload.action = actionOverride;
      const next = await invoke('install_acp_agent', payload);
      if (next?.agent_id === activeAgentIdRef.current) setStatus(next);
    }
    catch (err) { showRuntimeError(agentId, err); }
    finally {
      window.clearInterval(poll);
      await refreshStatus(agentId).catch(() => {});
      finishRuntimeOperation(agentId, 'install');
    }
  }

  async function login() {
    const agentId = activeAgentId;
    beginRuntimeOperation(agentId, 'login');
    setError('');
    try {
      const next = await invoke('login_acp_agent', { agentId });
      if (next?.agent_id === activeAgentIdRef.current) setStatus(next);
    }
    catch (err) { showRuntimeError(agentId, err); }
    finally { finishRuntimeOperation(agentId, 'login'); }
  }

  async function switchAccount() {
    const agentId = activeAgentId;
    setAccountMenuOpen(false);
    if (serviceFailure?.key) setDismissedFailureKey(serviceFailure.key);
    beginRuntimeOperation(agentId, 'switch-account');
    setError('');
    try {
      const next = await invoke('switch_acp_agent_account', { agentId });
      if (next?.agent_id === activeAgentIdRef.current) setStatus(next);
    } catch (err) {
      showRuntimeError(agentId, err);
    } finally {
      finishRuntimeOperation(agentId, 'switch-account');
    }
  }

  async function openLogin() {
    const agentId = activeAgentId;
    setRuntimeErrors(current => ({ ...current, [agentId]: '' }));
    try { await invoke('open_acp_agent_login_url', { agentId }); }
    catch (err) { showRuntimeError(agentId, err); }
  }

  async function submitLoginCode(code) {
    const agentId = activeAgentId;
    setRuntimeErrors(current => ({ ...current, [agentId]: '' }));
    try {
      await invoke('submit_acp_agent_login_code', { agentId, code });
      await refreshStatus(agentId);
    } catch (err) {
      showRuntimeError(agentId, err);
    }
  }

  function renderItem(item) {
    return item.type === 'elicitation'
      ? (
          <ElicitationCard
            elicitation={item.elicitation}
            pending={pendingByElicitation[item.elicitation.elicitationId]}
            onRespond={respondElicitation}
            responding={responding}
            copy={codexCopy}
            conversationCopy={t.uiConversation}
          />
        )
      : undefined;
  }

  // ACP 事件流：只推进当前会话的 timeline 与 pending 登记（原生会话不产生
  // acp:event，过滤语义与原实现一致）；turn 边界/权限应答顺手刷新会话列表。
  useEffect(() => {
    let unlisten = null;
    listenTauri('acp:event', message => {
      const incoming = message.payload;
      setEvents(current => incoming && incoming.sessionId === activeIdRef.current ? appendAcpEvent(current, incoming) : current);
      if (incoming && incoming.sessionId === activeIdRef.current) {
        const type = incoming.event && incoming.event.type;
        const data = incoming.event && incoming.event.data || {};
        if (type === 'permission_requested') {
          setPending(current => [...current.filter(item => item.toolCallId !== data.toolCallId), {
            sessionId: incoming.sessionId, toolCallId: data.toolCallId, request: data.request,
          }]);
        } else if (type === 'elicitation_requested') {
          setPendingElicitations(current => [
            ...current.filter(item => item.elicitationId !== data.elicitationId),
            {
              sessionId: incoming.sessionId,
              elicitationId: data.elicitationId,
              request: data.request,
            },
          ]);
        } else if (type === 'elicitation_resolved') {
          setPendingElicitations(current => current.filter(
            item => item.elicitationId !== data.elicitationId,
          ));
        } else if (type === 'permission_resolved' || type === 'turn_completed') {
          if (type === 'permission_resolved') setPending(current => current.filter(item => item.toolCallId !== data.toolCallId));
          refreshSessions().catch(() => {});
        } else if (type === 'runtime_ready') {
          invoke('get_codex_acp_session_info', { sessionId: incoming.sessionId })
            .then(info => applySessionInfo(info, incoming.sessionId))
            .catch(() => {});
        }
      }
    }).then(fn => { unlisten = fn; });
    return () => { if (unlisten) unlisten(); };
  }, []);

  useEffect(() => {
    // 原生（品悟）会话没有 ACP 状态机，跳过 get_acp_agent_status（后端会拒绝非 ACP agent）。
    if (!active) {
      setStatus(null);
      return;
    }
    // 用户主动切换 Agent 后必须绕过进程内探测缓存，立即反映 App 外的安装/卸载。
    refreshStatus(activeAgentId, true).catch(showError);
  }, [activeAgentId, active]);

  useEffect(() => {
    const latest = events[events.length - 1];
    if (!isAcpAuthenticationFailure(latest)) return;
    refreshStatus(activeAgentId).catch(() => {});
  }, [events.length, activeAgentId]);

  useEffect(() => {
    if (!activeStatus?.login_in_progress) return undefined;
    let cancelled = false;
    let timer = null;
    const poll = async () => {
      await refreshStatus(activeAgentId).catch(() => {});
      if (!cancelled) timer = window.setTimeout(poll, 750);
    };
    timer = window.setTimeout(poll, 750);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [activeAgentId, activeStatus?.login_in_progress]);

  return {
    kind: 'acp',
    // 确属 UI 差异的分歧点集中在 capabilities：ACP 会话有安装/登录状态机
    // （RuntimeNotice）、账号菜单与会话配置组（模型/权限模式/config_options），
    // 发送前要求已认证；turns 按设置项决定是否走统一 ConversationTimeline。
    capabilities: {
      runtimeNotice: true,
      accountMenu: true,
      sessionSyncingHint: true,
      acpComposerControls: true,
      nativeComposerControls: false,
      forceUnifiedTurns: false,
      requiresAuthToSend: true,
      // turn 边界 checkpoint 入口（Rust 侧 codex_acp_prompt 在 turn 开始前打快照）。
      checkpoints: true,
      welcomeHints: { active: codexCopy.activeHint, draft: codexCopy.draftHint },
    },
    events,
    turns,
    busy,
    sessionReady,
    runtimeBusy: activeRuntimeBusy,
    sendDisabled: !activeStatus || !activeStatus.installed || !activeStatus.authenticated,
    attentionCount: pending.length + pendingElicitations.length,
    availableCommands,
    configApplying,
    workspaceRefreshToken: events.length,
    pendingByTool,
    pendingByElicitation,
    activeStatus,
    runtimeOperation: activeRuntimeOperation,
    runtimeError: activeRuntimeError,
    serviceFailure: visibleServiceFailure,
    accountMenuOpen,
    setAccountMenuOpen,
    dismissServiceFailure: () => setDismissedFailureKey(serviceFailure?.key || ''),
    resetConversation,
    resetSessionInfo,
    clearStatus: () => setStatus(null),
    loadSession,
    send,
    cancel,
    respond,
    renderItem,
    install,
    login,
    switchAccount,
    openLogin,
    submitLoginCode,
    refreshStatus,
    composer: {
      visible: composerControlsVisible,
      models: controls.fallbackModels,
      modelValue: composerModelValue,
      modes: controls.fallbackModes,
      modeValue: composerModeValue,
      configOptions: controls.configOptions,
      configOptionValue: composerConfigOptionValue,
      configChoices,
      configLabel: option => configLabel(option, codexCopy),
      onModelChange: changeModel,
      onModeChange: changeMode,
      onConfigChange: changeConfig,
    },
  };
}
