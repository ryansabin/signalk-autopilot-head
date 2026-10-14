'use strict'

// Execute the actual browser app with a small DOM/HTTP/WebSocket fixture.
// No dependencies or source-text assertions: clicks must produce v2 API requests.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const source = fs.readFileSync(path.join(__dirname, '../public/app.js'), 'utf8')
const base = '/signalk/v2/api/vessels/self/autopilots/virtual'

class Element {
  constructor (tagName = 'div') {
    this.tagName = tagName
    this.disabled = false
    this.children = []
    this.dataset = {}
    this.style = {}
    this.listeners = {}
    this.className = ''
    this.classList = {
      add: (name) => { this.className += ' ' + name },
      toggle: () => {}
    }
  }
  set innerHTML (value) { this.children = [] }
  appendChild (child) { this.children.push(child) }
  setAttribute () {}
  addEventListener (name, fn) { this.listeners[name] = fn }
  matches (selector) {
    const attr = selector.match(/\[data-(\w+)="([^"]+)"\]/)
    if (attr) return this.dataset[attr[1]] === attr[2]
    if (selector.startsWith('.')) return this.className.split(' ').includes(selector.slice(1))
    return this.tagName === 'button' && (selector === 'button' || selector === 'button[data-cmd]' && !!this.dataset.cmd)
  }
  querySelectorAll (selector) {
    return this.children.flatMap((child) => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
    ])
  }
  querySelector (selector) { return this.querySelectorAll(selector)[0] || null }
  closest () { return this }
  showModal () { this.open = true }
  close () { this.open = false; this.onclose?.() }
}

async function fixture ({ engaged = true, fail, pending } = {}) {
  const elements = new Map()
  const document = new Element()
  document.getElementById = (id) => {
    if (!elements.has(id)) elements.set(id, new Element())
    return elements.get(id)
  }
  document.createElement = (tag) => new Element(tag)
  document.createElementNS = (namespace, tag) => new Element(tag)
  const controls = new Element()
  controls.className = 'controls'
  document.appendChild(controls)
  for (const dataset of [{ cmd: 'standby' }, { cmd: 'auto' },
    ...[-10, -1, 1, 10].map((deg) => ({ cmd: 'adjust', deg: String(deg) }))]) {
    const button = new Element('button')
    button.dataset = dataset
    controls.appendChild(button)
  }
  controls.appendChild(document.getElementById('modeRow'))
  controls.appendChild(document.getElementById('actionRow'))
  const actions = ['dodge', 'tack', 'gybe', 'courseCurrentPoint', 'courseNextPoint']
    .map((id) => ({ id, name: id, available: true }))
  const data = {
    options: { states: [], modes: ['compass', 'windApparent'], actions },
    state: engaged ? 'auto' : 'standby', engaged, mode: engaged ? 'compass' : null, target: 0
  }
  const requests = []
  const response = (body, status = 200) => ({
    ok: status < 400, status,
    headers: { get: () => 'application/json' }, json: async () => body
  })
  const window = {}
  let ws
  const context = vm.createContext({
    document, window, console,
    location: { protocol: 'http:', host: 'localhost', pathname: '/pilot/' },
    setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1,
    WebSocket: class { constructor () { ws = this } send () {} },
    fetch: async (url, options) => {
      requests.push({ url, ...options })
      if (options.method) {
        if (pending) await pending
        return response({}, fail || 200)
      }
      if (url === '/signalk/v2/features?enable=1') return response({})
      if (url === base) return response(data)
      return response({ virtual: { isDefault: true } })
    }
  })
  vm.runInContext(source, context)
  await document.listeners.DOMContentLoaded()
  const click = (selector) => {
    const button = controls.querySelector(selector)
    assert.ok(button, selector)
    return controls.listeners.click({ target: button })
  }
  const choose = (label) => {
    const button = document.getElementById('dlgBtns').children.find((b) => b.textContent.includes(label))
    assert.ok(button, label)
    // Real dialog close events are asynchronous.
    const dialog = document.getElementById('dlg')
    dialog.close = () => { dialog.open = false }
    button.onclick()
  }
  const delta = (values) => ws.onmessage({ data: JSON.stringify({ updates: [{ values }] }) })
  const commands = () => requests.filter((r) => r.method)
  return { document, controls, click, choose, delta, commands, requests, data, window }
}

function expectCommand (app, subpath, method, body) {
  const actual = app.commands().at(-1)
  assert.equal(actual.url, base + subpath)
  assert.equal(actual.method, method)
  assert.equal(actual.credentials, 'include')
  assert.deepEqual(actual.body === undefined ? undefined : JSON.parse(actual.body), body)
}

