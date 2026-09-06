-- =============================================================================
-- SCP-G3-EXEC-01 — Service-Commerce Kernel.
-- Migration 005. Additive over 002/003/004; no G2 object is redesigned.
--
-- Governing question: "Can this service be sold, here, for this customer, at
-- this time, under these operating rules?"
--
-- OWNERSHIP (one concept -> one owner):
--   core_commerce_evaluation  G3 kernel decision record
--   core_sellable_offer       G3 canonical pre-commit commercial aggregate
--   core_capacity_hold        EXISTING G2 capacity owner, widened here
--   core_service_request      EXISTING G2 canonical commitment target
--
-- No booking/order/appointment system of record is created. Commitment always
-- lands in core_service_request.
-- =============================================================================

BEGIN;

CREATE TYPE fulfillment_topology AS ENUM ('MOBILE', 'INSTORE', 'HYBRID');

CREATE TYPE sellable_offer_state AS ENUM (
    'ACTIVE',
    'COMMITTED',
    'EXPIRED',
    'INVALIDATED',
    'SUPERSEDED'
);

CREATE TYPE commerce_evaluation_outcome AS ENUM (
    'SELLABLE',
    'NOT_SELLABLE',
    'REQUIRES_ALTERNATIVE'
);

-- -----------------------------------------------------------------------------
-- Topology, location, service area — the "here" half of the kernel question
-- -----------------------------------------------------------------------------

-- Which topologies a service may be sold through. Absence is a refusal, not a
-- default: a service with no row here is not sellable in any topology.
CREATE TABLE core_service_topology (
    service_id UUID NOT NULL REFERENCES core_service (service_id),
    topology   fulfillment_topology NOT NULL,
    PRIMARY KEY (service_id, topology)
);

