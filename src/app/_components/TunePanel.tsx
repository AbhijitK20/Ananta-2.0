"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import type { DiscoveryContext, Rejection } from "@/contracts";
import type { PlaceOption } from "../_lib/place";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { AccessibilityControls } from "./AccessibilityControls";
import { RealityPanel } from "./RealityPanel";
import { SituationEditor } from "./SituationEditor";
import { LearnedWeights } from "@/components/fit";

/**
 * Everything you can change, on one page.
 *
 * The situation editor, the accessibility needs, the "what would have to be
 * true" triggers and the learned weights were spread across the home page's
 * three columns, which is most of why the home page felt like seven products.
 * They are all inputs, so they belong together and the map belongs on its own.
 *
 * State is the URL. Every edit is a navigation, so the back button undoes a
 * change, a plan is shareable by copying the address, and there is no client
 * state to fall out of sync with the server-rendered plan.
 */
export function TunePanel({
  initialContext,
  query,
  firstStopId,
  places,
  rejections,
  profile,
}: {
  initialContext: DiscoveryContext;
  query: string;
  /** Handed to the sold-out trigger, which names a specific stop. */
  firstStopId: string | null;
  /** Resolvable places for the origin box. */
  places: ReadonlyArray<PlaceOption>;
  rejections: ReadonlyArray<Rejection>;
  profile: {
    weights: Readonly<Record<string, number>>;
    source: "prior" | "learned" | "user_edited";
    observations: number;
    version: string;
  };
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  const apply = useCallback(
    (patch: Partial<DiscoveryContext>) => {
      // The URL is the state. `original` is deliberately not touched: it is the
      // baseline the replanner diffs against, so widening the window has to stay
      // visible as a change rather than silently becoming the new normal. The
      // `was` / `intent` / `changed` history params are carried untouched for
      // the same reason.
      setPending(true);
      const params = new URLSearchParams(query);
      if (patch.availableMin !== undefined) params.set("t", String(patch.availableMin));
      if (patch.budget !== undefined) {
        const rupees = patch.budget === null ? 5000 : Math.round(patch.budget.minor / 100);
        if (rupees >= 5000) params.delete("b");
        else params.set("b", String(rupees));
      }
      if (patch.partySize !== undefined) params.set("p", String(patch.partySize));
      if (patch.partyType !== undefined) params.set("pt", patch.partyType);
      if (patch.childAges !== undefined) {
        if (patch.childAges.length) params.set("ages", patch.childAges.join(","));
        else params.delete("ages");
      }
      if (patch.interests !== undefined) {
        if (patch.interests.length) params.set("i", patch.interests.join(","));
        else params.delete("i");
      }
      if (patch.avoid !== undefined) {
        if (patch.avoid.length) params.set("avoid", patch.avoid.join(","));
        else params.delete("avoid");
      }
      /*
        Only the label. The coordinate is re-resolved on the server from the
        label, so a client cannot hand the engine a point that disagrees with the
        place the traveller named.
      */
      if (patch.origin !== undefined) params.set("at", patch.origin.label);
      if (patch.accessNeeds !== undefined) {
        if (patch.accessNeeds.length) params.set("needs", patch.accessNeeds.join(","));
        else params.delete("needs");
      }
      if (patch.weather !== undefined) params.set("w", patch.weather.condition);
      if (patch.travelMode !== undefined) params.set("m", patch.travelMode);
      router.push(`/tune?${params.toString()}`);
    },
    [query, router],
  );

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-caps text-ink-muted">Your situation</h2>
        <div className="mt-4">
          <SituationEditor
            context={initialContext}
            onChange={apply}
            places={places}
            pending={pending}
          />
        </div>
        <div className="mt-4 flex gap-2">
          <Button variant="primary" onClick={() => router.push(`/?${query}`)} loading={pending}>
            Show what fits
          </Button>
          <Button variant="ghost" onClick={() => router.push(`/plan?${query}`)}>
            See the plan
          </Button>
        </div>
      </Card>

      <AccessibilityControls />

      <Card>
        <RealityPanel
          context={initialContext}
          query={query}
          firstStopId={firstStopId}
          pending={pending}
        />
        <div className="mt-3">
          {/*
            Not a "reality changed" trigger, so it produces no diff: the traveller
            is choosing to give themselves more time rather than reporting that
            something went wrong. It still goes through the same `apply`, so it
            cannot drift from the slider it sits under.
          */}
          <Button size="sm" onClick={() => apply({ availableMin: initialContext.availableMin + 45 })}>
            Add 45 minutes
          </Button>
        </div>
      </Card>

      <Card>
        <LearnedWeights
          weights={profile.weights}
          source={profile.source}
          observations={profile.observations}
          version={profile.version}
        />
      </Card>

      {rejections.length > 0 ? (
        <Card>
          <h2 className="text-caps text-ink-muted">Why things were ruled out</h2>
          <ul className="mt-3 space-y-1.5 text-sm text-ink-muted">
            {rejections.slice(0, 8).map((item) => (
              <li key={`${item.experienceId}-${item.code}`}>{item.message}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
