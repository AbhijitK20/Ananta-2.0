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
 *     wheelchair is not something a group votes on, so access needs, and the
 *     money and walking limits stated as hard, go in as they are. The group's
 *     walking limit is the *strictest* one anybody stated and its ceiling is the
 *     *lowest*, because every weaker limit is already satisfied by the stricter
 *     one. That is why these axes need no arbitration at all — and it is why
 *     "average the group" is never the right answer for them. Interests are the
 *     opposite case: they are wants, not limits, so they are ranked by how many
 *     people asked for them and the tail is reported as dropped rather than
 *     quietly ignored.
 *
 *  3. **The tension is reported, not resolved.** `docs/MASTERPLAN.md` §10 asked
 *     for "shared constraints + per-person personas + a visible tension axis", and
 *     `content/evaluation/scenarios.jsonl:12` asserts the tension is surfaced.
 *     Every conflict below is derived from something that really happened: an
 *     engine rejection, a load-model cut, a number in the plan, a distance from
 *     the engine's own router. This file never invents a disagreement between two
 *     people who did not have one, and it reports no conflict for an axis where
 *     the group had nothing to lose.
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
  type DiscoverOutcome,
  type DiscoverySession,
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

export type GroupAxis = "party" | "walking" | "indoor" | "budget" | "access" | "interests";

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
  /** Fixed axis order: party, walking, indoor, budget, access, interests. */
  decisions: GroupDecision[];
  /** Union of everybody's hard access needs, and whose each one is. */
  access: { needs: AccessNeed[]; by: Map<AccessNeed, string[]> };
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
 */
function interestsOf(members: readonly GroupMember[]): { kept: GroupInterest[]; dropped: GroupInterest[] } {
  const strong = new Map<string, string[]>();
  const soft = new Map<string, string[]>();
  for (const member of members) {
    for (const raw of member.strong?.interests ?? []) push(strong, norm(raw), member.label);
    for (const raw of member.soft?.interests ?? []) push(soft, norm(raw), member.label);
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

const withCount = (interest: GroupInterest): string =>
  interest.labels.length > 1 ? `${interest.name} (${interest.labels.length} of you)` : interest.name;

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
 * Which of the group's stated interests the plan does not answer, and what
 * stopped the places that would have. Reported as `strained`, not `blocking`: the
 * group has a plan, and this is what it cost.
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
  const byId = new Map(catalogue.map((item) => [item.id, item]));

  return aggregate.interests.kept
    .filter((interest) => !served.has(interest.name))
    .map((interest) => {
      // Ask the engine which candidates would have matched, so the evidence names
      // real places and the real reason each of them is not in the plan.
      //
      // ponytail: one `score` call per catalogue row, and only when a want went
      // unanswered. Upgrade path if it shows up in a profile: score the shortlist
      // once and index it by id.
      const matched = catalogue.filter((item) =>
        servedIn(
          interestReason(engine.score(ctx, [item], weights).find((row) => row.experienceId === item.id)),
          [interest.name],
        ).length > 0,
      );
      const stopped = rejections().filter((blocker) =>
        matched.some((item) => item.id === blocker.at),
      );
      // A want can also have been lost to the travel-load veto rather than to the
      // gate, and the cut is recorded with its own sentence, so both are evidence.
      const cut = excluded.filter((drop) => matched.some((item) => item.id === drop.id));
      return {
        axis: "interests" as const,
        severity: "strained" as const,
        heldBy: [],
        costing: interest.labels,
        reason:
          matched.length === 0
            ? `Nothing near here matches ${interest.name}, which ${joinAnd(interest.labels)} asked for.`
            : `Nothing in the plan matches ${interest.name}, which ${joinAnd(interest.labels)} asked for.`,
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

  // The gate's own account of the candidates, straight from the engine. Called at
  // most once, and only when something needs explaining. Allowed to fail: the run
  // may have failed *because* the engine threw, and an empty list then means "no
  // candidate evidence", which is the truth — the violations `discover` returned
  // are still reported.
  let cache: readonly Blocker[] | null = null;
  const blockers = (): readonly Blocker[] => {
    if (cache === null) {
      try {
        cache = input.engine
          .filterFeasible(ctx, [...input.catalogue])
          .rejected.map((rejection) => ({
            code: rejection.code,
            at: rejection.experienceId,
            message: rejection.message,
            shortfall: rejection.shortfall,
            unit: rejection.unit,
          }));
      } catch {
        cache = [];
      }
    }
    return cache;
  };

  const outcome = discover(input.engine, active);
  const loadBlockers = (load: LoadReport | null): Blocker[] =>
    (load?.violations ?? []).map((violation) => ({
      code: violation.code,
      at: violation.at,
      message: violation.message,
      shortfall: violation.shortfall,
      unit: violation.unit,
    }));

  if (!outcome.ok) {
    // The engine threw, or `admit` refused. Both mean this group cannot be served
    // as asked, and both arrive with the numbers that say why.
    const rows = byCode([...blockers(), ...loadBlockers(outcome.load)]);
    const codes = new Set([...outcome.violations.map((violation) => violation.code), ...rows.keys()]);
    const everyone = labelsOf(aggregate.members);
    return {
      ok: false,
      aggregate,
      session: active,
      outcome,
      reason: outcome.reason,
      conflicts: [
        blocking("party", [], everyone, outcome.reason, [
          ...outcome.violations.map((violation) => violation.message),
          ...namesOf([...rows.values()].flat().map((row) => row.at), byId).map((name) => `Ruled out: ${name}.`),
        ]),
      ],
      ask: asksFrom(codes, rows, ctx, aggregate, input.engine, input.catalogue),
    };
  }

  if (outcome.plan.stops.length === 0) {
    const rows = byCode(blockers());
    const unmet = outcome.demand.status === "unmet";
    const ruled = namesOf([...rows.values()].flat().map((row) => row.at), byId);
    return {
      ok: false,
      aggregate,
      session: active,
      outcome,
      reason: unmet
        ? "Nothing within reach works for all of you at once."
        : "There is nothing to plan from where you are.",
      conflicts: unmet
        ? [
            blocking(
              "party",
              [],
              labelsOf(aggregate.members),
              `Every one of the ${plural(ruled.length, "place", "places")} near here was ruled out on a hard constraint this group set.`,
              [
                ...aggregate.decisions
                  .filter((decision) => decision.strength === "hard")
                  .map((decision) => `${decision.axis}: ${decision.reason}`),
                ...ruled.map((name) => `Ruled out: ${name}.`),
              ],
            ),
          ]
        : [],
      // No rejection means nothing was retrieved, so there is no constraint to ask
      // about: that is a market gap, and it belongs in unmet demand, not in a
      // question for the group.
      ask: unmet ? asksFrom(rows.keys(), rows, ctx, aggregate, input.engine, input.catalogue) : [],
    };
  }

  const conflicts = [
    ...hardBreaches(outcome.plan, ctx, aggregate, byId),
    ...unservedInterests(
      outcome.plan,
      aggregate,
      ctx,
      input.catalogue,
      input.engine,
      input.weights,
      blockers,
      outcome.excluded,
    ),
    ...loadTension(aggregate, outcome.load, outcome.excluded),
  ];
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

  return { ok: true, aggregate, session: active, outcome, conflicts, ask: [] };
}
