const test=require('node:test'),assert=require('node:assert/strict')
const {normalizeRows,normalizePayFeeRows}=require('../src/services/undeclared-monitor')
const server={baseServer:'http://127.0.0.1:9090'},names=['武汉-社保']
test('monitor preserves reported execution counts including zero; absent or invalid counts remain unknown',()=>{
  for(const [value,expected] of [[0,0],['12',12],[null,null],[undefined,null],['',null],[-1,null],['invalid',null],[1.5,null],[false,null]]){
    const row=normalizeRows([{id:1,appName:'武汉-社保',noDeclaredCount:2,execCount:value}],server,0,names)[0]
    assert.equal(row.execCount,expected)
  }
})
test('payment rows do not fabricate execution counts when the source does not provide them',()=>{
  const row={id:1,addrName:'武汉',businessType:1,custId:1}
  assert.equal(normalizePayFeeRows([row],server,0,names)[0].execCount,null)
  assert.equal(normalizePayFeeRows([{...row,execCount:3}],server,0,names)[0].execCount,3)
})
