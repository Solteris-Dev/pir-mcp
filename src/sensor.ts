/**
 * The sensor proper: named regions, and the three questions an agent asks of
 * them. State per region is one grid (the last sample) — never an image.
 */
import {
  captureGrid,
  captureWindowGrid,
  windowGeometry,
  windowStack,
  type CaptureOptions,
  type StackEntry,
} from "./capture.js";
import { coveredFraction, diff, type Diff, type Grid, type Rect } from "./frame.js";

export interface Region extends Rect {
  name: string;
  /** rects to ignore, in region-local pixel coordinates */
  masks: Rect[];
  /** if set, x/y/w/h are re-resolved from this window before every capture */
  window?: string;
  /** with `window`: the watched part of it, window-local. Absent means the whole window. */
  anchor?: Rect;
}

export interface SensorOptions extends CaptureOptions {
  /** template with {id}; empty disables window regions */
  windowGeometryCommand: string;
  /** template with {id} capturing one window's own contents; empty means window regions are cut from the screen */
  windowCaptureCommand: string;
  /** lists visible windows topmost first; empty disables occlusion reporting */
  stackCommand: string;
}

export type Metric = "rmse" | "peak";

/**
 * What a blocking call does when the watched window is covered or hidden:
 * report — return at once with occluded=true (default);
 * pause — stop judging while occluded, then compare against the baseline from before;
 * pause_rebaseline — stop judging, then take a fresh baseline when it reappears;
 * count — judge anyway, so being covered counts as a change.
 */
export type OnOcclusion = "report" | "pause" | "pause_rebaseline" | "count";

export interface WaitOptions {
  threshold: number;
  /** which number the threshold applies to: rmse (whole region moved) or peak (any one cell moved) */
  metric: Metric;
  intervalMs: number;
  timeoutMs: number;
  onOcclusion: OnOcclusion;
}

export interface Occlusion {
  /** visible: nothing on top; covered: other windows overlap it; hidden: not on a visible workspace */
  state: "visible" | "covered" | "hidden";
  covered_fraction: number;
  /**
   * Whether the score is unreliable right now: covered or hidden while
   * capturing from the screen. A window captured as itself is judged even
   * when hidden, though a hidden app may stop repainting, so a hidden region
   * that stays still is weak evidence.
   */
  affects_score: boolean;
}

interface Shot {
  /** null when the capture failed while the window was occluded */
  grid: Grid | null;
  occlusion?: Occlusion;
}

const pick = (d: Diff, m: Metric) => (m === "peak" ? d.peak : d.rmse);
const show = (d: Diff) => ({ rmse: round(d.rmse), peak: round(d.peak) });

/** A grid of a different shape (the window resized) is, for our purposes, maximal change. */
const RESIZED: Diff = { rmse: 1, peak: 1 };
function cmp(a: Grid | null, b: Grid | null): Diff {
  if (!a || !b) return RESIZED;
  return a.gw === b.gw && a.gh === b.gh ? diff(a, b) : RESIZED;
}

