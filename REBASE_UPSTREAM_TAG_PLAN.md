# Rebase Plan: upstream release tag integration

Created: 2026-03-18

## Goal

Rebase this fork onto the latest upstream release tag while preserving the fork-specific work that is still wanted.

## Baseline

- Current branch: `main`
- Current fork HEAD: `232df717ea`
- Upstream latest stable release tag at plan time: `v2026.3.13-1`
- Upstream latest prerelease tag at plan time: `v2026.3.13-beta.1`

Unless the operator says otherwise, use `v2026.3.13-1` as the rebase target.

## Preserve

Keep the fork-specific work unless explicitly listed under "Drop / reset".

This includes, at minimum:

- browser inspect + `js_repl` runtime
- browser reliability improvements that are still useful
- screenshot/document-upload handling
- configurable outbound media local roots
- system-prompt changes that are still desired
- model retry/fallback behavior that is still desired
- Telegram queueing/command-sync robustness
- `/usage` provider-quota formatting
- local chat editor
- raw tool output UI improvements
- gateway `--force` hardening
- WhatsApp ETIMEDOUT retry
- heartbeat session rotation recovery
- Docker/cloud-init/custom skill surface
- `gws` replacement for legacy `gog` / Gmail watcher flow

## Drop / reset

Reset these fork-specific areas during the rebase:

1. Section `#8` from `FORK_CHANGES.md`
   - "Reply delivery is more durable and recoverable"
   - Main commits called out there:
     - `f890b366b3`
     - `cebeb24760`
     - `4ed6e2994d`

2. Section `#10` from `FORK_CHANGES.md`
   - "Telegram zero-delivery finals are explicitly handled now"
   - Main commits called out there:
     - `df358bd5e8`
     - `f50223bfd2`

3. The sanitizer piece that strips leaked assistant/tool-call draft tails
   - Primary commit:
     - `ce51b4b425`
   - Intent: remove only the no-longer-needed assistant/tool-call-tail stripping behavior, not unrelated sanitize fixes unless required.

4. Codex SSE event capture
   - Primary commit:
     - `84d64375d3`
   - Intent: remove the Codex SSE frame capture behavior; keep unrelated fixes only if they are still needed and can be cleanly separated.

## Execution approach

1. Map the keep/drop list to exact commits and files.
2. Rebase or replay the wanted fork commits onto `v2026.3.13-1`.
3. Omit the clearly unwanted commits above.
4. If a mixed commit contains both wanted and unwanted behavior:
   - keep the commit during replay
   - then surgically revert only the unwanted hunks
5. Run targeted verification on the preserved features and the removed areas.

## Expected tricky areas

- `84d64375d3` likely mixes Codex SSE capture with tool-call leak hardening, so it may need a partial revert rather than a full drop.
- `ce51b4b425` may mix general outbound-text cleanup with the specific assistant-draft-tail stripping behavior, so it may also need a partial revert.
- Dropping `#8` and `#10` may expose assumptions in later commits that were built on top of that delivery logic.

## Verification after rewrite

- confirm branch now sits on `v2026.3.13-1`
- confirm wanted fork features still exist
- confirm `#8` and `#10` behavior is gone
- confirm assistant/tool-call-tail stripping is gone
- confirm Codex SSE capture is gone
- run targeted tests for browser tools, Telegram flow, and reply normalization where touched
