import assert from 'node:assert/strict';
import { createWorkspaceTrustGrants, trustDecision } from '../src/features/codex/workspace-trust.js';

// ── trustDecision：check_workspace_trust 返回 → UI 动作 ─────────────
// 已信任 → 直接放行，不弹确认。
assert.deepEqual(trustDecision({ path: '/p', trusted: true, warning: null }), { action: 'proceed' });
// 已信任且是危险目录（极端：信任后又判为家目录）也不再弹窗——信任清单是真相源。
assert.deepEqual(trustDecision({ path: '/home/u', trusted: true, warning: 'home' }), { action: 'proceed' });
// 未信任 → 弹授权确认；危险目录警示透传。
assert.deepEqual(trustDecision({ path: '/p', trusted: false, warning: null }), {
  action: 'confirm', path: '/p', warning: null,
});
assert.deepEqual(trustDecision({ path: '/home/u', trusted: false, warning: 'home' }), {
  action: 'confirm', path: '/home/u', warning: 'home',
});
assert.deepEqual(trustDecision({ path: 'C:\\', trusted: false, warning: 'root' }), {
  action: 'confirm', path: 'C:\\', warning: 'root',
});
// 缺字段兜底：status 缺失也按「弹确认」处理（不放行）。
assert.equal(trustDecision(null).action, 'confirm');
assert.equal(trustDecision({}).action, 'confirm');
assert.equal(trustDecision({ trusted: 0 }).action, 'confirm');

// ── createWorkspaceTrustGrants：confirmed 记账 ──────────────────────
{
  const grants = createWorkspaceTrustGrants();
  assert.equal(grants.isGranted('/p'), false);
  grants.grant('/p');
  assert.equal(grants.isGranted('/p'), true);
  // 只记确认过的路径；近似路径不命中（字符串精确相等，与 draftWorkspacePath 同源）。
  assert.equal(grants.isGranted('/p2'), false);
  assert.equal(grants.isGranted('/p/'), false);
  // 空值不记账、不命中。
  grants.grant('');
  grants.grant(null);
  grants.grant(undefined);
  assert.equal(grants.isGranted(''), false);
  assert.equal(grants.isGranted(null), false);
  assert.equal(grants.isGranted(undefined), false);
  // 重复确认幂等。
  grants.grant('/p');
  assert.equal(grants.isGranted('/p'), true);
}

console.log('workspace_trust_logic.test.mjs: all assertions passed');
