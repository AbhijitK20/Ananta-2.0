#!/usr/bin/env python3
"""Generate every launcher icon and splash screen for the native app.

One drawing routine, four output families, because they are the same mark at
different sizes with different constraints:

  PWA any          the platform masks it to whatever shape it likes (circle,
                   squircle), so the mark can sit closer to the edge.
  PWA maskable     may be cropped to a circle, so the mark is inset to survive.
  Android adaptive  a 108dp canvas of which only the centre ~66% is guaranteed
  foreground        visible, on transparency so the colour layer shows through.
  Android legacy    pre-API-26 launchers get a bitmap; the round one is masked.
  Splash            11 orientation buckets, flat, no safe zone and no mask.

THE MARK
--------
The site's own logo (public/lal-logo.avif) is a red wordmark whose paper-plane
glyph is fused into the counter of the "A" in "A Local" -- the ink is one
connected shape, so it cannot be lifted out of the raster without taking part of
the letterform with it. It is also far too detailed to survive a 48px launcher:
the wingtip dots and the inner fold all collapse into a smudge.

So the mark here is a plain paper plane drawn to the same silhouette. That is the
same idea the brand already uses (something in flight, carrying a place
somewhere), it is legible at launcher size, and it is the decision a designer
would make rather than a raster trace.

Colours are sampled from the logo, not eyeballed: the red is #e6433c and the
page ground is #fff.

Usage:  uv run --with pillow python tools/generate-native-assets.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

# Sampled from public/lal-logo.avif.
BRAND_RED = "#e6433c"
PAGE_BG = "#ffffff"

SUPERSAMPLE = 4
ROOT = Path(__file__).resolve().parent.parent
PWA_OUT = ROOT / "public" / "icons"
ANDROID_RES = ROOT / "android" / "app" / "src" / "main" / "res"

PWA_SIZES = (192, 512)

# The mark's extent, as a fraction of the canvas, applied about the centre.
# The plane geometry already leaves a small margin, so these are mostly about
# giving the mark room to breathe: launchers mask and sometimes add their own
# padding, and a glyph that runs to the edge of an `any` icon is already half
# cropped before the platform does anything.
RADIUS_ANY = 0.88
RADIUS_MASKABLE = 0.70

ANDROID_DENSITIES = {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}
ADAPTIVE_CANVAS_DP = 108
RADIUS_ADAPTIVE = 0.80

# Splash dimensions, read back off the Capacitor template rather than invented,
# so every orientation bucket Capacitor expects is covered.
SPLASH_SIZES = {
    "drawable": (480, 320),
    "drawable-port-mdpi": (320, 480),
    "drawable-port-hdpi": (480, 800),
    "drawable-port-xhdpi": (720, 1280),
    "drawable-port-xxhdpi": (960, 1600),
    "drawable-port-xxxhdpi": (1280, 1920),
    "drawable-land-mdpi": (480, 320),
    "drawable-land-hdpi": (800, 480),
    "drawable-land-xhdpi": (1280, 720),
    "drawable-land-xxhdpi": (1600, 960),
    "drawable-land-xxxhdpi": (1920, 1280),
}
SPLASH_MARK_FRACTION = 0.22

# The plane, in unit coordinates with y running downward, taken from the shape of
# a standard send/paper-plane glyph: nose, two wingtips, and a notch cut back
# into the tail so it reads as folded paper rather than a triangle.
PLANE = [
    (0.083, 0.875),  # lower wingtip
    (0.958, 0.500),  # nose
    (0.083, 0.125),  # upper wingtip
    (0.083, 0.417),  # notch, upper
    (0.708, 0.500),  # notch apex
    (0.083, 0.583),  # notch, lower
]


def draw_plane(size: int, scale: float, background: str | None, foreground: str) -> Image.Image:
    """Render the plane on a `size` px canvas, antialiased via supersampling.

    `background` of None yields a transparent canvas, which the Android adaptive
    foreground layer needs so the colour layer below it shows through.
    """
    s = size * SUPERSAMPLE
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0) if background is None else background)
    d = ImageDraw.Draw(img)

    # Scale about the centre so `scale` shrinks the plane without letting it
    # drift toward one edge.
    points = [(0.5 + (x - 0.5) * scale, 0.5 + (y - 0.5) * scale) for x, y in PLANE]
    d.polygon([(x * s, y * s) for x, y in points], fill=foreground)
    return img.resize((size, size), Image.LANCZOS)


def write(img: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, "PNG", optimize=True)
    print(f"wrote {path.relative_to(ROOT)}")


def pwa_assets() -> None:
    for family, scale in (("any", RADIUS_ANY), ("maskable", RADIUS_MASKABLE)):
        for size in PWA_SIZES:
            write(draw_plane(size, scale, BRAND_RED, PAGE_BG), PWA_OUT / family / f"{size}.png")


def android_assets() -> None:
    if not (ANDROID_RES / "mipmap-mdpi").is_dir():
        print("skipping Android icons: platform not added yet (npm run cap:add:android)")
        return

    for dpi, legacy_px in ANDROID_DENSITIES.items():
        mipmap = ANDROID_RES / f"mipmap-{dpi}"

        write(draw_plane(legacy_px, RADIUS_ANY, BRAND_RED, PAGE_BG), mipmap / "ic_launcher.png")

        # Round variant: same art, masked to a circle. Drawn as a mask rather
        # than composited so the edge stays crisp at hdpi, where a hand-masked
        # PNG would show its seam.
        round_icon = draw_plane(legacy_px, RADIUS_ANY, BRAND_RED, PAGE_BG)
        circle = Image.new("L", (legacy_px, legacy_px), 0)
        ImageDraw.Draw(circle).ellipse([0, 0, legacy_px - 1, legacy_px - 1], fill=255)
        round_icon.putalpha(circle)
        write(round_icon, mipmap / "ic_launcher_round.png")

        canvas_px = round(legacy_px * ADAPTIVE_CANVAS_DP / 48)
        write(
            draw_plane(canvas_px, RADIUS_ADAPTIVE, None, PAGE_BG),
            mipmap / "ic_launcher_foreground.png",
        )


def splash_assets() -> None:
    if not (ANDROID_RES / "drawable").is_dir():
        print("skipping Android splash: platform not added yet (npm run cap:add:android)")
        return

    for bucket, (width, height) in SPLASH_SIZES.items():
        img = Image.new("RGB", (width, height), PAGE_BG)
        mark_px = round(min(width, height) * SPLASH_MARK_FRACTION * 2)
        # The splash is a flat, mask-free surface, so the mark can be a little
        # larger and needs no safe-zone inset.
        mark = draw_plane(mark_px, RADIUS_ANY, None, BRAND_RED)
        img.paste(mark, ((width - mark_px) // 2, (height - mark_px) // 2), mark)
        write(img, ANDROID_RES / bucket / "splash.png")


def main() -> None:
    pwa_assets()
    android_assets()
    splash_assets()


if __name__ == "__main__":
    main()
