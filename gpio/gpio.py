#!/usr/bin/env python3
"""
pioneer-home GPIO service: reads DHT22 sensors and drives a PWM fan, all over MQTT.

Publishes (retained):
  <base>/<sensor id>          {"temperature": 21.4, "humidity": 48.2, "ts": "...", "reads": 3}
  <base>/<sensor id>/status   online | offline (last will)
  <base>/fan                  {"level": 0-100, "ts": "..."}
Subscribes:
  <base>/fan/set              {"level": 0-100}

Configuration: gpio.yaml next to this file (gitignored; falls back to gpio.example.yaml) or GPIO_CONFIG env. MQTT_URL env overrides mqtt.url.
"""
from __future__ import annotations

import json
import logging
import os
import signal
import statistics
import sys
import threading
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

import paho.mqtt.client as mqtt
import yaml

log = logging.getLogger("pioneer-gpio")


@dataclass
class SensorCfg:
    id: str
    model: str
    pin: int
    interval_s: int = 30
    samples: int = 3
    max_jump_c: float = 10.0


@dataclass
class FanCfg:
    pin: int
    frequency_hz: int = 100
    initial_level: int = 0


@dataclass
class Config:
    mqtt_url: str
    base: str
    sensors: list[SensorCfg] = field(default_factory=list)
    fan: FanCfg | None = None


def load_config(path: Path) -> Config:
    raw = yaml.safe_load(path.read_text()) or {}
    mqtt_cfg = raw.get("mqtt", {})
    url = os.environ.get("MQTT_URL", mqtt_cfg.get("url", "mqtt://localhost:1883"))
    sensors = [SensorCfg(**s) for s in raw.get("sensors", [])]
    fan = FanCfg(**raw["fan"]) if raw.get("fan") else None
    return Config(mqtt_url=url, base=raw.get("base", "home/gpio"), sensors=sensors, fan=fan)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


# --------------------------------------------------------------------------------------------
# Sensors
# --------------------------------------------------------------------------------------------


class DhtReader:
    """DHT22/DHT11 via adafruit-circuitpython-dht. Reads are slow (~2 s) and often fail: we take a
    handful of samples, keep the median, and reject physically impossible values or huge jumps."""

    def __init__(self, cfg: SensorCfg):
        import adafruit_dht  # type: ignore
        import board  # type: ignore

        self.cfg = cfg
        pin = getattr(board, f"D{cfg.pin}")
        cls = adafruit_dht.DHT22 if cfg.model.lower() == "dht22" else adafruit_dht.DHT11
        self.dev = cls(pin, use_pulseio=False)
        self.last_temp: float | None = None

    def read(self) -> tuple[float, float, int] | None:
        temps: list[float] = []
        hums: list[float] = []
        attempts = 0
        while len(temps) < self.cfg.samples and attempts < self.cfg.samples * 3:
            attempts += 1
            try:
                t = self.dev.temperature
                h = self.dev.humidity
            except RuntimeError:
                time.sleep(2.1)
                continue
            if t is None or h is None or not (-40 <= t <= 80) or not (0 <= h <= 100):
                time.sleep(2.1)
                continue
            temps.append(float(t))
            hums.append(float(h))
            time.sleep(2.1)
        if not temps:
            return None
        t = statistics.median(temps)
        h = statistics.median(hums)
        if self.last_temp is not None and abs(t - self.last_temp) > self.cfg.max_jump_c:
            log.warning("%s: rejecting jump %.1f -> %.1f", self.cfg.id, self.last_temp, t)
            return None
        self.last_temp = t
        return round(t, 1), round(h, 1), len(temps)


class FakeReader:
    """Used with GPIO_FAKE=1 for development off the Pi."""

    def __init__(self, cfg: SensorCfg):
        self.cfg = cfg
        self.t = 20.0

    def read(self) -> tuple[float, float, int] | None:
        import random

        self.t += random.uniform(-0.2, 0.2)
        return round(self.t, 1), round(50 + random.uniform(-3, 3), 1), 3


# --------------------------------------------------------------------------------------------
# Fan
# --------------------------------------------------------------------------------------------


