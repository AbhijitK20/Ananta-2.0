# Like a Local Guide — mobile app (Capacitor)

The site as a real Android app. The web app is unchanged and remains the source
of truth; this is a native shell around it.

> **Read this first if you hit a blank app.** This repo has another process in it
> that runs `git reset --hard`. That discards uncommitted work, which is why the
> mobile app was written into an isolated directory and installed by script. If
> `research/lal-clone/capacitor.config.ts` has disappeared, run
> `bash install-mobile.sh` from the install directory rather than rebuilding it
> by hand.

---

## 1. Why Capacitor

The brief was "turn this web page into a mobile app". Four things were on the
table:

| Approach | Verdict here |
| --- | --- |
| **`ionic-team/capacitor`** (16.6k★, MIT) | **Chosen.** Real iOS + Android projects, native plugin API, drop-in to an existing web app. |
| `GoogleChromeLabs/bubblewrap` (3.1k★) | Android only, and it requires a *valid PWA* first — manifest, service worker, HTTPS. The manifest exists now; there is no service worker, and TWA would still leave the app dead offline. |
| PWA only | No store, no push, no native share sheet. Cheapest to ship, and a genuine fallback, but not "an app" in the sense people mean. |
| React Native / Expo rewrite | Would mean rewriting every component. The design system is a 1,300-line hand-built CSS token layer plus a WebGL globe; none of that survives a rewrite intact. |

Capacitor is a **webview with a native API surface**. That framing sets the
expectation correctly: it is the right tool when the goal is distribution and
native capability, and the wrong tool if the goal is a UI indistinguishable from
a native app.

---

## 2. The one constraint that shaped everything

The site is **server-rendered** — the routes under `app/` produce HTML on the
server, and `/blog/[slug]` and `/[slug]` are generated per entry.

**There is no Node server inside a mobile webview.** So a static export is not
available: the webview has to load a running server.

That is why `capacitor.config.ts` is environment-driven:

```
CAP_SERVER_URL unset  ->  bundle mode. Shell loads the static shell in public/.
CAP_SERVER_URL set    ->  webview loads that URL. Development against a LAN server.
```

Capacitor's own docs mark `server.url` and `cleartext` as development-only, and
this document does not pretend otherwise. Shipping to a store means pointing
`CAP_SERVER_URL` at a real HTTPS origin and rebuilding.

---

## 3. Daily loop (Android, on your LAN)

```bash
# 1. Serve the site on the LAN.
PORT=4310 npm run start:lan

# 2. In another shell: point the native shell at it and sync.
npm run cap:sync

# 3. Build, install and launch on a connected device or emulator.
npm run cap:run:android
```

The phone must be on the **same Wi-Fi**. `cap:sync` prints the URL it baked in;
if your LAN address changes, re-run it.

`tools/cap-sync.mjs` exists so that is one command rather than a runbook. The
Capacitor CLI does not read `.env`, and the server's address is whatever DHCP
handed out this morning, so hard-coding it produces a blank app on the first
machine that differs from yours. The script reads the default route's source
address, writes the cleartext exception to match, and warns if the port is
serving something that is not this site.

---

## 4. What is wired up

All native access goes through **`lib/native/bridge.ts`**. Component code calls
that; nothing imports `@capacitor/*` directly. Three reasons, all load-bearing:

1. The same module graph runs in a browser. Every native call has a web
   fallback, so `npm run dev` keeps working.
2. The web bundle does not carry native plugin code — plugins load behind a
   native check via dynamic `import()`.
3. Native failure is a **value**, not an exception. A phone that denies
   location, or an emulator with no GPS, is an ordinary condition. Callers get
   `null` and degrade.

| Capability | Bridge function | Web fallback |
| --- | --- | --- |
| Geolocation | `currentPosition`, `watchPosition`, `requestLocationPermission` | `navigator.geolocation` |
| Haptics | `tapFeedback`, `outcomeFeedback` | no-op |
| Share | `share` | `navigator.share` |
| Push | `registerForPush`, `onPushReceived` | `null` |
| Splash screen | `hideSplashScreen` | no-op |
| Status bar | `applyStatusBarTheme` | no-op |
| Hardware back | `onHardwareBack` | no-op |

`components/NativeShell.tsx` drives the shell from the root layout so every route
gets the same behaviour. It renders nothing and is inert in a browser.

### Two of these deserve a note

**Geolocation and secure contexts.** `navigator.geolocation` is gated on a
secure context. In a browser that means https or localhost, so the web fallback
works. Inside the native shell pointed at a plain-http LAN origin it does *not*,
which is precisely why the native path exists rather than delegating to the
browser. The native plugin talks to the OS location provider directly.

**Push.** Android needs `google-services.json` in `android/app/` and iOS needs
an `aps-environment` entitlement. Neither belongs in version control, so a fresh
checkout has no token — that is the expected state, and `registerForPush`
resolving `null` is normal, not a fault. It is deliberately not on the boot
path, so the app is fully usable without it.

---

