/**
 * Group preference intelligence: several people, one plan.
 *
 * A `DiscoveryContext` describes one party, so by the time the planner sees it
 * every person in it has already been averaged into a single `partySize`, a
 * single `budget` and a single `walking` value. This file is the step in front
 * of that. It takes the people and what each of them stated, decides what the
 * group as a whole can commit to, and hands the result to the existing
 * discovery pipeline as an ordinary `ContextSeed`.
 *
 * Four rules, and why each one is the rule:
 *
 *  1. **No second planner.** The output of the aggregation is a seed, and
 *     `createSession` + `discover` do the rest, untouched. A group plan is
 *     therefore produced by the same retrieve -> gate -> score -> pack -> admit
 *     loop as a solo plan, and it inherits every guarantee that loop makes:
 *     `Plan.parse`, `validate`, the travel-load veto, no context drift. Change
 *     the engine and group plans change with it.
 *
 *  2. **Hard beats strong beats soft, and a ceiling only ever tightens.** A
 *     wheelchair is not something a group votes on, and neither is somebody's
 *     diet, so access needs, diets, and the money and walking limits stated as
 *     hard, go in as they are. The group's walking limit is the *strictest* one
 *     anybody stated, its ceiling is the *lowest*, and its access and diet sets
 *     are the unions, because every weaker limit is already satisfied by the
 *     stricter one and every member's diet has to be fed. That is why these axes
 *     need no arbitration at all — and it is why "average the group" is never the
 *     right answer for them. Interests are the opposite case: they are wants, not
 *     limits, so they are ranked by how many people asked for them and the tail is
 *     reported as dropped rather than quietly ignored.
 *
 *  3. **The tension is reported, not resolved.** `docs/MASTERPLAN.md` §10 asked
 *     for "shared constraints + per-person personas + a visible tension axis", and
 *     `content/evaluation/scenarios.jsonl:12` asserts the tension is surfaced.
 *     Every conflict below is derived from something that really happened: an
 *     engine rejection, a load-model cut, a number in the plan, a distance from
 *     the engine's own router. This file never invents a disagreement between two
 *     people who did not have one, and it reports no conflict for an axis where
 *     the group had nothing to lose. Where the engine does not report something
 *     this file needs in order to be right — whether a stop answered an interest,
 *     say — it says nothing at all about it rather than guessing.
 *
 *  4. **A group that cannot be served gets an ask, not an itinerary.** The ask is
 *     read off the shortfall the engine itself reported — the rupees short, the
 *     minutes short — and it carries the editor op that applies it, so what the
 *     group is told to change is exactly what the next re-solve changes. Nothing
 *     is relaxed on the traveller's behalf.
 *
 * Not here, on purpose. Who is in the group is a `GroupMember[]` the caller
 * supplies, and no `Plan` is ever assembled here. The contract is frozen and has
 * no per-person field, so the personas live in this feature and land in the
 * context as the fields the planner already reads.
 */
import {
  type AccessNeed,
  type Accessibility,
  type ContextChange,
  type DiscoveryContext,
  type Experience,
  type GeoPoint,
  type Plan,
  type Rejection,
  type ScoreBreakdown,
  type WeatherNow,
  type WeightProfile,
} from "../../contracts";
import {
  DEFAULT_PREFS,
  INDOOR_TOKEN,
  applyOps,
  createContext,
  type ContextSeed,
  type DiscoveryPrefs,
  type EditorOp,
  type EditorState,
  type WalkingTolerance,
} from "../discovery/context";
import type { EnginePort } from "../discovery/engine";
import type { LoadExclusion, LoadReport } from "../discovery/fatigue";
import { hm, money, plural } from "../discovery/format";
import {
  createSession,
  discover,
  replan,
  type DiscoverOutcome,
  type DiscoverySession,
  type ReplanOutcome,
} from "../discovery/replanner";

// ---------------------------------------------------------------------------
// What one person said
// ---------------------------------------------------------------------------

/**
 * How much a stated preference counts. The three tiers are not a vibe scale:
 *  - `hard` is a constraint. It filters candidates, so a plan that breaks it is
 *    not a plan for this person and is refused rather than shown.
 *  - `strong` is a want the group commits to unless a `hard` constraint forbids
 *    it. It outranks any `soft` want.
 *  - `soft` is a nice-to-have, and only ever fills a slot nobody else wanted.
 */
export type Strength = "hard" | "strong" | "soft";

/** A stated walking limit, in the discovery feature's own vocabulary. */
export type GroupWalking = WalkingTolerance;

/**
 * One person in the group.
 *
 * Every field is a statement somebody actually made. There is no inferred
 * preference here and no default tier: a member who says nothing about walking
 * has not said "any walking is fine", they have said nothing, and the
 * aggregation is required to say which of the two it was.
 */
export type GroupMember = {
  /** Stable. Also the sort key, so a group always aggregates in one order. */
  id: string;
  /** "Parent", "Friend", "Child". Every sentence this file produces names people. */
  label: string;
  /**
   * Composition, not preference. It is what turns a headcount into a
   * `partyType`, a toddler into a lower walking budget and an older adult into
   * step-free access, through the discovery feature's own `derivePartyType`.
   */
  role?: "adult" | "child" | "elder";
  /** Required for `role: "child"`. Drives `childAges` and the load factor. */
  age?: number;
  hard?: {
    /** Per-person ceiling, integer minor units. */
    budgetMinor?: number;
    /** Body facts. A group cannot outvote these, so they are never averaged. */
    accessNeeds?: AccessNeed[];
    /**
     * Open vocabulary, the contract's own. Also a fact about a body rather than a
     * taste, so it unions: a vegetarian and a jain in one group is a place that
     * feeds both, not a place that feeds the average of the two.
     */
    diets?: string[];
    walking?: GroupWalking;
    indoorOnly?: boolean;
  };
  strong?: {
    interests?: string[];
    /** A ceiling too, but honoured only when nobody stated a hard one. */
    budgetMinor?: number;
    walking?: GroupWalking;
    indoorOnly?: boolean;
  };
  soft?: { interests?: string[] };
};

/** The facts of the one request, so they are stated once rather than by N people. */
export type GroupRequest = {
  id: string;
  origin: { label: string; point?: GeoPoint | null };
  availableMin: number;
  nowMin: number;
  weather?: Partial<WeatherNow>;
  /** A ceiling the group shares before anybody states their own. Null = none. */
  budgetMinor?: number | null;
};

export type GroupAxis = "party" | "walking" | "indoor" | "budget" | "access" | "diet" | "interests";

/** One axis, resolved, with the words that decided it. The audit trail. */
export type GroupDecision = {
  axis: GroupAxis;
  /** The value the context now holds, in the discovery feature's own words. */
  value: string;
  /** `shared` when nobody stated anything and the request's own fact stands. */
  strength: Strength | "shared";
  /** Labels of the members whose statement decided it. Sorted. */
  by: string[];
  reason: string;
};

/** An interest, and who asked for it. */
export type GroupInterest = { name: string; labels: string[] };

export type GroupAggregate = {
  seed: ContextSeed;
  /** Resolved exactly as `createContext` resolves `seed.prefs`, so the two agree. */
  prefs: DiscoveryPrefs;
  partySize: number;
  childAges: number[];
  elders: number;
  /** Fixed axis order: party, walking, indoor, budget, access, diet, interests. */
  decisions: GroupDecision[];
  /** Union of everybody's hard access needs, and whose each one is. */
  access: { needs: AccessNeed[]; by: Map<AccessNeed, string[]> };
  /** Union of everybody's hard diets, and whose each one is. */
  diets: { names: string[]; by: Map<string, string[]> };
  interests: { kept: GroupInterest[]; dropped: GroupInterest[] };
  /** Sorted by id. The personas themselves, never merged away. */
  members: readonly GroupMember[];
};

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

