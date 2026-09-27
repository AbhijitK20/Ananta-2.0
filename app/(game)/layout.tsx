import type { ReactNode } from "react";

import { GameShell } from "../../components/GameShell";
import { ProgressProvider } from "../../lib/game/store";

/**
 * The gamified layer, scoped to its own routes.
 *
 * `GameShell` is the XP rail and the bottom nav, and it is deliberately NOT in
 * the root layout. The clone is a brochure and this is a game; a fixed shell
 * wrapped around every page would put a progress bar and a game nav on top of
 * the landing page, the city index and the globe, which are not game surfaces
 * and should look like the site they always have.
 *
 * A route group is what makes that scoping possible. The directory name does
 * not appear in the URL, so these still serve `/quests`, `/stamps`,
 * `/cities/<slug>` and `/pick/<city>/<slug>` — they are just rendered inside
 * this layout instead of the root one.
 *
 * The provider lives here for the same reason. It has to sit above every game
 * route so the rail survives navigation between them, but it reads and writes
 * localStorage, and there is no reason for a visitor who only ever reads the
 * brochure to pay for that.
 */
export default function GameLayout({ children }: { children: ReactNode }) {
  return (
    <ProgressProvider>
      <GameShell>{children}</GameShell>
    </ProgressProvider>
  );
}
