/**
 * The chat sidecar: one turn of conversation, end to end.
 *
 *   text -> `IntentParser` (a model, or the deterministic one) -> `DialogueDecision`
 *       -> `copilot.planTurn` -> `EditorOp`s -> `ContextChange`
 *       -> `replanner.applyEditorChange` -> engine `replan()` -> admitted `Plan`
 *
 * `copilot.ts` owns the understanding; this file owns the loop and its guards. The
 * LLM lives in `src/llm/**` and is injected, so this file never imports a client:
 * `mockIntentParser` is the `LLM=off` path, and the app passes the real
 * `parseIntent`.
 *
 * Three things are enforced here rather than trusted:
 *
 *  1. **The output is parsed with the contract's own schema.** `DialogueDecision` is
 *     `.strict()`, so a model that invents a key is a schema error, not a silently
 *     applied preference. `JSON.parse` on a model string is exactly the bug the
 *     contract's comment warns about.
 *  2. **A model below the confidence gate is not acted on.** Its patch is dropped and
 *     the deterministic floor decides, per `docs/FEATURES.md` §7. The floor is not
 *     gated, because it is a rule set rather than a guess: with the model switched
 *     off, "I have three hours" still has to work.
 *  3. **A failed re-solve rolls the context back.** `applyEditorChange` returns the
 *     untouched session, so a context the planner could not honour is never left in
 *     front of the traveller.
 *
 * The model's only permitted effect is `contextPatch`, and the only code that reads it
 * is `opsFromPatch` in `context.ts`. There is no path from a `DialogueDecision` to a
 * `Plan`.
 */
import { DialogueDecision, type DiscoveryContext } from "../../contracts";
import {
  CONFIDENCE_GATE,
  type CopilotTurn,
  type NamedPlace,
  type TurnRecord,
  catalogueResolver,
  ordinalResolver,
  planTurn,
  summariseSwaps,
} from "./copilot";
import { SUGGESTIONS } from "./actions";
import type { EditorState } from "./context";
import type { EnginePort } from "./engine";
import { type ActionOutcome, type DiscoverySession, applyEditorChange } from "./replanner";

export { CONFIDENCE_GATE };

/** The `src/llm/nlu.ts` signature, verbatim. The app passes the real one. */
export interface IntentParser {
  parseIntent(text: string, ctx: DiscoveryContext): Promise<DialogueDecision>;
}

export type ChatOutcome = {
  /** What the sidecar shows. The model's words, then what actually changed. */
  reply: string;
  suggestions: string[];
  /** True only when a patch was applied and a new plan was admitted. */
  acted: boolean;
  /** True when the sidecar needs a clarifying answer rather than a new plan. */
  needsClarification: boolean;
  /** True when the model's contribution was unavailable or below the gate. */
  degraded: boolean;
  replan: ActionOutcome | null;
  state: EditorState;
  /** The turn, for the transcript and for tests. Not for the UI to interpret. */
  turn: CopilotTurn;
  /**
   * Pass this back as `last` on the next turn and "actually never mind" works. A
   * surface that ignores it loses the ability to take a change back, which is the one
   * thing a traveller asks for the moment a plan surprises them.
   */
  record: TurnRecord | null;
};

const CHIPS = (): string[] => SUGGESTIONS.map((action) => action.label);

/**
 * Whoever spoke last names the chips: the model if it offered any, else the
 * deterministic floor, else the standing eight a traveller can always tap.
 */
const chipsFor = (unsure: DialogueDecision | null, turn: CopilotTurn): string[] => {
  const offered = unsure?.suggestions.length ? unsure.suggestions : turn.decision.suggestions;
  return offered.length > 0 ? offered : CHIPS();
};

/**
 * Deterministic stand-in for the NLU: the `LLM=off` path the eval suite is required
 * to pass in, and what the tests run against so they never touch a network. A rule
 * set is supplied by the caller, so a demo or an eval scenario can script exactly
 * which utterance does what. The interesting case is the fall-through: a
 * low-confidence decision with an empty patch, which is what the copilot's own reader
 * then has to carry on its own.
 */
