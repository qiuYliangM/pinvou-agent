//! 代码会话目录：辅助索引（`SessionAgentStore`）+ ACP 元数据兜底的统一查询面。
//!
//! 会话类型/后端/工作区绑定等「这是什么代码会话」的判定全部收口在这里：
//! `session-agents.json` 是可重建的辅助索引，缺失或损坏时由会话元数据中的
//! `* (ACP)` 模型类型兜底，原生代码会话由 sidecar 体系兜底（见 `super` 的启动
//! 恢复）。ACP 链路（`codex_acp::AcpPool`）与 Native 链路（bridge/远控经组合根
//! 注入的 `session_kind` 闭包）共享同一份判定，不再各自实现。

use std::collections::HashMap;
use std::sync::Arc;

use anyhow::{bail, Result};
use deepseek_tui::session_manager::SessionMetadata;
use parking_lot::RwLock;

use super::acp_record::{
    acp_session_backend, load_acp_config_values_from_state, load_acp_recovery_record,
    saved_config_values,
};
use super::store::{AcpConfigDefaultsStore, AgentBackend, SessionAgentRecord, SessionAgentStore};
use crate::features::sessions::{SessionKind, SessionStore};

/// 代码会话目录：每条代码会话（ACP 或品悟原生）的类型、后端与工作区绑定记录。
#[derive(Clone)]
pub struct CodeSessionCatalog {
    agents: SessionAgentStore,
    acp_metadata_backends: Arc<RwLock<HashMap<String, AgentBackend>>>,
}

impl CodeSessionCatalog {
    /// 启动装配：从会话元数据构建 ACP 兜底表，恢复缺失的 ACP 索引记录与原生
    /// 代码会话 sidecar，并为旧版本迁移每个 Agent 最近一次成功配置。
    ///
    /// 所有恢复/迁移失败只记日志不阻断启动（辅助索引损坏不能拖垮主程序）。
    pub(crate) fn boot(
        agents: SessionAgentStore,
        session_store: &SessionStore,
        config_defaults: &AcpConfigDefaultsStore,
        metadata: &[SessionMetadata],
    ) -> Self {
        let acp_metadata_backends = metadata
            .iter()
            .filter_map(|metadata| {
                acp_session_backend(agents.backend(&metadata.id), &metadata.model)
                    .map(|backend| (metadata.id.clone(), backend))
            })
            .collect::<HashMap<_, _>>();
        for (session_id, backend) in &acp_metadata_backends {
            if agents.backend(session_id).is_acp() {
                continue;
            }
            match load_acp_recovery_record(session_id, *backend, session_store)
                .and_then(|record| agents.restore_missing_acp_record(session_id, record))
            {
                Ok(()) => eprintln!(
                    "[pinvou3-app] recovered {} ACP session index for {session_id}",
                    backend.display_name()
                ),
                Err(error) => eprintln!(
                    "[pinvou3-app] {} ACP session {session_id} remains read-only until its index can be recovered: {error:#}",
                    backend.display_name()
                ),
            }
        }
        // 原生代码会话的权威 sidecar 恢复：sidecar 随 session 私有目录存续，辅助
        // 索引（session-agents.json）损坏/丢失后，据 sidecar 恢复原生代码会话类型
        // 与项目目录绑定，避免会话静默掉回普通聊天、执行根退回私有目录。
        super::restore_code_native_sessions_from_sidecars(&agents);
        // 旧版本只保存了 session 级状态。按更新时间从新到旧，为每个 Agent
        // 迁移最近一次成功配置，使升级后的第一个新会话也能继承用户选择。
        for item in metadata {
            let Some(backend) = acp_metadata_backends.get(&item.id).copied() else {
                continue;
            };
            if config_defaults.has_backend(backend) {
                continue;
            }
            let values = load_acp_config_values_from_state(&item.id, backend)
                .unwrap_or_else(|_| saved_config_values(&agents.get(&item.id)));
            match config_defaults.set_all_if_absent(backend, values) {
                Ok(true) => eprintln!(
                    "[pinvou3-app] migrated {} ACP defaults from session {}",
                    backend.display_name(),
                    item.id
                ),
                Ok(false) => {}
                Err(error) => eprintln!(
                    "[pinvou3-app] failed to migrate {} ACP defaults: {error:#}",
                    backend.display_name()
                ),
            }
        }
        Self {
            agents,
            acp_metadata_backends: Arc::new(RwLock::new(acp_metadata_backends)),
        }
    }

    pub fn agents(&self) -> &SessionAgentStore {
        &self.agents
    }

    /// 已识别为 ACP 的会话 id（含元数据兜底），供启动时收口遗留 running 回合。
    pub(crate) fn acp_session_ids(&self) -> Vec<String> {
        self.acp_metadata_backends.read().keys().cloned().collect()
    }

