# gpio service

Reads the two DHT22 sensors and drives the PWM fan on the Pi, speaking MQTT to the engine.

Install on the Pi (once):

```
cd /opt/pioneer-home/gpio
python3 -m venv .venv --system-site-packages
.venv/bin/pip install -r requirements.txt
sudo systemctl enable --now pioneer-gpio
```

`--system-site-packages` reuses the Debian-packaged gpiozero/lgpio. Set `GPIOZERO_PIN_FACTORY=lgpio` in
`/etc/pioneer-home/gpio.env` if gpiozero picks the wrong backend. Run with `GPIO_FAKE=1` on a laptop to
publish random readings without hardware.
