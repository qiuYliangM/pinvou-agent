//! 代码会话领域状态：类型判定、绑定、恢复与持久化记录（与运行时无关）。
//!
//! 「代码」模块的会话有两条运行时链路——外部 Agent ACP（`codex_acp`，子进程 +
//! JSON-RPC）与品悟原生 Engine（`assistant`/bridge）——但它们共享同一份领域
//! 状态，本模块是这份状态的唯一所有者：
//!
//! - [`store`]：辅助索引 `session-agents.json`（[`SessionAgentStore`]）、原生代码
//!   会话的权威 sidecar（`code-session.json`）与 ACP Agent 默认配置；
//! - [`acp_record`]：ACP 会话记录的分类、恢复与配置值迁移（`acp-state.json` /
//!   工作区基线解析）；
//! - [`CodeSessionCatalog`]：辅助索引 + ACP 元数据兜底的统一查询面，会话类型
//!   （`SessionKind`）解析的使用方全部收口于此；
//! - [`checkpoints`]：turn 级执行根快照与回滚（影子 git 仓库，数据落账本根）；
//! - [`workspace_trust`]：项目目录信任清单（绑定即授权的显式确认与持久化）。
//!
//! 运行时能力（子进程托管、事件桥、Engine 会话）分别留在 `codex_acp` 与
//! `assistant`；本模块不感知任何运行时。

mod acp_record;
mod catalog;
pub mod checkpoints;
mod store;
mod workspace_trust;

pub use acp_record::CODEX_ACP_SESSION_MODEL;
pub(crate) use acp_record::{saved_config_values, CLAUDE_ACP_PACKAGE, CODEX_ACP_PACKAGE};
pub use catalog::CodeSessionCatalog;
pub use store::{
    validate_codex_project_workspace, AcpConfigDefaultsStore, AgentBackend, CodexWorkspaceKind,
    SessionAgentRecord, SessionAgentStore,
};
pub use workspace_trust::{trust_warning_for, TrustedWorkspaceStore};

use crate::features::sessions::SessionKind;

/// 启动时原生代码会话 sidecar 恢复/回填/清理的统计，供真实恢复信号计数与测试断言。
#[derive(Debug, Default, PartialEq, Eq)]
struct SidecarRecoverySummary {
    /// 真实从 sidecar 恢复的索引记录数（索引完好不误报）。
    restored: usize,
    /// 索引在而 sidecar 缺失时按索引补写的 sidecar 数。
    backfilled: usize,
    /// 已被 ACP 会话占用、作为残留清理的 sidecar 数。
    cleaned: usize,
}

