"use client";

import { useRouter } from "next/navigation";
import { ArrowRight, Compass } from "lucide-react";
import { type FormEvent, useState } from "react";

/**
 * Natural-language entry point into the real retrieval engine.
 *
 * Ported from the `ananta` prototype, with the browse chips rewritten. The
 * prototype invented its own query vocabulary — `?free=1`, `?gems=1`,
 * `?walkable=1`, `?bestTime=Best%20in%20the%20morning` — and none of those
 * parameters exist anywhere in this app, so every chip was a dead link dressed
 * as a feature. These map onto the parameter names `computeDiscovery` actually
 * reads (`needs`, `where`, `window`, `budget`, `travellers`, `rain`,
 * `vegetarian`, `wheelchair`, ...), so tapping one runs a real query and the
 * resulting screen is the real plan.
 *
 * Two behavioural changes beyond the parameters:
 *
 * - `router.push` instead of `window.location.href`. The prototype threw away
 *   the whole client runtime on every search.
 * - The free-text box sends `needs`. There is no `q` in this engine, so a
 *   natural-language sentence is a *need*, and `where` is a separate, more
 *   specific field.
 */

const QUICK_REQUESTS = [
  { label: "45 minutes", params: { window: "45" } },
  { label: "Before my train", params: { window: "90", needs: "near a station" } },
  { label: "Under ₹800", params: { budget: "800" } },
  { label: "Rainy day", params: { rain: "1" } },
] as const;

/**
 * One-tap filters. Each entry is a real engine parameter, not a decorative
 * label — see the note above on why the prototype's equivalents were dropped.
 */
const BROWSE_FILTERS = [
  { label: "Food", params: { category: "food" } },
  { label: "Nature", params: { category: "nature" } },
  { label: "Culture", params: { category: "culture" } },
  { label: "Nightlife", params: { category: "nightlife" } },
  { label: "Vegetarian", params: { vegetarian: "1" } },
  { label: "Halal", params: { halal: "1" } },
  { label: "Step-free", params: { wheelchair: "1" } },
  { label: "Rainy day", params: { rain: "1" } },
  { label: "Two travellers", params: { travellers: "2" } },
] as const;

type Params = Record<string, string>;

function planHref(params: Params): string {
  const search = new URLSearchParams(params).toString();
  return search ? `/plan?${search}` : "/plan";
}

export function DiscoverySearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const needs = query.trim();
    router.push(planHref(needs ? { needs } : {}));
  };

  return (
    <form onSubmit={submit} className="mt-9 max-w-[600px]">
      <label htmlFor="discovery-query" className="sr-only">
        Describe what you want to do
      </label>
      <div className="focus-within:border-accent flex items-center gap-3 rounded-xl border border-rule bg-canvas px-4 py-3 shadow-sm">
        <Compass size={22} className="shrink-0 text-ink-muted" aria-hidden="true" />
        <input
          id="discovery-query"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="I have 3 hours near CST and want local food"
          className="text-ink placeholder:text-ink-faint min-w-0 flex-1 bg-transparent text-sm outline-none"
        />
        <button
          type="submit"
          aria-label="Search experiences"
          className="bg-accent text-on-accent rounded-lg p-2"
        >
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>

      <div className="mt-3 flex flex-wrap gap-2">
        {QUICK_REQUESTS.map((request) => (
          <button
            key={request.label}
            type="button"
            onClick={() => router.push(planHref({ ...request.params }))}
            className="border-rule bg-surface text-ink hover:border-accent hover:text-accent rounded-lg border px-3 py-2 text-sm font-semibold"
          >
            {request.label}
          </button>
        ))}
      </div>
      <p className="text-ink-muted mt-2 text-xs leading-5">
        Every chip is a real query against the plan engine, not placeholder text.
      </p>

      <p className="text-ink-muted mt-5 text-[10px] font-bold uppercase tracking-[0.14em]">
        Browse by
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {BROWSE_FILTERS.map((filter) => (
          <button
            key={filter.label}
            type="button"
            onClick={() => router.push(planHref({ ...filter.params }))}
            className="border-rule bg-surface text-ink hover:border-accent hover:text-accent rounded-full border px-3.5 py-1.5 text-sm font-semibold"
          >
            {filter.label}
          </button>
        ))}
      </div>
    </form>
  );
}
