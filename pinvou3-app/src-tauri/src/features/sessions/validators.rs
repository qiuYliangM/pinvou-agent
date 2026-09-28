//! Session id, workspace, and path validators plus the small persistence
//! helpers shared across the session store submodules.
//!
//! These free functions are intentionally side-effect-free (validation) or
//! trivially derivable (path composition / system-prompt flattening) so that
//! every other submodule can depend on them without introducing cycles.

use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use deepseek_tui::models::SystemPrompt;
use deepseek_tui::session_manager::SessionManager;

/// 生成 URL-safe session id（短 8 字节 timestamp + nanos hash）。
/// 上游 `validated_session_path` 只允许 `[A-Za-z0-9_-]`，所以走 base32-like 字符集。
pub(crate) fn validate_session_id(id: &str) -> Result<()> {
    if id.trim().is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        bail!("Invalid session id '{id}'");
    }
    Ok(())
}

pub(crate) fn validate_scheduled_session_id(id: &str) -> Result<()> {
    validate_session_id(id)?;
    if !id.starts_with("sched-") {
        bail!("Scheduled session id must start with 'sched-': {id}");
    }
    Ok(())
}

pub(crate) fn validate_scheduled_task_id(id: &str) -> Result<()> {
    if id.trim().is_empty()
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        bail!("Invalid scheduled task id '{id}'");
    }
    Ok(())
}

pub(crate) fn validate_scheduled_workspace_path(root: &Path, workspace: &Path) -> Result<()> {
    if !workspace.is_absolute() {
        bail!(
            "Scheduled profile workspace must be absolute: {}",
            workspace.display()
        );
    }
    if workspace
        .components()
        .any(|component| matches!(component, Component::ParentDir))
    {
        bail!(
            "Scheduled profile workspace must not contain parent segments: {}",
            workspace.display()
        );
    }
    if !workspace.starts_with(root) {
        bail!(
            "Scheduled profile workspace must live under {}: {}",
            root.display(),
            workspace.display()
        );
    }
    if workspace.file_name().and_then(|name| name.to_str()) != Some("workspace") {
        bail!(
            "Scheduled profile workspace must end with 'workspace': {}",
            workspace.display()
        );
    }
    Ok(())
}

/// Validates the working directory a user selected for a plain chat session:
/// non-empty, absolute, must exist on disk and be a directory. Returns the
/// canonicalized path (removing `.`, symlinks, and trailing separators); callers
/// use the return value for both binding and display.
pub(crate) fn validate_user_workspace_path(raw: &str) -> Result<PathBuf> {
    if raw.trim().is_empty() {
        bail!("Workspace path must not be empty");
    }
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        bail!("Workspace path must be absolute: {raw}");
    }
    let canonical = path
        .canonicalize()
        .with_context(|| format!("Workspace path does not exist: {raw}"))?;
    if !canonical.is_dir() {
        bail!("Workspace path must be a directory: {raw}");
    }
    // Windows canonicalize returns a \?\ verbatim prefix; agents and the
    // frontend misjudge cwd in string/prefix comparisons, so normalize to a
    // regular drive path (identity on non-Windows) — the same invariant as
    // validate_codex_project_workspace.
    Ok(crate::platform::os::platform_compat_path(
        &canonical.to_string_lossy(),
    ))
}

