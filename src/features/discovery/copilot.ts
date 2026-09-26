/**
 * The Conversational Travel Copilot. One utterance in, a structured change to
 * `DiscoveryContext` out, and the real planner does the rest.
 *
 * The invariant this file exists to hold, restated because it is the whole
 * feature: **the copilot never produces a `Plan`.** It produces `EditorOp`s and
 * a `ContextChange`, which are the same kinds of value a slider, a chip and a
 * "reality changed" button produce. `replanner.ts` then hands the new context to
 * the engine and admits the plan that comes back. There is no path from a
 * `DialogueDecision` to a stop.
 *
 * Two readers run on every turn, and the order is the point:
 *
 *  1. **`src/llm`'s deterministic reader** (`deterministicDecision`), reused
 *     as-is. It already reads time, money, party size, access needs, interests,
 *     exclusions, indoor-only and mood out of plain English, and it is the
 *     documented `LLM=off` behaviour, so the copilot must not grow a second one
 *     for the same job.
 *  2. **This file's own reading** (`readTurn`), for the axes the frozen
 *     `DialogueDecision` cannot carry at all. `DialogueDecision` is `.strict()`
 *     and its patch has eight fields, none of which is a weather condition, a
 *     walking tolerance or the composition of the party. Those three are not
 *     decoration: the planner reads `DiscoveryContext.weather` for its weather
 *     gate, `travelMode` and the `prefers_*_walks` tokens for its legs, and
 *     `partyType` / `accessNeeds` for its accessibility gate. Without a lowering
 *     step, "it started raining" sets an `indoors_only` token and leaves
 *     `weather.condition: "clear"`, so the gate the traveller is asking for never
 *     fires. That is the bug this file fixes, and it is fixed by producing editor
 *     ops, never by special-casing a reply.
 *
 * Confidence. The model's contribution is gated at 0.5, as `docs/FEATURES.md` §7
 * requires. Our own reading is NOT gated, because it is a rule set rather than a
 * guess: "less walking" either contains a walking phrase or it does not. Gating
 * it would mean that with the model switched off the flagship sentences do
 * nothing, which is the exact failure `docs/ARCHITECTURE.md` §10 forbids.
 *
 * Everything below is pure. No `Date`, no model, no network: `nowMin` comes from
 * the caller's context, so a replay of the same transcript six months later
 * produces the same ops.
 */
import { DialogueDecision, DiscoveryContext, type ContextChange, type WeatherNow } from "../../contracts";
import { deterministicDecision, mergePatch } from "../../llm";
import {
  type EditorOp,
  type EditorState,
  type WalkingTolerance,
  applyOps,
  opsFromPatch,
} from "./context";

/** Below this the traveller is asked a question instead of the model being acted on. `docs/FEATURES.md` §7. */
export const CONFIDENCE_GATE = 0.5;

/**
 * What our own reader is sure of. Above the gate, so a turn the rule set
 * recognises still acts with the model switched off; below 1, so a model that read
 * the sentence properly still outranks it.
 */
export const OWN_CONFIDENCE = 0.85;

// ---------------------------------------------------------------------------
// The axes the frozen patch has no field for
// ---------------------------------------------------------------------------

/**
 * Ordered: the first match wins, and the strongest reading is first. "It stopped
 * raining" is checked before "it is raining" because it contains the word rain
 * too, and a traveller who says the rain stopped means clear.
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

export type TurnReading = { ops: EditorOp[]; matched: string[] };

/**
 * Pure, and the only part of the copilot that looks at words. At most one op per
 * axis: two ops on one axis are two contradictory statements, and "the last one
 * silently wins" is not a policy.
 *
 * The party op is missing here because it needs the current party size to
 * express "at least three"; `planTurn` adds it.
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

  if (CULTURE.test(text)) {
    ops.push({ kind: "add_interests", interests: CULTURE_TERMS, note: "More culture stops." });
    matched.push("interest.culture");
  }

  return { ops, matched };
}

/**
 * "I am with my parents" states a party, so the party is at least three. That is
 * an entailment rather than a guess: a plural reference to your own parents, plus
 * you, cannot be two people. It matters because the budget, the capacity check
 * and the accessibility defaults are all functions of party size and party type,
 * so without it "with my parents" is booked as a solo evening.
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
// One turn
// ---------------------------------------------------------------------------

export type CopilotTurn = {
  /** The contract's decision, and the only thing a model is allowed to say. */
  decision: DialogueDecision;
  /** The ops, kept for inspection. Applying them is the replanner's job. */
  ops: EditorOp[];
  /** One classified change, or null when the turn means nothing new. */
  change: ContextChange | null;
  /** The state the change was computed against, or the input on refusal. */
  state: EditorState;
  /** True when the model's contribution was unavailable or below the gate. */
  degraded: boolean;
  /** Which rules fired. Assertions and the eval harness read this. */
  matched: string[];
};

export type TurnReason = "ok" | "no_change" | "invalid_context";

/**
 * One utterance -> one change. `model` is the model's read, already schema-checked
 * by the caller; leave it out and the deterministic floor is the whole answer,
 * which is the `LLM=off` path and what the eval suite has to pass in.
 *
 * `state` in the result is the state the returned `change` belongs to. When
 * `change` is null nothing moved and the caller keeps the state it had.
 */
export function planTurn(state: EditorState, text: string, model?: DialogueDecision): CopilotTurn {
  const own = readTurn(text);
  const elder = elderOp(state, text);
  const ownOps = elder ? [...own.ops, elder] : own.ops;
  if (elder) own.matched.push("party.elders");

  // The floor. `deterministicDecision` is pure and makes no model call.
  const floor = deterministicDecision(text, state.ctx);
  const trusted = model !== undefined && model.confidence >= CONFIDENCE_GATE;
  const patch = trusted && model ? mergePatch(floor.contextPatch, model.contextPatch) : floor.contextPatch;
  const ops: EditorOp[] = [...opsFromPatch(patch), ...ownOps];

  const confidence = Math.max(
    floor.confidence,
    own.matched.length > 0 ? OWN_CONFIDENCE : 0,
    trusted && model ? model.confidence : 0,
  );
  const decision = DialogueDecision.parse({
    ...(trusted && model ? model : floor),
    contextPatch: patch,
    confidence: Math.min(1, confidence),
  });

  const edit = applyOps(state, ops);
  if (!edit.change) {
    return { decision, ops, change: null, state, degraded: !trusted, matched: own.matched };
  }
  // A turn that produced a context the contract rejects is refused, not applied.
  // The editor clamps most of this already; the parse is the backstop that makes
  // "an invalid request fails safely" a property rather than a hope.
  if (!DiscoveryContext.safeParse(edit.state.ctx).success) {
    return {
      decision,
      ops,
      change: null,
      state,
      degraded: true,
      matched: [...own.matched, "refused.invalid_context"],
    };
  }
  return { decision, ops, change: edit.change, state: edit.state, degraded: !trusted, matched: own.matched };
}

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
 * "Dropped the market, added the gallery." Every word comes from `PlanDiff`,
 * which the engine produced, so this cannot claim a swap that did not happen and
 * cannot describe one that did.
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

