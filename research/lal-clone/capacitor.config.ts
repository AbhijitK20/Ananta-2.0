import type { CapacitorConfig } from "@capacitor/cli";

/**
 * Capacitor wraps this site in a real native Android/iOS project.
 *
 * appId is the app's permanent identity. Android and iOS both key on it, so
 * changing it after a store release publishes a *new* app rather than updating
 * the old one. It must be the reverse DNS of the domain you ship under.
 */
const appId = process.env.CAPACITOR_APP_ID ?? "com.likealocalguide.app";

/**
 * Where the webview loads from.
 *
 * The site is server-rendered, so the webview has to load a running server --
 * there is no Node runtime inside a mobile webview to render the routes itself.
 *
 *   CAP_SERVER_URL unset -> bundle mode. The shell loads the static assets in
 *                           `public/`. The site's own pages are server-rendered,
 *                           so this only gives a working app once the same site
 *                           is reachable at a real origin the webview can load.
 *   CAP_SERVER_URL set   -> the webview loads that URL instead. This is how you
 *                           develop against a server on your own LAN. Capacitor
 *                           marks both this and `cleartext` as development-only
 *                           in its own docs, so do not ship this mode.
 */
const serverUrl = process.env.CAP_SERVER_URL;
const isLiveServer = Boolean(serverUrl);

/**
 * Matches `--lal-bg` in app/globals.css. The splash screen and the launch
 * window are native views, so they cannot read a CSS custom property -- this is
 * the one place the two layers have to be kept in step. `lib/native/bridge.ts`
 * exports the same value for the runtime plugin calls.
 */
const CANVAS_LIGHT = "#ffffff";

const config: CapacitorConfig = {
  appId,
  appName: "Local Guide",
  // The project already has a public/ directory, so the native shell's static
  // root and Next's static root are the same place. No separate build output to
  // keep in step.
  webDir: "public",

  /**
   * A LAN server is plain HTTP, so the local scheme has to be http as well. Any
   * other value makes Capacitor present the app from an https origin, and the
   * webview then rejects the http subresources as mixed content -- the app
   * renders as a blank screen with only a console error to explain it.
   *
   * `iosScheme` is deliberately left at its default. iOS refuses to register a
   * scheme handler for http or https because the WKWebView already handles them,
   * so setting it here would be a no-op that looks like it did something. An
   * iOS build pointed at a plain-http origin instead needs an ATS exception in
   * Info.plist; see docs/mobile-app.md.
   */
  server: isLiveServer
    ? {
        url: serverUrl,
        // Android has blocked cleartext traffic by default since API 28.
        cleartext: true,
        androidScheme: "http",
      }
    : undefined,

  android: {
    // Lets the release build run `adb` against a debuggable app. Debug only.
    webContentsDebuggingEnabled: false,
    allowMixedContent: false,
  },

  plugins: {
    /**
     * Over-the-air updates. See docs/updates.md for the whole pipeline.
     *
     * `atBackground` (the value `true` maps to) is the deliberate choice: the
     * bundle is checked for and downloaded while the app is idle, and applied
     * the next time it goes to the background. `always` would swap the code out
     * under someone mid-task, and `onLaunch` would show a fresh download on
     * every cold start. For a content site, arriving on the next visit is
     * invisible, which is the point.
     *
     * `autoSplashscreen` stays off because NativeShell already owns the splash
     * and dismisses it after the first paint. Two owners for one screen is how
     * you get a splash that never goes away.
     */
    CapacitorUpdater: {
      autoUpdate: true,
      autoSplashscreen: false,
      // The native shell serves the site's own routes, so a reload should land
      // on the root rather than trying to restore a deep path the bundle has no
      // route table for.
      keepUrlPathAfterReload: false,
      // Direct the updater at Capgo Cloud's channel endpoint. Left unset, the
      // plugin uses its default, which is the public Capgo channel.
      // channel: "production",
    },

    SplashScreen: {
      /**
       * Auto-hide is on as a *failsafe*, not as the primary path.
       *
       * NativeShell calls SplashScreen.hide() after React's first paint, which
       * is what actually times the transition. If the bundle never executes --
       * a runtime crash, a failed chunk fetch against a LAN server that dropped
       * off -- nothing would ever dismiss the native splash and the app would
       * sit on a blank white screen with no error, which reads as a hung app.
       * Auto-hide guarantees the webview is revealed within 3s regardless.
       */
      launchAutoHide: true,
      launchShowDuration: 3_000,
      backgroundColor: CANVAS_LIGHT,
      // No spinner: the app renders its own loading state, and two spinners
      // during a cold start is worse than either one alone.
      showSpinner: false,
      androidScaleType: "CENTER_CROP",
    },
    StatusBar: {
      // The status bar is a native view sitting above the webview, so it needs
      // the page colour rather than the web's own background.
      backgroundColor: CANVAS_LIGHT,
      style: "DARK",
      // false so the webview starts below the status bar instead of under it.
      // With overlaysWebView true, the header would sit underneath the clock.
      overlaysWebView: false,
    },
    PushNotifications: {
      /**
       * Registration needs a Firebase `google-services.json` in `android/app/`.
       * Without it registration rejects and NativeShell reports it as a
       * non-fatal note rather than failing boot.
       */
      presentationOptions: ["badge", "sound", "alert"],
    },
  },

  backgroundColor: CANVAS_LIGHT,
};

export default config;
