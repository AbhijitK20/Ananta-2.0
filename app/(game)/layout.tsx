import type { ReactNode } from "react";

import { GameShell } from "../../components/GameShell";
import { ProgressProvider } from "../../lib/game/store";

import "../game.css";

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
 *
 * `game.css` is imported here rather than in the root layout for the same
 * reason. It is 1161 lines of `lq-` rules and none of them apply to a
 * brochure page, and it was not imported at all until this line existed -- the
 * game rendered as unstyled HTML inside the site chrome, which compiles
 * cleanly and typechecks, so nothing caught it.
 *
 * `lq-ground` is the other half of living inside someone else's layout. The
 * clone paints a fixed WebGL mesh at z-index -1, which deliberately paints over
 * the body background, so there is no body colour to set and the game was
 * reading as moving grey texture behind its own text. An opaque wrapper above
 * it gives the game back the plain light ground it was designed against. The
 * footer clearance it also sets lives in game.css, under `body:has()`.
 */
export default function GameLayout({ children }: { children: ReactNode }) {
  return (
    <ProgressProvider>
      <GameShell>
        <div className="lq-ground">{children}</div>
      </GameShell>
    </ProgressProvider>
  );
}
