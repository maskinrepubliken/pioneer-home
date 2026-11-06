# pioneer-home

The home as a spreadsheet. Everything the house does is described by flat TSV tables in `tables/` (gitignored; `example/tables/` is the shipped example). There are no "modes": state lives in plain cells and vars, behaviour in rules.
A small engine recomputes cells like a spreadsheet, fires rules on edges, and sends commands to
zigbee2mqtt and a GPIO service over MQTT.

Never guess about the physical setup. Facts about the Pi, its devices and services are in `CLAUDE.local.md`
(gitignored, may be missing), `README.md` (section "Hardware") and `tables/devices.tsv`. If something is not written down, ask.
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
| `engine/src/adapters/` | MQTT, HTTP/SSE, PocketBase history, weather, SMHI forecast, the program planner, file watcher, snapshots. |
| `gpio/` | Python service: DHT22 sensors in, PWM fan out, over MQTT (Phase 4). |
| `web/` | Svelte 5 + Vite UI served by the engine at `/`: the rooms (the page Rum, `#/rooms`; `views/Live.svelte`, "Live" in code and below) with controls, tables, trace, history charts. `pnpm --filter web mock` + `dev` to work on it without the Pi. |
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
| `settings.tsv` | key, value, note | engine configuration (System); every key is a cell; `title` is the name in the UI header and browser tab; `start_url` (optional) is where the system icon far left in the header links to |
| `rooms.tsv` | id, name, note | room ids and Swedish names, in the order the Live view shows them; `name` becomes `<device>.room_name` and the `location` in climate history |
| `devices.tsv` | id, room, kind, group, source, name, watts, note | id = stable device name, room ∈ rooms.tsv; group (optional) = appliance column in Live, see below; watts (optional) = rated power, used for the cost estimate; kind ∈ light, plug, motion, contact, thermostat, heater, remote, climate, pwm. source `z2m:<friendly>` or `mqtt:<topic>`, or `estimate` for a heater |
| `cells.tsv` | id, formula, initial, type, room, group, name, note | with formula = computed (typed in dependency order, cycles are errors); without formula = held value with `initial` (type inferred, or `type` ∈ number, boolean, string, duration, timeofday, timestamp); `room` (optional, from rooms.tsv) and `group` (optional) place the cell in a room and appliance column in the UI; `name` is the Swedish label shown instead of the id |
| `scenes.tsv` | device, `<scene>`... | grid; cell = target tokens; empty = untouched |
| `rules.tsv` | id, when, if, then, enabled, note | see below |
| `sequences.tsv` | sequence, step, after, action, cancel_if, note | `after` is relative to the previous step; step `*` = whole-sequence cancel condition |
| `modes.tsv` | id, name, `<room>`..., note | the heating modes and each room's temperature in them; compiled to cells (see Heating modes) |
| `week.tsv` | hour, mon, tue, wed, thu, fri, sat, sun | the heating mode of each hour of the week; the first hour after a change is a transition (see Heating modes) |
| `alerts.tsv` | id, level, if, text, room, note | banners at the top of Live while `if` is TRUE; level ∈ info, warning, danger (most severe first); `text` may contain `{formula}`; compiled to derived cells `alert_<id>` and `alert_<id>_text` (usable in rules and scenarios); thresholds go in cells.tsv |
| `events.tsv` | at, title, note | big changes to the house or to what is measured (a sensor moved, a heater counted from now on, windows insulated); `at` = `YYYY-MM-DD` or `YYYY-MM-DD HH:MM` local; every chart (Chart, HeatStrips, CostBars; `lib/events.ts`) marks the events in its span with a dashed line and title, so statistics before and after read as different eras; Grafer and Kostnader list them and add one (`components/EventsPanel.svelte`); the engine only validates them (`config.events`) |
| `history.tsv` | record, collection, field, formula, scale, min_interval, max_interval, min_delta, note | rows with the same `record` form one PocketBase record; `max_interval` = heartbeat write even when unchanged |

