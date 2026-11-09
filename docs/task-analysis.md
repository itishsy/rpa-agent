# 任务监控分析 Agent（1.0.3）

在系统设置保存模型地址、模型名称及 API Key，在任务数据源设置保存对应服务与账户。任务监控点击「立即刷新」后，使用「分析Agent」分析当前筛选范围的未完成或审核中任务。

## 操作与结果

- 主窗口和独立监控窗口均有入口，位于「立即刷新」之后。
- 「未完成原因」列位于未完成任务之后，悬停可查看完整结论。页面不展示过程面板、工具记录或逐任务折叠列表。
- 每项任务独立分析，按钮仅显示简短数量进度。可用「停止分析」中断当前模型和取证，剩余任务不继续处理；调用记录仍保留在加密日志中。
- 分析期间暂停自动刷新，并拒绝跨窗口刷新覆盖正在分析的快照。刷新成功后旧结论清除，避免套用到新任务。
- 每次运行固定使用启动时的模型配置；未配置模型时显示设置提示。正常任务和缴费任务分别绑定各自数据源，并核对服务与登录账户标识。

## Harness

复用 `src/agent/harness.js` 的工具登记、调用校验、历史配对、预算、取消信号和事件记录。注册表只包含只读诊断工具，执行预算为0；不会启动机器人、修改 DSL、调整队列、导出报盘或执行缴费。

启动阶段由 Harness 读取近24小时执行和队列；之后由当前模型选择需要的补充工具。预算为8轮编排、16次工具、每任务5分钟，预留文字收尾。预算不足或模型连接失败时保留证据，输出有条件的原因与处理建议，不能把失败当成业务已完成。

独立加密记录保存在当前工作台数据目录的 `task-analysis` 内，包含调用目的、证据和结论；不与流程调试会话混用。登录凭据和 JSON 参数中的密码字段在进入模型上下文前脱敏。

## 证据工具与已核对的接口

| 工具 | 用途及接口 |
| --- | --- |
| recent_executions | `robot/app/client/executionList`，北京时间近24小时，按当前应用、任务和客户查询，再核对返回身份和时间；最多20条 |
| execution_detail | `robot/app/client/client/execution/detail`，只接受本任务已发现的 executionCode 与 flowCode |
| queue_status | `robot/taskQueue/page`，使用 taskCode、精确账户 declareAccounts、clientId；返回结果再核对应用、任务和账户，标注前100条覆盖范围 |
| task_config | `robot/app/client/getRobotTaskConfigInfo/{taskCode}`，当前任务的参数与登录配置 |
| service_flows | `robot/app/client/showServiceItemFlow/{appCode}/{taskCode}/{accountNumber}`，任务服务流程及启停情况 |
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
