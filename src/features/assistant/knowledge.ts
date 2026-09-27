/**
 * What the assistant knows about TravelBuddy itself.
 *
 * One table, read by two callers: the deterministic provider (to answer app
 * questions offline) and `scripts/assistant-dataset.ts` (to build the
 * customization dataset). Sharing it is the point — a dataset written from a
 * different description of the app than the runtime enforces is a dataset that
 * teaches the model to be wrong about the product.
 *
 * Every `answer` here is checked against the app's own contracts and pages. Where
 * the app has no capability, the answer says so; that is the behaviour the
 * dataset is trying to teach, so it cannot be an embellishment.
 */
import { PROMPT_VERSION } from "./prompt";

export type AppTopic = {
  /** Stable slug, also the dataset tag. */
  id: string;
  /** Lowercase keywords matched against the traveller's question. */
  match: readonly string[];
  /** One-line topic name for the UI's suggestion chips. */
  label: string;
  answer: string;
};

export const APP_TOPICS: readonly AppTopic[] = [
  {
    id: "fit-meter",
    label: "What the fit meter means",
    match: ["fit", "fit meter", "fit score", "how good is the match", "suitability"],
    answer:
      "The fit meter is the score for a single stop, and it is only ever shown next to the reason it has that score. It combines how well the stop fits your time budget, your budget, your access needs, the weather and your distance from where you are now. A high score with a weak reason is not a good recommendation, so the app shows the breakdown and not just the number. Nothing is shown at all if it does not fit, which is why you may see fewer options than you expected.",
  },
  {
    id: "time-budget",
    label: "Time budgets",
    match: ["time budget", "how long", "available time", "minutes", "hours do i have", "fit my time"],
    answer:
      "A time budget is how long you actually have, including travel between stops. The app packs a plan against it rather than against a wish list, and every stop carries its own typical duration. If you tell the assistant you have lost an hour, it shortens the budget and the plan re-solves; it does not drop a stop silently. The subtraction and the assignment are different operations, which is why \"we have 90 minutes\" and \"we lost 90 minutes\" produce different plans.",
  },
  {
    id: "rejections",
    label: "Why something was rejected",
    match: ["rejected", "rejection", "why was it left out", "why nothing", "dismissed", "not shown"],
    answer:
      "A stop is dropped for a named reason, never quietly. The reasons are: too far, travel time over budget, duration over budget, closed now, closed during the visit window, opening hours unverified, over budget, over budget per person, capacity exceeded, not step free, not stroller safe, no low-stairs route, no hearing loop, no restroom, diet mismatch, sold out, booking required but unavailable, lead time too short, weather unsafe, or a duplicate. Most rejections are relaxable, and the app will tell you which constraint to relax to get the stop back.",
  },
  {
    id: "unmet-needs",
    label: "Unmet needs",
    match: ["unmet", "unmet need", "nothing matched", "accessibility need", "wheelchair", "stroller", "hearing loop", "restroom"],
    answer:
      "An unmet need is a requirement you stated that no stop in the plan satisfies. The app reports it rather than relaxing it, because a plan that quietly drops a step-free requirement is worse than no plan. Access needs the app understands are wheelchair access, stroller access, a low-stairs route, a hearing loop and a restroom on site. Where a field is unknown it is reported as unknown, never as a yes, so it will not recommend a place as accessible on the strength of missing data.",
  },
  {
    id: "weather",
    label: "Weather",
    match: ["weather", "rain", "monsoon", "hot", "heat", "wind", "storm", "umbrella"],
    answer:
      "Weather is treated as a constraint, not a suggestion. Each stop declares how sensitive it is to rain, heat, wind or any of them, and outdoor stops in heavy rain are dropped for weather safety rather than suggested with a caveat. Mumbai's monsoon is roughly June to September, and the season changes which months a stop is worth going to. The app uses a real forecast when it can reach one and says which it used, so you can tell a live reading from a simulated one.",
  },
  {
    id: "digital-twin",
    label: "The digital twin",
    match: ["twin", "digital twin", "what if", "scenario", "propagate", "cascade"],
    answer:
      "The digital twin is a what-if layer over the plan. You change a condition, such as flooding at one place or a closure upstream, and it propagates the consequence through connected places and re-solves the plan. It is built on a graph of dependencies, so a change at one node reaches the nodes that depend on it and stops where there is no path. The twin is not a forecast and it does not invent new places; it only re-evaluates the ones already in your plan.",
  },
  {
    id: "why-ledger",
    label: "Why this was recommended",
    match: ["why", "why this", "why was this recommended", "reason", "explain", "ledger", "evidence"],
    answer:
      "Every recommendation carries a ledger of the facts behind it, and the app can show you that ledger. It records the source of each attribute, so you can see whether a duration was curated, came from OpenStreetMap, was inferred, or came from a provider. That distinction matters more than it sounds: an inferred duration is an estimate, and the app labels it as one rather than presenting it as measured.",
  },
  {
    id: "search",
    label: "Finding things",
    match: ["search", "find", "looking for", "show me", "suggest"],
    answer:
      "Discovery works as a fit search rather than a keyword search. You say what you have, who it is for and what you want to avoid, and the app ranks candidates against those constraints and shows the reasons. Keyword search is still there, but it is a filter over the catalogue rather than the ranking, so a well-fitting stop beats a better-matching word.",
  },
  {
    id: "provider",
    label: "Offering a place",
    match: ["i offer", "i run", "list my", "my place", "provider", "host", "accept requests"],
    answer:
      "If you run a place, the provider surface is where you list it, set your availability and answer traveller requests. Listing a place does not put it in search by itself; it has to pass the same fit checks any other stop passes, so a listing with unverified hours is deprioritised rather than hidden. Requests arrive with the traveller's constraints, so you can see whether you actually fit before you answer.",
  },
  {
    id: "analytics",
    label: "What travellers wanted",
    match: ["analytics", "demand", "what did travellers want", "opportunit", "supply"],
    answer:
      "The analytics surface reads the gaps between what travellers asked for and what the catalogue could offer, which is the part of the product most people never see. It groups unmet demand by constraint, such as step-free access or a low-stairs route, and shows which of those gaps a new listing would close. It is for deciding what to open, not for planning a trip.",
  },
  {
    id: "voice",
    label: "Talking to the app",
    match: ["voice", "speak", "talk", "microphone", "dictate", "hands free"],
    answer:
      "The assistant listens through your browser's own speech recognition, so voice works with no account and no audio leaving your device for transcription. Say what you want, and the transcript is treated exactly as typed text, including the stop button if you want to interrupt. Voice needs microphone permission; if you decline it, everything still works by typing.",
  },
  {
    id: "limits",
    label: "What the app cannot do",
    match: ["can you book", "book a table", "reserve", "payment", "pay", "flight", "visa", "passport", "visa advice", "ticket", "uber", "cab"],
    answer:
      "It cannot. The app plans and ranks; it does not book, hold a table, take a payment, or reach any airline, rail or immigration system. If you need a table held or a ticket bought, do that directly. Visa, passport and immigration questions need an official source, not a travel app.",
  },
];

