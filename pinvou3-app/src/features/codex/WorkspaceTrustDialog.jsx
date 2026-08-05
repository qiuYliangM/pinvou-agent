// 项目目录绑定前的显式授权确认弹窗（workspace trust）。
//
// 说明该目录将成为代码会话的执行根（引擎可读写其文件、执行 shell；敏感目录
// 仍受防火墙约束）；绑定家目录本身 / 盘符根时带额外警示。用户确认后才继续
// 绑定流程（confirmed=true 随创建命令下发，由 Rust 记入信任清单）。

import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, FolderOpen } from '../../components/icons.jsx';

export function WorkspaceTrustDialog({ path, warning, copy, onConfirm, onCancel }) {
  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  const warningText = warning === 'home'
    ? copy.trustDialogWarnHome
    : warning === 'root'
      ? copy.trustDialogWarnRoot
      : '';
  return createPortal(
    <div
      role="presentation"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/30 p-4 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="workspace-trust-title"
        data-testid="workspace-trust-dialog"
        className="w-[420px] max-w-[calc(100vw-48px)] overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-2xl dark:border-white/10 dark:bg-[#202124]"
        onClick={event => event.stopPropagation()}
      >
        <div className="px-5 pb-5 pt-5">
          <div className="flex items-center gap-2.5">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
              <FolderOpen size={18} />
            </span>
            <div id="workspace-trust-title" className="text-[15px] font-semibold text-[#1F1F1F] dark:text-[#E8EAED]">
              {copy.trustDialogTitle}
            </div>
          </div>
          <div className="mt-3 text-[13px] leading-relaxed text-gray-600 dark:text-gray-300">
            {copy.trustDialogBody}
          </div>
          <div className="mt-3 break-all rounded-xl bg-black/[0.03] px-3 py-2 font-mono text-[12px] text-gray-500 dark:bg-white/[0.06] dark:text-gray-400">
            {path}
          </div>
          {warningText && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/25 bg-amber-500/[0.08] px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" />
              <span>{warningText}</span>
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-black/[0.06] px-5 py-3 dark:border-white/[0.08]">
          <button
            type="button"
            onClick={onCancel}
            className="h-8 rounded-lg px-3 text-[13px] text-gray-500 hover:bg-black/[0.05] dark:text-gray-400 dark:hover:bg-white/[0.07]"
          >
            {copy.cancel}
          </button>
          <button
            type="button"
            data-testid="workspace-trust-confirm"
            onClick={onConfirm}
            className="h-8 rounded-lg bg-[#007AFF] px-3 text-[13px] font-semibold text-white shadow-sm hover:bg-[#006EE6]"
          >
            {copy.trustDialogConfirm}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
