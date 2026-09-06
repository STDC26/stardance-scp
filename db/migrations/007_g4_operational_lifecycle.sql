-- =============================================================================
-- SCP-G4-EXEC-01 — Service Lifecycle Orchestration & Operational Execution.
-- Migration 007. Additive over 002-006; no G1/G2/G3 object is redesigned.
--
-- OWNERSHIP. The lifecycle aggregate remains core_service_request. Nothing here
-- is a second Booking / Appointment / Order / Job lifecycle. Every object below
-- is either a command envelope or versioned durable EVIDENCE about how the one
-- canonical lifecycle moved:
--
--   core_operational_action       command envelope + idempotency + audit
--   core_dispatch_offer           DispatchAttempt   (existing owner, versioned)
--   core_assignment               ProviderAssignment(existing owner, versioned)
--   core_customer_confirmation    ConfirmationContext(existing owner, versioned)
--   core_operational_recovery     recovery evidence, NOT a lifecycle owner
--
-- The three existing tables are widened in place. A parallel dispatch,
-- assignment or confirmation table would be exactly the competing truth the
-- frozen contract forbids.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Enumerations
-- -----------------------------------------------------------------------------

CREATE TYPE operational_action_outcome AS ENUM ('ACCEPTED', 'REFUSED');

CREATE TYPE assignment_status AS ENUM ('ACTIVE', 'REPLACED', 'REVOKED');

CREATE TYPE confirmation_context_status AS ENUM (
    'PENDING',
    'CONFIRMED',
    'EXPIRED',
    'SUPERSEDED',
    'WITHDRAWN'
);

CREATE TYPE operational_recovery_status AS ENUM (
    'OPEN',
    'RECOVERED_WITHIN_COMMITMENT',
    'AMENDMENT_REQUIRED',
    'TERMINAL_UNABLE_TO_FULFILL',
    'CANCELLED'
);

-- -----------------------------------------------------------------------------
-- OperationalAction — governed transaction command envelope
-- -----------------------------------------------------------------------------

