# Feature Extension Playbook

How to add new Indeed candidate features to this skill without breaking existing flows.

## Goal

When you need a new capability (new filter, new update action, new field extraction), use one of two discovery tracks:

1. **Recon track** (capture live network)
2. **Inferred track** (derive from known operations + payload patterns)

Use recon first when available. Use inferred track when UI capture is blocked.

---

## Track A: Recon (preferred)

### 1) Capture requests

From `indeed-cli`:

```bash
indeed-cli recon:watch --duration-sec 120 --page-url-contains employers.indeed.com
```

In the UI, perform exactly one target action during capture (example: click “Shortlist”).

### 2) Parse operation names + variables

```bash
jq '.[] | select(.url|test("apis.indeed.com/graphql")) | {op:.postDataJson.operationName, vars:.postDataJson.variables, query:.postDataJson.query}' <requests.json>
```

### 3) Identify minimal payload

Strip payload to smallest required fields. Keep operation name + query text + required vars only.

### 4) Add as command/script

- CLI command in `src/commands/*.ts`
- If reusable for agents, add script to `skills/.../scripts/*.mjs`
- Add docs in `references/`

### 5) Validate safely

- Add `--dry-run` first
- Then run one live update against a known test candidate
- Confirm in UI and with a follow-up query

---

## Track B: Inferred (fallback)

Use when recon cannot capture payloads (Cloudflare, worker routing, etc.).

### 1) Start from existing operations

Use known nearby operations from `references/graphql-operations.md` and past captures.

### 2) Infer payload shape

Look for naming patterns:

- update sentiment: `CreateEmployerCandidateSubmissionFeedbackInput`
- update milestone: `UpdateCandidateSubmissionMilestoneInput`

### 3) Build conservative command

- Require explicit IDs from user
- Implement `--dry-run`
- Avoid destructive defaults

### 4) Confirm with one live call

- Execute once
- Verify returned GraphQL object shows expected state change
- If mismatch, revert by opposite operation

---

## Safety / rollout checklist

- [ ] `--dry-run` mode exists
- [ ] No bulk updates by default
- [ ] Requires explicit candidate identifier(s)
- [ ] Logs operation name + target IDs
- [ ] Docs include rollback path
- [ ] Added to `references/` (not bloating SKILL.md)

---

## Where to document

Put operational detail in `references/`:

- `graphql-operations.md` -> operation/payload examples
- `status-mapping.md` -> UI-to-filter mapping
- `feature-extension-playbook.md` -> this process

Keep `SKILL.md` concise and link here.
