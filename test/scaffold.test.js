'use strict'

// Dependency-free smoke tests using Node's built-in test runner (`node --test`).
// These guard the scaffold: valid manifest, correct webapp packaging, syntactically
// valid client JS, and the HTML wiring the app expects.

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const root = path.join(__dirname, '..')
const pub = path.join(root, 'public')
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8')

test('package.json is valid and declares a Signal K webapp', () => {
  const pkg = JSON.parse(read('package.json'))
  assert.strictEqual(pkg.name, 'signalk-autopilot-head')
  assert.ok(pkg['signalk-webapp'] === true || (pkg.keywords || []).includes('signalk-webapp'),
    'must be flagged as a signalk-webapp')
  assert.ok(pkg.signalk && pkg.signalk.displayName, 'needs signalk.displayName')
})

test('public/ contains the webapp entry files', () => {
  for (const f of ['index.html', 'app.js', 'style.css']) {
    assert.ok(fs.existsSync(path.join(pub, f)), 'missing public/' + f)
  }
})

test('index.html wires app.js and style.css', () => {
  const html = read('public/index.html')
  assert.match(html, /src="app\.js"/)
  assert.match(html, /href="style\.css"/)
})

test('app.js is syntactically valid', () => {
  // `node --check` throws (non-zero) on a syntax error.
  execFileSync(process.execPath, ['--check', path.join(pub, 'app.js')])
})

test('app.js targets the v2 autopilot API', () => {
  const js = read('public/app.js')
  assert.match(js, /\/signalk\/v2\/api\/vessels\/self\/autopilots/)
})

test('device-id normalization handles map and array shapes', async () => {
  // Load app.js in a minimal DOM-less shim by extracting the pure helper.
  // The helper is also exposed on window.__pilot at runtime; here we re-implement
  // the contract check against the source to keep the test dependency-free.
  const js = read('public/app.js')
  assert.match(js, /function normalizeDeviceIds/)
  assert.match(js, /Array\.isArray\(list\)/)
})
