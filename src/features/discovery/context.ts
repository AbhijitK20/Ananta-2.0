/**
 * The context editor: everything the traveller can change, expressed only in
 * terms the frozen `DiscoveryContext` already has.
 *
 * Three rules, all of them load-bearing:
 *
 *  1. **`original` is never touched.** `DiscoveryContext.original` is the whole
 *     point of principle 3 — the replanner diffs against the intent the
 *     traveller started with, not against the last mutation. `createContext`
 *     writes it once; nothing in this file can write it again.
 *
 *  2. **One classifier.** `classifyChange` is the only place a
 *     `ContextChange.kind` is decided, so a slider, a suggestion chip and a
 *     chat patch can never produce different change kinds for the same edit.
 *
 *  3. **Preference axes that the contract has no field for are lowered into the
 *     open-vocabulary fields it does have.** `indoorOnly`, walking tolerance,
 *     weather sensitivity and mood have no column in `DiscoveryContext`, and
 *     the contract is frozen, so they lower into `avoid` tokens plus
 *     `travelMode`. The tokens are names the engine must honour, and they are
 *     listed in `docs/ARCHITECTURE.md` §9 as the only permitted effect of a
 *     model. Reported as a contract gap in the session hand-off: the honest fix
 *     is three optional fields on `DiscoveryContext`, agreed in standup.
 */
import {
  DiscoveryContext,
  type AccessNeed,
  type ContextChange,
  type DecomposedRequest,
  type DialogueDecision,
  type GeoPoint,
  type Money,
  type WeatherNow,
} from "../../contracts";
import { hm, money, plural } from "./format";

/** A window shorter than this cannot hold travel plus one stop. */
export const FLOOR_MIN = 15;

const rupees = (minor: number): Money => ({ minor, currency: "INR" });

// ---------------------------------------------------------------------------
// Feature-local preference axes, lowered into the contract
// ---------------------------------------------------------------------------

export type WalkingTolerance = "any" | "low" | "minimal";
export type WeatherSensitivity = "ignore" | "normal" | "high";

/** The `avoid` / `travelMode` tokens each preference lowers to. */
export const INDOOR_TOKEN = "indoors_only";
export const WALK_TOKENS: Record<Exclude<WalkingTolerance, "any">, string> = {
  low: "prefers_short_walks",
  minimal: "prefers_no_walks",
};
export const WEATHER_TOKENS: Record<Exclude<WeatherSensitivity, "normal" | "ignore">, string> = {
  high: "weather_averse",
};
const PREF_TOKENS = new Set<string>([
  INDOOR_TOKEN,
  ...Object.values(WALK_TOKENS),
  ...Object.values(WEATHER_TOKENS),
]);

/** Slug for a free-text mood, so "low energy" and "Low  Energy!" agree. */
export const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");

export type DiscoveryPrefs = {
  walking: WalkingTolerance;
  weatherSensitivity: WeatherSensitivity;
  indoorOnly: boolean;
  mood: string | null;
};

export const DEFAULT_PREFS: DiscoveryPrefs = {
  walking: "any",
  weatherSensitivity: "normal",
  indoorOnly: false,
  mood: null,
};

/** The editor's own state: the contract context plus the axes it cannot hold. */
export type EditorState = { ctx: DiscoveryContext; prefs: DiscoveryPrefs };

function prefTokens(prefs: DiscoveryPrefs): string[] {
  const tokens: string[] = [];
  if (prefs.indoorOnly) tokens.push(INDOOR_TOKEN);
  if (prefs.walking !== "any") tokens.push(WALK_TOKENS[prefs.walking]);
  if (prefs.weatherSensitivity === "high") tokens.push(WEATHER_TOKENS.high);
  if (prefs.mood) tokens.push(`mood_${slug(prefs.mood)}`);
  return tokens;
}

/**
 * Idempotent: strips the tokens a previous lowering added, then re-adds the
 * current ones. That is what lets `walking: "low"` be walked back to `"any"`
 * without the traveller's own `avoid` list being mangled.
 */
