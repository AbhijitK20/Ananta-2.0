/**
 * Score the assistant on the held-out test split.
 *
 * ```
 * npm run assistant:eval                       # offline path only, no key needed
 * NUGEN_API_KEY=... npm run assistant:eval     # base model and/or customized model
 * npm run assistant:eval -- --models base,customized --tag my-note
 * ```
 *
 * The number this produces is the one thing in the whole feature that cannot be
 * faked, so the rules about it are strict:
 *
 *   - **Only the test split is scored.** `validation.jsonl` is attached to the
 *     Nugen run as a benchmark, so anything it contains has been seen by the
 *     training loop. Scoring it would be measuring training data.
 *   - **A model that cannot be reached is recorded as UNAVAILABLE, never as a
 *     zero.** A 0% hallucination rate for a model that returned 502 for every
 *     prompt is a lie that a reader cannot detect, and this file exists to be
 *     the thing that cannot lie.
 *   - **No number is printed that was not computed here.** Every metric in the
 *     report is produced by `score()` in this file, from a response this file
 *     received.
 *
 * ## What is actually measured
 *
 * These are heuristics, and they are labelled as heuristics. There is no judge
 * model and no human rubric in the loop, because both were unavailable and a
 * number from a rubric nobody wrote down is worse than no number. What each one
 * really detects is stated next to it.
 *
 *   refusal-correct   the reply redirects rather than complying. Detects an
 *                     out-of-scope answer to a medical/visa question.
 *   no-fabrication    the reply asserts no price or clock time when the example
 *                     supplied no grounding. Detects the failure that matters.
 *   domain-terms      the app's own vocabulary appears for app questions.
 *   format            a reply is neither empty nor a refusal loop.
 *   latency           wall clock, which is the number a traveller feels.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

import { DeterministicProvider } from "../src/features/assistant/provider/deterministic";
import { NugenProvider } from "../src/features/assistant/provider/nugen";
import { assistantNugenConfig } from "../src/features/assistant/provider/config";
import { assembleContext } from "../src/features/assistant/orchestration/context";
import { groundingBlock, SYSTEM_PROMPT } from "../src/features/assistant/prompt";
import { APP_TOPICS, OUT_OF_SCOPE } from "../src/features/assistant/knowledge";
import { MAX_TOKENS } from "../src/features/assistant/orchestration/chat";
import type { ProviderMessage } from "../src/features/assistant/provider";

const TEST_SET = "data/ai_assistant/test.jsonl";
const REPORTS = "data/ai_assistant/reports";

type Example = {
  id: string;
  instruction: string;
  context?: { role: "user" | "assistant"; content: string }[];
  grounding?: string[];
  response: string;
  tags: string[];
};

const argv = process.argv.slice(2);
const option = (name: string, dflt: string): string => {
  const at = argv.findIndex((arg) => arg.replace(/^-+/, "") === name);
  const raw = at >= 0 ? argv[at + 1] : undefined;
  return raw !== undefined && !String(raw).startsWith("--") ? String(raw) : dflt;
};

type Arm = "offline" | "base" | "customized";

type Result = {
  id: string;
  tags: string[];
  expected: string;
  actual: string;
  latencyMs: number;
  scores: Record<string, boolean>;
  model: string;
  note: string;
};

/**
 * The app's own vocabulary.
 *
 * A reply that describes a real feature using an invented synonym is the failure
 * this detects, so the list has to span both halves of the app's language: the
 * traveller-facing terms (a time budget, a fit meter) and the operator-facing ones
 * (a listing, unmet demand, unverified hours). Scoping it to the traveller half
 * only would fail every provider and analytics answer for using the wrong half,
 * which measures nothing.
 */
const DOMAIN_TERMS = [
  // traveller-facing
  "time budget",
  "fit meter",
  "unmet need",
  "rejection",
  "step-free",
  "stroller",
  "hearing loop",
  "monsoon",
  "itinerary",
  "plan",
  "stop",
  "catalogue",
  "unverified",
  // operator-facing
  "provider",
  "listing",
  "requests",
  "demand",
  "availability",
];

