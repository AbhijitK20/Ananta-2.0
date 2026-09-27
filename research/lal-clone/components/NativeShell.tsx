"use client";

/**
 * Drives the native shell from inside the web app.
 *
 * Renders nothing. Everything it does is invisible from the DOM: it dismisses
 * the launch screen, repaints the status bar, registers the hardware back
 * button, and asks for a push token.
 *
 * It lives in the root layout rather than in a page so that every one of the
 * site's routes gets the same native behaviour and there is nowhere to forget
 * it. The site has a dozen routes; a per-page mount is a dozen chances to miss
 * one.
 *
 * Inert in a browser: `isNative()` short-circuits, so `npm run dev` and the
 * plain web build behave exactly as they did before any of this existed.
 */

import { useEffect } from "react";

import {
  applyStatusBarTheme,
  hideSplashScreen,
  isNative,
  notifyBundleReady,
  onHardwareBack,
  onPushReceived,
  platform,
  registerForPush,
} from "../lib/native/bridge";

export function NativeShell() {
  useEffect(() => {
    if (!isNative()) return;

    let cancelled = false;

    /**
     * Hide the launch screen once React has actually painted.
     *
     * `launchAutoHide` in capacitor.config.ts is the failsafe for the case where
     * the bundle never executes at all. This is the path that decides when the
     * transition looks right, which is why it waits for a paint rather than a
     * timer -- the globe route in particular has real WebGL work to do before
     * there is anything worth showing.
     */
    const afterPaint = requestAnimationFrame(() => {
      void hideSplashScreen();
      // Paired with the same paint deliberately. The updater treats a bundle that
      // never reports ready as broken and reverts to the last good one, so this
      // has to happen on the first successful commit -- no later, or a runtime
      // error would already have been on screen before we vouched for it.
      void notifyBundleReady();
    });

    const applyTheme = () => {
      if (!cancelled) void applyStatusBarTheme();
    };
    applyTheme();

    /**
     * Android's back button exits the app by default. The webview keeps its own
     * history stack, so delegating to it gives Back the meaning a person
     * expects from a site they have navigated within. Only when there is nothing
     * to go back to does the handler return false and let the app exit.
     */
    const removeBack = onHardwareBack(() => {
      if (window.history.length > 1) {
        window.history.back();
        return true;
      }
      return false;
    });

    const removePush = onPushReceived((notification) => {
      // No in-app inbox. Logged rather than dropped silently so a
      // foreground-delivered push is at least visible during development.
      console.info("[native] push received", notification.id);
    });

    /**
     * Push registration is fire-and-forget and must never gate boot.
     *
     * A fresh checkout has no `google-services.json` and no APNs entitlement, so
     * `null` here is the expected result, not a fault. Anything that treated a
     * push token as required would make the app unbootable without credentials
     * that are deliberately not in version control.
     */
    void registerForPush().then((registration) => {
      if (cancelled) return;
      if (!registration) {
        console.info(`[native] no push token on ${platform()} (credentials not configured)`);
        return;
      }
      console.info(`[native] push registered via ${registration.kind}`);
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(afterPaint);
      removeBack();
      removePush();
    };
  }, []);

  return null;
}
