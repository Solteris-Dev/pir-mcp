/**
 * The sensor proper: named regions, and the three questions an agent asks of
 * them. State per region is one grid (the last sample) — never an image.
 */
import { captureGrid, type CaptureOptions } from "./capture.js";
import { diff, type Diff, type Grid, type Rect } from "./frame.js";

export interface Region extends Rect {
  name: string;
  /** rects to ignore, in region-local pixel coordinates */
  masks: Rect[];
}

export type Metric = "rmse" | "peak";

export interface WaitOptions {
  threshold: number;
  /** which number the threshold applies to: rmse (whole region moved) or peak (any one cell moved) */
  metric: Metric;
  intervalMs: number;
  timeoutMs: number;
}

const pick = (d: Diff, m: Metric) => (m === "peak" ? d.peak : d.rmse);
const show = (d: Diff) => ({ rmse: round(d.rmse), peak: round(d.peak) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Sensor {
  private regions = new Map<string, Region>();
  private last = new Map<string, { grid: Grid; at: number }>();

  constructor(private readonly capture: CaptureOptions) {}

  define(r: Region): Region {
    if (!(r.w > 0 && r.h > 0)) throw new Error("region needs positive width and height");
    this.regions.set(r.name, r);
    this.last.delete(r.name);
    return r;
  }

  /** Add a mask given in global coordinates (as a selector returns them). */
  addMask(name: string, global: Rect): Region {
    const r = this.get(name);
    const local = { x: global.x - r.x, y: global.y - r.y, w: global.w, h: global.h };
    if (local.x + local.w <= 0 || local.y + local.h <= 0 || local.x >= r.w || local.y >= r.h) {
      throw new Error(`mask ${JSON.stringify(global)} does not overlap region "${name}"`);
    }
    r.masks.push(local);
    this.last.delete(name); // grid contents change with masks; old samples are not comparable
    return r;
  }

  remove(name: string): boolean {
    this.last.delete(name);
    return this.regions.delete(name);
  }

  list(): Region[] {
    return [...this.regions.values()];
  }

  get(name: string): Region {
    const r = this.regions.get(name);
    if (!r) throw new Error(`unknown region "${name}"; define it first or check pir_list_regions`);
    return r;
  }

  private async grab(r: Region): Promise<Grid> {
    return captureGrid(r, r.masks, this.capture);
  }

  /** One capture; score against the previous sample of this region, if any. */
  async sample(name: string) {
    const r = this.get(name);
    const grid = await this.grab(r);
    const prev = this.last.get(name);
    const now = Date.now();
    this.last.set(name, { grid, at: now });
    return {
      region: name,
      captured_at: new Date(now).toISOString(),
      size: { width: grid.width, height: grid.height, cells: `${grid.gw}x${grid.gh}` },
      vs_previous: prev ? show(diff(prev.grid, grid)) : null,
      previous_age_ms: prev ? now - prev.at : null,
    };
  }

  /** Block until the region departs from how it looked when the call began. */
  async waitForChange(name: string, o: WaitOptions) {
    const r = this.get(name);
    const start = Date.now();
    const baseline = await this.grab(r);
    let prev = baseline;
    let samples = 1;
    let max: Diff = { rmse: 0, peak: 0 };
    for (;;) {
      const elapsed = Date.now() - start;
      if (elapsed >= o.timeoutMs) {
        this.last.set(name, { grid: prev, at: Date.now() });
        return { region: name, changed: false, metric: o.metric, elapsed_ms: elapsed, samples, max_vs_baseline: show(max) };
      }
      await sleep(Math.min(o.intervalMs, o.timeoutMs - elapsed));
      const grid = await this.grab(r);
      samples++;
      const vsBase = diff(baseline, grid);
      const vsPrev = diff(prev, grid);
      max = { rmse: Math.max(max.rmse, vsBase.rmse), peak: Math.max(max.peak, vsBase.peak) };
      prev = grid;
      if (pick(vsBase, o.metric) >= o.threshold) {
        this.last.set(name, { grid, at: Date.now() });
        return {
          region: name,
          changed: true,
          metric: o.metric,
          elapsed_ms: Date.now() - start,
          samples,
          vs_baseline: show(vsBase),
          vs_previous: show(vsPrev),
        };
      }
    }
  }

  /**
   * Block until consecutive samples have stayed below threshold for
   * `stillForMs`. Small stillness windows mean "the animation settled"; a
   * window of minutes on something that should tick (a clock, a progress
   * bar) means it is frozen.
   */
  async waitForStillness(name: string, stillForMs: number, o: WaitOptions) {
    const r = this.get(name);
    const start = Date.now();
    let prev = await this.grab(r);
    let stillSince = Date.now();
    let samples = 1;
    let last: Diff = { rmse: 0, peak: 0 };
    for (;;) {
      const now = Date.now();
      if (now - stillSince >= stillForMs) {
        this.last.set(name, { grid: prev, at: now });
        return {
          region: name,
          still: true,
          metric: o.metric,
          still_for_ms: now - stillSince,
          elapsed_ms: now - start,
          samples,
          last: show(last),
        };
      }
      const elapsed = now - start;
      if (elapsed >= o.timeoutMs) {
        this.last.set(name, { grid: prev, at: now });
        return {
          region: name,
          still: false,
          metric: o.metric,
          current_still_ms: now - stillSince,
          elapsed_ms: elapsed,
          samples,
          last: show(last),
        };
      }
      await sleep(Math.min(o.intervalMs, o.timeoutMs - elapsed));
      const grid = await this.grab(r);
      samples++;
      last = diff(prev, grid);
      if (pick(last, o.metric) >= o.threshold) stillSince = Date.now();
      prev = grid;
    }
  }
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