export function mockIntentParser(rules: Readonly<Record<string, Partial<DialogueDecision>>> = {}): IntentParser {
  return {
    async parseIntent(text: string, _ctx: DiscoveryContext): Promise<DialogueDecision> {
      const needle = text.trim().toLowerCase();
      for (const [phrase, decision] of Object.entries(rules)) {
        if (!needle.includes(phrase.toLowerCase())) continue;
        return DialogueDecision.parse({
          reply: "",
          confidence: 0.9,
          suggestions: [],
          contextPatch: {},
          ...decision,
        });
      }
      return DialogueDecision.parse({
        reply: "I did not catch a change in that. Tap one of the suggestions or say what changed.",
        confidence: 0,
        suggestions: SUGGESTIONS.map((action) => action.label),
        contextPatch: {},
      });
    },
  };
}

const NO_CHANGE_REPLY = "Nothing to change there, so your plan is as it was.";
const CLARIFY = "I did not catch a change in that. Say a time, a budget, a group size, or something to avoid.";

/**
 * The full loop, with every guard in the right order. `state` in the result is the
 * state the plan is actually consistent with: on a failed replan that is the old one,
 * because `applyEditorChange` rolls the context back.
 *
 * A model that throws, or returns something the contract rejects, is not the end of
 * the conversation: the deterministic floor reads the sentence anyway, which is what
 * `docs/FEATURES.md` §7 promises for both failures.
 *
 * The catalogue comes from the session rather than an import, so this file stays free
 * of a data dependency: the app has the catalogue, each test has its own, and the
 * resolver that turns "drop the market" into an id is built here.
 */
export async function handleChat(
  engine: EnginePort,
  parser: IntentParser,
  session: DiscoverySession,
  text: string,
  last?: TurnRecord | null,
): Promise<ChatOutcome> {
  let model: DialogueDecision | undefined;
  let unreadable = false;
  try {
    const raw: unknown = await parser.parseIntent(text, session.state.ctx);
    const parsed = DialogueDecision.safeParse(raw);
    if (parsed.success) {
      model = parsed.data;
    } else {
      unreadable = true;
    }
  } catch {
    unreadable = true;
  }

  // Two ways to name a place, tried in that order: what it is called, then where it
  // sits in the plan the traveller is looking at.
  const byName = catalogueResolver(session.catalogue);
  const byPosition = ordinalResolver(session.plan?.stops ?? [], session.catalogue);
  const resolve = (text: string): NamedPlace[] => byName(text).length > 0 ? byName(text) : byPosition(text);
  const turn = planTurn(session.state, text, model, { last: last ?? null, resolve });
  // A model that read the sentence and then admitted it was unsure. The traveller gets
  // its question, never its patch.
  const unsure = model !== undefined && model.confidence < CONFIDENCE_GATE ? model : null;
  const base: Omit<ChatOutcome, "state" | "turn" | "record"> = {
    reply: "",
    suggestions: chipsFor(unsure, turn),
    acted: false,
    needsClarification: false,
    degraded: turn.degraded || unreadable,
    replan: null,
  };
  // Only a turn that actually moved something is worth taking back.
  const finish = (outcome: Omit<ChatOutcome, "record">): ChatOutcome => ({
    ...outcome,
    record: outcome.acted ? { before: turn.previous, after: outcome.state } : null,
  });

  if (!turn.change) {
    // Below the gate with a question of its own to ask, we ask it. Otherwise we say
    // plainly that nothing moved, because a plan the traveller thinks is stale is
    // worse than one they know is unchanged.
    return finish({
      ...base,
      reply: unsure ? unsure.reply || CLARIFY : turn.decision.reply || NO_CHANGE_REPLY,
      needsClarification: unsure !== null,
      state: session.state,
      turn,
    });
  }

  const outcome = applyEditorChange(engine, session, { state: turn.state, change: turn.change });
  if (!outcome.ok) {
    return finish({ ...base, reply: outcome.reason, state: session.state, turn });
  }
  return finish({
    ...base,
    // The reply states what actually changed, with the names and counts the engine's
    // own diff produced. Not a canned sentence about the weather.
    reply: [turn.decision.reply, summariseSwaps(outcome.diff)].filter(Boolean).join(" "),
    acted: true,
    replan: outcome,
    state: outcome.session.state,
    turn,
  });
}
