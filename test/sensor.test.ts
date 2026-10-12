import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStack } from "../src/capture.js";
import { coveredFraction, cropRgb } from "../src/frame.js";
import { occlusionOf, Sensor, type OnOcclusion } from "../src/sensor.js";

/**
 * A fake desktop: one window whose contents, geometry and place in the stack
 * are files the test rewrites while the sensor polls them with `cat`.
 */
function desk(own: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "pir-test-"));
  const put = (name: string, data: string | Uint8Array) => {
    writeFileSync(join(dir, `${name}.tmp`), data);
    renameSync(join(dir, `${name}.tmp`), join(dir, name));
  };
  const paint = (fill: (x: number, y: number) => number) => {
    const w = 100;
    const h = 50;
    const body = Buffer.alloc(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) body.fill(fill(x, y), (y * w + x) * 3, (y * w + x) * 3 + 3);
    const ppm = Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), body]);
    put("window.ppm", ppm);
    put("screen.ppm", ppm);
  };
  const place = (x: number, y: number) => put("geo.txt", `${x},${y} 100x50 w1\n`);
  const stack = (lines: string[]) => put("stack.txt", lines.join("\n") + "\n");
  paint(() => 0);
  place(10, 10);
  stack(["w1 10,10 100x50"]);
  const sensor = new Sensor({
    command: `cat ${dir}/screen.ppm`,
    timeoutMs: 2000,
    maxCells: 64,
    windowGeometryCommand: `cat ${dir}/geo.txt # {id}`,
    windowCaptureCommand: own ? `cat ${dir}/window.ppm # {id}` : "",
    stackCommand: `cat ${dir}/stack.txt`,
  });
  return { sensor, paint, place, stack, put, geoCmd: `cat ${dir}/geo.txt # {id}`, stackCmd: `cat ${dir}/stack.txt` };
}

const opts = (onOcclusion: OnOcclusion, timeoutMs = 600) => ({
  threshold: 0.05,
  metric: "rmse" as const,
  intervalMs: 20,
  timeoutMs,
  onOcclusion,
});
const after = (ms: number, fn: () => void) => setTimeout(fn, ms);

test("crop cuts the right pixels", () => {
  const rgb = new Uint8Array(4 * 2 * 3).map((_, i) => i);
  const c = cropRgb(4, 2, rgb, { x: 1, y: 1, w: 2, h: 1 });
  assert.deepEqual([c.width, c.height], [2, 1]);
  assert.deepEqual([...c.rgb], [15, 16, 17, 18, 19, 20]);
  assert.throws(() => cropRgb(4, 2, rgb, { x: 9, y: 0, w: 2, h: 1 }), /outside/);
});

test("covered fraction and stack parsing", () => {
  assert.equal(coveredFraction({ x: 0, y: 0, w: 100, h: 100 }, [{ x: 0, y: 0, w: 50, h: 100 }]), 0.5);
  assert.equal(coveredFraction({ x: 0, y: 0, w: 10, h: 10 }, []), 0);
  const s = parseStack("a 0,0 1920x1080\nb -2554,32 2548x1402\n\ngarbage\n");
  assert.deepEqual(s.map((e) => e.id), ["a", "b"]);
  assert.equal(s[1]!.x, -2554);
});

test("occlusion: only windows above count, and own capture makes covering harmless", () => {
  const r = { x: 0, y: 0, w: 100, h: 100 };
  const stack = parseStack("top 50,0 100x100\nme 0,0 100x100\nbelow 0,0 100x100");
  assert.deepEqual(occlusionOf("me", r, stack, false), { state: "covered", covered_fraction: 0.5, affects_score: true });
  assert.equal(occlusionOf("me", r, stack, true).affects_score, false);
  assert.equal(occlusionOf("top", r, stack, false).state, "visible");
  assert.equal(occlusionOf("gone", r, stack, true).state, "hidden");
  assert.equal(occlusionOf("gone", r, stack, true).affects_score, false);
  assert.equal(occlusionOf("gone", r, stack, false).affects_score, true);
});

test("anchored region ignores the rest of the window, sees its own part", async () => {
  const d = desk(true);
  await d.sensor.defineWindow("vc", "w1", [], { x: 0, y: 0, w: 50, h: 50 });
  after(100, () => d.paint((x) => (x >= 50 ? 255 : 0)));
  const outside = await d.sensor.waitForChange("vc", opts("report", 400));
  assert.equal(outside.changed, false);
  after(100, () => d.paint(() => 255));
  const inside = await d.sensor.waitForChange("vc", opts("report"));
  assert.equal(inside.changed, true);
});

test("moving the window is not a change when capturing the window itself", async () => {
  const d = desk(true);
  await d.sensor.defineWindow("w", "w1");
  after(100, () => {
    d.place(500, 300);
    d.stack(["w1 500,300 100x50"]);
  });
  const r = await d.sensor.waitForChange("w", opts("report", 400));
  assert.equal(r.changed, false);
  assert.deepEqual(d.sensor.get("w").x, 500);
});

