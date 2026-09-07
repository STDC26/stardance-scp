// SCP Adapter Spine — concrete bounded transports.
//
// WhatsApp is present as a TRANSPORT only. G5-C does not activate a WhatsApp
// runtime; this establishes the replaceable boundary G5-G will later fill, and
// proves the boundary is non-authoritative before anything is wired to it.

import {
    checkAdapterContext,
    type AdapterRequestContext,
    type AdapterResult,
    type OutboundMessage,
    type TransportAdapter
} from "./adapter";

/**
 * WhatsApp outbound transport. Not configured in G5-C: it reports
 * ADAPTER_NOT_CONFIGURED rather than pretending to deliver, because a
 * fabricated success is worse than an explicit refusal.
 */
export function createWhatsAppTransport(options: { enabled: boolean }): TransportAdapter {
    return {
        name: "whatsapp-transport-v1",
        channel: "WHATSAPP",
        isConfigured: () => options.enabled,
        async send(context: AdapterRequestContext): Promise<AdapterResult> {
            return {
                transported: false,
                correlationId: context.correlationId,
                idempotencyKey: context.idempotencyKey,
                code: "ADAPTER_NOT_CONFIGURED",
                message:
                    "WhatsApp runtime is not activated in G5-C; the transport boundary exists but sends nothing",
                advancesCanonicalState: false
            };
        }
    };
}

/**
 * In-memory transport for tests and local runs. Substituting this for a real
 * transport changes what leaves the process and nothing about SCP truth.
 */
export function createRecordingTransport(
    channel: string,
    behavior: { fail?: { code: "TRANSPORT_UNAVAILABLE" | "TRANSPORT_REJECTED" | "TRANSPORT_TIMEOUT"; message: string } } = {}
): TransportAdapter & { sent: Array<{ context: AdapterRequestContext; message: OutboundMessage }> } {
    const sent: Array<{ context: AdapterRequestContext; message: OutboundMessage }> = [];
    return {
        name: `recording-transport:${channel}`,
        channel,
        sent,
        isConfigured: () => true,
        async send(context, message): Promise<AdapterResult> {
            const contextFailure = checkAdapterContext(context);
            if (contextFailure) {
                return contextFailure;
            }
            if (behavior.fail) {
                return {
                    transported: false,
                    correlationId: context.correlationId,
                    idempotencyKey: context.idempotencyKey,
                    code: behavior.fail.code,
                    message: behavior.fail.message,
                    advancesCanonicalState: false
                };
            }
            sent.push({ context, message });
            return {
                transported: true,
                correlationId: context.correlationId,
                idempotencyKey: context.idempotencyKey,
                externalReference: `rec-${sent.length}`,
                advancesCanonicalState: false
            };
        }
    };
}
