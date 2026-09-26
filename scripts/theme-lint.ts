/**
 * theme:lint — fails on any colour literal outside the token layer.
 *
 * docs/DESIGN_SYSTEM.md §6: "a design system without a gate is a mood board".
 * The reference clone we took the token guarantee from had exactly one inline
 * hex appear in it, and the whole guarantee decayed the week nobody checked.
 *
 * What it checks:
 *   1. hex literals        — only src/styles/tokens.css may contain them
 *   2. raw token leakage   — `--raw-*` is private to tokens.css
 *   3. banned type faces   — Inter / Roboto / Open Sans / Playfair
 *   4. banned radius       — `rounded-full` on a container class
 *   5. transition: all     — named properties only
 *   6. bare z-index        — must come from the named scale
 *   7. token name typos    — catches a `--colour-accent` that silently misses
 *
 * Exit codes: 0 clean, 1 violations found, 2 bad invocation.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const TOKENS_FILE = join("src", "styles", "tokens.css");

/** Directories never scanned. Third-party and generated. */
const IGNORED_DIRS = new Set([
  "node_modules",
  ".next",
  ".git",
  "out",
  "build",
  "dist",
  "coverage",
  "research",
  "data",
  // Agent tooling, not app source. Its hex-looking strings are issue numbers.
  ".opencode",
  ".github",
  "graphify-out",
  "graphify-systems-out",
]);

/**
 * The linter is exempt from itself. Its source necessarily contains every
 * banned string it looks for, so scanning it would report its own
 * documentation as a violation on every run. Every linter does this.
 */
const SELF = relative(ROOT, resolve(import.meta.filename));

const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css"]);

/**
 * Hex in any of its spellings: #rgb, #rgba, #rrggbb, #rrggbbaa.
 * Anchored so it does not fire on an id selector (`#root`) or a URL fragment.
 */
const HEX_RE = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g;

/**
 * Functional colour literals. `rgb(0 0 0 / 0.4)` is as much a hardcoded colour
 * as a hex, and it is the obvious way to route around this linter. The only
 * legal ones are in tokens.css.
 */