test("covered while cut from the screen: report returns occluded at once", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("w", "w1");
  after(100, () => d.stack(["other 0,0 200x200", "w1 10,10 100x50"]));
  const r = await d.sensor.waitForChange("w", opts("report", 2000));
  assert.equal(r.changed, false);
  assert.equal("occluded" in r && r.occluded, true);
  assert.ok(r.elapsed_ms < 1000);
});

test("covered under own capture is not occlusion that matters", async () => {
  const d = desk(true);
  await d.sensor.defineWindow("w", "w1");
  d.stack(["other 0,0 200x200", "w1 10,10 100x50"]);
  const r = await d.sensor.waitForChange("w", opts("report", 300));
  assert.equal("occluded" in r, false);
  assert.equal(r.occlusion?.state, "covered");
});

test("pause: a change made while hidden counts once it reappears", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("w", "w1");
  after(80, () => d.stack(["other 0,0 200x200", "w1 10,10 100x50"]));
  after(160, () => d.paint(() => 255));
  after(300, () => d.stack(["w1 10,10 100x50"]));
  const r = await d.sensor.waitForChange("w", opts("pause", 2000));
  assert.equal(r.changed, true);
  assert.ok("occluded_ms" in r && r.occluded_ms > 0);
});

test("pause_rebaseline: a change made while hidden is forgotten", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("w", "w1");
  after(80, () => d.stack(["other 0,0 200x200", "w1 10,10 100x50"]));
  after(160, () => d.paint(() => 255));
  after(300, () => d.stack(["w1 10,10 100x50"]));
  const r = await d.sensor.waitForChange("w", opts("pause_rebaseline", 700));
  assert.equal(r.changed, false);
});

test("count: being covered is itself the change", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("w", "w1");
  after(100, () => {
    d.stack(["other 0,0 200x200", "w1 10,10 100x50"]);
    d.paint(() => 255); // what the screen shows at that spot is now the other window
  });
  const r = await d.sensor.waitForChange("w", opts("count", 2000));
  assert.equal(r.changed, true);
});

test("stillness never counts occluded time as still", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("w", "w1");
  d.stack(["other 0,0 200x200", "w1 10,10 100x50"]);
  after(400, () => d.stack(["w1 10,10 100x50"]));
  const r = await d.sensor.waitForStillness("w", 200, opts("pause", 2000));
  assert.equal(r.still, true);
  assert.ok(r.elapsed_ms >= 550, `went still after ${r.elapsed_ms}ms`);
});

test("hidden window reports hidden", async () => {
  const d = desk(true);
  await d.sensor.defineWindow("w", "w1");
  d.stack(["somethingelse 0,0 10x10"]);
  const s = await d.sensor.sample("w");
  assert.equal(s.occlusion?.state, "hidden");
});

test("follow_window clips a selection to the window without widening it", async () => {
  const d = desk(true);
  // window at 10,10 100x50; selection starts 20px left of it
  const r = await d.sensor.defineAnchored("a", { x: -10, y: 20, w: 50, h: 10 });
  assert.deepEqual(r.anchor, { x: 0, y: 10, w: 30, h: 10 });
  await assert.rejects(d.sensor.defineAnchored("b", { x: 500, y: 500, w: 5, h: 5 }), /no visible window/);
});

test("a region saved by another id form learns the canonical one on first capture", async () => {
  const d = desk(false);
  d.sensor.define({ name: "saved", x: 10, y: 10, w: 100, h: 50, masks: [], window: "0xaddress" });
  const s = await d.sensor.sample("saved");
  assert.equal(d.sensor.get("saved").window, "w1");
  assert.equal(s.occlusion?.state, "visible");
});

test("an anchor is re-clipped when the window shrinks, and that scores as a resize", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("a", "w1", [], { x: 80, y: 0, w: 20, h: 50 });
  d.place(10, 10);
  await d.sensor.sample("a");
  d.put("geo.txt", "10,10 90x50 w1\n");
  await d.sensor.sample("a");
  assert.equal(d.sensor.get("a").w, 10);
  d.put("geo.txt", "10,10 70x50 w1\n");
  await assert.rejects(d.sensor.sample("a"), /shrank past the anchor/);
});

test("count never turns a failed capture into a change", async () => {
  const d = desk(true);
  await d.sensor.defineWindow("w", "w1");
  d.stack(["somethingelse 0,0 10x10"]); // hidden...
  d.put("window.ppm", "not a ppm"); // ...and its capture fails
  const s = new Sensor({
    command: "false",
    timeoutMs: 2000,
    maxCells: 64,
    windowGeometryCommand: d.geoCmd,
    windowCaptureCommand: "", // cut from the screen, so hidden affects the score
    stackCommand: d.stackCmd,
  });
  await s.defineWindow("w", "w1");
  const r = await s.waitForChange("w", opts("count", 300));
  assert.equal(r.changed, false);
});

test("occluded_ms is wall clock, captures included", async () => {
  const d = desk(false);
  await d.sensor.defineWindow("w", "w1");
  d.stack(["other 0,0 200x200", "w1 10,10 100x50"]);
  const r = await d.sensor.waitForChange("w", opts("pause", 400));
  assert.ok("occluded_ms" in r && r.occluded_ms >= 350, `occluded_ms ${"occluded_ms" in r ? r.occluded_ms : "?"}`);
});
