// SCP Adapter Spine — governed, replaceable, non-authoritative boundaries.
//
// An adapter TRANSPORTS. It never owns SCP business state.
//
// The type system carries that rule: an AdapterResult has no field through
// which a canonical state could be asserted, and a successful transport is
// explicitly `transported: true` rather than anything resembling `applied` or
// `confirmed`. Delivering a message is not the same event as advancing a
// Service Request, and an adapter cannot conflate them because it has no
// vocabulary for the second.
//
// Every call carries correlation, idempotency and tenant lineage, so an
// external retry is attributable and a failure is bounded rather than ambiguous.

import type { IdentityLineage } from "../../runtime/identity";

export interface AdapterRequestContext {
    /** Ties this attempt to the governed action it supports. */
    correlationId: string;
    /** Makes a retry recognisable as the same attempt. */
    idempotencyKey: string;
    lineage: IdentityLineage;
}

export type AdapterFailureCode =
    | "TRANSPORT_UNAVAILABLE"
    | "TRANSPORT_REJECTED"
    | "TRANSPORT_TIMEOUT"
    | "ADAPTER_NOT_CONFIGURED"
    | "CONTEXT_INCOMPLETE";

/**
 * The only shape an adapter may return.
 *
 * Note what is absent: there is no state, no status, no "confirmed", no
 * "applied". A transport outcome cannot imply a canonical outcome because it
 * cannot express one.
 */
export type AdapterResult =
    | {
          transported: true;
          correlationId: string;
          idempotencyKey: string;
          /** Opaque external reference. Never an SCP identifier. */
          externalReference: string | null;
          /** Always false. An adapter never advances canonical state. */
          advancesCanonicalState: false;
      }
    | {
          transported: false;
          correlationId: string;
          idempotencyKey: string;
          code: AdapterFailureCode;
          message: string;
          /** Always false. A failure certainly does not advance state either. */
          advancesCanonicalState: false;
      };

export interface OutboundMessage {
    channel: string;
    recipientHandle: string;
    body: string;
}

export interface TransportAdapter {
    readonly name: string;
    readonly channel: string;
    isConfigured(): boolean;
    send(context: AdapterRequestContext, message: OutboundMessage): Promise<AdapterResult>;
}

/** Validates that a call carries the lineage every adapter attempt must have. */
export function checkAdapterContext(context: AdapterRequestContext): AdapterResult | null {
    const missing: string[] = [];
    if (!context.correlationId) missing.push("correlationId");
    if (!context.idempotencyKey) missing.push("idempotencyKey");
    if (!context.lineage?.tenantId) missing.push("lineage.tenantId");
    if (!context.lineage?.marketId) missing.push("lineage.marketId");
    if (!context.lineage?.environment) missing.push("lineage.environment");
    if (missing.length === 0) {
        return null;
    }
    return {
        transported: false,
        correlationId: context.correlationId ?? "",
        idempotencyKey: context.idempotencyKey ?? "",
        code: "CONTEXT_INCOMPLETE",
        message: `adapter context is missing: ${missing.join(", ")}`,
        advancesCanonicalState: false
    };
}

/**
 * Registry of replaceable adapters. Substituting a fake for a real transport
 * changes what happens on the wire and nothing about SCP truth — which is the
 * property G5-D/E/F/G will depend on.
 */
export class AdapterSpine {
    private readonly adapters = new Map<string, TransportAdapter>();

    register(adapter: TransportAdapter): this {
        this.adapters.set(adapter.channel, adapter);
        return this;
    }

    get(channel: string): TransportAdapter | undefined {
        return this.adapters.get(channel);
    }

    channels(): string[] {
        return [...this.adapters.keys()].sort();
    }

    async send(
        channel: string,
        context: AdapterRequestContext,
        message: OutboundMessage
    ): Promise<AdapterResult> {
        const contextFailure = checkAdapterContext(context);
        if (contextFailure) {
            return contextFailure;
        }
        const adapter = this.adapters.get(channel);
        if (!adapter || !adapter.isConfigured()) {
            return {
                transported: false,
                correlationId: context.correlationId,
                idempotencyKey: context.idempotencyKey,
                code: "ADAPTER_NOT_CONFIGURED",
                message: `no configured adapter for channel ${channel}`,
                advancesCanonicalState: false
            };
        }
        return adapter.send(context, message);
    }
}
