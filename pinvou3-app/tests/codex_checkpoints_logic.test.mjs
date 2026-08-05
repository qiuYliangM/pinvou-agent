import assert from 'node:assert/strict';
import { checkpointMapByTurn, summarizeCheckpointChanges } from '../src/features/codex/checkpoints.js';

// ── checkpointMapByTurn：turn 序号对齐 ──────────────────────────────
{
  const map = checkpointMapByTurn([
    { id: 'c1', turn: 1 },
    { id: 'c2', turn: 2 },
    { id: 'c3', turn: 3 },
  ]);
  assert.equal(map.get(1).id, 'c1');
  assert.equal(map.get(2).id, 'c2');
  assert.equal(map.get(3).id, 'c3');
  assert.equal(map.get(4), undefined);
}

// 回滚点（turn=None）不占位，不与 turn 快照抢序号。
{
  const map = checkpointMapByTurn([
    { id: 'c1', turn: 1 },
    { id: 'undo', turn: null, kind: 'preRestore' },
    { id: 'c2', turn: 2 },
  ]);
  assert.equal(map.size, 2);
  assert.equal(map.get(2).id, 'c2');
}

// 快照创建失败的 turn 没有条目：后续 turn 的序号不漂移（靠 turn 字段而非位置）。
{
  const map = checkpointMapByTurn([
    { id: 'c1', turn: 1 },
    { id: 'c3', turn: 3 },
  ]);
  assert.equal(map.get(2), undefined);
  assert.equal(map.get(3).id, 'c3');
}

// 全部缺序号（计数失败兜底）时按创建顺序对齐。
{
  const map = checkpointMapByTurn([{ id: 'a' }, { id: 'b' }]);
  assert.equal(map.get(1).id, 'a');
  assert.equal(map.get(2).id, 'b');
}

// 空/非法输入。
assert.equal(checkpointMapByTurn([]).size, 0);
assert.equal(checkpointMapByTurn(null).size, 0);
assert.equal(checkpointMapByTurn(undefined).size, 0);

// ── summarizeCheckpointChanges：diff 摘要计数 ───────────────────────
{
  const summary = summarizeCheckpointChanges([
    { path: 'a.rs', status: 'added' },
    { path: 'b.rs', status: 'added' },
    { path: 'c.rs', status: 'modified' },
    { path: 'd.rs', status: 'deleted' },
    { path: 'e.rs', status: 'renamed' },
    { path: 'f.rs', status: 'copied' },
    { path: 'g.rs', status: 'weird' },
    { path: 'h.rs' },
    null,
  ]);
  assert.deepEqual(summary, {
    added: 2, modified: 1, deleted: 1, renamed: 1, copied: 1, other: 2, total: 8,
  });
}
assert.deepEqual(summarizeCheckpointChanges([]), {
  added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, other: 0, total: 0,
});
assert.deepEqual(summarizeCheckpointChanges(null).total, 0);

console.log('codex_checkpoints_logic: all assertions passed');
