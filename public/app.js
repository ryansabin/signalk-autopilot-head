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
  const RAD = (deg) => deg * Math.PI / 180
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

  const inFlight = new Set()

  // ---- DOM ---------------------------------------------------------------
  const $ = (id) => document.getElementById(id)
  const el = {
    app: $('app'), device: $('deviceName'), conn: $('conn'),
    banner: $('banner'), bannerText: $('bannerText'), engLamp: $('engLamp'),
    heading: $('heading'), target: $('target'), awa: $('awa'), cog: $('cog'), stw: $('stw'),
    rudderFill: $('rudderFill'),
    tapeTicks: $('tapeTicks'), tapeTarget: $('tapeTarget'), tapeTargetLabel: $('tapeTargetLabel'),
    modeRow: $('modeRow'), actionRow: $('actionRow'),
    overlay: $('overlay'), overlayMsg: $('overlayMsg'), overlayBtn: $('overlayBtn'),
    toast: $('toast'),
    dlg: $('dlg'), dlgTitle: $('dlgTitle'), dlgBody: $('dlgBody'), dlgBtns: $('dlgBtns')
  }

  const SVGNS = 'http://www.w3.org/2000/svg'
  const TAPE_CX = 300              // svg center (viewBox 0..600)
  const TAPE_PXDEG = 600 / 64      // ~64° window across the tape
  const TAPE_MIN = 4, TAPE_MAX = 596

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

  // ---- command helpers ---------------------------------------------------
  async function apPut (subpath, body) {
    return api(AP_BASE + '/' + encodeURIComponent(state.deviceId) + subpath, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  let _toastTimer = null
  function toast (msg) {
    el.toast.textContent = msg
    el.toast.hidden = false
    clearTimeout(_toastTimer)
    _toastTimer = setTimeout(() => { el.toast.hidden = true }, 3500)
  }

  function showDlg (title, body, buttons) {
    return new Promise((resolve) => {
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      el.dlgTitle.textContent = title
      el.dlgBody.textContent = body
      el.dlgBtns.innerHTML = ''
      for (const { label, value, cls } of buttons) {
        const b = document.createElement('button')
        b.className = 'btn ' + (cls || '')
        b.textContent = label
        b.onclick = () => { el.dlg.close(); finish(value) }
        el.dlgBtns.appendChild(b)
      }
      el.dlg.onclose = () => finish('cancel')
      el.dlg.showModal()
    })
  }

  async function confirmModal (msg) {
    const v = await showDlg('Confirm', msg, [
      { label: 'CANCEL', value: 'cancel', cls: '' },
      { label: 'OK', value: 'ok', cls: 'btn--auto' }
    ])
    return v === 'ok'
  }

  async function dirModal (title) {
    const v = await showDlg(title, 'Select direction', [
      { label: '\u25c4 PORT', value: 'port', cls: 'btn--adj' },
      { label: 'STBD \u25ba', value: 'stbd', cls: 'btn--adj' },
      { label: 'CANCEL', value: 'cancel', cls: '' }
    ])
    return v === 'cancel' ? null : v
  }

  async function guardedStandby () {
    await apPut('/disengage')
  }

  async function guardedEngage () {
    if (!await confirmModal('Engage autopilot?')) return
    await apPut('/engage')
  }

  async function runAction (id) {
    if (id === 'tack' || id === 'gybe') {
      const dir = await dirModal(id.toUpperCase())
      if (!dir) return
      await apPut('/' + id + '/' + dir)
    } else if (id === 'courseCurrentPoint') {
      if (!await confirmModal('Follow current waypoint?')) return
      await apPut('/courseCurrentPoint')
    } else {
      await apPut('/' + id)
    }
  }

  async function handleControlClick (e) {
    const b = e.target.closest('button[data-cmd]')
    if (!b || b.disabled) return
    const key = [b.dataset.cmd, b.dataset.mode, b.dataset.action, b.dataset.deg, b.dataset.dir]
      .filter(Boolean).join(':')
    if (inFlight.has(key)) return
    inFlight.add(key)
    b.disabled = true
    try {
      if (b.dataset.cmd === 'standby')     await guardedStandby()
      else if (b.dataset.cmd === 'auto')   await guardedEngage()
      else if (b.dataset.cmd === 'adjust') await apPut('/target/adjust', { value: RAD(Number(b.dataset.deg)) })
      else if (b.dataset.cmd === 'mode')   await apPut('/mode', { value: b.dataset.mode })
      else if (b.dataset.cmd === 'dodge') {
        const msg = 'Dodge ' + (b.dataset.dir === 'port' ? 'to port' : 'to starboard') + '?'
        if (await confirmModal(msg)) await apPut('/dodge', { value: RAD(b.dataset.dir === 'port' ? -5 : 5) })
      } else if (b.dataset.cmd === 'action') await runAction(b.dataset.action)
    } catch (err) {
      toast(err.message || 'Command failed')
    } finally {
      inFlight.delete(key)
      updateButtonStates()
    }
  }

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
    const on = engaged || s === 'auto' // "steering" (engaged in some mode)

    // banner (GHC-style: mode phrase left, engaged lamp right)
    let cls = 'banner--standby', text = 'Standby'
    if (offline) { cls = 'banner--offline'; text = 'No Autopilot' }
    else if (on) { cls = 'banner--engaged'; text = bannerLabel(state.ap.mode) }
    el.banner.className = 'banner ' + cls
    el.bannerText.textContent = text
    el.app.setAttribute('data-state', offline ? 'offline' : (on ? 'engaged' : 'standby'))

    // heading number
    const hdg = state.nav.heading
    el.heading.textContent = (hdg == null) ? '---' : String(Math.round(norm360(hdg))).padStart(3, '0')

    // linear tape + target bug
    const tgtDeg = DEG(state.ap.target)
    renderTape(hdg, on, tgtDeg)
    el.target.textContent = (on && tgtDeg != null) ? String(Math.round(norm360(tgtDeg))).padStart(3, '0') + '°' : '--'

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
    updateButtonStates()
  }

  function bannerLabel (mode) {
    switch (String(mode)) {
      case 'compass': return 'Heading Hold'
      case 'wind': return 'Wind Hold'
      case 'route': return 'Route'
      default: return mode ? (mode[0].toUpperCase() + mode.slice(1)) : 'Auto'
    }
  }

  function cardinal (d) {
    const n = norm360(d)
    const card = { 0: 'N', 90: 'E', 180: 'S', 270: 'W' }
    if (card[n] !== undefined) return { text: card[n], isCard: true }
    return { text: String(Math.round(n)).padStart(3, '0'), isCard: false }
  }

  // Redraw the heading tape: minor ticks every 5°, labelled majors every 15°, centered on the
  // current heading, with a cyan target bug at the target's position.
  function renderTape (hdg, showTarget, tgtDeg) {
    const g = el.tapeTicks
    g.textContent = ''
    if (hdg == null) { el.tapeTarget.style.display = 'none'; return }

    const start = Math.ceil((hdg - 34) / 5) * 5
    for (let d = start; d <= hdg + 34; d += 5) {
      const x = TAPE_CX + norm180(d - hdg) * TAPE_PXDEG
      if (x < TAPE_MIN || x > TAPE_MAX) continue
      const major = ((((d % 15) + 15) % 15) === 0)
      const line = document.createElementNS(SVGNS, 'line')
      line.setAttribute('x1', x); line.setAttribute('y1', 22)
      line.setAttribute('x2', x); line.setAttribute('y2', 22 + (major ? 15 : 8))
      line.setAttribute('class', 'tape__tick' + (major ? ' tape__tick--major' : ''))
      g.appendChild(line)
      if (major) {
        const c = cardinal(d)
        const t = document.createElementNS(SVGNS, 'text')
        t.setAttribute('x', x); t.setAttribute('y', 58); t.setAttribute('text-anchor', 'middle')
        t.setAttribute('class', 'tape__label' + (c.isCard ? ' tape__label--card' : ''))
        t.textContent = c.text
        g.appendChild(t)
      }
    }

    if (showTarget && tgtDeg != null) {
      const x = TAPE_CX + norm180(tgtDeg - hdg) * TAPE_PXDEG
      if (x >= TAPE_MIN && x <= TAPE_MAX) {
        el.tapeTarget.style.display = ''
        el.tapeTarget.setAttribute('transform', 'translate(' + (x - TAPE_CX) + ' 0)')
        el.tapeTargetLabel.textContent = String(Math.round(norm360(tgtDeg))).padStart(3, '0')
      } else {
        el.tapeTarget.style.display = 'none'
      }
    } else {
      el.tapeTarget.style.display = 'none'
    }
  }

  function updateButtonStates () {
    const hasDevice = !!state.deviceId
    const offline = state.ap.state === 'off-line'
    const engaged = !!state.ap.engaged || state.ap.state === 'auto'
    const ready = hasDevice && !offline

    const btnStandby = document.querySelector('.btn--standby')
    const btnAuto = document.querySelector('.btn--auto')
    if (btnStandby) btnStandby.disabled = !ready
    if (btnAuto) btnAuto.disabled = !ready

    for (const b of document.querySelectorAll('.btn--adj')) {
      b.disabled = !engaged
    }

    for (const b of el.modeRow.querySelectorAll('button[data-cmd="mode"]')) {
      b.disabled = !ready
      b.classList.toggle('is-active', b.dataset.mode === state.ap.mode)
    }

    const actionMap = new Map(state.ap.actions.map((a) => [a.id, a]))
    for (const b of el.actionRow.querySelectorAll('button')) {
      const id = b.dataset.action || (b.dataset.cmd === 'dodge' ? 'dodge' : null)
      const action = id ? actionMap.get(id) : null
      b.disabled = !(action && action.available !== false)
    }
  }

  function renderModes () {
    el.modeRow.innerHTML = ''
    for (const m of state.options.modes) {
      const b = document.createElement('button')
      b.className = 'btn btn--mode'
      b.dataset.cmd = 'mode'
      b.dataset.mode = m
      b.textContent = String(m).toUpperCase()
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
      if (a.id === 'dodge') {
        for (const dir of ['port', 'stbd']) {
          const b = document.createElement('button')
          b.className = 'btn btn--action'
          b.dataset.cmd = 'dodge'
          b.dataset.dir = dir
          b.textContent = dir === 'port' ? '\u25c4 DODGE' : 'DODGE \u25ba'
          if (!a.available) b.classList.add('is-unavailable')
          el.actionRow.appendChild(b)
        }
        continue
      }
      const b = document.createElement('button')
      b.className = 'btn btn--action'
      b.dataset.cmd = 'action'
      b.dataset.action = a.id
      b.textContent = a.name || a.id
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
    document.querySelector('.controls').addEventListener('click', handleControlClick)
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
  window.__pilot = { state, DEG, RAD, norm180, norm360, normalizeDeviceIds, apPut, inFlight }
})()