    /// 会话类型以 ACP 辅助索引为主，并用 SavedSession 中持久化的 Agent 模型类型兜底。
    ///
    /// `session-agents.json` 是可重建的辅助索引，缺失或损坏时不能让历史 Codex
    /// / Claude / Kimi 会话掉回普通聊天列表；创建会话时写入的 `* (ACP)` 元数据
    /// 是长期兼容依据。列表调用已经持有 metadata，应使用本方法避免重复读取 transcript。
    pub fn is_acp_metadata(&self, metadata: &SessionMetadata) -> bool {
        let backend = self.agents.backend(&metadata.id);
        let Some(backend) = acp_session_backend(backend, &metadata.model) else {
            return false;
        };
        if !self.acp_metadata_backends.read().contains_key(&metadata.id) {
            self.acp_metadata_backends
                .write()
                .insert(metadata.id.clone(), backend);
        }
        true
    }

    pub fn is_acp(&self, session_id: &str) -> bool {
        self.agents.backend(session_id).is_acp()
            || self.acp_metadata_backends.read().contains_key(session_id)
    }

    /// 会话类型判定（含 ACP 元数据兜底）：以 `SessionAgentStore::session_kind`
    /// 为唯一类型真相源；辅助索引缺失、仅凭元数据兜底识别出的 ACP 会话仍判
    /// `CodeAcp`，与 [`Self::is_acp`] 保持一致（`is_acp()` ⟺ kind == `CodeAcp`）。
    pub fn session_kind(&self, session_id: &str) -> SessionKind {
        match self.agents.session_kind(session_id) {
            SessionKind::Chat if self.acp_metadata_backends.read().contains_key(session_id) => {
                SessionKind::CodeAcp
            }
            kind => kind,
        }
    }

    pub fn backend(&self, session_id: &str) -> AgentBackend {
        let backend = self.agents.backend(session_id);
        if backend.is_acp() {
            backend
        } else {
            self.acp_metadata_backends
                .read()
                .get(session_id)
                .copied()
                .unwrap_or(backend)
        }
    }

    pub(crate) fn acp_record(&self, session_id: &str) -> Result<SessionAgentRecord> {
        let record = self.agents.get(session_id);
        if record.backend.is_acp() {
            return Ok(record);
        }
        if let Some(backend) = self.acp_metadata_backends.read().get(session_id).copied() {
            bail!(
                "{} 会话辅助索引缺失，且无法从 acp-state.json 与工作区基线完整恢复；\
                 为避免在错误目录新建上下文，当前会话仅允许查看历史",
                backend.display_name()
            );
        }
        bail!("会话不是 ACP 会话")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn catalog_with_metadata_fallback(
        store_path: std::path::PathBuf,
        session_id: &str,
        backend: AgentBackend,
    ) -> CodeSessionCatalog {
        let catalog = CodeSessionCatalog {
            agents: SessionAgentStore::for_test(store_path),
            acp_metadata_backends: Arc::new(RwLock::new(HashMap::new())),
        };
        catalog
            .acp_metadata_backends
            .write()
            .insert(session_id.to_string(), backend);
        catalog
    }

    #[test]
    fn session_kind_falls_back_to_acp_metadata_when_index_is_missing() {
        let path = std::env::temp_dir().join(format!(
            "pinvou3-catalog-kind-test-{}/session-agents.json",
            std::process::id()
        ));
        let catalog = catalog_with_metadata_fallback(path, "acp-legacy", AgentBackend::ClaudeAcp);
        // 辅助索引缺失、仅凭元数据兜底识别出的 ACP 会话仍判 CodeAcp。
        assert_eq!(catalog.session_kind("acp-legacy"), SessionKind::CodeAcp);
        assert!(catalog.is_acp("acp-legacy"));
        assert_eq!(catalog.backend("acp-legacy"), AgentBackend::ClaudeAcp);
        // 无索引且无元数据的会话保持普通聊天。
        assert_eq!(catalog.session_kind("unknown"), SessionKind::Chat);
        assert!(!catalog.is_acp("unknown"));
        assert_eq!(catalog.backend("unknown"), AgentBackend::Deepseek);
        // acp_record 对兜底会话给出明确的只读报错，而不是误导性的「不是 ACP 会话」。
        let error = catalog.acp_record("acp-legacy").unwrap_err();
        assert!(format!("{error:#}").contains("辅助索引缺失"));
        assert!(catalog.acp_record("unknown").is_err());
    }

    #[test]
    fn index_record_wins_over_metadata_fallback() {
        let root = std::env::temp_dir().join(format!(
            "pinvou3-catalog-index-wins-test-{}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let catalog = catalog_with_metadata_fallback(
            root.join("session-agents.json"),
            "code-1",
            AgentBackend::CodexAcp,
        );
        // 索引持有显式 CodeNative 记录时，元数据兜底不得把它误判为 ACP。
        catalog
            .agents()
            .bind_code_native_session(
                "code-1",
                super::super::store::CodexWorkspaceKind::Project,
                Some(root.clone()),
            )
            .unwrap();
        assert_eq!(catalog.session_kind("code-1"), SessionKind::CodeNative);
        assert_eq!(catalog.backend("code-1"), AgentBackend::CodexAcp);
        std::fs::remove_dir_all(&root).unwrap();
    }
}
