// SCP-G5-D — the customer acknowledgement.
//
// A submission acknowledgement is the single most tempting place in a booking
// product to overstate. "Booked!" converts better than "received". It is also
// false: at REQUEST_RECEIVED nobody has qualified the request, no provider has
// accepted it, no owner has assigned it, and the customer has confirmed nothing.
//
// So the acknowledgement carries the state truth as DATA, not as tone. The copy
// stays warm and high-trust — the approved Freshline voice — while every claim a
// surface might be tempted to make is present as an explicit `false`. A UI that
// wants to say "confirmed" has to contradict a field that says it is not.
//
// `PROHIBITED_ACKNOWLEDGEMENT_TERMS` makes that checkable rather than a matter
// of editorial discipline.

import strings from "../localization/strings.json";

export interface CustomerAcknowledgement {
    /** The canonical state this acknowledgement describes. */
    stateTruth: "REQUEST_RECEIVED";
    /** The canonical Service Request state behind it. */
    canonicalState: "PENDING_ACCEPTANCE";
    /** What has NOT happened. Present as data so a surface cannot imply it has. */
    ownerQualified: false;
    providerAccepted: false;
    providerAssigned: false;
    customerConfirmed: false;
    fulfillmentStarted: false;
    serviceCompleted: false;
    paymentTaken: false;
    /** The canonical identifier the customer may quote. */
    requestReference: string;
    locale: string;
    headline: string;
    body: string;
    nextStep: string;
    /** True when this acknowledgement answers a replay of an earlier submission. */
    replay: boolean;
}

/**
 * Terms an acknowledgement must never contain, in either governed locale. Each
 * one asserts a lifecycle position that REQUEST_RECEIVED does not hold.
 */
export const PROHIBITED_ACKNOWLEDGEMENT_TERMS = [
    "confirmed",
    "confirmation",
    "booked",
    "guaranteed",
    "assigned",
    "your barber",
    "your provider",
    "paid",
    "terkonfirmasi",
    "dikonfirmasi",
    "dipesan",
    "dijamin",
    "ditugaskan",
    "dibayar"
] as const;

type LocalizedEntry = Record<string, string>;

function localized(section: string, key: string, locale: string): string {
    const table = (strings as unknown as Record<string, Record<string, LocalizedEntry>>)[section];
    const entry = table?.[key];
    if (!entry) {
        return "";
    }
    // Fall back to the governed default locale rather than to an empty string:
    // a missing translation should degrade to readable English, not to silence.
    return entry[locale] ?? entry["en"] ?? "";
}

export function buildAcknowledgement(input: {
    locale: string;
    requestId: string;
    brandPublicName: string;
    replay: boolean;
}): CustomerAcknowledgement {
    const headline = localized("acknowledgement", "headline", input.locale);
    const body = localized("acknowledgement", "body", input.locale).replace(
        "{brand}",
        input.brandPublicName
    );
    const nextStep = localized(
        "acknowledgement",
        input.replay ? "next_step_replay" : "next_step",
        input.locale
    );

    return {
        stateTruth: "REQUEST_RECEIVED",
        canonicalState: "PENDING_ACCEPTANCE",
        ownerQualified: false,
        providerAccepted: false,
        providerAssigned: false,
        customerConfirmed: false,
        fulfillmentStarted: false,
        serviceCompleted: false,
        paymentTaken: false,
        requestReference: input.requestId,
        locale: input.locale,
        headline,
        body,
        nextStep,
        replay: input.replay
    };
}
