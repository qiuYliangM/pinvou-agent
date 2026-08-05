// Plan 审批卡（accept_plan）的纯逻辑：plan 快照 → 执行指令 markdown、
// update_plan 工具参数 → plan 快照、会话 items → 最后一次 plan 快照。
//
// composePlanMarkdown 与聊天页 bridge.js 的同名函数同契约（accept_plan 命令把
// 该 markdown 拼进「立即执行」指令发给引擎）；代码车道（会话作用域 store）自持
// 一份，避免 features/conversation 反向依赖 platform/tauri/bridge。

export const UPDATE_PLAN_TOOL = 'update_plan';

function statusSymbol(status) {
  return status === 'completed' ? '●' : status === 'in_progress' ? '◎' : '○';
}

/// { plan: {explanation, items:[{step,status}]}, todos: {items:[{content,status}]} }
/// → accept_plan 的 plan_markdown。
export function composePlanMarkdown(snapshots) {
  const lines = [];
  const plan = snapshots && snapshots.plan;
  const todos = snapshots && snapshots.todos;
  if (plan && Array.isArray(plan.items)) {
    if (plan.explanation) lines.push('**方案：**', plan.explanation, '');
    lines.push('**步骤：**');
    plan.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${statusSymbol(item && item.status)} ${item && item.step}`);
    });
    lines.push('');
  }
  if (todos && Array.isArray(todos.items)) {
    lines.push('**细分待办：**');
    todos.items.forEach((item, index) => {
      lines.push(`${index + 1}. ${statusSymbol(item && item.status)} ${item && item.content}`);
    });
  }
  return lines.length > 0 ? lines.join('\n') : '（plan 为空）';
}

/// update_plan 工具调用的 input（{explanation, items:[{step,status}]}）→ plan 快照；
/// 形状不符（非对象 / 无有效步骤）返回 null。
export function planSnapshotFromToolArgs(args) {
  if (!args || typeof args !== 'object') return null;
  const rawItems = Array.isArray(args.items) ? args.items : [];
  const items = rawItems
    .map(item => ({
      step: String((item && item.step) || ''),
      status: String((item && item.status) || 'pending'),
    }))
    .filter(item => item.step);
  if (!items.length) return null;
  return {
    explanation: typeof args.explanation === 'string' ? args.explanation : '',
    items,
  };
}

/// 从会话 items（hydrate/事件推进后的 tool 卡）找最后一次 update_plan 的 plan
/// 快照；没有则 null。重载还原挂起方案卡用（plan 快照本体不落盘）。
export function lastPlanSnapshotFromItems(items) {
  const list = Array.isArray(items) ? items : [];
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const item = list[index];
    if (item && item.type === 'tool' && item.name === UPDATE_PLAN_TOOL) {
      const snapshot = planSnapshotFromToolArgs(item.args);
      if (snapshot) return snapshot;
    }
  }
  return null;
}