function lowerPrefs(ctx: DiscoveryContext, prefs: DiscoveryPrefs): DiscoveryContext {
  const kept = ctx.avoid.filter((token) => !PREF_TOKENS.has(token) && !token.startsWith("mood_"));
  const next: DiscoveryContext = {
    ...ctx,
    avoid: [...new Set([...kept, ...prefTokens(prefs)])],
  };
  // Fewer legs on foot is the contract's only lever on walking, so use it.
  if (prefs.walking === "minimal") next.travelMode = "auto";
  else if (prefs.walking === "low" && next.travelMode === "walk") next.travelMode = "auto";
  return next;
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

export type ContextSeed = {
  id: string;
  origin: { label: string; point?: GeoPoint | null };
  availableMin: number;
  nowMin: number;
  budgetMinor?: number | null;
  budgetPerPersonMinor?: number | null;
  partySize?: number;
  childAges?: number[];
  /** Older adults in the party. Drives party type and the access defaults. */
  elderly?: number;
  accessNeeds?: AccessNeed[];
  diets?: string[];
  interests?: string[];
  avoid?: string[];
  weather?: Partial<WeatherNow>;
  travelMode?: DiscoveryContext["travelMode"];
  requests?: DecomposedRequest[];
  excludedIds?: string[];
  pinnedIds?: string[];
  prefs?: Partial<DiscoveryPrefs>;
};

/**
 * `partyType` is derived, never asked: a chip that says "family" and a count of
 * 2 that says `family_with_children` is a contradiction waiting to be rendered.
 */
function derivePartyType(partySize: number, childAges: number[], elderly: number): DiscoveryContext["partyType"] {
  if (childAges.some((age) => age < 12)) return "family_with_children";
  if (childAges.length > 0) return "family_teens";
  if (elderly > 0) return "older_adults";
  if (partySize >= 3) return "friends";
  if (partySize === 2) return "couple";
  return "solo";
}

/** An older adult in the party is a fact about stairs and toilets, not a vibe. */
function accessDefaults(elderly: number): AccessNeed[] {
  return elderly > 0 ? ["lowStairs", "restroom"] : [];
}

/** Ends in `DiscoveryContext.parse`, so a bad seed fails here, not downstream. */
export function createContext(seed: ContextSeed): EditorState {
  const childAges = seed.childAges ?? [];
  const elderly = seed.elderly ?? 0;
  const partySize = seed.partySize ?? 1;
  const accessNeeds = seed.accessNeeds ?? accessDefaults(elderly);
  const budget = seed.budgetMinor === null || seed.budgetMinor === undefined
    ? null
    : rupees(seed.budgetMinor);
  const perPerson = seed.budgetPerPersonMinor === null || seed.budgetPerPersonMinor === undefined
    ? null
    : rupees(seed.budgetPerPersonMinor);

  const ctx: DiscoveryContext = {
    id: seed.id,
    origin: { label: seed.origin.label, point: seed.origin.point ?? null },
    availableMin: Math.max(FLOOR_MIN, Math.round(seed.availableMin)),
    nowMin: seed.nowMin,
    budget,
    budgetPerPerson: perPerson,
    partySize,
    partyType: derivePartyType(partySize, childAges, elderly),
    childAges,
    accessNeeds,
    diets: seed.diets ?? [],
    interests: seed.interests ?? [],
    avoid: seed.avoid ?? [],
    weather: {
      condition: seed.weather?.condition ?? "clear",
      tempC: seed.weather?.tempC ?? 30,
      source: seed.weather?.source ?? "unknown",
    },
    travelMode: seed.travelMode ?? "any",
    requests: seed.requests ?? [],
    excludedIds: seed.excludedIds ?? [],
    pinnedIds: seed.pinnedIds ?? [],
    original: {
      availableMin: Math.max(FLOOR_MIN, Math.round(seed.availableMin)),
      budget,
      partySize,
      accessNeeds,
    },
  };
  const prefs: DiscoveryPrefs = { ...DEFAULT_PREFS, ...seed.prefs };
  return { ctx: lowerPrefs(DiscoveryContext.parse(ctx), prefs), prefs };
}

// ---------------------------------------------------------------------------
// Classification — the single source of truth for `ContextChange.kind`
// ---------------------------------------------------------------------------

const budgetCeiling = (ctx: DiscoveryContext): number => ctx.budget?.minor ?? Number.POSITIVE_INFINITY;

/** Set growth: something is in the new list that was not in the old one. */
function grew(next: readonly string[], prev: readonly string[]): boolean {
  return next.some((item) => !prev.includes(item));
}

/**
 * Everything that is not one of the eight classified axes, for the "something
 * else changed" fallback. Fixed key order, sorted arrays, so the key is stable
 * and the comparison is deterministic.
 *
 * Load-bearing: this key must name EVERY field the planner reads. A field left
 * out is a silent `null` from `classifyChange`, and a `null` means the caller
 * skips the replan — so a traveller who edits that field sees a stale plan. That
 * is how `partySize`, `childAges`, `partyType`, `budgetPerPerson`, `nowMin` and
 * `weather.tempC` were being dropped on the floor.
 */
function preferenceKey(ctx: DiscoveryContext): string {
  return JSON.stringify({
    origin: [ctx.origin.label, ctx.origin.point],
    avoid: [...ctx.avoid].sort(),
    diets: [...ctx.diets].sort(),
    interests: [...ctx.interests].sort(),
    travelMode: ctx.travelMode,
    requests: ctx.requests.map((r) => [r.pos, r.neg, r.mustsee, r.type]),
    pinned: [...ctx.pinnedIds].sort(),
    party: [ctx.partySize, ctx.partyType, [...ctx.childAges].sort()],
    perPersonBudget: ctx.budgetPerPerson?.minor ?? null,
    nowMin: ctx.nowMin,
    tempC: ctx.weather.tempC,
  });
}

/**
 * `null` means "nothing the planner would care about changed", so the caller
 * skips the replan instead of paying for one. `mood_changed` is the frozen
 * enum's catch-all for preference edits (indoor, walking, origin, mood): the
 * enum has no neutral "preference" kind, which is reported as a contract gap.
 *
 * A party that SHRINKS still returns `party_grew`, because that is the only
 * party kind the frozen enum has. The `narrative` carries the truth ("Now 2
 * people"), and the swap diff shows the narrative, so the machine key is a
 * coarser label than the sentence. Returning `null` here would be worse: the
 * traveller would drop a traveller and keep a four-seat booking.
 */
export function classifyChange(
  prev: DiscoveryContext,
  next: DiscoveryContext,
): ContextChange["kind"] | null {
  if (next.availableMin !== prev.availableMin) {
    return next.availableMin < prev.availableMin ? "time_shrank" : "time_grew";
  }
  const before = budgetCeiling(prev);
  const after = budgetCeiling(next);
  if (after !== before) return after < before ? "budget_cut" : "budget_grew";
  if (next.weather.condition !== prev.weather.condition) return "weather_changed";
  if (next.partySize !== prev.partySize) return "party_grew";
  if (grew(next.accessNeeds, prev.accessNeeds)) return "access_need_added";
  if (grew(next.interests, prev.interests)) return "interest_added";
  if (grew(next.excludedIds, prev.excludedIds)) return "became_unavailable";
  if (preferenceKey(next) !== preferenceKey(prev)) return "mood_changed";
  return null;
}

const CONDITION_WORDS: Record<WeatherNow["condition"], string> = {
  clear: "Clear skies",
  cloudy: "Overcast",
  light_rain: "Light rain",
  heavy_rain: "Heavy rain",
  storm: "A storm",
  heat: "Peak heat",
  wind: "High wind",
};

/**
 * Fallback copy for edits that arrive without one — a chat patch, mainly. Every
 * named action supplies its own sentence, so this is the audit-safe path: the
 * numbers in the swap diff are interpolated here, never generated.
 */
export function narrativeFor(kind: ContextChange["kind"], ctx: DiscoveryContext): string {
  switch (kind) {
    case "time_shrank":
      return `Time is down to ${hm(ctx.availableMin)}.`;
    case "time_grew":
      return `You have ${hm(ctx.availableMin)} now.`;
    case "budget_cut":
      return `Budget is now ${money(ctx.budget)}.`;
    case "budget_grew":
      return `Budget raised to ${money(ctx.budget)}.`;
    case "weather_changed":
      return `${CONDITION_WORDS[ctx.weather.condition]}, ${ctx.weather.tempC}°C.`;
    case "party_grew":
      return `Now ${plural(ctx.partySize, "person", "people")}.`;
    case "access_need_added":
      return `Added: ${ctx.accessNeeds.map((need) => need.replace(/_/g, " ")).join(", ")}.`;
    case "interest_added":
      return `Looking for ${ctx.interests.join(", ")}.`;
    case "became_unavailable":
      return `${plural(ctx.excludedIds.length, "place is", "places are")} off the list.`;
    case "mood_changed":
      return "Your preferences changed.";
  }
}

/** The changed top-level fields, as the `ContextChange.patch` record. */
function patchOf(prev: DiscoveryContext, next: DiscoveryContext): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(next) as (keyof DiscoveryContext)[]) {
    if (key === "original") continue;
    if (JSON.stringify(next[key]) !== JSON.stringify(prev[key])) patch[key] = next[key];
  }
  return patch;
}

