---
name: company-recordings-cli
description: Query and fetch company meeting recordings from the central admin SharePoint library using the local `company-recordings-cli` tool. Use when an agent needs to find recordings, filter by user/path, download a specific recording for analysis into temporary storage, and clean up downloaded files to avoid disk bloat.
---

# Company Recordings CLI

## Overview

Use this skill to work with centrally archived recordings without syncing the full recordings library to local disk.

Use these paths:

- CLI wrapper: `/home/admin/.local/bin/company-recordings-cli`
- Env config: `/home/admin/.config/company-recordings-sync/.env`
- Temp cache: `/tmp/company-recordings-cache`

Do not use local OneDrive sync folders to access recordings.

## Core Commands

List recordings:

```bash
/home/admin/.local/bin/company-recordings-cli list --videos-only --json
```

Filter by user folder and limit results:

```bash
/home/admin/.local/bin/company-recordings-cli list --user chadd@dialogix.ai --limit 20 --json
```

Filter by substring in path or filename:

```bash
/home/admin/.local/bin/company-recordings-cli list --contains "weekly" --videos-only --json
```

Download one recording by `item_id`:

```bash
/home/admin/.local/bin/company-recordings-cli download --item-id <driveItemId> --json
```

Cleanup cached downloads:

```bash
/home/admin/.local/bin/company-recordings-cli cleanup --json
```

## Recommended Agent Workflow

1. Run `list` with `--json` and relevant filters.
2. Pick a target `item_id`.
3. Run `download --item-id ... --json` and capture `downloaded_to` from output.
4. Analyze the downloaded file using the required tool.
5. Delete the specific file after analysis, then run `cleanup`.

Example extraction of downloaded path:

```bash
OUT=$(/home/admin/.local/bin/company-recordings-cli download --item-id "$ITEM_ID" --json)
FILE_PATH=$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)["downloaded_to"])')
```

Example cleanup after analysis:

```bash
rm -f "$FILE_PATH"
/home/admin/.local/bin/company-recordings-cli cleanup --json
```

## Storage Safety Rules

- Always prefer targeted downloads over bulk downloads.
- Always remove downloaded files when analysis is complete.
- Always run `cleanup` after batch analysis tasks.
- Keep `CACHE_TTL_HOURS` in env at a low value unless explicitly asked otherwise.
