import { createSubsystemLogger } from "../../logging/subsystem.js";
import { routeReply, type RouteReplyParams, type RouteReplyResult } from "./route-reply.js";

export const ROUTED_EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

const log = createSubsystemLogger("reply/routed-final");

export type RoutedFinalReplyResult = RouteReplyResult & {
  fallbackSent: boolean;
};

function buildLogContext(
  params: Pick<RouteReplyParams, "accountId" | "channel" | "sessionKey" | "to">,
  component: string,
  reason?: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    component,
    channel: params.channel,
    accountId: params.accountId ?? "default",
    to: params.to,
    sessionKey: params.sessionKey ?? "unknown",
    ...(reason ? { reason } : {}),
    ...extra,
  };
}

export async function deliverRoutedFinalReply(params: RouteReplyParams & { component: string }) {
  const primary = await routeReply(params);
  if (
    !primary.ok ||
    primary.delivered ||
    params.channel !== "telegram" ||
    !primary.zeroDeliveryReason
  ) {
    return {
      ...primary,
      fallbackSent: false,
    } satisfies RoutedFinalReplyResult;
  }

  if (primary.zeroDeliveryReason === "cancelled_by_hook") {
    log.warn(
      "routed telegram final reply intentional_noop",
      buildLogContext(params, params.component, primary.zeroDeliveryReason),
    );
    return {
      ...primary,
      fallbackSent: false,
    } satisfies RoutedFinalReplyResult;
  }

  log.warn(
    "routed telegram final reply unexpected_zero_delivery",
    buildLogContext(params, params.component, primary.zeroDeliveryReason),
  );

  const fallback = await routeReply({
    ...params,
    payload: { text: ROUTED_EMPTY_RESPONSE_FALLBACK },
  });

  if (!fallback.ok || !fallback.delivered) {
    log.warn(
      "routed telegram final reply fallback_failed",
      buildLogContext(params, params.component, primary.zeroDeliveryReason, {
        fallbackOk: fallback.ok,
        fallbackDelivered: fallback.delivered,
        fallbackError: fallback.error,
        fallbackZeroDeliveryReason: fallback.zeroDeliveryReason,
      }),
    );
  }

  return {
    ...fallback,
    messageId: fallback.messageId ?? primary.messageId,
    zeroDeliveryReason: primary.zeroDeliveryReason,
    fallbackSent: fallback.ok && fallback.delivered,
  } satisfies RoutedFinalReplyResult;
}
