//! 代码会话 checkpoint 命令：turn 边界快照的查询、差异预览与回滚。
//!
//! 快照本体在 `features/code_sessions/checkpoints`（影子 git 仓库，数据落账本根）；
//! 本文件只做传输边界：会话类型/根解析、忙碌门与错误文案。仅代码会话
//! （CodeNative / CodeAcp）可用，其余会话类型如实拒绝。

use super::prelude::*;
use crate::features::code_sessions::checkpoints::{
    self, CheckpointDiff, CheckpointMeta,
};
use crate::features::codex_acp::AcpPool;

/// 解析代码会话的两个根：账本根（checkpoint 数据落点）+ 执行根（快照对象）。
/// 非代码会话、会话不存在、工作目录不可用都如实报错，不静默降级。
fn resolve_code_session_roots(
    session_id: &str,
    store: &SessionStore,
    acp_pool: &AcpPool,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    if !matches!(
        acp_pool.session_kind(session_id),
        SessionKind::CodeNative | SessionKind::CodeAcp
    ) {
        return Err("仅代码会话支持检查点".to_string());
    }
    let ledger = store
        .session_roots(session_id)
        .map_err(|error| format!("解析会话根失败: {error:#}"))?
        .ledger;
    let info = acp_pool
        .workspace_info(session_id)
        .map_err(|error| format!("读取代码会话工作目录失败: {error:#}"))?;
    if !info.workspace_available {
        return Err(format!("代码会话工作目录不可用: {}", info.workspace_path));
    }
    Ok((ledger, std::path::PathBuf::from(info.workspace_path)))
}

#[tauri::command]
pub async fn list_checkpoints(
    session_id: String,
    store: State<'_, SessionStore>,
    acp_pool: State<'_, AcpPool>,
) -> Result<Vec<CheckpointMeta>, String> {
    // 列表只读账本根索引，不触碰执行根（执行根被删的历史会话仍可查看/清理认知）。
    if !matches!(
        acp_pool.session_kind(&session_id),
        SessionKind::CodeNative | SessionKind::CodeAcp
    ) {
        return Err("仅代码会话支持检查点".to_string());
    }
    let ledger = store
        .session_roots(&session_id)
        .map_err(|error| format!("解析会话根失败: {error:#}"))?
        .ledger;
    tauri::async_runtime::spawn_blocking(move || {
        checkpoints::list_checkpoints(&ledger)
            .map_err(|error| format!("读取检查点列表失败: {error:#}"))
    })
    .await
    .map_err(|error| format!("读取检查点列表任务失败: {error}"))?
}

#[tauri::command]
pub async fn checkpoint_diff(
    session_id: String,
    checkpoint_id: String,
    store: State<'_, SessionStore>,
    acp_pool: State<'_, AcpPool>,
) -> Result<CheckpointDiff, String> {
    let (ledger, execution) = resolve_code_session_roots(&session_id, &store, &acp_pool)?;
    tauri::async_runtime::spawn_blocking(move || {
        checkpoints::diff_checkpoint(&ledger, &execution, &checkpoint_id)
            .map_err(|error| format!("读取检查点差异失败: {error:#}"))
    })
    .await
    .map_err(|error| format!("读取检查点差异任务失败: {error}"))?
}

#[tauri::command]
pub async fn restore_checkpoint(
    session_id: String,
    checkpoint_id: String,
    pool: State<'_, EnginePool>,
    store: State<'_, SessionStore>,
    acp_pool: State<'_, AcpPool>,
) -> Result<CheckpointMeta, String> {
    // 忙碌门：turn 进行中回滚会与引擎写文件竞争，如实拒绝（前端同时禁用入口）。
    let busy = match acp_pool.session_kind(&session_id) {
        SessionKind::CodeNative => pool.is_turn_active(&session_id),
        SessionKind::CodeAcp => acp_pool.is_session_busy(&session_id).await,
        _ => return Err("仅代码会话支持检查点".to_string()),
    };
    if busy {
        return Err("会话正在执行，请先停止当前任务再回滚".to_string());
    }
    let (ledger, execution) = resolve_code_session_roots(&session_id, &store, &acp_pool)?;
    tauri::async_runtime::spawn_blocking(move || {
        checkpoints::restore_checkpoint(&ledger, &execution, &checkpoint_id)
            .map_err(|error| format!("回滚检查点失败: {error:#}"))
    })
    .await
    .map_err(|error| format!("回滚检查点任务失败: {error}"))?
}
