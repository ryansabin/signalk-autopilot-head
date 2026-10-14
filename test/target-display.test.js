'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

// Run the real app and send deltas through its WebSocket callback.
async function display () {
  const elements = new Map()
  const element = () => ({
    dataset: {}, style: {}, children: [], classList: { add () {}, toggle () {} },
    appendChild (child) { this.children.push(child) }, setAttribute () {},
    querySelector: () => null, querySelectorAll: () => [], addEventListener () {}
  })
  let boot, ws
  const document = {
    getElementById (id) {
      if (!elements.has(id)) elements.set(id, element())
      return elements.get(id)
    },
    createElement: element, createElementNS: element,
    querySelector: element, querySelectorAll: () => [],
    addEventListener (event, callback) { boot = callback }
  }
  const data = {
    options: { states: [], modes: [] }, state: 'auto', mode: 'compass', engaged: true, target: 0
  }
  const context = vm.createContext({
    document, window: {}, console,
    location: { protocol: 'http:', host: 'localhost' },
    setTimeout () {}, clearTimeout () {}, setInterval () {},
    WebSocket: class { constructor () { ws = this } },
    fetch: async (url) => ({ ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => url.endsWith('/virtual') ? data : url.endsWith('/autopilots') ? { virtual: {} } : {}
    })
  })
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8'), context)
  await boot()
  const render = (mode, degrees, engaged = true, heading = 0) => {
    ws.onmessage({ data: JSON.stringify({ updates: [{ values: [
      { path: 'steering.autopilot.mode', value: mode },
      { path: 'steering.autopilot.target', value: degrees === null ? null : degrees * Math.PI / 180 },
      { path: 'steering.autopilot.engaged', value: engaged },
      { path: 'steering.autopilot.state', value: engaged ? 'auto' : 'standby' },
      { path: 'navigation.headingMagnetic', value: heading * Math.PI / 180 }
    ] }] }) })
    return document.getElementById('target').textContent
  }
  return { render, elements }
}

test('wind targets show signed angles for apparent, true and legacy wind modes', async () => {
  const { render } = await display()
  for (const mode of ['windApparent', 'windTrue', 'wind']) {
    for (const [degrees, label] of [[-45, '-45°'], [45, '+45°'], [-179, '-179°'],
      [179, '+179°'], [-180, '-180°'], [180, '+180°'], [315, '-45°'],
      [0, '0°'], [-0.1, '0°']]) {
      assert.equal(render(mode, degrees), label, `${mode}: ${degrees}`)
    }
  }
})

test('heading targets retain unsigned three-digit bearings and wrap at north', async () => {
  const { render } = await display()
  for (const mode of ['compass', 'gps', 'route']) {
    assert.equal(render(mode, -45), '315°')
    assert.equal(render(mode, 45), '045°')
    assert.equal(render(mode, 359.6), '000°')
  }
})

test('standby and missing targets remain blank', async () => {
  const { render } = await display()
  assert.equal(render('windApparent', -45, false), '--')
  assert.equal(render('windTrue', null), '--')
})

test('the tape target label uses the same angle convention as TGT', async () => {
  const { render, elements } = await display()
  render('windApparent', 120, true, 120)
  assert.equal(elements.get('tapeTargetLabel').textContent, '+120')
  render('compass', 120, true, 120)
  assert.equal(elements.get('tapeTargetLabel').textContent, '120')
})