CREATE TABLE core_operational_action (
    action_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           TEXT NOT NULL,
    market_id           TEXT NOT NULL,
    request_id          UUID NOT NULL REFERENCES core_service_request (request_id),
    action_type         TEXT NOT NULL,
    outcome             operational_action_outcome NOT NULL,
    -- Machine-readable refusal. NULL only when the action was ACCEPTED.
    reason_code         TEXT,
    from_state          TEXT,
    to_state            TEXT,
    actor_identity_id   UUID REFERENCES core_identity (identity_id),
    actor_role          scp_role NOT NULL,
    actor_authority     TEXT NOT NULL,
    -- Idempotency is (tenant, key); the fingerprint distinguishes an honest
    -- replay from a key reused for materially different work.
    idempotency_key     TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    payload             JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_action_reason_presence
        CHECK ((outcome = 'ACCEPTED') = (reason_code IS NULL)),
    -- The database is the final idempotency backstop, not the application.
    CONSTRAINT uq_action_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_action_request ON core_operational_action (request_id, created_at);
CREATE INDEX idx_action_type ON core_operational_action (action_type, outcome);

-- -----------------------------------------------------------------------------
-- DispatchAttempt — versioning on the existing dispatch owner
-- -----------------------------------------------------------------------------

ALTER TABLE core_dispatch_offer ADD COLUMN attempt_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE core_dispatch_offer ADD COLUMN superseded_by UUID REFERENCES core_dispatch_offer (offer_id);

ALTER TABLE core_dispatch_offer
    ADD CONSTRAINT chk_dispatch_attempt_version CHECK (attempt_version >= 1);

-- One attempt may be current per request. Monotonic versioning makes "which
-- attempt is the exact current one" answerable without inference.
CREATE UNIQUE INDEX uq_dispatch_attempt_version
    ON core_dispatch_offer (request_id, attempt_version);

-- G2's chk_offer_decided_consistency asserted decided_at is set iff the state
-- is ACCEPTED or DECLINED. SUPERSEDED is also a decided-by-the-system outcome
-- that needs to record when it happened, so the constraint is restated rather
-- than leaving a terminal state unable to timestamp itself.
ALTER TABLE core_dispatch_offer DROP CONSTRAINT chk_offer_decided_consistency;
ALTER TABLE core_dispatch_offer
    ADD CONSTRAINT chk_offer_decided_consistency
    CHECK ((state IN ('ACCEPTED', 'DECLINED', 'SUPERSEDED')) = (decided_at IS NOT NULL));

-- -----------------------------------------------------------------------------
-- ProviderAssignment — versioned operational responsibility
-- -----------------------------------------------------------------------------

ALTER TABLE core_assignment ADD COLUMN status assignment_status NOT NULL DEFAULT 'ACTIVE';
ALTER TABLE core_assignment ADD COLUMN assignment_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE core_assignment ADD COLUMN replaced_by UUID REFERENCES core_assignment (assignment_id);

ALTER TABLE core_assignment
    ADD CONSTRAINT chk_assignment_version CHECK (assignment_version >= 1);

-- Exactly one ACTIVE assignment per Service Request. Replacing the index that
-- keyed on revoked_at: status is now the authoritative discriminator, and a
-- REPLACED assignment is not revoked, it is superseded.
DROP INDEX uq_assignment_single_active;
CREATE UNIQUE INDEX uq_assignment_single_active
    ON core_assignment (request_id) WHERE status = 'ACTIVE';

CREATE UNIQUE INDEX uq_assignment_version
    ON core_assignment (request_id, assignment_version);

-- -----------------------------------------------------------------------------
-- CustomerConfirmationContext — versioned, bound to assignment + commitment
-- -----------------------------------------------------------------------------

ALTER TABLE core_customer_confirmation
    ADD COLUMN status confirmation_context_status NOT NULL DEFAULT 'CONFIRMED';
ALTER TABLE core_customer_confirmation ADD COLUMN context_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE core_customer_confirmation
    ADD COLUMN assignment_id UUID REFERENCES core_assignment (assignment_id);
ALTER TABLE core_customer_confirmation ADD COLUMN expires_at TIMESTAMPTZ;

-- A PENDING context has nobody who has confirmed it yet. The G2 default of
-- now() is retained so existing G2 inserts behave exactly as before; G4 writes
-- NULL explicitly when opening a pending context.
ALTER TABLE core_customer_confirmation ALTER COLUMN confirmed_at DROP NOT NULL;
ALTER TABLE core_customer_confirmation ALTER COLUMN confirmed_by_identity_id DROP NOT NULL;

-- A PENDING context has nobody who has confirmed it, and a CONFIRMED one must
-- name its confirmer. The terminal statuses are deliberately unconstrained:
-- a SUPERSEDED or WITHDRAWN context that WAS confirmed keeps the identity of
-- whoever confirmed it, because erasing that would destroy the audit trail of
-- consent that was genuinely given and later invalidated.
ALTER TABLE core_customer_confirmation
    ADD CONSTRAINT chk_confirmation_pending_has_no_confirmer
    CHECK (status <> 'PENDING' OR confirmed_by_identity_id IS NULL);

ALTER TABLE core_customer_confirmation
    ADD CONSTRAINT chk_confirmation_confirmed_has_confirmer
    CHECK (status <> 'CONFIRMED' OR confirmed_by_identity_id IS NOT NULL);

ALTER TABLE core_customer_confirmation
    ADD CONSTRAINT chk_confirmation_context_version CHECK (context_version >= 1);

-- One live context per request: PENDING or CONFIRMED, never both.
DROP INDEX uq_confirmation_single_active;
CREATE UNIQUE INDEX uq_confirmation_single_active
    ON core_customer_confirmation (request_id)
    WHERE status IN ('PENDING', 'CONFIRMED');

CREATE UNIQUE INDEX uq_confirmation_context_version
    ON core_customer_confirmation (request_id, context_version);

-- -----------------------------------------------------------------------------
-- OperationalRecovery — durable recovery evidence, never the lifecycle owner
-- -----------------------------------------------------------------------------

CREATE TABLE core_operational_recovery (
    recovery_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      TEXT NOT NULL,
    market_id      TEXT NOT NULL,
    request_id     UUID NOT NULL REFERENCES core_service_request (request_id),
    status         operational_recovery_status NOT NULL DEFAULT 'OPEN',
    trigger_reason TEXT NOT NULL,
    -- Set only when recovery concluded that the customer-facing commitment
    -- materially changed and a canonical Amendment was required.
    amendment_id   UUID REFERENCES core_amendment (amendment_id),
    opened_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ,
    resolution     TEXT,
    payload        JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT chk_recovery_resolution_consistency
        CHECK ((status = 'OPEN') = (resolved_at IS NULL))
);

CREATE INDEX idx_recovery_request ON core_operational_recovery (request_id, opened_at);

-- At most one open recovery per request, so "what is being recovered" is never
-- ambiguous.
CREATE UNIQUE INDEX uq_recovery_single_open
    ON core_operational_recovery (request_id) WHERE status = 'OPEN';

COMMIT;
