# Status Mapping (UI parity)

Use these mappings for filter parity with the Indeed Candidates UI.

- `new` -> milestones: `NEW`, `PENDING`
- `reviewing` (or `reviewed`) -> milestone: `REVIEWED`
- `all` -> milestones: `NEW`, `PENDING`, `PHONE_SCREENED`, `INTERVIEWED`, `OFFER_MADE`, `REVIEWED`
- `rejected` -> milestone: `REJECTED`
- `shortlist` -> milestones above + sentiments: `YES`
- `undecided` -> milestones above + sentiments: `MAYBE`

Default UI-style time scope observed in payloads:

- `created.createdAfter = 1708992000000`

Default UI job scope observed in payloads:

- `jobs.hostedJobPostStatuses = ["ACTIVE", "PAUSED"]`
