import type { Metadata } from "next";

import { OracleChat } from "../../../components/OracleChat";

export const metadata: Metadata = {
  title: "Ask the catalogue",
  description:
    "The Local Legends assistant: a domain-aligned model answering questions about 890 local picks across 202 cities.",
};

/**
 * /oracle — the assistant, inside the game route group so it sits under the same
 * shell and can read the player's save from the same provider the stamp book
 * uses. Without that it would be guessing at progress; with it, every number the
 * assistant states is the number on screen.
 */
export default function OraclePage() {
  return (
    <div className="lq-page lq-page--narrow">
      <p className="lq-head__eyebrow">Local Legends</p>
      <h1 className="lq-head__title">Ask the catalogue</h1>
      <p className="lq-head__sub">
        A model aligned to this app&rsquo;s own corpus — 890 places, 202 cities, 222 quests. It reads
        the game for anything countable, so it cannot disagree with the stamp book.
      </p>
      <OracleChat />
    </div>
  );
}
