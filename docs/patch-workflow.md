# 补丁生成与应用

与 rpa-ide 的 `stepDebugRuntime.stagePatch/applyProposal` 和 `subflowPatchSession` 对齐业务处理，Agent 仍使用现有 Harness 调度，不移植 IDE 的 Harness。

1. “仅生成步骤”和“运行与诊断”通过 `propose_dsl_patch` 暂存候选，生成阶段不改变编辑草稿、不保存。旧的显式 `writeToEditor` 调用保留兼容能力，工作台默认关闭。
2. 补丁卡片显示目标流程、改动项和属于该补丁的调试结果；“查看改动”显示逐项修改前后对比。调试状态不等同于业务核验通过。
3. “确认应用补丁”提交本次预览的指纹，主进程重新校验根流程版本、目标版本、窗口归属和指令参数。异步校验结束后再次检查，拒绝期间发生的修改或运行。
4. 应用只更新目标本地草稿并递增版本。子流程补丁进入对应 Tab，主流程步骤不变。保存仍由用户点击，沿用服务器基线检查。
5. 只读流程可查看建议补丁和临时调试，禁止直接应用与保存。子流程已有另一份候选时，必须先处理它；不同流程的候选不可相互替换。
6. 放弃候选不会修改步骤；过期或校验失败的候选保留供检查，不会部分应用。

主要实现：`services/patch-workflow.js`、`renderer/patches.js`、`agents/development/tools.js`。
