/**
 * Frames and scoring. A frame is only ever a coarse grid of averaged colour
 * cells, built straight from the capture bytes and thrown away after scoring.
 * Nothing here can reproduce an image: 64 cells across is enough to tell "the
 * scene changed" from "the clock ticked", and not enough to read anything.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Grid {
  /** cells across / down */
  gw: number;
  gh: number;
  /** source pixel size, for reporting only */
  width: number;
  height: number;
  /** gw*gh*3 channel means in [0,1] */
  cells: Float32Array;
}

/** Parse a binary PPM (P6, maxval 255) into raw RGB bytes. */
export function parsePpm(buf: Uint8Array): { width: number; height: number; rgb: Uint8Array } {
  let pos = 0;
  const tokens: string[] = [];
  // Header: magic, width, height, maxval — whitespace separated, '#' comments allowed.
  while (tokens.length < 4) {
    if (pos >= buf.length) throw new Error("PPM header truncated");
    const c = buf[pos]!;
    if (c === 0x23 /* # */) {
      while (pos < buf.length && buf[pos] !== 0x0a) pos++;
      continue;
    }
    if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) {
      pos++;
      continue;
    }
    let end = pos;
    while (end < buf.length && ![0x20, 0x0a, 0x0d, 0x09].includes(buf[end]!)) end++;
    tokens.push(Buffer.from(buf.subarray(pos, end)).toString("ascii"));
    pos = end;
  }
  pos++; // exactly one whitespace byte after maxval
  const [magic, ws, hs, maxs] = tokens;
  if (magic !== "P6") throw new Error(`expected binary PPM (P6), got ${magic}`);
  const width = Number(ws);
  const height = Number(hs);
  const maxval = Number(maxs);
  if (!(width > 0 && height > 0)) throw new Error(`bad PPM size ${ws}x${hs}`);
  if (maxval !== 255) throw new Error(`only 8-bit PPM supported (maxval ${maxval})`);
  const need = width * height * 3;
  if (buf.length - pos < need) throw new Error(`PPM body truncated: ${buf.length - pos} < ${need}`);
  return { width, height, rgb: buf.subarray(pos, pos + need) };
}

/**
 * Box-average RGB into a grid no wider than `maxCells` on its long side.
 * `masks` are rects in the frame's own pixel coordinates; a cell whose centre
 * falls inside any mask is zeroed on both sides of every comparison, so it can
 * never contribute (a clock, a spinner, a blinking caret).
 */
export function toGrid(
  width: number,
  height: number,
  rgb: Uint8Array,
  maxCells = 64,
  masks: Rect[] = [],
): Grid {
  const long = Math.max(width, height);
  // Cells are at least 4px square so a 1-2px caret or cursor edge is averaged
  // away even in a small region, and at most `maxCells` across.
  const scale = Math.max(4, long / maxCells);
  const gw = Math.max(1, Math.round(width / scale));
  const gh = Math.max(1, Math.round(height / scale));
  const cells = new Float32Array(gw * gh * 3);
  const counts = new Uint32Array(gw * gh);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(gh - 1, Math.floor((y * gh) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(gw - 1, Math.floor((x * gw) / width));
      const ci = gy * gw + gx;
      const pi = (y * width + x) * 3;
      cells[ci * 3] = cells[ci * 3]! + rgb[pi]!;
      cells[ci * 3 + 1] = cells[ci * 3 + 1]! + rgb[pi + 1]!;
      cells[ci * 3 + 2] = cells[ci * 3 + 2]! + rgb[pi + 2]!;
      counts[ci] = counts[ci]! + 1;
    }
  }
  for (let ci = 0; ci < gw * gh; ci++) {
    const n = counts[ci]! * 255;
    if (n === 0) continue;
    cells[ci * 3] = cells[ci * 3]! / n;
    cells[ci * 3 + 1] = cells[ci * 3 + 1]! / n;
    cells[ci * 3 + 2] = cells[ci * 3 + 2]! / n;
  }
  for (const m of masks) {
    for (let gy = 0; gy < gh; gy++) {
      const cy = ((gy + 0.5) * height) / gh;
      if (cy < m.y || cy >= m.y + m.h) continue;
      for (let gx = 0; gx < gw; gx++) {
        const cx = ((gx + 0.5) * width) / gw;
        if (cx < m.x || cx >= m.x + m.w) continue;
        const ci = (gy * gw + gx) * 3;
        cells[ci] = cells[ci + 1] = cells[ci + 2] = 0;
      }
    }
  }
  return { gw, gh, width, height, cells };
}

export interface Diff {
  /** root-mean-square difference over all cells: 0 identical, 1 black vs white. Global motion. */
  rmse: number;
  /** the single most-changed cell's RMS difference. Local motion: a digit flipping, a cursor. */
  peak: number;
}

/** Compare two grids of the same shape. */
export function diff(a: Grid, b: Grid): Diff {
  if (a.gw !== b.gw || a.gh !== b.gh) {
    throw new Error(`grid size changed (${a.gw}x${a.gh} -> ${b.gw}x${b.gh}); did the capture geometry change?`);
  }
  let sum = 0;
  let peak = 0;
  const cells = a.gw * a.gh;
  for (let c = 0; c < cells; c++) {
    let cell = 0;
    for (let k = 0; k < 3; k++) {
      const d = a.cells[c * 3 + k]! - b.cells[c * 3 + k]!;
      cell += d * d;
    }
    sum += cell;
    if (cell > peak) peak = cell;
  }
  return { rmse: Math.sqrt(sum / (cells * 3)), peak: Math.sqrt(peak / 3) };
}

/** Root-mean-square difference over all cells, 0 (identical) to 1 (black vs white). */
export function rmse(a: Grid, b: Grid): number {
  return diff(a, b).rmse;
}