/** Hard before strong. Nothing is ever resolved out of a soft statement alone. */
const TIERS = ["hard", "strong"] as const;

/** Strictness order. Lower is stricter, so the group takes the minimum. */
const WALK_RANK: Record<GroupWalking, number> = { minimal: 0, low: 1, any: 2 };

/** An older adult is a fact about stairs and toilets. Mirrors `accessDefaults`. */
const ELDER_NEEDS: readonly AccessNeed[] = ["lowStairs", "restroom"];

/** The `Accessibility` field each access need is actually about. */
const NEED_FIELD: Record<AccessNeed, keyof Accessibility> = {
  wheelchair: "stepFree",
  stroller: "strollerOk",
  lowStairs: "lowStairs",
  hearingLoop: "hearingLoop",
  restroom: "restroomOnSite",
};

/**
 * How many distinct interests the group's ranking can still separate.
 *
 * ponytail: a cap, not a model. The engine's interest component is a *count* of
 * matches, so an unbounded union of six people's wishes matches nearly
 * everything and stops discriminating. Three is what still separates places.
 * Upgrade path if it ever bites: rank interests by support and carry the weight
 * through `WeightProfile` instead of capping.
 */
export const INTEREST_SLOTS = 3;

const fail = (message: string): never => {
  throw new Error(`group: ${message}`);
};

const labelsOf = (members: readonly GroupMember[]): string[] =>
  [...new Set(members.map((member) => member.label))].sort();

