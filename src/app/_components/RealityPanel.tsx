"use client";

import type { DiscoveryContext } from "@/contracts";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

import { cn } from "@/components/cn";
import { Button } from "@/components/ui/Button";
import { CONTEXT_TRIGGERS, queryForTrigger, type ContextTrigger } from "../_lib/triggers";

export interface RealityPanelProps {
  /** The traveller's situation, for the triggers that move a window. */
  context: DiscoveryContext;
  /** The query the panel's own buttons build on. */
  query: string;
  /** The stop the sold-out trigger removes. Null when the plan is empty. */
  firstStopId: string | null;
  pending?: boolean;
  className?: string;
}

/**
 * RealityPanel — the six things that go wrong in a real day.
 *
 * Each one writes a real `DiscoveryContext` field and navigates. The previous
 * version handed the route handler a `ContextChange` with an empty `patch`,
 * which — because this app keeps the situation in the URL, not in a store —
 * meant every button navigated to the address it came from. The triggers and
 * their patches now live in `_lib/triggers.ts`, which both this panel and the
 * server-side diff read, so the button and the explanation cannot disagree about
 * what "it started raining" means.
 *
 * The metric that matters is at most two swaps per trigger. The count is
 * rendered by `SwapDiff` above this panel, including when it is over, because a
 * replan that returns five changes is a finding about the engine rather than a
 * state to ship quietly.
 */
export function RealityPanel({
  context,
  query,
  firstStopId,
  pending = false,
  className,
}: RealityPanelProps) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const apply = useCallback(
    (trigger: ContextTrigger) => {
      setBusy(true);
      const next = queryForTrigger(trigger, {
        params: new URLSearchParams(query),
        context,
        firstStopId,
      });
      router.push(`/tune?${next}`);
    },
    [context, firstStopId, query, router],
  );

  return (
    <div className={cn("min-w-0", className)}>
      <h2 className="text-caps text-ink-muted">Reality changed</h2>
      <p className="mt-1 text-meta-sm text-ink-muted">
        Six things that go wrong in a real day. Each one re-solves the plan and
        shows what it swapped.
      </p>

      <ul className="mt-3 space-y-1.5">
        {CONTEXT_TRIGGERS.map((trigger) => {
          // `soldout` names a specific stop. With an empty plan there is none to
          // name, so the button says so in its own detail line and is disabled —
          // a live button that navigated to an unchanged URL is the bug this
          // panel was rewritten to remove.
          const blocked = trigger.key === "soldout" && !firstStopId;
          return (
            <li key={trigger.key}>
              <Button
                variant="secondary"
                fullWidth
                disabled={pending || busy || blocked}
                onClick={() => apply(trigger)}
                className="h-auto justify-start py-2 text-left"
              >
                <span className="min-w-0">
                  <span className="block truncate">{trigger.label}</span>
                  <span className="block truncate text-meta-sm text-ink-muted">
                    {blocked ? "Nothing is in the plan to replace" : trigger.detail}
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
