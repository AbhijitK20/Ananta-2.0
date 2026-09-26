# AGENTS.md — instructions for coding agents on Athiti

Read this before changing anything in this repository. It is short on purpose:
the detail already lives in the docs it points to, and duplicating it here would
just create a second thing to keep in sync.

## What this project is

**Athiti** (codename; the product is TravelBuddy) — context-aware local
discovery for time-constrained travellers. A recommendation has to *fit* the
traveller's hours, budget, body and weather, or it is not shown. The thesis is
in `README.md`; the reasoning is in `docs/MASTERPLAN.md`.

The repository is built by three people in three parallel streams. **The only
shared surface is `src/contracts/index.ts`, which is frozen.** Do not redefine a
type locally and do not widen one at a call site. If a field genuinely must
change, it changes in that file, in its own commit, and the other streams rebase.

**Check `TASKS.md` before writing to a path.** It has the file-ownership map. If
a path has an owner and it is not you, do not write there — stub against the
contract and say so. That rule is what makes the parallelism safe.

## Frontend and UI work

**For any frontend, UI, or visual work, read and follow the installed Taste
Skill before implementing or redesigning anything.**

- Skill: `design-taste-frontend`
- Source of truth: `.agents/skills/design-taste-frontend/SKILL.md`

That file is the skill. Do not copy its rules into this file, an issue, a comment,
or a prompt — load it and follow it. It is installed from
`github.com/Leonxlnx/taste-skill` and is pinned by `skills-lock.json`; update it
with `npx skills update design-taste-frontend`, never by hand-editing it.

### How the skill and this project relate

**Athiti's product identity is the source of truth. The skill is a quality
instrument, not an art direction.** It exists to stop generic output, not to
impose a look. Specifically:

- Where the skill and `docs/DESIGN_SYSTEM.md` disagree, **the design system
  wins.** It is this project's decided position, with the reasoning recorded, and
  it is enforced by `npm run theme:lint`.
- Where the skill and the frozen contract disagree, the **contract** wins.
- Do not import a house style from the skill because it is fashionable there.
  Athiti is a warm, human, local-companion product: premium but never clinical,
  cinematic where it earns it and quiet everywhere else.

**Know the skill's own scope limit.** It states, in its own first lines, that it
covers *"landing pages, portfolios, and redesigns. Not dashboards, not data
tables, not multi-step product UI."* Athiti **is** multi-step product UI — a
context editor, a result surface, a plan timeline, a replanner, a provider side.
So:

- Take from it the transferable parts: typography, spacing, motion restraint,
  hierarchy, anti-slop patterns, accessibility.
- Do not take its page-shaped assumptions. It will tell you a serif is wrong for
  dashboards and that filled progress tracks are clutter; Athiti's feasibility
  meter is a filled segmented track, and it is the one place the design system
  deliberately spends boldness. That is a considered decision, not a mistake to
  correct.
- On a redesign, read the existing tokens and components first. The goal is
  refinement, not replacement.

## Agent capability rules

Three agent capabilities are installed. Each has a job; none of them is allowed
to overrule the project.

### Ponytail — build the simplest correct thing

`/ponytail` (levels: `lite`, `full`, `ultra`, `off`; default `full`).
Commands: `/ponytail-review`, `/ponytail-audit`, `/ponytail-debt`,
`/ponytail-gain`, `/ponytail-help`.

Use it to avoid unnecessary implementation complexity and dependency growth:
reuse what exists, prefer platform and native capabilities, do not abstract
prematurely, do not add a dependency when the platform already does the job.

**This is not permission to remove:** security, validation, error handling,
tests, accessibility, observability, correctness, or architecture the project
actually needs. Athiti is a sophisticated product and still needs good
architecture — the target is *less accidental* complexity, never less rigour.
Never use it to delete a passing test, skip a gate, or drop an error path.

Leave the level at `full` unless a human asks otherwise. `ultra` is not the
default and should not become the default for this project.

### AgentMemory — durable project context

17 skills, an MCP server, and a capture plugin are installed. The server is a
separate process: if memory tools are unavailable, start it with
`npx @agentmemory/agentmemory` (REST on `:3111`).

Use it for context that should survive the session: architectural decisions,
implementation discoveries, recurring bugs, established conventions,
project-level lessons, handoff state. Before re-deriving something, recall it
first.

**Never store secrets** — no API keys, passwords, tokens, or private
credentials — and no unnecessary personal information. The traveller-facing
data in this product is PII-adjacent; record *that* a constraint exists, not the
data.

### HyperFrames — video and motion generation

`/hyperframes` is a router: read it first for any request to make, edit, animate
or render a video, motion graphic, animated explainer, product demo, or
cinematic visual composition. It installs the specific workflow on demand.

Use it when the task genuinely involves video or motion generation. **Do not
reach for it for ordinary application UI** — Athiti's interface is built in
React and CSS against the design system, and a motion-design skill is the wrong
tool for a settings page.

### How the three combine

| Task | Reach for |
|---|---|
| Ordinary application development | Athiti architecture + Ponytail — build the simplest correct implementation |
| Recalling or recording project context | AgentMemory |
| Video, motion, cinematic generation | `/hyperframes` |
| Frontend and UI work | Taste Skill + Ponytail + `docs/DESIGN_SYSTEM.md` |

The Taste Skill handles visual quality, Ponytail prevents unnecessary
complexity, and the design system remains authoritative for brand identity. No
skill may blindly override another.

### If instructions conflict

In priority order: **security and correctness → Athiti requirements → existing
architecture → the explicit user request → a specialised skill → general coding
defaults.**

No skill may expose secrets, weaken authentication, bypass authorisation,
remove tests to make CI green, disable a gate, add an arbitrary dependency, or
rewrite working architecture without justification.

## Before you commit

The gates are executable and they are not ceremony — two of them found real
defects in this project's own design system.

```bash
npm run typecheck      # tsc --noEmit
npm run lint           # ESLint
npm test               # vitest
npm run theme:lint     # no colour literal outside src/styles/tokens.css
npm run copy:lint      # no emoji, banned filler, or colon reveals
npm run contrast:lint  # every token pair, both themes, WCAG AA
npm run build
```

A gate that fails is information. Do not silence it, widen a rule, or add an
exception to make it green — fix the cause, or say plainly in the PR why the
gate is wrong. Every lint in this repo was verified against a planted
violation, so a green run means something.

## Honesty about state

This repository is assembled in parallel by three people, and **parts of it do
not exist yet.** Do not write copy, documentation, or a PR description that
implies a capability is implemented when it is stubbed or fixture-backed. The UI
currently runs on fixtures and says so in the `x-engine` response header and in
a visible badge; that honesty is deliberate and is the pattern to follow.

If you are unsure whether something is real, check. Do not assume.

## Useful paths

| Path | What it is |
|---|---|
| `src/contracts/index.ts` | **Frozen.** Every type and zod schema |
| `TASKS.md` | File ownership, and the day-by-day |
| `docs/DESIGN_SYSTEM.md` | Tokens, components, copy, accessibility. The decided position |
| `docs/MASTERPLAN.md` | The whole thing, decisions locked |
| `docs/DECISIONS.md` | Contested questions, resolved, with evidence |
| `docs/PRESENTATION.md` | Internal round prep — pitch, Q&A, phrases to avoid |
| `research/findings/` | ~15k lines of evidence-graded research across 71 pinned repos. `research/README.md` records 27 claims from reference repos that did not survive checking |
| `src/styles/tokens.css` | The only place a colour may be written |