Room target temperature: a held number cell `<room>_target` (room = that room, group = heating) plus a rule `on <room>_target` → `set thermostat in <room> setpoint={<room>_target}`. The Live view shows it as a stepper in the room's Värme column. Moving a thermostat to another room needs no rule change. To make a setpoint changed on the device itself become the room's target (the other thermostats in the room then follow), add one rule per thermostat: `on <device>.setpoint`, if `AND(CHANGED(<device>.last_seen), NOT(ISBLANK(PREV(<device>.setpoint))), <device>.setpoint <> <room>_target)` → `set <room>_target {<device>.setpoint}` (with heating modes, `set heat_mode manual; ` first). `CHANGED(<device>.last_seen)` keeps out the broker's retained replay when the engine connects (old state; only live reports stamp `last_seen`), the `PREV` guard the first value after startup, and the `<>` guard makes the echo of the engine's own command a no-op.

A heater the engine cannot steer (no radio, its own clock): describe its settings as constant cells (temperatures, `timeofday` switch times, room = its room, group = heating) and what it holds now as a derived cell `<room>_local_setpoint`, e.g. `IF(OR(TIME() >= night_from, TIME() < day_from), night_temp, day_temp)`. Värme shows it in the room's line as "eget element 17,0°" instead of "ingen termostat"; nothing is sent. For its cost, add it to devices.tsv as kind `heater`, source `estimate`, with `watts`, and a `heating` history record with a `sensor` constant and `pi`/`current`/`target` from `<id>.demand`/`.temperature`/`.setpoint`. The program service (adapters/program.ts) then fills those cells every quarter: the room temperature from the room's other sensors, the setpoint from `<room>_local_setpoint`, and the share of time it heats (`localDemand` in core/thermal.ts: 100 % well below the setpoint, 0 well above, in between what the room loses by a model fitted hourly on its own history, `fitLocalHeater`: cool-downs give the loss, warm-ups at full power the heater's effect; until enough of both, unknown, written as 0 since PocketBase cannot store an empty number). Each time the model is refitted it revises the heater's own history rows to what it would estimate now (`reviseLocal`, through `HistoryQuery.update`), so hours written as unknown get their estimate once it has learnt. Kostnader and Värme take it like a thermostat ("≈" for an estimate); Live leaves its temperature out of the room's readings and shows it like a thermostat row (`live/HeaterStatus.svelte`: estimated heating, the clock's setpoint, and under Detaljer the clock from cells `<room>_heater_night`, `_night_from`, `_day`, `_day_from`, the estimated kW, how far it has learnt and its devices.tsv note).

