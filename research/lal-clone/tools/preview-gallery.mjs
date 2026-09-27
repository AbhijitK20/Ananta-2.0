#!/usr/bin/env node
/**
 * Build a browsable preview of the native app, then serve it on the LAN.
 *
 * There is no Android SDK on this machine, so an actual APK cannot be installed
 * and screenshotted. What this does instead is reproduce the parts of the shell
 * a person actually sees -- the launch screen, the launcher icon, the themed
 * status bar, and the app itself at a phone viewport -- and lay them out as an
 * HTML gallery you can open in any browser.
 *
 * Everything inside a phone frame is the REAL page, screenshotted from the
 * running server at a Pixel-class viewport. The only synthetic parts are the
 * device frame, the status bar and the launch screen, which is unavoidable:
 * those are native views and do not exist in a browser.
 *
 * The gallery is written to preview/ and served over HTTP so it can be opened
 * from a phone on the same Wi-Fi, which is the whole point of building it.
 *
 * Usage:
 *   node tools/preview-gallery.mjs [base-url] [--port 4400] [--no-serve]
 */

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "preview");

/** Pixel 8 class. Android is the target the shell is actually built for. */
const VIEWPORT = { width: 412, height: 892 };
const SCALE = 2;

/** The home page is a WebGL globe, so give it room before screenshotting. */
const TIMEOUT_MS = 60_000;

/** Routes to photograph, in the order a person meets them. */
const ROUTES = [
  ["", "home", "Home — hero + city picker"],
  ["/cities", "cities", "Cities — the browse surface"],
  ["/about", "about", "About"],
  ["/blog", "blog", "Blog index — 160+ guides"],
  ["/social-impact", "social-impact", "Social impact"],
];

const args = process.argv.slice(2);
const base = (args.find((a) => !a.startsWith("--")) ?? "http://127.0.0.1:4310").replace(/\/$/, "");
const portArg = args.indexOf("--port");
const PORT = portArg >= 0 ? Number(args[portArg + 1]) : 4400;
const SERVE = !args.includes("--no-serve");

function log(msg) {
  console.log(`[preview] ${msg}`);
}

/** Screenshot one route at the phone viewport. Returns the file path or null. */
async function shoot(context, route, name) {
  const page = await context.newPage();
  const url = route ? `${base}${route}` : `${base}/`;
  try {
    await page.goto(url, { waitUntil: "networkidle", timeout: TIMEOUT_MS });
    // The hero and the globe animate in; a screenshot taken at networkidle
    // catches them mid-fade, which reads as a rendering bug rather than a
    // screenshot artefact.
    await page.waitForTimeout(2500);
    const file = join(OUT, `app-${name}.png`);
    await page.screenshot({ path: file });
    log(`shot ${name}`);
    return file;
  } catch (error) {
    log(`FAILED ${name}: ${String(error).split("\n")[0]}`);
    return null;
  } finally {
    await page.close();
  }
}

/** Copy a generated native asset into the gallery so it can be linked. */
function copyAsset(relative, outName) {
  const from = join(ROOT, relative);
  if (!existsSync(from)) return null;
  const to = join(OUT, outName);
  writeFileSync(to, readFileSync(from));
  return outName;
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".css": "text/css; charset=utf-8",
};

