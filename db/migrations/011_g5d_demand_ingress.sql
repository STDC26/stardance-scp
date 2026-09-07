-- =============================================================================
-- SCP-G5-D-01 — customer demand ingress.
-- Migration 011. Additive over 002-010. No Core object is altered.
--
-- WHAT THIS IS NOT: a second booking authority. Canonical demand truth stays in
-- core_service_request and core_service_request_version, written by the existing
-- Core module. Nothing here duplicates a request's state, price, duration or
-- lifecycle position, and no lifecycle decision ever reads these tables as
-- authority.
--
-- WHAT THIS IS: two additive records that make governed ingress checkable.
--
--   core_catalogue_binding  the mapping from a GOVERNED CONFIGURATION catalogue
--                           code to the canonical Core catalogue identity it was
--                           projected into. Without it, "the customer surface is
--                           governed by configuration" would be a claim rather
--                           than a join. It also carries the provenance of the
--                           duration governing exclusive capacity, so an
--                           engineering assumption cannot quietly become a
--                           ratified business fact (R16).
--
--   core_demand_ingress     the customer-context envelope Core deliberately does
--                           not model — region, accommodation type, locale,
--                           contact, source channel — plus the idempotency key
--                           and fingerprint that make a replay recognisable.
--                           Append-only, one row per accepted canonical request.
--
-- Every row carries tenant / market / environment lineage, enforced by NOT NULL
-- plus a non-empty CHECK rather than by convention.
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- Governed configuration catalogue -> canonical Core catalogue
-- -----------------------------------------------------------------------------

CREATE TABLE core_catalogue_binding (
    binding_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    -- The stable configuration identity. Display names are never authoritative
    -- and are deliberately absent here.
    kind         TEXT NOT NULL,
    service_code TEXT NOT NULL,
    extra_code   TEXT,

    -- The canonical Core rows this configuration item was projected into.
    service_id   UUID NOT NULL REFERENCES core_service (service_id),
    addon_id     UUID REFERENCES core_service_addon (addon_id),

    -- R16: where the duration governing exclusive capacity came from. A value
    -- declared as an engineering assumption in the bundle's _meta stays declared
    -- as one here; projecting it must not ratify it.
    duration_provenance TEXT NOT NULL,

    -- Which governed configuration version produced this binding.
    projected_from_version  INTEGER NOT NULL,
    projected_from_checksum TEXT NOT NULL,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_catalogue_binding_kind
        CHECK (kind IN ('SERVICE', 'EXTRA')),

    -- A SERVICE binding names no extra and no add-on; an EXTRA binding names
    -- both. The two shapes cannot be confused.
    CONSTRAINT chk_catalogue_binding_shape
        CHECK ((kind = 'SERVICE' AND extra_code IS NULL AND addon_id IS NULL)
            OR (kind = 'EXTRA'   AND extra_code IS NOT NULL AND addon_id IS NOT NULL)),

    CONSTRAINT chk_catalogue_binding_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),

    CONSTRAINT chk_catalogue_binding_provenance
        CHECK (duration_provenance IN ('CC_SUPPLIED_UNCONFIRMED', 'HUMAN_CONFIRMED'))
);

-- One binding per configuration item per scope. Re-projection updates in place;
-- it never accumulates competing mappings for the same code.
CREATE UNIQUE INDEX uq_catalogue_binding
    ON core_catalogue_binding
       (tenant_id, market_id, environment, service_code, COALESCE(extra_code, ''));

CREATE INDEX idx_catalogue_binding_scope
    ON core_catalogue_binding (tenant_id, market_id, environment, kind);

-- -----------------------------------------------------------------------------
-- Customer demand ingress — append-only
-- -----------------------------------------------------------------------------

CREATE TABLE core_demand_ingress (
    ingress_id   BIGSERIAL PRIMARY KEY,

    -- The canonical Service Request this intent became. NOT NULL: an ingress row
    -- without a canonical request would be a second demand authority.
    request_id   UUID NOT NULL REFERENCES core_service_request (request_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    -- Which governed configuration was in force when this intent was accepted.
    configuration_version  INTEGER NOT NULL,
    configuration_checksum TEXT NOT NULL,

    -- Server-generated or server-validated. Unique per scope.
    idempotency_key    TEXT NOT NULL,
    -- Deterministic digest of the materially-identifying intent. A reused key
    -- carrying different intent is a conflict, not a replay.
    request_fingerprint TEXT NOT NULL,

    source_channel TEXT NOT NULL,
    locale         TEXT NOT NULL,

    -- Configuration catalogue identity, retained alongside the canonical
    -- service_id on the request so the governing codes stay legible.
    service_code   TEXT NOT NULL,
    extra_codes    TEXT[] NOT NULL DEFAULT '{}',

    -- Customer context Core does not model.
    service_region     TEXT NOT NULL,
    accommodation_type TEXT,

    customer_display_name   TEXT NOT NULL,
    customer_contact_handle TEXT NOT NULL,
    customer_identity_id    UUID NOT NULL REFERENCES core_identity (identity_id),

    -- What the customer selected, in market-local terms, plus the instant the
    -- server resolved it to. The client never supplies an instant.
    requested_local_date DATE NOT NULL,
    requested_local_time TEXT NOT NULL,
    requested_start_time TIMESTAMPTZ NOT NULL,

    -- Server clock. Authoritative; a client-supplied time is never accepted.
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_demand_ingress_idempotency
        UNIQUE (tenant_id, market_id, environment, idempotency_key),

    CONSTRAINT chk_demand_ingress_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),

    CONSTRAINT chk_demand_ingress_local_time
        CHECK (requested_local_time ~ '^[0-2][0-9]:[0-5][0-9]$'),

    CONSTRAINT chk_demand_ingress_contact
        CHECK (length(btrim(customer_contact_handle)) > 0),

    CONSTRAINT chk_demand_ingress_configuration
        CHECK (configuration_version >= 1 AND length(btrim(configuration_checksum)) = 64)
);

CREATE INDEX idx_demand_ingress_scope
    ON core_demand_ingress (tenant_id, market_id, environment, server_received_at);

CREATE INDEX idx_demand_ingress_request
    ON core_demand_ingress (request_id);

-- Append-only. An accepted intent is history: correcting it is a governed
-- amendment against the canonical request, never a rewrite of what arrived.
CREATE OR REPLACE FUNCTION core_demand_ingress_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'core_demand_ingress is append-only (ingress_id=%); amend the canonical service request instead',
        OLD.ingress_id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_demand_ingress_append_only
    BEFORE UPDATE OR DELETE ON core_demand_ingress
    FOR EACH ROW
    EXECUTE FUNCTION core_demand_ingress_append_only();

COMMIT;
