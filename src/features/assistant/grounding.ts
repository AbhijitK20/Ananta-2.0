/**
 * Grounding: turning a question and the real catalogue into the handful of facts
 * the assistant is allowed to state.
 *
 * This is the mechanism behind the system prompt's hardest rule — never state a
 * price, an opening time, a distance or a duration that is not in the grounding
 * block. A rule in a prompt is a request; this is the supply side. If a fact is
 * not here, there is nothing for the assistant to quote, so hallucinating one
 * requires it to invent a number outright rather than misremember one.
 *
 * Facts come from `src/app/_lib/catalogue.ts`, which is the same validated
 * catalogue the rest of the app plans against — not a second copy, and not a
 * summary written by a model. Every fact is assembled from contract fields, so
 * "unknown" stays unknown: an experience with `pricePerPerson: null` produces a
 * fact that says the price is not listed, not a fact that omits the price and
 * lets the gap read as zero.
 *
 * Retrieval is keyword scoring over 250 rows with a category and neighbourhood
 * boost, not embeddings. It is deterministic, costs nothing, and at this
 * catalogue size it is not the bottleneck — a 3B model's attention over a long
 * context is.
 */
import { loadCatalogue } from "@/app/_lib/catalogue";
import type { Experience } from "@/contracts";
import type { ChatRequestBody } from "./orchestration/safety";

/** Facts per turn. More than this and a small model starts summarising. */
export const MAX_FACTS = 6;

const CATEGORY_WORDS: Record<string, string[]> = {
  street_food: ["food", "street", "eat", "eats", "eating", "snack", "chaat", "streetfood"],
  restaurant: ["restaurant", "dinner", "lunch", "meal", "eat", "food"],
  cafe: ["cafe", "coffee", "tea", "chai", "bake", "bakery", "breakfast"],
  market: ["market", "bazaar", "shopping", "shop", "buy", "souvenir"],
  craft_workshop: ["craft", "workshop", "pottery", "make", "hands", "diy", "crafts"],
  art_studio: ["art", "gallery", "studio", "paint", "exhibit", "artwork"],
  music_live: ["music", "live", "concert", "band", "jazz", "ghazal"],
  dance_performance: ["dance", "dancing", "performance", "kathak", "performance"],
  theatre: ["theatre", "theater", "play", "drama", "show"],
  temple: ["temple", "mandir", "shrine", "puja", "prayer"],
  church: ["church", "basilica", "cathedral", "mass", "christian"],
  mosque: ["mosque", "masjid", "namaz"],
  heritage_site: ["heritage", "fort", "ruins", "history", "historic", "forts"],
  museum: ["museum", "collection", "exhibit", "artefact", "artifact"],
  gallery: ["gallery", "art", "exhibition", "exhibit"],
  nature: ["nature", "park", "garden", "green", "trees", "bird", "birds"],
  beach: ["beach", "sea", "ocean", "sand", "swim", "swimming", "coast"],
  adventure: ["adventure", "activity", "ride", "kayak", "trek", "cycling"],
  wellness: ["wellness", "yoga", "spa", "massage", "relax", "ayurveda"],
  nightlife: ["nightlife", "bar", "pub", "club", "late", "drinks", "night"],
  shopping: ["shopping", "shop", "buy", "souvenir", "mall", "market"],
  community_hosted: ["community", "host", "local", "hosted", "neighbour", "neighbour"],
};

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "are", "was", "do", "does", "did", "i", "we", "you", "me", "my", "our",
  "to", "for", "of", "in", "on", "at", "and", "or", "but", "if", "it", "this", "that", "with",
  "can", "could", "should", "would", "what", "where", "when", "how", "why", "which", "there",
  "have", "has", "had", "be", "am", "any", "some", "so", "not", "no", "yes", "please", "thanks",
  "trip", "day", "mumbai", "plan", "want", "need", "looking", "find", "show", "give",
]);

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

/** Category words implied by the question itself, e.g. "beach" -> `beach`. */
function impliedCategories(question: string): Set<string> {
  const asked = new Set(words(question));
  const hits = new Set<string>();
  for (const [category, keywords] of Object.entries(CATEGORY_WORDS)) {
    if (keywords.some((keyword) => asked.has(keyword))) hits.add(category);
  }
  return hits;
}

