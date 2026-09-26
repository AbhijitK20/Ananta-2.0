# content/eval — pointer only

The eval scenarios are **not** in this directory. They are one directory up:

```
content/evaluation/scenarios.jsonl
```

`docs/EVAL_SPEC.md` §3 specifies `content/eval/scenarios.jsonl`. The session
ownership map allowed `content/evaluation/`, so that is where they were written
and this file exists so a lookup in the old place finds an explanation instead of
a missing directory.

**There is no `scripts/eval.ts`, and there is not going to be one until there is
an engine to measure.** The harness calls `EnginePort`; `src/engine/` is empty on
this branch. Writing a runner against the reference engine in
`src/features/discovery/__tests__/` would put fixture numbers into
`docs/EVAL_RESULTS.md`, and that file is defined as the only place a *measured*
result belongs. A table nobody can re-derive is worse than no table, so the run
command is absent rather than broken. `docs/EVAL_SPEC.md` §10 is the line to say
in a presentation until it exists.

The line shape is unchanged from EVAL_SPEC §3, plus two optional additions:

- `notes` — free text explaining what the scenario is really testing and which
  part of it is expected to be weak.
- `replan.expectKeptIntentTerms` — terms that must survive a replan, which is
  what makes `preservedIntent: true` mean something rather than just being a
  boolean the replanner sets to itself.

Run the content check with `npm run content:validate` from the repo root; it
validates the scenarios, including that every `forbiddenBecause` code is a real
`RejectionCode` and that `context.original` agrees with `context`.
