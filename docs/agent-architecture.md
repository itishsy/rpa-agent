# 两类 Agent 的代码边界

## 目录与依赖

* `src/agent-core/`：AgentRunner、工具注册表、模型协议、加密会话及证据存储、消息历史、取消控制、执行器租约。不依赖具体 Agent。
* `src/agents/operations/`：任务会话、诊断策略及上下文、取证工具、原因分类。唯一模式为 `diagnose`，只允许 `read`。
* `src/agents/development/`：研发工作区的上下文、工具、步骤补丁、业务核验和生成策略，提供现有 Harness 兼容名称。
* `src/handoff/`：带任务快照指纹的诊断交接对象、Runtime 接管协调。
* `src/ipc/`：运维和研发的 IPC 注册与生命周期边界。

历史 `src/agent/*.js`、`services/task-analysis.js` 和 `services/ai-model-client.js` 是兼容转发入口；业务实现只保留一份，新代码应引用显式目录。

## 共享 Runner

Runner 通过 profile 注入 `modePolicy`、`prepareContext`、`closingMessages`、`fallbackConclusion`，以及可选的工具选择、上下文装饰和交付检查钩子。研发的强制步骤生成逻辑在 development/policy 中，Runner 不再识别具体工具名。运维不再使用 generate 模式、占位 DSL 或覆盖实例 conclude 方法。

工具暴露与实际执行均校验 profile 权限，误注册编辑/执行工具也不会扩大运维权限。执行器租约由应用层创建并注入研发 Runner；Runtime 接管与调试共用同一资源占用记录。

## 运维到研发

运维流程配置诊断生成版本化 RepairHandoff，包含原诊断会话、任务范围、快照指纹、结论与工具证据摘要。主进程在选项及接管提交阶段校验诊断类别及快照；研发收到的摘要明确作为待核实材料，须重新确认当前流程版本和现场。摘要被限制长度，完整原证据仍在运维加密会话中。

当前分类仍兼容模型文字结论，证据摘要不等于结构化根因证明；后续可在此边界扩展逐条事实和证据关联校验。此次重组保留现有 UI、模型协议与存储目录。
