/**
 * MCP surface. Every result is `{ ok, result | error }`. No tool returns
 * pixels, file paths to images, or anything derived from a frame beyond a
 * change score, a size and a timestamp.
 */
import { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { Metric, OnOcclusion, Sensor, WaitOptions } from "./sensor.js";
import { pickWindow, selectRect } from "./capture.js";

export const SERVER_NAME = "pir-mcp";
export const SERVER_VERSION = "0.1.0";

export interface ServerOptions {
  defaultThreshold: number;
  defaultIntervalMs: number;
  defaultWaitMs: number;
  /** upper bound on any blocking call; keep it under the host's MCP tool timeout */
  maxWaitMs: number;
  captureCommand: string;
  /** interactive selector; empty string disables the pick tools */
  selectCommand: string;
  selectTimeoutMs: number;
  /** window geometry lookup; empty disables window regions */
  windowGeometryCommand: string;
  /** interactive window pick; empty disables pir_pick_window */
  pickWindowCommand: string;
  /** one window's own contents by id; empty means window regions are cut from the screen */
  windowCaptureCommand: string;
  /** visible windows topmost first; empty disables occlusion reporting and follow_window */
  stackCommand: string;
}

interface ToolEnvelope {
  ok: boolean;
  result?: unknown;
  error?: { message: string };
}

async function runTool(fn: () => unknown | Promise<unknown>) {
  let envelope: ToolEnvelope;
  let failed = false;
  try {
    envelope = { ok: true, result: (await fn()) ?? null };
  } catch (err) {
    envelope = { ok: false, error: { message: err instanceof Error ? err.message : String(err) } };
    failed = true;
  }
  return {
    content: [{ type: "text" as const, text: JSON.stringify(envelope) }],
    structuredContent: envelope as unknown as Record<string, unknown>,
    ...(failed ? { isError: true } : {}),
  };
}

const rect = z.object({
  x: z.number().int().describe("left edge, pixels"),
  y: z.number().int().describe("top edge, pixels"),
  w: z.number().int().min(1).describe("width, pixels"),
  h: z.number().int().min(1).describe("height, pixels"),
});

export function createServer(sensor: Sensor, opts: ServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  const waitOpts = (a: {
    threshold?: number;
    metric?: Metric;
    interval_ms?: number;
    timeout_ms?: number;
    on_occlusion?: OnOcclusion;
  }): WaitOptions => ({
    threshold: a.threshold ?? opts.defaultThreshold,
    metric: a.metric ?? "rmse",
    intervalMs: Math.max(100, a.interval_ms ?? opts.defaultIntervalMs),
    timeoutMs: Math.min(opts.maxWaitMs, a.timeout_ms ?? opts.defaultWaitMs),
    onOcclusion: a.on_occlusion ?? "report",
  });

  const timing = {
    threshold: z
      .number()
      .min(0)
      .max(1)
      .optional()
      .describe(
        `score that counts as a change, 0..1 (default ${opts.defaultThreshold}). With metric=rmse a caret or ` +
          "cursor edge scores about 0.02 and a dialog opening 0.1+. With metric=peak a digit flipping in one " +
          "cell scores about 0.05-0.2.",
      ),
    metric: z
      .enum(["rmse", "peak"])
      .optional()
      .describe(
        "what the threshold applies to. rmse (default): the whole region moved. peak: any single cell moved, " +
          "for a small thing that should tick inside a larger region (a clock in a bar).",
      ),
    interval_ms: z.number().int().min(100).optional().describe(`sampling period (default ${opts.defaultIntervalMs})`),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .optional()
      .describe(`give up after this long (default ${opts.defaultWaitMs}, max ${opts.maxWaitMs})`),
    on_occlusion: z
      .enum(["report", "pause", "pause_rebaseline", "count"])
      .optional()
      .describe(
        "window regions cut from the screen only (a window captured as itself is always judged): what to do " +
          "while it is covered or on a hidden workspace. report (default): return at once with occluded=true. pause: keep waiting without " +
          "judging, then compare against the baseline from before it was covered, so a change made while " +
          "hidden still counts. pause_rebaseline: keep waiting, take a fresh baseline when it reappears. " +
          "count: judge anyway, so being covered is a change. Paused time still counts toward timeout_ms.",
      ),
  };

  server.registerTool(
    "pir_define_region",
    {
      description:
        "Name a rectangle of the screen to watch. Coordinates are in the global layout the capture tool uses " +
        "(on a multi-monitor wlroots layout an output left of the primary has negative x). Masks are rects " +
        "inside the region, in region-local pixels, that are ignored: put a clock or spinner there. Redefining " +
        "a name replaces it and forgets its last sample.",
      inputSchema: z.object({
        name: z.string().min(1).max(64),
        ...rect.shape,
        masks: z.array(rect).max(32).optional(),
      }),
    },
    async (a) =>
      runTool(() =>
        sensor.define({ name: a.name, x: a.x, y: a.y, w: a.w, h: a.h, masks: a.masks ?? [] }),
      ),
  );

  if (opts.windowGeometryCommand) {
    server.registerTool(
      "pir_define_window",
      {
        description:
          "Watch a window rather than a fixed rectangle: geometry is looked up from the window id before " +
          "every capture, so the region follows the window when it moves. With anchor, only that part of " +
          "the window is watched, so the person can use the rest of it freely. Without one, a resize counts " +
          "as maximal change. Masks are region-local. The id is whatever your window-geometry command " +
          "understands (on Hyprland the stableId from hyprctl clients, or the address).",
        inputSchema: z.object({
          name: z.string().min(1).max(64),
          window: z.string().min(1).max(64),
          anchor: rect.optional().describe("the part of the window to watch, in window-local pixels"),
          masks: z.array(rect).max(32).optional(),
        }),
      },
      async (a) => runTool(() => sensor.defineWindow(a.name, a.window, a.masks ?? [], a.anchor)),
    );
  }

  if (opts.windowGeometryCommand && opts.pickWindowCommand) {
    server.registerTool(
      "pir_pick_window",
      {
        description:
          "Ask the person at the screen to click the window to watch (visible windows are offered as boxes; " +
          "Escape cancels). The region then follows that window. Prefer this over pir_define_window when a " +
          "human is present.",
        inputSchema: z.object({
          name: z.string().min(1).max(64),
          purpose: z
            .string()
            .max(200)
            .optional()
            .describe("one line on why you want to watch it; returned unchanged so it lands in the transcript"),
        }),
      },
      async (a) =>
        runTool(async () => {
          const id = await pickWindow(opts.pickWindowCommand, opts.selectTimeoutMs);
          const region = await sensor.defineWindow(a.name, id);
          return { ...region, ...(a.purpose ? { purpose: a.purpose } : {}) };
        }),
    );
  }

  if (opts.selectCommand) {
    server.registerTool(
      "pir_pick_region",
      {
        description:
          "Ask the person at the screen to draw the rectangle to watch (a selector such as slurp appears; " +
          "Escape cancels). Prefer this over pir_define_region whenever a human is present: they choose what " +
          "is sensed, and you get the geometry back. Blocks until they finish or the selector times out. " +
          "With follow_window, the rectangle is pinned to the window it was drawn on and moves with it.",
        inputSchema: z.object({
          name: z.string().min(1).max(64),
          follow_window: z
            .boolean()
            .optional()
            .describe("pin the rectangle to the window under it (needs window regions and the stack command)"),
          purpose: z
            .string()
            .max(200)
            .optional()
            .describe("one line on why you want to watch it; returned unchanged so it lands in the transcript"),
        }),
      },
      async (a) =>
        runTool(async () => {
          const r = await selectRect(opts.selectCommand, opts.selectTimeoutMs);
          const region = a.follow_window
            ? await sensor.defineAnchored(a.name, r)
            : sensor.define({ name: a.name, ...r, masks: [] });
          return { ...region, ...(a.purpose ? { purpose: a.purpose } : {}) };
        }),
    );

    server.registerTool(
      "pir_pick_mask",
      {
        description:
          "Ask the person to draw a rectangle inside an existing region that should be ignored (a clock, a " +
          "spinner, a caret). Forgets the region's last sample, since masked grids are not comparable to " +
          "unmasked ones.",
        inputSchema: z.object({ name: z.string() }),
      },
      async (a) => runTool(async () => sensor.addMask(a.name, await selectRect(opts.selectCommand, opts.selectTimeoutMs))),
    );
  }

  server.registerTool(
    "pir_list_regions",
    {
      description: "The regions currently defined, with their geometry and masks.",
      inputSchema: z.object({}),
    },
    async () =>
      runTool(() => ({
        regions: sensor.list(),
        capture_command: opts.captureCommand,
        select_command: opts.selectCommand || null,
        window_geometry_command: opts.windowGeometryCommand || null,
        pick_window_command: opts.pickWindowCommand || null,
        window_capture_command: opts.windowCaptureCommand || null,
        stack_command: opts.stackCommand || null,
      })),
  );

  server.registerTool(
    "pir_remove_region",
    {
      description: "Forget a region.",
      inputSchema: z.object({ name: z.string() }),
    },
    async (a) => runTool(() => ({ removed: sensor.remove(a.name) })),
  );

  server.registerTool(
    "pir_sample",
    {
      description:
        "Capture the region once and score it against the previous sample of the same region (null on the " +
        "first call). Cheap and non-blocking: use it to check the capture command works, to take a baseline " +
        "before doing something, or to ask 'did anything happen there since I last looked?'.",
      inputSchema: z.object({ name: z.string() }),
    },
    async (a) => runTool(() => sensor.sample(a.name)),
  );

  server.registerTool(
    "pir_wait_for_change",
    {
      description:
        "Block until the region looks different from how it looked when this call started, or until " +
        "timeout_ms. Returns changed=true with the score, or changed=false with the largest score seen. " +
        "Use it as a doorbell: 'wake me when the build output moves', 'when the dialog closes', " +
        "'when the game loads'.",
      inputSchema: z.object({ name: z.string(), ...timing }),
    },
    async (a) => runTool(() => sensor.waitForChange(a.name, waitOpts(a))),
  );

  server.registerTool(
    "pir_wait_for_stillness",
    {
      description:
        "Block until consecutive samples have stayed below threshold for still_for_ms, or until timeout_ms. " +
        "A short window means 'the page/animation has settled, safe to act'. A long window on something " +
        "that should keep changing (a clock, a progress bar, a status bar) means it is frozen: " +
        "still=true is then the alarm.",
      inputSchema: z.object({
        name: z.string(),
        still_for_ms: z.number().int().min(100).describe("how long nothing may change"),
        ...timing,
      }),
    },
    async (a) => runTool(() => sensor.waitForStillness(a.name, a.still_for_ms, waitOpts(a))),
  );

  return server;
}
