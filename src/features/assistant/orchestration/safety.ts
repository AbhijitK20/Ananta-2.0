/**
 * Input validation and output checks for the assistant.
 *
 * Two directions, and the second one is the one people forget.
 *
 * **Inbound** (`validateMessage`) runs at the trust boundary — a public POST
 * body. Length caps, shape validation, and a control-character strip. The caps are
 * not arbitrary: a 4,000-character cap is roughly 1,000 tokens, which is a
 * reasonable thing to send, and it is also the point past which a request starts
 * costing real money per call.
 *
 * **Outbound** (`screenResponse`) runs on generated text before it is stored and
 * before it is streamed to a browser. A model that has been talked into inventing
 * an opening time is a hallucination; one talked into emitting a script tag is an
 * XSS. Neither is prevented by asking nicely in the prompt, so this checks:
 *
 *   - raw HTML/script/iframe, which has no legitimate place in a chat reply and
 *     is the shape a stored-XSS payload takes;
 *   - prompt leakage, i.e. the model reciting its own instructions;
 *   - the specific fabrication the domain cannot tolerate — a price, an opening
 *     time or a duration asserted with no grounding fact behind it.
 *
 * The fabrication check is a heuristic and is labelled as one. It is a tripwire
 * that catches the obvious case; it is not a proof, and a reviewer reading this
 * should not believe otherwise.
 */
import { z } from "zod";

/** Roughly 1,000 tokens. A chat turn longer than this is a paste, not a question. */
export const MAX_MESSAGE_CHARS = 4000;
export const MAX_TITLE_CHARS = 80;

export const ChatRequest = z
  .object({
    conversationId: z.string().min(1).max(64).optional(),
    message: z.string().min(1, "Say something first.").max(MAX_MESSAGE_CHARS),
    /** App state the caller is looking at, passed in as grounding. Bounded. */
    context: z
      .object({
        city: z.string().max(64).optional(),
        neighbourhood: z.string().max(64).optional(),
        availableMin: z.number().int().min(0).max(1440).optional(),
        budgetMinor: z.number().int().min(0).max(100_000_000).optional(),
        partyType: z.string().max(32).optional(),
        stopCount: z.number().int().min(0).max(50).optional(),
        planId: z.string().max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ChatRequestBody = z.infer<typeof ChatRequest>;

export const ConversationIdParam = z.string().min(1).max(64);

/**
 * Strip control characters and normalise whitespace.
 *
 * Zero-width characters are included because they are invisible in a reviewer's
 * terminal and in a screenshot, which makes them a genuine review-evasion vector
 * for anything a human signs off on. They are stripped rather than rejected so a
 * copy-paste from a bad source degrades instead of erroring.
 */
export function sanitiseInput(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g, "")
    .replace(/\r\n/g, "\n")
    .trim();
}

export function validateMessage(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "message must be a string" };
  const value = sanitiseInput(raw);
  if (value.length === 0) return { ok: false, error: "message must not be empty" };
  if (value.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message is ${value.length} characters; the limit is ${MAX_MESSAGE_CHARS}` };
  }
  return { ok: true, value };
}

export type ScreenResult = { ok: true } | { ok: false; reason: string; sanitised: string };

/** Payloads with no legitimate reason to appear in a chat reply. */
const DANGEROUS_MARKUP =
  /<\s*(script|iframe|object|embed|svg|img|form|style|link|meta)\b|javascript:|data:text\/html|on(?:error|load|click|mouseover)\s*=/i;

/** The model reciting its own instructions back at the user. */
const PROMPT_LEAK =
  /\b(you are the travelbuddy assistant|SCOPE\.\s*You answer four things|GROUNDING\.\s*Each turn|my system prompt|above is my instructions)\b/i;

/**
 * A traveller (or something wearing a traveller's clothes) trying to move the
 * assistant off its job.
 *
 * Needed in code, not just in the prompt, because of an ordering bug the live
 * smoke test found: an injection attempt shares ordinary English words with the
 * catalogue, so keyword grounding matched, and the deterministic path answered
 * with a list of nearby places. Technically not a data leak — nothing privileged
 * came back — but it is the *worst possible* answer to "ignore your
 * instructions", because it looks like compliance. The dataset already teaches
 * the right behaviour; this makes the offline path do it too.
 *
 * Ordered before grounding for exactly that reason: a refusal must not depend on
 * whether a keyword happened to match a row.
 */
const INJECTION_ATTEMPT =
  /\b(ignore|disregard|forget|override)\b[^.?]{0,40}\b(previous|prior|above|earlier|all|any|your)\b[^.?]{0,30}\b(instruction|prompt|rule|direction|guideline|constraint)s?\b|\b(reveal|print|show|repeat|output|disclose|dump|echo)\b[^.?]{0,40}\b(your|my)\s+(?:\w+\s+){0,2}(prompt|instruction|rule|directive|guideline|context)s?\b|\byou are now\b|\bact as\b|\bDAN\b|\bjailbreak\b|\bdeveloper mode\b|\bpretend (you are|to be)\b|\bfrom now on,? (you|answer|respond|ignore)\b/i;

export const INJECTION_REFUSAL =
  "I am not going to do that, and I will not explain my instructions either. " +
  "I am still the TravelBuddy assistant: tell me about the hours, the budget or the stops and I will help with that.";

/** True when the message is an attempt to move the assistant off its job. */
export function isInjectionAttempt(message: string): boolean {
  return INJECTION_ATTEMPT.test(message);
}

export function screenResponse(text: string): ScreenResult {
  if (DANGEROUS_MARKUP.test(text)) {
    // Strip the markup rather than refusing to answer: the rest of the reply is
    // usually fine, and a refusal is a worse answer than a scrubbed one.
    return {
      ok: false,
      reason: "reply contained markup that has no place in a chat message; it was removed",
      sanitised: text.replace(/<[^>]*>/g, "").replace(/javascript:/gi, "").trim(),
    };
  }
  if (PROMPT_LEAK.test(text)) {
    return {
      ok: false,
      reason: "reply echoed the system prompt; it was withheld",
      sanitised:
        "I am not able to share my own instructions. Ask me about planning time in Mumbai, and I will help with that.",
    };
  }
  return { ok: true };
}

/**
 * A money or hours claim with no grounding behind it.
 *
 * Deliberately narrow: it fires on the shape "<number> rupees" or a clock time
 * appearing in a reply for a turn that supplied no facts. It will not catch every
 * hallucination and is not meant to; it catches the class that would survive into
 * a product as "the Bandstand closes at 10:30" when the catalogue never said so.
 */
export function ungroundedClaim(text: string, groundedFactCount: number): string | null {
  if (groundedFactCount > 0) return null;
  if (/\b\d{1,3}(?:,\d{3})*\s*(?:rupees|rs\.?)\b/i.test(text)) {
    return "asserted a price with no catalogue fact supplied";
  }
  if (/\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b/i.test(text)) {
    return "asserted a clock time with no catalogue fact supplied";
  }
  return null;
}

/** Rate-limit key material. Never includes message content. */
export function rateLimitKey(ownerId: string, ip: string | null): string {
  return ip ? `${ownerId}:${ip}` : ownerId;
}
