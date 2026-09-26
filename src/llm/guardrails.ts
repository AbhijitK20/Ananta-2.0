/**
 * The rails. Everything a model can influence passes through this file, and
 * every rule here is deterministic — a guardrail that itself needs a model is
 * not a guardrail.
 *
 * Layers, outermost first:
 *   1. INPUT      user text is normalised and stripped of injection patterns
 *   2. SCHEMA     model output must satisfy the contract's own zod schema
 *   3. PATCH      the context patch is re-built field by field from an
 *                 allow-list. Unknown keys cannot survive, whatever the model
 *                 said, because the patch is constructed, not merged.
 *   4. SIZE       arrays, strings and whole replies have hard caps. A model
 *                 that wants to return 4,000 interests gets 12.
 *   5. CLAIMS     narration may only state figures that exist in the plan. A
 *                 rupee amount or a duration that is not in the source data is
 *                 an invented fact, so the whole narration is discarded.
 *
 * Layer 1 REPLACES rather than rejects: a traveller who fat-fingers an injection
 * pattern still gets a working answer. Normalisation order (NFKC, then
 * zero-width, then homoglyphs, then patterns) is load-bearing — a Cyrillic "А"
 * otherwise walks straight through an `IMPORTАNT:` check.
 */

import { z } from "zod";
import { AccessNeed, type DialogueDecision } from "../contracts";
import { log } from "./log";

export type Patch = z.infer<typeof DialogueDecision>["contextPatch"];

/** Compile-time checked against the contract, so contract drift is a type error. */
const PATCH_KEYS = [
  "availableMin",
  "budgetMinor",
  "partySize",
  "accessNeeds",
  "interests",
  "avoid",
  "indoorOnly",
  "mood",
] as const satisfies readonly (keyof Patch)[];

// ---------------------------------------------------------------------------
// Layer 1 — input
// ---------------------------------------------------------------------------

export const MAX_USER_TEXT = 2_000;
const ZERO_WIDTH = /[\u200B-\u200D\u2060-\u2064\uFEFF\u00AD\u180E\u034F]/g;
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/**
 * The subset of the 60-entry homoglyph table that matters for ASCII English
 * injection phrases. A full table would be a maintenance liability for no gain:
 * every pattern we match on is English.
 */
const HOMOGLYPH = new Map<string, string>([
  ["\u0410", "A"], ["\u0430", "a"], ["\u0412", "B"], ["\u0415", "E"], ["\u0435", "e"],
  ["\u041A", "K"], ["\u041C", "M"], ["\u041D", "H"], ["\u041E", "O"], ["\u043E", "o"],
  ["\u0420", "P"], ["\u0440", "p"], ["\u0421", "C"], ["\u0441", "c"], ["\u0422", "T"],
  ["\u0423", "Y"], ["\u0443", "y"], ["\u0425", "X"], ["\u0445", "x"],
  ["\u0391", "A"], ["\u03B1", "a"], ["\u0392", "B"], ["\u0395", "E"], ["\u03B5", "e"],
  ["\u0396", "Z"], ["\u0397", "H"], ["\u0399", "I"], ["\u03BA", "k"], ["\u039C", "M"],
  ["\u039D", "N"], ["\u039F", "O"], ["\u03BF", "o"], ["\u03A1", "P"], ["\u03A1", "P"],
  ["\u03A4", "T"], ["\u03A5", "Y"], ["\u03A7", "X"], ["\u0456", "i"], ["\u0458", "j"],
  ["\u0405", "s"], ["\u04CF", "l"], ["\u04B9", "l"], ["\u0261", "g"],
]);

function normalizeForSecurity(input: string): string {
  let out = input.normalize("NFKC");
  out = out.replace(ZERO_WIDTH, "");
  if (HOMOGLYPH.size > 0) {
    out = Array.from(out, (ch) => HOMOGLYPH.get(ch) ?? ch).join("");
  }
  return out;
}

/**
 * Two sources merged. `<\|...\|>` is the sharp one: `<|im_start|>system` is a
 * real attack against an OpenAI-compatible endpoint and no "ignore previous
 * instructions" regex catches it.
 */
