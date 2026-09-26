/**
 * The four questions, as data.
 *
 * These are the sentences a traveller actually types. Each one is a
 * `ScenarioPreset` and nothing else — no prose, no branching, no "if you ask
 * this then probably also ask that". The machinery is in `simulate()`; this file
 * only says which `ScenarioEdit`s each question is worth.
 *
 * They are static, not functions of the live state, because `simulate` already
 * has the state and resolves `budget_delta` against it. "₹500 more" means ₹500
 * more than whatever this trip has, without the preset knowing what that is.
 *
 * `label` is the chip, `question` is the traveller's own words. Keeping the two
 * apart matters: the chip is eight characters and the question is the thing they
 * were actually thinking, and the answer is only credible when it is visibly
 * answering what they asked rather than a paraphrase of it.
 */
import { money } from "../discovery/format";
import type { ScenarioEdit } from "./scenario";

export type ScenarioPreset = {
  id: string;
  label: string;
  question: string;
  edits: readonly ScenarioEdit[];
};

/** ₹500. Paise, because the contract says money is minor units. */
const FIVE_HUNDRED_RUPEES = 50000;
const ONE_KILOMETRE = 1000;
const TWO_HOURS = 120;

export const SCENARIO_PRESETS: readonly ScenarioPreset[] = [
  {
    id: "more_money",
    label: `+${money(FIVE_HUNDRED_RUPEES)}`,
    question: "What if I had ₹500 more?",
    edits: [{ kind: "budget_delta", minor: FIVE_HUNDRED_RUPEES }],
  },
  {
    id: "less_time",
    label: `Only ${TWO_HOURS / 60}h`,
    question: "What if I only had 2 hours?",
    edits: [{ kind: "time", availableMin: TWO_HOURS }],
  },
  {
    id: "rain",
    label: "It rains",
    question: "What if it rains?",
    edits: [{ kind: "weather", condition: "heavy_rain" }],
  },
  {
    id: "less_walking",
    label: `Max ${ONE_KILOMETRE / 1000} km walk`,
    question: "What if I don't want to walk more than 1 km?",
    edits: [{ kind: "walk_cap_m", metres: ONE_KILOMETRE }],
  },
];

export const SCENARIO_PRESET_BY_ID: ReadonlyMap<string, ScenarioPreset> = new Map(
  SCENARIO_PRESETS.map((preset) => [preset.id, preset]),
);