/** Topics the assistant redirects rather than answers. Matched before `APP_TOPICS`. */
export const OUT_OF_SCOPE: readonly { id: string; match: RegExp; redirect: string }[] = [
  {
    id: "medical",
    match: /\b(diarr?hea|food poisoning|fever|dengue|typhoid|malaria|injury|fell down|bleeding|allergic reaction|chest pain)\b/i,
    redirect:
      "That is a medical question and I am not the right place for it — please see a doctor or a pharmacy. I can still help with the rest of your day: what is near you, and what fits the time you have left.",
  },
  {
    id: "legal-visa",
    match: /\b(visa|passport|immigration|work permit|taxi permit|police|fine|eviction|legal advice)\b/i,
    redirect:
      "Visa, passport and legal questions need an official source rather than a travel app, so I will not guess at them. I can help with everything inside the app: fitting a plan to your hours, or finding a stop that suits who you are travelling with.",
  },
  {
    id: "money-transaction",
    match: /\b(book (a|the) (table|flight|ticket|cab)|buy a ticket|make a payment|pay for|transfer money|atm|exchange rate for a transaction)\b/i,
    redirect:
      "I cannot book anything or move money — the app plans, it does not transact. Book or pay directly, and tell me the constraints and I will help you fit the rest of the day around it.",
  },
  {
    id: "unrelated",
    match: /\b(write (me )?(an? )?(essay|poem|email|resume)|debug this|summarise this pdf|stock price|bitcoin|who should i vote|crypto)\b/i,
    redirect:
      "That is outside what I do — I help with planning time in Mumbai and with how this app works. If you have a trip question, I am ready.",
  },
];

export const ASSISTANT_PROMPT_VERSION = PROMPT_VERSION;
