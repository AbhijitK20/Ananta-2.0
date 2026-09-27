/**
 * The one place Capacitor is allowed to be imported.
 *
 * Component code calls these functions and never `@capacitor/*` directly. That
 * is not ceremony, it buys three things:
 *
 *  1. The same module graph runs in a browser. Every native capability here has
 *     a web fallback, so `npm run dev` keeps working and a feature built on top
 *     of `currentPosition()` is not a browser-dead end.
 *  2. The web bundle does not carry native plugin code. Plugins are pulled in
 *     with dynamic `import()` behind a native check, so Next.js never evaluates
 *     them during SSR and a browser never downloads them.
 *  3. Native failure is a value, not an exception. A phone that denies
 *     location, or an emulator with no GPS, is an ordinary condition. Callers
 *     get `null` / `"unavailable"` and can degrade; a rejected promise that
 *     nobody awaits is a silent no-op in production.
 */

import { Capacitor } from "@capacitor/core";

export type Platform = "web" | "ios" | "android";

/**
 * The site is light-only — `--lal-bg: #fff` with no dark-mode block — so the
 * native chrome is light too. Exported rather than hard-coded at each call site
 * because the splash screen, the status bar and the web manifest all have to
 * agree with this one value, and three copies of `#fff` is three chances to
 * drift.
 */
export const CANVAS = "#ffffff";
export const INK = "#251e20";

export function platform(): Platform {
  const p = Capacitor.getPlatform();
  return p === "ios" || p === "android" ? p : "web";
}

export function isNative(): boolean {
  return platform() !== "web";
}

/**
 * Awaits a plugin module `import()` only when there is a native shell to import
 * it into. The returned `null` is the signal for the caller to take its web
 * path, which keeps the fallback decision at the call site where it is readable.
 *
 * Returns the whole module rather than a single plugin because the enums that
 * parameterise calls (`ImpactStyle.Light`, `StatusBar.Style.Dark`) live
 * alongside the plugin. Handing back the module means a caller can reach both
 * from one narrowed value.
 */
async function nativeModule<T>(load: () => Promise<T>): Promise<T | null> {
  if (!isNative()) return null;
  try {
    return await load();
  } catch (error) {
    // A plugin that fails to load is a broken build, not a runtime condition.
    // Surfacing it here beats every call site catching the same error.
    console.error("[native] plugin failed to load", error);
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Geolocation
 * ------------------------------------------------------------------ */

export type Coords = {
  latitude: number;
  longitude: number;
  /** Metres. A fix is only useful for distance maths if this is known. */
  accuracy: number;
};

export type Permission = "granted" | "denied" | "prompt";

function toCoords(raw: {
  coords: { latitude: number; longitude: number; accuracy: number | null };
}): Coords {
  return {
    latitude: raw.coords.latitude,
    longitude: raw.coords.longitude,
    // A null accuracy means "unknown", which is not the same as zero-metre
    // accuracy. Coercing it to 0 would make an unknown fix look perfect and
    // would win every distance comparison.
    accuracy: raw.coords.accuracy ?? Number.POSITIVE_INFINITY,
  };
}

export async function requestLocationPermission(): Promise<Permission> {
  if (isNative()) {
    const mod = await nativeModule(() => import("@capacitor/geolocation"));
    if (!mod) return "denied";
    const status = await mod.Geolocation.checkPermissions();
    if (status.location === "granted") return "granted";
    const asked = await mod.Geolocation.requestPermissions();
    return asked.location as Permission;
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) {
    return "denied";
  }
  // The Permissions API is Chromium-only. Where it is missing, "prompt" is the
  // honest answer: the browser may still grant on first use.
  if (!navigator.permissions?.query) return "prompt";
  try {
    const result = await navigator.permissions.query({ name: "geolocation" });
    return result.state as Permission;
  } catch {
    return "prompt";
  }
}

/**
 * One-shot fix. Resolves `null` when permission is absent or the platform
 * refuses -- callers should fall back to a chosen city rather than block.
 */
export async function currentPosition(): Promise<Coords | null> {
  if (isNative()) {
    const mod = await nativeModule(() => import("@capacitor/geolocation"));
    if (!mod) return null;
    try {
      // 10s timeout rather than the platform default: a person who has just
      // opened the app is waiting, and a fix that has not landed by then is
      // not going to arrive in time to be worth the wait.
      return toCoords(
        await mod.Geolocation.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 10_000,
        }),
      );
    } catch {
      return null;
    }
  }

  // `navigator.geolocation` is gated on a secure context. In a browser that is
  // https or localhost, so the fallback works. Inside the native shell pointed
  // at a plain-http LAN origin it does not, which is why the native branch
  // above exists rather than delegating to the browser.
  if (typeof navigator === "undefined" || !navigator.geolocation) return null;
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toCoords(pos)),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  });
}