Heating modes are plain cells and one table, found by name (model in `web/src/lib/heat.ts`). Värme (the landing page: also `#/` and the header's title) shows the mode and chooses it (`components/ModePicker.svelte`: what is in force, the schedule's next switch, a button per mode and what the chosen one means); Program shows it too.
- `heat_mode`: held string, `program` (the week schedule, heated by the program planner), a mode id held all the time (`home`, `sleep`, `away`: the program still heats it by price), or `manual` (Manuellt: its own button, a room target changed in the UI, which sends `set heat_mode manual` first (`targetActions`), or a setpoint changed on a thermostat, whose `<device>_sets_target` rule starts with `set heat_mode manual`). Manuellt leaves the targets alone until program or a mode is chosen.
- `heat_until`: held timestamp, the end of a mode chosen by hand (NULL = until further notice). Värme asks how long when a mode is chosen (ModePicker): Idag (until the week schedule's next switch into `heat_night_mode`, a constant string cell naming the night mode, so the night keeps its place; for the night mode itself, until it ends), I morgon också (the switch after), a time picked, or Tills vidare; Program and Manuellt clear it. The derived cell `heat_until_passed` (a mode with an end, past it) fires the rule `heat_until_end`: `set heat_mode program; set heat_until NULL`. The program plans the chosen mode until `heat_until` and the week schedule after it, so it can warm in time for a return.
- `modes.tsv` (columns `id`, `name`, one per room id, `note`): the modes and each room's temperature in them (a number or a formula; `heat_cold` or empty = cold: no damage to the house, nobody there). Edited on the Lägen page (`views/Modes.svelte`, `#/modes`, `lib/modes.ts`). The loader compiles it to derived cells, like alerts.tsv: `heat_use_<mode>` = `IF(heat_mode = "program", COALESCE(week.<mode>, FALSE), heat_mode = "<mode>")` (in force; `name` is the button label, row order the button order), `<room>_<mode>`, `heat_transition` (two in force at once) and `<room>_comfort` (the warmest mode in force, less `heat_overlap_slack` in a transition, never below `heat_cold`). It needs the cells `heat_mode`, `heat_cold` and `heat_overlap_slack`.
- `week.tsv` (columns `hour` 0-23 and `mon`..`sun`): the mode of each hour of the week (an id from modes.tsv). Where the mode changes, the new mode's first hour is a transition by itself (both in force; `modesInSlot` in `core/schedule.ts`, `inForce` in `lib/week.ts`); a cell may also list two. Painted in the grid on the Program page (`components/WeekEditor.svelte`, saved through `PUT /api/tables/week.tsv`). The engine keeps a boolean system cell `week.<mode>` per mode on the current hour (a timer at every full hour; set without firing at startup and reload). The old name `schedule.tsv` is refused (it was the timed-rules table).
- `<room>_plan` = `COALESCE(program.<room>, <room>_comfort)` in cells.tsv. A rule `on <room>_plan` (`if heat_mode <> "manual"`) copies the plan into `<room>_target`, and a rule `on heat_mode` (same `if`) applies every plan at once. A room with a `_plan` but no `_target` (no thermostat yet) is shown as planned only.
Värme (`views/Heat.svelte`, `#/heat`) lists every room on one line each (temperature, heating state, target stepper), the heated rooms first, and shows the last 48 hours as aligned hourly strips (`components/HeatStrips.svelte`, one measure per strip, never two y-axes): outdoor temperature, daylight (lx per hour from the climate history of the device named by the setting `daylight_sensor`, one whose light sensor sees only the sky; no strip without it), heating power per heat source (kW, from lib/cost.ts energy per hour), each heated room's temperature (the mean of its climate sensors, else its thermostats' readings) with its target as a dashed step, one strip per room on one scale, the price paid per kWh and the cost per heat source (thermostats and estimated heaters in the heated rooms); a picked hour reads across all of them. Above the strips the cost and kWh for 48 and for the last 24 hours. Avoid a cell that changes every second (such as `TIME() - x` on its own): every change is a trace entry, so put such expressions inside the formula that compares them.

