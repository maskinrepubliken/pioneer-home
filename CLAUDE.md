# pioneer-home

The home as a spreadsheet. Everything the house does is described by flat TSV tables in `tables/` (gitignored; `example/tables/` is the shipped example). There are no "modes": state lives in plain cells and vars, behaviour in rules.
A small engine recomputes cells like a spreadsheet, fires rules on edges, and sends commands to
zigbee2mqtt and a GPIO service over MQTT.

Never guess about the physical setup. Facts about the Pi, its devices and services are in `CLAUDE.local.md`
(gitignored, may be missing), `README.md` (section "The Pi") and `tables/devices.tsv`. If something is not written down, ask.
Never commit facts about a specific house (room or device names, hosts, addresses, locations): they belong in
`tables/` or `CLAUDE.local.md`, which are gitignored. Examples in code, tests and docs use the names from `example/`.

## Repo map

| path | what |
|---|---|
| `tables/*.tsv` | **The configuration.** Source of truth, hot-reloaded on the Pi. Gitignored. |
| `example/` | Example tables and scenarios with generic names; used when `tables/` is missing. |
| `scenarios/*.tsv` | Behaviour tests of the home, run by `just test`. One row per step. |
| `engine/` | TypeScript engine, CLI (`home`), simulator. Node 20+ (the Pi runs Node 20). |
| `engine/src/formula/` | The formula language (lexer, parser, type checker, evaluator). |
| `engine/src/config/` | TSV reader, table loader and validation, action parser. |
| `engine/src/core/` | Cell store, dependency graph, engine passes, device kinds, clock, transport. |
| `engine/src/sim/` | Simulator, scenario runner, trace formatting. |
| `engine/src/adapters/` | MQTT, HTTP/SSE, PocketBase history, weather, file watcher, snapshots. |
| `gpio/` | Python service: DHT22 sensors in, PWM fan out, over MQTT (Phase 4). |
| `web/` | Svelte 5 + Vite UI served by the engine at `/`: live grid with controls, tables, trace, history charts. `pnpm --filter web mock` + `dev` to work on it without the Pi. |
| `zigbee2mqtt/` | Versioned zigbee2mqtt configuration (secrets in gitignored `secret.yaml`). |
| `pocketbase/pb_migrations/` | PocketBase schema. Existing collections `climate`, `weather`, `heating`, `power` are kept. |
| `deploy/` | systemd units and install script for the Pi. |
| `justfile` | Every command you need. `just` alone = check + test. |

## Workflow for any behaviour change

1. Edit a table (or add a row). One rule per row. Put thresholds in `cells.tsv` as constant cells.
2. `just check` — validation errors point at `file:line [column]`.
3. Add or adjust a row in `scenarios/*.tsv` that proves the behaviour. Every behaviour change ships with a scenario row.
4. `just test` — unit tests plus every scenario.
5. `just simulate --at 2026-09-23T21:00 --set cell=value --advance 10m` to look at a trace when unsure.
6. `just deploy-tables` (tables only, hot reload, no restart) or `just deploy` (code too).

Commit tables and scenarios together.

Tables can also be edited in the web UI (Tabeller → Redigera). The engine validates the whole configuration before writing, so a broken edit is refused with `file:line [column]` errors and nothing changes. Saved edits are committed in the git repo at `/opt/pioneer-home/tables` on the Pi. To bring them to this machine run `just pull-tables`, review `git -C tables diff`, add scenario rows, commit in `tables/`. `just deploy-tables` refuses to run with uncommitted changes in `tables/` (when it is a git repo) because it pulls the Pi's edits first.

## The cell model

Every value in the house is a **cell** with a dotted id. Kinds of cell:

- `input`: device properties fed from MQTT (`lamp1.brightness`), plus system cells `sun.elevation`, `sun.azimuth`, `sun.up`, `weather.*`.
- `var`: held values written by rules or the UI (`fan_auto`). A row in `cells.tsv` without a formula.
- `derived`: formula cells. A row in `cells.tsv` with a formula. Recomputed when an input changes, or every second if they depend on time. Constants such as thresholds are derived cells whose formula is a number (`fan_max_temp = 20`).
- `setting`: engine configuration from `settings.tsv` (timezone, coordinates, MQTT), also readable as cells.

