import type { Metadata } from "next";

import { TripPlanner } from "../../components/TripPlanner";
import "../planner.css";

export const metadata: Metadata = {
  title: "Plan a trip",
  description:
    "A trip planner: set a start and an end, loop it back, drop stops on the map, drag them into order and filter the route by how far you will drive in a day.",
};

/**
 * This route used to be the Social Impact directory. It now rebuilds Furkot's
 * trip planner, which is a different product on a different design system --
 * see the header of app/planner.css for what is measured from the live site and
 * what came from a screenshot, and why the map half is the weaker of the two.
 *
 * There is deliberately no Header or Footer wrapper here. The planner is a
 * full-bleed map with its own toolbar and its own edge tabs, and the root
 * layout's chrome would sit on top of both. planner.css hides that chrome for
 * this route rather than leaving it invisible but focusable behind the map.
 */
export default function PlanTripPage() {
  return <TripPlanner />;
}