/**
 * Subscribes to position updates. Returns an unsubscribe function.
 *
 * The native path is asynchronous even to get started, so this cannot be
 * `async` -- a React effect has to be able to return its own teardown. The
 * cancellation flag covers the window between calling this and the plugin
 * module arriving, during which an unmount would otherwise leak a live watcher.
 */
export function watchPosition(
  onPosition: (coords: Coords) => void,
  onError?: () => void,
): () => void {
  if (isNative()) {
    let watchId: string | null = null;
    let cancelled = false;

    void nativeModule(() => import("@capacitor/geolocation")).then((mod) => {
      if (!mod || cancelled) return;
      mod.Geolocation.watchPosition({ enableHighAccuracy: true }, (position) => {
        // The plugin hands back null when it has a listener attached but no fix
        // yet, which is normal on a cold start rather than an error.
        if (position) onPosition(toCoords(position));
      }).then(
        (id) => {
          // The id arrives after the caller may already have torn down.
          if (cancelled) void mod.Geolocation.clearWatch({ id });
          else watchId = id;
        },
        () => onError?.(),
      );
    });

    return () => {
      cancelled = true;
      if (watchId !== null) {
        void nativeModule(() => import("@capacitor/geolocation"))
          .then((mod) => mod?.Geolocation.clearWatch({ id: watchId! }))
          .catch(() => {});
      }
    };
  }

  if (typeof navigator === "undefined" || !navigator.geolocation) return () => {};
  const id = navigator.geolocation.watchPosition(
    (pos) => onPosition(toCoords(pos)),
    () => onError?.(),
    { enableHighAccuracy: true },
  );
  return () => navigator.geolocation.clearWatch(id);
}

/* ------------------------------------------------------------------ *
 * Haptics
 * ------------------------------------------------------------------ */

/**
 * Fire-and-forget by design. Haptics are decoration, so a device without a
 * vibrator, or a user who has turned haptics off in system settings, must not
 * interrupt the interaction that triggered them.
 */
export async function tapFeedback(): Promise<void> {
  if (!isNative()) return;
  const mod = await nativeModule(() => import("@capacitor/haptics"));
  if (!mod) return;
  // ImpactStyle is a string enum, so the literal "LIGHT" is not assignable --
  // the enum member is the only way to name the value in a typed way.
  await mod.Haptics.impact({ style: mod.ImpactStyle.Light }).catch(() => {});
}

export async function outcomeFeedback(outcome: "success" | "warning"): Promise<void> {
  if (!isNative()) return;
  const mod = await nativeModule(() => import("@capacitor/haptics"));
  if (!mod) return;
  await mod.Haptics.notification({
    type:
      outcome === "success" ? mod.NotificationType.Success : mod.NotificationType.Warning,
  }).catch(() => {});
}

/* ------------------------------------------------------------------ *
 * Share
 * ------------------------------------------------------------------ */

export type SharePayload = { title?: string; text?: string; url?: string };

export type ShareResult = "shared" | "dismissed" | "unavailable";