/// Input validation for the keychain snapshot (§6): every additional root
/// must be absolute (hard reject, same gate as cwd); nonexistent/non-
/// directory roots only log a soft warning — following rebind's established
/// pattern, the target directory may be moved away and recreated later, the
/// snapshot faithfully records the user's choice at the time, and the
/// engine-side write exemption for a nonexistent root naturally lapses.
/// Successfully canonicalized roots use the canonical form (resolving
/// symlink/verbatim prefixes, same invariant as
/// validate_user_workspace_path); failures keep the lexical original.
///
/// Intake parity with the foundation's same-named validator
/// (`codewhale_core::validate_workspace_roots`, review #484 round-13 M2):
/// the delivery lane consumes the snapshot through the tolerant
/// `normalize_workspace_roots` only, so a root that normalizes to the
/// filesystem root — or, when the caller declares the workspace alongside,
/// a proper ancestor of that primary — would reach
/// `WorkspaceWrite.writable_roots` verbatim and make the sandboxed exec
/// lane filesystem-writable. Both classes are rejected here with the
/// foundation's reasoning. A root that merely sits under the primary stays
/// fine (already writable through it), and a root equal to the primary
/// dedups downstream.
pub(crate) fn validate_workspace_roots(
    raw: Vec<String>,
    primary: Option<&std::path::Path>,
) -> Result<Vec<PathBuf>, String> {
    let primary_lexical = primary.map(lexical_normalize);
    let mut roots = Vec::with_capacity(raw.len());
    for entry in raw {
        let path = PathBuf::from(&entry);
        if !path.is_absolute() {
            return Err(format!("workspace root must be absolute: {entry}"));
        }
        let lexical = lexical_normalize(&path);
        if is_filesystem_root(&lexical) {
            return Err(format!(
                "workspace root {entry:?} normalizes to the filesystem root; \
                 attaching it would make the whole filesystem writable"
            ));
        }
        if let Some(primary_lexical) = &primary_lexical {
            if primary_lexical != &lexical && primary_lexical.starts_with(&lexical) {
                return Err(format!(
                    "workspace root {entry:?} contains the primary workspace; \
                     attaching an ancestor of the primary would widen the sandbox"
                ));
            }
        }
        match path.canonicalize() {
            Ok(canonical) if canonical.is_dir() => {
                roots.push(crate::platform::os::platform_compat_path(
                    &canonical.to_string_lossy(),
                ));
            }
            Ok(_) => {
                // Log hygiene (CodeQL cleartext-logging, same convention as
                // the rebind lanes): the user-supplied absolute path stays out
                // of the log; the soft warning records only the failure class.
                eprintln!("[sessions] workspace root is not a directory (kept as-is)");
                roots.push(path);
            }
            Err(error) => {
                eprintln!(
                    "[sessions] workspace root canonicalize failed (kept as-is): {:?}",
                    error.kind()
                );
                roots.push(path);
            }
        }
    }
    Ok(roots)
}

/// Lexically collapse `.`/`..` components of an absolute path, clamping a
/// `..` at the filesystem root — comparison-local, the same normalization
/// the foundation's intake applies before its root-vs-primary checks.
fn lexical_normalize(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::Prefix(_) | std::path::Component::RootDir => {
                normalized.push(component.as_os_str());
            }
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                normalized.pop();
            }
            std::path::Component::Normal(part) => normalized.push(part),
        }
    }
    normalized
}

/// True when no named component remains after lexical normalization
/// (`/`, a Windows drive root, or a `..`-clamped spelling of either).
fn is_filesystem_root(path: &Path) -> bool {
    !path
        .components()
        .any(|component| matches!(component, std::path::Component::Normal(_)))
}

pub(crate) fn persisted_system_prompt(system_prompt: Option<&SystemPrompt>) -> Option<String> {
    match system_prompt {
        Some(SystemPrompt::Text(text)) => Some(text.clone()),
        Some(SystemPrompt::Blocks(blocks)) => Some(
            blocks
                .iter()
                .map(|block| block.text.clone())
                .collect::<Vec<_>>()
                .join("\n\n---\n\n"),
        ),
        None => None,
    }
}

pub(crate) fn chat_session_file(manager: &SessionManager, id: &str) -> Result<PathBuf> {
    validate_session_id(id)?;
    Ok(manager.sessions_dir().join(format!("{id}.json")))
}

pub(crate) fn scheduled_session_file(manager: &SessionManager, id: &str) -> Result<PathBuf> {
    validate_scheduled_session_id(id)?;
    Ok(manager.sessions_dir().join(format!("{id}.json")))
}

pub(crate) fn generate_session_id() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    const ALPHA: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut n = nanos;
    let mut buf = String::with_capacity(13);
    for _ in 0..13 {
        buf.push(ALPHA[(n % 36) as usize] as char);
        n /= 36;
    }
    buf
}

#[cfg(test)]
mod workspace_roots_tests {
    //! `validate_workspace_roots` is the security-relevant validation of a
    //! new input surface (§6 keychain snapshot): relative paths are hard-
    //! rejected, nonexistent/non-directory roots are soft-kept, existing
    //! directories are canonicalized.
    use super::*;

