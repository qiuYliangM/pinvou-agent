//! 项目目录信任清单（workspace trust）。
//!
//! 绑定项目目录 = 把该目录授权为代码会话的执行根：引擎可以在其中读写文件、
//! 执行 shell（敏感目录仍受 hooks 防火墙约束）。首次绑定前必须由用户显式授权；
//! 授权记录持久化在 `~/.pinvou3/trusted_workspaces.json`，路径归一化与
//! [`super::validate_codex_project_workspace`] 同源（canonicalize +
//! `platform_compat_path`），再次绑定同一目录免确认。
//!
//! 防绕过：信任判定只在 Rust 侧进行。绑定命令（`create_codex_acp_session`）
//! 要求「该路径已在清单中」或「调用方显式带 `confirmed=true`」（前端仅在用户
//! 确认弹窗后才传）；`confirmed=true` 通过校验的同时把路径记入清单。
//!
//! 行为兼容：功能上线前已绑定会话的执行根视为已信任——启动时把
//! `session-agents.json` 里所有项目绑定回填进清单（`backfill`），信任清单是
//! 唯一真相源；「不再信任」只影响后续新绑定，已在跑的会话不 retroactive 回收。

use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context, Result};
use parking_lot::RwLock;
use serde::{Deserialize, Serialize};

const TRUSTED_WORKSPACES_VERSION: u32 = 1;

#[derive(Debug, Default, Serialize, Deserialize)]
struct TrustedWorkspacesFile {
    #[serde(default = "trusted_workspaces_version")]
    version: u32,
    #[serde(default)]
    workspaces: Vec<PathBuf>,
}

fn trusted_workspaces_version() -> u32 {
    TRUSTED_WORKSPACES_VERSION
}

/// 危险目录警示：绑定家目录本身 / 盘符（文件系统）根为项目根时，即使确认也要
/// 额外警示（与安全审查 #12 的边界语义呼应：执行根越大，爆炸半径越大）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WorkspaceTrustWarning {
    /// 项目根 == 用户家目录本身。
    Home,
    /// 项目根 == 盘符/文件系统根（`C:\`、`/`、UNC 共享根）。
    Root,
}

impl WorkspaceTrustWarning {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Home => "home",
            Self::Root => "root",
        }
    }
}

/// 对已归一化的项目根判定危险目录警示。`None` = 常规项目目录。
///
/// 判定顺序：家目录优先于根目录（极端平台上家目录可能就是根，按家目录警示）。
/// 根判定用 `parent().is_none()`：归一化后的 `C:\`、`/`、UNC 共享根均无父级。
pub fn trust_warning_for(normalized: &Path) -> Option<WorkspaceTrustWarning> {
    // 双侧都以 canonical 形态比较：调用方传入的路径已经 canonicalize，家目录
    // 在这里补同样的归一化（canonicalize 失败退回原始形态，不影响常规平台）。
    let home = crate::platform::paths::user_home_dir();
    let canonical_home = home.canonicalize().unwrap_or_else(|_| home.clone());
    let canonical_home = crate::platform::os::platform_compat_path(&canonical_home.to_string_lossy());
    if normalized == canonical_home {
        return Some(WorkspaceTrustWarning::Home);
    }
    if normalized.parent().is_none() {
        return Some(WorkspaceTrustWarning::Root);
    }
    None
}

/// 信任清单 store。文件是用户可直接检查/编辑的纯清单（无 secret），损坏时
/// 按空清单启动（`load_or_empty`）：最坏后果是重新弹一次授权确认，不会放权。
#[derive(Clone)]
pub struct TrustedWorkspaceStore {
    path: PathBuf,
    entries: Arc<RwLock<BTreeSet<PathBuf>>>,
}

impl TrustedWorkspaceStore {
    pub fn load() -> Result<Self> {
        let path = crate::platform::paths::pinvou3_home().join("trusted_workspaces.json");
        let entries = if path.exists() {
            let raw = fs::read_to_string(&path)
                .with_context(|| format!("读取 {} 失败", path.display()))?;
            serde_json::from_str::<TrustedWorkspacesFile>(&raw)
                .with_context(|| format!("解析 {} 失败", path.display()))?
                .workspaces
                .into_iter()
                .collect()
        } else {
            BTreeSet::new()
        };
        Ok(Self {
            path,
            entries: Arc::new(RwLock::new(entries)),
        })
    }

    /// 清单损坏不阻断启动：按空清单启动（重新授权即可恢复），并记日志。
    pub fn load_or_empty() -> Self {
        match Self::load() {
            Ok(store) => store,
            Err(error) => {
                eprintln!("[pinvou3-app] trusted workspaces unavailable, starting empty: {error:#}");
                Self {
                    path: crate::platform::paths::pinvou3_home().join("trusted_workspaces.json"),
                    entries: Arc::new(RwLock::new(BTreeSet::new())),
                }
            }
        }
    }

    /// 测试专用：以指定清单路径构造空 store。
    #[cfg(test)]
    pub(crate) fn for_test(path: PathBuf) -> Self {
        Self {
            path,
            entries: Arc::new(RwLock::new(BTreeSet::new())),
        }
    }

