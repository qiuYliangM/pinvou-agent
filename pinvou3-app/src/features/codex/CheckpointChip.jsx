// 代码会话时间线上的 checkpoint 入口 chip。
//
// 每个 turn 边界渲染一个（由 CodexAcpView 按 turn 序号从 adapter 共用的
// useSessionCheckpoints 取数）：点击展开「回滚将撤销的变更」摘要（懒加载
// checkpoint_diff），二次确认后回滚；回滚前 Rust 侧会自动打回滚点，可反悔。

import React, { useState } from 'react';
import { RotateCcw, ChevronDown, ChevronRight } from '../../components/icons.jsx';
import { summarizeCheckpointChanges } from './checkpoints.js';

function ChangeSummary({ summary, copy }) {
  if (!summary.total) {
    return <span className="text-gray-400">{copy.checkpointNoChanges}</span>;
  }
  const parts = [];
  if (summary.added) parts.push(copy.checkpointAdded(summary.added));
  if (summary.modified) parts.push(copy.checkpointModified(summary.modified));
  if (summary.deleted) parts.push(copy.checkpointDeleted(summary.deleted));
  const rest = summary.renamed + summary.copied + summary.other;
  if (rest) parts.push(copy.checkpointOther(rest));
  return <span>{parts.join(' · ')}</span>;
}

export function CheckpointChip({ checkpoint, previewState, busy, restoring, copy, onPreview, onRestore }) {
  const [open, setOpen] = useState(false);
  const summary = previewState?.diff ? summarizeCheckpointChanges(previewState.diff.changes) : null;

  function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !previewState) onPreview(checkpoint.id);
  }

  async function confirmRestore() {
    const total = summary ? summary.total : 0;
    if (!window.confirm(copy.checkpointConfirm(total))) return;
    try {
      await onRestore(checkpoint.id);
    } catch (error) {
      window.alert(`${copy.checkpointFailed}: ${error}`);
    }
  }

  const title = checkpoint.turn
    ? copy.checkpointBeforeTurn(checkpoint.turn)
    : checkpoint.label || copy.checkpoint;

  return (
    <div className="my-1 flex justify-center">
      <div className="max-w-full rounded-xl border border-black/[0.06] bg-black/[0.02] px-2.5 py-1 text-[11px] text-gray-500 dark:border-white/10 dark:bg-white/[0.04] dark:text-gray-400">
        <button
          type="button"
          onClick={toggle}
          title={checkpoint.label || title}
          className="flex items-center gap-1.5 hover:text-gray-700 dark:hover:text-gray-200"
        >
          <RotateCcw size={11} />
          <span>{copy.checkpoint} · {title}</span>
          {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
        </button>
        {open && (
          <div className="mt-1.5 border-t border-black/[0.06] pt-1.5 dark:border-white/10">
            {previewState?.loading && <span>{copy.checkpointLoading}</span>}
            {previewState?.error && <span className="text-red-500">{previewState.error}</span>}
            {summary && (
              <div className="flex flex-wrap items-center gap-2">
                <ChangeSummary summary={summary} copy={copy} />
                <button
                  type="button"
                  onClick={confirmRestore}
                  disabled={busy || restoring}
                  title={copy.checkpointRestoreTitle}
                  className="ml-auto rounded-lg border border-blue-500/30 px-2 py-0.5 text-blue-600 transition-colors hover:bg-blue-500/10 disabled:cursor-not-allowed disabled:opacity-40 dark:text-blue-300"
                >
                  {restoring ? copy.checkpointRestoring : copy.checkpointRestore}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