export type EditorChange = { state: EditorState; change: ContextChange | null };

// ---------------------------------------------------------------------------
// The editor
// ---------------------------------------------------------------------------

/**
 * One shape for every edit, whether it came from a slider, a chip, a "reality
 * changed" button or a chat patch. `note` is the human sentence the swap diff
 * shows; omit it and `narrativeFor` writes one from the real numbers.
 */
export type EditorOp =
  | { kind: "set_time"; availableMin: number; note?: string }
  | { kind: "set_budget"; budgetMinor: number | null; perPersonMinor?: number | null; note?: string }
  | { kind: "set_origin"; label: string; point?: GeoPoint | null; note?: string }
  | { kind: "set_party"; partySize: number; childAges?: number[]; elderly?: number; note?: string }
  | { kind: "set_access_needs"; needs: AccessNeed[]; note?: string }
  | { kind: "add_access_needs"; needs: AccessNeed[]; note?: string }
  | { kind: "set_interests"; interests: string[]; note?: string }
  | { kind: "add_interests"; interests: string[]; note?: string }
  | { kind: "add_avoid"; avoid: string[]; note?: string }
  | { kind: "set_avoid"; avoid: string[]; note?: string }
  | { kind: "exclude"; experienceIds: string[]; note?: string }
  | { kind: "set_indoor"; indoorOnly: boolean; note?: string }
  | { kind: "set_walking"; walking: WalkingTolerance; note?: string }
  | { kind: "set_weather"; condition: WeatherNow["condition"]; tempC?: number; note?: string }
  | { kind: "set_weather_sensitivity"; sensitivity: WeatherSensitivity; note?: string }
  | { kind: "set_mood"; mood: string | null; note?: string };