Ids: `device.prop`, where the device id is the device's own stable name, the same as its zigbee2mqtt friendly name in lowercase (`motion1`, `floor1`, `lamp1`, `climate1`, `fan`). **Never put the room in an id**: sensors move between rooms. The room is the `room` column in `devices.tsv`, must be an id from `rooms.tsv` (ASCII Swedish: `bedroom`, `workshop`, `living_room`, `study`), and is readable as the cells `<device>.room` and `<device>.room_name` (the Swedish name from `rooms.tsv`). Moving a sensor is a one-cell edit in `devices.tsv`; history and UI grouping follow. Display names (Swedish, with åäö) go in `name` columns.
Derived cells and vars are named after what they mean, not where: `fan_target`, `too_dry`, `floor1_heating`.
A bare device id is an alias for its primary prop: `lamp1` = `lamp1.state`, `fan` = `fan.level`, `motion1` = `motion1.occupancy`.
Every device also has `.room`, `.room_name`, `.available` and `.last_seen`.

**NULL** means "unknown" (sensor has not reported yet). Arithmetic and comparisons with NULL give NULL; `AND`/`OR` are three-valued; a rule whose condition is NULL never fires. Use `COALESCE(x, default)` when a rule must act even before a value is known (see `fan_follow`).

Brightness is 0–100 %, colour temperature is Kelvin. The zigbee2mqtt conversion (0–254, mireds) lives only in `engine/src/core/kinds.ts`.

## Tables

TSV: tab-separated, no quoting, `#` comment lines, header row, columns matched by name. An empty cell means "no change" / "none". Run `just fmt` to normalise.

| table | columns | notes |
|---|---|---|
| `settings.tsv` | key, value, note | engine configuration (System); every key is a cell |
| `rooms.tsv` | id, name, note | room ids and Swedish names; `name` becomes `<device>.room_name` and the `location` in climate history |
| `devices.tsv` | id, room, kind, source, name, note | id = stable device name, room ∈ rooms.tsv; kind ∈ light, plug, motion, contact, thermostat, remote, climate, pwm. source `z2m:<friendly>` or `mqtt:<topic>` |
| `cells.tsv` | id, formula, initial, type, room, note | with formula = computed (typed in dependency order, cycles are errors); without formula = held value with `initial` (type inferred, or `type` ∈ number, boolean, string, duration, timeofday, timestamp); `room` (optional, from rooms.tsv) groups the cell under that room in the UI |
| `scenes.tsv` | device, `<scene>`... | grid; cell = target tokens; empty = untouched |
| `rules.tsv` | id, when, if, then, enabled, note | see below |
| `sequences.tsv` | sequence, step, after, action, cancel_if, note | `after` is relative to the previous step; step `*` = whole-sequence cancel condition |
| `history.tsv` | record, collection, field, formula, scale, min_interval, max_interval, min_delta, note | rows with the same `record` form one PocketBase record; `max_interval` = heartbeat write even when unchanged |

### Rules

- `when` empty: **rising edge** of `if`. Fires once when the condition goes from not-true to true, re-arms when it stops being true. This is the default and the spreadsheet way: express "hall idle for 5 min" as a derived cell and fire on its edge.
- `when` = `on <cell>`: fires on **every change** of that cell while `if` is true (or `if` empty). Use for buttons (`remote1`) and computed levels (`on fan_wanted`).
- `when` = `on event`: fires when an event is dispatched; `if` usually `event = "name"`.
- `when` = `at <time> [days]`: a clock trigger. Time is `08:00`, `sunrise`, `sunset`, `sunset-30m`, `sunrise+1h`; days `mon-fri`, `sat-sun`, `mon,wed`, `daily` (default). This replaces the old schedule table.
- `then`: actions separated by `;`. `enabled` = `no` disables a row (used during the Node-RED cutover).

Remote (button) cells are transient: every press counts as a change even if the action string repeats, and the cell returns to NULL after the pass.

