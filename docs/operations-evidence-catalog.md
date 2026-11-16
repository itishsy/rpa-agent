# SaaS 运维 Agent 举证工具目录与归因规范

本目录来自本地 `rpa/rpa-saas` 及 `rpa-common` 源码核对。以下“已接入”指已注册为模型可调用的只读工具，不表示已经调用生产服务验证权限或数据完整性。代码位于 `src/agents/operations/`，共享运行层位于 `src/agent-core/`。

## 1. 证据链与分类

按任务生命周期调查，保留每个阶段的事实，避免把多个服务项、历史执行和当前队列混为一个状态：

1. 锁定数据源、客户、应用、任务、申报账户和调查时间。
2. 固定读取最近执行、当前队列和服务流程。
3. 有失败执行：读取执行步骤、错误与截图；核对配置和认证、UKey现状。
4. 未发现执行/队列：读取真实生成记录，核对有效执行计划、申报期、业务数据和报盘限制。
5. 有待执行队列：计算本条队列年龄；按该队列executionCode读取设备拉取记录，核对设备、画像、会话、UKey和互斥限制。
6. 输出“事实、根因判断、可能原因、缺失证据、处理建议”。每条结论注明阶段、服务项、时间、队列/执行/步骤/设备及证据编号。

既有顶层类别仍为流程配置、业务数据、等待操作、外部系统、执行环境、任务调度、证据不足。新增细分证据使用 `stage` 与 `code`，错误现象不自动决定顶层根因。

## 2. 模型工具总表（20个）

下表路径省略网关 `/api/` 前缀；除截图下载外均为POST。工具参数由Schema限定，数据源和任务范围由程序绑定，模型不能提交任意URL、Mongo查询、客户编号或文件URL。

| 工具 | 请求/来源 | 参数及范围 | 可提供的证据 |
|---|---|---|---|
| recent_executions | robot/app/client/executionList | 应用、任务、已知客户、北京近24小时；返回再筛选，最多20条 | 执行编号、流程、时间、成功失败及错误 |
| execution_detail | robot/app/client/client/execution/detail?executionCode=...&flowCode=... | 只能使用本次执行查询发现的组合 | 首批失败步骤、步骤数据、error/errorStack、关联截图；返回按时间排序的异常现象facts |
| execution_image | GET policy/sys/file/download/{fileId} | 只允许当前步骤发现的数字文件编号；最多2张 | 页面现场；明确标记图片识别是否可用 |
| queue_status | robot/taskQueue/page | taskCode、精确declareAccounts、已知clientId；第一页100条，返回再核对 | status、生成时间、指定/实际设备、备注、执行编号、预估时间；本条队列已等待分钟数 |
| queue_generation_records | robot/loginAuth/findTaskQueueGenerate?limit=50&orderBy=timeStamp&orderDirection=desc | 固定JSON对象：taskCode、taskVO.clientId、taskVO.appCode；过滤近24小时 | 真实生成判断message、queueItem、流程计划、otherData.code/msg |
| queue_pull_records | robot/taskQueue/getPullPage | page=1,size=100,query.executionCode；必须来自本次queue_status | 某设备某时刻出队拒绝原因、画像/账户/端口/UKey/手机号等限制 |
| login_auth_status | robot/loginAuth/pageList | 账户及已知客户；返回再核对任务、客户和账户，最多保留50条 | processStatus、loginStatus、认证方式、备注、更新时间及设备 |
| ukey_bindings | robot/usbKey/usbAccountPage | clientId、keyword=账户；返回精确核对任务和账户 | 绑定UKey、插入/挂载状态、mountClient、启用状态、证书日期 |
| executor_status | robot/version/client/getByClientId/{clientId} | 固定当前客户；返回再核对clientId | 设备状态、心跳、类型、会话容量及备注；不返回token和操作命令 |
| task_config | robot/app/client/getRobotTaskConfigInfo/{taskCode} | 当前任务 | 登录及业务参数，动态密码值脱敏 |
| service_flows | robot/app/client/showServiceItemFlow/{appCode}/{taskCode}/{accountNumber} | 当前任务账户 | 服务项、启停原因、执行计划摘要、未完成/审核中数量 |
| execution_plan | robot/app/client/getRobotPlant/{clientId}/{machineCode}/{appCode}?searchText=... | 必须有客户和设备；返回再核对账户和任务 | 私有覆盖公共计划后的年月、日期、时段、启停状态 |
| declaration_period | policy/agent/getPolicyAddrDeadlineSettings/{addrId}/{businessType} | 当前地区与社保/公积金业务 | 分申报类型的起止月日；不直接证明当前客户受限 |
| queue_rules | 本地源码摘要 | 无后台请求 | 自动入队条件解释；observedFailure=false |
| offer_templates | policy/offerSettings/page | 当前地区及业务，最多50条 | 模板UUID、模板范围 |
| template_detail | policy/offerSettings/findByUuid/{uuid} | 只允许本次发现的UUID | 模板及导出配置 |
| column_rules | policy/offerSettings/columnRuleList/{uuid} | 同上 | 字段校验规则；需要实际数据证明命中 |
| offer_rules | robot/offerRule/list | 仅使用已确认declareWebsite | 回盘状态、节点判断规则 |
| export_constraints | 本地源码摘要 | 不调用declareOfferExportPage | 导出必填项、客户关联、申报期/空白期和模板限制 |
| read_evidence | 本次会话Artifact | 证据编号、offset，每页6000字符 | 已保存完整工具结果，不能跨会话读取 |