The program (the Program page, `web/src/views/Program.svelte`, `#/program`; engine `adapters/program.ts`, `core/thermal.ts`, `core/planner.ts`, `adapters/forecast.ts`; `GET /api/program`) heats within the modes' comfort by price and weather. Every hour it fits each heated room's thermal model (`dT/dt = a·P − b·(T − Tout) + c·S + d`: heating power from the thermostats' `watts` × demand, the room temperature as its thermostats read it, outdoor temperature from the weather history, sun from the solar elevation and the weather icon's cloud cover) on the trajectory (`fitTrajectory` in core/thermal.ts): quarter-hour samples, the model run 8 hours at a time from the measured temperature with the heating and weather that were, coefficients by Nelder–Mead on the misses; a one-step least-squares fit on hourly changes came out far too slow both ways and is only the start point. History: the last 28 days, a day `program_learn_halflife` days old weighing half (default 7), nothing before `program_learn_since` (held string `YYYY-MM-DD`, empty = 28 days; the Program page's "Lär om från i dag" sets it, for when the house has changed; the model then needs 2 days). Each model is then run over the last 7 days the same way (`backtest`, shown on the page as Modellen mot verkligheten for the last 48 hours): when it misses by more than `program_max_error` °C root mean square (default 0.5) or by more than three times that at worst, it is not steered by: no plan, the room's target is its comfort (no preheating), and the nights at the modes' temperatures give it data to learn from. Every quarter it plans the next 36 hours by dynamic programming over the room temperature: SMHI's forecast (snow1g point forecast, cached in `STATE_DIR/forecast.json`), the spot price (beyond the published prices the same quarter a day earlier), and the comfort of each quarter: the modes in force then (`week.tsv` in heat_mode program, else the mode chosen; Manuellt plans as program, for the page), the warmest `<room>_<mode>`, less `heat_overlap_slack` in a transition (the same rule as `<room>_comfort`). The room may lie `program_slack` °C below its comfort, each °C·h below costs `program_shortfall_cost` kr, it may be warmed up to `program_preheat` °C above the comfort of the next 8 hours, and a cold comfort (`heat_cold`) is never undercut. The setpoint for the quarter goes to the system cell `program.<room>` (one per room in rooms.tsv, NULL without a plan); it is the planned temperature at the end of a heating quarter, else the floor. The page shows what the program steers by, the week schedule to paint, what the coming hours are expected to cost (only for planned rooms; no comparison with an unplanned run, it says nothing useful), the coming hours in the same hourly strips as Värme (`ahead` in /api/program: forecast and price for every quarter, planned or not; the Värme and Kostnad strips only with a planned room) with two more on top (Läge: the mode of each hour in the week grid's fills, `MODE_FILLS` in lib/week.ts; Mål: each room's target per quarter, one dash pattern per room), and per room the expected temperature, the thermostats' setpoint over time and its changes (`setpoints` in /api/program: the plan's, or the comfort for a room without a usable model), and its heating curve (kW needed against outdoor temperature) with what the model says in words.

Appliance groups (`group` in devices.tsv and cells.tsv): `light` (Belysning), `heating` (Värme), `air` (Luft och ventilation), `sensors` (Sensorer), `other` (Övrigt). An empty group takes the default for the device kind: light→light, thermostat→heating, pwm/climate→air, motion/contact→sensors, remote/plug→other; cells default to other. The Live view shows each room as one panel split into these columns; held values appear as controls, computed cells and device details sit behind Detaljer.

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
set <kind> in <room> <targets> set thermostat in living_room setpoint={living_room_target}   (every device of that kind in the room, resolved when it runs)
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
| history | `SINCE(cell)` `SINCE(cell, value)` `PREV(cell)` `CHANGED(cell)` `HOLD(cell, 10m)` `SHARE(cell, 15m)` |

