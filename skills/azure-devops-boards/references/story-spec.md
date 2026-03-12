# Story Sync Spec

Use this skill with **User Stories as the visible board cards**.
Do not create Tasks as the default board unit unless the user explicitly asks for sub-work.

## Rules

- Treat each open board card as one `User Story`.
- Put the actionable detail directly in the story description.
- Assign every visible card to exactly one driver.
- Default `AreaPath` and `IterationPath` to the project name unless the user asks for something else.
- Prefer bulk sync over many one-off writes.

## Minimal JSON spec

```json
{
  "project": "Dialogix Leadership",
  "stories": [
    {
      "title": "Follow up with David on contracts/papers",
      "assignedTo": "Chadd Hodge",
      "state": "New",
      "description": "Owner: Chadd Hodge\n\nDetails:\n- Follow up with David on contracts and papers.\n- Keep status notes here."
    },
    {
      "title": "Finalize Voytech report",
      "assignedTo": "Samuel Lee-Howes",
      "state": "New",
      "description": "Owner: Samuel Lee-Howes\n\nDetails:\n- Finalize the Voytech report.\n- Keep status notes here."
    }
  ]
}
```

## Common commands

List stories:

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  list-stories --project "Dialogix Leadership"
```

Upsert one story:

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  upsert-story --project "Dialogix Leadership" \
  --title "Follow up with David on contracts/papers" \
  --assigned-to "Chadd Hodge" \
  --state New \
  --description $'Owner: Chadd Hodge\n\nDetails:\n- Follow up with David on contracts and papers.'
```

Sync a whole board from spec:

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  sync-stories --spec /tmp/leadership-board.json --close-missing
```

Dry-run before writing:

```bash
python scripts/azure_devops_boards.py --org https://dev.azure.com/dialogixhq \
  sync-stories --spec /tmp/leadership-board.json --close-missing --dry-run
```

## Notes

- Auth comes from `az account get-access-token` for the Azure DevOps resource.
- Pass `--org` each time or set `AZDO_ORG`.
- Exact-title matching is intentional. Rename explicitly when the title should change.
- `--close-missing` only closes missing **User Stories** in the target project. It does not touch other work item types.