### Actions

```
set <device> <targets...>       set lamp1 60% 2700K transition=2s
                                set lamp1 brightness+=20%     (relative, device does the maths)
                                set fan 40                     (pwm level / thermostat setpoint)
set <var> <value>               set fan_auto FALSE
scene <scene> [<room>]          scene night  /  scene off living_room
event <name>                    event goodnight        (fires `on event` rules; the UI and remotes can send events)
start <sequence> [unless running]
cancel <sequence>
fade <device> <targets> over <dur>   fade lamp1 70% 4000K over 20m
notify "<text>"                 publishes to MQTT topic home/notify
log "<text>"
script <file> [<args>]          tables/scripts/<file>.ts, last resort
```
Any token may contain `{formula}`: `set fan {fan_wanted}`, `set lamp1 on {IF(late_night, "color=#ff0000", "2000K")}`.
Target tokens: `on`, `off`, `60%`, `2700K`, `color=#ff0000`, `brightness+=20%`, `brightness-=20%`, `transition=2s`, `setpoint=21`, `mode=heat`, or a bare number for pwm/setpoint.

### Formula language cheat sheet

Excel-flavoured. Refs are lowercase dotted ids, functions UPPERCASE. Literals: `10`, `"text"`, `TRUE`, `10m` / `1h30m` (duration), `07:30` (time of day), `NULL`.
Operators: `= <> < <= > >= + - * / &` (`&` concatenates). No `&&`/`||`: use `AND()`/`OR()`.

| group | functions |
|---|---|
| logic | `AND OR NOT IF COALESCE ISBLANK` |
| math | `AVG MIN MAX SUM ABS ROUND CLAMP(x,lo,hi) BETWEEN(x,lo,hi) COUNT` |
| text | `TEXT LOWER UPPER` |
| time | `NOW() TIME() WEEKDAY() ISWEEKDAY() ISWEEKEND() HOUR() MINUTE() TODAY(07:30) SUNRISE() SUNSET() MINUTES(d) HOURS(d) SECONDS(d)` |
| history | `SINCE(cell)` `SINCE(cell, value)` `PREV(cell)` `CHANGED(cell)` `HOLD(cell, 10m)` |

Idioms:
```
BETWEEN(TIME(), 19:30, 06:00)                       time window wrapping midnight
AND(NOT(hall.motion), SINCE(hall.motion, TRUE) > 5m) quiet for 5 minutes
HOLD(bath.humid, 2m)                                 true continuously for 2 minutes
sun.elevation < dark_elevation                       dark, threshold from settings
COALESCE(fan.level, -1)                     treat unknown as -1
```
Time-dependent cells (`TIME`, `SINCE`, ...) are re-evaluated every second; edge rules make that safe.

## Simulating and reading a trace

```
just simulate --at 2026-09-23T21:00 --set climate1.temperature=19 --advance 1m
just simulate --at 2026-09-23T23:30 --action 'set lamp1 on' --all-rules
just eval 'BETWEEN(TIME(), 19:30, 06:00)' --at 2026-09-23T21:00
just scenario scenarios/fan_curve.tsv -v
```
A trace lists, per pass: `changed` input cells, `derived` recomputations, `rule` evaluations (FIRED or the reason not), `action`s with the MQTT topic and payload, `seq` events, `error`s. In the simulator, commands are echoed back as device state, so the next pass shows the consequence.

Scenario rows: `step | at | do | expect`. `at` = absolute `2026-09-23T21:00` (first row) or `+5m`. `do` = `set <cell> <value>`, `event <name>`, `mqtt <topic> <json>`, `action <text>`, `enable <rule...>` / `disable <rule...>` (scenarios for rules that are disabled during the cutover enable them first). `expect` (`;`-separated) = `sent <device> k=v ...`, `nothing sent`, `fired <rule>`, `not fired <rule>`, `running <seq>`, `not running <seq>`, or any formula that must be TRUE.

## Engine behaviour worth knowing