const INJECTION: readonly RegExp[] = [
  /<\|[^|]*\|>/g,
  /(?:^|\b)(?:IMPORTANT|URGENT|SYSTEM|ADMIN|ROOT)\s*:/gi,
  /\b(?:ignore|disregard|forget)\s+(?:all\s+)?(?:the\s+)?(?:previous|prior|above|earlier)\s+(?:instructions?|prompts?|rules?)/gi,
  /\boverride\s+(?:all\s+)?(?:the\s+)?(?:system\s+)?(?:prompts?|instructions?|rules?)/gi,
  /\byou\s+are\s+now\s+(?:a|an|the)\b/gi,
  /\b(?:invoke|call|execute|run)\s+(?:the\s+)?(?:tool|function|command)\b/gi,
  /```(?:json|js|javascript|ts)?[\s\S]*?```/g,
  /\[system\]/gi,
  /\{\{[^}]*\}\}/g,
];

/** Fresh instances: a shared /g regex carries `lastIndex` between calls. */
function fresh(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags);
}

export function hasInjectionRisk(input: string): boolean {
  if (typeof input !== "string" || input.length === 0) return false;
  const normalized = normalizeForSecurity(input);
  return INJECTION.some((re) => fresh(re).test(normalized));
}

/** Returns display-safe text for a prompt, plus whether anything was stripped. */
export function sanitizeUserText(input: unknown, maxLength = MAX_USER_TEXT): { text: string; filtered: boolean } {
  if (typeof input !== "string") return { text: "", filtered: false };
  let out = normalizeForSecurity(input).replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  let filtered = false;
  for (const re of INJECTION) {
    const next = out.replace(fresh(re), " [filtered] ");
    if (next !== out) filtered = true;
    out = next;
  }
  return { text: out.slice(0, maxLength), filtered };
}

// ---------------------------------------------------------------------------
// Layer 3 + 4 — the context patch
// ---------------------------------------------------------------------------

export const LIMITS = {
  availableMin: { min: 15, max: 1_440 },
  budgetMinor: { min: 0, max: 100_000_000 },
  partySize: { min: 1, max: 40 },
  listItems: 12,
  itemChars: 40,
  moodChars: 140,
  replyChars: 400,
  suggestionItems: 4,
  suggestionChars: 48,
} as const;

