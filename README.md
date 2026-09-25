# Pioneer Home

Home automation for a Raspberry Pi, written as a spreadsheet: flat TSV tables describe devices, formulas,
scenes, schedules, rules and timed sequences. A small TypeScript engine evaluates them like a
spreadsheet and talks to zigbee2mqtt and a GPIO service over MQTT. Statistics go to PocketBase.

## Part of the pioneer series

This is a pioneer project from Maskinrepubliken. Pioneer projects are small programs that run on a Raspberry Pi, each built for one specific place and purpose. They are open source, so you can read, change and run the code yourself. The code is kept small and plainly structured, which makes it easy to adapt, with or without AI tools. Treat it as a starting point for your own setup, not a finished product.

## What it does

Built to be worked on by AI code agents: every fact is one table row, every change is a one-line diff,
and the simulator answers "what happens if" by running the real engine against a fake clock.

- `example/` an example house (tables and scenarios) with generic room and device names
- `tables/`, `scenarios/` your own configuration: gitignored, never committed. When `tables/` is missing,
  `just`, the tests and the web mock use `example/` instead
- `engine/` engine, CLI, simulator (Node 22, TypeScript, vitest)
- `gpio/` Python GPIO service (DHT22 sensors, PWM fan)
- `web/` Svelte UI served by the engine
- `zigbee2mqtt/`, `pocketbase/`, `deploy/`

## Hardware

A Raspberry Pi (tested on a Pi 3 Model B+, 64-bit Debian) reached over SSH at `PI_HOST`. Services run under
systemd (no Docker):

| service | where | notes |
|---|---|---|
| mosquitto | `localhost:1883` | LAN only |
| zigbee2mqtt | `/opt/zigbee2mqtt`, UI :8080 | base topic `zigbee2mqtt`, devices publish with `retain: true` |
| pocketbase | `/opt/pocketbase`, :8090 | collections `climate`, `weather`, `heating`, `power` (see `pocketbase/pb_migrations/`) |
| pioneer-engine | `/opt/pioneer-home`, :8000 | this repo |
| pioneer-gpio | `/opt/pioneer-home/gpio` | this repo |

The web UI (Swedish) is served at `http://<pi>:8000/`; tables can be edited there.

## Getting started

```
cp -r example/tables example/scenarios .                        # then edit to match your devices
cp .env.example .env                                            # PI_HOST=pi@<your pi>
cp gpio/gpio.example.yaml gpio/gpio.yaml
cp zigbee2mqtt/configuration.example.yaml zigbee2mqtt/configuration.yaml
git -C tables init                                              # optional: version your tables locally
```

`tables/`, `scenarios/`, `.env`, `gpio/gpio.yaml`, `zigbee2mqtt/configuration.yaml` and `CLAUDE.local.md`
are gitignored, so the facts about your house stay on your machine and the Pi.

Everyday commands:

```
just check                                   validate tables
just test                                    unit tests + scenarios/*.tsv
just simulate --at 2026-09-23T21:00 --set climate1.temperature=19 --advance 1m
just scenario scenarios/fan_curve.tsv -v
just eval 'BETWEEN(TIME(), 19:30, 06:00)' --at 2026-09-23T21:00
```

See `CLAUDE.md` for the full reference (tables, formula language, actions, workflow).

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Viktor Lyresten / Maskinrepubliken.
