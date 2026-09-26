/**
 * The action layer. One to-do, not eleven.
 *
 * Detection answers "what is unmet". A provider's afternoon answers "what do I
 * do". Those are not the same list: one listing with three neighbourhoods
 * wanting step-free access is one edit on one field, and a feed that shows it
 * three times teaches the provider that the feed is noise.
 *
 * So an `Action` is the collapse: same provider, same listing, same dotted field
 * path, summed evidence. The numbers add because they count the same kind of
 * thing — searches, travellers, blocked candidates — and the contributing cells
 * are kept so a provider can see *which* areas asked rather than a total that
 * hides them.
 *
 * A `must_see_gap` is not an action: it belongs to whoever is acquiring supply,
 * not to a provider with a listing to edit. It is filtered out here and stays
 * available through `acquisitionGaps`.
 */
import type { ProviderOpportunity } from "../../contracts";
import { plural } from "./demand";
import type { ProviderOpportunityRecord } from "./engine";

export interface ActionEvidence {
  label: string;
  value: string;
}

export interface ProviderAction {
  id: string;
  providerId: string;
  providerName: string;
  kind: ProviderOpportunity["kind"];
  /** The listing to open, and the dotted field to focus. */
  targetListingId: string | null;
  targetListingName: string | null;
  /** The one thing to do: a field path, or `slots`. */
  field: string;
  /** Finished sentence naming the change, without the demand clause. */
  action: string;
  /** The button. Verb first. */
  cta: string;
  /** Summed across every gap that wants this same change. */
  searches: number;
  travellers: number;
  blockedCandidates: number;
  /** Distinct areas that asked, sorted. */
  neighbourhoods: string[];
  /** The gaps behind it, for drill-down. */
  cellKeys: string[];
  /** `rising` when any contributing gap is growing. */
  trend: "rising" | "falling" | "flat";
  /**
   * What the change would be worth, when a contributing gap carried a
   * measurement. In practice open opportunities never do — nothing has been
   * acted on yet, so there is nothing measured — which is exactly why this sits
   * here as null rather than as a prediction. Read it off a `met` record.
   */
  estimatedImpact: string | null;
  evidence: ActionEvidence[];
}

/**
 * Collapse open records into one action per (provider, listing, field).
 *
 * Order is by searches then id, so the list a provider sees does not reshuffle
 * between renders — the same guarantee `detectOpportunities` makes, applied one
 * level up.
 */
export function toActions(records: readonly ProviderOpportunityRecord[]): ProviderAction[] {
  const groups = new Map<string, ProviderOpportunityRecord[]>();

  for (const record of records) {
    // Acquisition gaps are not somebody's to-do item, and a met record is not
    // work. Both stay available through their own queries.
    if (record.status !== "open" || record.providerId === null) continue;
    const key = `${record.providerId}|${record.targetListingId ?? "-"}|${record.missingSupply.field}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(record);
    else groups.set(key, [record]);
  }

  const actions: ProviderAction[] = [];
  for (const [key, group] of groups) {
    const first = group[0]!;
    const searches = sum(group.map((record) => record.demand.searches));
    const travellers = sum(group.map((record) => record.demand.travellers));
    const blocked = sum(group.map((record) => record.demand.blockedCandidates));
    const neighbourhoods = [...new Set(group.map((record) => record.demand.neighbourhood))].sort();
    const trend: ProviderAction["trend"] = group.some((record) => record.demand.trend === "rising")
      ? "rising"
      : group.every((record) => record.demand.trend === "falling")
        ? "falling"
        : "flat";
    const suggested = group.find((record) => record.suggestedSlot !== null)?.suggestedSlot ?? null;

    actions.push({
      id: `act-${key}`,
      providerId: first.providerId!,
      providerName: first.providerName ?? "",
      kind: first.kind,
      targetListingId: first.targetListingId,
      targetListingName: first.targetListingName,
      field: first.missingSupply.field,
      // The headline reads `${change} — ${demand}, and ${supply}.` and only the
      // change is the action. Splitting on the em dash keeps the two apart
      // without writing the sentence twice.
      action: first.contract.headline.split(" — ")[0] ?? first.contract.headline,
      cta: first.contract.cta,
      searches,
      travellers,
      blockedCandidates: blocked,
      neighbourhoods,
      cellKeys: group.map((record) => record.demand.key).sort(),
      trend,
      // Impacts are per-gap sentences that cannot be added, and every record in
      // here is an OPEN one, which by construction carries no measurement. So
      // this is the first one that exists, not a sum dressed up as a total.
      estimatedImpact: first.contract.estimatedImpact,
      evidence: [
        {
          label: "searches behind this one change",
          value: `${searches} across ${neighbourhoods.length} ${plural(neighbourhoods.length, "area", "areas")}`,
        },
        { label: "travellers", value: `${travellers}` },
        { label: "candidates blocked", value: `${blocked}` },
        { label: "where", value: neighbourhoods.join(", ") },
        { label: "change to", value: first.missingSupply.field },
        { label: "demand trend", value: trend },
        ...(suggested === null ? [] : [{ label: "suggested window", value: `${suggested.label} on ${suggested.date}` }]),
        { label: "gaps behind it", value: `${group.length}` },
      ],
    });
  }

  return actions.sort((a, b) => (b.searches !== a.searches ? b.searches - a.searches : a.id < b.id ? -1 : 1));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