    fn unique_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pinvou3-roots-validate-{label}-{}",
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ))
    }

    #[test]
    fn rejects_relative_roots() {
        let error = validate_workspace_roots(vec!["relative/x".to_string()], None)
            .expect_err("relative root must be rejected");
        assert!(error.contains("must be absolute"), "{error}");
        // Mixing in a legal root does not let it through: any relative path
        // rejects the whole batch.
        let abs = std::env::temp_dir().to_string_lossy().into_owned();
        assert!(validate_workspace_roots(vec![abs, "x".to_string()], None).is_err());
    }

    #[test]
    fn empty_input_is_single_root_semantics() {
        assert_eq!(
            validate_workspace_roots(Vec::new(), None).unwrap(),
            Vec::<PathBuf>::new()
        );
    }

    #[test]
    fn existing_dirs_are_canonicalized() {
        let temp = tempfile::tempdir().expect("tempdir");
        let real = temp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        // Trailing `.` and separator spellings are normalized by
        // canonicalize (symlink/verbatim prefix stripping is covered by the
        // platform helper; this locks the lexical normalization).
        let spelled = format!("{}/./", real.display());
        let roots = validate_workspace_roots(vec![spelled], None).expect("valid");
        // The expected side goes through the same projection as production
        // (canonicalize + platform_compat_path), so Windows verbatim `\?\`
        // prefixes are stripped on both sides of the comparison.
        let expected = crate::platform::os::platform_compat_path(
            &real.canonicalize().unwrap().to_string_lossy(),
        );
        assert_eq!(roots, vec![expected]);
    }

    #[test]
    fn symlink_spelling_resolves_to_canonical_form() {
        // Same shape as macOS /var→/private/var: a symlink spelling is
        // stored in canonical form, consistent with the project layer's
        // stored-value identity keys. Directory symlinks on Windows need
        // privileges; unix/macOS cover this (no cfg: architecture-guard).
        if std::env::consts::OS == "windows" {
            return;
        }
        let temp = tempfile::tempdir().expect("tempdir");
        let real = temp.path().join("real");
        std::fs::create_dir_all(&real).unwrap();
        let link = temp.path().join("link");
        let status = std::process::Command::new("ln")
            .arg("-s")
            .arg(&real)
            .arg(&link)
            .status()
            .expect("spawn ln");
        assert!(status.success());
        let roots = validate_workspace_roots(vec![link.to_string_lossy().into_owned()], None)
            .expect("symlink root kept");
        assert_eq!(roots, vec![real.canonicalize().unwrap()]);
    }

    #[test]
    fn missing_or_file_roots_are_soft_kept_lexically() {
        // Soft keep: a nonexistent additional root is kept at its lexical
        // value (the target may be recreated later).
        let missing = unique_dir("missing");
        let roots = validate_workspace_roots(vec![missing.to_string_lossy().into_owned()], None)
            .expect("kept");
        assert_eq!(roots, vec![missing.clone()]);

        // Existing but not a directory is equally soft-kept (lexical value,
        // no canonicalize).
        let temp = tempfile::tempdir().expect("tempdir");
        let file = temp.path().join("a-file");
        std::fs::write(&file, b"x").unwrap();
        let roots = validate_workspace_roots(vec![file.to_string_lossy().into_owned()], None)
            .expect("kept");
        assert_eq!(roots, vec![file]);
        let _ = std::fs::remove_dir_all(&missing);
    }

    #[test]
    fn intake_rejects_fs_root_ancestor_and_relative_like_the_foundation() {
        // Round-13 M2 intake parity with codewhale_core::validate_workspace_roots:
        // the delivery lane only re-normalizes, so a fs-root (or `/..`-spelled)
        // additional root, or — when the workspace is declared alongside — a
        // proper ancestor of that primary, must be hard-rejected instead of
        // reaching WorkspaceWrite.writable_roots verbatim.
        let err = validate_workspace_roots(vec!["/".to_string()], None)
            .expect_err("filesystem root must be rejected");
        assert!(err.contains("filesystem root"), "{err}");
        let err = validate_workspace_roots(vec!["/shared/..".to_string()], None)
            .expect_err("a ..-clamped fs-root spelling is the same class");
        assert!(err.contains("filesystem root"), "{err}");

        let primary = std::path::PathBuf::from("/home/u/proj");
        let err = validate_workspace_roots(vec!["/home".to_string()], Some(&primary))
            .expect_err("an ancestor of the primary must be rejected");
        assert!(err.contains("ancestor of the primary"), "{err}");

        // Under-primary and sibling roots stay fine; with no primary declared
        // (temporary-session shape) only the primary-independent checks run.
        let ok = validate_workspace_roots(
            vec!["/home/u/proj/crates".to_string(), "/elsewhere".to_string()],
            Some(&primary),
        )
        .expect("subdirectory and sibling roots are fine");
        assert_eq!(ok.len(), 2);
        validate_workspace_roots(vec!["/home".to_string()], None)
            .expect("without a declared primary the ancestor check cannot apply");
    }
}