function clampInt(value: unknown, min: number, max: number): number | undefined {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** Lowercase, trimmed, de-duplicated, capped. Never throws. */
export function cleanList(value: unknown, limit: number = LIMITS.listItems, maxChars: number = LIMITS.itemChars): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    // `_` is KEPT, and that is load-bearing. This product's retrieval vocabulary is
    // underscore-separated on purpose: `features/discovery/actions.ts` sends
    // `kid_friendly`, `street_food` and `music_live`, and FEATURES §4 specifies
    // `interests += ['family','kid_friendly']`. Stripping `_` to a space here made
    // the SAME term reach the engine spelled two different ways depending on
    // whether the traveller typed it or tapped the chip, which halves recall on
    // exactly the terms the demo leans on.
    const item = raw
      .toLowerCase()
      .replace(/\s+/g, " ")
      .replace(/[^a-z0-9_₹/+&'-]/gi, " ")
      .trim()
      .slice(0, maxChars);
    if (item && !out.includes(item)) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

function cleanAccessNeeds(value: unknown): AccessNeed[] {
  if (!Array.isArray(value)) return [];
  // The contract's enum is camelCase ("lowStairs"), so matching is
  // case-insensitive but the CANONICAL spelling is what gets written back.
  const canonical = new Map(AccessNeed.options.map((n) => [n.toLowerCase(), n]));
  const out: AccessNeed[] = [];
  for (const raw of value) {
    if (typeof raw !== "string") continue;
    const need = canonical.get(raw.trim().toLowerCase());
    if (need && !out.includes(need)) out.push(need);
  }
  return out;
}

/**
 * Strict-schema DTO -> the contract's optional `Patch`.
 *
 * `@ai-sdk/openai-compatible` sends our zod schema as `json_schema` with
 * `strict: true`, and strict requires every property to be listed in `required`
 * and spelled `["T", "null"]` rather than omitted. So the model returns `null` for
 * "no change", and this is where that becomes "no key".
 *
 * It has to happen BEFORE `sanitizePatch`, which reads `null` as a real value —
 * `budgetMinor: null` is the contract's way of saying "clear the budget". A model
 * saying "nothing" must not read as the traveller withdrawing their budget.
 */
export function dtoToPatch(dto: unknown): Patch {
  const out: Record<string, unknown> = {};
  if (dto == null || typeof dto !== "object") return out as Patch;
  for (const [key, value] of Object.entries(dto as Record<string, unknown>)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out as Patch;
}

/**
 * Rebuilds the patch from an allow-list. Nothing is merged in: a key the model
 * invented simply has no branch here, and a value it got wrong is clamped or
 * dropped. This is the function that makes "may only produce a context patch" a
 * property of the code rather than a review comment.
 */
export function sanitizePatch(raw: unknown): Patch {
  const out: Record<string, unknown> = {};
  if (raw == null || typeof raw !== "object") return out as Patch;
  const src = raw as Record<string, unknown>;

  // A field the contract does not declare is a hallucinated field. It is dropped
  // by construction (no branch below reads it) and reported so the failure rate
  // is visible in the logs rather than silently absorbed.
  for (const key of Object.keys(src)) {
    if (!(PATCH_KEYS as readonly string[]).includes(key)) guardTrip("patch.unknown_key", key);
  }

  if (src.availableMin !== undefined) {
    const v = clampInt(src.availableMin, LIMITS.availableMin.min, LIMITS.availableMin.max);
    if (v !== undefined) out.availableMin = v;
  }
  if (src.budgetMinor !== undefined) {
    const v = src.budgetMinor === null ? null : clampInt(src.budgetMinor, LIMITS.budgetMinor.min, LIMITS.budgetMinor.max);
    if (v !== undefined) out.budgetMinor = v;
  }
  if (src.partySize !== undefined) {
    const v = clampInt(src.partySize, LIMITS.partySize.min, LIMITS.partySize.max);
    if (v !== undefined) out.partySize = v;
  }
  if (src.accessNeeds !== undefined) {
    const needs = cleanAccessNeeds(src.accessNeeds);
    if (needs.length > 0) out.accessNeeds = needs;
  }
  if (src.interests !== undefined) {
    const items = cleanList(src.interests);
    if (items.length > 0) out.interests = items;
  }
  if (src.avoid !== undefined) {
    const items = cleanList(src.avoid);
    if (items.length > 0) out.avoid = items;
  }
  if (typeof src.indoorOnly === "boolean") out.indoorOnly = src.indoorOnly;
  if (typeof src.mood === "string" && src.mood.trim()) {
    out.mood = src.mood.toLowerCase().replace(/\s+/g, " ").trim().slice(0, LIMITS.moodChars);
  }

  const patch = out as Patch;
  return patch;
}

/**
 * `next` wins on any field both sides set — the model understands paraphrase,
 * the floor does not. The floor fills every gap, and list fields are unioned, so
 * a constraint the traveller already stated is never dropped by a later turn.
 */
export function mergePatch(base: Patch, next: Patch): Patch {
  const out: Record<string, unknown> = { ...base, ...next };
  if (base.interests || next.interests) out.interests = cleanList([...(base.interests ?? []), ...(next.interests ?? [])]);
  if (base.avoid || next.avoid) out.avoid = cleanList([...(base.avoid ?? []), ...(next.avoid ?? [])]);
  if (base.accessNeeds || next.accessNeeds) {
    out.accessNeeds = cleanAccessNeeds([...(base.accessNeeds ?? []), ...(next.accessNeeds ?? [])]);
  }
  return sanitizePatch(out);
}

/** A patch that changes nothing is not a patch. */
export function isEmptyPatch(patch: Patch): boolean {
  return Object.keys(patch).length === 0;
}

// ---------------------------------------------------------------------------
// Layer 5 — narration claims
// ---------------------------------------------------------------------------

const MONEY_FIGURE = /(?:₹|\$|€|£|rs\.?|inr|usd)\s?(\d[\d,]*(?:\.\d+)?)/gi;
/**
 * `min`/`h` only. A bare `m` is excluded on purpose: "620 m" in a narration is
 * metres, and treating it as 620 minutes would reject a correct sentence.
 */
const DURATION_FIGURE = /\b(\d+(?:\.\d+)?)\s*(min|mins|minute|minutes|hr|hrs|hour|hours|h)\b/gi;
const PERCENT_FIGURE = /\b(\d{1,3})\s*%/g;

const moneyKey = (n: string): string => `money:${n.replace(/,/g, "")}`;
const durationKey = (raw: string, unit: string): string => {
  const per: Record<string, number> = {
    min: 1, mins: 1, minute: 1, minutes: 1,
    hr: 60, hrs: 60, hour: 60, hours: 60, h: 60,
  };
  return `dur:${Math.round(Number(raw) * (per[unit.toLowerCase()] ?? 1))}`;
};

/**
 * Every figure the plan actually contains, expanded into the ways a sentence may
 * legitimately render it: a minute value is also its hour form (`120` -> `2 h`)
 * and, when it is compound, into its parts (`130` -> `2 h 10 min`). Without that
 * expansion the deterministic narration would fail its own check, and a check
 * that the reference implementation fails is a check nobody keeps.
 */
export function groundedFigures(allowed: { moneyMinor?: number[]; minutes?: number[]; percents?: number[] }): Set<string> {
  const out = new Set<string>();
  for (const m of allowed.moneyMinor ?? []) {
    out.add(moneyKey(String(m)));
    const major = m / 100;
    out.add(moneyKey(String(major)));
    out.add(moneyKey(String(Math.round(major))));
  }
  for (const m of allowed.minutes ?? []) {
    out.add(durationKey(String(m), "min"));
    if (m % 60 === 0) out.add(durationKey(String(m / 60), "hr"));
    if (m >= 60) {
      out.add(durationKey(String(Math.floor(m / 60)), "hr"));
      out.add(durationKey(String(m % 60), "min"));
    }
  }
  for (const p of allowed.percents ?? []) out.add(`pct:${Math.round(p)}`);
  return out;
}

/** Money is quoted in major units ("₹1,000" for 100000 paise), so try both. */
export function unsupportedFigures(text: string, allowed: Set<string>): string[] {
  const bad: string[] = [];
  for (const m of text.matchAll(MONEY_FIGURE)) {
    const raw = m[1] ?? "";
    if (!allowed.has(moneyKey(raw))) {
      const asMinor = String(Math.round(Number(raw.replace(/,/g, "")) * 100));
      if (!allowed.has(moneyKey(asMinor))) bad.push(m[0]);
    }
  }
  for (const m of text.matchAll(DURATION_FIGURE)) {
    if (!allowed.has(durationKey(m[1] ?? "", m[2] ?? ""))) bad.push(m[0]);
  }
  for (const m of text.matchAll(PERCENT_FIGURE)) {
    if (!allowed.has(`pct:${m[1]}`)) bad.push(m[0]);
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Layer 4 — prose
// ---------------------------------------------------------------------------

export function capProse(text: unknown, maxChars: number): string {
  if (typeof text !== "string") return "";
  return (
    text
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^[#>\-*_`]{1,6}\s*/gm, "")
      // `_` is NOT stripped, and that is deliberate. This product's own vocabulary
      // is full of intra-word underscores: the discovery editor lowers "less
      // walking" into the `avoid` token `prefers_short_walks`, and a blanket
      // `[*_`]` delete printed "prefersshortwalks" at the traveller. Underscored
      // emphasis surviving from a chat model is a cosmetic risk; corrupting an
      // identifier is a correctness risk, and only one of those can be defended.
      .replace(/[*`#>]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars)
  );
}

export function capSuggestions(value: unknown): string[] {
  return cleanList(value, LIMITS.suggestionItems, LIMITS.suggestionChars);
}

/** Records a guardrail trip. One line, no payload — payloads carry user text. */
export function guardTrip(rule: string, detail?: string): void {
  log.warn("guardrail", { rule, detail: detail?.slice(0, 120) });
}