生成记录接口接收 `@RequestBody String`，当前工具提交固定JSON对象，经HTTP序列化后供后台 `BasicDBObject.parse` 解析。后台Repository只按键做等值条件，不提供可靠的时间范围查询，因此查询最新50条后由工具按时间窗口过滤，不允许模型传原始查询语句。

## 3. 执行异常明细

源码依据：`RobotExecutionController.clientExecutionDetail` 的接口、`RobotExecutionDetailMo` 的字段及执行明细查询。错误为执行器上报的现场信息，SaaS并没有为每类点击/扫码错误提供一个独立根因判定接口。

| 细分现象 | 举证要求 | 不应直接推导 |
|---|---|---|
| CLICK_FAILED 点击步骤失败 | 失败stepCode/stepName、error、时间，结合截图和实际配置 | 不能仅凭找不到元素认定XPath错误；可能是登录失效、弹窗、iframe或页面未加载 |
| SCAN_WAIT 未扫码/扫码超时 | error明确写未扫码、等待扫码超时等，或可核对的现场截图 | 登录中心待登录不等于用户未扫码 |
| CAPTCHA_REQUIRED 验证码问题 | 明确验证码错误/等待日志和现场 | 不直接认定流程应修改 |
| UKEY_RECOGNITION_FAILED UKey识别失败 | 执行步骤明确报告UKey未识别/未检测/未找到 | 当前UKey未插入不自动证明历史失败由它导致 |
| UKEY_EXECUTION_ERROR 其他证书/UKey异常 | 具体错误、步骤和时间，结合绑定及证书日期 | 已挂载不等于故障，可能正在正常使用 |
| STEP_FAILED 其他步骤失败 | 原始错误、堆栈、步骤数据及图像 | 故障堆栈不等于最终业务根因 |

`execution_detail.facts` 的 `symptomOnly=true` 表示现象归类。原始records和证据文件仍保留，模型需说明因果判断中的不确定部分。

## 4. 未入队列：代码中实际存在的分支

源码：`RobotTaskQueueComponent.generateTask/generateDataTasks/isNeedGenerateH5Queue/checkDeclareData`、`RobotTaskQueueServiceImpl.addTaskQueue/checkIntervalTime/checkClient/checkUsbKeyStatus`、`ScheduleUtils.matchSchedule`。

