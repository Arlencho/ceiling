#!/usr/bin/env bash
# Regenerate every icon PNG from the SVG masters in design/icon/ and
# design/store/. Requires rsvg-convert; sips is used for the small previews.
#
#   scripts/render-icon.sh
#
# Edit the SVGs, run this, commit both. Never edit the PNGs by hand.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ICON_SRC="$ROOT/design/icon"
STORE_SRC="$ROOT/design/store"
OUT="$ROOT/app/assets/images"
PREVIEW="$ROOT/design/icon/preview"

command -v rsvg-convert >/dev/null || { echo "rsvg-convert is required" >&2; exit 1; }
command -v sips >/dev/null || { echo "sips is required" >&2; exit 1; }

render() { # render <svg> <png> <width> <height>
  rsvg-convert -w "$3" -h "$4" "$1" -o "$2"
  echo "wrote ${2#"$ROOT"/} ($3x$4)"
}

mkdir -p "$PREVIEW"

# App assets, wired in app.json.
render "$ICON_SRC/icon.svg"                      "$OUT/icon.png"                      1024 1024
render "$ICON_SRC/android-icon-foreground.svg"   "$OUT/android-icon-foreground.png"   1024 1024
render "$ICON_SRC/android-icon-background.svg"   "$OUT/android-icon-background.png"   1024 1024
render "$ICON_SRC/android-icon-monochrome.svg"   "$OUT/android-icon-monochrome.png"   1024 1024
render "$ICON_SRC/splash-icon.svg"               "$OUT/splash-icon.png"                512  512

# Store listing assets.
render "$ICON_SRC/icon.svg"                      "$STORE_SRC/icon.png"                 512  512
render "$STORE_SRC/banner.svg"                   "$STORE_SRC/banner.png"              1200  600

# Verification previews: how the mark survives the launcher masks, and the
# 48px legibility check. Render large, then let sips downscale the way a
# launcher would.
render "$ICON_SRC/preview/masked.svg" "$PREVIEW/masked-large.png" 1536 512
sips -z 192 576 "$PREVIEW/masked-large.png" --out "$PREVIEW/masked-192.png" >/dev/null
sips -z 48 144 "$PREVIEW/masked-large.png" --out "$PREVIEW/masked-48.png" >/dev/null
rm "$PREVIEW/masked-large.png"
echo "wrote design/icon/preview/masked-192.png (576x192)"
echo "wrote design/icon/preview/masked-48.png (144x48)"

render "$ICON_SRC/icon.svg" "$PREVIEW/icon-large.png" 512 512
sips -z 48 48 "$PREVIEW/icon-large.png" --out "$PREVIEW/icon-48.png" >/dev/null
sips -z 72 72 "$PREVIEW/icon-large.png" --out "$PREVIEW/icon-72.png" >/dev/null
sips -z 192 192 "$PREVIEW/icon-large.png" --out "$PREVIEW/icon-192.png" >/dev/null
rm "$PREVIEW/icon-large.png"
echo "wrote design/icon/preview/icon-48.png (48x48)"
echo "wrote design/icon/preview/icon-72.png (72x72)"
echo "wrote design/icon/preview/icon-192.png (192x192)"
