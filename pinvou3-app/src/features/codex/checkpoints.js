// 代码会话 checkpoint 的视图侧状态与纯逻辑。
//
// Rust 侧（features/code_sessions/checkpoints）在每个用户消息（turn）开始时对
// 执行根打快照并记录 turn 序号（1-based）；本模块按它把 checkpoint 入口对齐到
// 时间线的 turn 边界，并提供变更摘要解析（预览确认）与回滚调用。
//
// 对齐规则：turn 序号与投影 turns 数组下标一一对应（两个 adapter 的投影都是
// 「一个用户消息一个 turn」）；缺序号的条目按创建顺序兜底对齐，快照创建失败的
// turn 只是没有入口，不会错位——回滚前的 diff 预览展示的始终是真实差异。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { invokeTauri as invoke } from '../../platform/tauri/client.js';

/**
 * checkpoint 列表 → Map<turnNumber, checkpoint>。
 * turn 缺失（计数失败兜底）的条目按顺序补号；同一 turn 取先创建者（turn 快照），
 * 回滚点（turn=None）不占位。
 */
export function checkpointMapByTurn(checkpoints) {
  const map = new Map();
  let fallback = 0;
  for (const checkpoint of checkpoints || []) {
    const turn = Number.isInteger(checkpoint?.turn) && checkpoint.turn > 0
      ? checkpoint.turn
      : null;
    if (turn === null) continue;
    if (!map.has(turn)) map.set(turn, checkpoint);
    if (turn > fallback) fallback = turn;
  }
  // 全部缺序号时退化为按创建顺序对齐（老数据/计数失败场景）。
  if (!map.size && Array.isArray(checkpoints)) {
    checkpoints.forEach((checkpoint, index) => {
      if (checkpoint && checkpoint.id) map.set(index + 1, checkpoint);
    });
  }
  return map;
}

/** diff changes 清单 → 按状态计数的摘要（UI 预览「回滚将撤销的变更」）。 */
export function summarizeCheckpointChanges(changes) {
  const summary = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, other: 0, total: 0 };
  for (const change of changes || []) {
    if (!change || typeof change !== 'object') continue;
    const status = typeof change.status === 'string' ? change.status : 'other';
    if (Object.prototype.hasOwnProperty.call(summary, status) && status !== 'total') {
      summary[status] += 1;
    } else {
      summary.other += 1;
    }
    summary.total += 1;
  }
  return summary;
}

/**
 * 会话级 checkpoint 状态：列表加载/刷新、diff 预览缓存、回滚。
 * `enabled` 由 adapter capabilities.checkpoints 门控；`refreshKey` 变化（如 turns
 * 数变化）时重新拉取，让新 turn 的 checkpoint 入口及时出现。
 */
export function useSessionCheckpoints({ sessionId, enabled, refreshKey, onRestored }) {
  const [checkpoints, setCheckpoints] = useState([]);
  const [previews, setPreviews] = useState({});
  const [restoring, setRestoring] = useState(false);
  const sessionRef = useRef(sessionId);
  sessionRef.current = sessionId;

  const refresh = useCallback(async () => {
    const id = sessionRef.current;
    if (!id || !enabled) {
      setCheckpoints([]);
      setPreviews({});
      return;
    }
    try {
      const list = await invoke('list_checkpoints', { sessionId: id });
      if (sessionRef.current === id) {
        setCheckpoints(Array.isArray(list) ? list : []);
      }
    } catch {
      // 列表失败（会话被删/索引损坏）不打扰主流程：该会话没有检查点入口。
      if (sessionRef.current === id) setCheckpoints([]);
    }
  }, [enabled]);

  useEffect(() => {
    setPreviews({});
    refresh();
    // refreshKey 由调用方给（turns.length），变化即重新拉取。
  }, [sessionId, enabled, refreshKey, refresh]);

  const byTurn = useMemo(() => checkpointMapByTurn(checkpoints), [checkpoints]);

  /** 懒加载某 checkpoint 的 diff 预览（缓存按 sessionId 失效）。 */
  const preview = useCallback(async (checkpointId) => {
    const id = sessionRef.current;
    if (!id) return;
    setPreviews(current => ({ ...current, [checkpointId]: { loading: true } }));
    try {
      const diff = await invoke('checkpoint_diff', { sessionId: id, checkpointId });
      if (sessionRef.current === id) {
        setPreviews(current => ({ ...current, [checkpointId]: { loading: false, diff } }));
      }
    } catch (error) {
      if (sessionRef.current === id) {
        setPreviews(current => ({ ...current, [checkpointId]: { loading: false, error: String(error) } }));
      }
    }
  }, []);

  /** 回滚到指定 checkpoint；成功后刷新列表并通知调用方（刷新工作区面板/记日志）。 */
  const restore = useCallback(async (checkpointId) => {
    const id = sessionRef.current;
    if (!id) throw new Error('no session');
    setRestoring(true);
    try {
      await invoke('restore_checkpoint', { sessionId: id, checkpointId });
      // 预览缓存基于回滚前的执行根，全部作废；列表刷新后重新懒加载。
      setPreviews({});
      await refresh();
      if (onRestored) onRestored(checkpointId);
    } finally {
      setRestoring(false);
    }
  }, [refresh, onRestored]);

  return { checkpoints, byTurn, previews, preview, restore, restoring, refresh };
}