/** The price/clock-time pattern, the same one `ungroundedClaim` uses. */
const CLAIM = /(?:\b\d{1,3}(?:,\d{3})*\s*(?:rupees|rs\.?)\b)|(?:\b\d{1,2}[:.]\d{2}\s*(?:am|pm)?\b)/i;

/** "I can't help with that" with nothing useful attached. */
const BARE_REFUSAL =
  /^(i (?:can'?t|cannot|am unable to|won'?t)|i'?m (?:sorry|not able)|unfortunately,? i)/i;

function score(example: Example, actual: string): Record<string, boolean> {
  const tags = example.tags;
  const out: Record<string, boolean> = {};

  // Non-empty, and not a refusal with nothing after it.
  out.format = actual.trim().length > 0 && !BARE_REFUSAL.test(actual.trim());

  // For an out-of-scope example: the reply must NOT contain a confident answer,
  // and must point somewhere useful. A reply that both redirects and answers is
  // not penalised — a two-line redirect plus an offer is the target behaviour.
  if (tags.includes("out-of-scope") || tags.includes("refusal")) {
    const redirected =
      /rather|instead|not the right|outside|will not|not going to|cannot|official source|doctor|pharmacy|book it directly|not transact/i.test(
        actual,
      );
    out.refusalCorrect = redirected;
  }

  // For an example that supplied no facts: no invented price or clock time.
  if (tags.includes("ungrounded") || (example.grounding ?? []).length === 0) {
    out.noFabrication = !CLAIM.test(actual);
  }

  // For app questions: the app's own words, not invented synonyms.
  if (tags.includes("app-howto") || tags.includes("terminology")) {
    out.domainTerms = DOMAIN_TERMS.some((term) => actual.toLowerCase().includes(term));
  }

  return out;
}

function aggregate(results: Result[]): Record<string, { passed: number; total: number; rate: number }> {
  const keys = new Set(results.flatMap((result) => Object.keys(result.scores)));
  const out: Record<string, { passed: number; total: number; rate: number }> = {};
  for (const key of keys) {
    const applicable = results.filter((result) => key in result.scores);
    const passed = applicable.filter((result) => result.scores[key]).length;
    out[key] = {
      passed,
      total: applicable.length,
      rate: applicable.length === 0 ? 0 : Number((passed / applicable.length).toFixed(3)),
    };
  }
  return out;
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : Number((values.reduce((sum, v) => sum + v, 0) / values.length).toFixed(0));
}

type ArmReport = {
  arm: Arm;
  model: string | null;
  available: boolean;
  /** Empty when available. The honest reason when not. */
  unavailableReason: string;
  examples: number;
  metrics: Record<string, { passed: number; total: number; rate: number }>;
  latencyMsMean: number;
  latencyMsP95: number;
  results: Result[];
};

async function runArm(arm: Arm, examples: Example[]): Promise<ArmReport> {
  const unavailable = (reason: string, model: string | null = null): ArmReport => ({
    arm,
    model,
    available: false,
    unavailableReason: reason,
    examples: examples.length,
    metrics: {},
    latencyMsMean: 0,
    latencyMsP95: 0,
    results: [],
  });

  const config = await assistantNugenConfig();

  let provider: NugenProvider | DeterministicProvider;
  let model: string | null;

  if (arm === "offline") {
    provider = new DeterministicProvider();
    model = null;
  } else {
    if (!config.enabled) return unavailable("NUGEN_API_KEY is not set");
    if (arm === "customized" && !config.modelId) {
      return unavailable("no customized model; run `npm run assistant:align`");
    }
    if (arm === "base" && !config.baseModelId || config.baseModelId === "unknown") {
      return unavailable("no base model recorded; set NUGEN_BASE_MODEL");
    }
    // For the baseline arm the base model is sent deliberately. It is never what
    // the app uses at runtime — `provider/config.ts` has no base-model fallback —
    // and this is the comparison that makes the customization claim measurable.
    const override = arm === "base" ? { ...config, modelId: config.baseModelId } : config;
    provider = new NugenProvider(override);
    model = arm === "base" ? config.baseModelId : config.modelId;
  }

  const probe = await provider.healthCheck();
  if (!probe.ok) return unavailable(probe.detail, model);

  const results: Result[] = [];
  for (const example of examples) {
    // The same assembly the route uses, so the eval measures the shipped prompt
    // and context rules rather than a cleaner paraphrase of them.
    const history = (example.context ?? []).map(
      (turn): ProviderMessage => ({ role: turn.role, content: turn.content }),
    );
    const context = assembleContext({
      history: history.map((turn, index) => ({
        id: `${example.id}-${index}`,
        conversationId: example.id,
        role: turn.role,
        content: turn.content,
        status: "complete" as const,
        createdAt: new Date(0).toISOString(),
        modelId: null,
        tokenUsage: null,
        latencyMs: null,
        metadata: {},
      })),
      message: example.instruction,
      facts: example.grounding ?? [],
    });
    // The eval passes the system prompt through assembleContext; the grounding
    // block it builds is what both providers actually read.
    void SYSTEM_PROMPT;
    void groundingBlock;

    const started = Date.now();
    let actual = "";
    let note = "";
    try {
      const result = await provider.generate({
        messages: context.messages,
        maxTokens: MAX_TOKENS,
        temperature: 0.3,
      });
      actual = result.text;
      if (result.finishReason === "error") note = "provider returned no completion";
    } catch (error) {
      note = error instanceof Error ? error.message : String(error);
    }
    const latencyMs = Date.now() - started;

    results.push({
      id: example.id,
      tags: example.tags,
      expected: example.response,
      actual,
      latencyMs,
      scores: actual.length > 0 ? score(example, actual) : { format: false },
      model: model ?? arm,
      note,
    });
  }

  const latencies = results.map((result) => result.latencyMs).sort((a, b) => a - b);
  return {
    arm,
    model,
    available: true,
    unavailableReason: "",
    examples: examples.length,
    metrics: aggregate(results),
    latencyMsMean: mean(latencies),
    latencyMsP95: latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0,
    results,
  };
}

function render(reports: ArmReport[]): string {
  const lines: string[] = [];
  lines.push("# Assistant evaluation");
  lines.push("");
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Test set: \`${TEST_SET}\` (held out; never uploaded to Nugen)`);
  if (option("tag", "") !== "") lines.push(`Note: ${option("tag", "")}`);
  lines.push("");

  for (const report of reports) {
    lines.push(`## ${report.arm}`);
    lines.push("");
    if (!report.available) {
      // Stated as UNAVAILABLE, never as a zero. This is the whole point of the
      // file: a number that was not measured must not look like a number that was.
      lines.push(`**UNAVAILABLE** — ${report.unavailableReason}`);
      lines.push("");
      lines.push("No metrics are reported for this arm. A zero here would be a fabricated result.");
      lines.push("");
      continue;
    }
    lines.push(`Model: \`${report.model ?? "none"}\` · examples: ${report.examples}`);
    lines.push("");
    lines.push("| metric | passed | applicable | rate |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const [key, value] of Object.entries(report.metrics).sort()) {
      lines.push(`| ${key} | ${value.passed} | ${value.total} | ${(value.rate * 100).toFixed(1)}% |`);
    }
    lines.push("");
    lines.push(`Latency: mean ${report.latencyMsMean} ms, p95 ${report.latencyMsP95} ms`);
    lines.push("");

    const failures = report.results.filter((result) =>
      Object.values(result.scores).some((value) => !value),
    );
    lines.push(`### Where it disagreed with the dataset (${failures.length} of ${report.examples})`);
    lines.push("");
    for (const failure of failures.slice(0, 12)) {
      lines.push(`#### ${failure.id}  \`${failure.tags.join(" ")}\``);
      lines.push("");
      lines.push(`**Asked:** ${failure.expected.split("\n")[0]}`);
      lines.push("");
      lines.push("**Said:**");
      lines.push("");
      lines.push("```");
      lines.push(failure.actual.slice(0, 600) || "(nothing)");
      lines.push("```");
      lines.push("");
      lines.push(`Failed: ${Object.entries(failure.scores).filter(([, v]) => !v).map(([k]) => k).join(", ") || "none"}`);
      if (failure.note) lines.push(`Note: ${failure.note}`);
      lines.push("");
    }
    if (failures.length > 12) lines.push(`… and ${failures.length - 12} more. Full detail is in the JSON beside this file.`);
    lines.push("");
  }

  const compared = reports.filter((report) => report.available && report.arm !== "offline");
  const baseline = compared.find((report) => report.arm === "base");
  const customized = compared.find((report) => report.arm === "customized");
  if (baseline && customized) {
    lines.push("## Base vs customized");
    lines.push("");
    lines.push("| metric | base | customized | change |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const key of new Set([...Object.keys(baseline.metrics), ...Object.keys(customized.metrics)])) {
      const before = baseline.metrics[key]?.rate;
      const after = customized.metrics[key]?.rate;
      if (before === undefined || after === undefined) continue;
      const delta = after - before;
      lines.push(
        `| ${key} | ${(before * 100).toFixed(1)}% | ${(after * 100).toFixed(1)}% | ${delta > 0 ? "+" : ""}${(delta * 100).toFixed(1)} pts |`,
      );
    }
    lines.push("");
    const latencyDelta = customized.latencyMsMean - baseline.latencyMsMean;
    lines.push(
      `Mean latency: ${baseline.latencyMsMean} ms -> ${customized.latencyMsMean} ms (${latencyDelta > 0 ? "+" : ""}${latencyDelta} ms).`,
    );
    lines.push("");
  } else if (compared.length < 2) {
    lines.push("## Base vs customized");
    lines.push("");
    lines.push(
      "Not comparable: both arms were not available in the same run. " +
        "A one-armed comparison is not a comparison, so no delta is printed.",
    );
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

async function main(): Promise<void> {
  const raw = await readFile(TEST_SET, "utf8").catch(() => "");
  const examples = raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Example);
  if (examples.length === 0) {
    process.stderr.write(`\nassistant-eval: ${TEST_SET} is empty. Run \`npm run assistant:dataset\`.\n\n`);
    process.exit(1);
  }
  process.stdout.write(`\nscoring ${examples.length} held-out examples\n`);
  process.stdout.write(`topics in the knowledge table: ${APP_TOPICS.length}, refusal rules: ${OUT_OF_SCOPE.length}\n\n`);

  const requested = option("models", "offline")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean) as Arm[];

  const reports: ArmReport[] = [];
  for (const arm of requested.length > 0 ? requested : (["offline"] as Arm[])) {
    process.stdout.write(`  ${arm}… `);
    const report = await runArm(arm, examples);
    reports.push(report);
    process.stdout.write(
      report.available
        ? `ok (${report.latencyMsMean} ms mean)\n`
        : `UNAVAILABLE — ${report.unavailableReason}\n`,
    );
  }

  await mkdir(REPORTS, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const markdown = render(reports);
  await writeFile(join(REPORTS, `eval-${stamp}.md`), markdown, "utf8");
  await writeFile(join(REPORTS, `eval-${stamp}.json`), `${JSON.stringify(reports, null, 2)}\n`, "utf8");
  await writeFile(join(REPORTS, "latest.md"), markdown, "utf8");
  await writeFile(join(REPORTS, "latest.json"), `${JSON.stringify(reports, null, 2)}\n`, "utf8");

  process.stdout.write(`\n${markdown}\n`);
  process.stdout.write(`Reports: ${REPORTS}/latest.md and latest.json\n\n`);
}

void main().catch((error: unknown) => {
  process.stderr.write(`\nassistant-eval: ${error instanceof Error ? error.message : String(error)}\n\n`);
  process.exit(1);
});
