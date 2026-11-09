const SERVICE_ITEM_ORDER = [1, 2, 3, 5, 6, 7, 8, 9, 10, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23]
const SERVICE_ITEM_NAMES = [
  '增员', '减员', '调基', '补缴', '缴费', '在册名单', '费用明细', '政策通知', '基数申报',
  '查审核结果', '调基名单', '参保证明', '获取待缴', '申报核定', '缴费扣款', '获取凭据',
  '撤销核定', '公司参保证明', '获取同步待缴', '申报同步核定', '获取缴费截图'
]

function serviceRank (flow) {
  const code = Number(flow.serviceItem)
  const byCode = SERVICE_ITEM_ORDER.indexOf(code)
  if (byCode >= 0) return byCode
  const byName = SERVICE_ITEM_NAMES.indexOf(String(flow.serviceItemName || '').trim())
  return byName >= 0 ? byName : SERVICE_ITEM_ORDER.length
}

function flowGroup (flow) {
  const serviceName = String(flow.serviceItemName || '').trim()
  const serviceItem = flow.serviceItem
  const hasService = serviceItem !== null && serviceItem !== undefined && serviceItem !== '' || Boolean(serviceName)
  if (Number(serviceItem) === 11 || serviceName === '登录' ||
      (!hasService && String(flow.flowName || '').includes('登录'))) return 0
  if (Number(flow.flowType) === 2) return 2
  return hasService ? 1 : 3
}

function currentOrder (flows) {
  return flows.map((flow, index) => ({ flow, index })).sort((a, b) =>
    Number(a.flow.execOrder) - Number(b.flow.execOrder) || a.index - b.index).map(item => item.flow)
}

function organizeFlows (flows) {
  return currentOrder(flows).map((flow, index) => ({ flow, index })).sort((a, b) =>
    flowGroup(a.flow) - flowGroup(b.flow) ||
    (flowGroup(a.flow) === 1 ? serviceRank(a.flow) - serviceRank(b.flow) : 0) ||
    a.index - b.index).map(item => item.flow)
}

function planFlowMoves (flows) {
  const current = currentOrder(flows)
  const desired = organizeFlows(flows)
  const slots = current.map(flow => Number(flow.execOrder))
  const ids = current.map(flow => String(flow.id || ''))
  if (slots.some(slot => !Number.isFinite(slot)) || new Set(slots).size !== slots.length ||
      ids.some(id => !id) || new Set(ids).size !== ids.length) {
    throw new Error('流程缺少唯一的执行顺序或编号，无法自动整理')
  }
  const working = current.slice()
  const moves = []
  desired.forEach((flow, index) => {
    const from = working.findIndex(item => String(item.id) === String(flow.id))
    if (from === index) return
    moves.push({ id: flow.id, execOrder: slots[index] })
    working.splice(index, 0, working.splice(from, 1)[0])
  })
  return { desired, moves }
}

module.exports = { organizeFlows, planFlowMoves }
