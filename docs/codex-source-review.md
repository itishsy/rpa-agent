# 本地 Codex 源码阅读与 Harness 优化

源码目录：工作区 `codex/`，只读，未修改。阅读版本：`9630fcfc1375f868693227ae14b5bd7142d8f8af`。本次没有用泛化的“Codex 风格”代替源码对照。

## 阅读路径与结论

| 本地 Codex 位置 | 实际控制行为 | RPA 的适配 |
| --- | --- | --- |
| `core/src/session/turn.rs:178`、`:491`、`:637` | Turn 循环在采样边界读取排队输入；模型需要继续或存在新输入时继续循环 | 引入持久化 pendingInputs，旧采样不能抢在新指令前执行 |
| `core/src/session/input_queue.rs:120` | 输入队列与运行中的 Turn 分离，区分通知与输入来源 | 输入有独立 id、接受时间；同一会话不通过第二个 start 追加指令 |
| `core/src/session/turn_input.rs:893` | steer 检查 expected_turn_id，拒绝投递到已经变化的 Turn | UI 补充指令必须提供当前 turnId |
| `core/src/tools/parallel.rs:155`、`:177` | 工具经统一路由，声明是否支持并行，并通过共享/独占门调度 | 只给已审阅纯读取设置 parallelSafe，草稿修改与执行形成屏障 |
| `core/src/tools/parallel.rs:372` | 根据工具是否需要完成取消清理选择等待完成或中止，最终输出与调用生命周期关联 | 模型与纯读可以快速取消，真实执行不能在网络请求未结束时释放租约 |
| `core/src/tools/orchestrator.rs:125` | 授权、权限选择、执行尝试在统一编排入口处理；重试授权有明确边界 | 绑定完整执行权限快照，提交前复核；不自动重试网站副作用 |
| `core/src/context_manager/normalize.rs:21`、`:171` | 模型输入补齐缺失结果并处理孤立输出 | 按相邻调用批次归一化，避免跨轮复用 callId 匹配错误 |
| `core/src/context_manager/history.rs:1038` | 历史管理显式调用输入归一化 | 原始 transcript 与模型投影分离，压缩不删除原始消息 |
| `core/src/context/compaction_summary.rs` | CompactionSummary 作为 contextual user fragment | 摘要及模型生成计划留在低权限上下文，不放入 system |
| `core/src/tasks/mod.rs`、`tasks/lifecycle.rs` | 任务具有取消、完成与中断生命周期，中断有明确历史标记 | turn/call 检查点、停止原因、阶段与终结事件独立记录 |

表中源码路径均以 `codex/codex-rs/` 为前缀。以上是本次实际阅读范围，不声称已经审计完整 Codex 仓库。

## 修复的具体问题

1. 原工具在异步账户/指令预检中收到停止后，仍可能调用执行器。现在实际提交前再次检查取消、输入队列和授权快照。
2. 停止原来使用会话所选 taskCode，忽略工具参数临时指定的账户。现在使用本次执行提交记录中的有效 taskCode。
3. 原实现只等待调试请求结束；cancel 尚未确认时可能开始新任务。现在两条请求均结束才释放租约。
4. 主进程重启丢失内存占用，而 Java 可能仍在操作网站。现在从已提交阶段恢复未知结果保护，需明确停止证据解除。
5. 原压缩直接 splice 原始历史，并把用户/模型摘要放入 system。现在生成独立投影，保留历史且维持权限层次。
6. 原恢复在全局历史中查找 callId，可能错配不同轮次的同名调用。现在以 assistant 批次配对。
7. 原来所有工具串行，callId 通过一个可变字段传递。现在纯读可受限并行，每个调用有自己的持久化身份，结果按原顺序写回。
8. 原来运行中只能拒绝新请求。现在支持有版本约束的 steer，撤销旧授权并在安全边界继续。
9. 原来刷新 Renderer 会丢失待授权 UI。现在 attach 到主进程的活动轮次，恢复授权卡片；异步快照带本地请求序，拒绝旧快照覆盖新状态。
10. 观察到确定结果后，不因渲染事件发送失败把操作改判成失败；超过工具/执行预算也会明确终结轮次，而非继续让模型重复失败调用。

## 验证

- `npm test`：包含异步预检停止、临时账户取消、双请求占用、重启未知结果保护、并行屏障、旧采样失效、授权撤销、重复调用身份和摘要权限等回归。
- `npm run check`：全部 JavaScript 语法及纯 Electron 依赖检查。
- `npm run test:electron`：真实 Electron/preload/safeStorage，配合本机模拟平台、模型及执行器；增加运行中补充和刷新后授权恢复检查。

没有访问生产平台、调用付费模型或执行真实申报。没有移植 Codex 的 Rust 运行时、OS 沙箱、Responses 加密 compaction、多 Agent 调度或任意 shell 工具；RPA 的网络取消与停止核验属于本项目适配。
