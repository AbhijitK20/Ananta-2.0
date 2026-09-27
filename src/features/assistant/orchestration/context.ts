/**
 * Context assembly — turning a conversation plus a new message into the exact
 * message list a provider receives.
 *
 * Three decisions live here.
 *
 * **The rolling summary.** A 3B-class model on a long context quietly starts
 * summarising and then answers the summary. So history is trimmed: once the
 * recent turns exceed a budget, everything older is replaced by a mechanical
 * digest and the raw turns are dropped. The digest is deterministic and
 * mechanical — it is not an LLM summary, because an LLM summariser would let a
 * user inject an instruction into their own conversation history and have it
 * promoted into context the model treats as authoritative.
 *
 * **The grounding block.** Assembled from the catalogue, injected as its own
 * system message, and never concatenated into the prompt text. If a fact could be
 * injected by a user it would not be a fact.
 *
 * **Roles, not concatenation.** User content arrives as a `user` message. There
 * is no code path anywhere in this feature that splices a traveller's words into
 * a system message, which is what makes injection resistance a structural
 * property rather than a property of the prompt's wording.
 */
import { GROUNDING_OPEN, SUMMARY_INSTRUCTION, SYSTEM_PROMPT, groundingBlock } from "../prompt";
import type { Message } from "../types";
import type { ProviderMessage } from "../provider/provider";

/** How many recent raw turns are kept before the digest takes over. */
export const RECENT_TURNS = 8;

/** Rough character budget for the recent window. ~4 chars per token. */
export const RECENT_CHAR_BUDGET = 6000;

export type ContextInput = {
  /** Prior turns, oldest first, already scoped to this conversation. */
  history: readonly Message[];
  /** The new traveller message. */
  message: string;
  /** Catalogue facts for this turn, already formatted as sentences. */
  facts: readonly string[];
  /** A mechanical digest of turns older than the recent window. */
  summary?: string | null;
};

export type AssembledContext = {
  messages: ProviderMessage[];
  /** How many prior turns were dropped in favour of the digest. */
  summarisedTurns: number;
  /** True when trimming actually removed anything. */
  trimmed: boolean;
};

/**
 * Mechanical digest of the dropped turns.
 *
 * Deliberately not a model call. Three reasons, in order of how much they
 * matter: it costs nothing on the hot path; it cannot be steered by whoever
 * wrote the earlier turns; and its output is inspectable, so a test can assert on
 * it. It keeps the first thing asked and the last thing asked, which is what a
 * follow-up question almost always refers back to.
 */
export function summariseTurns(turns: readonly Message[]): string {
  const users = turns.filter((turn) => turn.role === "user");
  if (users.length === 0) return "";
  const first = truncate(users[0]?.content ?? "", 160);
  const last = truncate(users[users.length - 1]?.content ?? "", 160);
  const lines = [`Earlier in this conversation the traveller asked (${users.length} messages):`];
  lines.push(`- first: "${first}"`);
  if (users.length > 1 && last !== first) lines.push(`- most recent: "${last}"`);
  return lines.join("\n");
}

function truncate(value: string, max: number): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function assembleContext(input: ContextInput): AssembledContext {
  const system: ProviderMessage[] = [{ role: "system", content: SYSTEM_PROMPT }];
  system.push({ role: "system", content: groundingBlock(input.facts) });

  // Only the user's own prior turns and the assistant's replies. A `system` row
  // in history is dropped: nothing in this feature writes one, and a stored one
  // would be a stored prompt injection.
  const usable = input.history.filter((turn) => turn.role === "user" || turn.role === "assistant");
  const complete = usable.filter((turn) => turn.status === "complete" || turn.status === "stopped");

  const recent = complete.slice(-RECENT_TURNS);
  let dropped = complete.slice(0, Math.max(0, complete.length - recent.length));

  // Enforce the character budget by pushing turns out of the recent window, from
  // the oldest end, so the newest context is always the one kept.
  let budget = RECENT_CHAR_BUDGET - input.message.length;
  while (recent.length > 2 && budget <= 0) {
    const evicted = recent.shift();
    if (evicted) dropped = [evicted, ...dropped];
    budget += recent.reduce((sum, turn) => sum + turn.content.length, 0);
  }

  const summary = input.summary?.trim() || summariseTurns(dropped);
  if (summary.length > 0) {
    system.push({ role: "system", content: `${SUMMARY_INSTRUCTION}\n\n${summary}` });
  }

  const turns: ProviderMessage[] = recent.map((turn) => ({
    role: turn.role === "assistant" ? "assistant" : "user",
    // A stopped turn kept its partial text; keeping it is honest about what was
    // said, and the model should see the partial rather than a gap.
    content: turn.content,
  }));

  return {
    messages: [...system, ...turns, { role: "user", content: input.message }],
    summarisedTurns: dropped.length,
    trimmed: dropped.length > 0,
  };
}

/** Exported for the health endpoint and tests; the block is what both providers read. */
export { groundingBlock, GROUNDING_OPEN };