const FN_COLOR_RE = /\b(?:rgba?|hsla?|oklch|oklab|lab|lch|color-mix|color)\s*\(/g;

/**
 * Banned faces. DESIGN_SYSTEM §2: Display is explicitly NOT Playfair, and
 * Geist Sans is chosen precisely because it bans Inter / Roboto / Open Sans.
 * A banned face reintroduces every association the palette works to avoid.
 */
const BANNED_FACES = [
  { name: "Inter", re: /(["'`])Inter\1/gi },
  { name: "Roboto", re: /(["'`])Roboto\1/gi },
  { name: "Open Sans", re: /(["'`])Open Sans\1/gi },
  { name: "Playfair", re: /(["'`])Playfair(?: Display)?\1/gi },
];

/**
 * `transition: all` is banned outright. It animates properties the author did
 * not intend, which is how a 180ms entrance turns into a 180ms reflow.
 */
const TRANSITION_ALL_RE = /transition(?:-property)?\s*:\s*all\b/gi;

/**
 * A bare numeric z-index. Legitimate values are 0, or one of the named steps.
 * Anything else means the author reached for a magic number instead of the
 * scale in tokens.css.
 */
const BARE_Z_RE = /(?:^|[\s;{])z-index\s*:\s*(-?\d+)/gi;

const NAMED_Z = new Set([0, 10, 20, 30, 40, 50, 60, 70]);

/**
 * `rounded-full` is banned on containers — pills and icon buttons only. The
 * heuristic: a full radius is fine when the element is small and round, and
 * wrong the moment it wraps a block of content. We flag it on the classes that
 * take content and ignore it on buttons/badges/dots.
 */
const FULL_RADIUS_OK_RE =
  /(rounded-full[^\n]*$)|(^\s*(?:rounded-full)\b)/; // bare usage, flagged below
const FULL_RADIUS_CONTAINER_RE = /\brounded-full\b(?![^\n]*\b(?:rounded-full\s+group|group\b))/gi;

/** Tokens the app is allowed to reference. Typos in here are the failure mode
 *  this list exists to catch: `--colour-accent` compiles to nothing. */
const KNOWN_TOKENS = new Set([
  // raw layer, private to tokens.css
  "raw-canvas", "raw-surface", "raw-ink", "raw-ink-muted", "raw-ink-faint", "raw-rule",
  "raw-accent", "raw-accent-soft", "raw-alarm", "raw-alarm-soft", "raw-fit", "raw-fit-soft",
  "raw-warn", "raw-warn-soft", "raw-info", "raw-info-soft", "raw-ink-dark", "raw-surface-dark",
  "raw-canvas-dark", "raw-ink-muted-dark", "raw-ink-faint-dark", "raw-rule-dark",
  "raw-accent-dark", "raw-accent-soft-dark", "raw-alarm-dark", "raw-alarm-soft-dark",
  "raw-fit-dark", "raw-fit-soft-dark", "raw-warn-dark", "raw-warn-soft-dark",
  "raw-info-dark", "raw-info-soft-dark", "raw-shadow-1", "raw-shadow-2", "raw-scrim",
  "raw-focus", "raw-shadow-1-dark", "raw-shadow-2-dark", "raw-scrim-dark", "raw-focus-dark",
  // semantic colour
  "canvas", "surface", "ink", "ink-muted", "ink-faint", "rule", "accent", "accent-soft",
  "alarm", "alarm-soft", "fit", "fit-soft", "warn", "warn-soft", "info", "info-soft",
  "shadow-1", "shadow-2", "scrim", "focus", "ink-inverse", "on-accent", "on-alarm", "on-fit",
  // type
  "font-display", "font-ui", "font-data", "fs-root", "fs-scale-body", "fs-scale-meta",
  "fs-scale-display", "fs-scale-num", "fs-body", "fs-body-lg", "fs-meta", "fs-meta-sm",
  "fs-num", "fs-num-sm", "fs-display", "fs-display-lg", "fs-title", "lh-tight", "lh-snug",
  "lh-body", "lh-loose", "tracking-caps", "tracking-tight",
  // space + radius
  "space-1", "space-2", "space-3", "space-4", "space-5", "space-6", "space-8", "space-10",
  "space-12", "space-16", "radius-sm", "radius-md", "radius-lg", "radius-pill",
  "border-hairline", "border-strong",
  // z
  "z-base", "z-sticky", "z-overlay", "z-dropdown", "z-modal", "z-toast", "z-map-marker",
  "z-map-popup", "map-z",
  // motion
  "ease-out-soft", "ease-in-out", "ease-feedback", "dur-fast", "dur-base", "dur-feedback",
  "skeleton-min",
  // layout
  "focus-ring-width", "focus-ring-offset", "tap-target-min", "measure-prose",
]);

/** The var() reference form, both spellings. */
const TOKEN_REF_RE = /var\(\s*(--[a-zA-Z0-9-]+)/g;

type Violation = {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
  excerpt: string;
};

function* walk(dir: string): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (IGNORED_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) yield* walk(full);
    else if (SCANNED_EXTENSIONS.has(extname(entry))) yield full;
  }
}

function excerptAt(source: string, index: number): string {
  const start = source.lastIndexOf("\n", index) + 1;
  const end = source.indexOf("\n", index);
  return source.slice(start, end === -1 ? undefined : end).trim();
}

function lineAndColumn(source: string, index: number): { line: number; column: number } {
  const before = source.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1) + 1;
  return { line, column };
}

/**
 * HEX_RE already constrains the match to hex digits, so `#root`, `#app` and
 * `#main` never match in the first place — `r`, `o`, `t` are not hex digits.
 * The only remaining ambiguity is a short all-numeric run, which is either a
 * 3/4-digit colour or a GitHub issue reference. There is no way to tell those
 * apart from the text alone, so we treat the numeric run as a colour and rely
 * on `.github/` and `.opencode/` being out of scope.
 */
function isHexMatch(text: string, source: string, index: number): boolean {
  // Not a colour if it is part of a longer identifier, e.g. `foo#bar` or a URL
  // fragment immediately followed by more path characters.
  const before = source[index - 1];
  if (before !== undefined && /[\w-]/.test(before)) return false;
  return true;
}

function lintFile(path: string): Violation[] {
  const rel = relative(ROOT, path);
  if (rel === SELF) return [];
  const isTokens = rel === TOKENS_FILE;
  const source = readFileSync(path, "utf8");
  const out: Violation[] = [];

  const push = (index: number, rule: string, message: string) => {
    const { line, column } = lineAndColumn(source, index);
    out.push({ file: rel, line, column, rule, message, excerpt: excerptAt(source, index) });
  };

  // 1 + 2. colour literals and raw-token leakage
  if (!isTokens) {
    for (const m of source.matchAll(HEX_RE)) {
      const index = m.index ?? 0;
      if (!isHexMatch(m[0], source, index)) continue;
      push(
        index,
        "no-hex-outside-tokens",
        `Colour literal \`${m[0]}\` outside ${TOKENS_FILE}. Use a semantic token, ` +
          `e.g. var(--accent), var(--alarm), var(--fit).`,
      );
    }
    for (const m of source.matchAll(FN_COLOR_RE)) {
      // `color-mix` and `color(` are also legitimate in a token reference, but
      // outside tokens.css they are a bypass. Flag them.
      push(
        m.index ?? 0,
        "no-fn-color-outside-tokens",
        `Functional colour \`${m[0]}\` outside ${TOKENS_FILE}. Compose the colour in ` +
          `tokens.css and reference the resulting token.`,
      );
    }
    for (const m of source.matchAll(/var\(\s*(--raw-[\w-]+)/g)) {
      push(
        m.index ?? 0,
        "no-raw-token-outside-tokens",
        `\`${m[1]}\` is private to ${TOKENS_FILE}. Reference the semantic token instead.`,
      );
    }
  }

  // 3. banned faces
  for (const face of BANNED_FACES) {
    for (const m of source.matchAll(face.re)) {
      push(
        m.index ?? 0,
        "banned-typeface",
        `\`${face.name}\` is banned. DESIGN_SYSTEM §2: Display is Instrument Serif, ` +
          `UI is Geist Sans. Both are chosen to avoid exactly this face.`,
      );
    }
  }

  // 4. full radius on a container
  if (!isTokens) {
    for (const m of source.matchAll(FULL_RADIUS_CONTAINER_RE)) {
      const line = excerptAt(source, m.index ?? 0);
      const isButtonOrPill =
        /\b(?:Button|button|Badge|badge|Dot|dot|Pill|pill|Chip|chip|IconButton|Toggle)\b/.test(line) ||
        /\brounded-full\b[^\n]*\b(?:w|h)-full\b/.test(line) ||
        /\baspect-square\b/.test(line);
      if (isButtonOrPill) continue;
      push(
        m.index ?? 0,
        "rounded-full-on-container",
        "`rounded-full` is for pills and icon buttons only (DESIGN_SYSTEM §2). " +
          "A container wrapping content must use --radius-sm/md/lg.",
      );
    }
  }

  // 5. transition: all
  for (const m of source.matchAll(TRANSITION_ALL_RE)) {
    push(
      m.index ?? 0,
      "no-transition-all",
      "`transition: all` animates properties you did not name. List them, or use " +
        "one of the --dur-* tokens.",
    );
  }

  // 6. bare z-index
  for (const m of source.matchAll(BARE_Z_RE)) {
    const value = Number(m[1]);
    if (NAMED_Z.has(value)) continue;
    push(
      m.index ?? 0,
      "bare-z-index",
      `\`z-index: ${value}\` is off the named scale. Use one of ` +
        `${[...NAMED_Z].join(", ")} — i.e. var(--z-dropdown) etc.`,
    );
  }

  // 7. unknown token names
  for (const m of source.matchAll(TOKEN_REF_RE)) {
    const name = (m[1] ?? "").slice(2);
    if (name.length === 0) continue;
    if (KNOWN_TOKENS.has(name)) continue;
    // Tailwind and MapLibre define their own custom properties. Anything namespaced
    // by another library is out of our token layer and not our business.
    if (name.startsWith("maplibre-") || name.startsWith("tw-")) continue;
    push(
      m.index ?? 0,
      "unknown-token",
      `\`--${name}\` is not a token in ${TOKENS_FILE}. An undefined custom property ` +
        `silently resolves to nothing, so this would be an invisible bug.`,
    );
  }

  return out;
}

function main(): number {
  const args = process.argv.slice(2);
  const asJson = args.includes("--json");
  const watch = args.includes("--watch");

  const collect = (): Violation[] => {
    const all: Violation[] = [];
    for (const file of walk(ROOT)) all.push(...lintFile(file));
    return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  };

  const report = (violations: Violation[]): void => {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ ok: violations.length === 0, violations }, null, 2)}\n`);
      return;
    }
    if (violations.length === 0) {
      process.stdout.write("theme:lint clean. No colour literal outside src/styles/tokens.css.\n");
      return;
    }
    const byRule = new Map<string, Violation[]>();
    for (const v of violations) {
      const list = byRule.get(v.rule) ?? [];
      list.push(v);
      byRule.set(v.rule, list);
    }
    process.stdout.write(`\ntheme:lint — ${violations.length} violation(s)\n\n`);
    for (const [rule, list] of [...byRule.entries()].sort()) {
      process.stdout.write(`  ${rule}  (${list.length})\n`);
      for (const v of list) {
        process.stdout.write(`    ${v.file}:${v.line}:${v.column}\n`);
        process.stdout.write(`      ${v.excerpt}\n`);
        process.stdout.write(`      ${v.message}\n\n`);
      }
    }
  };

  if (watch) {
    process.stdout.write("theme:lint --watch. Watching src/ and scripts/.\n");
    const run = (): void => {
      report(collect());
    };
    run();
    let timer: NodeJS.Timeout | undefined;
    for (const dir of ["src", "scripts"]) {
      const full = join(ROOT, dir);
      if (!statSync(full, { throwIfNoEntry: false })) continue;
      statSync(full);
      try {
        // Watch the whole project; the tree is small and the cost is one rescan.
        const { watch: fsWatch } = require("node:fs") as typeof import("node:fs");
        fsWatch(full, { recursive: true }, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(run, 120);
        });
      } catch {
        // Recursive watch is unsupported on some platforms. One-shot is fine.
        break;
      }
    }
    return 0;
  }

  const violations = collect();
  report(violations);
  return violations.length === 0 ? 0 : 1;
}

process.exit(main());
