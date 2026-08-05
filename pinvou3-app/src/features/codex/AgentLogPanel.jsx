// 会话级 agent log 面板（阶段二·可观测）：按时间序列展示当前代码会话的
// 关键事件 —— turn 开始/终态（含耗时）、工具调用（名称+参数摘要+结果状态）、
// plan 事件、checkpoint 创建/回滚、错误。数据来自 agent-log store（chat:* /
// acp:event 事件流的环形缓冲 + 重载后的历史种子），条目可展开看参数/结果
// 摘要（load_skill 全文按 bridge 先例脱敏为占位），可复制单条。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Archive, Check, ChevronDown, ChevronRight, ClipboardList,
  Copy, Lock, Sparkles, Terminal, Wrench, X,
} from '../../components/icons.jsx';
import { copyClipboardText } from '../conversation/message-clipboard.js';

const KIND_ICONS = {
  turn: Terminal,
  tool: Wrench,
  plan: ClipboardList,
  checkpoint: Archive,
  error: AlertTriangle,
  note: Sparkles,
  permission: Lock,
};

function timeLabel(at) {
  const date = new Date(Number(at) || Date.now());
  return date.toTimeString().slice(0, 8);
}

function turnStatusLabel(status, conversationCopy) {
  const normalized = String(status || '').toLowerCase();
  if (normalized === 'completed') return conversationCopy.completed;
  if (normalized === 'failed') return conversationCopy.failed;
  if (normalized === 'interrupted' || normalized === 'cancelled' || normalized === 'canceled') {
    return conversationCopy.interrupted;
  }
  return status || conversationCopy.completed;
}

function toolStatusLabel(status, copy, conversationCopy) {
  switch (status) {
    case 'done': return conversationCopy.completed;
    case 'failed': return conversationCopy.failed;
    case 'blocked': return copy.agentLogBlocked;
    case 'cancelled': return conversationCopy.interrupted;
    default: return conversationCopy.running;
  }
}

function toolStatusTone(status) {
  if (status === 'done') return 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/10';
  if (status === 'failed' || status === 'blocked') return 'text-red-600 dark:text-red-300 bg-red-500/10';
  if (status === 'cancelled') return 'text-gray-500 dark:text-gray-400 bg-gray-500/10';
  return 'text-blue-600 dark:text-blue-300 bg-blue-500/10';
}

/// 条目的一行摘要（按 kind 分派，文案全部来自 copy/conversationCopy）。
function entrySummary(entry, copy, conversationCopy) {
  switch (entry.kind) {
    case 'turn':
      if (entry.phase === 'start') return copy.agentLogTurnStart;
      return copy.agentLogTurnEnd(
        turnStatusLabel(entry.status, conversationCopy),
        entry.durationMs != null ? conversationCopy.elapsed(entry.durationMs) : '',
      );
    case 'tool':
      return entry.name || conversationCopy.tool;
    case 'plan':
      if (entry.phase === 'ready') return copy.agentLogPlanReady(entry.planItems || 0);
      if (entry.phase === 'resolved') return copy.agentLogPlanResolved;
      return copy.agentLogPlanUpdate(entry.planItems || 0);
    case 'checkpoint':
      if (entry.phase === 'restored') return copy.agentLogCheckpointRestored;
      return copy.agentLogCheckpointCreated(
        entry.turn ? copy.checkpointBeforeTurn(entry.turn) : (entry.label || ''),
      );
    case 'error':
      return entry.summary || '';
    case 'note': {
      const label = entry.phase === 'start'
        ? copy.compactStart
        : entry.phase === 'fail'
          ? copy.compactFail
          : copy.compactDone;
      return label;
    }
    case 'permission':
      return entry.phase === 'resolved'
        ? copy.agentLogPermissionResolved(entry.summary || '')
        : copy.agentLogPermissionRequested;
    default:
      return entry.summary || '';
  }
}

/// 条目的展开详情（参数/结果摘要、错误文本）；无详情返回空数组。
function entryDetails(entry, copy, conversationCopy) {
  const details = [];
  if (entry.kind === 'tool') {
    if (entry.argsSummary) details.push({ label: conversationCopy.arguments, text: entry.argsSummary });
    if (entry.resultRedacted) details.push({ label: conversationCopy.result, text: copy.agentLogSkillHidden });
    else if (entry.resultSummary) details.push({ label: conversationCopy.result, text: entry.resultSummary });
  }
  if (entry.kind === 'turn' && entry.error) details.push({ label: '', text: entry.error });
  if (entry.kind === 'error') details.push({ label: '', text: entry.summary || '' });
  if (entry.kind === 'note' && entry.summary) details.push({ label: '', text: entry.summary });
  if (entry.kind === 'permission' && entry.phase !== 'resolved' && entry.summary) {
    details.push({ label: '', text: entry.summary });
  }
  if (entry.kind === 'checkpoint' && entry.phase === 'created' && entry.label && entry.turn) {
    details.push({ label: '', text: entry.label });
  }
  return details;
}