test('AUTO requires confirmation and sends POST; STANDBY sends POST immediately', async () => {
  const app = await fixture({ engaged: false })
  let done = app.click('[data-cmd="auto"]')
  assert.equal(app.commands().length, 0)
  app.choose('CANCEL')
  await done
  assert.equal(app.commands().length, 0)
  done = app.click('[data-cmd="auto"]')
  app.choose('OK')
  await done
  expectCommand(app, '/engage', 'POST')
  await app.click('[data-cmd="standby"]')
  expectCommand(app, '/disengage', 'POST')
})

test('mode and all four target adjustments send PUT with value envelopes in radians', async () => {
  const app = await fixture()
  await app.click('[data-mode="windApparent"]')
  expectCommand(app, '/mode', 'PUT', { value: 'windApparent' })
  for (const deg of [-10, -1, 1, 10]) {
    await app.click(`[data-deg="${deg}"]`)
    expectCommand(app, '/target/adjust', 'PUT', { value: deg * Math.PI / 180 })
  }
})

test('tack and gybe send POST with port/starboard direction, and can be cancelled', async () => {
  const app = await fixture()
  for (const action of ['tack', 'gybe']) {
    for (const [label, direction] of [['PORT', 'port'], ['STBD', 'starboard']]) {
      const done = app.click(`[data-action="${action}"]`)
      app.choose(label)
      await done
      expectCommand(app, `/${action}/${direction}`, 'POST')
    }
  }
  const count = app.commands().length
  const done = app.click('[data-action="tack"]')
  app.choose('CANCEL')
  await done
  assert.equal(app.commands().length, count)
})

test('dodge sends PUT with signed radians; course actions send POST', async () => {
  const app = await fixture()
  for (const [direction, degrees] of [['port', -5], ['starboard', 5]]) {
    const done = app.click(`[data-dir="${direction}"]`)
    app.choose('OK')
    await done
    expectCommand(app, '/dodge', 'PUT', { value: degrees * Math.PI / 180 })
  }
  const done = app.click('[data-action="courseCurrentPoint"]')
  assert.equal(app.commands().length, 2)
  app.choose('OK')
  await done
  expectCommand(app, '/courseCurrentPoint', 'POST')
  await app.click('[data-action="courseNextPoint"]')
  expectCommand(app, '/courseNextPoint', 'POST')
})

test('options.actions are rendered and live availableActions IDs update availability', async () => {
  const app = await fixture()
  assert.equal(app.controls.querySelectorAll('[data-cmd="action"]').length, 4)
  app.delta([{ path: 'steering.autopilot.availableActions', value: ['courseCurrentPoint'] }])
  assert.equal(app.controls.querySelector('[data-action="tack"]').disabled, true)
  assert.equal(app.controls.querySelector('[data-action="courseCurrentPoint"]').disabled, false)
  await app.click('[data-action="tack"]')
  assert.equal(app.commands().length, 0)
  app.delta([{ path: 'steering.autopilot.availableActions', value: ['tack'] }])
  assert.equal(app.controls.querySelector('[data-action="tack"]').disabled, false)
})

test('standby locks target adjustments; offline locks every control', async () => {
  const app = await fixture({ engaged: false })
  assert.equal(app.controls.querySelector('[data-deg="1"]').disabled, true)
  await app.click('[data-deg="1"]')
  assert.equal(app.commands().length, 0)
  // Even a stale engaged flag or available action must not enable offline controls.
  app.delta([{ path: 'steering.autopilot.engaged', value: true },
    { path: 'steering.autopilot.state', value: 'off-line' }])
  for (const b of app.controls.querySelectorAll('button')) assert.equal(b.disabled, true)
})

test('live rendering preserves in-flight lockout and allows dialog choices', async () => {
  let release
  const pending = new Promise((resolve) => { release = resolve })
  const app = await fixture({ pending })
  const done = app.click('[data-deg="1"]')
  app.delta([{ path: 'steering.autopilot.target', value: 1 }])
  assert.equal(app.controls.querySelector('[data-deg="1"]').disabled, true)
  await app.click('[data-deg="1"]')
  assert.equal(app.commands().length, 1)
  release()
  await done
  assert.equal(app.controls.querySelector('[data-deg="1"]').disabled, false)
  const engaging = app.click('[data-cmd="auto"]')
  app.delta([{ path: 'steering.autopilot.engaged', value: false }])
  assert.equal(app.document.getElementById('dlgBtns').children.find((b) => b.textContent === 'OK').disabled, false)
  app.choose('OK')
  await engaging
  expectCommand(app, '/engage', 'POST')
})

test('successful commands reconcile via GET and failures show a toast and unlock controls', async () => {
  const app = await fixture({ fail: 409 })
  await app.click('[data-deg="1"]')
  assert.match(app.document.getElementById('toast').textContent, /409/)
  assert.equal(app.controls.querySelector('[data-deg="1"]').disabled, false)
  const success = await fixture()
  await success.click('[data-deg="1"]')
  assert.equal(success.requests.at(-1).url, base)
  assert.equal(success.requests.at(-1).method, undefined)
})
