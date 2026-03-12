---
name: azure-devops-boards
description: Manage Azure DevOps Boards over the Azure DevOps REST API with User Stories as the visible board cards. Use when creating, listing, updating, assigning, or bulk-syncing Azure DevOps board items, especially when the team wants simple board cards with details directly in the story description instead of extra Task layers.
---

# Azure DevOps Boards

Use this skill for Azure DevOps board management through the API.
Default board model: **User Story = board card**.

## Workflow

1. Resolve the org URL.
   - Prefer `--org https://dev.azure.com/<org>`.
   - Or set `AZDO_ORG` first.
2. Read `references/story-spec.md` when you need the JSON shape or command examples.
3. Prefer bulk sync for larger edits.
   - Write a JSON spec file.
   - Run `sync-stories` with `--dry-run` first.
   - If the diff looks right, rerun without `--dry-run`.
4. Use one-off upserts only for small changes.

## Defaults

- Use `User Story` as the visible board item.
- Put the actionable detail directly into `System.Description`.
- Assign every visible card to one owner.
- Keep `AreaPath` and `IterationPath` equal to the project unless asked otherwise.
- Avoid creating `Task` items unless the user explicitly wants sub-work.
- Avoid creating `Feature`/`Epic` layers unless the user explicitly wants rollups.

## Script

Primary script: `scripts/azure_devops_boards.py`

### List stories

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  list-stories --project "Dialogix Leadership"
```

### Upsert one story

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  upsert-story --project "Dialogix Leadership" \
  --title "Follow up with David on contracts/papers" \
  --assigned-to "Chadd Hodge" \
  --state New \
  --description $'Owner: Chadd Hodge\n\nDetails:\n- Follow up with David on contracts and papers.'
```

### Sync a board from JSON

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  sync-stories --spec /tmp/leadership-board.json --close-missing --dry-run
```

Then rerun without `--dry-run` to apply.

## Practical guidance

- For messy boards, convert the desired end state into a JSON spec and sync it.
- For small edits, use `upsert-story` keyed by exact title.
- If a story title should change, rename it explicitly instead of relying on sync title matching.
- When the user says “make it show on the board,” ensure the project has open `User Story` items, not only Tasks.
- When cleaning up duplicate hierarchy, collapse details into the story description and close redundant lower layers only if the user asks.
