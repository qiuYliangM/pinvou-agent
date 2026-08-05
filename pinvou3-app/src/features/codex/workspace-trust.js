// Workspace trust（项目目录信任）的前端纯逻辑：授权决策与确认记账。
//
// 信任判定与持久化的权威在 Rust（`~/.pinvou3/trusted_workspaces.json`，
// 归一化与 validate_codex_project_workspace 同源）；本模块只承载前端侧两件
// 可单测的事：
// 1. check_workspace_trust 返回值 → UI 动作（直接放行 / 弹授权确认）；
// 2. 用户确认记账——createSession 时按原始选择路径查账，命中才传
//    `confirmed: true`（confirmed 参数仅前端确认后才传；防绕过由 Rust 侧
//    「已信任 或 confirmed=true」校验兜底）。

/// check_workspace_trust 的返回 { path, trusted, warning } → 绑定前置决策。
/// 已信任 → proceed；否则 confirm（warning 为 'home' | 'root' 时弹窗带额外警示）。
export function trustDecision(status) {
  if (status && status.trusted) return { action: 'proceed' };
  return {
    action: 'confirm',
    path: (status && status.path) || '',
    warning: (status && status.warning) || null,
  };
}

/// 用户确认过的目录记账（键 = 用户选择时的原始路径字符串，与
/// draftWorkspacePath 同源，createSession 时字符串相等即命中）。
export function createWorkspaceTrustGrants() {
  const granted = new Set();
  return {
    grant(path) {
      if (path) granted.add(String(path));
    },
    isGranted(path) {
      return granted.has(String(path || ''));
    },
  };
}
