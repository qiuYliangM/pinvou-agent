//! ACP 会话记录：辅助索引（`session-agents.json`）记录的分类、恢复与配置值迁移。
//!
//! 这里只处理与运行时无关的持久化领域状态：`acp-state.json`/工作区基线的解析与
//! 校验、Agent 模型元数据的兜底分类、用户已确认配置值的读取。子进程托管与
//! JSON-RPC 运行时留在 `codex_acp`。

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde_json::Value;

use super::store::{AgentBackend, CodexWorkspaceKind, SessionAgentRecord};
use crate::features::sessions::{SessionKind, SessionStore};

pub(crate) const CODEX_ACP_PACKAGE: &str = "@agentclientprotocol/codex-acp";
pub(crate) const CLAUDE_ACP_PACKAGE: &str = "@agentclientprotocol/claude-agent-acp";
const KIMI_ACP_PACKAGE: &str = "kimi acp";
pub const CODEX_ACP_SESSION_MODEL: &str = "Codex (ACP)";
const CLAUDE_ACP_SESSION_MODEL: &str = "Claude Code (ACP)";
const KIMI_ACP_SESSION_MODEL: &str = "Kimi (ACP)";

fn backend_for_session_model(model: &str) -> Option<AgentBackend> {
    match model {
        CODEX_ACP_SESSION_MODEL => Some(AgentBackend::CodexAcp),
        CLAUDE_ACP_SESSION_MODEL => Some(AgentBackend::ClaudeAcp),
        KIMI_ACP_SESSION_MODEL => Some(AgentBackend::KimiAcp),
        _ => None,
    }
}

pub(super) fn acp_session_backend(backend: AgentBackend, model: &str) -> Option<AgentBackend> {
    backend
        .is_acp()
        .then_some(backend)
        .or_else(|| backend_for_session_model(model))
}

fn same_workspace(left: &Path, right: &Path) -> bool {
    left == right
        || left
            .canonicalize()
            .ok()
            .zip(right.canonicalize().ok())
            .is_some_and(|(left, right)| left == right)
}

fn backend_for_acp_state(state: &Value) -> Result<AgentBackend> {
    let package_backend = match state["adapter"]["package"].as_str() {
        Some(CODEX_ACP_PACKAGE) => Some(AgentBackend::CodexAcp),
        Some(CLAUDE_ACP_PACKAGE) => Some(AgentBackend::ClaudeAcp),
        Some(KIMI_ACP_PACKAGE) => Some(AgentBackend::KimiAcp),
        Some(other) => bail!("acp-state.json 包含未知 ACP adapter package: {other}"),
        None => None,
    };
    let agent_backend = state["adapter"]["agentId"]
        .as_str()
        .map(|agent_id| AgentBackend::parse(Some(agent_id)))
        .transpose()?
        .filter(|backend| backend.is_acp());
    if let (Some(package), Some(agent)) = (package_backend, agent_backend) {
        if package != agent {
            bail!("acp-state.json 的 Agent 与 adapter package 不匹配");
        }
    }
    agent_backend
        .or(package_backend)
        .context("acp-state.json 缺少可识别的 ACP Agent")
}

fn acp_mode_from_state(state: &Value) -> Option<String> {
    acp_config_values_from_state(state)
        .remove("mode")
        .or_else(|| {
            state["session"]["modes"]["currentModeId"]
                .as_str()
                .map(str::to_string)
        })
}

fn acp_config_values_from_state(state: &Value) -> HashMap<String, String> {
    state["session"]["config_options"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|option| {
            Some((
                option["id"].as_str()?.to_string(),
                option["currentValue"].as_str()?.to_string(),
            ))
        })
        .collect()
}

pub(crate) fn saved_config_values(record: &SessionAgentRecord) -> HashMap<String, String> {
    let mut values = record.acp_config_values.clone();
    if let Some(model_id) = &record.acp_model_id {
        values
            .entry("model".to_string())
            .or_insert_with(|| model_id.clone());
    }
    if let Some(mode_id) = &record.acp_mode_id {
        values
            .entry("mode".to_string())
            .or_insert_with(|| mode_id.clone());
    }
    values
}

