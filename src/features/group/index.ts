/**
 * `src/features/group/**` — several travellers, one plan.
 *
 * The group layer sits in front of the discovery pipeline and nowhere else. It
 * decides what a set of people can collectively commit to, hands that to
 * `createContext` as an ordinary `ContextSeed`, and reports the tension the
 * decision cost. The planner is the discovery feature's, unchanged.
 *
 * ```ts
 * const group = planForGroup({ engine, request, members, catalogue, weights });
 * group.ok
 *   ? render(group.outcome.plan, group.conflicts)                  // strained, with evidence
 *   : render(group.reason, group.ask, group.conflicts);             // no plan, and what to change
 * const answered = planForGroup({ engine, request, members, catalogue, weights, adjust: group.ask });
 * ```
 */
export {
  INTEREST_SLOTS,
  aggregateGroup,
  planForGroup,
  type Ask,
  type GroupAggregate,
  type GroupAxis,
  type GroupConflict,
  type GroupDecision,
  type GroupInterest,
  type GroupMember,
  type GroupPlan,
  type GroupPlanInput,
  type GroupRequest,
  type GroupWalking,
  type Strength,
} from "./group";