- One cause per pass. Actions that change engine state (`event`, `set <var>`, `start`, `cancel`) become new passes, so traces stay readable. A chain deeper than 20 passes is cut with an error (rules feeding each other).
- Device cells change only when the device reports back over MQTT, never optimistically.
- Rate guard: more than 10 commands to one device in 10 s are dropped with an error in the trace.
- Startup and hot reload evaluate everything and baseline rule edges **without firing**.
- `DRY_RUN=true` logs actions instead of publishing (used during the Node-RED cutover). `just dryrun` prints what the engine would have sent and whether the device ended up in that state anyway (because Node-RED did it).
- Snapshot of the store and running sequences is saved every 30 s so `SINCE` and sequences survive restarts.

## Conventions

- English words for ids and columns (device ids follow zigbee2mqtt names), Swedish for `name` and `note`. Comments in tables are welcome (`#` lines).
- The web UI is in Swedish: every label, button, status text and chart title. Label maps live in `web/src/lib/format.ts`. Cell ids, table contents, formulas and engine-generated trace text stay as they are.
- The Tabeller view documents itself in Swedish from `web/src/lib/docs.sv.ts` (table purposes, columns, formula and action help). That file mirrors this document: when a table, column, function or action changes here, change it there too.
- The web UI follows the Maskinrepubliken design system. Tokens and rules are copied in `web/design/` (see `SOURCE.md` there); `web/src/tokens.css` is generated from `web/design/tokens.json` and every colour, radius, spacing and font in the UI comes from those variables. No shadows, no gradients, no opacity for tone, no transitions; status is never carried by colour alone; buttons are pills; hover swaps the surface to `paper-hover`; focus is a solid 2 px ring.
- One rule per row; split rather than nest `IF`s. Timed things are `at` rules, not a separate schedule. Prefer derived cell + edge rule over `on <cell>` rules.
- Order of preference for logic: derived + rule → sequence → script. Scripts are rare and need a reason in `note`.
- Never write to device cells directly; send a command and let the device report.
- Do not add functions to the formula language casually. Every addition needs tests and a line in this file.
- `engine/src/core/kinds.ts` is the only place that knows zigbee2mqtt payload shapes.

## History, weather, GPIO

- `history.tsv` drives the PocketBase writer (`engine/src/core/history.ts` + `adapters/pocketbase.ts`). Rows sharing a `record` id are written as one PocketBase record when any field changes, at most once per `min_interval`, only if a numeric field moved by `min_delta`. Constant fields are quoted strings or numbers (`"climate1"`, `10`). Without `PB_URL`/`PB_EMAIL`/`PB_PASSWORD` in the env the engine keeps recent rows in memory only (the UI history view still works for the current run). In `DRY_RUN` history rows are logged, not written.
- `weather.*` cells come from OpenWeatherMap (`adapters/weather.ts`) when `OWM_API_KEY` is set; polling interval is `weather_interval` in settings.tsv.
- `gpio/gpio.py` (Python, systemd unit `pioneer-gpio`) reads the DHT22s and drives the PWM fan; topics under `home/gpio/`, configured in `gpio/gpio.yaml`. Run it with `GPIO_FAKE=1` off the Pi.
- The engine's HTTP API is documented at the top of `engine/src/adapters/http.ts`; `/api/history/:collection?since=&until=` proxies PocketBase so it never needs open rules.

## Deployment

The Pi runs services with systemd, no Docker. `just deploy` runs check + test, builds a self-contained engine bundle (`pnpm deploy`, Node 20 compatible, no native modules), rsyncs bundle, tables, scenarios, deploy files, gpio and web/dist to `/opt/pioneer-home` on the Pi and restarts `pioneer-engine`. `just deploy-tables` only syncs tables and scenarios (hot reloaded, no restart). `just logs` follows the journal. Environment lives in `/etc/pioneer-home/engine.env` (`DRY_RUN`, `PB_*`, `OWM_API_KEY`); `deploy/install.sh` sets up units and env files once. Confirm with the user before changing `DRY_RUN`, touching Node-RED, zigbee2mqtt or PocketBase services, or editing env files on the Pi.

## Open items

House-specific open questions live in `CLAUDE.local.md`. Do not guess.