    /// `path` 必须已是 `validate_codex_project_workspace` 归一化后的形态。
    pub fn is_trusted(&self, path: &Path) -> bool {
        self.entries.read().contains(path)
    }

    /// 记录信任并持久化；幂等（重复信任同一路径不报错）。
    pub fn trust(&self, path: PathBuf) -> Result<()> {
        {
            let mut entries = self.entries.write();
            entries.insert(path);
        }
        self.persist()
    }

    /// 撤销信任；返回是否确实移除了条目。
    pub fn untrust(&self, path: &Path) -> Result<bool> {
        let removed = {
            let mut entries = self.entries.write();
            entries.remove(path)
        };
        if removed {
            self.persist()?;
        }
        Ok(removed)
    }

    /// 当前清单（排序稳定，供设置/管理界面展示）。
    pub fn list(&self) -> Vec<PathBuf> {
        self.entries.read().iter().cloned().collect()
    }

    /// 启动回填：把既有绑定记录的项目目录并入清单，返回新增条数。
    /// 只在有新增时写盘。
    pub fn backfill(&self, paths: impl IntoIterator<Item = PathBuf>) -> usize {
        let added = {
            let mut entries = self.entries.write();
            let before = entries.len();
            entries.extend(paths);
            entries.len() - before
        };
        if added > 0 {
            if let Err(error) = self.persist() {
                eprintln!("[pinvou3-app] backfill trusted workspaces failed to persist: {error:#}");
            }
        }
        added
    }

    fn persist(&self) -> Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let value = TrustedWorkspacesFile {
            version: TRUSTED_WORKSPACES_VERSION,
            workspaces: self.list(),
        };
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, serde_json::to_vec_pretty(&value)?)?;
        fs::rename(&temporary, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_root(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pinvou3-workspace-trust-test-{tag}-{}",
            std::process::id()
        ))
    }

    #[test]
    fn trust_persists_and_reloads() {
        let root = test_root("persist");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("trusted_workspaces.json");
        let store = TrustedWorkspaceStore::for_test(path.clone());
        let dir = crate::platform::os::platform_compat_path("/tmp/pinvou3-trust-a");
        assert!(!store.is_trusted(&dir));
        store.trust(dir.clone()).unwrap();
        assert!(store.is_trusted(&dir));
        // 重新加载后仍在（持久化生效）。
        let raw = fs::read_to_string(&path).unwrap();
        let reloaded: TrustedWorkspacesFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(reloaded.version, TRUSTED_WORKSPACES_VERSION);
        assert_eq!(reloaded.workspaces, vec![dir.clone()]);
        // 撤销后持久化。
        assert!(store.untrust(&dir).unwrap());
        assert!(!store.is_trusted(&dir));
        assert!(!store.untrust(&dir).unwrap());
        let raw = fs::read_to_string(&path).unwrap();
        let reloaded: TrustedWorkspacesFile = serde_json::from_str(&raw).unwrap();
        assert!(reloaded.workspaces.is_empty());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn backfill_only_adds_missing_and_is_idempotent() {
        let root = test_root("backfill");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let store = TrustedWorkspaceStore::for_test(root.join("trusted_workspaces.json"));
        let a = crate::platform::os::platform_compat_path("/tmp/pinvou3-trust-a");
        let b = crate::platform::os::platform_compat_path("/tmp/pinvou3-trust-b");
        assert_eq!(store.backfill(vec![a.clone(), b.clone()]), 2);
        assert_eq!(store.backfill(vec![a.clone(), b.clone()]), 0);
        assert_eq!(store.backfill(vec![a.clone()]), 0);
        assert_eq!(store.list(), vec![a, b]);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_file_starts_empty() {
        let root = test_root("corrupt");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        let path = root.join("trusted_workspaces.json");
        fs::write(&path, b"not json").unwrap();
        // load 报错；load_or_empty 兜底为空清单（最坏后果 = 重新授权一次）。
        let file: Result<TrustedWorkspacesFile, _> = serde_json::from_str("not json");
        assert!(file.is_err());
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn warning_flags_home_and_root_but_not_project_dir() {
        let home = crate::platform::paths::user_home_dir();
        let canonical_home = home.canonicalize().unwrap_or_else(|_| home.clone());
        let canonical_home =
            crate::platform::os::platform_compat_path(&canonical_home.to_string_lossy());
        assert_eq!(
            trust_warning_for(&canonical_home),
            Some(WorkspaceTrustWarning::Home)
        );
        // 家目录下的普通项目目录不警示。
        let project = canonical_home.join("some-project");
        assert_eq!(trust_warning_for(&project), None);
        // 盘符/文件系统根：无父级。取家目录的根祖先构造（Windows 为盘符根、
        // Unix 为 /），避免在功能代码里写平台条件编译。
        let fs_root: PathBuf = canonical_home
            .ancestors()
            .last()
            .expect("absolute home has a root ancestor")
            .to_path_buf();
        assert!(fs_root.parent().is_none());
        assert_eq!(
            trust_warning_for(&fs_root),
            Some(WorkspaceTrustWarning::Root)
        );
        assert_eq!(WorkspaceTrustWarning::Home.as_str(), "home");
        assert_eq!(WorkspaceTrustWarning::Root.as_str(), "root");
    }
}