function withOp(state: EditorState, op: EditorOp): EditorState {
  const ctx: DiscoveryContext = { ...state.ctx };
  const prefs: DiscoveryPrefs = { ...state.prefs };
  switch (op.kind) {
    case "set_time":
      ctx.availableMin = Math.max(FLOOR_MIN, Math.round(op.availableMin));
      break;
    case "set_budget":
      ctx.budget = op.budgetMinor === null ? null : rupees(Math.max(0, Math.round(op.budgetMinor)));
      if (op.perPersonMinor !== undefined) {
        ctx.budgetPerPerson = op.perPersonMinor === null ? null : rupees(Math.max(0, Math.round(op.perPersonMinor)));
      }
      break;
    case "set_origin":
      ctx.origin = { label: op.label, point: op.point ?? null };
      break;
    case "set_party": {
      const childAges = op.childAges ?? ctx.childAges;
      const elderly = op.elderly ?? Math.max(0, (ctx.partyType === "older_adults" ? 1 : 0));
      ctx.partySize = Math.max(1, Math.round(op.partySize));
      ctx.childAges = childAges;
      ctx.partyType = derivePartyType(ctx.partySize, childAges, elderly);
      if (elderly > 0) ctx.accessNeeds = [...new Set([...ctx.accessNeeds, ...accessDefaults(elderly)])];
      break;
    }
    case "set_access_needs":
      ctx.accessNeeds = [...new Set(op.needs)];
      break;
    case "add_access_needs":
      ctx.accessNeeds = [...new Set([...ctx.accessNeeds, ...op.needs])];
      break;
    case "set_interests":
      ctx.interests = [...new Set(op.interests.map((interest) => interest.trim()).filter(Boolean))];
      break;
    case "add_interests":
      ctx.interests = [
        ...new Set([...ctx.interests, ...op.interests.map((i) => i.trim()).filter(Boolean)]),
      ];
      break;
    case "set_avoid":
      ctx.avoid = [...new Set(op.avoid)];
      break;
    case "add_avoid":
      ctx.avoid = [...new Set([...ctx.avoid, ...op.avoid])];
      break;
    case "exclude":
      ctx.excludedIds = [...new Set([...ctx.excludedIds, ...op.experienceIds])];
      break;
    case "set_indoor":
      prefs.indoorOnly = op.indoorOnly;
      break;
    case "set_walking":
      prefs.walking = op.walking;
      break;
    case "set_weather":
      ctx.weather = { ...ctx.weather, condition: op.condition, tempC: op.tempC ?? ctx.weather.tempC };
      break;
    case "set_weather_sensitivity":
      prefs.weatherSensitivity = op.sensitivity;
      break;
    case "set_mood":
      prefs.mood = op.mood;
      break;
  }
  return { ctx: lowerPrefs(ctx, prefs), prefs };
}