/// 复制单条的纯文本形态（时间 + 摘要 + 详情行）。
function entryCopyText(entry, copy, conversationCopy) {
  const lines = [`[${timeLabel(entry.at)}] ${entrySummary(entry, copy, conversationCopy)}`];
  for (const detail of entryDetails(entry, copy, conversationCopy)) {
    lines.push(detail.label ? `${detail.label}: ${detail.text}` : detail.text);
  }
  return lines.join('\n');
}

function AgentLogEntry({ entry, copy, conversationCopy }) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const Icon = KIND_ICONS[entry.kind] || Terminal;
  const summary = entrySummary(entry, copy, conversationCopy);
  const details = entryDetails(entry, copy, conversationCopy);

  function copyEntry() {
    copyClipboardText(entryCopyText(entry, copy, conversationCopy)).then(ok => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }

  return (
    <div data-testid="agent-log-entry" className="rounded-lg px-2 py-1.5 hover:bg-black/[0.03] dark:hover:bg-white/[0.04]">
      <div className="flex items-center gap-2">
        <span className="shrink-0 w-12 font-mono text-[10px] text-gray-400">{timeLabel(entry.at)}</span>
        <Icon size={12} className={`shrink-0 ${entry.kind === 'error' ? 'text-red-500' : 'text-gray-400'}`} />
        <span className={`min-w-0 flex-1 truncate text-[11px] ${entry.kind === 'error' ? 'text-red-600 dark:text-red-300' : 'text-gray-700 dark:text-gray-200'}`}
          title={summary}>
          {summary}
        </span>
        {entry.kind === 'tool' && (
          <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-medium ${toolStatusTone(entry.status)}`}>
            {toolStatusLabel(entry.status, copy, conversationCopy)}
          </span>
        )}
        {details.length > 0 && (
          <button
            type="button"
            onClick={() => setExpanded(value => !value)}
            aria-label={expanded ? copy.agentLogCollapse : copy.agentLogExpand}
            title={expanded ? copy.agentLogCollapse : copy.agentLogExpand}
            className="w-5 h-5 shrink-0 rounded-md flex items-center justify-center text-gray-400 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
          >
            {expanded ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
          </button>
        )}
        <button
          type="button"
          onClick={copyEntry}
          aria-label={copy.agentLogCopy}
          title={copied ? copy.agentLogCopied : copy.agentLogCopy}
          className="w-5 h-5 shrink-0 rounded-md flex items-center justify-center text-gray-400 hover:bg-black/[0.06] dark:hover:bg-white/[0.08]"
        >
          {copied ? <Check size={11} className="text-emerald-500" /> : <Copy size={11} />}
        </button>
      </div>
      {expanded && details.length > 0 && (
        <div className="mt-1 ml-14 space-y-1">
          {details.map((detail, index) => (
            <div key={index} className="rounded-md bg-black/[0.03] dark:bg-white/[0.05] px-2 py-1">
              {detail.label && (
                <div className="text-[9px] font-medium uppercase tracking-wider text-gray-400">{detail.label}</div>
              )}
              <pre className="whitespace-pre-wrap break-all font-mono text-[10px] leading-4 text-gray-600 dark:text-gray-300">{detail.text}</pre>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function AgentLogPanel({ entries, onClose, copy, conversationCopy }) {
  const scroller = useRef(null);
  const count = entries.length;
  // 新事件到达自动滚到底（面板是只读时间线，不跟踪用户回翻）。
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [count]);
  const body = useMemo(() => entries.map(entry => (
    <AgentLogEntry key={entry.id} entry={entry} copy={copy} conversationCopy={conversationCopy} />
  )), [entries, copy, conversationCopy]);

  return (
    <div data-testid="agent-log-panel"
      className="flex h-full w-[340px] shrink-0 flex-col border-l border-black/[0.06] bg-white dark:border-white/[0.08] dark:bg-[#141517]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-black/[0.05] px-4 dark:border-white/[0.06]">
        <ClipboardList size={14} className="shrink-0 text-gray-500 dark:text-gray-400" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold text-gray-800 dark:text-gray-100">{copy.agentLog}</div>
          <div className="text-[10px] text-gray-400">{copy.agentLogCapacityHint}</div>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={copy.agentLogClose}
          title={copy.agentLogClose}
          className="w-7 h-7 shrink-0 rounded-lg flex items-center justify-center text-gray-400 hover:bg-black/[0.05] dark:hover:bg-white/[0.07]"
        >
          <X size={14} />
        </button>
      </div>
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-2 py-2">
        {count === 0 ? (
          <div className="px-3 py-8 text-center text-[11px] leading-5 text-gray-400">{copy.agentLogEmpty}</div>
        ) : body}
      </div>
    </div>
  );
}
