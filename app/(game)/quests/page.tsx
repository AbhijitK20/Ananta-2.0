"use client";

/**
 * The quest board.
 *
 * Grouped by tier rather than as one flat sorted list. Sorting alone put a
 * 0/200 grand quest directly above a 1/1 city clearance, which reads as though
 * the second were the harder of the two.
 *
 * Within each tier the sort is the same as the home page's: claimables first,
 * then closest to done. That means the claimable ones do not stay buried at the
 * bottom of a long tier.
 */

import Link from "next/link";
import { useMemo, useState } from "react";

import { QuestCard } from "../../../components/QuestCard";
import { QUESTS, sortForBoard, TIER_LABELS, TIER_ORDER } from "../../../lib/game/quests";
import { useProgress } from "../../../lib/game/store";
import type { Quest } from "../../../lib/game/types";

type Filter = "open" | "claimable" | "claimed" | "all";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "open", label: "In progress" },
  { id: "claimable", label: "Ready" },
  { id: "claimed", label: "Claimed" },
  { id: "all", label: "All" },
];

export default function QuestsPage() {
  const { quests, hydrated } = useProgress();
  const [filter, setFilter] = useState<Filter>("open");

  const counts = useMemo(
    () => ({
      open: quests.filter((q) => !q.claimed && !q.claimable).length,
      claimable: quests.filter((q) => q.claimable).length,
      claimed: quests.filter((q) => q.claimed).length,
      all: quests.length,
    }),
    [quests],
  );

  const visible = useMemo(() => {
    const board = sortForBoard(quests);
    switch (filter) {
      case "open":
        return board.filter((q) => !q.claimed && !q.claimable);
      case "claimable":
        return board.filter((q) => q.claimable);
      case "claimed":
        return board.filter((q) => q.claimed);
      case "all":
        return board;
    }
  }, [quests, filter]);

  const byTier = useMemo(() => {
    const map = new Map<Quest["tier"], typeof visible>();
    for (const state of visible) {
      const bucket = map.get(state.quest.tier);
      if (bucket) bucket.push(state);
      else map.set(state.quest.tier, [state]);
    }
    return map;
  }, [visible]);

  return (
    <div className="lq-page">
      <header className="lq-head">
        <p className="lq-head__eyebrow">{QUESTS.length} quests</p>
        <h1 className="lq-head__title">The quest board</h1>
        <p className="lq-head__sub">
          Quest progress is read off your stamps, not tracked separately — so it
          can never fall behind the album. Rewards pay out once, when you claim.
        </p>
      </header>

      <div className="lq-card" style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {FILTERS.map((option) => (
          <button
            key={option.id}
            type="button"
            className={`lq-btn lq-btn--sm ${
              filter === option.id ? "" : "lq-btn--quiet"
            }`}
            aria-pressed={filter === option.id}
            onClick={() => setFilter(option.id)}
          >
            {option.label}
            <span aria-hidden="true"> · {counts[option.id]}</span>
          </button>
        ))}
      </div>

      {visible.length === 0 ? (
        <div className="lq-out" style={{ marginTop: 24 }}>
          {filter === "claimable"
            ? "Nothing ready to claim right now. Stamp a few more places and come back."
            : filter === "claimed"
              ? "No quests claimed yet."
              : hydrated
                ? "Every quest in this filter is done. Try another tab."
                : "Loading your progress…"}
        </div>
      ) : null}

      {TIER_ORDER.map((tier) => {
        const states = byTier.get(tier);
        if (!states?.length) return null;
        return (
          <section className="lq-tier" key={tier} aria-labelledby={`lq-tier-${tier}`}>
            <h2 className="lq-tier__title" id={`lq-tier-${tier}`}>
              {TIER_LABELS[tier]}
            </h2>
            <p className="lq-tier__note">
              {states.length} shown
              {tier === "city"
                ? " — one per city with two or more places, so anywhere you have collected has a quest."
                : tier === "category"
                  ? " — each is a quarter of the places carrying that tag."
                  : ""}
            </p>
            <ul className="lq-grid lq-grid--wide">
              {states.map((state) => (
                <QuestCard key={state.quest.id} state={state} />
              ))}
            </ul>
          </section>
        );
      })}

      <p className="lq-section__note" style={{ padding: "26px 0 8px" }}>
        Stuck on a city quest? <Link href="/cities">Browse cities</Link> or{" "}
        <Link href="/stamps">open the album</Link>.
      </p>
    </div>
  );
}