/**
 * Folds a list of ops into one `ContextChange`, so a multi-part action is one
 * replan and one reason rather than three.
 */
export function applyOps(state: EditorState, ops: readonly EditorOp[]): EditorChange {
  const current = ops.reduce<EditorState>((acc, op) => withOp(acc, op), state);
  const notes = ops.map((op) => op.note).filter((note): note is string => Boolean(note));
  const kind = classifyChange(state.ctx, current.ctx);
  if (kind === null) return { state, change: null };
  return {
    state: current,
    change: {
      kind,
      narrative: notes.length > 0 ? notes.join(" ") : narrativeFor(kind, current.ctx),
      patch: patchOf(state.ctx, current.ctx),
    },
  };
}

export function applyOp(state: EditorState, op: EditorOp): EditorChange {
  return applyOps(state, [op]);
}

/**
 * `DialogueDecision.contextPatch` -> editor ops. This function is the entire
 * blast radius of the model, and it is eight reads of a frozen object: it can
 * only produce `EditorOp`s, every one of which lands in `DiscoveryContext`.
 * The unknown-key case is impossible, not merely unhandled — `DialogueDecision`
 * is `.strict()`, so a key we do not read is a schema error upstream.
 *
 * `accessNeeds`, `interests` and `avoid` arrive as ADDITIONS, never as
 * replacements. FEATURES §4 writes them as `+=`, `guardrails.mergePatch` unions
 * them for the same reason, and a replace here would let one sentence
 * ("my aunt can't do stairs") silently delete a need the traveller already
 * stated. Only the three scalars a sentence can state outright — time, budget,
 * party size — are absolute.
 */
export function opsFromPatch(patch: DialogueDecision["contextPatch"]): EditorOp[] {
  const ops: EditorOp[] = [];
  if (patch.availableMin !== undefined) ops.push({ kind: "set_time", availableMin: patch.availableMin });
  if (patch.budgetMinor !== undefined) ops.push({ kind: "set_budget", budgetMinor: patch.budgetMinor });
  if (patch.partySize !== undefined) ops.push({ kind: "set_party", partySize: patch.partySize });
  if (patch.accessNeeds !== undefined) ops.push({ kind: "add_access_needs", needs: patch.accessNeeds });
  if (patch.interests !== undefined) ops.push({ kind: "add_interests", interests: patch.interests });
  if (patch.avoid !== undefined) ops.push({ kind: "add_avoid", avoid: patch.avoid });
  if (patch.indoorOnly !== undefined) ops.push({ kind: "set_indoor", indoorOnly: patch.indoorOnly });
  if (patch.mood !== undefined) ops.push({ kind: "set_mood", mood: patch.mood });
  return ops;
}

export function applyPatch(state: EditorState, patch: DialogueDecision["contextPatch"]): EditorChange {
  return applyOps(state, opsFromPatch(patch));
}
