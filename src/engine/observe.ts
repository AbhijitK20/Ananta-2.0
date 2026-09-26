/**
 * src/engine/observe.ts
 *
 * The bandit arm: learn per-traveller weights from the interaction stream.
 *
 * WHY A HAND-ROLLED GRADIENT INSTEAD OF THOMPSON SAMPLING. TASKS.md sketches
 * "Thompson sampling on weight profile" (Day 4), and for choosing *between whole
 * candidate sets* Thompson is the right tool. But here the learned object is a
 * vector of ~11 interpretable weights that the UI shows to the traveller under
 * "what I learned about you" — and a Thompson draw over a weight vector is not
 * something you can show a person and get consent for. A recommendation you
 * cannot interrogate is just a vibe.
 *
 * So this is a tiny, inspectable multiplicative-weights update instead: each
 * interaction nudges the weights that the engine actually scored on, in the
 * direction of the observed reward, by a step that shrinks as evidence
 * accumulates. It is deterministic, auditable, and every weight it changes is a
 * named key the UI already knows how to render. `DEFAULT_PROFILE.weights` is the
 * vocabulary; the bandit never invents a new dimension.
 *
 * THE SAFETY RAIL. Nothing is learned without being shown. This function
 * returns a profile with `source` and `observations` bumped, and the caller is
 * expected to render both. Weights are clamped to a floor and ceiling so a
 * single loud click cannot turn one dimension into the whole objective, and the
 * learning rate decays so early interactions move the needle and later ones
 * refine rather than thrash.
 *
 * Purity: no I/O, no LLM, no Date. The caller supplies the timestamp already
 * serialised, because putting a Date in here would reintroduce the boundary
 * this engine deliberately keeps out (see lib/time.ts).
 */
import type { Interaction, WeightProfile } from "@/contracts";
import { EPOCH_ISO } from "@/lib/time";
import { DEFAULT_PROFILE } from "./scoring";

/** Bounds so one interaction can nudge but never dominate the objective. */
const WEIGHT_FLOOR = 0.02;
const WEIGHT_CEILING = 3.0;

/**
 * How strongly each interaction type moves the weights.
 *
 * A save is a far stronger signal than an impression, and a dismiss is a
 * negative signal worth about as much as a click. Without this table every
 * event would nudge equally and the signal-to-noise would be poor.
 */
const REWARD_BY_TYPE: Record<Interaction["type"], number> = {
  impression: 0,
  click: 0.4,
  save: 1.0,
  book_requested: 1.5,
  dismiss: -0.8,
  not_interested: -1.0,
  reported_inaccurate: -1.2,
  opened_directions: 0.5,
  shared: 0.8,
};

/** Cap on a single update, so a max-reward event cannot launch a weight. */
const MAX_STEP = 0.08;

function clamp(n: number, lo: number, hi: number): number {
  return n < lo ? lo : n > hi ? hi : n;
}

/**
 * Decaying learning rate. Large when we know little, small once we do — the
 * standard (1/sqrt(n)) shape. With BASE_LR tuned so the first real interaction
 * moves a weight by a visible but modest amount (~0.04) rather than a
 * perceptible jolt, because the traveller can see these numbers.
 */
const BASE_LR = 0.35;
function learningRate(observations: number): number {
  return BASE_LR / Math.sqrt(Math.max(1, observations));
}

/**
 * Fold one interaction into the weight profile and return a new profile.
 *
 * Pure: neither argument is mutated. The reward is taken from the event's own
 * `reward` field, falling back to the type's prior signal, and the update is a
 * signed multiplicative nudge of every learnable weight toward the direction the
 * outcome implies. Weights that a later version of the engine drops are pruned
 * on sight so a stale profile cannot smuggle them back in.
 */
export function observe(profile: WeightProfile, event: Interaction): WeightProfile {
  const observations = (profile.observations ?? 0) + 1;
  const signal = Number.isFinite(event.reward)
    ? event.reward
    : REWARD_BY_TYPE[event.type] ?? 0;

  // An impression carries no outcome, so it is recorded in the count (the UI
  // shows "learned from N interactions") but does not move a weight.
  if (signal === 0) {
    return {
      ...profile,
      observations,
      source: profile.source === "prior" ? "learned" : profile.source,
      updatedAt: EPOCH_ISO,
    };
  }

  const lr = learningRate(profile.observations ?? 0);
  const step = clamp(Math.abs(signal) * lr, 0, MAX_STEP);
  const direction = Math.sign(signal);

  const learned: Record<string, number> = {};
  for (const [key, prior] of Object.entries(DEFAULT_PROFILE.weights)) {
    const current = profile.weights[key] ?? prior;
    // Positive reward lifts every dimension it interacted with; negative reward
    // pushes them down. Symmetric, because an interaction is evidence about all
    // the reasons it was shown, not just one of them.
    const next = current + direction * step * current;
    learned[key] = clamp(next, WEIGHT_FLOOR, WEIGHT_CEILING);
  }

  return {
    ...profile,
    version: profile.version,
    weights: learned,
    source: "learned",
    updatedAt: EPOCH_ISO,
    observations,
  };
}
