/**
 * Applies the saved theme, font scale and motion preference before first paint.
 *
 * Why an inline script rather than a React effect: an effect runs after the
 * browser has already painted, so a dark-mode user gets a full second of
 * bone-white canvas and then a jarring flip. It has to be blocking and inline
 * for exactly that reason, and it is why `layout.tsx` carries a comment saying
 * tokens.css alone cannot express this.
 *
 * The values are read from localStorage, which is a user preference by
 * definition — not a secret, not a token, and not PII. The same reasoning
 * applies to the theme, which is also mirrored onto `data-theme` so CSS can
 * beat the OS preference.
 *
 * THE NONCE. This is the one inline script in the app, and `src/middleware.ts`
 * sets a CSP with no `'unsafe-inline'` in `script-src`, so without a nonce here
 * the browser blocks it and every dark-mode user gets the bone-white flash this
 * component exists to prevent. The nonce is the one Next put on the request
 * header, which is also what it stamps onto its own `<script>` tags.
 */
import { headers } from "next/headers";

const STORAGE_KEY = "travelbuddy:prefs";

type Prefs = {
  theme: "light" | "dark" | "system";
  /** Per-tier font scale multipliers, from the accessibility control. */
  fontScale: { body: number; meta: number; display: number };
  motion: "full" | "reduced";
};

export const DEFAULT_PREFS: Prefs = {
  theme: "system",
  fontScale: { body: 1, meta: 1, display: 1 },
  motion: "full",
};

export async function ThemeScript() {
  // Serialised inline rather than fetched, so it cannot be cached stale and
  // cannot fail to load. Kept deliberately small and dependency-free.
  const script = `(function(){try{
var p=${JSON.stringify(DEFAULT_PREFS)};
var raw=localStorage.getItem(${JSON.stringify(STORAGE_KEY)});
if(raw){var s=JSON.parse(raw);if(s&&typeof s=="object"){p=Object.assign(p,s);if(s.fontScale){p.fontScale=Object.assign(p.fontScale,s.fontScale);}}}
var r=document.documentElement;
var t=p.theme=="system"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):p.theme;
r.setAttribute("data-theme",t);
r.style.setProperty("--fs-scale-body",String(p.fontScale.body));
r.style.setProperty("--fs-scale-meta",String(p.fontScale.meta));
r.style.setProperty("--fs-scale-display",String(p.fontScale.display));
if(p.motion=="reduced"){r.setAttribute("data-motion","reduced");}
}catch(e){}})();`;

  // Reading a request header opts this into dynamic rendering, which the CSP
  // nonce already forces app-wide, so it costs nothing extra.
  const nonce = (await headers()).get("x-nonce") ?? undefined;

  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: script }} />;
}

