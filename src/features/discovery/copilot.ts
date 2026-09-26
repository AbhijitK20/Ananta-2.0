/**
 * The Conversational Travel Copilot. One utterance in, a structured change to
 * `DiscoveryContext` out, and the real planner does the rest.
 *
 * The invariant this file exists to hold: **the copilot never produces a `Plan`.**
 * It produces `EditorOp`s and a `ContextChange`, which are the same kinds of value
 * a slider, a chip and a "reality changed" button produce. `replanner.ts` hands the
 * new context to the engine and admits the plan that comes back. There is no path
 * from a `DialogueDecision` to a stop, and a test fails if one appears.
 *
 * ## Why a second reader at all
 *
 * `src/llm`'s deterministic reader already understands time, money, party size,
 * access needs, interests, exclusions and mood, and it is the documented `LLM=off`
 * behaviour, so the copilot does not grow a second one for the same job. What it
 * does own is the four things a `DialogueDecision` structurally cannot carry, and
 * each one is read by the planner rather than by the reply:
 *
 * | axis | why the frozen patch cannot carry it | what the planner reads |
 * |---|---|---|
 * | weather | `DialogueDecision` is `.strict()` and has no weather field | `DiscoveryContext.weather.condition` drives the weather gate |
 * | walking | no field for a tolerance | `travelMode` + the `prefers_*_walks` tokens |
 * | party | `partySize` cannot express "two of them are my parents" | `partyType`, `childAges`, and the access needs an older adult implies |
 * | culture | `interests` is open vocab, and "cultural" is not in the reader's table | retrieval and scoring keywords |
 *
 * Without this lowering step, "it started raining" sets an `indoors_only` token and
 * leaves `weather.condition: "clear"`, so the gate the traveller is asking for never
 * fires. That is a bug fixed by producing editor ops, never by special-casing a
 * reply.
 *
 * ## Precedence, and why it is not arbitrary
 *
 * Both readers run on every turn. On the four axes above this file wins, because it
 * read the whole sentence: the keyword reader sees "rain" inside "the rain has
 * cleared" and concludes indoors, and only the clause-aware reading knows better.
 * On every other field the model wins, because it understood the paraphrase and this
 * file did not. The model's contribution is gated at 0.5 (`docs/FEATURES.md` §7).
 * This file's own reading is NOT gated, because it is a rule set rather than a
 * guess: "less walking" either contains a walking phrase or it does not. Gating it
 * would mean that with the model switched off the flagship sentences do nothing,
 * which is the exact failure `docs/ARCHITECTURE.md` §10 forbids.
 *
 * ## One patch, two consumers
 *
 * `planTurn` returns the decision AND the state it produced, and they agree. Any
 * consumer that applies `decision.contextPatch` by hand — an API route, a native
 * client, the eval harness — gets the same `avoid`, `interests`, `partySize` and
 * `accessNeeds` as the in-process replanner, because the tokens the editor would
 * lower are already in the patch. `copilot.test.ts` asserts that equality field by
 * field and names what is left over.
 *
 * What is left over is three things, and they are named rather than lost:
 * `weather` and `travelMode`, which the patch has no field for, and the preference
 * tokens, which the editor deliberately owns — `lowerPrefs` re-derives them from
 * `EditorState.prefs` on every write, so a patch can carry them for a client that
 * applies `avoid` directly but not through the editor. That list is the contract
 * gap, written down where somebody can fix it.
 *
 * Everything here is pure: no `Date`, no model, no network, and no catalogue unless
 * a resolver is injected. `nowMin` comes from the caller's context, so a replay of
 * the same transcript six months later produces the same ops.
 */
import { DialogueDecision, DiscoveryContext, type ContextChange, type Experience, type WeatherNow } from "../../contracts";
import { deterministicDecision, mergePatch, sanitizePatch, sanitizeUserText } from "../../llm";
import {
  WALK_TOKENS,
  type EditorOp,
  type EditorState,
  type WalkingTolerance,
  applyOps,
  opsFromPatch,
} from "./context";

/** Below this the traveller is asked a question instead of the model being acted on. `docs/FEATURES.md` §7. */
export const CONFIDENCE_GATE = 0.5;

/**
 * What our own reader is sure of. Above the gate, so a turn the rule set recognises
 * still acts with the model switched off; below 1, so a model that read the sentence
 * properly still outranks it on the fields we do not own.
 */
export const OWN_CONFIDENCE = 0.85;

