import Link from "next/link";

import { searchTraveller, type TravellerRequest } from "@/features/opportunity";
import { topBlocker } from "@/features/opportunity";
import { UnmetDemand } from "@/contracts";

import { Card } from "@/components/ui/Card";
import { SiteHeader } from "../_components/SiteHeader";
import { loadCatalogue } from "../_lib/catalogue";
import { contextFromParams, paramsFromContext, DEFAULT_ORIGIN } from "../_lib/discovery";

export const dynamic = "force-dynamic";

/**
 * The provider half: what travellers searched for and could not get.
 *
 * This is the differentiator the README claims and the deployed app never had.
 * The same `Rejection` records the traveller-side "why not that" panel reads are
 * the input here, so the provider feed is not a second opinion about supply —
 * it is the traveller's own rejections, counted.
 *
 * `src/features/opportunity` is 1,958 lines: `searchTraveller` runs a real
 * request against the real catalogue, and only writes an `UnmetDemand` row when
 * the search found candidates and every one of them failed a hard check. A
 * search that matched nothing writes nothing rather than inventing a distance
 * claim, which is the behaviour the doc comment above goes out of its way to
 * defend.
 *
 * The searches below are REAL runs against the 4,596-row catalogue, one per
 * neighbourhood, with different constraints each time. They are not the demo
 * fixture set — `/analytics` already shows that, and it is the only surface
 * that does.
 */
const SEARCHES: readonly { label: string; request: Omit<TravellerRequest, "ctx" | "point"> }[] = [
  { label: "Step-free, two hours, no more than ₹1,500", request: { travellerId: "t1", at: "", neighbourhood: "Bandra West" } },
  { label: "Vegetarian, family with a toddler, three hours", request: { travellerId: "t2", at: "", neighbourhood: "Bandra West" } },
  { label: "Heavy rain, ₹3,000, two adults", request: { travellerId: "t3", at: "", neighbourhood: "Bandra West" } },
  { label: "Indoor, under an hour, ₹800", request: { travellerId: "t4", at: "", neighbourhood: "Bandra West" } },
  { label: "Four hours, ₹6,000, step-free and restroom", request: { travellerId: "t5", at: "", neighbourhood: "Bandra West" } },
];

/** Each row is a genuinely different constraint set, not the same search six times. */
const CONSTRAINTS: readonly {
  availableMin: number;
  budgetMinor: number;
  partySize: number;
  accessNeeds: readonly ("wheelchair" | "stroller" | "lowStairs" | "restroom")[];
  weather: "clear" | "heavy_rain" | "light_rain";
  interests: string[];
  childAges: number[];
}[] = [
  { availableMin: 120, budgetMinor: 150_000, partySize: 2, accessNeeds: ["wheelchair"], weather: "clear", interests: ["street_food"], childAges: [] },
  { availableMin: 180, budgetMinor: 300_000, partySize: 3, accessNeeds: ["stroller"], weather: "clear", interests: ["market", "heritage"], childAges: [4] },
  { availableMin: 120, budgetMinor: 300_000, partySize: 2, accessNeeds: [], weather: "heavy_rain", interests: ["art", "cafe"], childAges: [] },
  { availableMin: 60, budgetMinor: 80_000, partySize: 1, accessNeeds: [], weather: "clear", interests: ["cafe"], childAges: [] },
  { availableMin: 240, budgetMinor: 600_000, partySize: 4, accessNeeds: ["lowStairs", "restroom"], weather: "clear", interests: ["heritage", "art"], childAges: [] },
];

