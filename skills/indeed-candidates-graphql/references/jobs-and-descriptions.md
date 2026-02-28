# Jobs + Job Descriptions

Use these commands when you need job metadata or full job description text for candidate context.

## Commands

### List jobs

```bash
indeed-cli job:list --config indeed.config.yaml --limit 50
```

Optional filter:

```bash
indeed-cli job:list --query "consultant"
```

Returns per job:

- `jobId` (IRI)
- `legacyId`
- `title`
- `descriptionText` (when available)

### Get one job

By legacy ID:

```bash
indeed-cli job:get --legacy-id cdbc7fa41ba9
```

By job ID:

```bash
indeed-cli job:get --job-id <iri_job_id>
```

Returns:

- `jobId`
- `legacyId`
- `title`
- `descriptionText`

## Notes

- Data is pulled live from GraphQL `FindEmployerJobs`.
- Description currently comes from `HostedJobPost.description` (schema-backed field).
- If a lookup misses, run `job:list --query ...` first to verify the correct ID.
