---
name: sedarplus-results-brief
description: Build a Canadian public-company results brief anchored on SEDAR+ filings, then layer external reporting and produce executive outputs (deck, comparison memo, and draft email). Use when asked to review issuer disclosure (Annual Report, AIF, news releases, annual/quarterly filings), especially for TSX issuers and late-quarter or year-end results packages.
---

# SEDAR+ Results Brief

## Overview

Use this workflow to produce a decision-ready results brief with filing-level evidence first, then outside commentary.

Priority order for facts:

1. SEDAR+ filing rows and documents
2. Issuer-hosted IR copies that match filing titles/dates
3. External reporting/commentary

## Workflow

## 1) Define scope

Capture upfront:

- Issuer legal name (and likely bilingual variant)
- Time window (example: late-Q4 + annual package)
- Required document classes (Annual report, AIF, news releases, annual MD&A, annual FS)

## 2) Collect official filing evidence in SEDAR+

In SEDAR+ Search:

- Use **Documents** tab
- Set **Filing category** to `Continuous disclosure`
- Set date range for the requested window
- Confirm correct issuer profile (record profile number)
- Review both page 1 and page 2 of results when present

Record for each relevant row:

- Document title
- Submission date/time
- Language/version
- Issuer profile number

Also keep quick run notes:

- Pages visited
- Buttons/filters clicked
- Any UI quirks or blockers

## 3) Handle document extraction reliably

SEDAR+ resource links can be session-sensitive.

If direct downloads fail:

- Keep SEDAR+ as filing authority for title/date/document class
- Pull stable issuer IR-hosted copies of the same documents
- Verify mirror docs match filing set by title/date/context

Extract key facts from official docs:

- Net income, adjusted net income, EPS (reported/adjusted)
- Capital metrics (for banks: CET1, leverage where relevant)
- Dividend changes
- Segment performance cues
- Management forward-looking integration/synergy statements (if present)

## 4) Gather latest external reporting

Use web search and fetch to gather commentary with:

- Source name
- Publication date
- Link
- 1-line angle (what they emphasize)

Prefer a balanced mix:

- Financial media/interview coverage
- Syndicated press wire coverage
- Optional transcript/summary source if accessible

If paywall/anti-bot blocks full text:

- Keep source/date from index snippet
- Mark confidence and limitations clearly

## 5) Compare local vs official vs external

Create a comparison section with three buckets:

- Local workspace/company files
- Official filing package
- External reporting

State clearly:

- Which bucket is source-of-truth for facts
- Whether external commentary is consistent with filing headlines
- Any mismatches or uncertainty

## 6) Produce outputs

Default output set:

1. Executive summary slide deck (brand-inspired colors)
2. Comparison memo (`local vs official vs web`)
3. Polished team email draft
4. Reusable workflow notes (click path + rerun checklist)

## Output quality bar

- Include dates and sources for every non-trivial claim
- Separate facts from interpretation
- Flag extraction gaps and blocked pages
- Keep recommendations short and actionable

## Reusable templates

For reusable structure and prompt snippets, read:

- `references/templates.md`