class Fan:
    def __init__(self, cfg: FanCfg, fake: bool):
        self.cfg = cfg
        self.level = cfg.initial_level
        self.dev = None
        if not fake:
            from gpiozero import PWMOutputDevice  # type: ignore

            self.dev = PWMOutputDevice(cfg.pin, frequency=cfg.frequency_hz, initial_value=cfg.initial_level / 100)

    def set(self, level: int) -> int:
        level = max(0, min(100, int(round(level))))
        self.level = level
        if self.dev is not None:
            self.dev.value = level / 100
        return level


# --------------------------------------------------------------------------------------------
# Service
# --------------------------------------------------------------------------------------------


class Service:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self.fake = os.environ.get("GPIO_FAKE") == "1"
        self.stop = threading.Event()
        self.fan = Fan(cfg.fan, self.fake) if cfg.fan else None
        u = urlparse(cfg.mqtt_url)
        self.client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="pioneer-gpio")
        if u.username:
            self.client.username_pw_set(u.username, u.password)
        self.client.will_set(f"{cfg.base}/status", "offline", retain=True)
        self.client.on_connect = self._on_connect
        self.client.on_message = self._on_message
        self.client.connect_async(u.hostname or "localhost", u.port or 1883, keepalive=30)

    # MQTT -----------------------------------------------------------------------------------

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        log.info("mqtt connected (%s)", reason_code)
        client.publish(f"{self.cfg.base}/status", "online", retain=True)
        for s in self.cfg.sensors:
            client.publish(f"{self.cfg.base}/{s.id}/status", "online", retain=True)
        if self.fan:
            client.subscribe(f"{self.cfg.base}/fan/set")
            self.publish_fan()

    def _on_message(self, client, userdata, msg):
        if self.fan and msg.topic == f"{self.cfg.base}/fan/set":
            try:
                payload = json.loads(msg.payload.decode())
                level = payload["level"] if isinstance(payload, dict) else payload
                level = self.fan.set(float(level))
                log.info("fan -> %d%%", level)
                self.publish_fan()
            except Exception as e:  # noqa: BLE001
                log.warning("bad fan/set payload %r: %s", msg.payload, e)

    def publish_fan(self):
        if self.fan:
            self.client.publish(f"{self.cfg.base}/fan", json.dumps({"level": self.fan.level, "ts": now_iso()}), retain=True)

    # Sensors --------------------------------------------------------------------------------

    def sensor_loop(self, cfg: SensorCfg):
        reader = FakeReader(cfg) if self.fake else DhtReader(cfg)
        failures = 0
        while not self.stop.is_set():
            started = time.monotonic()
            result = reader.read()
            if result is None:
                failures += 1
                if failures in (3, 10, 50):
                    log.warning("%s: %d consecutive failed reads", cfg.id, failures)
                if failures >= 10:
                    self.client.publish(f"{self.cfg.base}/{cfg.id}/status", "offline", retain=True)
            else:
                if failures >= 10:
                    self.client.publish(f"{self.cfg.base}/{cfg.id}/status", "online", retain=True)
                failures = 0
                t, h, n = result
                self.client.publish(
                    f"{self.cfg.base}/{cfg.id}",
                    json.dumps({"temperature": t, "humidity": h, "ts": now_iso(), "reads": n}),
                    retain=True,
                )
                log.debug("%s: %.1f C %.1f %%", cfg.id, t, h)
            elapsed = time.monotonic() - started
            self.stop.wait(max(1.0, cfg.interval_s - elapsed))

    def run(self):
        self.client.loop_start()
        threads = [threading.Thread(target=self.sensor_loop, args=(s,), name=s.id, daemon=True) for s in self.cfg.sensors]
        for t in threads:
            t.start()
        log.info("running: %d sensors, fan=%s, base=%s, fake=%s", len(threads), bool(self.fan), self.cfg.base, self.fake)
        try:
            while not self.stop.is_set():
                self.stop.wait(1.0)
        finally:
            self.client.publish(f"{self.cfg.base}/status", "offline", retain=True)
            self.client.loop_stop()
            self.client.disconnect()


def main() -> int:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(levelname)s %(name)s %(message)s", stream=sys.stdout)
    default_cfg = Path(__file__).with_name("gpio.yaml")
    if not default_cfg.exists():
        default_cfg = Path(__file__).with_name("gpio.example.yaml")
    cfg_path = Path(os.environ.get("GPIO_CONFIG", default_cfg))
    cfg = load_config(cfg_path)
    svc = Service(cfg)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: svc.stop.set())
    svc.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
