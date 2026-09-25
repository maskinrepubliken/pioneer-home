/**
 * Sun position and sunrise/sunset for the configured location, via suncalc.
 */
import SunCalc from 'suncalc';

export interface SunProvider {
  /** degrees above the horizon (negative below) */
  elevation(epochMs: number): number;
  /** degrees, 0 = north, clockwise */
  azimuth(epochMs: number): number;
  /** sunrise for the local calendar day that contains `epochMs`, epoch ms */
  sunrise(epochMs: number, localMidnightMs: number): number;
  sunset(epochMs: number, localMidnightMs: number): number;
}

export function createSunProvider(latitude: number, longitude: number): SunProvider {
  const rad2deg = 180 / Math.PI;
  return {
    elevation(ms) {
      return SunCalc.getPosition(new Date(ms), latitude, longitude).altitude * rad2deg;
    },
    azimuth(ms) {
      // suncalc azimuth is measured from south, clockwise; convert to compass bearing from north.
      const a = SunCalc.getPosition(new Date(ms), latitude, longitude).azimuth * rad2deg;
      return (a + 180 + 360) % 360;
    },
    sunrise(_ms, midnight) {
      return sunTime(midnight, 'sunrise');
    },
    sunset(_ms, midnight) {
      return sunTime(midnight, 'sunset');
    },
  };

  function sunTime(localMidnightMs: number, which: 'sunrise' | 'sunset'): number {
    // suncalc computes times for the date of the given instant (UTC-based); noon local is the safest anchor.
    const noon = new Date(localMidnightMs + 12 * 3_600_000);
    const t = SunCalc.getTimes(noon, latitude, longitude)[which];
    const ms = t.getTime();
    if (Number.isNaN(ms)) {
      // Polar day/night: fall back to local noon (sunrise) or noon (sunset) so schedules stay sane.
      return noon.getTime();
    }
    return ms;
  }
}

/** Fixed sun for tests and the simulator: sunrise 06:00, sunset 18:00 local, elevation from a set value. */
export function fixedSun(elevation = 10): SunProvider & { setElevation(e: number): void } {
  let el = elevation;
  return {
    elevation: () => el,
    azimuth: () => 180,
    sunrise: (_ms, midnight) => midnight + 6 * 3_600_000,
    sunset: (_ms, midnight) => midnight + 18 * 3_600_000,
    setElevation(e) {
      el = e;
    },
  };
}
