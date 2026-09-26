"use client";

import { useRouter } from "next/navigation";

import type { Experience, Plan } from "@/contracts";
import { PlanTimeline } from "./PlanTimeline";

/**
 * Client wrapper so the plan can navigate.
 *
 * `PlanTimeline` is a client component and takes an `onOpenLedger` callback. A
 * server component cannot hand a function to a client component, so the page
 * passes the query string and this does the navigation. Small, but it keeps the
 * `window.location.href` out of a server file, where it would be a bug rather
 * than a smell.
 */
export function PlanTimelineLink({
  plan,
  experiences,
  query,
}: {
  plan: Plan;
  experiences: ReadonlyMap<string, Experience>;
  query: string;
}) {
  const router = useRouter();
  return (
    <PlanTimeline
      plan={plan}
      experiences={experiences}
      onOpenLedger={(id) => router.push(`/why?${query}&id=${encodeURIComponent(id)}`)}
    />
  );
}
