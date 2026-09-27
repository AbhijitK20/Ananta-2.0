import type { Metadata } from "next";

import { PlanView } from "./PlanView";

/* The stylesheet sits at app/plan.css, beside the other interior stylesheets, so
   a route that grows a second folder still imports `../x.css` like its siblings.
   app/twin.css is imported for the same reason and under the same rule: the
   weather twin is a panel inside this page, not a route of its own. */
import "../plan.css";
import "../twin.css";

export const metadata: Metadata = {
  title: "Plan a trip",
  description:
    "Build an itinerary from the directory: add places, drop pins, set a daily driving limit and see how many nights the trip needs.",
};

export default function PlanPage() {
  return <PlanView />;
}