/**
 * The native sheet on a device, `navigator.share` in a browser, and a no-op
 * where neither exists. The third case is real: iOS Safari only exposes
 * `navigator.share` from a user gesture, and desktop Firefox has no share
 * target worth showing.
 */
export async function share(payload: SharePayload): Promise<ShareResult> {
  if (isNative()) {
    const mod = await nativeModule(() => import("@capacitor/share"));
    if (!mod) return "unavailable";
    try {
      await mod.Share.share({
        title: payload.title,
        text: payload.text,
        url: payload.url,
        dialogTitle: payload.title,
      });
      return "shared";
    } catch {
      // Capacitor 8 has no cancellation value: the Android plugin rejects with
      // "Share canceled" when the sheet is dismissed, and iOS rejects the call
      // the same way. A resolved result carries only the chosen component's
      // package name, so there is nothing in it to compare against -- the
      // rejection IS the cancellation signal.
      return "dismissed";
    }
  }

  if (typeof navigator === "undefined" || !navigator.share) return "unavailable";
  try {
    await navigator.share(payload);
    return "shared";
  } catch (error) {
    // AbortError means the person closed the sheet, which is a normal outcome
    // and not an error worth reporting.
    if (error instanceof DOMException && error.name === "AbortError") return "dismissed";
    return "unavailable";
  }
}

/* ------------------------------------------------------------------ *
 * Push notifications
 * ------------------------------------------------------------------ */

export type PushRegistration = {
  /** FCM registration token on Android, APNs device token on iOS. */
  token: string;
  kind: "fcm" | "apns";
};

/**
 * Resolves `null` when the platform is not configured. Android needs a
 * `google-services.json` and iOS needs an `aps-environment` entitlement before
 * a token exists, and neither is in version control -- so "no token" is the
 * expected state on a fresh checkout, not a failure.
 */
export async function registerForPush(): Promise<PushRegistration | null> {
  const mod = await nativeModule(() => import("@capacitor/push-notifications"));
  if (!mod) return null;
  const { PushNotifications } = mod;

  try {
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive !== "granted") {
      permission = await PushNotifications.requestPermissions();
    }
    if (permission.receive !== "granted") return null;
  } catch {
    return null;
  }

  // A cold start with no listener attached drops the token, so the listener has
  // to be in place before register() resolves -- which is why this awaits a
  // wrapper rather than doing add-then-register.
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: PushRegistration | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    void PushNotifications.addListener("registration", (token: { value: string }) => {
      void PushNotifications.removeAllListeners();
      finish({ token: token.value, kind: platform() === "ios" ? "apns" : "fcm" });
    });
    // If the token never arrives, the app must still boot. Failing to resolve
    // here would leave every caller awaiting forever.
    setTimeout(() => finish(null), 10_000);
    PushNotifications.register().catch(() => finish(null));
  });
}

/** Subscribes to pushes that arrive while the app is open. */
export function onPushReceived(
  handler: (notification: { id: string; title?: string; body?: string }) => void,
): () => void {
  const load = async () => {
    const mod = await nativeModule(() => import("@capacitor/push-notifications"));
    if (!mod) return () => {};
    const listener = await mod.PushNotifications.addListener(
      "pushNotificationReceived",
      (n) => {
        handler({ id: String(n.id ?? ""), title: n.title, body: n.body });
      },
    );
    return () => void listener.remove();
  };
  let cleanup: (() => void) | null = null;
  let cancelled = false;
  void load().then((fn) => {
    if (cancelled) fn();
    else cleanup = fn;
  });
  return () => {
    cancelled = true;
    cleanup?.();
  };
}

/* ------------------------------------------------------------------ *
 * Over-the-air updates
 * ------------------------------------------------------------------ */

