# Fix Silent Zero-Delivery on Routed Telegram Finals

## Summary

The March 13, 2026 repeat around `19:42:02Z` to `19:43:32Z` is not the original direct Telegram-final bug. The live gateway already contains that fix.

This repeat is most likely in the routed followup/origin path:

- the assistant final exists in the Iris session
- no Telegram `sendMessage ok ...` was logged for that turn
- no `telegram final reply unexpected_zero_delivery` log was emitted
- a new inbound message arrived before the earlier turn completed, which makes the followup/origin-routing path plausible
- `routeReply()` currently returns `{ ok: true }` whenever `deliverOutboundPayloads()` does not throw, even if it returned an empty delivery list

The implementation should make routed assistant replies depend on actual visible delivery, not just “outbound completed without throwing,” and should reuse the same intentional-noop vs unexpected-zero-delivery model from the first Telegram fix.

## Key Changes

- In `src/infra/outbound/deliver.ts`, add an internal detailed-outcome helper for outbound delivery.
- Keep the existing `deliverOutboundPayloads()` array return contract for existing callers.
- Add a sibling internal path that returns both the delivery results and visibility metadata.
- The metadata must distinguish:
  - `delivered`
  - `cancelled_by_hook`
  - `empty_after_hooks`
  - `unknown_zero_delivery`
- Reason precedence when no visible message is delivered:
  - all cancelled by `message_sending` hook => `cancelled_by_hook`
  - at least one payload blanked to empty after hooks and none delivered => `empty_after_hooks`
  - anything else with zero visible delivery => `unknown_zero_delivery`
- In `src/auto-reply/reply/route-reply.ts`, stop treating “no throw” as delivery success.
- Keep `ok` for transport/runtime success vs hard failure.
- Extend `RouteReplyResult` to include:
  - `delivered: boolean`
  - `zeroDeliveryReason?: "cancelled_by_hook" | "empty_after_hooks" | "unknown_zero_delivery"`
  - `messageId?: string`
- Pre-routing intentional suppressions should return `ok: true`, `delivered: false` without a zero-delivery anomaly:
  - reasoning-only suppression
  - silent-token suppression
  - normalized empty payloads
- Post-routing zero-delivery must come only from the outbound helper metadata above.
- Update routed assistant-reply callers to use `delivered`, not just `ok`.
- `src/auto-reply/reply/followup-runner.ts`
  - treat queued followup payloads as final assistant delivery for fallback purposes
  - if routed Telegram delivery is `delivered: false` with `empty_after_hooks` or `unknown_zero_delivery`, immediately send the standard fallback text through the same routed Telegram path
  - if the routed result is `cancelled_by_hook`, log intentional noop and do not fallback
  - preserve existing same-channel dispatcher fallback only for actual route failures (`ok: false`)
- routed final-delivery paths in ACP/config dispatch should use the same rule:
  - `ok: false` => existing route failure behavior
  - `ok: true` and `delivered: false` with unexpected zero delivery on Telegram finals => send the standard fallback and log
  - `cancelled_by_hook` => no fallback, intentional noop log
  - tool/block routed payloads should never send the empty-response fallback; log only
- Routed final-count accounting must count actual visible final delivery or fallback delivery, not just `result.ok`.
- Add explicit routed zero-delivery logging.
- One structured warning at the route/outbound boundary with:
  - channel
  - accountId
  - destination
  - sessionKey when available
  - whether text/media/channelData existed
  - zero-delivery reason
- One higher-level log at the routed final caller when a Telegram final becomes:
  - `unexpected_zero_delivery`
  - `intentional_noop`
- Use distinct wording from the direct Telegram-dispatch logs so future incidents show which path failed.

## Interface Changes

- Internal only:
  - add a detailed outbound delivery result/helper in `src/infra/outbound/deliver.ts`
  - extend `RouteReplyResult` in `src/auto-reply/reply/route-reply.ts` with visible-delivery metadata
- No public CLI, config, schema, or channel-plugin API changes.
- Keep `deliverOutboundPayloads()` source-compatible for existing generic callers that only need the raw delivery array.

## Test Plan

- `src/auto-reply/reply/route-reply.test.ts`
  - zero outbound deliveries without throw => `ok: true`, `delivered: false`, `zeroDeliveryReason: "unknown_zero_delivery"`
  - hook cancellation => `ok: true`, `delivered: false`, `zeroDeliveryReason: "cancelled_by_hook"`
  - hook blanking to empty => `ok: true`, `delivered: false`, `zeroDeliveryReason: "empty_after_hooks"`
  - reasoning/silent/empty pre-routing skips => no anomaly reason and no outbound call
- `src/infra/outbound/deliver.test.ts`
  - detailed helper reports `cancelled_by_hook`
  - detailed helper reports `empty_after_hooks`
  - detailed helper reports `unknown_zero_delivery` when processing completes with zero visible sends and no throw
  - normal text/media delivery still reports `delivered: true`
- Routed final callers
  - followup queue routed to Telegram returns zero visible delivery without throw => fallback is routed and anomaly is logged
  - followup queue routed to Telegram cancelled by hook => no fallback, intentional noop log
  - config-routed final to Telegram zero-delivery => fallback is sent and final-count accounting reflects visible delivery
  - ACP-routed final to Telegram zero-delivery => fallback is sent and logged
  - routed tool/block zero-delivery => no empty-response fallback regression

## Assumptions

- The interrupted heartbeat is adjacent noise again, not the direct cause of the missing Telegram final.
- The missing follow-up reply most likely used the routed followup/origin path because a new inbound message arrived before the earlier turn completed.
- The standard fallback text remains `No response generated. Please try again.`
- Scope is limited to routed assistant replies, especially Telegram finals; this plan does not broaden empty-response fallback behavior across all channels.
