# macOS

Untested starting points. Written on Linux; expect to fix the y flip or
multi-display maths on a real Mac and please send a PR when you do.

## Capture

`screencapture` writes files, not stdout, and `magick` (ImageMagick) turns
the PNG into the PPM pir-mcp reads:

```sh
PIR_CAPTURE_CMD='f=$(mktemp -t pir).png; screencapture -x -R{x},{y},{w},{h} -t png "$f" && magick "$f" ppm:-; rm -f "$f"'
```

`-R` takes points with the origin at the top-left of the main display.

## Region selection

`screencapture -i` lets you drag a rectangle but does not print its geometry,
so it cannot be the selector. `select-rect.swift` is a small AppKit overlay
that does print `x,y wxh`:

```sh
PIR_SELECT_CMD='swift /path/to/pir-mcp/contrib/macos/select-rect.swift'
```

Compile it once with `swiftc select-rect.swift -o pir-select` if the
interpreter start-up is too slow.

## Windows

`screencapture -l <windowid>` captures one window by id, and window ids can
be listed with the `GetWindowID` tool (`brew install smokris/getwindowid/getwindowid`)
or via `CGWindowListCopyWindowInfo` from a short Swift script. A window
geometry command would print the window's `kCGWindowBounds` as `x,y wxh`;
nobody has written that yet.
