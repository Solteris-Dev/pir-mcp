#!/usr/bin/env node
/**
 * stdio entrypoint. Configuration is by environment:
 *   PIR_CAPTURE_CMD     command template writing a binary PPM to stdout; {x} {y} {w} {h} are substituted.
 *                       default: grim -g "{x},{y} {w}x{h}" -t ppm -
 *   PIR_SELECT_CMD      interactive rectangle selector printing "x,y wxh"; default slurp -f "%x,%y %wx%h";
 *                       set to "" to disable the pick tools
 *   PIR_SELECT_TIMEOUT_MS  how long the person has to draw (60000)
 *   PIR_WINDOW_GEOMETRY_CMD  prints "x,y wxh" for window {id}; default is Hyprland via jq; "" disables window regions
 *   PIR_PICK_WINDOW_CMD      interactive window pick printing the window id; default Hyprland+slurp; "" disables
 *   PIR_REGIONS         optional JSON file: [{ "name", "x", "y", "w", "h", "masks": [...] }, ...]
 *   PIR_THRESHOLD       default change threshold (0.05)
 *   PIR_INTERVAL_MS     default sampling period (500)
 *   PIR_DEFAULT_WAIT_MS default timeout for blocking calls (55000)
 *   PIR_MAX_WAIT_MS     cap for blocking calls (540000); keep below the host's MCP tool timeout
 *   PIR_CAPTURE_TIMEOUT_MS  how long one capture may take (10000)
 *   PIR_MAX_CELLS       grid resolution on the long side (64); smaller = coarser and more private
 * stdout is the MCP transport; logging goes to stderr.
 */
import { readFileSync } from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import {
  DEFAULT_CAPTURE_CMD,
  DEFAULT_PICK_WINDOW_CMD,
  DEFAULT_SELECT_CMD,
  DEFAULT_WINDOW_GEOMETRY_CMD,
} from "./capture.js";
import { Sensor, type Region } from "./sensor.js";
import { createServer } from "./server.js";

function env(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined || v === "" ? def : v;
}

/** Like env(), but an explicitly empty value means "off". */
function envOrOff(name: string, def: string): string {
  const v = process.env[name];
  return v === undefined ? def : v;
}

function loadRegions(path: string | undefined): Region[] {
  if (!path) return [];
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(raw)) throw new Error(`${path}: expected a JSON array of regions`);
  return raw.map((r) => {
    const o = r as Partial<Region>;
    if (typeof o.name !== "string" || [o.x, o.y, o.w, o.h].some((v) => typeof v !== "number")) {
      throw new Error(`${path}: each region needs name, x, y, w, h`);
    }
    return {
      name: o.name,
      x: o.x!,
      y: o.y!,
      w: o.w!,
      h: o.h!,
      masks: o.masks ?? [],
      ...(typeof o.window === "string" ? { window: o.window } : {}),
    };
  });
}

async function main(): Promise<void> {
  const captureCommand = env("PIR_CAPTURE_CMD", DEFAULT_CAPTURE_CMD);
  const windowGeometryCommand = envOrOff("PIR_WINDOW_GEOMETRY_CMD", DEFAULT_WINDOW_GEOMETRY_CMD);
  const sensor = new Sensor({
    command: captureCommand,
    timeoutMs: Number(env("PIR_CAPTURE_TIMEOUT_MS", "10000")),
    maxCells: Number(env("PIR_MAX_CELLS", "64")),
    windowGeometryCommand,
  });
  for (const r of loadRegions(process.env.PIR_REGIONS)) sensor.define(r);

  const server = createServer(sensor, {
    defaultThreshold: Number(env("PIR_THRESHOLD", "0.05")),
    defaultIntervalMs: Number(env("PIR_INTERVAL_MS", "500")),
    defaultWaitMs: Number(env("PIR_DEFAULT_WAIT_MS", "55000")),
    maxWaitMs: Number(env("PIR_MAX_WAIT_MS", "540000")),
    captureCommand,
    selectCommand: envOrOff("PIR_SELECT_CMD", DEFAULT_SELECT_CMD),
    selectTimeoutMs: Number(env("PIR_SELECT_TIMEOUT_MS", "60000")),
    windowGeometryCommand,
    pickWindowCommand: envOrOff("PIR_PICK_WINDOW_CMD", DEFAULT_PICK_WINDOW_CMD),
  });

  const shutdown = (): void => {
    setTimeout(() => process.exit(0), 100).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(new StdioServerTransport());
}

main().catch((e: Error) => {
  process.stderr.write(`pir-mcp: ${e.stack ?? e.message}\n`);
  process.exit(1);
});
