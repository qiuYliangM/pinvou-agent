# 完全体 Code 模式升级实施记录

> 关联：`docs/code-native-agent-完全体架构设计.md`（总设计）、`docs/code-native-agent-会话能力档案设计.md`（阶段一核心）。
> 工作分支：`feat/full-code-mode`（fork 仓 `qiuYliangM/pinvou-agent`）；底座分支 `feat/session-capability-profile`（fork 仓 `qiuYliangM/CodeWhale`）。
> 红线：上游 `Pinvou/pinvou-agent`、`Pinvou/CodeWhale` 只读，零写入；所有提交仅推 fork。
> 本文件随阶段推进持续更新，作为各阶段验收依据。

## 阶段一：类型与能力地基 ✅ 已完成

**提交**：CodeWhale `0bb4266`（fork 侧档案化）→ parent `e3bc513c`（SessionKind + app 侧接入 + fork 登记/指纹）→ `11452198`（UI 恢复可交互）。环境准备提交：`.gitmodules` 指向 fork、CodeWhale 基线 tag `pinvou-v0.9.0-r3` 补推 fork。

### 实施内容

| 模块 | 改动 | 要点 |
|---|---|---|
| fork（CodeWhale） | `EngineConfig.disabled_skills: Option<Vec<String>>`；catalogue/`load_skill` 同走 `is_skill_disabled_for_session`；`Op::SetDisabledSkills` 热更 | None=回落进程级全局（无档案会话行为逐字节不变，golden 锁定）；Some=会话集**替换**全局（非并集，否则 plain 禁用穿透回代码会话）；空集 `Some(vec![])` ≠ None |
| app 会话模型 | `SessionKind { Chat, CodeNative, CodeAcp, ScheduledRun }` 一等化（`sessions/mod.rs`）；`SessionAgentRecord.kind` serde 兼容 | 旧记录 legacy 推导 + `sync_kind_mirror()` 构造性保证「显式==推导」；三处谓词闭包收敛为单一 `session_kind` 判定；列表互斥守卫改 `listed_session_kind` 纯核双向；`code_session` bool 保留为兼容镜像（停写留后续迁移 PR）；sidecar 崩溃恢复机制不变 |
| app 能力解析 | `bridge.shape_disabled_skills`：CodeNative → Some(code 禁用集折算 + code 禁连接器 companion)，其余 → None | code 未初始化 companion 全禁（安全默认与 disallowed_tools 一致）；「plain 关、code 开」成立（替换语义 app 侧锁定） |
| 下发链路 | spawn 覆盖（engine.rs）+ `EnginePool::refresh_disabled_skills` 广播 | 触发点：`set_disabled_connectors(scope=code)`、skill 装/卸/导入、启动补刷存量会话 |
| 方案 D 退役 | 代码会话不再整禁 `load_skill`；UI 只读灰显/说明文案/三语 key 移除，开关恢复真实可交互 | skill 隔离由档案承担；catalogue 不列出 = read_file 照抄路径侧路封死 |
| fork 合规 | `docs/fork-modifications.md` T3 更新；`scripts/fork-guard.sh` 锚点换 `is_skill_disabled_for_session` | `fork-guard.sh --fast` 全过 |

### 验收矩阵

| 验收项 | 方式 | 结果 |
|---|---|---|
| 无档案会话（plain/ACP）提示词零变化 | fork golden `forkguard_session_profile_none_matches_global_byte_for_byte` + prompts 99 全绿 | ✅（fork 本机已跑） |
| 替换语义双向锁定 | `forkguard_session_profile_replaces_global_set_in_catalogue`（全局禁会话未列→仍列出；会话禁→隐藏） | ✅ |
| `load_skill` 按会话集判定 + None 回落 | `forkguard_load_skill_*` ×2 | ✅ |
| 热更生效 | `forkguard_set_disabled_skills_hot_update_renders_new_catalogue` | ✅ |
| app 解析语义（code 集/companion 全禁/替换语义/None） | `code_session_skill_profile_resolves_code_scope_set` | ⚠️ 编译过，**本机 0xc0000139 无法运行，待可运行环境/CI** |
| SessionKind 兼容与列表互斥 | store.rs/sessions.rs 新增单测（legacy 推导、双向真值表） | ⚠️ 同上待 CI |
| 前端 | `test:composer-tools`、`test:ui-language`、eslint | ✅ 全绿 |
| 架构/指纹守卫 | `architecture-guard.py`、`fork-guard.sh --fast` | ✅ |
| 编译 | `cargo check --all-targets` 零新增警告；`cargo test --no-run --lib` 链接过 | ✅ |

### 已知残留（如实登记）

1. **Rust 测试未实机运行**：本机测试二进制 0xc0000139（机器级 DLL 环境问题，与安全审查 #29 同源），新增 Rust 单测断言为静态推演 + 编译验证，**需在可运行环境/CI 确认**。
2. **ima 连接/断开不在热更触发点内**（`connectors/ima.rs:310/343`）：在跑代码会话的 Some 集等下次触发才重算；修法是把 ima_connect/logout 改为带 EnginePool 的命令，小改未做。
3. **猜路径 read_file 残留**：skill 路径形态可预测，catalogue 不列出后模型可盲猜 `read_file`；封口补法是文件工具工作区围栏（能力档案设计 §5，独立专项）。
4. **`code_session` bool 镜像停写**：留作后续独立迁移 PR。
5. fork 基线已有失败（`cached_skills_*`×2、`command_palette_skills_*`、engine 套件 8 个环境性失败）与本改动无关，另行登记。

## 阶段二：体验闭环 ⏳ 待实施

范围（设计 §5）：CodeView 上提（`codex_acp` 拆分 + 会话作用域状态机）→ checkpoint 回滚 → 权限分级（workspace trust + plan 完整化）→ queue/steer → agent log 可观测 → 工具 profile 收编（§10 待决策项 3 剩余维度）。

## 阶段三：编排面 ⏳ 待实施

范围（设计 §5）：跨项目 Agents 窗口、后台会话 + 完成通知、子代理/worktree 隔离、远程控制通道化（审查 #11 终态解法）。
