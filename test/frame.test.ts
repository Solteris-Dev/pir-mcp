import { test } from "node:test";
import assert from "node:assert/strict";
import { diff, parsePpm, rmse, toGrid } from "../src/frame.js";
import { parseSelection, renderCommand, renderWindowCommand } from "../src/capture.js";

function ppm(width: number, height: number, fill: (x: number, y: number) => [number, number, number]): Uint8Array {
  const header = Buffer.from(`P6\n# a comment\n${width} ${height}\n255\n`, "ascii");
  const body = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fill(x, y);
      body.set([r, g, b], (y * width + x) * 3);
    }
  return Buffer.concat([header, body]);
}

test("parses P6 with comments", () => {
  const p = parsePpm(ppm(4, 2, () => [1, 2, 3]));
  assert.equal(p.width, 4);
  assert.equal(p.height, 2);
  assert.equal(p.rgb.length, 24);
  assert.deepEqual([...p.rgb.subarray(0, 3)], [1, 2, 3]);
});

test("rejects non-P6", () => {
  assert.throws(() => parsePpm(Buffer.from("P3\n1 1\n255\n0 0 0")), /P6/);
});

test("identical frames score 0, black vs white scores 1", () => {
  const black = parsePpm(ppm(100, 40, () => [0, 0, 0]));
  const white = parsePpm(ppm(100, 40, () => [255, 255, 255]));
  const gb = toGrid(black.width, black.height, black.rgb);
  const gb2 = toGrid(black.width, black.height, black.rgb);
  const gw = toGrid(white.width, white.height, white.rgb);
  assert.equal(rmse(gb, gb2), 0);
  assert.ok(Math.abs(rmse(gb, gw) - 1) < 1e-6);
  assert.equal(gb.gw, 25);
  assert.equal(gb.gh, 10);
});

test("a small change scores small, a big change scores big", () => {
  const base = parsePpm(ppm(200, 50, () => [40, 40, 40]));
  const caret = parsePpm(ppm(200, 50, (x, y) => (x < 2 && y < 12 ? [255, 255, 255] : [40, 40, 40])));
  const half = parsePpm(ppm(200, 50, (x) => (x < 100 ? [255, 255, 255] : [40, 40, 40])));
  const g = (p: ReturnType<typeof parsePpm>) => toGrid(p.width, p.height, p.rgb);
  const small = rmse(g(base), g(caret));
  const big = rmse(g(base), g(half));
  assert.ok(small < 0.03, `caret scored ${small}`);
  assert.ok(big > 0.4, `half-screen scored ${big}`);
});

test("masked cells never contribute", () => {
  const base = parsePpm(ppm(200, 50, () => [0, 0, 0]));
  const clock = parsePpm(ppm(200, 50, (x) => (x >= 150 ? [255, 255, 255] : [0, 0, 0])));
  const mask = [{ x: 150, y: 0, w: 50, h: 50 }];
  const a = toGrid(base.width, base.height, base.rgb, 64, mask);
  const b = toGrid(clock.width, clock.height, clock.rgb, 64, mask);
  assert.equal(rmse(a, b), 0);
  const unmasked = rmse(toGrid(base.width, base.height, base.rgb), toGrid(clock.width, clock.height, clock.rgb));
  assert.ok(unmasked > 0.4);
});

test("peak catches a local change that rmse averages away", () => {
  const base = parsePpm(ppm(1920, 26, () => [30, 30, 30]));
  const digit = parsePpm(ppm(1920, 26, (x, y) => (x >= 1700 && x < 1708 && y >= 6 && y < 20 ? [255, 255, 255] : [30, 30, 30])));
  const d = diff(toGrid(base.width, base.height, base.rgb), toGrid(digit.width, digit.height, digit.rgb));
  assert.ok(d.rmse < 0.02, `rmse ${d.rmse}`);
  assert.ok(d.peak > 0.05, `peak ${d.peak}`);
});

test("grid size mismatch is an error, not a silent wrong score", () => {
  const a = toGrid(100, 40, new Uint8Array(100 * 40 * 3));
  const b = toGrid(100, 20, new Uint8Array(100 * 20 * 3));
  assert.throws(() => rmse(a, b), /grid size changed/);
});

test("command template substitution", () => {
  assert.equal(
    renderCommand('grim -g "{x},{y} {w}x{h}" -t ppm -', { x: -2560, y: 0, w: 2560, h: 26 }),
    'grim -g "-2560,0 2560x26" -t ppm -',
  );
});

test("selector output parsing", () => {
  assert.deepEqual(parseSelection("-2560,0 2560x26\n"), { x: -2560, y: 0, w: 2560, h: 26 });
  assert.throws(() => parseSelection("selection cancelled"), /expected/);
  assert.throws(() => parseSelection("1,1 0x0"), /no area/);
});

test("window ids are validated before touching a shell", () => {
  assert.equal(renderWindowCommand("geom {id}", "0x564d21946290"), "geom 0x564d21946290");
  assert.throws(() => renderWindowCommand("geom {id}", "0x1; rm -rf ~"), /refusing/);
  assert.throws(() => renderWindowCommand("geom {id}", "$(id)"), /refusing/);
});