pub(super) fn load_acp_config_values_from_state(
    session_id: &str,
    expected_backend: AgentBackend,
) -> Result<HashMap<String, String>> {
    let state_path = crate::platform::paths::sessions_root()
        .join(session_id)
        .join("acp-state.json");
    let state: Value = serde_json::from_slice(
        &std::fs::read(&state_path)
            .with_context(|| format!("读取 {} 失败", state_path.display()))?,
    )
    .with_context(|| format!("解析 {} 失败", state_path.display()))?;
    if backend_for_acp_state(&state)? != expected_backend {
        bail!("acp-state.json 的 Agent 与会话元数据不匹配");
    }
    Ok(acp_config_values_from_state(&state))
}

fn acp_recovery_record(
    pinvou_session_id: &str,
    expected_backend: AgentBackend,
    state: &Value,
    workspace_path: PathBuf,
    temporary_workspace: &Path,
) -> Result<SessionAgentRecord> {
    if state["pinvouSessionId"].as_str() != Some(pinvou_session_id) {
        bail!("acp-state.json 的 Pinvou 会话 ID 不匹配");
    }
    if !expected_backend.is_acp() {
        bail!("会话元数据不是 ACP Agent");
    }
    let state_backend = backend_for_acp_state(state)?;
    if state_backend != expected_backend {
        bail!(
            "acp-state.json 的 Agent {} 与会话元数据 {} 不匹配",
            state_backend.display_name(),
            expected_backend.display_name()
        );
    }
    let acp_session_id = state["session"]["session_id"]
        .as_str()
        .filter(|value| !value.is_empty())
        .context("acp-state.json 缺少原 ACP session id")?
        .to_string();
    if !workspace_path.is_absolute() {
        bail!("ACP 工作目录记录不是绝对路径");
    }
    let workspace_kind = match state["workspace"]["kind"].as_str() {
        Some("temporary") => {
            if !same_workspace(&workspace_path, temporary_workspace) {
                bail!("acp-state.json 的临时工作目录与会话目录不匹配");
            }
            CodexWorkspaceKind::Temporary
        }
        Some("project") => CodexWorkspaceKind::Project,
        Some(other) => bail!("acp-state.json 包含未知工作目录类型: {other}"),
        None if same_workspace(&workspace_path, temporary_workspace) => {
            CodexWorkspaceKind::Temporary
        }
        None => CodexWorkspaceKind::Project,
    };
    Ok(SessionAgentRecord {
        backend: expected_backend,
        acp_session_id: Some(acp_session_id),
        acp_model_id: state["session"]["current_model_id"]
            .as_str()
            .map(str::to_string),
        acp_mode_id: acp_mode_from_state(state),
        acp_config_values: acp_config_values_from_state(state),
        workspace_kind,
        workspace_path: (workspace_kind == CodexWorkspaceKind::Project).then_some(workspace_path),
        code_session: false,
        kind: Some(SessionKind::CodeAcp),
    })
}