CREATE TABLE core_location (
    location_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   TEXT NOT NULL,
    market_id   TEXT NOT NULL,
    name        TEXT NOT NULL,
    timezone    TEXT NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_location_scope ON core_location (tenant_id, market_id, active);

-- Location operating policy, distinct from provider availability and from the
-- market-level business policy in config/<marketId>.market.json.
CREATE TABLE core_location_hours (
    location_hours_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id       UUID NOT NULL REFERENCES core_location (location_id),
    -- 0 = Sunday .. 6 = Saturday, evaluated in the location's own timezone.
    weekday           SMALLINT NOT NULL,
    open_minute       INTEGER NOT NULL,
    close_minute      INTEGER NOT NULL,

    CONSTRAINT chk_location_weekday CHECK (weekday BETWEEN 0 AND 6),
    CONSTRAINT chk_location_minutes
        CHECK (open_minute >= 0 AND close_minute <= 1440 AND close_minute > open_minute),
    CONSTRAINT uq_location_weekday UNIQUE (location_id, weekday)
);

-- MOBILE serviceability. A destination outside every active area for the
-- tenant/market is LOCATION_NOT_SERVICEABLE.
CREATE TABLE core_service_area (
    service_area_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    market_id       TEXT NOT NULL,
    area_key        TEXT NOT NULL,
    active          BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT uq_service_area UNIQUE (tenant_id, market_id, area_key)
);

-- -----------------------------------------------------------------------------
-- Resources — the exclusive things a service consumes besides the provider
-- -----------------------------------------------------------------------------

CREATE TABLE core_resource (
    resource_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     TEXT NOT NULL,
    market_id     TEXT NOT NULL,
    location_id   UUID REFERENCES core_location (location_id),
    resource_kind TEXT NOT NULL,
    name          TEXT NOT NULL,
    active        BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX idx_resource_lookup ON core_resource (tenant_id, market_id, resource_kind, active);

CREATE TABLE core_service_resource_requirement (
    service_id    UUID NOT NULL REFERENCES core_service (service_id),
    resource_kind TEXT NOT NULL,
    PRIMARY KEY (service_id, resource_kind)
);

-- -----------------------------------------------------------------------------
-- Provider eligibility — distinct from provider availability (core_capacity_window)
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_service (
    provider_id UUID NOT NULL REFERENCES core_provider (provider_id),
    service_id  UUID NOT NULL REFERENCES core_service (service_id),
    PRIMARY KEY (provider_id, service_id)
);

CREATE TABLE core_provider_location (
    provider_id UUID NOT NULL REFERENCES core_provider (provider_id),
    location_id UUID NOT NULL REFERENCES core_location (location_id),
    PRIMARY KEY (provider_id, location_id)
);

-- -----------------------------------------------------------------------------
-- ServiceCommerceEvaluation — the governed decision record
-- -----------------------------------------------------------------------------

CREATE TABLE core_commerce_evaluation (
    evaluation_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            TEXT NOT NULL,
    market_id            TEXT NOT NULL,
    topology             fulfillment_topology NOT NULL,
    outcome              commerce_evaluation_outcome NOT NULL,
    -- Machine-readable refusal. NULL only when the outcome is SELLABLE.
    reason_code          TEXT,
    service_id           UUID REFERENCES core_service (service_id),
    customer_identity_id UUID REFERENCES core_identity (identity_id),
    requested_start      TIMESTAMPTZ,
    -- The effective-time context the decision was made against. Determinism is
    -- defined relative to this, not to wall clock.
    effective_at         TIMESTAMPTZ NOT NULL,
    -- Durable provenance: the exact authoritative inputs, the configuration
    -- that governed, and what was decided. Replay reads these, not live state.
    inputs_snapshot      JSONB NOT NULL,
    config_snapshot      JSONB NOT NULL,
    decision_snapshot    JSONB NOT NULL,
    alternatives         JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_evaluation_reason_presence
        CHECK ((outcome = 'SELLABLE') = (reason_code IS NULL))
);

CREATE INDEX idx_evaluation_scope
    ON core_commerce_evaluation (tenant_id, market_id, created_at);

-- -----------------------------------------------------------------------------
-- SellableOffer — immutable, versioned, pre-commit commercial aggregate
-- -----------------------------------------------------------------------------

CREATE TABLE core_sellable_offer (
    offer_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id            TEXT NOT NULL,
    market_id            TEXT NOT NULL,
    topology             fulfillment_topology NOT NULL,
    -- Offer identity is (offer_key, version): a supersession keeps the key and
    -- increments the version, so lineage is explicit rather than inferred.
    offer_key            UUID NOT NULL,
    version              INTEGER NOT NULL,
    state                sellable_offer_state NOT NULL DEFAULT 'ACTIVE',

    evaluation_id        UUID NOT NULL REFERENCES core_commerce_evaluation (evaluation_id),
    customer_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    service_id           UUID NOT NULL REFERENCES core_service (service_id),
    provider_id          UUID NOT NULL REFERENCES core_provider (provider_id),
    location_id          UUID REFERENCES core_location (location_id),
    service_area_key     TEXT,

    -- Immutable commercial snapshot. Canonical, never client-supplied.
    start_time           TIMESTAMPTZ NOT NULL,
    end_time             TIMESTAMPTZ NOT NULL,
    duration_minutes     INTEGER NOT NULL,
    price_minor_units    BIGINT NOT NULL,
    currency_code        TEXT NOT NULL,
    price_version_id     UUID NOT NULL REFERENCES core_service_price_version (price_version_id),
    addons_snapshot      JSONB NOT NULL DEFAULT '[]'::jsonb,
    duration_basis       JSONB NOT NULL,
    config_provenance    JSONB NOT NULL,

    -- Fingerprint of the materially-identifying request, so a replayed
    -- idempotency key can be told apart from a reused one.
    request_fingerprint  TEXT NOT NULL,
    idempotency_key      TEXT NOT NULL,

    expires_at           TIMESTAMPTZ NOT NULL,
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_by        UUID REFERENCES core_sellable_offer (offer_id),
    committed_request_id UUID REFERENCES core_service_request (request_id),

    CONSTRAINT chk_offer_window CHECK (end_time > start_time),
    CONSTRAINT chk_offer_duration CHECK (duration_minutes > 0),
    CONSTRAINT chk_offer_price CHECK (price_minor_units >= 0),
    CONSTRAINT chk_offer_version CHECK (version >= 1),
    CONSTRAINT uq_offer_key_version UNIQUE (offer_key, version),
    -- Idempotency is tenant-scoped so two tenants cannot collide on a key.
    CONSTRAINT uq_offer_idempotency UNIQUE (tenant_id, idempotency_key)
);

CREATE INDEX idx_sellable_offer_scope ON core_sellable_offer (tenant_id, market_id, state);
CREATE INDEX idx_sellable_offer_expiry_scan ON core_sellable_offer (expires_at) WHERE state = 'ACTIVE';
-- One live offer per offer_key: a supersession must close the previous one.
CREATE UNIQUE INDEX uq_sellable_offer_single_active
    ON core_sellable_offer (offer_key) WHERE state = 'ACTIVE';

-- Commercial content is frozen once written. Lifecycle columns stay mutable.
CREATE OR REPLACE FUNCTION core_sellable_offer_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.start_time         IS DISTINCT FROM OLD.start_time
       OR NEW.end_time        IS DISTINCT FROM OLD.end_time
       OR NEW.duration_minutes IS DISTINCT FROM OLD.duration_minutes
       OR NEW.price_minor_units IS DISTINCT FROM OLD.price_minor_units
       OR NEW.currency_code   IS DISTINCT FROM OLD.currency_code
       OR NEW.price_version_id IS DISTINCT FROM OLD.price_version_id
       OR NEW.addons_snapshot IS DISTINCT FROM OLD.addons_snapshot
       OR NEW.duration_basis  IS DISTINCT FROM OLD.duration_basis
       OR NEW.config_provenance IS DISTINCT FROM OLD.config_provenance
       OR NEW.service_id      IS DISTINCT FROM OLD.service_id
       OR NEW.provider_id     IS DISTINCT FROM OLD.provider_id
       OR NEW.customer_identity_id IS DISTINCT FROM OLD.customer_identity_id
       OR NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
       OR NEW.market_id       IS DISTINCT FROM OLD.market_id
       OR NEW.request_fingerprint IS DISTINCT FROM OLD.request_fingerprint THEN
        RAISE EXCEPTION
            'core_sellable_offer commercial content is immutable (offer_id=%); supersede instead', OLD.offer_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_sellable_offer_immutable
    BEFORE UPDATE ON core_sellable_offer
    FOR EACH ROW
    EXECUTE FUNCTION core_sellable_offer_immutable();

-- -----------------------------------------------------------------------------
-- CapacityHold — widened in place, still owned by the G2 capacity module
-- -----------------------------------------------------------------------------

ALTER TABLE core_capacity_hold ADD COLUMN tenant_id TEXT;
ALTER TABLE core_capacity_hold ADD COLUMN offer_id UUID REFERENCES core_sellable_offer (offer_id);
ALTER TABLE core_capacity_hold ADD COLUMN expires_at TIMESTAMPTZ;
ALTER TABLE core_capacity_hold ADD COLUMN consumed_at TIMESTAMPTZ;

CREATE INDEX idx_capacity_hold_offer ON core_capacity_hold (offer_id) WHERE offer_id IS NOT NULL;
CREATE INDEX idx_capacity_hold_expiry ON core_capacity_hold (expires_at) WHERE state = 'ACTIVE';

-- A hold may be consumed exactly once, and only as part of a commit.
ALTER TABLE core_capacity_hold
    ADD CONSTRAINT chk_hold_consumed_consistency
    CHECK ((state = 'CONSUMED') = (consumed_at IS NOT NULL));

-- G2 wrote this as "released_at is set iff state = RELEASED", which was exact
-- when RELEASED was the only way a hold could stop occupying capacity. G3 adds
-- two more: EXPIRED (TTL elapsed) and INVALIDATED (governing offer closed).
-- The column's real meaning is "when this hold stopped occupying capacity", so
-- the constraint is restated over all three terminal states rather than
-- leaving two of them unable to record when they ended.
ALTER TABLE core_capacity_hold DROP CONSTRAINT chk_hold_released_consistency;

ALTER TABLE core_capacity_hold
    ADD CONSTRAINT chk_hold_released_consistency
    CHECK ((state IN ('RELEASED', 'EXPIRED', 'INVALIDATED')) = (released_at IS NOT NULL));

-- The exclusion constraint is rebuilt on two axes rather than three.
--
-- WHY: keying on provider_id AND resource_key meant two DIFFERENT providers
-- could hold the SAME shared resource_key at the same time — correct for a
-- mobile provider who is their own exclusive resource, wrong the moment an
-- InStore location has one chair and two barbers. resource_key alone is the
-- exclusivity axis; a provider's own exclusivity is expressed as the key
-- PROVIDER:<provider_id>, so existing G2 behavior is unchanged while shared
-- resources now conflict correctly.
--
-- market_id is included so two tenants/markets cannot collide on an
-- identically-named resource key.
ALTER TABLE core_capacity_hold DROP CONSTRAINT excl_capacity_no_overlap;

ALTER TABLE core_capacity_hold
    ADD CONSTRAINT excl_capacity_no_overlap
    EXCLUDE USING gist (
        market_id WITH =,
        resource_key WITH =,
        during WITH &&
    ) WHERE (state IN ('HELD', 'COMMITTED', 'ACTIVE', 'CONSUMED'));

COMMIT;
