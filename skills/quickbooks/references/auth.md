# QuickBooks MCP auth (headless/manual)

## What “working” looks like

- `mcporter call QuickBooks.health_check --output json`
  - `checks.oauth.status` should be `ok`
  - First real API call may still need to authenticate the in-memory session

## Where tokens live

- Token file (encrypted): `~/.config/quickbooks-mcp/tokens.json`
- Encryption is machine-derived (hostname/platform/arch/homedir). Copying tokens to a different machine usually will not decrypt.

## Manual/headless OAuth flow (recommended)

This avoids relying on `xdg-open` and is the most reliable way to auth on headless servers.

1. If you plan to use a **public callback** (cloudflared), make sure the service is **off by default** and only started for auth:

```bash
sudo systemctl disable cloudflared
sudo systemctl stop cloudflared
```

2. Start the cloudflared service **only when needed** (skip if you can open the browser on the same host and use localhost):

```bash
sudo systemctl start cloudflared
```

Stop it again once OAuth completes:

```bash
sudo systemctl stop cloudflared
```

3. Start OAuth and capture the URL + redirect URI:

```bash
mcporter call QuickBooks.oauth_start --output json
```

- Open the returned `authUrl` in a browser.
- The `redirectUri` is what QuickBooks will send you back to (either `http://localhost:8765/callback` or your cloudflared URL).

4. After approval, copy the **full redirect URL** (with `code`, `state`, `realmId`) and complete OAuth:

```bash
mcporter call QuickBooks.oauth_complete redirectUrl:"<PASTE_REDIRECT_URL>" --output json
```

5. Turn off cloudflared after auth completes:

```bash
sudo systemctl stop cloudflared
```

## If you need a remote browser but want localhost callbacks

You can use an SSH tunnel instead of cloudflared:

```bash
ssh -N -L 8765:localhost:8765 timmy@timmys-crib
```

Then open the `authUrl` in your browser and the callback will hit this host.

## Common failure modes

### 1) No browser pops up

The server tries to `open(authUri)` via `xdg-open`, which often does nothing on headless boxes.

Fix:

- Use the **manual/headless flow** above (`oauth_start` → open URL → `oauth_complete`).

### 2) `EADDRINUSE` on port 8765

A previous process is still listening on the OAuth callback port.

Fix:

```bash
lsof -i :8765
kill <pid>
```

### 3) `No OAuth tokens found`

Usually means:

- `tokens.json` is missing/unreadable, or
- refresh token + realm ID were not set.

Fix:

- Re-auth using the manual flow.

### 4) `tokens.json` looks encrypted but won’t decrypt

We saw a case where the file formatting broke the decrypt detection.

Fix options:

- Simplest: delete `~/.config/quickbooks-mcp/tokens.json` and re-auth.
- If you want to try saving it: trim trailing whitespace/newlines, ensure it’s exactly `salt:iv:tag:ciphertext` hex segments.
