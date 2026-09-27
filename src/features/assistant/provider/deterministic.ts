/**
 * `DeterministicProvider` — the assistant when Nugen cannot answer.
 *
 * Not a stub and not a placeholder. Nugen's data plane has returned 502 for every
 * listed model, so this is currently the path a demo takes, and a product that
 * only works when a third party is up is not a product. It reads the *same*
 * assembled messages the Nugen provider reads — same system prompt, same grounding
 * block, same history — so the two are interchangeable from the route's point of
 * view, and every streaming, persistence, ownership and error test exercises the
 * real code path rather than a mock.
 *
 * It answers from three sources, in order: the out-of-scope table, the app-topic
 * table, and the grounding block of real catalogue facts. It never states a fact
 * that is not in the grounding block, which is the same rule the system prompt
 * gives the model — enforced here in code rather than asked for in prose.
 *
 * It streams, because "the offline path returns a whole string" would mean the
 * streaming route has a branch that only runs in production.
 */
import { APP_TOPICS, OUT_OF_SCOPE } from "../knowledge";
import { GROUNDING_CLOSE, GROUNDING_OPEN, PROMPT_VERSION } from "../prompt";
import { INJECTION_REFUSAL, isInjectionAttempt } from "../orchestration/safety";
import type {
  AIProvider,
  GenerateRequest,
  GenerateResult,
  ProviderHealthResult,
} from "./provider";
import type { ProviderHealth } from "../types";

/** Word-boundary-ish match on a topic keyword, tolerant of plurals. */
function mentions(question: string, keyword: string): boolean {
  const stem = keyword.replace(/s$/, "");
  return new RegExp(`\\b${escapeRegExp(stem)}`, "i").test(question);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The traveller's question: the last `user` message in the assembled turn. */
export function lastUserQuestion(messages: GenerateRequest["messages"]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === "user") return message.content;
  }
  return "";
}

/** The numbered facts out of the grounding block, or [] when there are none. */
export function groundingFacts(messages: GenerateRequest["messages"]): string[] {
  const joined = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const start = joined.indexOf(GROUNDING_OPEN);
  const end = joined.indexOf(GROUNDING_CLOSE);
  if (start < 0 || end <= start) return [];
  return joined
    .slice(start + GROUNDING_OPEN.length, end)
    .split("\n")
    .map((line) => /^\d+\.\s+(.*)$/.exec(line.trim())?.[1]?.trim() ?? "")
    .filter((fact) => fact.length > 0);
}

export function answerFromGrounding(question: string, facts: readonly string[]): string {
  if (facts.length === 0) {
    return [
      "I do not have catalogue data for that in this turn, and I would rather say so than guess at a place, a price or an opening time.",
      "",
      "Tell me the neighbourhood you are in or heading to, how long you have, and who you are travelling with, and I will work from what the app actually has.",
    ].join("\n");
  }
  const lead = facts.length === 1 ? "Here is the one thing the catalogue has:" : `Here is what the catalogue has (${facts.length}):`;
  return [lead, ...facts.map((fact) => `- ${fact}`), "", "Any of these can be re-fit against a different time budget or a different group. Which one do you want to look at?"].join(
    "\n",
  );
}

/**
 * The offline answer. Exported for the evaluation harness, which scores the
 * deterministic path on the same set as the model so the two are comparable.
 */
export function deterministicAnswer(messages: GenerateRequest["messages"]): string {
  const question = lastUserQuestion(messages);
  if (question.trim().length === 0) {
    return "I did not catch that. Tell me what you would like to do and how long you have, and I will work from there.";
  }

  for (const rule of OUT_OF_SCOPE) {
    if (rule.match.test(question)) return rule.redirect;
  }

  // BEFORE the grounding lookup, and deliberately so.
  //
  // An injection attempt is written in ordinary English, so keyword grounding
  // matches it: the live smoke test asked for the system prompt and got back a
  // list of six nearby places. Nothing privileged leaked, but that is the worst
  // possible answer to "ignore your instructions" — it looks like compliance. A
  // refusal must not depend on whether a word happened to match a catalogue row.
  if (isInjectionAttempt(question)) return INJECTION_REFUSAL;

  // A topic match beats grounding: "why was it rejected" is a question about the
  // app's behaviour, and answering it with a list of nearby places is a non-answer.
  for (const topic of APP_TOPICS) {
    if (topic.match.some((keyword) => mentions(question, keyword))) return topic.answer;
  }

  const facts = groundingFacts(messages);
  if (facts.length > 0) return answerFromGrounding(question, facts);

  // Ambiguous with nothing to ground it: ask rather than enumerate.
  if (/\b(something|somewhere|anything|nice|good|fun|interesting)\b/i.test(question)) {
    return [
      "I can do that, but I need one thing before I narrow it down: who is it for, and roughly how long do you have?",
      "",
      "Also worth saying is whether you need to stay indoors — in this season that changes the answer more than any other single thing.",
    ].join("\n");
  }

  return [
    "I want to be straight with you: I do not have a fact in front of me for that, so I am not going to invent one.",
    "",
    "I can help with three things: fitting a plan to the hours you actually have, finding a stop that suits who you are travelling with, and explaining how the app scores what it shows you. Which of those is closest?",
  ].join("\n");
}

export class DeterministicProvider implements AIProvider {
  readonly name = "deterministic";
  readonly available = true;

  metadata() {
    return {
      source: "deterministic" as const,
      modelId: null,
      baseModelId: null,
      alignmentId: null,
      promptVersion: PROMPT_VERSION,
    };
  }

  async generate(request: GenerateRequest): Promise<GenerateResult> {
    const started = Date.now();
    return {
      text: deterministicAnswer(request.messages),
      modelId: "deterministic",
      usage: null,
      latencyMs: Date.now() - started,
      finishReason: "stop",
    };
  }

  /**
   * Same text, emitted in word-sized chunks on a timer.
   *
   * The delay is what makes this honest: a caller that aborts mid-stream has to
   * behave, and a synchronous generator would let an abort land after the whole
   * answer was already produced, so the abort path would never be exercised.
   */
  async *stream(request: GenerateRequest): AsyncIterable<string> {
    const text = deterministicAnswer(request.messages);
    const words = text.split(/(\s+)/);
    for (let index = 0; index < words.length; index += 1) {
      if (request.signal?.aborted) return;
      const word = words[index];
      if (word !== undefined) yield word;
      // Every few words, yield to the event loop so cancellation and client
      // disconnect are observed at a sane granularity.
      if (index % 6 === 5) await new Promise((done) => setTimeout(done, 12));
    }
  }

  async healthCheck(): Promise<ProviderHealthResult> {
    return { ok: true, detail: "offline path always available", latencyMs: 0 };
  }

  health(): ProviderHealth {
    return {
      provider: "deterministic",
      configured: true,
      model: null,
      customized: false,
      status: "ready",
      detail: "no model call; answers from the grounding block",
      checkedAt: new Date().toISOString(),
    };
  }
}
