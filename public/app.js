'use strict'

/*
 * signalk-autopilot-head — a device-agnostic control head for any Signal K v2 autopilot.
 *
 * Phase 1: discovery + live read-only display.
 *   - Discovers the server's autopilot device(s) via the v2 Autopilot API.
 *   - Renders state / mode / engaged / target and the vessel heading, rudder, wind, COG, STW live
 *     over the Signal K delta WebSocket.
 *   - Builds the mode + action buttons from what the provider advertises (options / actions), but
 *     leaves them disabled — command wiring lands in Phase 2.
 *
 * No build step, no framework, no dependencies. Works against any Signal K server >= 2.x.
 */

;(function () {
  // ---- config / constants ------------------------------------------------
  const AP_BASE = '/signalk/v2/api/vessels/self/autopilots'
  const RECONNECT_MS = 3000
  const POLL_MS = 2000 // REST fallback for autopilot data if no AP deltas arrive

  const DEG = (rad) => (rad == null || !isFinite(rad)) ? null : rad * 180 / Math.PI
  const norm360 = (d) => ((d % 360) + 360) % 360
  const norm180 = (d) => { d = ((d % 360) + 360) % 360; return d > 180 ? d - 360 : d }

  // ---- app state ---------------------------------------------------------
  const state = {
    deviceId: null,
    options: { states: [], modes: [] },
    ap: { state: null, mode: null, engaged: null, target: null, actions: [] },
    nav: { heading: null, cog: null, stw: null, rudder: null, awa: null },
    ws: null,
    wsAlive: false,
    lastApDelta: 0
  }

  // ---- DOM ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id)
  const el = {
    app: $('app'), device: $('deviceName'), conn: $('conn'), banner: $('banner'),
    heading: $('heading'), target: $('target'), awa: $('awa'), cog: $('cog'), stw: $('stw'),
    rudderFill: $('rudderFill'), roseRing: $('roseRing'), targetBug: $('targetBug'),
    modeRow: $('modeRow'), actionRow: $('actionRow'),
    overlay: $('overlay'), overlayMsg: $('overlayMsg'), overlayBtn: $('overlayBtn')
  }

  // ---- HTTP helpers ------------------------------------------------------
  async function api (path, opts) {
    const res = await fetch(path, Object.assign({ credentials: 'include' }, opts))
    if (res.status === 401) { requireLogin(); throw new Error('unauthenticated') }
    if (!res.ok) throw new Error(path + ' -> ' + res.status)
    const ct = res.headers.get('content-type') || ''
    return ct.includes('application/json') ? res.json() : res.text()
  }

  function requireLogin () {
    const here = location.pathname + location.search + location.hash
    showOverlay('Sign in required.', 'Log in', () => {
      location.href = '/admin/#/login?redirect=' + encodeURIComponent(here)
    })
  }

  function showOverlay (msg, btnLabel, onClick) {
    el.overlayMsg.textContent = msg
    if (btnLabel) {
      el.overlayBtn.textContent = btnLabel
      el.overlayBtn.hidden = false
      el.overlayBtn.onclick = onClick
    } else {
      el.overlayBtn.hidden = true
    }
    el.overlay.hidden = false
  }
  function hideOverlay () { el.overlay.hidden = true }

  // ---- discovery ---------------------------------------------------------
  async function discover () {
    // Confirm the autopilot API is present.
    try {
      const feats = await api('/signalk/v2/features?enable=1')
      const apis = (feats && feats.apis) || []
      if (Array.isArray(apis) && apis.length && !apis.includes('autopilot')) {
        // Some servers list it; absence isn't fatal (older servers omit the field), so only warn.
        console.warn('autopilot not listed in /features; continuing')
      }
    } catch (e) { console.warn('feature probe failed', e.message) }

    // List devices. Shape can be a map { id: {...} } or an array of ids/objects.
    let list
    try { list = await api(AP_BASE) } catch (e) {
      showOverlay('No Signal K v2 autopilot API found on this server.'); throw e
    }
    const ids = normalizeDeviceIds(list)
    if (!ids.length) { showOverlay('No autopilot devices are registered on this server.'); throw new Error('no devices') }

    // Prefer a default if the server marks one; else first. (_default is a valid server alias too.)
    state.deviceId = ids.find((x) => x.isDefault)?.id || ids[0].id
    el.device.textContent = state.deviceId

    await refreshAp() // seed options + current data
    renderModes()
  }

  function normalizeDeviceIds (list) {
    if (!list) return []
    if (Array.isArray(list)) {
      return list.map((x) => (typeof x === 'string') ? { id: x } : { id: x.id || x.deviceId, isDefault: !!x.isDefault })
                 .filter((x) => x.id)
    }
    if (typeof list === 'object') {
      return Object.keys(list).map((id) => ({ id, isDefault: !!(list[id] && list[id].isDefault) }))
    }
    return []
  }

  async function refreshAp () {
    if (!state.deviceId) return
    try {
      const d = await api(AP_BASE + '/' + encodeURIComponent(state.deviceId))
      applyApData(d)
    } catch (e) { /* transient; WS/poll will retry */ }
  }

  function applyApData (d) {
    if (!d || typeof d !== 'object') return
    if (d.options) state.options = { states: d.options.states || [], modes: d.options.modes || [] }
    if ('state' in d) state.ap.state = d.state
    if ('mode' in d) state.ap.mode = d.mode
    if ('engaged' in d) state.ap.engaged = d.engaged
    if ('target' in d) state.ap.target = d.target
    if (Array.isArray(d.actions)) state.ap.actions = d.actions
    render()
  }

  // ---- WebSocket ---------------------------------------------------------
  function connectWs () {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const url = proto + '//' + location.host + '/signalk/v1/stream?subscribe=none'
    let ws
    try { ws = new WebSocket(url) } catch (e) { scheduleReconnect(); return }
    state.ws = ws

    ws.onopen = () => {
      state.wsAlive = true
      setConn('live')
      ws.send(JSON.stringify({
        context: 'vessels.self',
        subscribe: [
          { path: 'steering.autopilot.*', period: 500 },
          { path: 'navigation.headingMagnetic', period: 500 },
          { path: 'navigation.courseOverGroundTrue', period: 1000 },
          { path: 'navigation.speedThroughWater', period: 1000 },
          { path: 'navigation.rudderAngle', period: 300 },
          { path: 'environment.wind.angleApparent', period: 500 }
        ]
      }))
    }
    ws.onmessage = (ev) => { try { onDelta(JSON.parse(ev.data)) } catch (e) {} }
    ws.onclose = () => { state.wsAlive = false; setConn('offline'); scheduleReconnect() }
    ws.onerror = () => { try { ws.close() } catch (e) {} }
  }

  function scheduleReconnect () { setTimeout(connectWs, RECONNECT_MS) }

  function onDelta (msg) {
    if (!msg || !Array.isArray(msg.updates)) return
    for (const u of msg.updates) {
      for (const v of (u.values || [])) {
        routeValue(v.path, v.value)
      }
    }
    render()
  }

  function routeValue (path, value) {
    switch (path) {
      case 'navigation.headingMagnetic': state.nav.heading = DEG(value); break
      case 'navigation.courseOverGroundTrue': state.nav.cog = DEG(value); break
      case 'navigation.speedThroughWater': state.nav.stw = value; break
      case 'navigation.rudderAngle': state.nav.rudder = DEG(value); break
      case 'environment.wind.angleApparent': state.nav.awa = DEG(value); break
      case 'steering.autopilot.state': state.ap.state = value; markAp(); break
      case 'steering.autopilot.mode': state.ap.mode = value; markAp(); break
      case 'steering.autopilot.engaged': state.ap.engaged = value; markAp(); break
      case 'steering.autopilot.target':
      case 'steering.autopilot.targetHeadingMagnetic':
      case 'steering.autopilot.targetWindAngleApparent':
        state.ap.target = value; markAp(); break
      default: break
    }
  }
  function markAp () { state.lastApDelta = Date.now() }

  // ---- rendering ---------------------------------------------------------
  function setConn (kind) {
    el.conn.textContent = kind === 'live' ? 'live' : (kind === 'offline' ? 'offline' : 'connecting…')
    el.conn.className = 'conn conn--' + kind
  }

  function render () {
    const s = state.ap.state
    const engaged = !!state.ap.engaged
    const offline = s === 'off-line'

    // banner
    let label = 'STANDBY'
    let cls = 'banner--standby'
    if (offline) { label = 'OFF-LINE'; cls = 'banner--offline' }
    else if (engaged || s === 'auto') { label = (state.ap.mode || 'AUTO').toUpperCase(); cls = 'banner--engaged' }
    el.banner.textContent = label
    el.banner.className = 'banner ' + cls
    el.app.setAttribute('data-state', offline ? 'offline' : (engaged ? 'engaged' : 'standby'))

    // heading + rose
    const hdg = state.nav.heading
    el.heading.textContent = (hdg == null) ? '---' : String(Math.round(norm360(hdg))).padStart(3, '0')
    if (hdg != null) el.roseRing.setAttribute('transform', 'rotate(' + (-norm360(hdg)) + ' 150 150)')

    // target bug: place relative to heading on the rose (top = current heading)
    const tgtDeg = DEG(state.ap.target)
    if (tgtDeg != null && hdg != null && (engaged || s === 'auto')) {
      const rel = norm180(tgtDeg - hdg)
      el.targetBug.style.display = ''
      el.targetBug.setAttribute('transform', 'rotate(' + rel + ' 150 150)')
      el.target.textContent = String(Math.round(norm360(tgtDeg))).padStart(3, '0') + '°'
    } else {
      el.targetBug.style.display = 'none'
      el.target.textContent = '--'
    }

    // rudder bar: -45..45 deg -> -100..100%
    const r = state.nav.rudder
    if (r == null) { el.rudderFill.style.width = '0%'; el.rudderFill.style.left = '50%' }
    else {
      const pct = Math.max(-1, Math.min(1, r / 45))
      const w = Math.abs(pct) * 50
      el.rudderFill.style.width = w + '%'
      el.rudderFill.style.left = (pct >= 0 ? 50 : 50 - w) + '%'
    }

    // strip
    el.awa.textContent = state.nav.awa == null ? '--' : Math.round(state.nav.awa) + '°'
    el.cog.textContent = state.nav.cog == null ? '--' : String(Math.round(norm360(state.nav.cog))).padStart(3, '0') + '°'
    el.stw.textContent = state.nav.stw == null ? '--' : (state.nav.stw * 1.94384).toFixed(1) + ' kn'

    renderActions()
  }

  function renderModes () {
    el.modeRow.innerHTML = ''
    for (const m of state.options.modes) {
      const b = document.createElement('button')
      b.className = 'btn btn--mode'
      b.dataset.cmd = 'mode'
      b.dataset.mode = m
      b.textContent = String(m).toUpperCase()
      b.disabled = true // Phase 2 wires this
      el.modeRow.appendChild(b)
    }
  }

  function renderActions () {
    // Only rebuild if the action signature changed (avoid thrashing the DOM every delta).
    const sig = state.ap.actions.map((a) => a.id + ':' + (a.available ? 1 : 0)).join(',')
    if (sig === renderActions._sig) return
    renderActions._sig = sig
    el.actionRow.innerHTML = ''
    for (const a of state.ap.actions) {
      const b = document.createElement('button')
      b.className = 'btn btn--action'
      b.dataset.cmd = 'action'
      b.dataset.action = a.id
      b.textContent = a.name || a.id
      b.disabled = true // Phase 2 wires + respects a.available
      if (!a.available) b.classList.add('is-unavailable')
      el.actionRow.appendChild(b)
    }
  }

  // ---- poll fallback -----------------------------------------------------
  function startPollFallback () {
    setInterval(() => {
      // If AP deltas aren't flowing (server doesn't emit them), refresh via REST.
      if (Date.now() - state.lastApDelta > POLL_MS) refreshAp()
    }, POLL_MS)
  }

  // ---- boot --------------------------------------------------------------
  async function boot () {
    setConn('connecting')
    try {
      await discover()
      hideOverlay()
    } catch (e) {
      console.error('discovery failed:', e.message)
      // overlay already shown by discover() on the fatal paths
      return
    }
    connectWs()
    startPollFallback()
  }

  document.addEventListener('DOMContentLoaded', boot)

  // Expose a little surface for tests / debugging.
  window.__pilot = { state, DEG, norm180, norm360, normalizeDeviceIds }
})()