// ---------------------------------------------------------------------------
// The four axes the frozen patch has no field for
// ---------------------------------------------------------------------------

/**
 * Ordered: the first match wins, and the strongest reading is first. "It stopped
 * raining" is checked before "it is raining" because it contains the word rain too,
 * and a traveller who says the rain stopped means clear.
 */
const WEATHER: ReadonlyArray<readonly [RegExp, WeatherNow["condition"], string]> = [
  [
    /\b(rain stopped|stopped raining|it stopped raining|cleared up|it dried up|sun came out|no more rain|rain has cleared)\b/i,
    "clear",
    "The rain has cleared.",
  ],
  [
    /\b(storm|storming|thunderstorm|downpour|torrent|very heavy rain|heavy rain|raining cats|rain started|started rain(?:ing)?|is pouring)\b/i,
    "heavy_rain",
    "Rain started.",
  ],
  [
    /\b(rain|raining|rained|shower|showering|drizzle|drizzling|monsoon|is raining|it's raining)\b/i,
    "light_rain",
    "Rain started.",
  ],
  [
    /\b(too hot|heatwave|heat wave|scorching|sweltering|oppressive heat|humid|35\s*c\b|40\s*c\b|40 degree)\b/i,
    "heat",
    "It is too hot to be outside.",
  ],
  [/\b(windy|blustery|gale|blowing)\b/i, "wind", "It is windy."],
];

/** `minimal` is checked first: a traveller who says "no walking" means minimal. */
const WALKING: ReadonlyArray<readonly [RegExp, WalkingTolerance, string]> = [
  [
    /\b(less walking|little walking|not much walking|no walking|minimal walking|avoid walking|avoid long walks|no long walks|tired of walking|don'?t want to walk|do not want to walk|cannot walk|can'?t walk (?:far|much)|keep (?:the |it )?walking short|shorter walks|short walks only|walking is tiring|too much walking)\b/i,
    "minimal",
    "Keeping the walking to a minimum.",
  ],
  [
    /\b(parents? are tired|we'?re (?:all )?tired|everyone is tired|i'?m tired|exhausted|no energy|low energy|knackered|dead on (?:my|our) feet|feet hurt|legs hurt|can'?t keep up)\b/i,
    "minimal",
    "Everyone is tired, so this is the slow version.",
  ],
  [
    /\b(a bit of walking|short walks are fine|happy to walk|don'?t mind walking|do not mind walking|ok(?:ay)? to walk|we can walk)\b/i,
    "low",
    "Keeping the walking short.",
  ],
];

/**
 * An explicit indoor or outdoor request, and nothing else.
 *
 * Deliberately NOT derived from the weather: `src/features/weather` reads
 * `indoors_only` as a standing request from the traveller, so a sentence about the
 * sky must not quietly unset a preference they set on purpose last turn. What this
 * axis is for is the sentence that says both things — "the rain has cleared, let's
 * go outside" — where a keyword reader hears "rain" and concludes indoors. Only
 * real statements count: "street food" is an interest, not a request to stand in the
 * street, and a museum mentioned in passing is not a preference.
 */
const INDOORS: ReadonlyArray<readonly [RegExp, boolean, string]> = [
  [/\b(indoors?\b|inside|indoor only|shelter(?:ed)?|air[\s-]?conditioned|aircon|\bac\b)\b/i, true, "Indoors from here."],
  [/\b(outdoors?\b|outside|open air|fresh air)\b/i, false, "Outdoors it is."],
];

/**
 * A plural reference to your own parents, plus you, is a party of three. Both
 * patterns are anchored on a possessive or a "with", because the bare words are
 * also how people ask about a place: "somewhere good for parents" is a question
 * about a venue, not a fact about who is travelling.
 */
const ELDER_PLURAL =
  /\bwith\s+(?:my\s+|two\s+|the\s+)?(?:parents|grandparents|elders|seniors|older\s+(?:people|folks))\b|\bmy\s+(?:parents|grandparents|elders)\s+(?:are|is|were|have|has|can'?t|cannot|need|prefer|want|don'?t|do\s+not)\b/i;
const ELDER_SINGLE =
  /\bmy\s+(?:father|mother|dad|mum|uncle|aunt|grandpa|grandma|grandfather|grandmother|elderly\s+(?:parent|relative)|senior\s+citizen)\b/i;

/** What "something cultural" means to the retrieval vocabulary. Underscored, as `guardrails` requires. */
const CULTURE = /\b(cultur(?:e|al)|tradition(?:al)?|folk|classical|heritage|monument|historic(?:al)?|temple|fort)\b/i;
const CULTURE_TERMS = ["culture", "heritage"];

/**
 * "Actually never mind." The one conversational move with no analogue in a slider,
 * and the one a traveller reaches for the moment a plan surprises them. It is not a
 * patch to the context: it is the absence of the last patch, so it is handled as an
 * inversion rather than smuggled in as an empty `interests: []`.
 */
const UNDO = /\b(never ?mind|nevermind|forget (?:it|that|this)|undo|put (?:it|that|this) back|take (?:it|that|this) back|revert|scratch that)\b/i;

export type TurnReading = { ops: EditorOp[]; matched: string[] };

/**
 * Pure, and the only part of the copilot that looks at words. At most one op per
 * axis: two ops on one axis are two contradictory statements, and "the last one
 * silently wins" is not a policy.
 *
 * The party op is missing here because it needs the current party size to express
 * "at least three"; `planTurn` adds it.
 */
export function readTurn(text: string): TurnReading {
  const ops: EditorOp[] = [];
  const matched: string[] = [];

  const weather = WEATHER.find(([re]) => re.test(text));
  if (weather) {
    ops.push({ kind: "set_weather", condition: weather[1], note: weather[2] });
    matched.push(`weather.${weather[1]}`);
  }

  const walking = WALKING.find(([re]) => re.test(text));
  if (walking) {
    ops.push({ kind: "set_walking", walking: walking[1], note: walking[2] });
    matched.push(`walking.${walking[1]}`);
  }

  // After the weather, so "the rain has cleared, let's go outside" ends up outside
  // whatever the rain said a moment ago.
  const indoors = INDOORS.find(([re]) => re.test(text));
  if (indoors) {
    ops.push({ kind: "set_indoor", indoorOnly: indoors[1], note: indoors[2] });
    matched.push(`indoor.${indoors[1]}`);
  }

  if (CULTURE.test(text)) {
    ops.push({ kind: "add_interests", interests: CULTURE_TERMS, note: "More culture stops." });
    matched.push("interest.culture");
  }

  return { ops, matched };
}

/**
 * "I am with my parents" states a party, so the party is at least three. That is an
 * entailment rather than a guess: a plural reference to your own parents, plus you,
 * cannot be two people. It matters because the budget, the capacity check and the
 * accessibility defaults are all functions of party size and party type, so without
 * it "with my parents" is booked as a solo evening.
 */
export function elderOp(state: EditorState, text: string): EditorOp | null {
  const elders = ELDER_PLURAL.test(text) ? 2 : ELDER_SINGLE.test(text) ? 1 : 0;
  if (elders === 0) return null;
  return {
    kind: "set_party",
    partySize: Math.max(state.ctx.partySize, elders + 1),
    elderly: elders,
    note: elders > 1 ? "You are with your parents." : "Someone older is travelling with you.",
  };
}

// ---------------------------------------------------------------------------
// Excluding a place by the name a traveller says
// ---------------------------------------------------------------------------

/** Words that are never a place's name, however they are capitalised. */
const NOT_A_NAME = new Set([
  "the", "and", "for", "with", "some", "any", "this", "that", "there", "here",
  "place", "places", "spot", "spots", "thing", "things", "room", "house", "centre", "center",
  "area", "morning", "evening", "night", "today", "tomorrow", "street",
]);

const normalise = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** A place the traveller named, with the display name so a reply can use it. */
export type NamedPlace = { id: string; name: string };

/**
 * A spoken name to catalogue places, for "drop the market" and "no art please".
 *
 * Deliberately conservative, because excluding the wrong place is worse than
 * ignoring the sentence. A name counts only when it is a WHOLE word (or a whole
 * phrase) in the utterance, and only when exactly ONE place matches; whole-word
 * matching is what makes a three-letter keyword like "art" safe to accept, because
 * there is no substring search left to hit "start" or "party" with it. Two matches
 * means the traveller was vague, so nothing is excluded and the sidecar asks. The
 * exclusion cue must sit within 24 characters before the name, which is the same
 * window `src/llm`'s exclusion reader uses, so the two agree on "avoid the museum"
 * and disagree on "the museum was great, but avoid the beach".
 */
export function catalogueResolver(catalogue: ReadonlyMap<string, Experience>): (text: string) => NamedPlace[] {
  const EXCLUSION_CUE = /\b(avoid|skip|drop|remove|cancel|exclude|leave out|not|no|without|rather not|nothing)\b/;
  return (text: string): NamedPlace[] => {
    const phrase = normalise(text);
    const words = new Set(phrase.split(" ").filter(Boolean));
    const hits = new Map<string, NamedPlace>();
    for (const [id, item] of catalogue) {
      const named = normalise(item.name);
      const candidates = [
        named,
        ...item.keywords.map(normalise),
        ...named.split(" ").filter((word) => word.length >= 5 && !NOT_A_NAME.has(word)),
      ].filter((candidate) => candidate.length >= 3);
      const match = candidates.find((candidate) =>
        candidate.includes(" ") ? phrase.includes(candidate) : words.has(candidate),
      );
      if (!match) continue;
      const at = phrase.indexOf(match);
      const before = phrase.slice(Math.max(0, at - 24), at);
      if (EXCLUSION_CUE.test(before) || EXCLUSION_CUE.test(match)) hits.set(id, { id, name: item.name });
    }
    return hits.size === 1 ? [...hits.values()] : [];
  };
}

/** "The Fort Temple is off the list." Names, never ids. */
export function exclusionNote(places: readonly NamedPlace[]): string {
  const names = places.map((place) => place.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `${list} is off the list.`;
}

/**
 * "Drop the first one." Position, rather than name, which is how people refer to a
 * plan they are looking at: they can see "Tea Stall 22" but they say "the second
 * stop".
 *
 * Only a MUTATION verb counts. "Keep the first one" is the opposite instruction, and
 * treating it as a rejection would be the worst bug in this file, so a sentence that
 * asks to keep something is not an exclusion at all — it falls through and the
 * traveller is asked, which is the safe direction.
 */
const MUTATION_CUE = /\b(avoid|skip|drop|remove|cancel|exclude|leave out|without|rather not|not|no)\b/;
const PLACE_WORD = /\b(place|places|stop|stops|one|ones|spot|spots|option|options)\b/;
const ORDINALS: Record<string, (length: number) => number> = {
  first: (n) => 0,
  "1st": (n) => 0,
  second: (n) => 1,
  "2nd": (n) => 1,
  third: (n) => 2,
  "3rd": (n) => 2,
  fourth: (n) => 3,
  "4th": (n) => 3,
  fifth: (n) => 4,
  "5th": (n) => 4,
  last: (n) => n - 1,
  final: (n) => n - 1,
};

export function ordinalResolver(
  stops: readonly { experienceId: string }[],
  catalogue: ReadonlyMap<string, Experience>,
): (text: string) => NamedPlace[] {
  return (text: string): NamedPlace[] => {
    const said = normalise(text);
    if (!MUTATION_CUE.test(said) || !PLACE_WORD.test(said)) return [];
    const word = Object.keys(ORDINALS).find((ordinal) => new RegExp(`\\b${ordinal}\\b`).test(said));
    if (!word) return [];
    const index = ORDINALS[word]?.(stops.length) ?? -1;
    const stop = stops[index];
    const item = stop ? catalogue.get(stop.experienceId) : undefined;
    return item ? [{ id: item.id, name: item.name }] : [];
  };
}

// ---------------------------------------------------------------------------
// Taking the last turn back
// ---------------------------------------------------------------------------

export type TurnRecord = { before: EditorState; after: EditorState };

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The inverse of a turn: the ops that put every field the last turn moved back where
 * it was. Only fields with a REPLACE op in the editor can be inverted; the ones
 * without are reported in `skipped` rather than silently half-undone, because a
 * traveller told "took that back" while a sold-out stop stayed excluded has been lied
 * to.
 *
 * The history is ONE level deep by design, so an undo puts back the last thing said
 * and nothing older. `original` is never touched, so undoing twice cannot damage it.
 */
export function invertTurn(record: TurnRecord, note = "Taking that back."): { ops: EditorOp[]; skipped: string[] } {
  const { before, after } = record;
  const ops: EditorOp[] = [];
  const skipped: string[] = [];
  const was = before.ctx;
  const now = after.ctx;

  if (was.availableMin !== now.availableMin) ops.push({ kind: "set_time", availableMin: was.availableMin });
  if (!same(was.budget, now.budget) || !same(was.budgetPerPerson, now.budgetPerPerson)) {
    ops.push({
      kind: "set_budget",
      budgetMinor: was.budget?.minor ?? null,
      perPersonMinor: was.budgetPerPerson?.minor ?? null,
    });
  }
  if (!same(was.origin, now.origin)) {
    ops.push({ kind: "set_origin", label: was.origin.label, point: was.origin.point });
  }
  if (was.partySize !== now.partySize || !same(was.childAges, now.childAges) || was.partyType !== now.partyType) {
    ops.push({
      kind: "set_party",
      partySize: was.partySize,
      childAges: [...was.childAges],
      // The editor derives the party type from this and stores only the type.
      elderly: was.partyType === "older_adults" ? 1 : 0,
    });
  }
  if (!same(was.accessNeeds, now.accessNeeds)) ops.push({ kind: "set_access_needs", needs: [...was.accessNeeds] });
  if (!same(was.interests, now.interests)) ops.push({ kind: "set_interests", interests: [...was.interests] });
  if (!same(was.diets, now.diets)) skipped.push("diets");
  // `travelMode` is also a preference axis and `set_walking` is the op that owns it,
  // so the walking tolerance is inverted alongside the mode it changed.
  if (was.travelMode !== now.travelMode || before.prefs.walking !== after.prefs.walking) {
    ops.push({ kind: "set_walking", walking: before.prefs.walking });
  }
  if (!same(was.weather, now.weather)) {
    ops.push({ kind: "set_weather", condition: was.weather.condition, tempC: was.weather.tempC });
  }
  if (!same(was.requests, now.requests)) skipped.push("requests");
  if (!same(was.excludedIds, now.excludedIds)) skipped.push("excludedIds");
  if (!same(was.pinnedIds, now.pinnedIds)) skipped.push("pinnedIds");

  // The preference axes live beside the context rather than inside it, so they are
  // inverted from the editor state the same way.
  if (before.prefs.indoorOnly !== after.prefs.indoorOnly) {
    ops.push({ kind: "set_indoor", indoorOnly: before.prefs.indoorOnly });
  }
  if (before.prefs.weatherSensitivity !== after.prefs.weatherSensitivity) {
    ops.push({ kind: "set_weather_sensitivity", sensitivity: before.prefs.weatherSensitivity });
  }
  if (before.prefs.mood !== after.prefs.mood) ops.push({ kind: "set_mood", mood: before.prefs.mood });

  if (ops.length > 0) (ops[0] as { note?: string }).note = note;
  return { ops, skipped };
}

// ---------------------------------------------------------------------------
// One turn
// ---------------------------------------------------------------------------

/** What the copilot needs beyond the sentence, and why it is not always there. */
export type TurnContext = {
  /**
   * The last turn this surface applied, so "actually never mind" has something to
   * take back. A surface that keeps no record simply never undoes, and says so.
   */
  last?: TurnRecord | null;
  /** Resolves a spoken name to places. Absent means "drop the market" is not understood. */
  resolve?: (text: string) => NamedPlace[];
};

export type CopilotTurn = {
  /** The contract's decision, and the only thing a model is allowed to say. */
  decision: DialogueDecision;
  /** The ops, kept for inspection. Applying them is the replanner's job. */
  ops: EditorOp[];
  /** One classified change, or null when the turn means nothing new. */
  change: ContextChange | null;
  /** The state this turn computed its change against, so a surface can undo it. */
  previous: EditorState;
  /** The state the change belongs to, or the input on refusal. */
  state: EditorState;
  /** True when the model's contribution was unavailable or below the gate. */
  degraded: boolean;
  /** Which rules fired. Assertions and the eval harness read this. */
  matched: string[];
  /**
   * Context the traveller's own words moved that the patch cannot reach. Named on
   * every turn that moved one, because a client that applies the patch by hand
   * silently misses them.
   */
  unreachableByPatch: string[];
};

export type TurnReason = "ok" | "no_change" | "invalid_context";

/**
 * The fields a `DialogueDecision.contextPatch` cannot reach, however careful the
 * model is. Reported on every turn, so a surface knows which of its changes arrived
 * only because it went through the editor.
 */
export const PATCH_UNREACHABLE = ["weather", "travelMode", "partyType", "childAges"] as const;

/**
 * One utterance -> one change. `model` is the model's read, already schema-checked by
 * the caller; leave it out and the deterministic floor is the whole answer, which is
 * the `LLM=off` path and what the eval suite has to pass in.
 *
 * `state` in the result is the state the returned `change` belongs to. When `change`
 * is null nothing moved and the caller keeps the state it had.
 */
export function planTurn(
  state: EditorState,
  text: string,
  model?: DialogueDecision,
  options?: TurnContext,
): CopilotTurn {
  // Sanitised once, here, so the copilot's own reader sees the same text the model
  // prompt does. A zero-width character inside "less walking" otherwise reads as no
  // walking phrase at all, and the length cap is the only thing between a
  // 2,000-character utterance and a pathological one.
  const { text: said, filtered } = sanitizeUserText(text);
  const own = readTurn(said);
  const matched: string[] = filtered ? [...own.matched, "input.filtered"] : [...own.matched];
  const elder = elderOp(state, said);
  const ownOps: EditorOp[] = elder ? [...own.ops, elder] : [...own.ops];
  if (elder) matched.push("party.elders");

  // "Drop the market". Resolved against the catalogue, and it composes: a sentence
  // that also moves the budget gets both.
  const dropped: NamedPlace[] =
    options?.resolve?.(said).filter((place) => !state.ctx.excludedIds.includes(place.id)) ?? [];
  if (dropped.length > 0) {
    ownOps.push({ kind: "exclude", experienceIds: dropped.map((place) => place.id), note: exclusionNote(dropped) });
    matched.push("exclude.place");
  }

  // The floor. `deterministicDecision` is pure and makes no model call.
  const floor = deterministicDecision(said, state.ctx);
  const trusted = model !== undefined && model.confidence >= CONFIDENCE_GATE;
  const patch = mergePatch(
    mergePatch(floor.contextPatch, trusted && model ? model.contextPatch : {}),
    // Our own reading last: on the axes it owns, it read the whole sentence.
    ownPatch(own, elder, extraAccessNeeds(state, elder)),
  );
  const ops: EditorOp[] = [...opsFromPatch(patch), ...ownOps];

  // A turn can be a retraction instead of a change.
  const last = options?.last ?? null;
  if (last && UNDO.test(said)) {
    const inverse = invertTurn(last);
    const edit = applyOps(state, inverse.ops);
    if (edit.change) {
      return {
        decision: DialogueDecision.parse({
          contextPatch: patch,
          reply: `Took that back. ${retraction(inverse.skipped)}`,
          confidence: OWN_CONFIDENCE,
          suggestions: floor.suggestions,
        }),
        ops: inverse.ops,
        change: edit.change,
        previous: state,
        state: edit.state,
        degraded: !trusted,
        matched: [...matched, "undo.applied", ...inverse.skipped.map((field) => `undo.skipped.${field}`)],
        unreachableByPatch: unreachable(state, edit.state),
      };
    }
  }

  const confidence = Math.max(
    floor.confidence,
    matched.length > 0 ? OWN_CONFIDENCE : 0,
    trusted && model ? model.confidence : 0,
  );
  const decision = DialogueDecision.parse({
    ...(trusted && model ? model : floor),
    contextPatch: patch,
    confidence: Math.min(1, confidence),
  });
  const reply = dropped.length > 0 ? `${decision.reply} ${exclusionNote(dropped)}` : decision.reply;

  const edit = applyOps(state, ops);
  if (!edit.change) {
    return {
      decision: { ...decision, reply },
      ops,
      change: null,
      previous: state,
      state,
      degraded: !trusted,
      matched,
      unreachableByPatch: [],
    };
  }
  // A turn that produced a context the contract rejects is refused, not applied. The
  // editor clamps most of this already; the parse is the backstop that makes "an
  // invalid request fails safely" a property rather than a hope.
  if (!DiscoveryContext.safeParse(edit.state.ctx).success) {
    return {
      decision: { ...decision, reply },
      ops,
      change: null,
      previous: state,
      state,
      degraded: true,
      matched: [...matched, "refused.invalid_context"],
      unreachableByPatch: [],
    };
  }
  return {
    decision: { ...decision, reply },
    ops,
    change: edit.change,
    previous: state,
    state: edit.state,
    degraded: !trusted,
    matched,
    unreachableByPatch: unreachable(state, edit.state),
  };
}

/**
 * The access needs the party op implies, read from the EDITOR rather than restated
 * here. An older adult in the party means stairs and a toilet in `context.ts`, and a
 * second copy of that rule in this file is a second rule to keep in step.
 */
function extraAccessNeeds(state: EditorState, elder: EditorOp | null): string[] {
  if (!elder) return [];
  const after = applyOps(state, [elder]).state.ctx.accessNeeds;
  return after.filter((need) => !state.ctx.accessNeeds.includes(need));
}

/**
 * Our own reading as a patch, so a client that applies the patch by hand ends up with
 * the same context the editor would have produced. This is the one place the two
 * paths are made to agree, and `copilot.test.ts` is what keeps them agreeing.
 *
 * The party size and the access needs it implies are in here because BOTH are patch
 * fields: a client that applied the patch without them would book "I'm with my
 * parents" as one able-bodied person, which is the exact silent miss this function
 * exists to prevent. What still cannot travel is the party TYPE, because that is
 * derived by the editor from an `elderly` count the frozen patch has no field for.
 * That, plus weather and travelMode, is what `PATCH_UNREACHABLE` names.
 */
function ownPatch(own: TurnReading, elder: EditorOp | null, accessNeeds: string[]): DialogueDecision["contextPatch"] {
  const avoid: string[] = [];
  const interests: string[] = [];
  let indoorOnly: boolean | undefined;
  let partySize: number | undefined;
  for (const op of own.ops) {
    // `"any"` is a real value for a walking op — it is how an undo says "no
    // preference" — and it has no token, because it is the absence of one.
    if (op.kind === "set_walking" && op.walking !== "any") avoid.push(WALK_TOKENS[op.walking]);
    else if (op.kind === "set_indoor") indoorOnly = op.indoorOnly;
    else if (op.kind === "add_interests") interests.push(...op.interests);
  }
  if (elder?.kind === "set_party") partySize = elder.partySize;
  return sanitizePatch({
    ...(avoid.length > 0 ? { avoid } : {}),
    ...(indoorOnly !== undefined ? { indoorOnly } : {}),
    ...(interests.length > 0 ? { interests } : {}),
    ...(partySize !== undefined ? { partySize } : {}),
    ...(accessNeeds.length > 0 ? { accessNeeds } : {}),
  });
}

/** Which of the four unreachable fields this turn actually moved. */
function unreachable(before: EditorState, after: EditorState): string[] {
  const was = before.ctx;
  const now = after.ctx;
  const childMoved = !same(was.childAges, now.childAges);
  const moved: Record<(typeof PATCH_UNREACHABLE)[number], boolean> = {
    weather: !same(was.weather, now.weather),
    travelMode: was.travelMode !== now.travelMode,
    partyType: was.partyType !== now.partyType,
    childAges: childMoved,
  };
  return PATCH_UNREACHABLE.filter((field) => moved[field]);
}

/** Honest about what a retraction could not reach. */
const retraction = (skipped: readonly string[]): string =>
  skipped.length === 0 ? "Your plan is back to what it was." : `I could not take back ${skipped.join(", ")}.`;

/** Why a turn produced no change. Tests and telemetry only. */
export function turnReason(turn: CopilotTurn): TurnReason {
  if (turn.change) return "ok";
  return turn.matched.includes("refused.invalid_context") ? "invalid_context" : "no_change";
}

// ---------------------------------------------------------------------------
// What the turn did to the plan, in a sentence built from the engine's own diff
// ---------------------------------------------------------------------------

/** Structural, so this needs no import from `diff.ts` and no plan to test. */
export type SwapNames = {
  readonly removed: readonly { readonly id: string; readonly name: string }[];
  readonly added: readonly { readonly id: string; readonly name: string }[];
};

const list = (entries: SwapNames["removed"]): string =>
  entries.slice(0, 2).map((entry) => entry.name).join(" and ");

/**
 * "Dropped the market, added the gallery." Every word comes from `PlanDiff`, which the
 * engine produced, so this cannot claim a swap that did not happen and cannot describe
 * one that did.
 */
export function summariseSwaps(diff: SwapNames): string {
  const { removed, added } = diff;
  if (removed.length === 0 && added.length === 0) return "Your plan is unchanged.";
  const parts: string[] = [];
  if (removed.length > 0) {
    const names = list(removed);
    parts.push(`Dropped ${names}${removed.length > 2 ? ` and ${removed.length - 2} more` : ""}.`);
  }
  if (added.length > 0) {
    const names = list(added);
    parts.push(`Added ${names}${added.length > 2 ? ` and ${added.length - 2} more` : ""}.`);
  }
  return parts.join(" ");
}