/// 扫描 session 私有目录中的原生代码会话权威 sidecar，恢复辅助索引缺失的
/// 原生代码会话记录，并回填索引在而 sidecar 缺失的记录。
///
/// sidecar（`code-session.json`）随会话存续，是跨进程的权威真相源；辅助索引
/// `session-agents.json` 可损坏/丢失后据此重建。扫描根与 sidecar 读取根同源
/// （均由辅助索引路径派生，见 `store::code_session_sidecar_root`），避免两处
/// 根定义漂移。对每个 sidecar：索引已持有 `CodeNative` 记录时跳过（不误报
/// 恢复）；会话已被 ACP 占用（`CodeAcp`）时 sidecar 属历史残留，直接清理而非
/// 反复重试；其余情况据 sidecar 恢复索引（恢复记录写入显式 `CodeNative` kind）。
fn restore_code_native_sessions_from_sidecars(
    agents: &SessionAgentStore,
) -> SidecarRecoverySummary {
    let mut summary = SidecarRecoverySummary::default();
    let sessions_root = store::code_session_sidecar_root(agents.path());
    let entries = match std::fs::read_dir(&sessions_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // sessions 根不存在 = 没有任何会话，无需恢复。
            return summary;
        }
        Err(error) => {
            eprintln!(
                "[pinvou3-app] scan native code session sidecars failed ({}): {error:#}",
                sessions_root.display()
            );
            return summary;
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(error) => {
                eprintln!(
                    "[pinvou3-app] scan native code session sidecars failed to read an entry: {error:#}"
                );
                continue;
            }
        };
        let session_dir = entry.path();
        if !session_dir.is_dir() {
            continue;
        }
        let Some(session_id) = session_dir.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        let Some(sidecar) = store::read_code_session_sidecar(agents.path(), session_id) else {
            continue;
        };
        let record = agents.get(session_id);
        if record.session_kind() == SessionKind::CodeNative {
            // 索引完好无需恢复：不计入 restored，避免每次启动误报恢复信号。
            continue;
        }
        if record.session_kind() == SessionKind::CodeAcp {
            // 会话已被 ACP 绑定：sidecar 是历史残留，恢复必然被拒，直接清理并
            // 如实记日志，而不是每次启动重复报 degraded。
            store::remove_code_session_sidecar(agents.path(), session_id);
            summary.cleaned += 1;
            eprintln!(
                "[pinvou3-app] removed leftover native code session sidecar for ACP session {session_id}"
            );
            continue;
        }
        match agents.restore_missing_code_session_record(session_id, sidecar) {
            Ok(true) => {
                summary.restored += 1;
                eprintln!("[pinvou3-app] recovered native code session index for {session_id}");
            }
            Ok(false) => {}
            Err(error) => eprintln!(
                "[pinvou3-app] native code session {session_id} remains degraded: {error:#}"
            ),
        }
    }
    // 回填自愈：索引在而 sidecar 缺失（修复前构建的存量会话，或绑定时 sidecar
    // 写失败）时按索引补写 sidecar，写失败逐条记日志。
    summary.backfilled = agents.backfill_missing_code_session_sidecars();
    if summary.restored > 0 {
        eprintln!(
            "[pinvou3-app] recovered {} native code session index record(s) from sidecars",
            summary.restored
        );
    }
    if summary.backfilled > 0 {
        eprintln!(
            "[pinvou3-app] backfilled {} missing native code session sidecar(s) from index",
            summary.backfilled
        );
    }
    summary
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_startup_recovery_restores_backfills_and_cleans_leftovers() {
        let root = std::env::temp_dir().join(format!(
            "pinvou3-sidecar-startup-recovery-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let path = root.join("session-agents.json");
        // 写入一个已绑定的原生代码会话（索引 + sidecar）。
        let writer = SessionAgentStore::for_test(path.clone());
        writer
            .bind_code_native_session("code-1", CodexWorkspaceKind::Project, Some(root.clone()))
            .unwrap();
        // 模拟辅助索引丢失：空内存索引 + 磁盘 sidecar 仍在 → 真实恢复一次。
        let agents = SessionAgentStore::for_test(path.clone());
        let summary = restore_code_native_sessions_from_sidecars(&agents);
        assert_eq!(
            summary,
            SidecarRecoverySummary {
                restored: 1,
                backfilled: 0,
                cleaned: 0
            }
        );
        assert_eq!(agents.session_kind("code-1"), SessionKind::CodeNative);
        assert_eq!(
            agents.get("code-1").kind,
            Some(SessionKind::CodeNative),
            "恢复路径必须写入显式 kind"
        );
        assert_eq!(
            agents.get("code-1").workspace_path.as_deref(),
            Some(root.as_path())
        );
        // 索引完好时不再误报恢复信号。
        let summary = restore_code_native_sessions_from_sidecars(&agents);
        assert_eq!(summary, SidecarRecoverySummary::default());
        // sidecar 缺失（存量会话/绑定时写失败）时按索引回填自愈。
        let sidecar_path = root
            .join("sessions")
            .join("code-1")
            .join("code-session.json");
        std::fs::remove_file(&sidecar_path).unwrap();
        let summary = restore_code_native_sessions_from_sidecars(&agents);
        assert_eq!(
            summary,
            SidecarRecoverySummary {
                restored: 0,
                backfilled: 1,
                cleaned: 0
            }
        );
        assert!(sidecar_path.is_file());
        // ACP 会话的残留 sidecar：清理一次并如实计数，而不是每次启动报 degraded。
        agents
            .set_acp_workspace(
                "acp-1",
                AgentBackend::CodexAcp,
                CodexWorkspaceKind::Temporary,
                None,
            )
            .unwrap();
        let leftover_dir = root.join("sessions").join("acp-1");
        std::fs::create_dir_all(&leftover_dir).unwrap();
        std::fs::write(
            leftover_dir.join("code-session.json"),
            serde_json::to_vec(&store::CodeSessionSidecar {
                version: 1,
                workspace_kind: CodexWorkspaceKind::Temporary,
                workspace_path: None,
                bound_at: None,
            })
            .unwrap(),
        )
        .unwrap();
        let summary = restore_code_native_sessions_from_sidecars(&agents);
        assert_eq!(
            summary,
            SidecarRecoverySummary {
                restored: 0,
                backfilled: 0,
                cleaned: 1
            }
        );
        assert!(!leftover_dir.join("code-session.json").exists());
        assert_eq!(agents.get("acp-1").backend, AgentBackend::CodexAcp);
        // 残留已清理：再次启动扫描无任何动作。
        let summary = restore_code_native_sessions_from_sidecars(&agents);
        assert_eq!(summary, SidecarRecoverySummary::default());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
