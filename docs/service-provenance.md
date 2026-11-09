# 服务复用与重写范围

本目录是独立项目。以下为现有业务协议复用，不是旧 Harness 移植：

- `platform-service.js`、`longfor-auth.js`：平台身份、密码编码与 token 校验协议。
- `executor-service.js`、`executor-control.js`：已有 Java 执行器 HTTP 协议和本机进程控制。
- `ai-model-client.js`：模型 API 调用；`model-settings.js`：模型连接参数校验。模型密钥保存由主进程统一处理，MCP 令牌由桥接服务管理。
- `debug-dsl.js`：现有步骤结构与执行 DSL 的转换、引用流程装载；已补充空 VO 列表的兼容读取。
- `dsl-debug-service.js`：仅保留 DSL 结构校验与 set/insert/remove/move 补丁语义，移除旧调试会话控制器。
- `undeclared-monitor.js`、`undeclared-filter.js`、`undeclared-export.js`：原生申报监控查询、筛选和导出。
- `renderer/monitor.html`：独立任务监控页面；脚本外置，通过白名单 preload 访问主进程。无入口的旧平台管理页面已移除，平台账户服务仍供执行器连接使用。
- `action-knowledge.json`：已有 Java 指令参考定义；实际参数校验仍以当前平台命令中心为准。

`src/agent`、`platform-api.js`、`mcp.js`、`experience.js`、新主进程、原生工作区及业务参数表单为本次新实现。没有引用上级项目、旧编译产物或 `rpa-ide/harness`。

接口核对来源包括旧 `processSetting` 视图与 Java `RobotTaskController`、`RobotDebugController`。业务参数表单提供可编辑 query/body，仍需具体服务器联调；接口名字相同不意味着所有服务端版本的字段都相同。