function score(
  experience: Experience,
  questionWords: Set<string>,
  categories: Set<string>,
  neighbourhood: string | undefined,
): number {
  let value = 0;
  for (const word of words(`${experience.name} ${experience.blurb ?? ""}`)) {
    if (questionWords.has(word)) value += 3;
  }
  for (const keyword of experience.keywords) {
    if (questionWords.has(keyword.toLowerCase())) value += 2;
  }
  if (categories.has(experience.category)) value += 4;
  if (neighbourhood && experience.neighbourhood === neighbourhood) value += 5;
  // A well-rated row is a better thing to say something about than a bad one.
  value += experience.rating.value;
  return value;
}

/** One sentence per fact. Never more than one claim, so a reader can check it. */
export function factFor(experience: Experience): string {
  const parts: string[] = [experience.name];
  const where = [experience.neighbourhood, experience.city].filter(Boolean).join(", ");
  if (where) parts.push(`in ${where}`);

  const traits: string[] = [experience.category.replace(/_/g, " ")];
  traits.push(`${experience.durationMin} minutes`);
  traits.push(experience.indoorOutdoor);
  if (experience.weatherSensitive !== "none") traits.push(`weather-sensitive to ${experience.weatherSensitive}`);
  parts.push(`— ${traits.join(", ")}`);

  if (experience.pricePerPerson) {
    parts.push(`${(experience.pricePerPerson.minor / 100).toLocaleString("en-IN")} rupees per person`);
  } else {
    parts.push("price not listed");
  }

  if (experience.hours.status === "ok" && experience.hours.raw) {
    parts.push(`hours: ${experience.hours.raw}`);
  } else if (experience.hours.status === "unparsable") {
    parts.push("opening hours listed but not machine-readable");
  } else {
    parts.push("opening hours not verified");
  }

  const access: string[] = [];
  if (experience.accessibility.stepFree) access.push("step-free");
  if (experience.accessibility.strollerOk) access.push("stroller ok");
  if (experience.accessibility.lowStairs) access.push("low-stairs route");
  if (experience.accessibility.hearingLoop) access.push("hearing loop");
  if (experience.accessibility.restroomOnSite) access.push("restroom on site");
  parts.push(access.length > 0 ? access.join(", ") : "no access features recorded");

  if (experience.booking.required) {
    parts.push(`booking required, about ${experience.booking.leadTimeMin} minutes' notice`);
  }

  return `${parts.join("; ")}.`;
}

/**
 * The facts for one turn.
 *
 * `appContext` is the caller's own state — which neighbourhood they are looking
 * at, how long they have — and it is stated as a fact about the *traveller*,
 * never about a place. That keeps the two kinds of grounding distinguishable, so
 * "you have 90 minutes" can never be quoted back as if it were a property of a
 * stop.
 */
export async function buildGrounding(
  question: string,
  appContext: ChatRequestBody["context"],
): Promise<string[]> {
  const facts: string[] = [];

  if (appContext) {
    const about: string[] = [];
    if (appContext.availableMin !== undefined) {
      about.push(`the traveller currently has ${appContext.availableMin} minutes`);
    }
    if (appContext.budgetMinor !== undefined) {
      about.push(
        `a budget of ${(appContext.budgetMinor / 100).toLocaleString("en-IN")} rupees per person`,
      );
    }
    if (appContext.partyType) about.push(`travelling as ${appContext.partyType.replace(/_/g, " ")}`);
    if (appContext.stopCount !== undefined) {
      about.push(`a current plan with ${appContext.stopCount} stop${appContext.stopCount === 1 ? "" : "s"}`);
    }
    if (appContext.neighbourhood) about.push(`currently looking at ${appContext.neighbourhood}`);
    if (about.length > 0) {
      facts.push(`App state, as passed by the caller: ${about.join("; ")}.`);
    }
  }

  const { experiences } = await loadCatalogue();
  if (experiences.length === 0) return facts;

  const questionWords = new Set(words(question));
  const categories = impliedCategories(question);
  const ranked = experiences
    .map((experience) => ({ experience, value: score(experience, questionWords, categories, appContext?.neighbourhood) }))
    // A score of zero means nothing in the row matched the question at all.
    // Emitting it anyway would hand the model a place the traveller did not ask
    // about, which is the confident-wrong-answer failure this module exists to stop.
    .filter((row) => row.value > 0)
    .sort((a, b) => b.value - a.value)
    .slice(0, MAX_FACTS);

  for (const row of ranked) facts.push(factFor(row.experience));
  return facts;
}
