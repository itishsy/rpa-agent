'use strict'
const {test}=require('node:test'),assert=require('node:assert/strict')
const {validateAppearance,appearanceSnapshot}=require('../src/services/appearance')
test('appearance migrates missing settings to the existing dark style and validates every selection',()=>{
  assert.deepEqual(validateAppearance(),{mode:'dark',accent:'blue',density:'comfortable'})
  for(const input of [null,[],{mode:'sepia'},{accent:'red'},{density:'tiny'}])assert.throws(()=>validateAppearance(input))
  assert.deepEqual(validateAppearance({mode:'light',unrelated:'ignored'}),{mode:'light',accent:'blue',density:'comfortable'})
})
test('system appearance follows the current OS preference; explicit themes remain stable',()=>{
  assert.equal(appearanceSnapshot({mode:'system'},false).resolvedTheme,'light')
  assert.equal(appearanceSnapshot({mode:'system'},true).resolvedTheme,'dark')
  assert.equal(appearanceSnapshot({mode:'light'},true).resolvedTheme,'light')
  assert.equal(appearanceSnapshot({mode:'dark'},false).resolvedTheme,'dark')
})
