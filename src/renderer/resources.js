'use strict'
// Native business forms use the same service contracts as the IDE. Body and query
// are intentionally separate: many older endpoints accept POST query parameters.
window.resourceGroups = [
  { name: '应用管理', items: [
    ['应用分页', 'robot/app/getAppData', { page: 1, start: 0, size: 50, query: [] }],
    ['新增应用', 'robot/app/add', { appName: '', robotName: '', appArgs: '{}', appRemark: '', robotServiceItemList: [] }, {}, true],
    ['修改应用', 'robot/app/updateApp', { appCode: '$appCode', appName: '', appArgs: '{}', robotServiceItemList: [] }, {}, true],
    ['应用类型', 'robot/app/type'], ['应用统计', 'robot/app/getAppCount'],
    ['历史版本', 'robot/app/history', {}, { appCode: '$appCode' }],
    ['激活版本', 'robot/app/activate', {}, { appCode: '$appCode', version: '' }, true],
    ['发布版本', 'robot/app/release', { appCode: '$appCode', comment: '', rule: '补丁', changeReason: '' }, {}, true],
    ['同步至生产', 'robot/app/syncOut', undefined, { appCode: '$appCode', comment: '' }, true],
    ['应用状态调整', 'robot/app/updateAppStatus', {}, { appCode: '$appCode' }, true],
    ['下线应用', 'robot/app/offlineStatus', {}, { appCode: '$appCode' }, true]
  ] },
  { name: '流程与模板', items: [
    ['流程列表', 'robot/flow/list', { appCode: '$appCode' }],
    ['添加流程', 'robot/flow/add', undefined, { appCode: '$appCode', flowName: '', flowType: 1, serviceItem: '', declareSystem: '', runSupport: '' }, true],
    ['编辑流程', 'robot/flow/editFlow', { id: '', appCode: '$appCode', flowCode: '$flowCode', flowName: '', flowType: 1, serviceItem: '', declareSystem: '', runSupport: '' }, {}, true],
    ['复制流程', 'robot/flow/copyAdd', undefined, { appCode: '$appCode', flowCode: '$flowCode', flowName: '', flowType: '' }, true],
    ['关联流程', 'robot/flow/relateAdd', undefined, { appCode: '$appCode', flowName: '', flowCode: '', flowType: '' }, true],
    ['删除流程', 'robot/flow/delete', undefined, { flowCode: '$flowCode' }, true],
    ['流程状态', 'robot/flow/editFlowStatus', { id: '', appCode: '$appCode', flowCode: '$flowCode', status: 1, comment: '' }, {}, true],
    ['流程状态历史', 'robot/flow/statusHistory', { appCode: '$appCode', flowCode: '$flowCode', historyType: 2 }, {}],
    ['模板列表', 'robot/flow/listTemplate', undefined, { templateType: 1, flowType: 1 }],
    ['同步模板', 'robot/flowDesign/syncOut', undefined, { comment: '' }, true]
  ] },
  { name: '执行计划', items: [
    ['计划列表', 'robot/flow/flowScheduleList', {}, { appCode: '$appCode' }],
    ['通用计划', 'robot/flow/generalPlanEcho', {}, { appCode: '$appCode' }],
    ['通用计划保存', 'robot/flow/updateGeneralPlan', undefined, { appCode: '$appCode', execCycle: '', execAreaTime: '', execStyle: '', execYear: '', execMonth: '' }, true],
    ['编辑计划', 'robot/flow/editFlowSchedule/$appCode', { id: '', flowCode: '$flowCode', clientId: '', execCycle: '', execStyle: '', execYear: '', execMonth: '' }, {}, true],
    ['添加计划', 'robot/flow/addFlowSchedule', { flowCode: '$flowCode', clientId: '' }, { appCode: '$appCode', clientId: '' }, true],
    ['删除计划', 'robot/flow/removeSchedule', {}, { id: '' }, true],
    ['计划详情', 'robot/flow/editEcho', {}, { id: '' }],
    ['计划排序', 'robot/flow/upOrDownMove', {}, { id: '', type: '' }, true]
  ] },
  { name: '参数与配置', items: [
    ['应用配置信息', 'robot/appConfig/getRobotConfigInfoById/$appCode', { robotType: '' }],
    ['通用参数', 'robot/appConfig/getGeneralArgs', { businessType: '' }, {}, false, 'POST', 'form'],
    ['保存应用参数', 'robot/appConfig/addGeneralArgs', [], { appCode: '$appCode' }, true],
    ['字段字典', 'robot/appConfig/getFiledDictList', {}, { appCode: '$appCode' }],
    ['保存字段字典', 'robot/appConfig/addOrUpdateArgsDefineDict', { appCode: '$appCode' }, {}, true],
    ['输入项配置', 'robot/appConfig/getInputInfo', { robotType: '' }],
    ['保存表单', 'robot/appConfig/addInput', { robotType: '', formCode: '', formName: '', createRobotAppId: '$appCode' }, {}, true],
    ['分组配置', 'robot/appConfig/getGroupInfo', undefined, { robotType: '' }],
    ['添加分组', 'robot/appConfig/addGroup', { appCode: '$appCode', groupName: '', groupId: '', formId: '', robotType: '' }, {}, true],
    ['保存分组', 'robot/appConfig/editGroupInfo', { appCode: '$appCode' }, {}, true],
    ['删除分组', 'robot/appConfig/deleteGroupInfo', {}, { appCode: '$appCode', groupId: '' }, true],
    ['添加条件', 'robot/appConfig/addCondition', { appCode: '$appCode' }, {}, true],
    ['调整字段顺序', 'robot/appConfig/editGroupItemOrder', {}, { appCode: '$appCode' }, true],
    ['复制参数', 'robot/appConfig/copyArgs', {}, { appCode: '$appCode' }, true],
    ['申报系统字典', 'robot/data/dict/10008'], ['服务项目字典', 'robot/data/dict/10018'], ['运行载体字典', 'robot/data/dict/10019']
  ] },
  { name: '画布与录制', items: [
    ['读取流程画布', 'robot/flowDesign/getByCode', undefined, { appCode: '$appCode', flowCode: '$flowCode' }, false, 'GET'],
    ['保存流程画布', 'robot/flowDesign/add', { id: null, appCode: '$appCode', flowCode: '$flowCode', flowName: '', data: '{"cells":[]}', steps: [], flowType: 1 }, {}, true],
    ['引用节点列表', 'robot/flowDesign/getSubByAppCode', undefined, { appCode: '$appCode' }, false, 'GET'],
    ['复制流程画布', 'robot/flowDesign/copyByCode', undefined, { sourceFlowCode: '$flowCode', targetFlowCode: '', parentFlowCode: '' }, true, 'GET'],
    ['录制应用列表', 'policy/sys/desktopApplications/getAllPage', { page: 1, start: 0, size: 50, query: [] }],
    ['读取录制步骤', 'policy/saasRobotFlowStep/findStepListByDeskId', undefined, { id: '' }, false, 'GET']
  ] },
  { name: '账户与执行记录', items: [
    ['客户列表', 'robot/app/client/listCustomer'],
    ['客户端列表', 'robot/app/client/list', { keyWord: '', status: [], machineCode: '', clientId: null }],
    ['账户列表', 'robot/app/client/getRobotTaskList', {}, { appCode: '$appCode' }],
    ['执行记录', 'robot/app/client/executionList', { page: 1, size: 50, start: 0, query: [{ property: 'appCode', value: '$appCode' }] }],
    ['执行明细', 'robot/app/client/client/execution/detail', {}, { executionCode: '' }],
    ['测试任务状态', 'robot/task/getTestTaskStatus', {}, { appCode: '$appCode' }]
  ] }
]
