-- =============================================================================
-- SCP-G5-F-01 — Owner qualification of a customer request.
-- Migration 015. Additive over 002-014. No Core object is altered.
--
-- WHY THIS EXISTS AT ALL. Every other step of the Freshline operational journey
-- already has a canonical home: dispatch in core_dispatch_offer, acceptance in
-- the dispatch attempt, assignment in core_assignment, confirmation in the
-- confirmation context, fulfillment in core_fulfillment. Qualification — the
-- Owner's judgement that a request is serviceable, needs clarification, or is
-- not serviceable — had none.
--
-- So this is not a second copy of an authority that lives elsewhere. It is the
-- ONE place that decision is recorded, and it is written only through the G4
-- orchestrator, which supplies predecessor validation, actor attribution,
-- idempotency and audit. There is no second write path.
--
-- WHAT IT IS NOT: a lifecycle state. Qualification does not move
-- core_service_request.state and this table is never consulted to answer "what
-- state is this request in". A SERVICEABLE request stays at PENDING_ACCEPTANCE
-- and becomes eligible for the Owner to dispatch; an UNSERVICEABLE one is
-- declined through the existing CANCEL_SERVICE lifecycle action, which is what
-- actually moves the request. Recording a judgement and moving a request are
-- deliberately two different acts.
--
-- Append-only: a changed judgement is a new decision, so the sequence of what
-- an Owner concluded and when stays reconstructable.
-- =============================================================================

BEGIN;

CREATE TYPE request_qualification_outcome AS ENUM (
    -- Serviceable. The request may proceed to matching. It is NOT matched,
    -- offered, assigned or confirmed by this outcome.
    'SERVICEABLE',
    -- More information is needed. The request deliberately stays exactly where
    -- it is; clarification must not look like progress.
    'CLARIFICATION_REQUIRED',
    -- Not serviceable. The judgement is recorded here; the request is moved by
    -- the existing governed cancellation action, not by this row.
    'UNSERVICEABLE'
);

CREATE TABLE core_request_qualification (
    qualification_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id       UUID NOT NULL REFERENCES core_service_request (request_id),

    tenant_id        TEXT NOT NULL,
    market_id        TEXT NOT NULL,

    -- Monotonic per request. The current judgement is the highest sequence;
    -- there is no mutable "current" flag to fall out of step with it.
    sequence         INTEGER NOT NULL,
    outcome          request_qualification_outcome NOT NULL,
    reason_code      TEXT,
    note             TEXT,

    -- The canonical state the request was in when the judgement was made, so a
    -- later reader can see the judgement was made against what they think.
    observed_state   service_request_state NOT NULL,

    decided_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    -- The governed action envelope this decision was recorded under, joinable to
    -- core_operational_action on (tenant_id, idempotency_key) — which that table
    -- already declares unique. Not nullable: a qualification with no governed
    -- action behind it would be exactly the second write path this table must
    -- not have.
    --
    -- A key rather than a foreign key because the orchestrator persists its
    -- action AFTER the handler runs; a hard FK would have forced the write
    -- order to change, and distorting a proven G4 flow to satisfy a new table
    -- is the wrong way round.
    action_idempotency_key TEXT NOT NULL,
    decided_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_request_qualification_sequence UNIQUE (request_id, sequence),
    CONSTRAINT chk_request_qualification_sequence CHECK (sequence >= 1),
    CONSTRAINT chk_request_qualification_lineage
        CHECK (length(btrim(tenant_id)) > 0 AND length(btrim(market_id)) > 0),
    -- An unserviceable judgement must say why. A serviceable one need not.
    CONSTRAINT chk_request_qualification_reason
        CHECK (outcome <> 'UNSERVICEABLE' OR length(btrim(coalesce(reason_code, ''))) > 0),
    CONSTRAINT chk_request_qualification_action
        CHECK (length(btrim(action_idempotency_key)) > 0)
);

CREATE INDEX idx_request_qualification_current
    ON core_request_qualification (request_id, sequence DESC);

CREATE INDEX idx_request_qualification_scope
    ON core_request_qualification (tenant_id, market_id, outcome, decided_at);

-- Append-only. A changed judgement is a NEW decision; rewriting one would erase
-- the fact that an Owner once concluded otherwise.
CREATE OR REPLACE FUNCTION core_request_qualification_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'core_request_qualification is append-only (qualification_id=%); record a new qualification instead',
        OLD.qualification_id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_request_qualification_append_only
    BEFORE UPDATE OR DELETE ON core_request_qualification
    FOR EACH ROW
    EXECUTE FUNCTION core_request_qualification_append_only();

COMMIT;