Idioms:
```
BETWEEN(TIME(), 19:30, 06:00)                       time window wrapping midnight
AND(NOT(hall.motion), SINCE(hall.motion, TRUE) > 5m) quiet for 5 minutes
HOLD(bath.humid, 2m)                                 true continuously for 2 minutes (also after NULL -> TRUE); the argument must be a cell
ROUND(SHARE(heater1_heating, 15m) * 100)            % of the last 15 min a boolean cell was TRUE (the duty of an on/off heater; at most 24 h back, only known time counts)
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

Scenario rows: `step | at | do | expect`. `at` = absolute `2026-09-23T21:00` (first row) or `+5m`. `do` = `set <cell> <value>`, `event <name>`, `mqtt <topic> <json>` (a live report; the clock moves on a millisecond), `mqtt retained <topic> <json>` (the broker replaying a retained message), `action <text>`, `enable <rule...>` / `disable <rule...>` (scenarios for rules that are disabled during the cutover enable them first). `expect` (`;`-separated) = `sent <device> k=v ...`, `nothing sent`, `fired <rule>`, `not fired <rule>`, `running <seq>`, `not running <seq>`, or any formula that must be TRUE.

## Engine behaviour worth knowing

- One cause per pass. Actions that change engine state (`event`, `set <var>`, `start`, `cancel`) become new passes, so traces stay readable. A chain deeper than 20 passes is cut with an error (rules feeding each other).
- Device cells change only when the device reports back over MQTT, never optimistically.
- `<device>.last_seen` is set by live reports only; a retained message replayed at startup is old state and does not count. When zigbee2mqtt reports on `bridge/logging` that a command to a device failed, `<device>.available` becomes FALSE (Live shows "nås inte") until the device reports live again.
- A command zigbee2mqtt reports as failed (within 2 min of sending) is resent: after 30 s, then after the next failure 2 min, then 5 min; after a third failed resend the trace gets an error "gave up on ...". Nothing is resent when a newer command to the device was sent meanwhile, or when the device already reports the values the command sets. Not in `DRY_RUN`.
- Rate guard: more than 10 commands to one device in 10 s are dropped with an error in the trace.
- Startup and hot reload evaluate everything and baseline rule edges **without firing**.
- `DRY_RUN=true` logs actions instead of publishing (used during the Node-RED cutover). `just dryrun` prints what the engine would have sent and whether the device ended up in that state anyway (because Node-RED did it).
- Snapshot of the store and running sequences is saved every 30 s so `SINCE` and sequences survive restarts.

## Conventions

- English words for ids and columns (device ids follow zigbee2mqtt names), Swedish for `name` and `note`. Comments in tables are welcome (`#` lines).
- The web UI is in Swedish: every label, button, status text and chart title. Label maps live in `web/src/lib/format.ts`. Cell ids, table contents, formulas and engine-generated trace text stay as they are.
- Boolean words in the UI: PÅ/AV only for devices you can switch, JA/NEJ for held values (vars) you can toggle, SANT/FALSKT for everything you cannot change (computed cells, sensor flags). Device kind icons are simple stroke drawings in `web/src/components/live/Icon.svelte`. Every reported value looks the same whatever its source (sensor, thermostat, computed cell): the global `.value` style, numbers through `formatQuantity` in `web/src/lib/format.ts` (°C one decimal, % lx K whole, space before the unit); in Live rows use `components/live/Reading.svelte`. Everything measured in a room (temperature, humidity, light, motion, open) is shown together in the room's readings band (`RoomReadings.svelte`, `roomReadings` in `lib/live.ts`): the mean of the reachable sources with the sources listed under it, whatever device kind reports it. A reading named in the setting `reading_exclude` (cell ids such as `motion1.temperature`, a sensor known to read wrong) is listed as "räknas inte" and left out of the room value on Live, Värme and Grafer; its history is still written. Pure sensors and remotes get no row of their own; their details are under the room's Detaljer.
- The Tabeller view documents itself in Swedish from `web/src/lib/docs.sv.ts` (table purposes, columns, formula and action help). That file mirrors this document: when a table, column, function or action changes here, change it there too.
- The web UI follows the Maskinrepubliken design system. Tokens and rules are copied in `web/design/` (see `SOURCE.md` there); `web/src/tokens.css` is generated from `web/design/tokens.json` and every colour, radius, spacing and font in the UI comes from those variables. No shadows, no gradients, no opacity for tone, no transitions; status is never carried by colour alone; buttons are pills; hover swaps the surface to `paper-hover`; focus is a solid 2 px ring. Charts must read on an e-ink panel: dark colours first and ochre last (`Chart.svelte`), and bar series take their fill from `lib/seriesFill.ts` (solid colours with the widest spread in lightness, the light ochre outlined in ink, a one-pixel paper gap between stacked segments; no patterns, they blur on the glass), by appliance in `applianceOrder` (lib/cost.ts) so an appliance keeps its fill on every page.
- One rule per row; split rather than nest `IF`s. Timed things are `at` rules, not a separate schedule. Prefer derived cell + edge rule over `on <cell>` rules.
- Order of preference for logic: derived + rule → sequence → script. Scripts are rare and need a reason in `note`.
- Never write to device cells directly; send a command and let the device report.
- Do not add functions to the formula language casually. Every addition needs tests and a line in this file.
- `engine/src/core/kinds.ts` is the only place that knows zigbee2mqtt payload shapes.

