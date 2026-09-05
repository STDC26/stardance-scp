// Freshline Studio Bali — MSOS Phase 0/1 shared types.

export type AppointmentStatus =
    | "PENDING_ACCEPTANCE"
    | "CONTRACTOR_DISPATCHED"
    | "CONTRACTOR_ACCEPTED"
    | "CONTRACTOR_DECLINED"
    | "CONFIRMED"
    | "CANCELLED"
    | "EXPIRED_REVERTED";

export type WhatsAppIntentState = "ACCEPT" | "DECLINE" | "NEEDS_CLARIFICATION";

export interface AppointmentRow {
    appointment_id: string;
    billing_code: string;
    customer_id: string;
    service_id: string;
    contractor_id: string | null;
    start_time: Date;
    end_time: Date;
    status: AppointmentStatus;
    dispatched_at: Date | null;
    version: number;
    created_at: Date;
    updated_at: Date;
}

/** Result of a single timeout-recovery sweep. */
export interface RecoveryResult {
    scannedCandidates: number;
    reverted: string[]; // appointment_ids actually reverted to PENDING_ACCEPTANCE
    skippedAlreadyResolved: string[]; // lost the race to a concurrent transition
    errors: Array<{ appointmentId: string; error: string }>;
}

export type DispatchResolutionOutcome =
    | { success: true; appointmentId: string; newStatus: AppointmentStatus; version: number }
    | { success: false; appointmentId: string; reasonCode: "STALE_STATE"; currentStatus: AppointmentStatus }
    | { success: false; appointmentId: string; reasonCode: "NOT_FOUND" };

export interface BookingValidationResult {
    valid: boolean;
    reasonCode?:
        | "INVALID_START_TIME"
        | "INVALID_DURATION"
        | "SERVICE_NOT_FOUND"
        | "SERVICE_INACTIVE"
        | "BEFORE_OPENING"
        | "CLOSING_CEILING_EXCEEDED";
    message?: string;
    computedStartLocal?: string;
    computedEndLocal?: string;
    computedEndUtc?: string;
    closingCeilingLocal?: string;
}

export interface ParsedWhatsAppMessage {
    originalText: string;
    normalizedText: string;
    billingCode: string | null;
    intent: WhatsAppIntentState;
    routing: "MATCHED" | "NEEDS_CLARIFICATION";
    clarificationReason?: "NO_BILLING_CODE" | "AMBIGUOUS_INTENT" | "NO_INTENT_FOUND";
}
