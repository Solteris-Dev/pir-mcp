/**
 * Capture is delegated to whatever the user already trusts to grab their
 * screen. The command is a template with {x} {y} {w} {h} substituted, run via
 * `sh -c`, and must write a binary PPM (P6) to stdout. The default is grim
 * (wlroots/Hyprland/Sway). See README for X11 and macOS equivalents.
 */
import { spawn } from "node:child_process";
import { cropRgb, parsePpm, toGrid, type Grid, type Rect } from "./frame.js";

export const DEFAULT_CAPTURE_CMD = 'grim -g "{x},{y} {w}x{h}" -t ppm -';
/** Interactive rectangle selection; must print `x,y wxh` (slurp's default format) to stdout. */
export const DEFAULT_SELECT_CMD = 'slurp -f "%x,%y %wx%h"';
/**
 * Window geometry lookup: {id} is substituted, output is `x,y wxh`, optionally
 * followed by the window's canonical id (what the capture and stack commands
 * use) when {id} may be given in another form. A region
 * defined on a window re-resolves this before every capture, so it follows
 * the window when it moves or resizes. Default is Hyprland via jq, matching
 * either the window's stableId or its address.
 */
export const DEFAULT_WINDOW_GEOMETRY_CMD =
  "hyprctl -j clients | jq -r --arg id \"{id}\" '.[] | select(.stableId==$id or .address==$id) | \"\\(.at[0]),\\(.at[1]) \\(.size[0])x\\(.size[1]) \\(.stableId)\"'";
/**
 * Interactive window pick: prints the window id. Default offers every mapped
 * window on the currently visible workspaces as a slurp box and prints the
 * chosen one's stableId (the id grim -T understands).
 */
export const DEFAULT_PICK_WINDOW_CMD =
  "hyprctl -j clients | jq -r --argjson a \"$(hyprctl -j monitors | jq -c '[.[].activeWorkspace.id]')\" " +
  "'.[] | select(.mapped and (.workspace.id as $w | $a | index($w))) | " +
  "\"\\(.at[0]),\\(.at[1]) \\(.size[0])x\\(.size[1]) \\(.stableId)\"' | slurp -r -f '%l'";
/**
 * Capture one window's own contents, {id} substituted, as a binary PPM. Not
 * what is on screen at its position: a window that is moved or covered
 * still captures as itself. grim -T needs a compositor with
 * ext-image-copy-capture (Hyprland has it) and takes the stableId.
 */
export const DEFAULT_WINDOW_CAPTURE_CMD = "grim -T {id} -t ppm -";
/**
 * Visible windows, topmost first, one per line: `id x,y wxh`. Used to tell
 * whether a watched window is covered or on a workspace nobody can see.
 * Hyprland does not expose z-order, so the default approximates it: pinned,
 * special workspace, fullscreen, floating, tiled, each by focus recency. A
 * floating window allowed above a fullscreen one is reported under it.
 */
export const DEFAULT_STACK_CMD =
  "hyprctl -j clients | jq -r --argjson m \"$(hyprctl -j monitors)\" " +
  "'([$m[].activeWorkspace.id]) as $act | ([$m[].specialWorkspace.id | select(. != 0)]) as $sp | " +
  "map(select(.mapped and (.hidden | not) and ((.workspace.id | IN($act[], $sp[])) or .pinned))) | " +
  "sort_by([(if .pinned then 0 else 1 end), (if (.workspace.id | IN($sp[])) then 0 else 1 end), (if .fullscreen > 0 then 0 else 1 end), " +
  "(if .floating then 0 else 1 end), .focusHistoryID]) | " +
  ".[] | \"\\(.stableId) \\(.at[0]),\\(.at[1]) \\(.size[0])x\\(.size[1])\"'";

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

/** Window ids go into a shell template, so only plain identifier characters are accepted. */
export function renderWindowCommand(template: string, id: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(id)) throw new Error(`refusing window id "${id}"`);
  return template.replaceAll("{id}", id);
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

/** Where is window `id` right now, and what does it call itself? */
export async function windowGeometry(command: string, id: string, timeoutMs: number): Promise<Rect & { id: string }> {
  const out = await runCapture(renderWindowCommand(command, id), timeoutMs);
  const text = Buffer.from(out).toString("utf8");
  if (!text.trim()) throw new Error(`window "${id}" not found (is it still open?)`);
  const canonical = /\d+x\d+\s+(\S+)/.exec(text)?.[1];
  return { ...parseSelection(text), id: canonical ?? id };
}

/** Ask the person to pick a window; returns its id as the pick command prints it. */
export async function pickWindow(command: string, timeoutMs: number): Promise<string> {
  let out: Uint8Array;
  try {
    out = await runCapture(command, timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`window pick cancelled or failed: ${msg}`);
  }
  const id = Buffer.from(out).toString("utf8").trim().split(/\s+/).pop() ?? "";
  if (!id) throw new Error("window pick printed nothing");
  return id;
}

/** Grab one region and reduce it to a grid. The raw bytes never leave this function. */
export async function captureGrid(r: Rect, masks: Rect[], opts: CaptureOptions): Promise<Grid> {
  const raw = await runCapture(renderCommand(opts.command, r), opts.timeoutMs);
  const { width, height, rgb } = parsePpm(raw);
  return toGrid(width, height, rgb, opts.maxCells, masks);
}

/**
 * Capture a whole window by id and reduce `anchor` (window-local, logical
 * pixels) to a grid. `logical` is the window's size as the geometry command
 * reports it; a capture at a different pixel size (output scaling) has the
 * anchor scaled to match.
 */
export async function captureWindowGrid(
  command: string,
  id: string,
  logical: { w: number; h: number },
  anchor: Rect,
  masks: Rect[],
  opts: CaptureOptions,
): Promise<Grid> {
  const raw = await runCapture(renderWindowCommand(command, id), opts.timeoutMs);
  const frame = parsePpm(raw);
  const sx = frame.width / logical.w;
  const sy = frame.height / logical.h;
  const cut = cropRgb(frame.width, frame.height, frame.rgb, {
    x: anchor.x * sx,
    y: anchor.y * sy,
    w: anchor.w * sx,
    h: anchor.h * sy,
  });
  const scaled = masks.map((m) => ({ x: m.x * sx, y: m.y * sy, w: m.w * sx, h: m.h * sy }));
  return toGrid(cut.width, cut.height, cut.rgb, opts.maxCells, scaled);
}

export interface StackEntry extends Rect {
  id: string;
}

/** Parse the stack command's `id x,y wxh` lines, topmost first. */
export function parseStack(out: string): StackEntry[] {
  const entries: StackEntry[] = [];
  for (const line of out.split("\n")) {
    const m = /^\s*(\S+)\s+(-?\d+),(-?\d+)\s+(\d+)x(\d+)/.exec(line);
    if (m) entries.push({ id: m[1]!, x: Number(m[2]), y: Number(m[3]), w: Number(m[4]), h: Number(m[5]) });
  }
  return entries;
}

export async function windowStack(command: string, timeoutMs: number): Promise<StackEntry[]> {
  return parseStack(Buffer.from(await runCapture(command, timeoutMs)).toString("utf8"));
}
