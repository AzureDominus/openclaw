---
description: Rebase onto latest upstream release tag, build, restart gateway, and push
argument-hint: [REMOTE=upstream] [BASE=main] [PUSH_REMOTE=origin] [BRANCH=main] [SERVICE=openclaw-gateway.service] [INCLUDE_PRERELEASE=0]
---

You are running the OpenClaw upstream-release sync workflow.

Defaults (unless overridden by named args):

- REMOTE=upstream
- BASE=main
- PUSH_REMOTE=origin
- BRANCH=main
- SERVICE=openclaw-gateway.service
- INCLUDE_PRERELEASE=0

Goal:

1. Rebase local changes onto the latest upstream release tag (not latest commit).
2. Build.
3. Restart gateway via systemd user service and verify status.
4. Push to fork remote.

Requirements:

- Do not switch branches unless explicitly requested.
- Do not use stash.
- Do not discard unrelated local changes.
- If dependency/tooling is missing, run the repo package-manager install, then retry the failed command once.

Execution steps:

1. Fetch release metadata and tags from upstream:
   - `git fetch "$REMOTE" --prune --tags`
2. Determine latest release tag from upstream refs:
   - If INCLUDE_PRERELEASE != 1, ignore prerelease tags like `-beta`/`-rc`.
   - Prefer true release tags (e.g. `vYYYY.M.D`) from upstream, not arbitrary local tags.
   - Print the selected tag and why.
3. Rebase current branch onto that release tag:
   - `git rebase <selected_tag>`
4. Conflict policy:
   - Auto-resolve straightforward conflicts using local context and keep moving.
   - Only stop and ask the user when conflict intent is genuinely ambiguous.
   - When asking, provide a short summary for each ambiguous file:
     - what incoming (upstream tag) changes do,
     - what local changes do,
     - concrete behavior tradeoff.
   - Then continue rebase after user direction.
5. Build:
   - `pnpm build`
6. Restart and verify gateway:
   - `systemctl --user restart "$SERVICE"`
   - `systemctl --user --no-pager --full status "$SERVICE" | sed -n '1,80p'`
7. Push rebased branch to fork:
   - `git push --force-with-lease "$PUSH_REMOTE" "$BRANCH"`

Final report:

- Selected upstream release tag.
- Whether any conflicts occurred and how they were resolved.
- Build result.
- Service restart/status summary.
- Push result with remote/branch.
- If anything failed, include the first actionable error.