function serve() {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    // normalize() collapses any `..` before it is joined, so a request cannot
    // walk out of preview/ and read the rest of the project.
    const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, "");
    const file = join(OUT, rel === "/" ? "index.html" : rel);
    if (!file.startsWith(OUT) || !existsSync(file)) {
      res.writeHead(404).end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(readFileSync(file));
  });
  server.listen(PORT, "0.0.0.0", () => {
    const lan = process.env.CAP_PREVIEW_HOST ?? "";
    log(`serving on http://0.0.0.0:${PORT}${lan ? `  (LAN: http://${lan}:${PORT}/)` : ""}`);
  });
}

function page(screens) {
  const cards = screens
    .map(
      ({ name, label, file }) => `      <figure class="shot">
        <div class="phone">
          <div class="notch"></div>
          <div class="statusbar"><span>9:41</span><span class="glyphs">&#9679;&#9679;&#9679;&#9646;</span></div>
          <img src="${file}" alt="${label}" loading="lazy" />
          <div class="pill"></div>
        </div>
        <figcaption><strong>${label}</strong><code>/${name === "home" ? "" : name}</code></figcaption>
      </figure>`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Local Guide — native app preview</title>
<style>
  :root {
    --bg: #141414; --card: #1e1e1e; --ink: #f2f2f2; --muted: #9a9a9a;
    --red: #e6433c; --line: #2e2e2e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--ink);
    font: 400 15px/1.6 -apple-system, system-ui, "Segoe UI", sans-serif;
    padding: 40px 24px 80px;
  }
  .wrap { max-width: 1400px; margin: 0 auto; }
  header { border-bottom: 1px solid var(--line); padding-bottom: 24px; margin-bottom: 36px; }
  h1 { font-size: 26px; margin: 0 0 6px; letter-spacing: -0.01em; }
  .sub { color: var(--muted); margin: 0; }
  .tag {
    display: inline-block; background: var(--red); color: #fff; font-size: 11px;
    font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase;
    padding: 4px 9px; border-radius: 4px; margin-bottom: 14px;
  }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.1em;
       color: var(--muted); margin: 48px 0 18px; font-weight: 600; }
  .grid { display: flex; flex-wrap: wrap; gap: 28px; }
  .shot { margin: 0; width: 300px; }
  .phone {
    position: relative; background: #000; border-radius: 30px; padding: 10px;
    border: 1px solid #333; overflow: hidden;
  }
  .phone img { display: block; width: 100%; border-radius: 22px; background: #fff; }
  .notch {
    position: absolute; top: 18px; left: 50%; transform: translateX(-50%);
    width: 76px; height: 5px; background: #000; border-radius: 3px; z-index: 2;
  }
  .statusbar {
    display: flex; justify-content: space-between; align-items: center;
    padding: 5px 12px 3px; color: #251e20; font-size: 11px; font-weight: 600;
    background: #fff; margin: 0 -10px 0; padding-left: 22px; padding-right: 22px;
  }
  .glyphs { letter-spacing: 1px; font-size: 9px; }
  .pill {
    position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%);
    width: 100px; height: 4px; background: #55524d; border-radius: 3px; opacity: 0.55;
  }
  figcaption { margin-top: 12px; font-size: 13px; }
  figcaption code {
    display: block; color: var(--muted); font-size: 11px; margin-top: 2px;
    font-family: ui-monospace, SFMono-Regular, monospace;
  }
  .assets { display: flex; flex-wrap: wrap; gap: 18px; align-items: flex-start; }
  .asset { text-align: center; font-size: 11px; color: var(--muted); }
  .asset img { display: block; border-radius: 10px; background: #2a2a2a; padding: 8px; }
  .asset .sq img { border-radius: 14px; }
  table { border-collapse: collapse; width: 100%; max-width: 900px; font-size: 13px; }
  td, th { text-align: left; padding: 7px 12px 7px 0; border-bottom: 1px solid var(--line); }
  th { color: var(--muted); font-weight: 600; font-size: 11px;
       text-transform: uppercase; letter-spacing: 0.08em; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; color: #ffb4b0; }
  a { color: var(--red); }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="tag">Capacitor 8 &middot; Android</span>
    <h1>Like a Local Guide &mdash; native app preview</h1>
    <p class="sub">
      Every frame below is the real site screenshotted from
      <code>${base}</code> at a ${VIEWPORT.width}&times;${VIEWPORT.height} viewport.
      The device frame, status bar and launch screen are drawn on top, because
      those are native views that do not exist in a browser.
    </p>
  </header>

  <h2>The app</h2>
  <div class="grid">
${cards}
  </div>

  <h2>Launcher icon &amp; splash</h2>
  <div class="assets">
    <div class="asset sq"><img src="icon-any.png" width="86" alt="" /><div>any 192</div></div>
    <div class="asset sq"><img src="icon-maskable.png" width="86" alt="" /><div>maskable 192</div></div>
    <div class="asset"><img src="icon-legacy-48.png" width="56" alt="" /><div>launcher 48</div></div>
    <div class="asset"><img src="icon-round.png" width="86" alt="" /><div>round 192</div></div>
    <div class="asset"><img src="splash-portrait.png" width="150" alt="" /><div>splash</div></div>
  </div>

  <h2>What is wired up</h2>
  <table>
    <tr><th>Capability</th><th>Bridge function</th><th>Web fallback</th></tr>
    <tr><td>Geolocation</td><td><code>currentPosition</code>, <code>watchPosition</code></td><td><code>navigator.geolocation</code></td></tr>
    <tr><td>Haptics</td><td><code>tapFeedback</code>, <code>outcomeFeedback</code></td><td>no-op</td></tr>
    <tr><td>Share</td><td><code>share</code></td><td><code>navigator.share</code></td></tr>
    <tr><td>Push</td><td><code>registerForPush</code>, <code>onPushReceived</code></td><td><code>null</code></td></tr>
    <tr><td>Splash screen</td><td><code>hideSplashScreen</code></td><td>no-op</td></tr>
    <tr><td>Status bar</td><td><code>applyStatusBarTheme</code></td><td>no-op</td></tr>
    <tr><td>Hardware back</td><td><code>onHardwareBack</code></td><td>no-op</td></tr>
  </table>

  <h2>Not yet verified</h2>
  <p class="sub">
    No Android SDK on this machine, so there is no installed APK. The splash
    transition, real status-bar plugin calls, haptics, the share sheet, push
    delivery and the hardware back button are written and typechecked but have
    not run on a device.
  </p>
</div>
</body>
</html>
`;
}

async function main() {
  mkdirSync(OUT, { recursive: true });

  const browser = await chromium.launch({ args: ["--no-sandbox", "--use-gl=swiftshader"] });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
    isMobile: true,
    hasTouch: true,
    colorScheme: "light",
  });

  const screens = [];
  for (const [route, name, label] of ROUTES) {
    const file = await shoot(context, route, name);
    if (file) screens.push({ name, label, file: `app-${name}.png` });
  }
  await browser.close();

  copyAsset("public/icons/any/192.png", "icon-any.png");
  copyAsset("public/icons/maskable/192.png", "icon-maskable.png");
  copyAsset("android/app/src/main/res/mipmap-mdpi/ic_launcher.png", "icon-legacy-48.png");
  copyAsset("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher_round.png", "icon-round.png");
  copyAsset("android/app/src/main/res/drawable-port-xhdpi/splash.png", "splash-portrait.png");

  writeFileSync(join(OUT, "index.html"), page(screens));
  log(`wrote ${join(OUT, "index.html")} (${screens.length} screens)`);

  if (SERVE) serve();
}

await main();
