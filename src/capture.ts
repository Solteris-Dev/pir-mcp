/**
 * Capture is delegated to whatever the user already trusts to grab their
 * screen. The command is a template with {x} {y} {w} {h} substituted, run via
 * `sh -c`, and must write a binary PPM (P6) to stdout. The default is grim
 * (wlroots/Hyprland/Sway). See README for X11 and macOS equivalents.
 */
import { spawn } from "node:child_process";
import { parsePpm, toGrid, type Grid, type Rect } from "./frame.js";

export const DEFAULT_CAPTURE_CMD = 'grim -g "{x},{y} {w}x{h}" -t ppm -';
/** Interactive rectangle selection; must print `x,y wxh` (slurp's default format) to stdout. */
export const DEFAULT_SELECT_CMD = 'slurp -f "%x,%y %wx%h"';

export interface CaptureOptions {
  command: string;
  timeoutMs: number;
  maxCells: number;
}

export function renderCommand(template: string, r: Rect): string {
  const n = (v: number) => String(Math.round(v));
  return template
    .replaceAll("{x}", n(r.x))
    .replaceAll("{y}", n(r.y))
    .replaceAll("{w}", n(r.w))
    .replaceAll("{h}", n(r.h));
}

function runCapture(cmd: string, timeoutMs: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const child = spawn("sh", ["-c", cmd], { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`capture timed out after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);
    child.stdout.on("data", (c: Buffer) => chunks.push(c));
    child.stderr.on("data", (c: Buffer) => (err += c.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`capture exited ${code}: ${err.trim() || cmd}`));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
}

/** Parse `x,y wxh` (slurp / slop -f "%x,%y %wx%h"). */
export function parseSelection(out: string): Rect {
  const m = /(-?\d+),(-?\d+)\s+(\d+)x(\d+)/.exec(out);
  if (!m) throw new Error(`selector printed "${out.trim()}", expected "x,y wxh"`);
  const r = { x: Number(m[1]), y: Number(m[2]), w: Number(m[3]), h: Number(m[4]) };
  if (!(r.w > 0 && r.h > 0)) throw new Error("selection has no area");
  return r;
}

/**
 * Ask the person at the screen to draw a rectangle. The selector runs with
 * their privileges on their display; the agent only ever sees the geometry.
 * A cancelled selection (Escape) is an error, not an empty region.
 */
export async function selectRect(command: string, timeoutMs: number): Promise<Rect> {
  let out: Uint8Array;
  try {
    out = await runCapture(command, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`selection cancelled or failed: ${msg}`);
  }
  return parseSelection(Buffer.from(out).toString("utf8"));
}

/** Grab one region and reduce it to a grid. The raw bytes never leave this function. */
export async function captureGrid(r: Rect, masks: Rect[], opts: CaptureOptions): Promise<Grid> {
  const raw = await runCapture(renderCommand(opts.command, r), opts.timeoutMs);
  const { width, height, rgb } = parsePpm(raw);
  return toGrid(width, height, rgb, opts.maxCells, masks);
}
