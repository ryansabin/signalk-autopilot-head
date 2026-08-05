'use strict'

// Phase 2 command-map tests — dependency-free, Node built-in runner (`node --test`).
// Verifies endpoint paths, RAD helper, and the absence of prohibited stubs.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8')
const js = read('public/app.js')

test('apPut is defined', () => {
  assert.match(js, /async function apPut\s*\(/)
})

test('RAD helper converts degrees to radians', () => {
  assert.match(js, /const RAD = \(deg\) =>/)
  // Verify the formula is correct — extract and eval the constant expression.
  const m = js.match(/const RAD = \(deg\) => (deg \* Math\.PI \/ 180)/)
  assert.ok(m, 'RAD formula not found')
})

test('adjust uses /target/adjust with radians via RAD()', () => {
  assert.match(js, /\/target\/adjust/)
  assert.match(js, /RAD\(Number\(b\.dataset\.deg\)\)/)
})

test('engage uses /engage endpoint', () => {
  assert.match(js, /apPut\s*\(\s*['"]\/engage['"]/)
})

test('disengage uses /disengage endpoint', () => {
  assert.match(js, /apPut\s*\(\s*['"]\/disengage['"]/)
})

test('mode uses /mode endpoint with value envelope', () => {
  assert.match(js, /apPut\s*\(\s*['"]\/mode['"]/)
  assert.match(js, /\{\s*value:\s*b\.dataset\.mode\s*\}/)
})

test('tack wires direction via runAction id+dir path', () => {
  // runAction builds: '/' + id + '/' + dir  where id is 'tack'
  assert.match(js, /'\/' \+ id \+ '\/' \+ dir/)
  assert.match(js, /id === 'tack'.*?id === 'gybe'|id === 'tack' \|\| id === 'gybe'/s)
})

test('gybe wires direction via runAction id+dir path', () => {
  assert.match(js, /id === 'gybe'|id === 'tack' \|\| id === 'gybe'/)
})

test('dodge uses /dodge with radian value', () => {
  assert.match(js, /apPut\s*\(\s*['"]\/dodge['"]/)
  assert.match(js, /RAD\(b\.dataset\.dir === ['"]port['"]/)
})

test('courseCurrentPoint uses /courseCurrentPoint endpoint', () => {
  assert.match(js, /apPut\s*\(\s*['"]\/courseCurrentPoint['"]/)
})

test('setTarget is not wired', () => {
  assert.doesNotMatch(js, /apPut\s*\(\s*['"]\/setTarget['"]/)
  assert.doesNotMatch(js, /\/target["']\s*,\s*\{\s*value/)
})

test('courseNextPoint is not wired', () => {
  assert.doesNotMatch(js, /apPut\s*\(\s*['"]\/courseNextPoint['"]/)
})

test('standby requires no confirm (guardedStandby calls apPut directly)', () => {
  // guardedStandby must not contain confirmModal
  const m = js.match(/async function guardedStandby[\s\S]*?async function guardedEngage/)
  assert.ok(m, 'guardedStandby not found')
  assert.doesNotMatch(m[0], /confirmModal/)
})

test('engage guard calls confirmModal', () => {
  assert.match(js, /async function guardedEngage[\s\S]*?confirmModal/)
})

test('in-flight lockout uses inFlight Set', () => {
  assert.match(js, /const inFlight = new Set\(\)/)
  assert.match(js, /inFlight\.has\(key\)/)
  assert.match(js, /inFlight\.add\(key\)/)
  assert.match(js, /inFlight\.delete\(key\)/)
})

test('event delegation is on .controls', () => {
  assert.match(js, /querySelector\s*\(\s*['"]\.controls['"]\s*\)\.addEventListener\s*\(\s*['"]click['"]/)
})

test('window.__pilot exposes RAD and apPut', () => {
  assert.match(js, /window\.__pilot\s*=[\s\S]*?RAD[\s\S]*?apPut/)
})
