# pir-mcp

A motion sensor for AI agents.

__*"Gives your LLM agents enough info to be a helpful "watcher" without being a privacy nightmare like Windows Recall"*__ 
*-Solteris-Dev*

A PIR sensor tells you *that* something moved, never *what*. This is the same
idea for a screen: an MCP server that watches named rectangles and answers
"did this change?" and "has this gone still?" with a number, a size and a
timestamp. No tool in it returns pixels, image files, or anything that could
be turned back into a picture.

It exists because an agent driving a desktop keeps needing the same two
things: *wake me when the build output moves* and *tell me if this status bar
has stopped ticking*. Both are motion questions. Neither needs a screenshot.

## What it does

- **`pir_pick_region`** ask the person at the screen to draw the rectangle,
  the way a regional screenshot works (slurp, slop). The human chooses what
  is sensed; the agent gets the geometry. Use this whenever someone is there.
- **`pir_pick_mask`** the same gesture for a patch inside a region to ignore
  (a clock, a spinner, a caret).
- **`pir_define_region`** the scriptable path: name a rectangle by global
  layout coordinates, with optional masks.
- **`pir_sample`** capture once, score against the previous sample of that
  region. Cheap; also the way to check the capture command works.
- **`pir_wait_for_change`** block until the region departs from how it looked
  when the call began, or time out. A doorbell.
- **`pir_wait_for_stillness`** block until nothing has changed for
  `still_for_ms`, or time out. A short window means "the animation settled,
  safe to act". A long window on something that should keep changing means
  it is frozen, and `still=true` is the alarm.
- **`pir_list_regions`**, **`pir_remove_region`** housekeeping.

Every comparison reports two numbers over a coarse grid of averaged colour
cells (at most 64 across, each at least 4 px), both 0 for identical and 1 for
black against white:

- **`rmse`** over the whole grid: did the region as a whole move? A cursor
  edge or an antialiased caret scores about 0.02; a dialog opening 0.1 or
  more. This is the default metric, threshold 0.05.
- **`peak`** the single most-changed cell: did *anything* in it move? A clock
  digit flipping inside a 1920-wide status bar scores rmse 0.018 (invisible
  to the default) but peak 0.145. Use `metric=peak` for a small thing that
  should tick inside a larger region.

Averaging is what makes this a sensor rather than a camera: 64 cells cannot
be read.

## What it deliberately does not do

- It never returns image data. There is no snapshot tool and none is planned.
  If an agent needs to *see*, use the screenshot tool your environment already
  has, so that choice stays explicit and yours.
- It never writes frames to disk. A capture lives in memory for the
  milliseconds it takes to reduce it to a grid, and only the grid of the last
  sample is kept per region.
- It does not capture on its own. Every sample is a tool call the agent made,
  visible in the transcript, and `pir_pick_region` carries a `purpose` line
  the agent has to write down before you draw.

What it *does* reveal, so you can decide whether that is acceptable: that a
given rectangle changed, at a given time, by a given magnitude. On a region
covering a chat window that is presence information. Choose regions
accordingly; the server has no opinion.

The capture itself is delegated to a command you configure, run with your
privileges. The default is `grim`, so nothing here has screen access that you
did not already give to grim.

## Install

```sh
git clone https://github.com/Solteris-Dev/pir-mcp
cd pir-mcp && npm install && npm run build
```

Requires Node 20+ and a screenshot tool that can write binary PPM to stdout.

### Capture command

`PIR_CAPTURE_CMD` is a template; `{x} {y} {w} {h}` are substituted and the
result runs under `sh -c`. It must print a binary PPM (`P6`) to stdout.

| environment | command |
|---|---|
| wlroots / Hyprland / Sway (default) | `grim -g "{x},{y} {w}x{h}" -t ppm -` |
| X11 with maim | `maim -g {w}x{h}+{x}+{y} -f png \| magick png:- ppm:-` |
| X11 with ImageMagick | `import -window root -crop {w}x{h}+{x}+{y} +repage ppm:-` |
| macOS | `screencapture -x -R{x},{y},{w},{h} -t png /dev/stdout \| magick png:- ppm:-` |

Coordinates are whatever the capture tool uses. On a wlroots layout that is
the global layout, so an output placed left of the primary has negative x.

### Selector command

`PIR_SELECT_CMD` runs when an agent calls `pir_pick_region` or
`pir_pick_mask` and must print `x,y wxh`. Set it to an empty string to remove
those tools entirely.

| environment | command |
|---|---|
| wlroots / Hyprland / Sway (default) | `slurp -f "%x,%y %wx%h"` |
| X11 | `slop -f "%x,%y %wx%h"` |

### Claude Code

```sh
claude mcp add -s user pir -- node /path/to/pir-mcp/dist/stdio.js
```

Blocking calls default to 55 s and are capped by `PIR_MAX_WAIT_MS` (540 s).
Keep the cap under your host's MCP tool timeout; an agent that needs to watch
for longer just calls again.

### Other settings

| variable | default | meaning |
|---|---|---|
| `PIR_REGIONS` | unset | JSON file of regions to define at startup |
| `PIR_THRESHOLD` | `0.05` | default change threshold |
| `PIR_INTERVAL_MS` | `500` | default sampling period |
| `PIR_DEFAULT_WAIT_MS` | `55000` | default timeout for blocking calls |
| `PIR_MAX_WAIT_MS` | `540000` | cap for blocking calls |
| `PIR_CAPTURE_TIMEOUT_MS` | `10000` | how long one capture may take |
| `PIR_SELECT_TIMEOUT_MS` | `60000` | how long the person has to draw a selection |
| `PIR_MAX_CELLS` | `64` | grid resolution on the long side; smaller is coarser and more private |

A regions file looks like:

```json
[
  { "name": "bar", "x": 0, "y": 0, "w": 1920, "h": 26,
    "masks": [{ "x": 1690, "y": 0, "w": 110, "h": 26 }] }
]
```

## Example

The case that produced this: a status bar that occasionally froze for hours
while its process looked healthy. The clock in it should change every
minute, so a bar that is still for three minutes is a frozen bar.

```
pir_pick_region         name=bar purpose="watch the status bar for a freeze"
pir_wait_for_stillness  name=bar still_for_ms=180000 metric=peak timeout_ms=540000
```

`still=true` comes back only if the bar stopped; otherwise the call returns
`still=false` at the timeout and the agent calls again. Nothing on the screen
was ever seen, and the person drew the rectangle themselves.

## Tests

```sh
npm test
```

## License

MIT.
