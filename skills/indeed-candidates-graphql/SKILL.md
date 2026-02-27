---
name: indeed-candidates-graphql
description: Query Indeed employer candidates via direct GraphQL and optional CLI wrappers. Use when an agent needs exact candidate counts by status (new/reviewing/rejected/shortlist/undecided), candidate metadata search, resume/cover-letter attachment URLs, or file downloads from the employer candidate pipeline.
---

# Indeed Candidates GraphQL

Use this skill for Indeed employer candidate data work.

## Core approach

Prefer this order:

1. Direct GraphQL for exact counts, custom filters, and flexible automation.
2. `indeed-cli` for quick operator tasks (`search:candidates`, `sync:candidates`).

This keeps the system flexible for scripts while still giving easy CLI operations.

## Required inputs

- GraphQL endpoint
- API key (`indeed-api-key`)
- Employer key (`indeed-employer-key`)
- CTK token (`indeed-ctk`, recommended)
- Cookie file (JSON cookie export)

Environment variables are supported by scripts:

- `INDEED_GRAPHQL_ENDPOINT`
- `INDEED_API_KEY`
- `INDEED_EMPLOYER_KEY`
- `INDEED_CTK`
- `INDEED_COOKIE_FILE`

## Scripts

### 1) Exact count by status

Use:

```bash
node scripts/candidate-count.mjs --status new --json
```

Other statuses:

- `new`
- `reviewing`
- `all`
- `shortlist`
- `undecided`
- `rejected`

### 2) Update candidate status (shortlist/undecided/rejected)

Use:

```bash
node scripts/update-candidate-status.mjs \
  --status shortlist \
  --candidate-submission-id <iri_candidate_submission_id> \
  --dry-run
```

For rejected, add `--job-id <iri_employer_job_id>`.

### 3) Arbitrary GraphQL request

Use:

```bash
node scripts/graphql-request.mjs \
  --operation-name CandidateListTotalCount \
  --query-file /path/to/query.graphql \
  --variables-file /path/to/vars.json
```

Use this when you need custom filters or operations not covered by the CLI.

## CLI wrappers (optional)

If `indeed-cli` is installed:

- Metadata-only search:

```bash
indeed-cli search:candidates --status new --query "kevin"
```

- Sync with files (explicit):

```bash
indeed-cli sync:candidates --status reviewing --download
```

- Metadata-only sync:

```bash
indeed-cli sync:candidates --status shortlist --no-download
```

## Safety defaults

- Prefer metadata-only operations first.
- Download files only when requested.
- Use temporary output roots with TTL cleanup for downloaded files.

## References

- GraphQL operations and endpoint details: `references/graphql-operations.md`
- Status filter mapping (UI parity): `references/status-mapping.md`
- How to add/extend features (recon + inferred methods): `references/feature-extension-playbook.md`
