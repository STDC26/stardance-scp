-- =============================================================================
-- Freshline Studio Bali — MSOS Phase 0/1
-- PART A: Relational SQL — DDL for timeout recovery, booking validation,
--         and WhatsApp inbound parsing.
-- Target: PostgreSQL 15+
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

CREATE TYPE appointment_status AS ENUM (
    'PENDING_ACCEPTANCE',      -- newly created, awaiting contractor dispatch
    'CONTRACTOR_DISPATCHED',   -- offer sent to a contractor, awaiting response
    'CONTRACTOR_ACCEPTED',     -- contractor accepted the dispatch
    'CONTRACTOR_DECLINED',     -- contractor declined the dispatch
    'CONFIRMED',               -- booking confirmed with customer
    'CANCELLED',               -- cancelled by customer/ops
    'EXPIRED_REVERTED'         -- terminal marker retained for audit queries;
                                -- the *live* revert target is PENDING_ACCEPTANCE
                                -- (see REQ-OPS-TIMEOUT-09) — this value exists so
                                -- history rows can be distinguished from a normal
                                -- PENDING_ACCEPTANCE created at intake time.
);

CREATE TYPE whatsapp_intent_state AS ENUM (
    'ACCEPT',
    'DECLINE',
    'NEEDS_CLARIFICATION'
);

-- -----------------------------------------------------------------------------
-- service_catalogue — canonical service durations, source of truth for the
-- boundary validator (REQ-INTK-VALID-05).
-- -----------------------------------------------------------------------------

CREATE TABLE service_catalogue (
    service_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL,
    duration_minutes  INTEGER NOT NULL,
    active            BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_service_duration_positive
        CHECK (duration_minutes > 0 AND duration_minutes <= 480)
);

-- -----------------------------------------------------------------------------
-- appointments — the row this whole subsystem fights over. `version` backs
-- optimistic-lock defense-in-depth on top of SELECT ... FOR UPDATE row locks.
-- -----------------------------------------------------------------------------

CREATE TABLE appointments (
    appointment_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    billing_code      VARCHAR(14) NOT NULL UNIQUE,
    customer_id       UUID NOT NULL,
    service_id        UUID NOT NULL REFERENCES service_catalogue (service_id),
    contractor_id     UUID,                     -- NULL until dispatched
    start_time        TIMESTAMPTZ NOT NULL,
    end_time          TIMESTAMPTZ NOT NULL,
    status            appointment_status NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    dispatched_at     TIMESTAMPTZ,               -- set on transition into
                                                   -- CONTRACTOR_DISPATCHED; the
                                                   -- timeout sweep scans this.
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_billing_code_format
        CHECK (billing_code ~ '^FL-[0-9]{6}-[A-Z0-9]{4}$'),
    CONSTRAINT chk_end_after_start
        CHECK (end_time > start_time),
    CONSTRAINT chk_dispatched_at_requires_dispatch_status
        CHECK (
            (status = 'CONTRACTOR_DISPATCHED' AND dispatched_at IS NOT NULL)
            OR status <> 'CONTRACTOR_DISPATCHED'
        )
);

-- Partial index: the timeout sweep's only query shape is
-- "status = CONTRACTOR_DISPATCHED AND dispatched_at < cutoff". A partial
-- index keeps this O(dispatched rows) instead of O(all appointments) as the
-- table grows.
CREATE INDEX idx_appointments_dispatch_scan
    ON appointments (dispatched_at)
    WHERE status = 'CONTRACTOR_DISPATCHED';

CREATE INDEX idx_appointments_customer ON appointments (customer_id);
CREATE INDEX idx_appointments_service ON appointments (service_id);

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_appointments_updated_at
    BEFORE UPDATE ON appointments
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

-- -----------------------------------------------------------------------------
-- appointment_status_history — append-only audit trail. One row per
-- transition. Used by the concurrency stress test to assert that a
-- CONTRACTOR_DISPATCHED row transitions exactly once, never twice, when the
-- timeout sweep and an acceptance webhook race on the same row.
-- -----------------------------------------------------------------------------

CREATE TABLE appointment_status_history (
    history_id         BIGSERIAL PRIMARY KEY,
    appointment_id      UUID NOT NULL REFERENCES appointments (appointment_id),
    from_status         appointment_status,
    to_status           appointment_status NOT NULL,
    version_at_change   INTEGER NOT NULL,
    changed_by          TEXT NOT NULL,   -- e.g. 'SYSTEM_TIMEOUT_SWEEP',
                                          -- 'WEBHOOK:<contractor_id>'
    reason              TEXT,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_status_history_appointment
    ON appointment_status_history (appointment_id, changed_at);

-- -----------------------------------------------------------------------------
-- whatsapp_inbound_events — raw + parsed record of every inbound webhook
-- payload, whether or not it resolved to a clean state mutation
-- (REQ-WHATSAPP-PARSER-02). NEEDS_CLARIFICATION rows are exactly the manual
-- review queue.
-- -----------------------------------------------------------------------------

CREATE TABLE whatsapp_inbound_events (
    event_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    raw_text              TEXT NOT NULL,
    normalized_text       TEXT NOT NULL,
    parsed_billing_code   VARCHAR(14),
    parsed_intent         whatsapp_intent_state NOT NULL,
    appointment_id        UUID REFERENCES appointments (appointment_id),
    matched               BOOLEAN NOT NULL DEFAULT FALSE,
    applied               BOOLEAN NOT NULL DEFAULT FALSE, -- true only once the
                                                            -- parsed intent was
                                                            -- actually used to
                                                            -- mutate appointment
                                                            -- state
    received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at           TIMESTAMPTZ,
    processing_notes       TEXT,

    CONSTRAINT chk_billing_code_format_if_present
        CHECK (
            parsed_billing_code IS NULL
            OR parsed_billing_code ~ '^FL-[0-9]{6}-[A-Z0-9]{4}$'
        ),
    CONSTRAINT chk_applied_requires_match
        CHECK (NOT applied OR (matched AND parsed_intent <> 'NEEDS_CLARIFICATION'))
);

CREATE INDEX idx_whatsapp_events_billing_code
    ON whatsapp_inbound_events (parsed_billing_code);
CREATE INDEX idx_whatsapp_events_needs_clarification
    ON whatsapp_inbound_events (received_at)
    WHERE parsed_intent = 'NEEDS_CLARIFICATION';

COMMIT;
