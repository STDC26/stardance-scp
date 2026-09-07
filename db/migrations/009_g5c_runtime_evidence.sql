-- =============================================================================
-- SCP-G5-C-01 — runtime evidence.
-- Migration 009. Additive over 002-008. No Core object is altered.
--
-- Normalized evidence of what the RUNTIME did: which configuration it resolved,
-- which identity it resolved, whether persistence was compatible, and what
-- adapters attempted. This is operational evidence, NOT business truth —
-- canonical SCP events and records remain the measurement authority, and
-- nothing here is read back as authority for a lifecycle decision.
--
-- Every row carries tenant / market / environment lineage, which is what makes
-- the lineage requirement checkable rather than asserted.
-- =============================================================================

BEGIN;

CREATE TYPE runtime_evidence_kind AS ENUM (
    'RUNTIME_START',
    'CONFIGURATION_RESOLVED',
    'CONFIGURATION_REFUSED',
    'IDENTITY_RESOLVED',
    'IDENTITY_REFUSED',
    'PERSISTENCE_VERIFIED',
    'PERSISTENCE_REFUSED',
    'ADAPTER_ATTEMPT',
    'ADAPTER_RESULT'
);

CREATE TABLE core_runtime_evidence (
    evidence_id           BIGSERIAL PRIMARY KEY,
    kind                  runtime_evidence_kind NOT NULL,

    -- Mandatory lineage. Not nullable: evidence without lineage would be
    -- unattributable, which defeats the point of recording it.
    tenant_id             TEXT NOT NULL,
    market_id             TEXT NOT NULL,
    environment           TEXT NOT NULL,

    -- Which governed configuration was in force, where applicable.
    configuration_version INTEGER,
    configuration_checksum TEXT,

    outcome               TEXT NOT NULL,
    reason_code           TEXT,
    detail                JSONB NOT NULL DEFAULT '{}'::jsonb,
    occurred_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_runtime_evidence_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    CONSTRAINT chk_runtime_evidence_outcome
        CHECK (outcome IN ('OK', 'REFUSED'))
);

CREATE INDEX idx_runtime_evidence_scope
    ON core_runtime_evidence (tenant_id, market_id, environment, occurred_at);

CREATE INDEX idx_runtime_evidence_kind ON core_runtime_evidence (kind, occurred_at);

COMMIT;