/** Where `region` (global coordinates) of window `id` stands in the stack. */
export function occlusionOf(id: string, region: Rect, stack: StackEntry[], ownCapture: boolean): Occlusion {
  const at = stack.findIndex((e) => e.id === id);
  if (at < 0) return { state: "hidden", covered_fraction: 1, affects_score: !ownCapture };
  const f = coveredFraction(region, stack.slice(0, at));
  return {
    state: f > 0 ? "covered" : "visible",
    covered_fraction: round(f),
    affects_score: f > 0 && !ownCapture,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Sensor {
  private regions = new Map<string, Region>();
  private last = new Map<string, { grid: Grid; at: number }>();

  constructor(private readonly opts: SensorOptions) {}

  define(r: Region): Region {
    if (!(r.w > 0 && r.h > 0)) throw new Error("region needs positive width and height");
    if (r.anchor && !(r.anchor.w > 0 && r.anchor.h > 0)) throw new Error("anchor needs positive width and height");
    this.regions.set(r.name, r);
    this.last.delete(r.name);
    return r;
  }

  /**
   * A region pinned to a window: geometry is looked up now and again before
   * every capture. `anchor` (window-local) watches only that part of it.
   */
  async defineWindow(name: string, window: string, masks: Rect[] = [], anchor?: Rect): Promise<Region> {
    if (!this.opts.windowGeometryCommand) throw new Error("window regions are disabled (PIR_WINDOW_GEOMETRY_CMD is empty)");
    const g = await windowGeometry(this.opts.windowGeometryCommand, window, this.opts.timeoutMs);
    if (anchor && (anchor.x < 0 || anchor.y < 0 || anchor.x + anchor.w > g.w || anchor.y + anchor.h > g.h)) {
      throw new Error(`anchor ${JSON.stringify(anchor)} does not fit inside the ${g.w}x${g.h} window`);
    }
    const a = anchor ?? { x: 0, y: 0, w: g.w, h: g.h };
    return this.define({
      name,
      x: g.x + a.x,
      y: g.y + a.y,
      w: a.w,
      h: a.h,
      masks,
      window: g.id,
      ...(anchor ? { anchor } : {}),
    });
  }

  /**
   * Anchor a rectangle given in global coordinates (as a selector returns it)
   * to the topmost visible window containing its centre.
   */
  async defineAnchored(name: string, global: Rect): Promise<Region> {
    if (!this.opts.stackCommand) throw new Error("following a window needs PIR_STACK_CMD (it is empty)");
    const stack = await windowStack(this.opts.stackCommand, this.opts.timeoutMs);
    const cx = global.x + global.w / 2;
    const cy = global.y + global.h / 2;
    const w = stack.find((e) => cx >= e.x && cx < e.x + e.w && cy >= e.y && cy < e.y + e.h);
    if (!w) throw new Error("no visible window under the selection");
    // Intersect with the window: clipping may shrink what the person drew, never widen it.
    const anchor = intersect({ x: global.x - w.x, y: global.y - w.y, w: global.w, h: global.h }, w.w, w.h);
    if (!anchor) throw new Error("the selection does not overlap the window under it");
    return this.defineWindow(name, w.id, [], anchor);
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

  private async grab(r: Region): Promise<Shot> {
    if (!r.window) return { grid: await captureGrid(r, r.masks, this.opts) };
    const g = await windowGeometry(this.opts.windowGeometryCommand, r.window, this.opts.timeoutMs);
    r.window = g.id; // a region saved by address learns the id capture and stack use
    // An anchor is re-clipped to the window as it is now; a shrink changes the grid shape, which scores as a resize.
    const anchor = r.anchor ? intersect(r.anchor, g.w, g.h) : { x: 0, y: 0, w: g.w, h: g.h };
    if (!anchor) throw new Error(`window "${r.window}" shrank past the anchor of region "${r.name}"; redefine it`);
    Object.assign(r, { x: g.x + anchor.x, y: g.y + anchor.y, w: anchor.w, h: anchor.h }); // follow the window
    const own = Boolean(this.opts.windowCaptureCommand);
    // A failing stack command leaves occlusion unknown rather than failing the sample.
    const stack = this.opts.stackCommand
      ? await windowStack(this.opts.stackCommand, this.opts.timeoutMs).catch(() => null)
      : null;
    const occlusion = stack ? occlusionOf(r.window, r, stack, own) : undefined;
    try {
      const grid = own
        ? await captureWindowGrid(this.opts.windowCaptureCommand, r.window, g, anchor, r.masks, this.opts)
        : await captureGrid(r, r.masks, this.opts);
      return { grid, ...(occlusion ? { occlusion } : {}) };
    } catch (e) {
      if (occlusion?.affects_score) return { grid: null, occlusion };
      throw e;
    }
  }

  /** One capture; score against the previous sample of this region, if any. */
  async sample(name: string) {
    const r = this.get(name);
    const { grid, occlusion } = await this.grab(r);
    const prev = this.last.get(name);
    const now = Date.now();
    if (grid) this.last.set(name, { grid, at: now });
    return {
      region: name,
      captured_at: new Date(now).toISOString(),
      geometry: { x: r.x, y: r.y, w: r.w, h: r.h },
      size: grid ? { width: grid.width, height: grid.height, cells: `${grid.gw}x${grid.gh}` } : null,
      vs_previous: prev && grid ? show(cmp(prev.grid, grid)) : null,
      previous_age_ms: prev ? now - prev.at : null,
      ...(occlusion ? { occlusion } : {}),
    };
  }

  /** Block until the region departs from how it looked when the call began. */
  async waitForChange(name: string, o: WaitOptions) {
    const r = this.get(name);
    const start = Date.now();
    const pausing = o.onOcclusion === "pause" || o.onOcclusion === "pause_rebaseline";
    const judged = (s: Shot) => s.grid !== null && (!s.occlusion?.affects_score || o.onOcclusion === "count");
    let shot = await this.grab(r);
    let samples = 1;
    const occluded = () => ({
      region: name,
      changed: false,
      occluded: true,
      occlusion: shot.occlusion,
      metric: o.metric,
      elapsed_ms: Date.now() - start,
      samples,
    });
    if (!judged(shot) && o.onOcclusion === "report") return occluded();
    // Under pause, a call that starts occluded takes its baseline when the region first shows.
    let baseline = judged(shot) ? shot.grid : null;
    let prev = baseline;
    let prevAt = Date.now();
    let max: Diff = { rmse: 0, peak: 0 };
    // Occluded time is wall clock, captures included; occludedSince is set while occluded.
    let occludedMs = 0;
    let occludedSince: number | null = judged(shot) ? null : start;
    const extra = () => ({
      ...(shot.occlusion ? { occlusion: shot.occlusion } : {}),
      ...(pausing ? { occluded_ms: occludedMs + (occludedSince === null ? 0 : Date.now() - occludedSince) } : {}),
    });
    for (;;) {
      const elapsed = Date.now() - start;
      if (elapsed >= o.timeoutMs) {
        if (prev) this.last.set(name, { grid: prev, at: prevAt });
        return {
          region: name,
          changed: false,
          metric: o.metric,
          elapsed_ms: elapsed,
          samples,
          max_vs_baseline: show(max),
          ...extra(),
        };
      }
      const wait = Math.min(o.intervalMs, o.timeoutMs - elapsed);
      await sleep(wait);
      shot = await this.grab(r);
      samples++;
      if (!judged(shot)) {
        if (o.onOcclusion === "report") return occluded();
        occludedSince ??= Date.now();
        continue;
      }
      const reappeared = occludedSince !== null;
      if (reappeared) {
        occludedMs += Date.now() - occludedSince!;
        occludedSince = null;
      }
      if (reappeared && (o.onOcclusion === "pause_rebaseline" || !baseline)) {
        baseline = prev = shot.grid;
        prevAt = Date.now();
        continue;
      }
      const grid = shot.grid;
      const vsBase = cmp(baseline, grid);
      const vsPrev = cmp(prev, grid);
      max = { rmse: Math.max(max.rmse, vsBase.rmse), peak: Math.max(max.peak, vsBase.peak) };
      prev = grid;
      prevAt = Date.now();
      if (pick(vsBase, o.metric) >= o.threshold) {
        if (grid) this.last.set(name, { grid, at: Date.now() });
        return {
          region: name,
          changed: true,
          metric: o.metric,
          elapsed_ms: Date.now() - start,
          samples,
          vs_baseline: show(vsBase),
          vs_previous: show(vsPrev),
          ...extra(),
        };
      }
    }
  }

  /**
   * Block until consecutive samples have stayed below threshold for
   * `stillForMs`. Small stillness windows mean "the animation settled"; a
   * window of minutes on something that should tick (a clock, a progress
   * bar) means it is frozen. Time spent occluded under pause never counts
   * as still: nothing can be vouched for while it is covered.
   */
  async waitForStillness(name: string, stillForMs: number, o: WaitOptions) {
    const r = this.get(name);
    const start = Date.now();
    const pausing = o.onOcclusion === "pause" || o.onOcclusion === "pause_rebaseline";
    const judged = (s: Shot) => s.grid !== null && (!s.occlusion?.affects_score || o.onOcclusion === "count");
    let shot = await this.grab(r);
    let samples = 1;
    const occluded = () => ({
      region: name,
      still: false,
      occluded: true,
      occlusion: shot.occlusion,
      metric: o.metric,
      elapsed_ms: Date.now() - start,
      samples,
    });
    if (!judged(shot) && o.onOcclusion === "report") return occluded();
    let prev = judged(shot) ? shot.grid : null;
    let prevAt = Date.now();
    let stillSince = Date.now();
    let last: Diff = { rmse: 0, peak: 0 };
    let occludedMs = 0;
    let occludedSince: number | null = judged(shot) ? null : start;
    const extra = () => ({
      ...(shot.occlusion ? { occlusion: shot.occlusion } : {}),
      ...(pausing ? { occluded_ms: occludedMs + (occludedSince === null ? 0 : Date.now() - occludedSince) } : {}),
    });
    for (;;) {
      const now = Date.now();
      if (prev && now - stillSince >= stillForMs) {
        this.last.set(name, { grid: prev, at: now });
        return {
          region: name,
          still: true,
          metric: o.metric,
          still_for_ms: now - stillSince,
          elapsed_ms: now - start,
          samples,
          last: show(last),
          ...extra(),
        };
      }
      const elapsed = now - start;
      if (elapsed >= o.timeoutMs) {
        if (prev) this.last.set(name, { grid: prev, at: prevAt });
        return {
          region: name,
          still: false,
          metric: o.metric,
          current_still_ms: prev ? now - stillSince : 0,
          elapsed_ms: elapsed,
          samples,
          last: show(last),
          ...extra(),
        };
      }
      const wait = Math.min(o.intervalMs, o.timeoutMs - elapsed);
      await sleep(wait);
      shot = await this.grab(r);
      samples++;
      if (!judged(shot)) {
        if (o.onOcclusion === "report") return occluded();
        occludedSince ??= Date.now();
        prev = null;
        continue;
      }
      if (occludedSince !== null) {
        occludedMs += Date.now() - occludedSince;
        occludedSince = null;
      }
      if (!prev) {
        prev = shot.grid;
        prevAt = stillSince = Date.now();
        continue;
      }
      last = cmp(prev, shot.grid);
      if (pick(last, o.metric) >= o.threshold) stillSince = Date.now();
      prev = shot.grid;
      prevAt = Date.now();
    }
  }
}

/** `a` clipped to a `w` x `h` window, or null if nothing is left. */
function intersect(a: Rect, w: number, h: number): Rect | null {
  const x0 = Math.max(0, a.x);
  const y0 = Math.max(0, a.y);
  const x1 = Math.min(w, a.x + a.w);
  const y1 = Math.min(h, a.y + a.h);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : null;
}

function round(x: number): number {
  return Math.round(x * 10000) / 10000;
}
