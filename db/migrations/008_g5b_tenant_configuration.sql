-- =============================================================================
-- SCP-G5-B-01 — Freshline tenant / market / catalogue / policy configuration.
-- Migration 008. Additive over 002-007. No Core object is altered.
--
-- This is the configuration PLANE, not Core. Nothing in src/core, src/kernel or
-- src/lifecycle reads these tables; they hold governed tenant configuration so
-- that Freshline-specific brand, market, catalogue, commerce, operations and
-- experience values never become reusable Core constants.
--
-- Bundles are immutable once written. A change is a NEW VERSION, and rollback
-- reactivates a previously proven version rather than rewriting history — so a
-- historical transaction stays interpretable against the configuration that was
-- active when its governed event occurred.
-- =============================================================================

BEGIN;

CREATE TYPE configuration_state AS ENUM (
    'DRAFT',
    'VALIDATED',
    'APPROVED',
    'ACTIVE',
    'SUPERSEDED',
    'REJECTED'
);

CREATE TABLE core_tenant_configuration (
    configuration_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id             TEXT NOT NULL,
    market_id             TEXT NOT NULL,
    environment           TEXT NOT NULL,
    configuration_version INTEGER NOT NULL,
    schema_version        TEXT NOT NULL,
    state                 configuration_state NOT NULL DEFAULT 'DRAFT',

    -- The bundle and its deterministic identity. Immutable, enforced below.
    bundle                JSONB NOT NULL,
    checksum              TEXT NOT NULL,

    -- Provenance.
    predecessor_version   INTEGER,
    actor_or_authority    TEXT NOT NULL,
    source_reference      TEXT NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    activated_at          TIMESTAMPTZ,
    superseded_at         TIMESTAMPTZ,

    CONSTRAINT chk_configuration_version CHECK (configuration_version >= 1),
    CONSTRAINT chk_configuration_checksum CHECK (checksum ~ '^[0-9a-f]{64}$'),
    CONSTRAINT chk_configuration_activated_consistency
        CHECK ((state IN ('ACTIVE', 'SUPERSEDED')) = (activated_at IS NOT NULL)),
    CONSTRAINT chk_configuration_predecessor
        CHECK (predecessor_version IS NULL OR predecessor_version < configuration_version),

    CONSTRAINT uq_configuration_version
        UNIQUE (tenant_id, market_id, environment, configuration_version)
);

-- At most one ACTIVE configuration per tenant/market/environment. Activation is
-- therefore atomic by construction: a second activation cannot coexist.
CREATE UNIQUE INDEX uq_configuration_single_active
    ON core_tenant_configuration (tenant_id, market_id, environment)
    WHERE state = 'ACTIVE';

CREATE INDEX idx_configuration_lookup
    ON core_tenant_configuration (tenant_id, market_id, environment, configuration_version);

CREATE INDEX idx_configuration_checksum ON core_tenant_configuration (checksum);

-- A persisted bundle is evidence. Lifecycle columns move; content never does.
CREATE OR REPLACE FUNCTION core_tenant_configuration_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.bundle IS DISTINCT FROM OLD.bundle
       OR NEW.checksum IS DISTINCT FROM OLD.checksum
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.market_id IS DISTINCT FROM OLD.market_id
       OR NEW.environment IS DISTINCT FROM OLD.environment
       OR NEW.configuration_version IS DISTINCT FROM OLD.configuration_version
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version THEN
        RAISE EXCEPTION
            'core_tenant_configuration content is immutable (configuration_id=%); publish a new version instead',
            OLD.configuration_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_tenant_configuration_immutable
    BEFORE UPDATE ON core_tenant_configuration
    FOR EACH ROW
    EXECUTE FUNCTION core_tenant_configuration_immutable();

-- Append-only record of every activation and rollback, so the configuration
-- timeline is reconstructable independently of current state.
CREATE TABLE core_tenant_configuration_event (
    event_id           BIGSERIAL PRIMARY KEY,
    configuration_id   UUID NOT NULL REFERENCES core_tenant_configuration (configuration_id),
    tenant_id          TEXT NOT NULL,
    market_id          TEXT NOT NULL,
    environment        TEXT NOT NULL,
    from_state         configuration_state,
    to_state           configuration_state NOT NULL,
    actor_or_authority TEXT NOT NULL,
    reason             TEXT,
    occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_configuration_event_scope
    ON core_tenant_configuration_event (tenant_id, market_id, environment, occurred_at);

COMMIT;
