/**
 * The two chip sets. Both are the same thing — a named editor edit a traveller
 * can fire in one tap — so they share one type and one runner, and both resolve
 * to a `ContextChange` rather than touching the plan. Nothing here mutates a
 * `Plan`; the engine re-derives it.
 *
 * The six reality triggers are the ones `docs/FEATURES.md` §3 pins down. The
 * eight suggestions are what a traveller reaches for when the plan is merely not
 * what they hoped for, so they are gentler edits than a trigger: a smaller cut,
 * and mostly preferences.
 *
 * A chip that cannot apply returns `null` rather than a no-op change. "Make it
 * cheaper" needs a plan to measure against, and with no plan there is nothing to
 * make cheaper — so the UI hides the chip instead of paying for an empty replan.
 */
import type { Plan } from "../../contracts";
import { type EditorChange, type EditorOp, type EditorState, applyOps } from "./context";
import { money } from "./format";

export type ActionInput = {
  state: EditorState;
  plan: Plan | null;
  /** Resolves an id to a display name, so a narrative never leaks an id. */
  nameOf: (id: string) => string;
};

export type DiscoveryAction = {
  id: string;
  label: string;
  /** One line on what the chip does, for the panel's secondary text. */
  hint: string;
  /** Ops to apply, or `null` when the chip does not apply right now. */
  ops: (input: ActionInput) => EditorOp[] | null;
};

const LOST_MIN = 90;
const CHEAPER_SHARE = 0.7;
const LESS_TIME_MIN = 60;
const BUDGET_MINOR = 60000;

/** Round to the nearest rupee, so the number in the narrative is one a human said. */
const toRupee = (minor: number): number => Math.max(0, Math.round(minor / 100)) * 100;

export const REALITY_TRIGGERS: readonly DiscoveryAction[] = [
  {
    id: "rain",
    label: "It started raining",
    hint: "Outdoor stops lose, covered and indoor ones win.",
    ops: () => [{ kind: "set_weather", condition: "heavy_rain", note: "Rain started." }],
  },
  {
    id: "time_lost",
    label: `We lost ${LOST_MIN} minutes`,
    hint: "Fewer stops, closer together.",
    ops: ({ state }) => [
      {
        kind: "set_time",
        availableMin: state.ctx.availableMin - LOST_MIN,
        note: `${LOST_MIN} minutes went somewhere else.`,
      },
    ],
  },
  {
    id: "sold_out",
    label: "This one is sold out",
    hint: "Drops the first stop and puts the next best thing in its place.",
    ops: ({ plan, nameOf }) => {
      const first = plan?.stops[0];
      if (!first) return null;
      return [
        {
          kind: "exclude",
          experienceIds: [first.experienceId],
          note: `${nameOf(first.experienceId)} is sold out.`,
        },
      ];
    },
  },
  {
    id: "budget",
    label: "Budget is now ₹600",
    hint: "Prunes to what fits, and says what it cut.",
    ops: () => [{ kind: "set_budget", budgetMinor: BUDGET_MINOR, note: "Budget is ₹600 now." }],
  },
  {
    id: "restroom",
    label: "Need a bathroom",
    hint: "Keeps only places with a restroom on site.",
    ops: () => [
      // ADD, not replace. FEATURES §3 writes this as `accessNeeds +=`. Replacing
      // would drop the step-free need the traveller already stated, so the plan
      // would quietly stop being step-free the moment they asked for a toilet.
      { kind: "add_access_needs", needs: ["restroom"], note: "Needs a restroom on site." },
    ],
  },
  {
    id: "exhausted",
    label: "We're exhausted",
    hint: "Shorter walks, fewer transfers, a slower day.",
    ops: () => [
      { kind: "set_walking", walking: "minimal", note: "Everyone is tired, so this is the slow version." },
    ],
  },
];

export const SUGGESTIONS: readonly DiscoveryAction[] = [
  {
    id: "cheaper",
    label: "Make it cheaper",
    hint: "Cuts the spend by about a third.",
    ops: ({ plan }) => {
      if (!plan || plan.totalCost.minor <= 0) return null;
      const target = toRupee(plan.totalCost.minor * CHEAPER_SHARE);
      return [
        { kind: "set_budget", budgetMinor: target, note: `Keeping it under ${money(target)}.` },
      ];
    },
  },
  {
    id: "less_walking",
    label: "Less walking",
    hint: "Prefers short walks and fewer legs on foot.",
    ops: () => [{ kind: "set_walking", walking: "low", note: "Keeping the walking short." }],
  },
  {
    id: "more_local",
    label: "More local",
    hint: "Neighbourhood places over the tourist circuit.",
    ops: () => [
      { kind: "add_interests", interests: ["local", "neighbourhood"], note: "More neighbourhood places." },
    ],
  },
  {
    id: "indoor_only",
    label: "Indoor only",
    hint: "Nothing that needs you to be outside.",
    ops: () => [{ kind: "set_indoor", indoorOnly: true, note: "Indoors from here." }],
  },
  {
    id: "less_time",
    label: "I have less time",
    hint: `Takes ${LESS_TIME_MIN} minutes off the window.`,
    ops: ({ state }) => [
      {
        kind: "set_time",
        availableMin: state.ctx.availableMin - LESS_TIME_MIN,
        note: `${LESS_TIME_MIN} minutes less.`,
      },
    ],
  },
  {
    id: "family_friendly",
    label: "Family friendly",
    hint: "Things that work with a child in the group.",
    ops: () => [
      { kind: "add_interests", interests: ["family", "kid_friendly"], note: "Keeping it family friendly." },
    ],
  },
  {
    id: "more_food",
    label: "More food",
    hint: "Street food, and somewhere to sit and eat it.",
    ops: () => [
      { kind: "add_interests", interests: ["street_food", "food"], note: "More food stops." },
    ],
  },
  {
    id: "more_culture",
    label: "More culture",
    hint: "Heritage, galleries, workshops, live music.",
    ops: () => [
      { kind: "add_interests", interests: ["heritage", "gallery", "music_live"], note: "More culture stops." },
    ],
  },
];

export const ALL_ACTIONS: readonly DiscoveryAction[] = [...REALITY_TRIGGERS, ...SUGGESTIONS];

export const ACTION_BY_ID: ReadonlyMap<string, DiscoveryAction> = new Map(
  ALL_ACTIONS.map((action) => [action.id, action]),
);

/** Applies a chip. `null` means the chip did not apply, so do not replan. */
export function runAction(action: DiscoveryAction, input: ActionInput): EditorChange | null {
  const ops = action.ops(input);
  if (!ops || ops.length === 0) return null;
  const result = applyOps(input.state, ops);
  return result.change ? result : null;
}