## 5. Safe areas

`viewportFit: "cover"` in `app/layout.tsx` lets the page extend under a display
cutout or home indicator, which is the only way `env(safe-area-inset-*)` reports
anything non-zero. Those become the `--lal-safe-*` tokens in `globals.css`.

The site has **no fixed or sticky chrome at all** — everything scrolls — so the
insets land on the scroll container and the two edges rather than on individual
components:

- `body` — left/right, for landscape on a notched phone
- `.lal-header` — top
- `.lal-footer` — bottom

Each uses `max(<design spacing>, var(--lal-safe-*))` so the token can only
*grow* the spacing, never shrink it. Off-device it is 0 with no separate desktop
path.

On Android the shell sets `overlaysWebView: false`, so the webview is already
seated below the status bar and the top token resolves to 0 there.

---

## 6. Cleartext, and why it is not blanket

Android has blocked cleartext HTTP by default since API 28, and **Capacitor does
not add the permission for you** — the `usesCleartextTraffic` injection lives in
its Cordova migration path, not the Capacitor one. Without an exception the app
loads nothing and logs an opaque `ERR_CLEARTEXT_NOT_PERMITTED`, indistinguishable
from the server being down.

Rather than a blanket permission (which covers *every* request the app makes),
the exception is scoped to the one host the dev server runs on:

`android/app/src/main/res/xml/network_security_config.xml` — cleartext denied by
default, permitted for `localhost`, `127.0.0.1`, `10.0.2.2` and the detected LAN
address. `npm run cap:sync` rewrites the LAN entry each time. A build pointed at
an https origin gets no cleartext entry and fails closed.

---

## 7. Icons and splash

One generator, `tools/generate-native-assets.py`, emits all of it:

- PWA `any` and `maskable` icons → `public/icons/`
- Android adaptive foregrounds, legacy square and round bitmaps, all five
  densities → `android/app/src/main/res/mipmap-*/`
- Android splash screens, all eleven orientation buckets

```bash
npm run assets:native
```

**The mark is drawn, not traced.** The site's own logo (`public/lal-logo.avif`) is
a red wordmark whose paper-plane glyph is fused into the counter of the "A" in
"A Local" — one connected shape, so it cannot be lifted from the raster without
taking part of the letterform. It is also far too detailed for 48px: the wingtip
dots and inner fold collapse into a smudge. So the generator draws a plain paper
plane to the same silhouette, in the brand red sampled from that logo
(`#e6433c`). Same idea the brand already uses, legible at launcher size.

---

## 8. Building an APK

**Not possible on this machine yet.** Two blockers, both environmental:

1. **No Android SDK.** `ANDROID_HOME` and `ANDROID_SDK_ROOT` are unset. Install
   Android Studio (or the command-line SDK) and accept the licenses.
2. **Java 25 is too new.** Only OpenJDK 25 is installed. Gradle 8.14.3 fails with
   `Unsupported class file major version 69` (69 = Java 25); AGP 8.13 supports up
   to Java 23. **Install JDK 21** and point `JAVA_HOME` at it.

Once both are in place:

```bash
cd android && ./gradlew assembleDebug     # debug APK
cd android && ./gradlew bundleRelease     # AAB for the Play Store
```

iOS additionally needs Xcode (macOS only) and, for a plain-http LAN origin, an
ATS exception in `Info.plist` — the equivalent of §6.

---

## 9. Preview

```bash
npm run preview:gallery
```

Screenshots every route at a 412×892 Pixel-class viewport from the running
server, copies in the launcher icons and splash, writes `preview/index.html`, and
serves it on the LAN. Open it from a phone to see what the shell looks like.

Every frame inside a device frame is the real page. The device frame, status bar
and launch screen are drawn on top, because those are native views and do not
exist in a browser.

---

## 10. What is verified, and what is not

**Verified**

- `npx tsc --noEmit` — clean
- `npm run build` — succeeds; all routes prerender (160+ blog posts, 13+ cities)
- `npm run preview:gallery` — all five routes screenshot successfully
- Every route returns 200 from the running server
- `/manifest.webmanifest` is served and parses
- Generated icons verified: the round launcher icon is genuinely RGBA with
  transparent corners, and the maskable mark is measurably inset

**Not verified — there is no device**

The splash transition, real status-bar plugin calls, haptics, the share sheet,
push delivery and the hardware back button are written and typechecked but have
never run on a device. Treat §3 as untested until you have an Android SDK.

---

## 11. Shipping checklist

1. Install JDK 21 + Android SDK, produce a signed AAB (§8).
2. Point `CAP_SERVER_URL` at a real HTTPS origin and rebuild — the current config
   is development-shaped by design (§2).
3. Add `google-services.json` for push (§4).
4. Decide the store identity: `appId` is `com.likealocalguide.app` and must be
   the reverse DNS of the domain you ship under. **Changing it after a store
   release publishes a new app rather than updating the old one.**
5. Consider a `values-night` colour resource for the launch window, if the site
   ever gains a dark theme.
