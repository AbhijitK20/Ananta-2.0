import { NextResponse } from "next/server";

import { SCENARIO_BOUNDS } from "@/features/twin";
import { computeTwin } from "../../_lib/twin";

/**
 * `POST /api/twin` — run one what-if and return the plan it produces.
 *
 * The page already does this server-side by reading search params, so this route
 * exists for the two callers a page cannot serve: a script that wants to sweep a
 * range of scenarios, and a client that wants the answer without a full route
 * transition. Both get exactly the same `computeTwin()` the page gets, so there is
 * one implementation of "what does this weather do to the plan" and not two that
 * can disagree.
 *
 * Two deliberate limits, both about not being a denial-of-service surface:
 *
 *  - **Body capped at 8 KB.** The request is a handful of numbers; anything larger
 *    is not a what-if.
 *  - **No rate limit, but the expensive half is process-cached.** The catalogue, the
 *    graph and the model fit are memoised, so the marginal cost of a request is two
 *    plan solves plus at most one live call. The live call is opt-in via `live`,
 *    because a sweep of forty scenarios should not make forty Open-Meteo requests.
 *
 * The response is the twin report minus the parts a client cannot use: the catalogue
 * is not serialised, and `provenance` is always present so a caller can tell a
 * simulation from an observation.
 */
export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 8 * 1024;

export async function POST(request: Request) {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "Request body was too large." }, { status: 413 });
  }

  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) {
      return NextResponse.json({ error: "Request body was too large." }, { status: 413 });
    }
    body = text.length === 0 ? {} : JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "Request body was not valid JSON." }, { status: 400 });
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Expected a JSON object." }, { status: 400 });
  }

  const payload = body as Record<string, unknown>;
  const params = new URLSearchParams();

  // Traveller's situation, forwarded verbatim so a what-if is simulated against the
  // same day the caller already planned. Unknown keys are dropped by
  // `contextFromParams`, which is the same validation the page gets.
  for (const key of ["t", "b", "p", "pt", "needs", "m", "now"]) {
    const value = payload[key];
    if (typeof value === "string" && value.length > 0) params.set(key, value);
  }
  // The weather. Numeric fields are validated against the same bounds the sliders
  // use, so an API caller cannot construct a scenario the UI cannot reach — which
  // would make the two paths disagree about what "a flood" means.
  for (const [key, bound] of Object.entries(SCENARIO_BOUNDS)) {
    const value = payload[key];
    if (typeof value !== "number" || !Number.isFinite(value)) continue;
    params.set(key, String(Math.min(bound.max, Math.max(bound.min, value))));
  }
  if (typeof payload.date === "string") params.set("date", payload.date);
  if (typeof payload.hour === "number" && Number.isFinite(payload.hour)) {
    params.set("hour", String(Math.min(23, Math.max(0, Math.round(payload.hour)))));
  }

  const live = payload.live === true;
  if (live) params.set("live", "1");

  try {
    const report = await computeTwin({ params, live });
    return NextResponse.json(
      {
        scenario: report.scenario,
        condition: report.condition,
        hazards: report.twin.hazards,
        summary: report.twin.summary,
        cascades: report.twin.cascades,
        corridors: report.twin.corridors,
        provenance: report.twin.provenance,
        delta: report.delta,
        plan: {
          id: report.simulated.plan.id,
          stops: report.simulated.plan.stops.map((stop) => ({
            experienceId: stop.experienceId,
            arriveMin: stop.arriveMin,
            departMin: stop.departMin,
            why: stop.why,
          })),
          totalMin: report.simulated.plan.totalMin,
          totalCost: report.simulated.plan.totalCost,
          totalMetres: report.simulated.plan.totalMetres,
          utilisation: report.simulated.plan.utilisation,
          stressScore: report.simulated.plan.stressScore,
          engineVersion: report.simulated.plan.engineVersion,
        },
        validation: report.simulated.validation,
        closed: report.closedCount,
        stretched: report.stretchedCount,
        mostAffected: report.mapNodes.slice(0, 20),
        elapsedMs: report.elapsedMs,
      },
      {
        headers: {
          // Same honesty contract as `/api/discover`: the caller can always tell
          // which of the three inputs was real.
          "x-twin-weather": report.observation.weatherSource,
          "x-twin-model": report.twin.provenance.modelSource,
          "x-twin-observations": String(report.twin.provenance.observations),
        },
      },
    );
  } catch (error) {
    // A 500 here means the catalogue or the manifest is unreadable, which is a
    // deployment fault rather than a bad request — and it is worth saying which,
    // because "the twin is broken" and "the twin could not find its data" call for
    // completely different responses.
    return NextResponse.json(
      {
        error: "The simulation could not run.",
        detail: error instanceof Error ? error.message : "unknown failure",
      },
      { status: 500 },
    );
  }
}
