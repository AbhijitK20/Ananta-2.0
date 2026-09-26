/**
 * The whole situation, in one line.
 *
 * This replaced a seven-panel home page. The state that used to be spread across
 * a left column of sliders, a results list, a plan timeline, a map and four more
 * panels is now one sentence a person can read at a glance, with a link to
 * change it. Everything the traveller told us is still here — nothing was
 * dropped, it just stopped taking up the screen to say it.
 *
 * It is a link, not a control, on purpose. A row of inputs is what made the old
 * page unreadable; a summary that opens an editor is the same information at a
 * fraction of the cost.
 */

import Link from "next/link";
import type { DiscoveryContext } from "@/contracts";
import { formatMinutes } from "./SituationEditor";

const PARTY_LABEL: Record<string, string> = {
  solo: "Solo",
  couple: "Two of you",
  family_with_children: "Family",
  family_teens: "Teens",
  friends: "Friends",
  business: "Work",
  solo_female: "Solo",
  older_adults: "Older adults",
};

const WEATHER_LABEL: Record<string, string> = {
  clear: "Clear",
  cloudy: "Cloudy",
  light_rain: "Light rain",
  heavy_rain: "Heavy rain",
  storm: "Storm",
  heat: "Hot",
  wind: "Windy",
};

const NEED_LABEL: Record<string, string> = {
  wheelchair: "step-free",
  stroller: "stroller-friendly",
  lowStairs: "few stairs",
  hearingLoop: "hearing loop",
  restroom: "restroom on site",
};

export interface ContextBarProps {
  context: DiscoveryContext;
  /** Query string carrying the current situation, for the links. */
  query: string;
  /** How many stops the plan holds, so the bar can link to it. */
  stopCount: number;
  rowCount: number;
}

export function ContextBar({ context, query, stopCount, rowCount }: ContextBarProps) {
  const budget =
    context.budget === null
      ? "No budget limit"
      : `₹${Math.round(context.budget.minor / 100).toLocaleString("en-IN")}`;

  const needs = context.accessNeeds.map((need) => NEED_LABEL[need] ?? need);

  const facts = [
    formatMinutes(context.availableMin),
    budget,
    PARTY_LABEL[context.partyType] ?? `${context.partySize} people`,
    `${context.partySize} ${context.partySize === 1 ? "person" : "people"}`,
    WEATHER_LABEL[context.weather.condition] ?? context.weather.condition,
    ...needs,
  ].filter((fact, index, all) => all.indexOf(fact) === index);

  return (
    <div className="border-b border-rule bg-surface px-4 py-3">
      <div className="mx-auto flex max-w-[100rem] flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-sm font-medium text-ink">{context.origin.label}</h1>

        <ul className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
          {facts.map((fact) => (
            <li key={fact} className="flex items-center gap-2">
              <span aria-hidden className="text-rule">
                ·
              </span>
              {fact}
            </li>
          ))}
        </ul>

        <div className="ml-auto flex items-center gap-2">
          <span className="hidden text-xs text-ink-muted sm:inline">
            {rowCount.toLocaleString("en-IN")} places
          </span>
          <Link
            href={`/plan?${query}`}
            className="rounded-md border border-rule px-2.5 py-1 text-sm text-ink hover:border-accent"
          >
            Your plan{stopCount > 0 ? ` (${stopCount})` : ""}
          </Link>
          <Link
            href={`/tune?${query}`}
            className="rounded-md bg-ink px-2.5 py-1 text-sm text-surface hover:bg-ink/90"
          >
            Change
          </Link>
        </div>
      </div>
    </div>
  );
}