/**
 * Tells the updater that this bundle booted successfully.
 *
 * **This is not optional and not cosmetic.** The updater watches for this call;
 * a bundle that never makes it is treated as broken and the app is rolled back
 * to the last known-good bundle on the next launch. So calling it too early is
 * how you ship a broken release, and not calling it at all is how every release
 * silently reverts.
 *
 * Call it once the first client render has committed, which is the earliest
 * moment a runtime error in the bundle would already have surfaced.
 */
export async function notifyBundleReady(): Promise<void> {
  const mod = await nativeModule(() => import("@capgo/capacitor-updater"));
  await mod?.CapacitorUpdater.notifyAppReady().catch(() => {});
}

/**
 * Reports the bundle the app is currently running, and whether the native shell
 * is the source of it.
 *
 * Exported so the UI can be honest about where the code came from — a
 * "new version available, restart to update" affordance beats letting the app
 * change under someone mid-task with no indication.
 *
 * `native: true` means the built-in bundle is live, i.e. no over-the-air update
 * has been applied yet on this device.
 */
export async function currentBundle(): Promise<{ version: string; isNative: boolean } | null> {
  const mod = await nativeModule(() => import("@capgo/capacitor-updater"));
  if (!mod) return null;
  try {
    const result = await mod.CapacitorUpdater.current();
    return { version: result.bundle.version, isNative: result.native === "true" };
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Native chrome
 * ------------------------------------------------------------------ */

/**
 * Hides the launch screen. Call this after the first client render commits.
 *
 * `launchAutoHide` in capacitor.config.ts is the failsafe for a bundle that
 * never executes at all; this is the call that times the transition correctly.
 */
export async function hideSplashScreen(): Promise<void> {
  const mod = await nativeModule(() => import("@capacitor/splash-screen"));
  if (!mod) return;
  await mod.SplashScreen.hide({ fadeOutDuration: 200 }).catch(() => {});
}

/**
 * Repaints the status bar to match the page.
 *
 * The status bar is a native view above the webview, so it cannot inherit the
 * page's background or theme. Left alone it stays whatever colour the shell was
 * built with, which shows as a bar framing an app it does not match.
 * `overlaysWebView: false` already seats the webview below it on Android, so
 * this is mostly about keeping the two in step if the site ever gains a dark
 * theme.
 */
export async function applyStatusBarTheme(): Promise<void> {
  const mod = await nativeModule(() => import("@capacitor/status-bar"));
  if (!mod) return;
  const { StatusBar, Style } = mod;
  try {
    // Style.Dark means dark *content*, not a dark background. The naming is
    // inverted from intuition, so it is worth stating: on a white background the
    // icons have to be dark, and that is the Style.Dark case.
    await StatusBar.setStyle({ style: Style.Dark });
    if (platform() === "android") {
      // Matches --lal-bg. Duplicated from capacitor.config.ts because a plugin
      // call needs a runtime value and the config is evaluated in another process.
      await StatusBar.setBackgroundColor({ color: CANVAS });
    }
  } catch {
    // Some devices refuse the background colour under their system theme.
    // The style flag has already been applied, so this is cosmetic at worst.
  }
}

/**
 * Android's back button exits the app by default. Register a handler to
 * override that when there is in-app state to unwind first -- on this site that
 * is chiefly the burger menu, which overlays the page rather than navigating.
 *
 * Return `true` from the handler to keep the app open; return `false` to fall
 * through to the default exit.
 */
export function onHardwareBack(handler: () => boolean): () => void {
  if (platform() !== "android") return () => {};
  const load = async () => {
    const mod = await nativeModule(() => import("@capacitor/app"));
    if (!mod) return () => {};
    const listener = await mod.App.addListener("backButton", () => {
      if (!handler()) mod.App.exitApp();
    });
    return () => void listener.remove();
  };
  let cleanup: (() => void) | null = null;
  let cancelled = false;
  void load().then((fn) => {
    if (cancelled) fn();
    else cleanup = fn;
  });
  return () => {
    cancelled = true;
    cleanup?.();
  };
}

/** True when the app is running in the native shell rather than a browser tab. */
export const runningInNativeShell = isNative();
