# Phase 2 Handoff — wire the command buttons

**For:** Claude Code (or any dev) picking up `signalk-autopilot-head`.
**Goal of Phase 2:** make the already-rendered control buttons actually drive the autopilot through
the Signal K **v2 Autopilot API**, generically (no provider-specific hardcoding), with safety guards.

Phase 1 (done) is discovery + a live **read-only** GHC 20-style display. All the buttons exist in the
DOM but are `disabled`. Phase 2 = enable + wire them, reflect availability, and reconcile UI with
server state.

---

## Repo & dev workflow (unchanged)

- **Dev machine (Mac):** `~/buttercup/signalk-autopilot-head` — edit here.
- **GitHub:** `github.com/ryansabin/signalk-autopilot-head` (branch `main`).
- **Boat Pi (`buttercup`):** clone at `~/dev/signalk-autopilot-head`, installed into the Signal K
  server as a `file:` dependency, so `~/.signalk/node_modules/signalk-autopilot-head` is an
  npm-managed symlink to it.

Loop:
```
# Mac
npm test && git add -A && git commit -m "…" && git push
# Pi (ssh buttercup)
cd ~/dev/signalk-autopilot-head && git pull && npm test
```
UI edits (public/*) are live on browser refresh because of the symlink. **Only restart Signal K
(`sudo systemctl restart signalk`) if `package.json` changes** (keywords/deps) — not for UI edits.
The server enumerates webapps only at startup.

> Install gotcha (already solved, don't repeat): a bare `ln -s` into `~/.signalk/node_modules` gets
> pruned by npm because it isn't a dependency. It must be a `file:` dep in `~/.signalk/package.json`.

---

## Current architecture (what to build on)

No build step, no framework, no deps. Everything is in `public/`:

- `public/index.html` — markup. The control buttons already exist with `data-*` hooks (see below).
- `public/app.js` — an IIFE. Key pieces:
  - `state` — `{ deviceId, options:{states,modes}, ap:{state,mode,engaged,target,actions}, nav:{…} }`
  - `api(path, opts)` — `fetch` wrapper: `credentials:'include'`, throws on !ok, 401 → `requireLogin()`.
  - `discover()` — finds the device (`state.deviceId`), seeds `options`, calls `renderModes()`.
  - `connectWs()` / `onDelta()` / `routeValue()` — live delta stream → `state` → `render()`.
  - `render()` — banner, heading, tape, strip, `renderActions()`.
  - `renderModes()` / `renderActions()` — build the mode + action buttons (currently `disabled`).
  - Constants: `AP_BASE = '/signalk/v2/api/vessels/self/autopilots'`, `DEG(rad)`, `norm180/360`.
  - Debug hook: `window.__pilot`.

### DOM the buttons already expose (in index.html)
```html
<button class="btn btn--standby" data-cmd="standby" disabled>STANDBY</button>
<button class="btn btn--auto"    data-cmd="auto"    disabled>AUTO</button>
<button class="btn btn--adj" data-cmd="adjust" data-deg="-10" disabled>−10</button>  (also -1, 1, 10)
<div id="modeRow"   …></div>   <!-- renderModes(): btn--mode  data-cmd="mode"   data-mode="<m>" -->
<div id="actionRow" …></div>   <!-- renderActions(): btn--action data-cmd="action" data-action="<id>" -->
```
`renderActions()` already adds class `is-unavailable` when `action.available` is false.

---

## Phase 2 tasks

### 1. A command sender
Add near `api()`:
```js
function RAD (deg) { return deg * Math.PI / 180 }
async function apPut (subpath, body) {
  return api(AP_BASE + '/' + encodeURIComponent(state.deviceId) + subpath, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}
```
On success, optionally call `refreshAp()` to reconcile immediately (deltas will also update).
On failure, surface a brief toast (add a small `toast(msg)` helper; don't reuse the blocking overlay
for transient command errors).

### 2. Event delegation
One listener on `.controls` (buttons are recreated by renderModes/renderActions, so delegate — don't
bind per button):
```js
document.querySelector('.controls').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-cmd]'); if (!b || b.disabled) return
  const cmd = b.dataset.cmd
  if (cmd === 'standby') return void guardedStandby()
  if (cmd === 'auto')    return void guardedEngage()
  if (cmd === 'adjust')  return void apPut('/target/adjust', { value: RAD(Number(b.dataset.deg)) })
  if (cmd === 'mode')    return void apPut('/mode',  { value: b.dataset.mode })
  if (cmd === 'action')  return void runAction(b.dataset.action)
})
```

### 3. Command → endpoint map (verify against the running server + provider `index.js`)
Base: `/signalk/v2/api/vessels/self/autopilots/{deviceId}`

| Button | Method + subpath | Body | Notes |
|---|---|---|---|
| AUTO | `PUT /engage` | — | or `PUT /state {value:'auto'}` |
| STANDBY | `PUT /disengage` | — | or `PUT /state {value:'standby'}` |
| mode | `PUT /mode` | `{value:'<mode>'}` | mode string from `options.modes` |
| −10/−1/+1/+10 | `PUT /target/adjust` | `{value:<radians>}` | **value is RADIANS** — convert from deg |
| tack | `PUT /tack/port` \| `/tack/starboard` | — | action id `tack` |
| gybe | `PUT /gybe/port` \| `/gybe/starboard` | — | action id `gybe` |
| dodge | `PUT /dodge` | `{value:<radians>}` | quantized nudge; provider decides step |
| follow waypoint | `PUT /courseCurrentPoint` | — | action id `courseCurrentPoint` |

Do **not** wire `setTarget` (absolute) or `courseNextPoint` — both are throwing stubs on the Garmin
provider (no absolute-heading PGN; plotter advances waypoints). If a future provider supports them,
gate on a successful probe, not a hardcode.

> The Garmin provider's method surface is in `signalk-autopilot-provider-garmin/index.js`
> (`engage`, `disengage`, `setState`, `setMode`, `adjustTarget`, `tack(dir)`, `gybe(dir)`,
> `dodge(value)`, `courseCurrentPoint`). Confirm the exact v2 REST payload shape the server expects
> from `@signalk/server-api` (autopilot API) before finalizing — units and the `{value}` envelope
> matter.

### 4. `runAction(id)` + direction
- `tack` / `gybe` need a direction (`port`/`starboard`). Add a small port/stbd affordance (two-way
  button or a quick inline chooser) rather than guessing. The provider auto-picks the *geometrically*
  correct turn from wind, but the API path still takes a direction.
- `dodge` needs a magnitude and a side; simplest: two dodge buttons (port/stbd) sending a fixed step.
- `courseCurrentPoint` is a plain PUT.

### 5. Enable / disable logic (drive from server, not assumptions)
- Enable AUTO/STANDBY/mode when `state.deviceId` is set and not `off-line`.
- Enable −/+ adjust only when engaged (`state.ap.engaged || state.ap.state==='auto'`).
- Action buttons: enable strictly from `action.available` (already computed by the provider and put on
  `state.ap.actions`). Remove the blanket `disabled = true` in `renderActions()` / `renderModes()` and
  set `disabled` from real conditions. Keep `is-unavailable` styling in sync.
- Re-evaluate enablement inside `render()` so it tracks live state (engage/standby, mode, wind known).

### 6. Safety guards (required)
- **Confirm before anything that moves the boat:** AUTO/engage, tack, gybe, dodge, patterns. Use a
  small confirm modal (in-flow, not `position:fixed`). Standby should be instant (no confirm) — it's
  the safety-off.
- **Disengaged lockout:** adjust/tack/gybe/dodge inert unless engaged.
- **Debounce/lock** a button while its request is in flight to avoid double-fires.
- Keep the existing "No Autopilot / off-line" banner behavior; disable all move commands when off-line.

### 7. UX reconcile
- After a successful command, let the WS deltas update `state` and re-`render()`. Optionally do an
  immediate `refreshAp()` for snappier feedback, but the server/CCU is the source of truth — never
  latch the UI to the requested value (target is reconstructed and can differ).

---

## Testing

Extend `test/scaffold.test.js` (or add `test/commands.test.js`) — keep it dependency-free
(`node --test`), since there's no DOM in CI:
- Assert the command map exists and uses `/target/adjust`, `/engage`, `/disengage`, `/mode`,
  `/tack/`, `/gybe/`, `/dodge`, `/courseCurrentPoint`.
- Assert `setTarget`/`courseNextPoint` are **not** wired.
- Unit-test any pure helper you add (e.g. `RAD`, a `degToRadStep` map) by exporting it on
  `window.__pilot` and/or factoring pure logic into a testable form.
- `node --check public/app.js` (already a test) must stay green.

**Manual dockside checklist (clutch disengaged, helm manned):**
engage → heading hold holds; ±1/±10 nudges move target on the tape and the boat; mode compass↔wind;
tack/gybe each direction; dodge; standby disengages. Verify the tape target bug and banner track the
GHC head if you also press buttons on the physical GHC.

## Definition of done
- All buttons issue the correct v2 PUTs; disabled/available states reflect live server data.
- Confirm guards on move commands; standby instant; in-flight lockout; off-line lockout.
- Tests green on Mac and Pi; `node --check` clean.
- No provider-specific hardcoding beyond gracefully hiding unsupported ops.

## Gotchas
- `adjustTarget` value is **radians** — convert from the button's `data-deg`.
- 401 → `requireLogin()` already redirects to `/admin/#/login?redirect=…`; keep using `api()` so auth
  is handled uniformly.
- If the plugin config has the controller keepalive on and a physical GHC is on the bus, commands can
  contend — that's a provider/config concern, not the webapp's, but note it if you see arbitration.
- Round any degrees shown to the user; keep internal math in radians.
