---
name: candidate-screening
description: Screen job candidates against a role-specific rubric and JD, then produce ranked summaries with scores, hard-gate outcomes, and explicit evidence/inference attribution. Use when reviewing newest applicants from Indeed, re-evaluating a shortlist, or standardizing hiring decisions. For LinkedIn checks, always use browser tooling.
---

# Candidate Screening

Use this skill to run consistent candidate triage and ranking.

## Source of truth policy

Always treat existing role-pack files as canonical.
Do not duplicate or paraphrase full JD/criteria content into new skill files unless explicitly asked.

## Workspace continuation defaults

1. Discover role-pack folders in workspace matching:
   - preferred: `candidate-screening-pack-<YYYY-MM-DD>-<role-slug>/`
   - backward compatible: `candidate-screening-pack-*/`
2. Auto-select the newest pack (prefer latest date in folder name; tie-break by most recently modified).
3. If no pack is found, fallback to:
   - `/home/admin/.openclaw/claw-spaces/Iris/candidate-screening-pack-2026-02-28-ai-transformation-consultant/`
4. Inside the selected pack, load role-specific files.
5. If missing, fetch the JD via `indeed-cli job:get` and rebuild the pack files.

## Required workflow

1. Load active JD + criteria from role pack.
2. Pull target candidates.
   - For Indeed pipelines: `indeed-cli sync:candidates ... --download`
   - Default batch size: **20 candidates** per pass (unless user specifies otherwise).
3. Extract resume text.
   - Use bundled script `scripts/extract_resume_text.sh`.
4. Enrich missing signals.
   - LinkedIn verification must use `browser` tool.
   - Do not treat blocked/unavailable sections as confirmed evidence.
5. Score and rank.
   - Apply hard gates first.
   - Score competencies 1-5 with concise rationale.
   - Sort highest to lowest.
6. Report with provenance and inference labeling.
7. Persist notes for continuity (required).

## Notes + continuity (required)

Store notes inside the selected role-pack under:

- `notes/<YYYY-MM-DD>/batch-<NN>/`

Current example for this role:

- `notes/2026-02-28/batch-01/`

For each batch, create:

1. `batch-summary.md`
   - ranked list, final decisions, key callouts, unresolved questions
2. `candidate-notes.md`
   - one section per candidate with detailed analysis
3. `evidence-log.md`
   - exact source trail per candidate:
     - resume path(s)
     - LinkedIn URL(s) checked via browser
     - any additional web sources used
     - what was inferred vs explicit

Keep these notes concise but decision-grade so future runs can continue without re-reading all raw files.

## Output format (default)

- Role + rubric file paths used
- Ranked list (highest score first)
- Per candidate:
  - Name, score, decision
  - Hard gates (PASS/FAIL/UNCERTAIN)
  - Top strengths
  - Top risks
  - Evidence Source:
    - Resume only
    - Resume + LinkedIn (browser)
    - Resume + other web research
  - Inference Notes:
    - What was inferred
    - What was explicit
- Final recommendation summary

See `references/output-template.md` for exact layout.

## Guardrails

- Never fabricate missing facts.
- If EN/FR or Montreal in-person is not clearly verified, mark `UNCERTAIN`.
- If user gives threshold overrides, apply and restate them.
- LinkedIn evidence should come from browser workflow, not web snippets alone.