/** "A", "A and B", "A, B and C". "nobody" for an empty list, never a blank. */
function joinAnd(names: readonly string[]): string {
  if (names.length === 0) return "nobody";
  if (names.length === 1) return names[0] ?? "nobody";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The engine matches interests case- and separator-insensitively, so "Street
 * Food" and "street_food" are one interest. Same rule here, or the dedupe and the
 * match disagree and a slot is spent on a duplicate.
 */
const norm = (value: string): string => value.trim().toLowerCase().replace(/[\s-]+/g, "_");

/**
 * Trust boundary. A group arrives from a form or a chat turn, so the statements
 * that drive a hard filter are checked before they can reach the planner. Throws
 * with the member's own name in the message, because "invalid group" tells the
 * caller nothing about which person to go and ask.
 */
function validated(members: readonly GroupMember[]): readonly GroupMember[] {
  if (members.length === 0) fail("a group needs at least one member");
  const seen = new Set<string>();
  for (const member of members) {
    if (member.id.trim() === "") fail("every member needs an id");
    if (seen.has(member.id)) fail(`two members are both "${member.id}"`);
    seen.add(member.id);
    if (member.label.trim() === "") fail(`${member.id} needs a label, because every sentence names people`);
    if (member.role === "child") {
      const age = member.age;
      if (age === undefined || !Number.isInteger(age) || age < 0 || age > 17) {
        fail(`${member.id} is a child, so they need an age between 0 and 17, not ${String(age)}`);
      }
    }
    for (const tier of TIERS) {
      const budget = member[tier]?.budgetMinor;
      if (budget !== undefined && (!Number.isInteger(budget) || budget < 0)) {
        fail(`${member.id} states a ${tier} budget of ${budget}; it must be whole minor units, zero or more`);
      }
    }
  }
  return members;
}

function statedBy<T>(
  members: readonly GroupMember[],
  read: (member: GroupMember) => T | undefined,
): readonly { member: GroupMember; value: T }[] {
  return members
    .map((member) => ({ member, value: read(member) }))
    .filter((row): row is { member: GroupMember; value: T } => row.value !== undefined);
}

/** The strictest limit anybody stated, and who asked for exactly that limit. */
function walkingOf(members: readonly GroupMember[]): Stated<GroupWalking> {
  for (const tier of TIERS) {
    const rows = statedBy(members, (member) => member[tier]?.walking);
    if (rows.length === 0) continue;
    const value = rows
      .map((row) => row.value)
      .reduce((a, b) => (WALK_RANK[a] <= WALK_RANK[b] ? a : b));
    return {
      value,
      strength: tier,
      labels: labelsOf(rows.filter((row) => row.value === value).map((row) => row.member)),
    };
  }
  return { value: "any", strength: "soft", labels: [] };
}

/** Indoor-only is a claim about a body on a bad day, so only `true` is a claim. */
function indoorOf(members: readonly GroupMember[]): Stated<boolean> {
  for (const tier of TIERS) {
    const rows = members.filter((member) => member[tier]?.indoorOnly === true);
    if (rows.length > 0) return { value: true, strength: tier, labels: labelsOf(rows) };
  }
  return { value: false, strength: "soft", labels: [] };
}

type Stated<T> = { value: T; strength: Strength; labels: string[] };
type Ceiling = { perPerson: number | null; total: number | null; strength: Strength | "shared"; labels: string[] };

/** The lowest ceiling anybody stated, and never above the group's own. */
function ceilingOf(members: readonly GroupMember[], size: number, shared: number | null): Ceiling {
  for (const tier of TIERS) {
    const rows = statedBy(members, (member) => member[tier]?.budgetMinor);
    if (rows.length === 0) continue;
    const perPerson = Math.min(...rows.map((row) => row.value));
    return {
      perPerson,
      total: shared === null ? perPerson * size : Math.min(perPerson * size, shared),
      strength: tier,
      labels: labelsOf(rows.filter((row) => row.value === perPerson).map((row) => row.member)),
    };
  }
  return { perPerson: null, total: shared, strength: "shared", labels: [] };
}

function push(map: Map<string, string[]>, name: string, label: string): void {
  const labels = map.get(name);
  if (labels) labels.push(label);
  else map.set(name, [label]);
}

/**
 * Strong wants take a slot each in order of how many people asked, and the soft
 * ones fill whatever is left. An interest is never a hard constraint in this
 * layer: a "hard interest" with no test for satisfaction would be a promise the
 * engine cannot keep, and the contract's real hard-intent field is
 * `requests[].mustsee`, which the chat path already owns.
 *
 * A soft ask for something somebody else asked for strongly still counts towards
 * the support, because "two of you want this" is true whether the second person
 * was certain or hopeful, and the count is the number the sentence shows.
 */
function interestsOf(members: readonly GroupMember[]): { kept: GroupInterest[]; dropped: GroupInterest[] } {
  const strong = new Map<string, string[]>();
  const soft = new Map<string, string[]>();
  for (const member of members) {
    for (const raw of member.strong?.interests ?? []) push(strong, norm(raw), member.label);
    for (const raw of member.soft?.interests ?? []) push(soft, norm(raw), member.label);
  }
  for (const [name, labels] of soft) {
    const strongLabels = strong.get(name);
    if (strongLabels) for (const label of labels) if (!strongLabels.includes(label)) strongLabels.push(label);
  }
  const bySupport = (a: GroupInterest, b: GroupInterest): number =>
    b.labels.length - a.labels.length || a.name.localeCompare(b.name);
  const strongList = [...strong].map(([name, labels]) => ({ name, labels })).sort(bySupport);
  const softList = [...soft]
    .filter(([name]) => !strong.has(name))
    .map(([name, labels]) => ({ name, labels }))
    .sort(bySupport);
  const kept = strongList.slice(0, INTEREST_SLOTS);
  const rest = softList.slice(0, Math.max(0, INTEREST_SLOTS - kept.length));
  const named = new Set([...kept, ...rest].map((row) => row.name));
  return { kept: [...kept, ...rest], dropped: [...strongList, ...softList].filter((row) => !named.has(row.name)) };
}

/**
 * Access needs are a union, never a vote: they are stated as `hard` by
 * construction and a group does not get to outvote a wheelchair. The elder
 * defaults are added here rather than left to `createContext`, which only applies
 * them when the seed carries no access needs at all — and a group always has
 * somebody else's needs to carry.
 */
function accessOf(members: readonly GroupMember[]): { needs: AccessNeed[]; by: Map<AccessNeed, string[]> } {
  const by = new Map<AccessNeed, string[]>();
  for (const member of members) {
    for (const need of member.hard?.accessNeeds ?? []) push(by, need, member.label);
    if (member.role === "elder") for (const need of ELDER_NEEDS) push(by, need, member.label);
  }
  return { needs: [...by.keys()].sort(), by };
}

/**
 * Diets union for the same reason access needs do, and unlike walking there is no
 * ordering to reconcile: a place that feeds the vegetarian and the jain feeds both,
 * and a place that feeds neither is out. The names stay in the contract's open
 * vocabulary and go out normalised, so "Jain" and "jain " are one requirement.
 *
 * There is no verification pass for this axis, unlike access. What `Experience`
 * means by `diets` — a subset to satisfy, a menu to intersect — is the engine's
 * call and is not in the contract, so guessing at it here would be a second opinion
 * about someone else's semantics. The union is what the engine is obliged to read.
 */
function dietsOf(members: readonly GroupMember[]): { names: string[]; by: Map<string, string[]> } {
  const by = new Map<string, string[]>();
  for (const member of members) {
    for (const raw of member.hard?.diets ?? []) push(by, norm(raw), member.label);
  }
  return { names: [...by.keys()].sort(), by };
}

const withCount = (interest: GroupInterest): string =>
  interest.labels.length > 1 ? `${interest.name} (${interest.labels.length} of you)` : interest.name;

/** "a place has to feed everybody" / "a place has to feed both of them". */
const dietSubject = (count: number): string =>
  count === 1 ? "everybody" : count === 2 ? "both of them" : `all ${count}`;

/**
 * N people and their statements in, one `ContextSeed` out. Pure, deterministic
 * (members are sorted by id before anything is read) and it decides nothing about
 * the catalogue: the planner does that next, and this file only reports what it
 * was handed.
 */
export function aggregateGroup(request: GroupRequest, members: readonly GroupMember[]): GroupAggregate {
  const ordered = [...validated(members)].sort((a, b) => a.id.localeCompare(b.id));
  const size = ordered.length;
  const childAges = ordered
    .flatMap((member) => (member.role === "child" && typeof member.age === "number" ? [member.age] : []))
    .sort((a, b) => a - b);
  const elders = ordered.filter((member) => member.role === "elder").length;
  const walking = walkingOf(ordered);
  const indoor = indoorOf(ordered);
  const ceiling = ceilingOf(ordered, size, request.budgetMinor ?? null);
  const access = accessOf(ordered);
  const diets = dietsOf(ordered);
  const interests = interestsOf(ordered);
  const labels = labelsOf(ordered);

  const seed: ContextSeed = {
    id: request.id,
    origin: request.origin,
    availableMin: request.availableMin,
    nowMin: request.nowMin,
    budgetMinor: ceiling.total,
    budgetPerPersonMinor: ceiling.perPerson,
    partySize: size,
    childAges,
    elderly: elders,
    accessNeeds: access.needs,
    diets: diets.names,
    interests: interests.kept.map((row) => row.name),
    weather: request.weather,
    prefs: { walking: walking.value, indoorOnly: indoor.value },
  };

  const composition = [
    plural(size, "person", "people"),
    childAges.length > 0 ? `${plural(childAges.length, "child", "children")} aged ${childAges.join(", ")}` : null,
    elders > 0 ? plural(elders, "older adult", "older adults") : null,
  ].filter((part): part is string => part !== null);

  const decisions: GroupDecision[] = [
    {
      axis: "party",
      value: composition.join(", "),
      strength: "shared",
      by: labels,
      reason: `${joinAnd(labels)}: ${composition.join(", ")}.`,
    },
    {
      axis: "walking",
      value: walking.value,
      strength: walking.strength,
      by: walking.labels,
      reason:
        walking.value === "minimal"
          ? `${joinAnd(walking.labels)} said no walking they cannot avoid, so the group stays put and the car is the default.`
          : walking.value === "low"
            ? `${joinAnd(walking.labels)} asked for short walks, so the day is planned around staying near where you are.`
            : "Nobody in the group said anything about walking, so nothing is capped.",
    },
    {
      axis: "indoor",
      value: indoor.value ? INDOOR_TOKEN : "any",
      strength: indoor.strength,
      by: indoor.labels,
      reason: indoor.value
        ? `${joinAnd(indoor.labels)} needs it indoors, so nothing outdoors is on the list.`
        : "Nobody asked to stay indoors.",
    },
    {
      axis: "budget",
      value: ceiling.perPerson === null ? "none" : String(ceiling.perPerson),
      strength: ceiling.strength,
      by: ceiling.labels,
      reason:
        ceiling.perPerson === null
          ? ceiling.total === null
            ? "Nobody set a ceiling, so price is not a constraint on this plan."
            : `The group is spending against its own ceiling of ${money(ceiling.total)}.`
          : ceiling.total !== null && ceiling.total < ceiling.perPerson * size
            ? `${joinAnd(ceiling.labels)} set the ceiling at ${money(ceiling.perPerson)} each, and the group's own ceiling of ${money(ceiling.total)} is what binds for ${plural(size, "person", "people")}.`
            : `${joinAnd(ceiling.labels)} set the ceiling at ${money(ceiling.perPerson)} each, ${money(ceiling.total)} for ${plural(size, "person", "people")}.`,
    },
    {
      axis: "access",
      value: access.needs.join("+") || "none",
      strength: "hard",
      by: labels.filter((label) =>
        access.needs.some((need) => (access.by.get(need) ?? []).includes(label)),
      ),
      reason:
        access.needs.length === 0
          ? "Nobody stated an access need, so accessibility is not filtering the list."
          : `${access.needs
              .map((need) => `${need} (${joinAnd(access.by.get(need) ?? [])})`)
              .join(", ")}: only places that can take ${access.needs.length > 1 ? "them" : "it"} are on the list.`,
    },
    {
      axis: "diet",
      value: diets.names.join("+") || "none",
      strength: "hard",
      by: labels.filter((label) => diets.names.some((name) => (diets.by.get(name) ?? []).includes(label))),
      reason:
        diets.names.length === 0
          ? "Nobody stated a diet, so food is not filtering the list."
          : `${diets.names.map((name) => `${name} (${joinAnd(diets.by.get(name) ?? [])})`).join(", ")}: a place has to feed ${dietSubject(diets.names.length)}.`,
    },
    {
      axis: "interests",
      value: interests.kept.map((row) => row.name).join(","),
      strength: "strong",
      by: [...new Set(interests.kept.flatMap((row) => row.labels))].sort(),
      reason:
        interests.kept.length === 0
          ? "Nobody named an interest, so the plan is ranked on proximity and rating alone."
          : `Looking for ${interests.kept.map(withCount).join(", ")}.` +
            (interests.dropped.length > 0
              ? ` ${plural(interests.dropped.length, "interest", "interests")} (${interests.dropped
                  .map((row) => row.name)
                  .join(", ")}) fitted no slot and ${
                  interests.dropped.length === 1 ? "is" : "are"
                } not being planned for.`
              : ""),
    },
  ];

  return {
    seed,
    prefs: { ...DEFAULT_PREFS, walking: walking.value, indoorOnly: indoor.value },
    partySize: size,
    childAges,
    elders,
    decisions,
    access,
    diets,
    interests,
    members: ordered,
  };
}

// ---------------------------------------------------------------------------
// Conflicts and asks
// ---------------------------------------------------------------------------

export type GroupConflict = {
  axis: GroupAxis;
  /**
   * `blocking`: the group as a whole has no plan, and `planForGroup` refuses.
   * `strained`: it has one, and this is what that cost somebody.
   */
  severity: "blocking" | "strained";
  /** Whose statement set the ceiling. */
  heldBy: string[];
  /** Who gave something up, or who cannot be served. */
  costing: string[];
  reason: string;
  /** Real numbers, and the engine's own sentences where it has one. */
  evidence: string[];
};

/**
 * One change the group could make, with the editor op that makes it. The op is
 * the point: an ask cannot drift from the re-solve, because the re-solve is
 * handed this exact op back by `planForGroup({ adjust })`.
 */
export type Ask = {
  sentence: string;
  op: EditorOp;
  /** Whose statement would have to give. */
  by: string[];
  evidence: string[];
};

/**
 * One thing that stopped the plan, in a shape both the gate and the load model fit
 * into. The gate speaks in `Rejection` and the travel-load veto in `LoadViolation`,
 * and a plan can be blocked by either, so asking has to speak both.
 */
type Blocker = { code: string; at: string | null; message: string; shortfall: number | null; unit: string | null };

const blocking = (
  axis: GroupAxis,
  heldBy: string[],
  costing: string[],
  reason: string,
  evidence: string[],
): GroupConflict => ({ axis, severity: "blocking", heldBy, costing, reason, evidence });

const byAxis = (aggregate: GroupAggregate, axis: GroupAxis): string[] =>
  decisionFor(aggregate, axis).by;

function decisionFor(aggregate: GroupAggregate, axis: GroupAxis): GroupDecision {
  const found = aggregate.decisions.find((decision) => decision.axis === axis);
  if (!found) throw new Error(`group: no decision for ${axis}`);
  return found;
}

/**
 * Which context change could relieve a blocking code. Every number in an ask is
 * read off the shortfall or off the router, never off a guess at what the group
 * would probably accept. A code with no entry here is still reported as evidence;
 * it just does not become a question, because we cannot say what the question is.
 */
type Relief = { kind: "budget" } | { kind: "window" } | { kind: "walking" } | { kind: "access"; need: AccessNeed };

const RELIEF: Readonly<Partial<Record<string, Relief>>> = {
  over_budget: { kind: "budget" },
  over_budget_per_person: { kind: "budget" },
  duration_exceeds_budget: { kind: "window" },
  travel_time_exceeds_budget: { kind: "window" },
  window_exceeded: { kind: "window" },
  too_far: { kind: "walking" },
  leg_too_long_to_walk: { kind: "walking" },
  walking_budget_exceeded: { kind: "walking" },
  too_many_back_to_back: { kind: "walking" },
  block_too_long_without_rest: { kind: "walking" },
  not_step_free: { kind: "access", need: "wheelchair" },
  not_stroller_ok: { kind: "access", need: "stroller" },
  no_low_stairs: { kind: "access", need: "lowStairs" },
  no_hearing_loop: { kind: "access", need: "hearingLoop" },
  no_restroom: { kind: "access", need: "restroom" },
};

const min = (values: readonly number[]): number | null =>
  values.length === 0 ? null : Math.min(...values);

/** The names behind a set of ids, deduplicated and sorted. */
function namesOf(ids: readonly (string | null)[], byId: ReadonlyMap<string, Experience>): string[] {
  const names = ids.map((id) => (id === null ? null : (byId.get(id)?.name ?? id)));
  return [...new Set(names.filter((name): name is string => name !== null))].sort();
}

/**
 * Did the engine say this candidate matched? Its `interest` component names every
 * stated interest that matched, so the answer is read off the engine's own
 * sentence rather than re-derived from the catalogue — a second matcher in this
 * file would be a second opinion about the engine's vocabulary.
 */
function interestReason(breakdown: ScoreBreakdown | undefined): string | undefined {
  return breakdown?.components.find((part) => part.key === "interest")?.reason;
}

function servedIn(reason: string | undefined, wanted: readonly string[]): string[] {
  const haystack = reason?.toLowerCase() ?? "";
  return wanted.filter((name) => haystack.includes(name));
}

// ---------------------------------------------------------------------------
// Verification: does the admitted plan actually honour the group?
// ---------------------------------------------------------------------------

/**
 * The safety net. The engine's gate and the load model are supposed to have
 * enforced all of this already, so a breach here is a fault in the pipeline
 * rather than a discovery — which is exactly why it is re-checked from the
 * group's own statements, and why it is reported as blocking rather than
 * downgraded to a warning. The discovery feature's `admit` guards the plan; this
 * guards the *group*, which `admit` has never seen.
 */
function hardBreaches(
  plan: Plan,
  ctx: DiscoveryContext,
  aggregate: GroupAggregate,
  byId: ReadonlyMap<string, Experience>,
): GroupConflict[] {
  const out: GroupConflict[] = [];
  const everyone = labelsOf(aggregate.members);

  if (ctx.budget !== null && plan.totalCost.minor > ctx.budget.minor) {
    const holders = byAxis(aggregate, "budget");
    out.push(
      blocking(
        "budget",
        holders,
        everyone,
        `The plan costs ${money(plan.totalCost)}, over the ${money(ctx.budget)} this group agreed to.`,
        [`${holders.length > 0 ? joinAnd(holders) : "The group"} set the ceiling.`],
      ),
    );
  }

  if (ctx.avoid.includes(INDOOR_TOKEN)) {
    const outside = plan.stops.filter((stop) => byId.get(stop.experienceId)?.indoorOutdoor === "outdoor");
    if (outside.length > 0) {
      out.push(
        blocking(
          "indoor",
          byAxis(aggregate, "indoor"),
          everyone,
          `${plural(outside.length, "stop is", "stops are")} outdoors and this group asked to stay in.`,
          namesOf(outside.map((stop) => stop.experienceId), byId),
        ),
      );
    }
  }

  for (const need of ctx.accessNeeds) {
    const field = NEED_FIELD[need];
    const bad = plan.stops.filter((stop) => byId.get(stop.experienceId)?.accessibility[field] !== true);
    if (bad.length > 0) {
      const holders = aggregate.access.by.get(need) ?? [];
      out.push(
        blocking(
          "access",
          holders,
          [],
          `${plural(bad.length, "stop", "stops")} cannot take ${need}, which ${joinAnd(holders)} needs.`,
          namesOf(bad.map((stop) => stop.experienceId), byId),
        ),
      );
    }
  }
  return out;
}

/**
 * Which group axis a rejection code is about, for *reporting* only. `RELIEF` above
 * is the stricter question — what could be changed to relieve it — and a code can
 * be reportable without being relievable, which is the case for every code here
 * that describes the market rather than the group: a gallery that is shut is not
 * anybody's fault and there is nothing for the group to answer.
 *
 * A code that is not listed is reported under `party`, which is the honest
 * fallback: we know something stopped the plan and we do not know whose axis it was.
 */
const AXIS_OF: Readonly<Partial<Record<string, GroupAxis>>> = {
  over_budget: "budget",
  over_budget_per_person: "budget",
  too_far: "walking",
  leg_too_long_to_walk: "walking",
  walking_budget_exceeded: "walking",
  too_many_back_to_back: "walking",
  block_too_long_without_rest: "walking",
  window_exceeded: "party",
  duration_exceeds_budget: "party",
  travel_time_exceeds_budget: "party",
  not_step_free: "access",
  not_stroller_ok: "access",
  no_low_stairs: "access",
  no_hearing_loop: "access",
  no_restroom: "access",
  inaccessible: "access",
  diet_mismatch: "diet",
  excluded_by_traveller: "interests",
  capacity_exceeded: "party",
  weather_unsafe: "party",
  closed_now: "party",
  closed_during_window: "party",
  hours_unverified: "party",
  sold_out: "party",
  requires_booking_not_available: "party",
  lead_time_too_short: "party",
  seasonal_mismatch: "party",
};

const axisOf = (code: string): GroupAxis => AXIS_OF[code] ?? "party";

/**
 * Who set the ceiling on an axis. For a hard axis that is the people who stated
 * it; for `party` it is nobody in particular, and the composition is the honest
 * answer because the party as a whole is what a window or a headcount is about.
 */
const heldByFor = (aggregate: GroupAggregate, axis: GroupAxis): string[] =>
  axis === "party"
    ? labelsOf(aggregate.members.filter((member) => member.role === "child" || member.role === "elder"))
    : byAxis(aggregate, axis);

/**
 * Which of the group's stated interests the plan does not answer, who stopped it,
 * and what the engine's own words were.
 *
 * Two honesty rules, both learned the hard way:
 *
 *  - **Only the engine may say whether a stop matched.** Its `interest` component
 *    names every stated interest that hit, so the answer is read off that sentence
 *    rather than re-derived from the catalogue. A second matcher in this file would
 *    be a second opinion about the engine's vocabulary.
 *  - **If the engine does not report interest hits at all, this reports nothing.**
 *    An engine that scores without naming its matches is not saying "nothing
 *    matched", it is saying nothing at all, and turning that silence into "Child did
 *    not get their entertainment" would be inventing a conflict between a child and
 *    a plan. So coverage is only claimed when there is something to claim it from.
 */
function unservedInterests(
  plan: Plan,
  aggregate: GroupAggregate,
  ctx: DiscoveryContext,
  catalogue: readonly Experience[],
  engine: EnginePort,
  weights: WeightProfile,
  rejections: () => readonly Blocker[],
  excluded: readonly LoadExclusion[],
): GroupConflict[] {
  const wanted = aggregate.interests.kept.map((row) => row.name);
  if (wanted.length === 0) return [];
  const served = new Set(plan.stops.flatMap((stop) => servedIn(interestReason(stop.score), wanted)));
  const unserved = aggregate.interests.kept.filter((interest) => !served.has(interest.name));
  if (unserved.length === 0) return [];
  const byId = new Map(catalogue.map((item) => [item.id, item]));

  // One pass over the catalogue, and only because a want went unanswered. Each row
  // is scored once and read for every open want, which is what keeps the cost at one
  // engine call per place rather than one per place per want.
  const scored = new Map(
    catalogue.map((item) => [
      item.id,
      interestReason(engine.score(ctx, [item], weights).find((row) => row.experienceId === item.id)),
    ]),
  );
  // Did the engine name its matches at all? A breakdown with no interest component
  // anywhere means the vocabulary above is not the engine's, and we stop here.
  const engineNamed = plan.stops.some((stop) => interestReason(stop.score) !== undefined) ||
    [...scored.values()].some((reason) => reason !== undefined);
  if (!engineNamed) return [];

  const cutAxis = aggregate.decisions.find((decision) => decision.axis === "walking")?.value !== "any"
    ? ("walking" as const)
    : ("party" as const);

  return unserved.map((interest) => {
    const matched = catalogue.filter((item) => servedIn(scored.get(item.id), [interest.name]).length > 0);
    const matchedIds = new Set(matched.map((item) => item.id));
    const stopped = rejections().filter((blocker) => blocker.at !== null && matchedIds.has(blocker.at));
    // A want can also have been lost to the travel-load veto rather than to the
    // gate, and the cut carries its own sentence, so both go in as evidence.
    const cut = excluded.filter((drop) => matchedIds.has(drop.id));
    // Who held the ceiling that took it. The gate's own code says, and the load
    // veto can only be the walking cap or the party, so nothing is invented.
    const axes = new Set<GroupAxis>([
      ...stopped.map((blocker) => axisOf(blocker.code)),
      ...cut.map(() => cutAxis),
    ]);
    const heldBy = [...axes].flatMap((axis) => heldByFor(aggregate, axis));
    const who =
      heldBy.length > 0
        ? ` Blocked by the ${[...axes].join(" and ")} constraint ${joinAnd(heldBy)} stated.`
        : "";
    return {
      axis: "interests" as const,
      severity: "strained" as const,
      heldBy: [...new Set(heldBy)].sort(),
      costing: interest.labels,
      reason:
        (matched.length === 0
          ? `Nothing near here matches ${interest.name}, which ${joinAnd(interest.labels)} asked for.`
          : `Nothing in the plan matches ${interest.name}, which ${joinAnd(interest.labels)} asked for.`) + who,
      evidence: [
        ...namesOf(
          matched.map((item) => item.id),
          byId,
        ).map((name) => `Would have matched: ${name}.`),
        ...stopped.map(
          (blocker) => `${byId.get(blocker.at ?? "")?.name ?? blocker.at ?? "That place"}: ${blocker.message}`,
        ),
        ...cut.map((drop) => `${byId.get(drop.id)?.name ?? drop.id} was cut: ${drop.reason}`),
      ].flat(),
    };
  });
}

/**
 * The tension `docs/MASTERPLAN.md` §10 asked to be visible. It fires only when the
 * travel-load model actually took a stop off the plan, so it is always a real
 * sacrifice rather than a hypothetical one, and the evidence is that model's own
 * audit trail — which also carries the group's factor, so a toddler or an older
 * adult shows up in the numbers.
 *
 * The axis is the cap that is in force, not the check that happened to fire: the
 * exclusions carry sentences, not codes, and guessing a code back out of a
 * sentence would be this file pretending to know more than it does. What binds
 * when a group capped its walking and stops were still cut is the cap, and every
 * exclusion's own sentence is in the evidence beside it.
 */
function loadTension(aggregate: GroupAggregate, load: LoadReport, excluded: readonly LoadExclusion[]): GroupConflict[] {
  if (excluded.length === 0) return [];
  const capped = decisionFor(aggregate, "walking");
  const walking = capped.value !== "any";
  const composition = labelsOf(aggregate.members.filter((member) => member.role === "child" || member.role === "elder"));
  const heldBy = walking ? capped.by : composition;
  return [
    {
      axis: walking ? "walking" : "party",
      severity: "strained",
      heldBy,
      costing: [...new Set(aggregate.interests.kept.flatMap((row) => row.labels))].sort(),
      reason: walking
        ? `${plural(excluded.length, "stop", "stops")} came off the plan to keep this group inside the walking limit ${joinAnd(heldBy)} set (${load.budget.walkMetres} m a day, ${load.budget.maxLegWalkMetres} m in one leg).`
        : `${plural(excluded.length, "stop", "stops")} came off the plan to fit what this group can do in ${hm(load.metrics.availableMin)}.`,
      evidence: [...excluded.map((drop) => `${drop.id}: ${drop.reason}`), ...load.budget.basis],
    },
  ];
}

// ---------------------------------------------------------------------------
// Asks
// ---------------------------------------------------------------------------

/** Blockers grouped by what they say, so one code becomes one question. */
function byCode(blockers: readonly Blocker[]): Map<string, Blocker[]> {
  const out = new Map<string, Blocker[]>();
  for (const blocker of blockers) {
    const rows = out.get(blocker.code);
    if (rows) rows.push(blocker);
    else out.set(blocker.code, [blocker]);
  }
  return out;
}

/**
 * One question, or null when we cannot say what the question is. Null is the
 * honest answer for a code with no known relief: the blocker stays in the
 * evidence, and the group is asked nothing we could not put a number on.
 */
function asksFor(
  blockers: readonly Blocker[],
  ctx: DiscoveryContext,
  aggregate: GroupAggregate,
  engine: EnginePort,
  catalogue: readonly Experience[],
): Ask | null {
  const relief = RELIEF[blockers[0]?.code ?? ""];
  if (!relief) return null;
  const evidence = [...new Set(blockers.map((blocker) => blocker.message))].slice(0, 3);
  const by = relief.kind === "window" ? [] : byAxis(aggregate, relief.kind);

  if (relief.kind === "budget") {
    // `shortfall` is how far a candidate is over the whole-plan ceiling, so the
    // price it needs is the ceiling plus the shortfall, and the per-person number
    // the group has to agree to is that divided by the headcount.
    const ceiling = ctx.budget?.minor ?? 0;
    const price = min(
      blockers
        .map((blocker) => (blocker.shortfall === null ? null : blocker.shortfall + ceiling))
        .filter((value): value is number => value !== null),
    );
    if (price === null) return null;
    const perPerson = Math.ceil(price / Math.max(1, ctx.partySize));
    return {
      sentence: `Raise the ceiling to ${money(perPerson)} each, ${money(perPerson * ctx.partySize)} for ${plural(ctx.partySize, "person", "people")}, and the cheapest options here come back into range.`,
      op: {
        kind: "set_budget",
        budgetMinor: perPerson * ctx.partySize,
        perPersonMinor: perPerson,
        note: `Budget raised to ${money(perPerson)} each.`,
      },
      by,
      evidence: [`Now ${money(ceiling)} for the whole plan.`, ...evidence],
    };
  }

  if (relief.kind === "window") {
    const extra = min(
      blockers
        .map((blocker) => (blocker.unit === "minutes" && blocker.shortfall !== null ? blocker.shortfall : null))
        .filter((value): value is number => value !== null),
    );
    if (extra === null) return null;
    return {
      sentence: `Give the group ${hm(extra)} more than the ${hm(ctx.availableMin)} it has, and the shortest thing it asked for fits.`,
      op: { kind: "set_time", availableMin: ctx.availableMin + extra, note: `Time is now ${hm(ctx.availableMin + extra)}.` },
      by,
      evidence: [`Now ${hm(ctx.availableMin)}.`, ...evidence],
    };
  }

  if (relief.kind === "walking") {
    // The router is the only source of distance, so the number in the evidence
    // comes from the engine's own `travelBetween` and not from a haversine.
    const nearest = closestWalking(
      blockers.map((blocker) => blocker.at),
      ctx,
      engine,
      catalogue,
    );
    return {
      sentence: "Let the group walk again, or take a car between stops.",
      op: { kind: "set_walking", walking: "any", note: "Walking is uncapped." },
      by,
      evidence: [...evidence, ...(nearest === null ? [] : [`Nearest on foot: ${nearest}`])],
    };
  }

  const holders = aggregate.access.by.get(relief.need) ?? [];
  const remaining = ctx.accessNeeds.filter((need) => need !== relief.need);
  const places = new Set(blockers.map((blocker) => blocker.at)).size;
  return {
    sentence: `Drop the ${relief.need} requirement. It is on the list because of ${joinAnd(holders)}, and on its own it rules out ${plural(places, "place", "places")}.`,
    op: { kind: "set_access_needs", needs: remaining, note: `${relief.need} no longer required.` },
    by: holders,
    evidence: [...evidence, `What the group may still ask for: ${remaining.length === 0 ? "no access need at all" : remaining.join(", ")}.`],
  };
}

function closestWalking(
  ids: readonly (string | null)[],
  ctx: DiscoveryContext,
  engine: EnginePort,
  catalogue: readonly Experience[],
): string | null {
  const origin = ctx.origin.point;
  if (!origin) return null;
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const nearest = ids
    .map((id) => (id === null ? undefined : byId.get(id)))
    .filter((item): item is Experience => item !== undefined)
    .map((item) => engine.travelBetween(origin, item.location, "walk", ctx.nowMin))
    .sort((a, b) => a.metres - b.metres || a.minutes - b.minutes)[0];
  return nearest === undefined ? null : `${Math.round(nearest.metres / 100) / 10} km, ${hm(nearest.minutes)} on foot.`;
}

/** One question per blocking code, most candidates freed first, then by code. */
function asksFrom(
  codes: Iterable<string>,
  rows: ReadonlyMap<string, Blocker[]>,
  ctx: DiscoveryContext,
  aggregate: GroupAggregate,
  engine: EnginePort,
  catalogue: readonly Experience[],
): Ask[] {
  return [...codes]
    .map((code) => ({ code, blockers: rows.get(code) ?? [] }))
    .sort((a, b) => b.blockers.length - a.blockers.length || a.code.localeCompare(b.code))
    .map((entry) => asksFor(entry.blockers, ctx, aggregate, engine, catalogue))
    .filter((ask): ask is Ask => ask !== null);
}

// ---------------------------------------------------------------------------
// The group plan
// ---------------------------------------------------------------------------

export type GroupPlanInput = {
  engine: EnginePort;
  request: GroupRequest;
  members: readonly GroupMember[];
  catalogue: readonly Experience[];
  weights: WeightProfile;
  /** Asks the group accepted. Applied through the discovery editor, in order. */
  adjust?: readonly Ask[];
};

export type GroupPlan =
  | {
      ok: true;
      aggregate: GroupAggregate;
      session: DiscoverySession;
      outcome: Extract<DiscoverOutcome, { ok: true }>;
      conflicts: GroupConflict[];
      ask: Ask[];
    }
  | {
      ok: false;
      aggregate: GroupAggregate;
      session: DiscoverySession;
      outcome: DiscoverOutcome;
      /** Finished sentence. Never a plan the group cannot all do. */
      reason: string;
      conflicts: GroupConflict[];
      ask: Ask[];
    };

/** Everything the conflict chain needs, named once because three callers need it. */
type Solved = {
  plan: Plan;
  load: LoadReport;
  excluded: readonly LoadExclusion[];
  aggregate: GroupAggregate;
  ctx: DiscoveryContext;
  byId: ReadonlyMap<string, Experience>;
  catalogue: readonly Experience[];
  engine: EnginePort;
  weights: WeightProfile;
  blockers: () => readonly Blocker[];
};

/**
 * The group's audit of a plan the pipeline has already admitted. One
 * implementation, three callers: a first solve, a replan, and the guard that
 * decides whether an admitted plan is allowed to exist at all for this group.
 */
function conflictsFor(solved: Solved): GroupConflict[] {
  return [
    ...hardBreaches(solved.plan, solved.ctx, solved.aggregate, solved.byId),
    ...unservedInterests(
      solved.plan,
      solved.aggregate,
      solved.ctx,
      solved.catalogue,
      solved.engine,
      solved.weights,
      solved.blockers,
      solved.excluded,
    ),
    ...loadTension(solved.aggregate, solved.load, solved.excluded),
  ];
}

const blockersFrom = (rejections: readonly Rejection[]): Blocker[] =>
  rejections.map((rejection) => ({
    code: rejection.code,
    at: rejection.experienceId,
    message: rejection.message,
    shortfall: rejection.shortfall,
    unit: rejection.unit,
  }));

const loadBlockers = (load: LoadReport | null): Blocker[] =>
  (load?.violations ?? []).map((violation) => ({
    code: violation.code,
    at: violation.at,
    message: violation.message,
    shortfall: violation.shortfall,
    unit: violation.unit,
  }));

/**
 * The pipeline's own violations, folded in with the gate's rejections so that a
 * refusal is reported in one vocabulary. `engine_error` is in here on purpose: when
 * the engine throws, its message is the only account of what happened, and dropping
 * it would leave a group being told their constraints were impossible when the
 * truth is that the index was offline.
 */
const violationRows = (violations: readonly { code: string; message: string; at: string | null }[]): Blocker[] =>
  violations.map((violation) => ({
    code: violation.code,
    at: violation.at,
    message: violation.message,
    shortfall: null,
    unit: null,
  }));

/**
 * The gate's own account of the candidates, straight from the engine, fetched at
 * most once and only when something needs explaining. Allowed to fail: a run may
 * have failed *because* the engine threw, and an empty list then means "no
 * candidate evidence", which is the truth — the violations the pipeline returned
 * are still reported on their own.
 */
function blockerSource(
  engine: EnginePort,
  ctx: DiscoveryContext,
  catalogue: readonly Experience[],
): () => readonly Blocker[] {
  let cache: readonly Blocker[] | null = null;
  return () => {
    if (cache === null) {
      try {
        cache = blockersFrom(engine.filterFeasible(ctx, [...catalogue]).rejected);
      } catch {
        cache = [];
      }
    }
    return cache;
  };
}

/**
 * One blocking conflict per axis, each with the engine's own sentences and the
 * decision that set the axis. Collapsing all of this into a single "party"
 * conflict was the lazy version and it was also the useless one: a group that
 * cannot go anywhere because of a ceiling and a group that cannot go anywhere
 * because of stairs get the same sentence, and only one of those is a conversation
 * the group can have. `stuck` when nothing was attributable at all — the engine
 * threw, and there is genuinely no axis to name.
 */
function blockingByAxis(
  rows: readonly Blocker[],
  aggregate: GroupAggregate,
  byId: ReadonlyMap<string, Experience>,
  fallback: string,
): GroupConflict[] {
  const everyone = labelsOf(aggregate.members);
  const grouped = new Map<GroupAxis, Blocker[]>();
  for (const row of rows) {
    const axis = axisOf(row.code);
    const bucket = grouped.get(axis);
    if (bucket) bucket.push(row);
    else grouped.set(axis, [row]);
  }
  if (grouped.size === 0) return [blocking("party", [], everyone, fallback, [fallback])];

  return [...grouped.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .map(([axis, bucket]) => {
      const decision = decisionFor(aggregate, axis);
      const places = new Set(bucket.map((row) => row.at)).size;
      return blocking(
        axis,
        heldByFor(aggregate, axis),
        everyone,
        `${plural(places, "place", "places")} ruled out on ${axis}. ${decision.reason}`,
        [
          ...[...new Set(bucket.map((row) => row.message))].slice(0, 3),
          ...namesOf(bucket.map((row) => row.at), byId).map((name) => `Ruled out: ${name}.`),
        ],
      );
    });
}

/**
 * No plan, and why not. One implementation for the first solve and for a re-solve
 * that came back empty, because they are the same event with the same evidence.
 *
 * `unmet` follows the discovery feature's own rule rather than a second one: a
 * group is blocked when candidates existed and every one of them was eliminated on
 * a hard constraint. No rejection at all means nothing was retrieved, which is a
 * market gap — so there is no constraint to ask about and no conflict to raise.
 */
function unserved(
  blockers: () => readonly Blocker[],
  planRejections: readonly Rejection[],
  aggregate: GroupAggregate,
  byId: ReadonlyMap<string, Experience>,
  ctx: DiscoveryContext,
  engine: EnginePort,
  catalogue: readonly Experience[],
): { reason: string; conflicts: GroupConflict[]; ask: Ask[] } {
  const rows = byCode([...blockers(), ...blockersFrom(planRejections)]);
  const unmet = rows.size > 0;
  return {
    reason: unmet
      ? "Nothing within reach works for all of you at once."
      : "There is nothing to plan from where you are.",
    conflicts: unmet
      ? blockingByAxis(
          [...rows.values()].flat(),
          aggregate,
          byId,
          "There is nothing to plan from where you are.",
        )
      : [],
    ask: unmet ? asksFrom(rows.keys(), rows, ctx, aggregate, engine, catalogue) : [],
  };
}

/**
 * Aggregate, then run the ordinary discovery pipeline on the result. There is no
 * group-specific solve, no group-specific gate and no group-specific plan: the
 * engine is handed a `DiscoveryContext` that happens to be the group's, and
 * everything it decides, it decides for everybody in it.
 *
 * A `blocking` conflict is never returned with a plan. It is a refusal, because
 * the alternative is showing four people an itinerary that does not work for one
 * of them — which is the exact failure this file exists to prevent.
 */
export function planForGroup(input: GroupPlanInput): GroupPlan {
  const aggregate = aggregateGroup(input.request, input.members);
  const base = createContext(aggregate.seed);
  const ops = (input.adjust ?? []).map((ask) => ask.op);
  // An accepted ask is a context edit, not a new trip: `intent` stays the group we
  // started with, so a diff still measures against the original request.
  const state: EditorState = ops.length > 0 ? applyOps(base, ops).state : base;
  const session = createSession({
    engine: input.engine,
    seed: aggregate.seed,
    catalogue: input.catalogue,
    weights: input.weights,
  });
  const active: DiscoverySession = state === base ? session : { ...session, state };
  const ctx = active.state.ctx;
  const byId = new Map(input.catalogue.map((item) => [item.id, item]));
  const blockers = blockerSource(input.engine, ctx, input.catalogue);

  const outcome = discover(input.engine, active);

  if (!outcome.ok) {
    // The engine threw, or `admit` refused. Both mean this group cannot be served
    // as asked, and both arrive with the numbers that say why.
    const stated = violationRows(outcome.violations);
    const rows = byCode([...blockers(), ...loadBlockers(outcome.load), ...stated]);
    const codes = new Set([...rows.keys()]);
    return {
      ok: false,
      aggregate,
      session: active,
      outcome,
      reason: outcome.reason,
      conflicts: blockingByAxis([...rows.values()].flat(), aggregate, byId, outcome.reason),
      ask: asksFrom(codes, rows, ctx, aggregate, input.engine, input.catalogue),
    };
  }

  if (outcome.plan.stops.length === 0) {
    const nothing = unserved(blockers, outcome.plan.rejected, aggregate, byId, ctx, input.engine, input.catalogue);
    return {
      ok: false,
      aggregate,
      session: active,
      outcome,
      reason: nothing.reason,
      conflicts: nothing.conflicts,
      ask: nothing.ask,
    };
  }

  const conflicts = conflictsFor({
    plan: outcome.plan,
    load: outcome.load,
    excluded: outcome.excluded,
    aggregate,
    ctx,
    byId,
    catalogue: input.catalogue,
    engine: input.engine,
    weights: input.weights,
    blockers,
  });
  const refused = conflicts.filter((conflict) => conflict.severity === "blocking");
  if (refused.length > 0) {
    // The pipeline returned a plan that breaks something the group said was hard.
    // We do not soften it and we do not ask anybody to drop a mobility need: we
    // hand back no plan, and the pipeline gets fixed instead.
    return {
      ok: false,
      aggregate,
      session: active,
      outcome,
      reason: refused[0]?.reason ?? "This plan does not work for everyone in the group.",
      conflicts,
      ask: [],
    };
  }

  return {
    ok: true,
    aggregate,
    // The session the pipeline returned, not the one we handed it: this is the one
    // carrying the admitted plan, its load report and its exclusions, and it is what
    // `replanForGroup` needs to adapt the group's plan rather than nothing.
    session: outcome.session,
    outcome,
    conflicts,
    ask: [],
  };
}

// ---------------------------------------------------------------------------
// Replanning a group that already has a plan
// ---------------------------------------------------------------------------

export type GroupReplanInput = {
  engine: EnginePort;
  /** The session `planForGroup` returned. Its `plan` is the one being adapted. */
  session: DiscoverySession;
  /** The aggregate that session was built from. It carries the personas. */
  aggregate: GroupAggregate;
  catalogue: readonly Experience[];
  weights: WeightProfile;
  /** What the group just agreed to, or every ask they were shown. */
  answer: Ask | readonly Ask[];
};

export type GroupReplan =
  | {
      ok: true;
      aggregate: GroupAggregate;
      session: DiscoverySession;
      outcome: Extract<ReplanOutcome, { ok: true }>;
      conflicts: GroupConflict[];
      /**
       * Always empty. A group that can be served has nothing left to be asked, and
       * the field is here so a caller can read `.ask` without branching on `ok` first.
       */
      ask: Ask[];
    }
  | {
      ok: false;
      aggregate: GroupAggregate;
      /** The session as it stands: a failed re-solve never costs the group its plan. */
      session: DiscoverySession;
      change: ContextChange | null;
      reason: string;
      conflicts: GroupConflict[];
      ask: Ask[];
    };

/**
 * The group accepts an answer, and the *existing* replanner does the work:
 * `applyOps` folds the ask into the editor state, `replan` re-solves, and `admit`
 * decides whether the result may be shown. So a group that already has a plan gets
 * the same diff, the same reality panel and the same guarantees as any other
 * replan, and this file only reports the tension afterwards.
 *
 * Three things it will not do: it will not invent a plan when there was none to
 * adapt, it will not re-solve when the answer changes nothing the planner reads, and
 * it will not return a new plan that breaks a hard group constraint — the same
 * refusal `planForGroup` makes, for the same reason.
 */
export function replanForGroup(input: GroupReplanInput): GroupReplan {
  const { aggregate, engine, catalogue, weights, session } = input;
  const answers = Array.isArray(input.answer) ? input.answer : [input.answer];
  const edit = applyOps(session.state, answers.map((ask) => ask.op));

  if (!edit.change) {
    // `applyOps` reports no change when nothing the planner reads moved. Re-solving
    // would burn an engine pass to return the same plan, and reporting a change
    // nobody made would be worse.
    return {
      ok: false,
      aggregate,
      session,
      change: null,
      reason: "That would not change anything the planner reads, so nothing was re-solved.",
      conflicts: [],
      ask: [],
    };
  }

  if (session.plan === null) {
    return {
      ok: false,
      aggregate,
      session,
      change: edit.change,
      reason: "There is no plan to adapt yet, so this has to be a new solve rather than a re-solve.",
      conflicts: [],
      ask: [],
    };
  }

  const outcome = replan(engine, { ...session, state: edit.state }, edit.change);
  const ctx = outcome.session.state.ctx;
  const byId = new Map(catalogue.map((item) => [item.id, item]));
  const blockers = blockerSource(engine, ctx, catalogue);

  if (!outcome.ok) {
    const stated = violationRows(outcome.violations);
    const rows = byCode([...blockers(), ...loadBlockers(outcome.load), ...stated]);
    const codes = new Set([...rows.keys()]);
    return {
      ok: false,
      aggregate,
      session: outcome.session,
      change: outcome.change,
      reason: outcome.reason,
      conflicts: blockingByAxis([...rows.values()].flat(), aggregate, byId, outcome.reason),
      ask: asksFrom(codes, rows, ctx, aggregate, engine, catalogue),
    };
  }

  if (outcome.plan.stops.length === 0) {
    // The re-solve is allowed to come back with nothing, and `admit` will pass an
    // empty plan: it is a true plan, just an empty one. For a group it is not a
    // result — the window they agreed to is gone — so it is reported the same way a
    // first solve reports it, with the evidence and the question.
    const nothing = unserved(blockers, outcome.plan.rejected, aggregate, byId, ctx, engine, catalogue);
    return {
      ok: false,
      aggregate,
      session: outcome.session,
      change: outcome.change,
      reason: nothing.reason,
      conflicts: nothing.conflicts,
      ask: nothing.ask,
    };
  }

  const conflicts = conflictsFor({
    plan: outcome.plan,
    load: outcome.load,
    excluded: outcome.excluded,
    aggregate,
    ctx,
    byId,
    catalogue,
    engine,
    weights,
    blockers,
  });
  const refused = conflicts.filter((conflict) => conflict.severity === "blocking");
  if (refused.length > 0) {
    return {
      ok: false,
      aggregate,
      session: outcome.session,
      change: outcome.change,
      reason: refused[0]?.reason ?? "The re-solved plan does not work for everyone in the group.",
      conflicts,
      // Not offered here either. The previous plan is what the group still has, and
      // it was valid when it was made.
      ask: [],
    };
  }

  return { ok: true, aggregate, session: outcome.session, outcome, conflicts, ask: [] };
}

// ---------------------------------------------------------------------------
// Negotiation
// ---------------------------------------------------------------------------

/** How many times `resolveGroup` will ask before it gives up on itself. */
export const MAX_ROUNDS = 3;

export type GroupRound = {
  /** The question put to the group, or null when there was none left to ask. */
  ask: Ask | null;
  /** Why the round ended the way it did. */
  reason: string;
  /** What the group was told it had lost, after this round. */
  conflicts: GroupConflict[];
  /** Stops in the plan this round produced. 0 means none. */
  stops: number;
};

export type GroupResolution = {
  ok: boolean;
  /** Every round, in order. The transcript the panel shows. */
  rounds: GroupRound[];
  /** The last plan produced, whichever way it went. */
  plan: GroupPlan;
  /**
   * True when no remaining answer would help: nothing left to ask, or the last
   * answer changed nothing the planner reads. This is what stops a caller from
   * looping on an ask that goes nowhere.
   */
  stuck: boolean;
};

/**
 * The fields an ask can move, and therefore everything that has to change for an
 * answer to count as progress. Mirrors the reasoning in `context.ts`: a field left
 * out here is one the loop would treat as "answered" while nothing happened.
 */
function visibleKey(ctx: DiscoveryContext): string {
  return JSON.stringify({
    availableMin: ctx.availableMin,
    budget: ctx.budget?.minor ?? null,
    perPerson: ctx.budgetPerPerson?.minor ?? null,
    accessNeeds: [...ctx.accessNeeds].sort(),
    avoid: [...ctx.avoid].sort(),
    interests: [...ctx.interests].sort(),
    travelMode: ctx.travelMode,
    partySize: ctx.partySize,
    childAges: [...ctx.childAges].sort(),
  });
}

/**
 * The group co-decider: solve, ask the group the single most useful question, take
 * the answer, solve again. Bounded three ways so it always terminates — by a
 * served plan, by having no question left to ask, and by noticing that the last
 * answer did not move anything the planner reads.
 *
 * Only the group's own asks are applied, one per round and always the one that
 * would free the most candidates, so the transcript is a negotiation rather than a
 * search. Nothing is relaxed that the group did not agree to, and a group that
 * cannot be served ends with `ok: false` and no itinerary.
 */
export function resolveGroup(input: GroupPlanInput & { maxRounds?: number }): GroupResolution {
  const rounds = Math.max(1, Math.min(MAX_ROUNDS, input.maxRounds ?? MAX_ROUNDS));
  const transcript: GroupRound[] = [];
  const accepted: Ask[] = [];
  let plan = planForGroup({ ...input, adjust: accepted });

  for (let round = 0; round < rounds; round += 1) {
    if (plan.ok) {
      return {
        ok: true,
        rounds: transcript,
        plan,
        stuck: false,
      };
    }
    const ask = plan.ask[0];
    if (!ask) {
      // Either the group cannot be served and there is nothing they could change,
      // or there was nothing to plan from. Either way, asking again is pointless.
      transcript.push({
        ask: null,
        reason: plan.reason,
        conflicts: plan.conflicts,
        stops: 0,
      });
      return { ok: false, rounds: transcript, plan, stuck: true };
    }

    const before = visibleKey(plan.session.state.ctx);
    accepted.push(ask);
    const next = planForGroup({ ...input, adjust: accepted });
    const moved = visibleKey(next.session.state.ctx) !== before;
    transcript.push({
      ask,
      reason: next.ok ? "The group could be served." : next.reason,
      conflicts: next.conflicts,
      stops: next.ok ? next.outcome.plan.stops.length : 0,
    });
    plan = next;
    if (!moved) {
      // The answer was accepted and the context did not move. Offering it again
      // would loop for ever, so this is where the negotiation stops.
      return { ok: false, rounds: transcript, plan, stuck: true };
    }
  }

  return { ok: false, rounds: transcript, plan, stuck: plan.ask.length === 0 };
}
