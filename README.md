# signalk-autopilot-head

A modern, **device-agnostic autopilot control head** webapp for **any Signal K v2 autopilot**.
Layout and interaction are modelled on the **Garmin GHC 20** helm control; the data path is the
standard Signal K **v2 Autopilot API**, so it works with any provider (Garmin Reactor, Raymarine,
pypilot, …) — no dependency on any specific autopilot plugin.

> Status: **Phase 1** — discovery + live read-only display. Command wiring (engage/standby, mode,
> target adjust, tack/gybe, dodge) lands in Phase 2.

## What it does (Phase 1)
- Discovers the server's autopilot device(s) via `GET /signalk/v2/api/vessels/self/autopilots`.
- Renders `state` / `mode` / `engaged` / `target` plus live vessel `heading`, `rudderAngle`,
  apparent wind, COG and STW over the Signal K delta WebSocket.
- Builds the **mode** and **action** buttons from what the provider advertises (`options.modes`,
  `data.actions[].available`) — so the head only ever shows what that device supports. Buttons are
  present but disabled until Phase 2.

## Design
- **Standalone Signal K webapp.** A `public/` folder the server auto-mounts; appears in *Webapps*.
- **No build step, no framework, no dependencies.** Vanilla JS + SVG. Runs offline on a Pi.
- **Generic by construction.** Nothing is hardcoded to a specific provider; the UI is driven by the
  v2 API's advertised options/actions. Proprietary v1 extras (e.g. Garmin steering patterns) are
  intentionally out of the generic core.

## Requirements
- Signal K server **≥ 2.x** with the Autopilot API and at least one registered v2 autopilot provider.
- A modern browser. Uses the shared server cookie session (`credentials: include`); if not logged in
  it hands off to the Admin UI login and returns.

## Install
```
cd ~/.signalk/node_modules
npm install signalk-autopilot-head
# or, for development, symlink a checkout:
#   git clone https://github.com/ryansabin/signalk-autopilot-head
#   ln -s "$(pwd)/signalk-autopilot-head" ~/.signalk/node_modules/signalk-autopilot-head
```
Restart the server; open **Pilot** from the *Webapps* list.

## Development workflow
Develop locally → push to GitHub → pull on the boat's Pi → run tests:
```
# on the dev machine
git add -A && git commit -m "..." && git push

# on the Pi (Signal K host)
cd ~/dev/signalk-autopilot-head && git pull && npm test
```

## Tests
```
npm test        # node --test — validates manifest, webapp packaging, HTML wiring, JS syntax
```

## License
Apache-2.0.
