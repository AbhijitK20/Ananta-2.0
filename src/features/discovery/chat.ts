/**
 * The chat sidecar's feature half: `parseIntent` -> `DialogueDecision` ->
 * context patch -> replan.
 *
 * The LLM lives in `src/llm/**`, which another session owns, so this file does
 * not import it. It takes an `IntentParser` — the exact signature
 * `docs/ARCHITECTURE.md` §9 gives `src/llm/nlu.ts`, and the one `parseIntent`
 * there already has — so the app injects the real parser and the feature stays
 * import-clean. `mockIntentParser` is the `LLM=off` path: no model, no network,
 * and the thing the tests run against.
 *
 * Three things are enforced here rather than trusted:
 *
 *  1. **Parse the output with the contract schema.** `DialogueDecision` is
 *     `.strict()`, so a model that invents a key is a schema error, not a
 *     silently applied preference. `JSON.parse` on a model string is exactly the
 *     bug the contract's comment warns about.
 *  2. **Confidence gate at 0.5**, from Plan-It, which is where the citation in
 *     `docs/ARCHITECTURE.md` §9 comes from. Below it we ask instead of acting.
 *  3. **A question is not a mutation.** "Is it far?" produces an empty patch, so
 *     `applyOps` returns no change and the plan is never touched.
 *
 * The model's only permitted effect is `contextPatch`, and the only code that
 * reads it is `opsFromPatch` in `context.ts`. There is no path from a
 * `DialogueDecision` to a `Plan`.
 */
import { DialogueDecision, type DiscoveryContext } from "../../contracts";
import { applyPatch, type EditorState } from "./context";
import { SUGGESTIONS } from "./actions";
import type { EnginePort } from "./engine";
import { type ActionOutcome, type DiscoverySession, applyEditorChange } from "./replanner";

/** Below this we ask rather than act. `docs/ARCHITECTURE.md` §9. */
export const CONFIDENCE_GATE = 0.5;

/** The `src/llm/nlu.ts` signature, verbatim. The app passes the real one. */
export interface IntentParser {
  parseIntent(text: string, ctx: DiscoveryContext): Promise<DialogueDecision>;
}

export type ChatOutcome = {
  /** What the sidecar shows. The model's words, or our fallback sentence. */
  reply: string;
  suggestions: string[];
  /** True only when a patch was applied and a new plan was admitted. */
  acted: boolean;
  /** True when the sidecar needs a clarifying answer rather than a new plan. */
  needsClarification: boolean;
  replan: ActionOutcome | null;
  state: EditorState;
};

/**
 * Deterministic stand-in for the NLU: the `LLM=off` path the eval suite is
 * required to pass in, and what the tests run against so they never touch a
 * network. A rule set is supplied by the caller, so a demo or an eval scenario
 * can script exactly which utterance does what.
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

/**
 * The full loop, with every guard in the right order. `state` in the result is
 * the state the plan is actually consistent with: on a failed replan that is the
 * old one, because `applyEditorChange` rolls the context back.
 */
export async function handleChat(
  engine: EnginePort,
  parser: IntentParser,
  session: DiscoverySession,
  text: string,
): Promise<ChatOutcome> {
  const base: Omit<ChatOutcome, "state"> = {
    reply: "",
    suggestions: [],
    acted: false,
    needsClarification: false,
    replan: null,
  };

  let decision: DialogueDecision;
  try {
    decision = await parser.parseIntent(text, session.state.ctx);
  } catch {
    return {
      ...base,
      reply: "I could not reach the model, so nothing changed. Your plan is as it was.",
      suggestions: SUGGESTIONS.map((action) => action.label),
      state: session.state,
    };
  }

  const parsed = DialogueDecision.safeParse(decision);
  if (!parsed.success) {
    return {
      ...base,
      reply: "That reply was not in the shape I can use, so nothing changed.",
      suggestions: SUGGESTIONS.map((action) => action.label),
      state: session.state,
    };
  }
  const safe = parsed.data;

  if (safe.confidence < CONFIDENCE_GATE) {
    return {
      ...base,
      reply: safe.reply,
      suggestions: safe.suggestions,
      needsClarification: true,
      state: session.state,
    };
  }

  const edit = applyPatch(session.state, safe.contextPatch);
  if (!edit.change) {
    return {
      ...base,
      reply: safe.reply || NO_CHANGE_REPLY,
      suggestions: safe.suggestions,
      state: session.state,
    };
  }

  const outcome = applyEditorChange(engine, session, edit);
  return {
    reply: outcome.ok ? safe.reply || edit.change.narrative : outcome.reason,
    suggestions: safe.suggestions,
    acted: outcome.ok,
    needsClarification: false,
    replan: outcome,
    state: outcome.ok ? outcome.session.state : session.state,
  };
}
