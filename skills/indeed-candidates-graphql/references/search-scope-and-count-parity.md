# Search Scope + Count Parity

Use this reference to avoid the classic mismatch where search results show fewer candidates than UI count.

## Why mismatches happen

Two common scopes exist:

1. **configured-jobs scope**

- Filter uses `jobs.employerJobIds` from config.
- Limited to listed jobs.

2. **all-jobs (UI-style) scope**

- Filter uses `jobs.hostedJobPostStatuses=["ACTIVE","PAUSED"]`.
- Includes all active/paused jobs in account.

If UI count is in the 50s but search returns 40s, search is usually running configured-jobs scope.

## Recommended defaults

- For operator search parity with UI, use: `--scope all-jobs`
- For job-specific workflows, use: `--scope configured-jobs`

## CLI examples

```bash
# UI-parity search (recommended default)
indeed-cli search:candidates --status new --scope all-jobs

# Job-specific search (config sync.employerJobIds)
indeed-cli search:candidates --status new --scope configured-jobs
```

## Exact count command pattern

For exact count parity, use `CandidateListTotalCount` with the same filter scope.

UI-style new count filter:

- `submissionType=LEGACY`
- `jobs.hostedJobPostStatuses=["ACTIVE","PAUSED"]`
- `hiringMilestones=["NEW","PENDING"]`
- `created.createdAfter=1708992000000`

## Troubleshooting checklist

- Confirm cookie freshness (expired cookies can silently reduce results).
- Confirm scope (`all-jobs` vs `configured-jobs`).
- Confirm status mapping (`new` = `NEW,PENDING`).
- Confirm page/limit cap (ensure fetch limit >= expected count).