## History, weather, GPIO

- `history.tsv` drives the PocketBase writer (`engine/src/core/history.ts` + `adapters/pocketbase.ts`). Rows sharing a `record` id are written as one PocketBase record when any field changes, at most once per `min_interval`, only if a numeric field moved by `min_delta`. A record that reads an unreachable device (`.available` FALSE, or no live report for 6 h) is not written, so a dead device's last value never shows up as a flat line. Constant fields are quoted strings or numbers (`"climate1"`, `10`). Without `PB_URL`/`PB_EMAIL`/`PB_PASSWORD` in the env the engine keeps recent rows in memory only (the UI history view still works for the current run). In `DRY_RUN` history rows are logged, not written.
- The Grafer view (`views/History.svelte`, `#/history`) is arranged like Live (`web/src/lib/history.ts`): the room temperatures side by side (mean of each room's sources), one panel per room with every source on its own line, then appliances (pwm levels as curves, everything else as a row of squares: one per hour for 24 h, one per day for a week or a month, filled when on for at least half of it). On/off rows are written only when an appliance switches, so they are fetched 31 days further back to know the state at the start. A history `sensor`/`name` constant is labelled with the Swedish name of the device or cell its history.tsv record reads.
- The footer on every page links to zigbee2mqtt and PocketBase from the settings `z2m_frontend` and `pocketbase_admin` (a full URL, or `:port/path` on the host the UI was loaded from).
- The header has no buttons for sequences; start one from a rule, e.g. `on event` from a remote.
- Kostnader (`web/src/views/Costs.svelte`, `#/costs`) shows the estimated cost for a day, week, month or custom range of days (at most 62), per appliance and per hour or day; the estimate itself is `web/src/lib/cost.ts`. Kostnader and Grafer show only a loading state while a period loads, never the previous period's numbers.
- Electricity: `price_area` in settings.tsv (e.g. `SE3`) makes the engine fetch spot prices from elprisetjustnu.se (`adapters/prices.ts`, days cached in `STATE_DIR/prices/`), feed the system cell `electricity.price` (SEK/kWh without VAT, current 15-minute slot) and serve `/api/prices?since=&until=`. Kostnader estimates cost for every device with `watts`: thermostats by their heating demand, on/off appliances by their on-time, priced at spot × `electricity_vat` + `electricity_surcharge` (cells.tsv).
- `weather.*` cells come from OpenWeatherMap (`adapters/weather.ts`) when `OWM_API_KEY` is set; polling interval is `weather_interval` in settings.tsv.
- `gpio/gpio.py` (Python, systemd unit `pioneer-gpio`) reads the DHT22s and drives the PWM fan; topics under `home/gpio/`, configured in `gpio/gpio.yaml`. Run it with `GPIO_FAKE=1` off the Pi.
- The engine's HTTP API is documented at the top of `engine/src/adapters/http.ts`; `/api/history/:collection?since=&until=` proxies PocketBase so it never needs open rules.

## Deployment

The Pi runs services with systemd, no Docker. `just deploy` runs check + test, builds a self-contained engine bundle (`pnpm deploy`, Node 20 compatible, no native modules), rsyncs bundle, tables, scenarios, deploy files, gpio and web/dist to `/opt/pioneer-home` on the Pi and restarts `pioneer-engine`. `just deploy-tables` only syncs tables and scenarios (hot reloaded, no restart). `just logs` follows the journal. Environment lives in `/etc/pioneer-home/engine.env` (`DRY_RUN`, `PB_*`, `OWM_API_KEY`); `deploy/install.sh` sets up units and env files once. Confirm with the user before changing `DRY_RUN`, touching Node-RED, zigbee2mqtt or PocketBase services, or editing env files on the Pi.

## Open items

House-specific open questions live in `CLAUDE.local.md`. Do not guess.