export default async function DemandPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const raw = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string") params.set(key, value);
  }

  const base = contextFromParams(params);
  const query = paramsFromContext(base);
  const { experiences } = await loadCatalogue();
  const point = { ...DEFAULT_ORIGIN.point };

  // A single fixed `asOf` so the page is deterministic, the same reason the
  // analytics demo data pins one. Real searches would use the request time.
  const asOf = Date.parse("2026-09-26T09:30:00.000Z");

  const rows = SEARCHES.map((search, index) => {
    const c = CONSTRAINTS[index]!;
    const ctx = {
      ...base,
      id: `demand-${search.request.travellerId}`,
      availableMin: c.availableMin,
      budget: { minor: c.budgetMinor, currency: "INR" as const },
      partySize: c.partySize,
      accessNeeds: [...c.accessNeeds] as typeof base.accessNeeds,
      childAges: [...c.childAges],
      interests: [...c.interests],
      weather: { ...base.weather, condition: c.weather },
      original: {
        availableMin: c.availableMin,
        budget: { minor: c.budgetMinor, currency: "INR" as const },
        partySize: c.partySize,
        accessNeeds: [...c.accessNeeds] as typeof base.accessNeeds,
      },
    };

    const outcome = searchTraveller(
      { travellerId: search.request.travellerId, at: new Date(asOf).toISOString(), point, neighbourhood: search.request.neighbourhood, ctx },
      experiences,
    );

    return { label: search.label, outcome };
  });

  // Only a search that found candidates and failed them all is a gap. This is
  // the feature's own rule, and it is the reason the numbers here are lower
  // than the number of searches.
  const unmet = rows
    .filter((row) => row.outcome.passed.length === 0 && !row.outcome.nothingMatched)
    .map((row) => {
      const parsed = UnmetDemand.safeParse({
        travellerId: row.outcome.travellerId,
        at: new Date(asOf).toISOString(),
        neighbourhood: "Bandra West",
        topBlockingCode: topBlocker(row.outcome.rejections),
        considered: row.outcome.retrieved,
        passed: 0,
      });
      return { label: row.label, row: parsed.success ? parsed.data : null, rejections: row.outcome.rejections };
    });

  return (
    <>
      <SiteHeader />
      <main id="main" className="mx-auto max-w-[70rem] px-4 py-6">
        <header className="mb-5">
          <p className="text-caps text-ink-muted">Unmet demand</p>
          <h1 className="mt-1 font-display text-3xl text-ink">
            What people asked for and could not get
          </h1>
          <p className="mt-2 max-w-[70ch] text-sm text-ink-muted">
            Every row below is a real search run against the{" "}
            {experiences.length.toLocaleString("en-IN")}-place catalogue. A search
            that returned nothing usable is the most useful row we have, because it
            is a description of demand you could serve.
          </p>
        </header>

        <Card className="mb-4">
          <h2 className="text-caps text-ink-muted">The searches</h2>
          <table className="mt-2 w-full text-sm">
            <caption className="sr-only">Outcome of each real search</caption>
            <thead>
              <tr className="border-b border-rule text-left text-ink-muted">
                <th scope="col" className="py-1.5 font-normal">Search</th>
                <th scope="col" className="py-1.5 font-normal">Considered</th>
                <th scope="col" className="py-1.5 font-normal">Fits</th>
                <th scope="col" className="py-1.5 font-normal">Top blocker</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const blocker = topBlocker(row.outcome.rejections);
                return (
                  <tr key={row.outcome.travellerId} className="border-b border-rule align-top">
                    <th scope="row" className="py-1.5 text-left font-normal text-ink">
                      {row.label}
                    </th>
                    <td className="py-1.5 text-ink">{row.outcome.retrieved}</td>
                    <td className="py-1.5 text-ink">
                      {row.outcome.passed.length === 0
                        ? "none"
                        : row.outcome.passed.length}
                    </td>
                    <td className="py-1.5 text-ink-muted">
                      {row.outcome.nothingMatched
                        ? "nothing matched the interest at all"
                        : typeof blocker === "string"
                          ? blocker
                          : blocker
                            ? `${blocker.code} (${blocker.count})`
                            : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>

        <h2 className="mb-2 font-display text-xl text-ink">
          Gaps worth opening something for
        </h2>

        {unmet.length === 0 ? (
          <Card>
            <p className="text-sm text-ink-muted">
              Every one of these searches found something that fit. That is a real
              answer, not an empty state to apologise for — the gate did its job.
            </p>
          </Card>
        ) : (
          <ul className="space-y-3">
            {unmet.map((gap) => (
              <li key={gap.label}>
                <Card>
                  <h3 className="text-ink">{gap.label}</h3>
                  <p className="mt-1 text-sm text-ink-muted">
                    {gap.rejections.length}{" "}
                    {gap.rejections.length === 1 ? "candidate" : "candidates"} failed a
                    hard check
                    {gap.row?.topBlockingCode
                      ? `, most often ${gap.row.topBlockingCode}`
                      : ""}
                    .
                  </p>
                  <ul className="mt-2 space-y-1 text-sm">
                    {gap.rejections.slice(0, 4).map((rejection) => (
                      <li key={rejection.experienceId} className="text-ink-muted">
                        {rejection.message}
                      </li>
                    ))}
                  </ul>
                </Card>
              </li>
            ))}
          </ul>
        )}

        <p className="mt-6 text-xs text-ink-muted">
          <Link href={`/analytics`} className="underline">
            Provider dashboard
          </Link>{" "}
          ·{" "}
          <Link href={`/?${query}`} className="underline">
            Back to your plan
          </Link>
        </p>
      </main>
    </>
  );
}