| 条件/后台原文 | 证据工具 | 细节与限制 |
|---|---|---|
| 申报账户非启用、流程为空/未关联计划 | service_flows、execution_plan、task_config、生成记录 | 部分早期退出只写应用日志，没有Mongo生成记录；账户停用还需核对原因 |
| 执行计划与当前时间不匹配 | queue_generation_records + execution_plan | 核对execYear/execMonth/execCycle/execAreaTime/execStyle；缴费及部分基数场景有例外 |
| 未到业务申报期/当前日期为空白期 | declaration_period + export_constraints + 实际报错 | 与执行计划不同；客户declareExpRule=0可绕过按申报期导出；缺客户开关或失败证据则只列待核实 |
| 无待申报数据、无待审核数据、无需执行数据 | queue_generation_records + service_flows | 精确到queueItem/serviceItem及对应时间，不能拿整个账户总数反驳某个服务项 |
| 无可申报数据 | queue_generation_records + 模板/字段/报盘规则 | 待申报计数大于0仍可能不可导出；需要实际校验失败内容才能给出具体人员字段原因 |
| 基数申报未完成 | queue_generation_records | 属于前置业务未完成，不直接归为流程错误 |
| 缴费暂停、API自动任务暂停 | queue_generation_records、服务状态 | 说明暂停来源，不能自动启用 |
| 没有缴费单、服务项不匹配、extendCode不同 | queue_generation_records | 核对同一缴费事项，不混用其他缴费单 |
| H5未维持/非工作时间、特定服务不自动生成 | queue_generation_records、login_auth_status | 是业务/时间策略，未必是故障 |
| 任务正在执行、已有缴费任务、已有待执行增减员任务 | 生成记录outcome + queue_status | code=202往往表示避免重复，不等于失败；可能是已经入队 |
| 查询审核结果任务的最小生成间隔未到 | queue_generation_records | intervalTime来自流程参数或预设1003；后台取最小间隔并和上次生成时间比较 |
| 无可用盒子 | 生成记录outcome + executor_status | 入队checkClient接受状态1、2、6，不能简单把所有非空闲设备都视为不符合入队要求 |
| UKey未配置或非可用状态 | 生成记录outcome + ukey_bindings | 需区分绑定不存在、禁用、未插入、已占用和当前证书状态 |
| 登录中心触发下发、队列锁异常、生成异常 | queue_generation_records | 保留outcome.code/msg；“调用入队列”只是尝试记录，不是成功证明 |

## 5. 已入队但未出队：按源码实际执行顺序核对

源码入口：`RobotTaskQueueServiceImpl.findTaskQueue/findQueueFirst`；判断实现：`RobotTaskQueueOutComponent`。

| 顺序 | 实际条件 | 需要的现场明细 |
|---|---|---|
| 1 | 画像不一致；有画像设备与会话维持任务不兼容 | 队列profileCode、请求画像、设备、拒绝时间 |
| 2 | 刷新会话与业务任务串行 | 应用是否在预设1019、刷新锁、拉取拒绝记录 |
| 3 | UKey被申报老师/其他系统占用 | UKey、占用方、系统、时间；申报老师占用分支可能直接把队列改为中断 |
| 4 | 同账户互斥；预设1013应用改按账户+申报系统互斥 | 冲突任务/系统；目前拉取日志只有文字，未提供完整冲突队列结构 |
| 5 | 同共享端口不能并发 | sharePort、应用；画像请求或预设1006例外不可忽略 |
| 6 | 同共享端口需同一台可运行设备 | 固定端口、指定可运行设备、当前拉取设备 |
| 7 | 身份切换限频，或同账户连续重试的公平性限制 | 60分钟内次数、动态阈值（预设1018）、网站适用范围（1015）、最后账户及例外；三次重试不是全局统一禁止 |
| 8 | 优先会话维持所在设备 | 当前拉取设备和维持设备 |
| 9 | 10分钟内短信发送次数>=3 | 适用应用（预设1014）、手机号脱敏、次数与时间窗口 |
| 10 | 自动H5任务在非工作时间会话已丢失 | source、会话、客户工作时间；可能将队列改为中断 |
| 11 | 同手机号正在登录 | 该手机号相关运行任务、系统及设备 |
| 12 | 优先指定设备与会话容量最少设备 | fixMachineCode、候选可运行设备及会话数量 |
| 13 | 通用会话数量均衡选择 | 拉取设备、最少负载设备及计数 |

