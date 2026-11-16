# 任务监控运维 Agent

在系统设置保存模型地址、模型名称及 API Key，在任务数据源设置保存对应服务与账户。任务监控点击「立即刷新」后，使用「运维Agent」分析当前筛选范围的未完成或审核中任务。

## 操作与结果

- 主窗口和独立监控窗口均有入口，位于「立即刷新」之后。
- 「原因分析」列只显示1–2句话的纯文本结论，历史报告也会提取短摘要；点击「明细」展开完整分析与举证记录，包括阶段、原始原因、步骤、设备和时间。
- 每项任务独立分析，按钮仅显示简短数量进度。可用「停止分析」中断当前模型和取证，剩余任务不继续处理；调用记录仍保留在加密日志中。
- 分析期间暂停自动刷新，并拒绝跨窗口刷新覆盖正在分析的快照。任务事实变化后清除旧结论；未变化时保留已有结果。
- 每次运行固定使用启动时的模型配置；未配置模型时显示设置提示。正常任务和缴费任务分别绑定各自数据源，并核对服务与登录账户标识。

## Harness

当前监控快照明确标记「已停用」的账户先走确定规则，直接返回停用状态、taskComment及处理建议，不要求模型配置、不请求其他取证接口。结论分类为任务调度，ruleCode为TASK_DISABLED，模型及工具调用次数均为0，不显示Agent接管。依据是该次监控快照，不代表停用前没有执行或业务已经办结。

使用 `src/agent-core/runner.js` 的调用校验、历史配对、预算、取消信号和事件记录；业务实现位于 `src/agents/operations/`，独立diagnose模式只允许read工具，执行预算为0。不会启动机器人、修改 DSL、调整队列、导出报盘或执行缴费。架构说明见 [agent-architecture.md](agent-architecture.md)。

启动阶段固定读取近24小时执行、队列和服务流程；之后由当前模型选择需要的补充工具。预算为8轮编排、16次工具、每任务5分钟，预留文字收尾。预算不足或模型连接失败时保留证据，输出有条件的原因与处理建议，不能把失败当成业务已完成。

独立加密记录保存在当前工作台数据目录的 `task-analysis` 内，包含调用目的、证据和结论；不与流程调试会话混用。登录凭据和 JSON 参数中的密码字段在进入模型上下文前脱敏。

## 证据工具与已核对的接口

完整20个工具、入队/出队条件、错误明细、已知证据缺口和后台建议见 [operations-evidence-catalog.md](operations-evidence-catalog.md)。

| 工具 | 用途及接口 |
| --- | --- |
| recent_executions | `robot/app/client/executionList`，北京时间近24小时，按当前应用、任务和客户查询，再核对返回身份和时间；最多20条 |
| execution_detail | `robot/app/client/client/execution/detail`，只接受本任务已发现的 executionCode 与 flowCode |
| queue_status | `robot/taskQueue/page`，使用 taskCode、精确账户 declareAccounts、clientId；返回结果再核对应用、任务和账户，标注前100条覆盖范围 |
| task_config | `robot/app/client/getRobotTaskConfigInfo/{taskCode}`，当前任务的参数与登录配置 |
| service_flows | `robot/app/client/showServiceItemFlow/{appCode}/{taskCode}/{accountNumber}`，任务服务流程及启停情况 |
| execution_plan | `robot/app/client/getRobotPlant/{clientId}/{machineCode}/{appCode}?searchText=...`；核对账户、应用及任务，只保留当前任务的计划；由后台合并私有和公共计划 |
| declaration_period | `policy/agent/getPolicyAddrDeadlineSettings/{addrId}/{businessType}`；严格核对地区和业务，按增员/减员/调基/补缴分别核实；不可用时保留证据缺口 |
| queue_rules | SaaS及独立部署 `RobotTaskQueueComponent.generateDataTasks`、`ScheduleUtils.matchSchedule` 的入队前置条件；需结合现场证据验证 |
| offer_templates | `policy/offerSettings/page`，仅查询已知地区和业务类型；最多50条 |
| column_rules / template_detail | `policy/offerSettings/columnRuleList/{uuid}`、`findByUuid/{uuid}`；UUID 必须由本次模板查询返回 |
| offer_rules | `robot/offerRule/list`，仅在已确认 declareWebsite 后查询回盘状态和节点规则 |
| export_constraints | 根据 SaaS `EmployeeDeclareServiceImpl.declareOfferExportPage` 源码核对导出前置参数，明确其不能证明当前任务实际缺参；不调用导出接口 |
| execution_image | 仅下载当前执行明细已发现的数字 fileId：`policy/sys/file/download/{fileId}`，绑定原数据源认证，不跟随任意附件 URL或重定向 |
| read_evidence | 对本次加密保留的完整证据分页读取 |

截图最多2张，原始下载限5MiB，PNG/JPEG验证、解码、缩放至最长边1536并压缩后提交当前模型。模型不接受图像输入时降级为文字取证并明确「截图未识别」。独立部署不支持文件或规则接口时，记录证据缺口，不猜测同名接口或把缺失解释为业务失败。

部分缴费来源未提供 appCode/taskCode 时，按同数据源、同应用名称、同申报账户和已知客户查询，只在唯一匹配时补齐；无法唯一定位则停止该任务的分析。

## 取证依据与验证

接口参数核对来自同级 `rpa` 后台的 SaaS 和 standalone 控制器、执行查询 DTO、队列映射和报盘服务源码。没有修改后台工程。

单元测试覆盖任务与时间范围、模板和截图范围、配置脱敏、取消、预算收尾、模型降级和缴费标识解析。`tests/electron-task-analysis.js` 使用真实 Electron、preload、IPC、加密存储和本地模拟后端/模型，验证主窗口筛选、模型工具链、认证截图输入、原因列回填、进度、停止、刷新冲突及无业务写入。

测试不访问真实申报网厅，不使用生产模型或生产凭据；真实服务权限、附件可用性以及具体模型的图像能力仍以部署环境为准。

## 申报期与未入队诊断

每次分析先读取执行记录、队列和服务流程（含启停原因、执行计划摘要及未完成计数）。无执行或未发现队列时，继续核对当前任务有效执行计划和入队条件：账户启用、对应服务流程、计划时间、待申报数据、可导出数据，以及登录和前置业务条件。队列第一页无结果不能证明从未入队。

报盘限制除必填参数外，还包含客户账户关联、申报期设置、空白期、模板及默认子节点。`AbstractOfferExportBase.getDeclareDateRange` 中客户 `declareExpRule=0` 可绕过按申报期导出；未取得开关和实际错误时，不把地区申报期直接当作当前任务的阻塞原因。执行计划与业务申报期分别判断，等待期间不开启流程配置接管。

## 思考模型工具调用兼容

模型返回的 `reasoning_content` 随 assistant 消息保留，在后续工具轮次原样回传；合成或旧工具消息在需要时补空字段。遇到明确的缺失 `reasoning_content` HTTP 400 时，仅重发一次模型请求，不重新执行取证工具。该字段不作为用户可见结论。