pub(super) fn load_acp_recovery_record(
    session_id: &str,
    expected_backend: AgentBackend,
    session_store: &SessionStore,
) -> Result<SessionAgentRecord> {
    let temporary_workspace = session_store.session_roots(session_id)?.execution;
    let session_root = crate::platform::paths::sessions_root().join(session_id);
    let state_path = session_root.join("acp-state.json");
    let state: Value = serde_json::from_slice(
        &std::fs::read(&state_path)
            .with_context(|| format!("读取 {} 失败", state_path.display()))?,
    )
    .with_context(|| format!("解析 {} 失败", state_path.display()))?;
    let workspace_path = if let Some(path) = state["workspace"]["path"]
        .as_str()
        .filter(|value| !value.is_empty())
    {
        PathBuf::from(path)
    } else {
        let baseline_path = session_root.join("codex-workspace-baseline.json");
        let baseline: Value = serde_json::from_slice(
            &std::fs::read(&baseline_path)
                .with_context(|| format!("读取 {} 失败", baseline_path.display()))?,
        )
        .with_context(|| format!("解析 {} 失败", baseline_path.display()))?;
        baseline["workspace_path"]
            .as_str()
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
            .context("Codex 工作区基线缺少 workspace_path")?
    };
    acp_recovery_record(
        session_id,
        expected_backend,
        &state,
        workspace_path,
        &temporary_workspace,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn acp_session_classification_survives_missing_auxiliary_index() {
        assert_eq!(
            acp_session_backend(AgentBackend::Deepseek, CODEX_ACP_SESSION_MODEL),
            Some(AgentBackend::CodexAcp)
        );
        assert_eq!(
            acp_session_backend(AgentBackend::Deepseek, CLAUDE_ACP_SESSION_MODEL),
            Some(AgentBackend::ClaudeAcp)
        );
        assert_eq!(
            acp_session_backend(AgentBackend::Deepseek, KIMI_ACP_SESSION_MODEL),
            Some(AgentBackend::KimiAcp)
        );
        assert_eq!(
            acp_session_backend(AgentBackend::ClaudeAcp, "unexpected legacy model"),
            Some(AgentBackend::ClaudeAcp)
        );
        assert_eq!(
            acp_session_backend(AgentBackend::Deepseek, "deepseek-chat"),
            None
        );
    }

    #[test]
    fn acp_recovery_preserves_original_agent_session_mode_and_workspace() {
        let state = json!({
            "pinvouSessionId": "pinvou-session",
            "adapter": {
                "agentId": "kimi",
                "package": KIMI_ACP_PACKAGE,
            },
            "session": {
                "session_id": "acp-session",
                "current_model_id": "kimi-test",
                "modes": {
                    "currentModeId": "stale-agent-mode",
                    "availableModes": [],
                },
                "config_options": [
                    {
                        "id": "mode",
                        "currentValue": "auto",
                    },
                    {
                        "id": "reasoning_effort",
                        "currentValue": "high",
                    }
                ],
            },
        });
        // 用平台相关的绝对路径（/tmp 在 Windows 上不是绝对路径）。
        let temporary = std::env::temp_dir().join("pinvou-session-workspace");
        let project = std::env::temp_dir().join("pinvou-project");
        let recovered = acp_recovery_record(
            "pinvou-session",
            AgentBackend::KimiAcp,
            &state,
            project.clone(),
            &temporary,
        )
        .unwrap();

        assert_eq!(recovered.backend, AgentBackend::KimiAcp);
        assert_eq!(recovered.acp_session_id.as_deref(), Some("acp-session"));
        assert_eq!(recovered.acp_model_id.as_deref(), Some("kimi-test"));
        assert_eq!(recovered.acp_mode_id.as_deref(), Some("auto"));
        assert_eq!(
            recovered.acp_config_values.get("reasoning_effort"),
            Some(&"high".to_string())
        );
        assert_eq!(recovered.workspace_kind, CodexWorkspaceKind::Project);
        assert_eq!(recovered.workspace_path, Some(project));

        let temporary_recovered = acp_recovery_record(
            "pinvou-session",
            AgentBackend::KimiAcp,
            &state,
            temporary.clone(),
            &temporary,
        )
        .unwrap();
        assert_eq!(
            temporary_recovered.workspace_kind,
            CodexWorkspaceKind::Temporary
        );
        assert_eq!(temporary_recovered.workspace_path, None);
    }

    #[test]
    fn acp_recovery_rejects_incomplete_or_mismatched_state() {
        let state = json!({
            "pinvouSessionId": "pinvou-session",
            "adapter": {
                "agentId": "claude",
                "package": CLAUDE_ACP_PACKAGE,
            },
            "session": {},
        });
        assert!(acp_recovery_record(
            "pinvou-session",
            AgentBackend::ClaudeAcp,
            &state,
            PathBuf::from("/tmp/pinvou-project"),
            Path::new("/tmp/pinvou-session-workspace"),
        )
        .is_err());
        let mismatched = json!({
            "pinvouSessionId": "pinvou-session",
            "adapter": {
                "agentId": "claude",
                "package": CLAUDE_ACP_PACKAGE,
            },
            "session": { "session_id": "claude-session" },
        });
        assert!(acp_recovery_record(
            "pinvou-session",
            AgentBackend::KimiAcp,
            &mismatched,
            PathBuf::from("/tmp/pinvou-project"),
            Path::new("/tmp/pinvou-session-workspace"),
        )
        .is_err());
    }
}
