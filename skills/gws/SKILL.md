---
name: gws
description: Use Google Workspace CLI (`gws`) for Gmail, Calendar, Contacts, Sheets, Docs, Slides, Tasks, and optional Drive. Trigger when working with Google account data or actions from the terminal. Prefer this skill for checking auth, searching or sending Gmail, reading or creating Calendar events, reading contacts through the People API, reading or updating Sheets, reading Docs, and other direct Google Workspace CLI tasks.
---

# gws

Use `gws` for direct Google Workspace CLI work. Prefer helper commands with `+` when they exist. Fall back to the raw discovery-style commands when a helper is missing.

## Quick rules

- Start with `gws auth status` if auth is unclear.
- Prefer the smallest scope set that covers the task.
- For consumer `@gmail.com` accounts or testing-mode OAuth apps, avoid broad presets. Request only the services or scopes you actually need.
- Confirm before sending email or creating/updating calendar events.
- Expect structured JSON output by default.

## Auth setup

### Fast path

If `gcloud` is available and no OAuth client is set up yet:

```bash
gws auth setup --login
```

If an OAuth client already exists, place `client_secret.json` at `~/.config/gws/client_secret.json` and run:

```bash
gws auth login
```

### Tested non-Drive auth set

Use this when setting up the common non-Drive auth set:

```bash
gws auth login --scopes 'https://www.googleapis.com/auth/spreadsheets,https://www.googleapis.com/auth/gmail.modify,https://www.googleapis.com/auth/calendar,https://www.googleapis.com/auth/documents,https://www.googleapis.com/auth/presentations,https://www.googleapis.com/auth/tasks,https://www.googleapis.com/auth/contacts,https://www.googleapis.com/auth/cloud-platform,openid,https://www.googleapis.com/auth/userinfo.email'
```

This covers:

- Gmail
- Calendar
- Contacts
- Docs
- Sheets
- Slides
- Tasks

Drive is intentionally not included.

### Scope gotcha

On some builds, `gws auth login -s people` may not grant the contacts scope cleanly even though People API calls need it. If contacts access matters, prefer explicit scopes and include:

```text
https://www.googleapis.com/auth/contacts
```

### Fresh-token gotcha

If `gws auth status` shows the new scopes but an API still returns `403 insufficient authentication scopes`, delete the cached access token and retry once:

```bash
rm -f ~/.config/gws/token_cache.json
```

## Common commands

### Auth and sanity checks

```bash
gws auth status
gws gmail users getProfile --params '{"userId":"me"}'
gws calendar calendarList list --params '{}'
```

### Gmail

Prefer helpers for common tasks:

```bash
gws gmail +triage
gws gmail +send --to alice@example.com --subject "Hello" --body "Hi there"
```

Raw discovery examples:

```bash
gws gmail users.messages.list --params '{"userId":"me","q":"newer_than:7d"}'
gws gmail users.messages.get --params '{"userId":"me","id":"MESSAGE_ID"}'
```

### Calendar

```bash
gws calendar +agenda
gws calendar events.list --params '{"calendarId":"primary","timeMin":"2026-03-15T00:00:00Z","timeMax":"2026-03-16T00:00:00Z","singleEvents":true,"orderBy":"startTime"}'
gws calendar +insert --summary "Title" --start '2026-03-15T19:00:00-04:00' --end '2026-03-15T20:00:00-04:00'
```

### Contacts

```bash
gws people people.connections.list --params '{"resourceName":"people/me","pageSize":20,"personFields":"names,emailAddresses,phoneNumbers"}'
```

### Sheets

Prefer single quotes around ranges that contain `!`.

```bash
gws sheets +read --spreadsheet SPREADSHEET_ID --range 'Sheet1!A1:C10'
gws sheets spreadsheets.values.get --params '{"spreadsheetId":"SPREADSHEET_ID","range":"Sheet1!A1:C10"}'
gws sheets +append --spreadsheet SPREADSHEET_ID --values 'Alice,95'
```

### Docs

```bash
gws docs documents.get --params '{"documentId":"DOC_ID"}'
gws docs +write --document-id DOC_ID --text 'Append this text.'
```

### Slides

```bash
gws slides presentations.get --params '{"presentationId":"PRESENTATION_ID"}'
```

### Tasks

```bash
gws tasks tasklists.list --params '{}'
gws tasks tasks.list --params '{"tasklist":"TASKLIST_ID"}'
```

### Drive, only when explicitly needed

If the task truly needs Drive, re-auth with a Drive scope and then use Drive commands like:

```bash
gws drive files.list --params '{"pageSize":10}'
gws drive +upload ./report.pdf --name 'Q1 Report'
```

## Working style

- Use helper commands first when they clearly fit.
- Use raw discovery commands when you need exact API parameters or response fields.
- Use `--params` for query and path parameters.
- Use `--json` for request bodies.
- For larger scripted flows, prefer JSON output piped into `jq` instead of scraping human text.
- Do not assume the Gmail watcher or Pub/Sub hook flows have been migrated. This skill is for direct `gws` CLI usage.
