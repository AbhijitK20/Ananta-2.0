#!/usr/bin/env node
/**
 * Points the native shell at the Next.js server and syncs it.
 *
 * Plain `.mjs` rather than TypeScript so it runs with bare `node` — no build
 * step, no devDependency. This is the one command someone has to be able to run
 * when the app is not working, and that is the worst moment to discover a
 * missing toolchain.
 *
 * Why a script at all rather than a documented `export`: the Capacitor CLI does
 * not read `.env` files, and the server's LAN address is whatever DHCP handed
 * out this morning. Hard-coding it produces a blank app on the first machine
 * that differs from yours, with no error to explain it. The address is
 * discovered at the moment of the sync instead.
 *
 * Usage:
 *   npm run cap:sync                        # auto-detect the LAN address
 *   node tools/cap-sync.mjs android         # one platform only
 *   CAP_SERVER_URL=https://example.com npm run cap:sync
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** 4310, matching the project's own `dev` / `start` scripts. */
const DEFAULT_PORT = process.env.PORT ?? "4310";
const SCHEME = "http";

const NET_SECURITY_CONFIG = join(
  ROOT,
  "android/app/src/main/res/xml/network_security_config.xml",
);

/** Hosts that may always be reached over plain HTTP, for local development. */
const ALWAYS_CLEARTEXT = ["localhost", "127.0.0.1", "10.0.2.2"];

/**
 * The address other devices on the network can reach.
 *
 * `os.networkInterfaces()` alone is not enough: it lists every interface
 * including loopback, docker bridges and virtualbox adapters, and picking the
 * wrong one produces a URL that resolves to nothing from a phone.
 *
 * Order of preference:
 *   1. An explicit CAP_SERVER_URL, because a real deployment is not a guess.
 *   2. The default-route source address. This is the address the kernel would
 *      actually send from, so it is by construction the right one.
 *   3. The first non-internal IPv4 as a last resort.
 */
export function detectLanAddress() {
  if (process.env.CAP_SERVER_URL) return null;

  // `ip route get` reports `src <addr>` for the interface that would carry
  // traffic to the public internet, which is the same interface a phone on the
  // same Wi-Fi can reach. No DNS lookup, no network traffic.
  const route = spawnSync("ip", ["route", "get", "1.1.1.1"], { encoding: "utf8" });
  if (route.status === 0) {
    const match = /src\s+(\d+\.\d+\.\d+\.\d+)/.exec(route.stdout);
    if (match?.[1]) return match[1];
  }

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      const usable =
        address.family === "IPv4" && !address.internal && !address.address.startsWith("172.");
      if (usable) return address.address;
    }
  }
  return null;
}

function serverUrl() {
  if (process.env.CAP_SERVER_URL) {
    console.log(`[cap-sync] using CAP_SERVER_URL=${process.env.CAP_SERVER_URL}`);
    return process.env.CAP_SERVER_URL;
  }

  const address = detectLanAddress();
  if (!address) {
    console.error(
      "[cap-sync] Could not determine a LAN address. Set CAP_SERVER_URL explicitly:\n" +
        "  CAP_SERVER_URL=https://your-host npm run cap:sync",
    );
    process.exit(1);
  }

  const url = `${SCHEME}://${address}:${DEFAULT_PORT}`;
  console.log(`[cap-sync] detected LAN address ${address} -> ${url}`);
  return url;
}

/**
 * Confirms the target is this site before syncing a URL into a native build.
 *
 * A webview pointed at the wrong server is the worst failure mode here,
 * because it produces no error at all: the app launches, renders, and is simply
 * some other site. Non-fatal — syncing before the server is up is legitimate —
 * so this warns and carries on.
 */
async function preflight(url) {
  const reachable = await fetch(url, { redirect: "manual" })
    .then(() => true)
    .catch(() => false);

  if (!reachable) {
    console.warn(
      `[cap-sync] nothing answering at ${url} yet. Fine if you have not started the\n` +
        `           server. Run:  npm run start:lan`,
    );
    return;
  }

  const looksRight = await fetch(`${url}/manifest.webmanifest`)
    .then((r) => (r.ok ? r.text() : ""))
    .then((body) => /local guide/i.test(body))
    .catch(() => false);

  if (!looksRight) {
    console.warn(
      `[cap-sync] WARNING: ${url} is not serving this site.\n` +
        `           The native app would open that instead. Try another port:\n` +
        `             PORT=4400 npm run start:lan && PORT=4400 npm run cap:sync`,
    );
  }
}

/**
 * Allows plain HTTP to the host the webview is about to load, and only that host.
 *
 * Android has blocked cleartext by default since API 28, and Capacitor does not
 * add the permission for you — the `usesCleartextTraffic` injection lives in its
 * Cordova migration path, not the Capacitor one. Without an exception the app
 * loads nothing and logs an opaque ERR_CLEARTEXT_NOT_PERMITTED, which is
 * indistinguishable from the server being down.
 */
function writeCleartextException(url) {
  if (!existsSync(NET_SECURITY_CONFIG)) {
    console.warn("[cap-sync] no network_security_config.xml yet; skipping");
    return;
  }

  if (url.startsWith("https://")) {
    console.log("[cap-sync] target is https; leaving the cleartext allowlist as it is");
    return;
  }

  const host = new URL(url).hostname;
  const hosts = ALWAYS_CLEARTEXT.includes(host) ? ALWAYS_CLEARTEXT : [...ALWAYS_CLEARTEXT, host];
  const entries = hosts
    .map((h) => `        <domain includeSubdomains="false">${h}</domain>`)
    .join("\n");

  const previous = readFileSync(NET_SECURITY_CONFIG, "utf8");
  const pattern =
    /(<domain-config cleartextTrafficPermitted="true">)[\s\S]*?(<\/domain-config>)/;

  // Distinguish "the pattern is missing" from "the allowlist already matches".
  // Comparing before/after text alone conflates them, and a re-sync with the
  // same IP — the common case — reported a false failure.
  if (!pattern.test(previous)) {
    console.warn("[cap-sync] could not find <domain-config> to update; check it by hand");
    return;
  }

  const next = previous.replace(pattern, `$1\n${entries}\n    $2`);
  if (next === previous) {
    console.log(`[cap-sync] cleartext allowlist already lists ${host}`);
    return;
  }

  writeFileSync(NET_SECURITY_CONFIG, next);
  console.log(`[cap-sync] cleartext allowed to ${host} only`);
}

async function main() {
  const platforms = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
  const url = serverUrl();

  await preflight(url);
  writeCleartextException(url);

  const args = ["sync", ...(platforms.length > 0 ? platforms : ["android"])];
  console.log(`[cap-sync] cap ${args.join(" ")}\n`);

  // Passed through the environment rather than written to a file: the address
  // is a property of this machine right now, and anything persisted would be
  // stale by the time someone else ran it.
  const result = spawnSync("npx", ["cap", ...args], {
    stdio: "inherit",
    env: { ...process.env, CAP_SERVER_URL: url },
  });

  if (result.status !== 0) process.exit(result.status ?? 1);

  console.log(
    [
      "",
      "  The app will load " + url,
      "  The phone must be on the same Wi-Fi as this machine.",
      `  Start the server:  PORT=${DEFAULT_PORT} npm run start:lan`,
      "  Then run the app:  npm run cap:run:android",
    ].join("\n"),
  );
}

void main();
