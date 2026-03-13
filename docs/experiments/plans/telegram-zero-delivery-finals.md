# Fix Silent Zero-Delivery Finals in Telegram

## Summary

The March 13, 2026 Iris incident is most likely a Telegram dispatch accounting bug, not a model/session failure and not a Telegram formatting failure.

Evidence already established:

- The missing Azure-comments reply exists in the Iris session and completed normally.
- Iris Telegram streaming is off, so this ran through the direct-send path, not preview finalization.
- The exact failed text formats into a valid Telegram chunk.
- No `telegram sendMessage ok ...` or Telegram API failure was logged for that turn.
- Current Telegram dispatch treats `queuedFinal` as success even when zero Telegram-visible messages were actually delivered.

The implementation should fix the silent-drop class directly and add enough telemetry to explain the exact zero-delivery cause if it ever happens again.

## Key Changes

- In `src/telegram/bot-message-dispatch.ts`, stop using `queuedFinal` as the success condition for a completed Telegram final.
- Treat `queuedFinal` as diagnostic-only: it means the model/dispatcher produced a final payload and accepted it into the reply queue, not that Telegram delivery succeeded.
- Track final outcomes explicitly in Telegram dispatch:
  - `delivered`: at least one Telegram-visible message or finalized preview was actually delivered.
  - `intentional_noop`: a final was intentionally suppressed and should not trigger fallback.
  - `unexpected_zero_delivery`: a final was processed but nothing visible was delivered.
- Trigger the empty-response fallback only for `unexpected_zero_delivery` or explicit dispatch failures, not for intentional suppressions.
- Keep the detection generic. Do not overfit the fix to hooks; include a catch-all zero-delivery reason such as `unknown_zero_delivery` or `no_visible_delivery`.
- In `src/telegram/bot/delivery.replies.ts`, return richer delivery outcome metadata instead of only `{ delivered: boolean }`.
- At minimum, report these post-queue zero-delivery reasons:
  - `cancelled_by_hook`
  - `empty_after_hooks`
  - `unknown_zero_delivery`
- Log zero-delivery finals explicitly with enough context to diagnose later: `accountId`, `chatId`, `sessionKey` when available, whether text/media existed, and the resolved zero-delivery reason.
- Treat reason-specific outcomes this way:
  - `empty_after_hooks` => `unexpected_zero_delivery` and send fallback.
  - `cancelled_by_hook` => `intentional_noop`, but emit a structured warning.
  - heartbeat/silent/no-reply/suppressed-reasoning intentional skips => `intentional_noop`.
- Update any internal Telegram call sites that consume `deliverReplies()` results so they compile cleanly and preserve current behavior. In particular, cover `src/telegram/bot-native-commands.ts` in addition to the main auto-reply path.

## Interface Changes

- Internal only: change `deliverReplies()` in `src/telegram/bot/delivery.replies.ts` from a boolean-only result to a delivery outcome object that exposes:
  - whether anything visible was delivered
  - a zero-delivery reason when nothing visible was delivered
- No public CLI, config, or schema changes.

## Test Plan

- Add/update Telegram dispatch tests to cover:
  - final delivery returns zero visible sends without throwing => fallback is sent and the anomaly is logged
  - final text reply blanked to empty after `message_sending` hooks => fallback is sent and the zero-delivery reason is recorded
  - final reply cancelled by hook => no fallback, but explicit noop reason is recorded
  - suppressed reasoning-only final => no fallback and no regression
  - normal Iris-style direct final text send with streaming off => still sends normally
  - final delivered via preview finalization path => still counts as delivered and does not fallback
- Keep or extend the existing Telegram delivery tests that already cover hook blanking/cancellation behavior so the richer return metadata is verified at the `deliverReplies()` layer too.

## Assumptions

- The heartbeat logged immediately after the missing reply is adjacent noise, not the cause of the missing Azure-comments reply.
- The exact sub-trigger for this incident is still unproven, but the root bug is that Telegram can currently report final success without actual delivery.
- No external Telegram ownership/filter plugin is active in the live config; only internal hooks are enabled.
- Heartbeat visibility behavior should remain unchanged.
