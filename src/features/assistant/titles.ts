/**
 * Conversation titles.
 *
 * Its own module because it is a pure string function and `store.ts` pulls in
 * `node:sqlite` and Drizzle. A unit test for "cut the title on a word boundary"
 * should not have to open a database module to get there.
 *
 * The rules it follows, all of which exist because the alternative looks fine in
 * a screenshot and is wrong in use:
 *
 *   - first *non-empty* line, because a leading blank line from a pasted
 *     paragraph would otherwise produce an untitled conversation;
 *   - collapsed whitespace, because a sidebar that renders three lines of
 *     wrapping is a sidebar nobody can scan;
 *   - cut on a word boundary, because a title ending mid-word ("where can I go
 *     in Ban…dra") reads as a rendering bug;
 *   - a fixed label rather than an empty string, because a blank sidebar entry
 *     is not selectable by anyone, including a screen reader.
 */
import { MAX_TITLE_CHARS, sanitiseInput } from "./orchestration/safety";

export const UNTITLED = "New chat";

export function titleFromMessage(content: string): string {
  const firstLine = sanitiseInput(content).split("\n").find((line) => line.trim().length > 0) ?? "";
  const flat = firstLine.replace(/\s+/g, " ").trim();
  if (flat.length === 0) return UNTITLED;
  if (flat.length <= MAX_TITLE_CHARS) return flat;
  const cut = flat.slice(0, MAX_TITLE_CHARS);
  // Only prefer a word boundary if it does not throw away most of the title.
  const space = cut.lastIndexOf(" ");
  return `${(space > 20 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