源码中“同经办人不能同时操作不同账户”检查已被注释，不作为当前生效出队规则。身份切换、共享端口等规则带动态预设及场景例外，不能只凭静态规则名认定本任务被阻挡。`RobotExecutionGroupRule`在此服务中的用途主要是对回调备注匹配errorCode，不能把它当作上表全部并发规则的来源。

## 6. 等待时长与证据缺口

工具仅在status=2且createTime有效、不在未来时计算：

`waitingMinutesAtObservation = floor((analysisTime - queue.createTime)/60000)`

正确表述：“队列Q从11:30生成至12:00已等待30分钟；11:59设备M的拉取记录报告同账户同系统互斥。”不能表述为“执行器故障导致等待30分钟”，也不能给出“还需等待N分钟”的承诺。preStartTime/preEndTime只是后台预估，不等于实际调度时间。

已核对到的限制：

* `RobotTaskQueuePullRepositoryImpl.save/batchSave` 按machineCode+executionCode删除旧记录后保存新记录，不能重建完整等待历史。
* `findTaskQueue` 在未找到候选、获取锁失败等分支提前返回；当前拉取记录批量保存位于成功选择后的方法末尾，部分拒绝原因不会落库。
* 生成记录查询上限50条且只有等值过滤；账户停用、无流程等早期分支存在仅日志记录的情况。
* 登录中心服务可能以当前用户客户替换查询clientId，且未保证按page/size分页；工具严格过滤并限制返回数量。
* `usbKey/getDeviceStatus` 实际返回设备IP，不能当作UKey识别健康检查。`version/client/getByClientId`是当前状态，不是历史故障证据。
* 仅凭现有接口不能完整举证某队列此刻的所有可用设备、全部规则命中、冲突队列编号、剩余限频时间和精确队列位置。

建议后台后续补充（本次未新增这些接口）：

1. 有租户/账户范围及时间游标的 `generationEvidence`：结构化记录每个检查项、实际值、阈值、结果与服务项，包括早期退出。
2. 无副作用的 `dispatchEvidence`：纯读取当前候选设备与阻塞快照；返回ruleCode、blockerExecutionCode、machineCode、observedAt、validUntil、实际值与阈值。
3. 在所有拉取结束路径持久化决策事件，并保留时间序列；不能直接调用 `findTaskQueue` 做诊断，因为该方法会更新队列、设备、任务、Redis锁和会话状态。
4. 按任务范围读取实际报盘校验失败明细，返回人员标识脱敏值、字段、规则及输入值摘要，避免通过实际报盘导出来诊断。

## 7. 结果保存与示例

有facts的工具结果会存为加密Artifact，返回evidenceId；`analysis.details`保存tool/evidenceId/facts，监控列表可展开“举证明细”。研发接管得到诊断与证据摘要，仍需核对当前流程和现场。

```json
{
  "tool": "queue_pull_records",
  "evidenceId": "本次会话内的证据编号",
  "facts": [{
    "stage": "dequeue",
    "code": "ACCOUNT_SYSTEM_MUTEX",
    "message": "同一申报户同一系统不能同时执行不能出队列",
    "executionCode": "queue-Q",
    "machineCode": "machine-M",
    "at": "2026-11-09 11:59:00",
    "observed": true
  }]
}
```

这条事实只证明后台当时对设备M作过该判断。根因结论须联合当前队列、有效计划、执行器及实际业务状态，明确哪些已确认、哪些仍待核实。
