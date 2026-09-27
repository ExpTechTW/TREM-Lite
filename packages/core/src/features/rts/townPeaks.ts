/**
 * The bottom-right ranking's memory: each town's highest level over the last
 * 60 s, keyed by city + town, so a town that shook stays on the list after
 * its stations calm down. Only that ranking reads it — the maximum intensity
 * and the trigger box take each frame's `int` as it comes.
 */
export interface TownLevel {
  code: number;
  i: number;
}

const WINDOW_MS = 60_000;

export class TownPeaks {
  private towns = new Map<string, { code: number; samples: { time: number; i: number }[] }>();

  constructor(private readonly townOf: (code: number) => { city: string; town: string } | null) {}

  clear(): void {
    this.towns.clear();
  }

  /** Adds one frame's per-town levels at `now`; returns every town's peak in the window. */
  update(frame: TownLevel[], now: number): TownLevel[] {
    for (const entry of frame) {
      const name = this.townOf(entry.code);
      const key = name ? `${name.city}${name.town}` : String(entry.code);
      let town = this.towns.get(key);
      if (!town) this.towns.set(key, (town = { code: entry.code, samples: [] }));
      town.samples.push({ time: now, i: entry.i });
    }

    const peaks: TownLevel[] = [];
    for (const [key, town] of this.towns) {
      // `time <= now` also drops what a jump back in time left in the future.
      town.samples = town.samples.filter((s) => s.time <= now && now - s.time < WINDOW_MS);
      if (!town.samples.length) {
        this.towns.delete(key);
        continue;
      }
      peaks.push({ code: town.code, i: Math.max(...town.samples.map((s) => s.i)) });
    }
    return peaks;
  }
}
