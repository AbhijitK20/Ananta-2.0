# Getting the app, and shipping updates to it

Two separate questions, two separate answers.

1. [How do I get the app onto my phone?](#1-getting-the-app-onto-your-phone)
2. [I pushed to Vercel — how does the installed app get the change?](#2-getting-updates-into-installed-apps)

---

## 1. Getting the app onto your phone

You cannot build the APK on this machine. Two blockers, both environmental:

- **No Android SDK.** `ANDROID_HOME` and `ANDROID_SDK_ROOT` are unset.
- **Java 25 is too new.** Gradle 8.14.3 rejects it with
  `Unsupported class file major version 69`. Capacitor 8's AGP supports up to
  Java 23.

So the APK is built by CI, where both already exist, and you download it.

### Option A — sideload from CI (use this now)

Push to `main`; the **Android APK** workflow runs and produces an artifact.

```bash
git add -A
git commit -m "feat: lal-clone mobile app"
git push origin main
```

Then on the GitHub Actions run page: **Artifacts → local-guide-apk → download**,
unzip, and either

- drag `app-debug.apk` onto a connected phone, or
- `adb install -r app-debug.apk`

Turn on USB debugging on the phone first. You can re-run the workflow by hand
from the **Actions** tab → **Android APK** → **Run workflow**.

This is the right loop for development. Reinstalling takes about 20 seconds.

### Option B — Play Store internal testing (when you want it on real devices)

Internal testing is the right track, not production: uploads are reviewed within
minutes to a couple of hours rather than days, and it is how you get a link
anyone can tap to install.

You need a Google Play developer account (a one-off $25), then a **release**
build rather than a debug one:

1. Create a keystore **outside the repo** and keep it somewhere safe:
   ```bash
   keytool -genkey -v -keystore ~/lal-release.keystore \
     -alias lal -keyalg RSA -keysize 2048 -validity 10000
   ```
2. Add its four values as repository secrets: `ANDROID_KEYSTORE_BASE64`,
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `KEY_PASSWORD`.
3. Wire `signingConfigs` into `android/app/build.gradle` — the commented block
   at the bottom of `.github/workflows/android-apk.yml` has the shape.
4. Change the last step to `./gradlew bundleRelease` and upload the `.aab`.
5. Create the app in the Play console, upload the AAB to **Internal testing**,
   and share the install link.

**Never commit the keystore.** Losing it means you can never update the app
again.

---

## 2. Getting updates into installed apps

### The constraint that makes this work

The site is **fully static** — no API routes, no dynamic rendering, no cookies
or headers, every route prerendered or SSG. That is the precondition for
over-the-air updates, and it is why this approach is available at all. If
someone later adds a server route, the bundle stops being self-contained and
this stops being an option.

### How it works

`@capgo/capacitor-updater` ships the site's compiled HTML, CSS and JavaScript
*inside* the app. On each foreground the app asks a small server whether a newer
bundle exists, downloads the difference, and swaps it in the next time it goes
to the background.

```
git push
   -> Vercel builds and deploys
   -> Vercel deploy hook fires the "Ship web update" workflow
   -> static export + zip, uploaded to Capgo
   -> installed apps check on their next foreground and download it
```

**No app store submission.** A copy change, a new city guide, a new photo, a
style tweak — all of it reaches installed apps in about a minute.

### What does *not* go through this

Anything **native**: a new Capacitor plugin, a new Android permission, an edit to
Kotlin/Java, a change to the app icon. Those live in the APK and need a store
release. An over-the-air bundle carries only web assets, so shipping a native
change this way would produce an app whose binary and whose bundle disagree.

The rule of thumb: **did you touch anything under `android/`? Then rebuild.**

### One-time setup

Both of these are manual and need you; the workflows refuse to run without them
and say so.

**1. A Capgo account and API key**

```bash
cd research/lal-clone
npx @capgo/cli@latest login <YOUR_API_KEY>
npx @capgo/cli@latest add
npx @capgo/cli@latest channel set production public
```

`add` writes `capacitor.appId` and `capacitor.appKey` into `package.json`. That
is where the workflow reads them from.

**2. A Vercel deploy hook**

Vercel dashboard → Project → **Settings → Git → Deploy Hooks → Add**

| Field | Value |
| --- | --- |
| Name | `ship-web-update-to-apps` |
| Branch | `main` (production only) |
| Payload | `{"repository_dispatch": {"types": ["vercel-production-deploy"]}}` |

The payload is what turns a plain POST into a `repository_dispatch` event, which
is what the workflow's trigger listens for. A bare webhook would not match.

Or from the CLI:

```bash
vercel deploy-hook add main \
  --name ship-web-update-to-apps \
  --payload '{"repository_dispatch":{"types":["vercel-production-deploy"]}}'
```

### Verifying the loop

Prove it end to end from cold:

1. Launch the app once, so it has a known-good bundle.
2. Change some copy on a page and push to `main`.
3. Wait for **Ship web update** to go green.
4. Background the app and bring it back.

The change should be there. If it is not, the usual causes are: the deploy hook
payload is wrong (the workflow never fired), the Vercel deploy failed (the hook
has `deploy_status: SUCCESS`, so it will not fire), or the device is on a
different Capgo channel.

### Why the update is not instant

`autoUpdate: true` maps to `atBackground`: the bundle is checked for and
downloaded while the app is idle, and applied the next time the app is
backgrounded. The alternatives are worse for this product — `always` would swap
the code out from under someone mid-task, and `onLaunch` would show a fresh
download on every cold start. For a content site, arriving on the next visit is
invisible, which is the point.

### Rollback

If a bundle breaks, the app reverts to the last known-good one on its next
launch. Capgo watches for `notifyAppReady()`, which `NativeShell` calls after the
first client render commits — a bundle that throws before that never reports
ready and is treated as broken. That is the mechanism, and it is why
`notifyBundleReady()` is wired in rather than left as a TODO.

You can also roll back by hand from the Capgo dashboard, or per-device with the
plugin's `setChannel`.

---

## 3. The three-layer model

Worth internalising, because it is the thing that makes this maintainable:

| Layer | Contains | Ships via | Latency |
| --- | --- | --- | --- |
| **Web** | Copy, images, guides, styles, layout | Capgo OTA | ~1 min, no review |
| **Shell** | Plugins, permissions, native config | APK / AAB to the store | Hours to days |
| **Store** | Binary signing, listing, review | Play Console | Days |

Almost everything you will change is the top layer, and that layer is fast. Reach
for the middle layer when you need a capability the web cannot reach — camera,
push, biometrics — and the bottom one only when the app's identity changes.

---

## 4. Known gaps

- **No APK has been built or run.** Everything in §1 and §2 is unverified at
  runtime; it is written and typechecked, and the CI has never executed. Treat
  the first CI run as the real test.
- **The CI paths assume `research/lal-clone/`** and `main`. Both are easy to
  change but they are assumptions, not configuration.
- **No `google-services.json`**, so push registration resolves `null` and logs a
  note. Expected, and deliberately not on the boot path.
- **Vercel is assumed to deploy `main` to production.** The hook's branch
  setting has to match.
- **Capgo Cloud is a third-party service.** It is open source and can be
  self-hosted, but that is a real piece of infrastructure to own; the 5-minute
  setup is the hosted version.
