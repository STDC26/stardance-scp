-- =============================================================================
-- SCP-G2-EXEC-01 — Core Foundation
-- Migration 002. Applied after db/schema.sql (the frozen G1 baseline, 001).
-- Target: PostgreSQL 15+
--
-- SCOPE NOTE (read before extending):
--   The G1 `appointments` table is NOT canonical. It is the frozen migration-era
--   surface retained unchanged so inherited G1 proof stays green. Canonical
--   Service Request truth lives in `core_service_request` and its versions.
--   `core_provider_alias` is the only sanctioned bridge between the two.
--
-- PLATFORM RULE: ONE DOMAIN CONCEPT -> ONE AUTHORITATIVE OWNER -> MANY GOVERNED
-- PROJECTIONS. Every table below names exactly one owner concept.
-- =============================================================================

BEGIN;

-- pgcrypto: gen_random_uuid(). btree_gist: equality operators inside the GiST
-- exclusion constraint that enforces non-overlapping exclusive capacity.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- -----------------------------------------------------------------------------
-- Enumerations — canonical vocabulary
-- -----------------------------------------------------------------------------

-- Scoped roles. The same person may hold several; possession of one never
-- implies authority in another scope (IDENTITY_AUTHORITY).
CREATE TYPE scp_role AS ENUM (
    'OWNER',      -- market operator: assignment + catalogue + capacity policy
    'PROVIDER',   -- supply side: may respond to its own dispatch offers only
    'CUSTOMER',   -- demand side: may confirm its own requests only
    'SYSTEM'      -- automated sweeps; never a substitute for a human authority
);

-- Submitted profile != approved supply (FOUNDATIONAL_INVARIANTS).
CREATE TYPE provider_supply_status AS ENUM (
    'SUBMITTED',
    'APPROVED',
    'SUSPENDED',
    'WITHDRAWN'
);

-- Canonical Service Request states. Deliberately absent:
--   * PROVIDER_DECLINED / CONTRACTOR_DECLINED — decline is a Dispatch Offer
--     outcome that releases the request to PENDING_ACCEPTANCE (G1R-01, and
--     LEGACY_STATE_MAPPING).
--   * AMENDMENT_PENDING_REVALIDATION — amendments are a sub-record, never a
--     top-level request state (AMENDMENT_MODEL.TOP_LEVEL_STATE_PROHIBITION).
--   * CONFIRMED — the ambiguous G1 value is decomposed into OWNER_ASSIGNED /
--     AWAITING_CUSTOMER_CONFIRMATION / CUSTOMER_CONFIRMED.
--   * EXPIRED_REVERTED — recovery history semantics only; lives in core_event.
CREATE TYPE service_request_state AS ENUM (
    'PENDING_ACCEPTANCE',
    'PROVIDER_DISPATCHED',
    'PROVIDER_ACCEPTED',
    'OWNER_ASSIGNED',
    'AWAITING_CUSTOMER_CONFIRMATION',
    'CUSTOMER_CONFIRMED',
    'FULFILLMENT_ACTIVE',
    'SERVICE_COMPLETED',
    'CANCELLED',
    'NO_SHOW',
    'UNABLE_TO_FULFILL'
);

CREATE TYPE amendment_state AS ENUM (
    'PROPOSED',
    'VALIDATING',
    'REQUIRES_RECONFIRMATION',
    'APPLIED',
    'REJECTED',
    'WITHDRAWN'
);

CREATE TYPE dispatch_offer_state AS ENUM (
    'OFFERED',
    'ACCEPTED',
    'DECLINED',
    'EXPIRED',
    'WITHDRAWN'
);

CREATE TYPE capacity_hold_state AS ENUM (
    'HELD',       -- provisional, blocks overlap
    'COMMITTED',  -- confirmed commitment, blocks overlap
    'RELEASED'    -- no longer blocks
);

CREATE TYPE fulfillment_result AS ENUM (
    'SERVICE_COMPLETED',
    'NO_SHOW',
    'UNABLE_TO_FULFILL'
);

-- -----------------------------------------------------------------------------
-- Identity + scoped authority
-- -----------------------------------------------------------------------------

CREATE TABLE core_identity (
    identity_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    display_name    TEXT NOT NULL,
    -- Verified inbound channel handle (e.g. normalized MSISDN). Channel
    -- identity must be *verified* before any binding transition; an unmatched
    -- handle yields no identity and therefore no authority.
    channel_handle  TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_identity_market_present CHECK (market_id = btrim(market_id) AND length(market_id) > 0),
    CONSTRAINT uq_identity_channel_handle UNIQUE (market_id, channel_handle)
);

CREATE TABLE core_identity_role (
    identity_role_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identity_id      UUID NOT NULL REFERENCES core_identity (identity_id),
    market_id        TEXT NOT NULL,
    role             scp_role NOT NULL,
    granted_at       TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_identity_role UNIQUE (identity_id, market_id, role)
);

CREATE INDEX idx_identity_role_lookup ON core_identity_role (identity_id, market_id);

-- -----------------------------------------------------------------------------
-- Provider — the single canonical supply aggregate
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider (
    provider_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id       TEXT NOT NULL,
    identity_id     UUID NOT NULL REFERENCES core_identity (identity_id),
    display_name    TEXT NOT NULL,
    supply_status   provider_supply_status NOT NULL DEFAULT 'SUBMITTED',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_provider_identity_market UNIQUE (market_id, identity_id)
);

CREATE INDEX idx_provider_market_status ON core_provider (market_id, supply_status);

-- Migration alias register. CANONICAL_PROVIDER_MODEL permits legacy
-- contractor_id to survive ONLY as an explicitly tracked alias with an
-- unambiguous mapping. One legacy id maps to at most one Provider, so no
-- competing authority can be constructed from it.
CREATE TABLE core_provider_alias (
    alias_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES core_provider (provider_id),
    alias_kind   TEXT NOT NULL,
    alias_value  TEXT NOT NULL,
    note         TEXT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_alias_kind CHECK (alias_kind IN ('LEGACY_CONTRACTOR_ID')),
    CONSTRAINT uq_provider_alias UNIQUE (alias_kind, alias_value)
);

-- -----------------------------------------------------------------------------
-- Catalogue + commercial truth
-- -----------------------------------------------------------------------------

CREATE TABLE core_service (
    service_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id             TEXT NOT NULL,
    name                  TEXT NOT NULL,
    base_duration_minutes INTEGER NOT NULL,
    active                BOOLEAN NOT NULL DEFAULT TRUE,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_core_service_duration CHECK (base_duration_minutes > 0 AND base_duration_minutes <= 480)
);

CREATE TABLE core_service_addon (
    addon_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id            UUID NOT NULL REFERENCES core_service (service_id),
    name                  TEXT NOT NULL,
    extra_duration_minutes INTEGER NOT NULL DEFAULT 0,
    price_minor_units     BIGINT NOT NULL DEFAULT 0,
    active                BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT chk_addon_duration CHECK (extra_duration_minutes >= 0),
    CONSTRAINT chk_addon_price CHECK (price_minor_units >= 0)
);

-- Price versions are append-only. A Service Request snapshots the price version
-- it accepted; later catalogue changes never reprice a persisted request
-- (COMMERCIAL_TRUTH.NO_SILENT_REPRICE).
CREATE TABLE core_service_price_version (
    price_version_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    service_id        UUID NOT NULL REFERENCES core_service (service_id),
    price_minor_units BIGINT NOT NULL,
    currency_code     TEXT NOT NULL,
    buffer_minutes    INTEGER NOT NULL DEFAULT 0,
    effective_from    TIMESTAMPTZ NOT NULL DEFAULT now(),
    active            BOOLEAN NOT NULL DEFAULT TRUE,

    CONSTRAINT chk_price_nonneg CHECK (price_minor_units >= 0),
    CONSTRAINT chk_buffer_nonneg CHECK (buffer_minutes >= 0)
);

CREATE INDEX idx_price_version_service ON core_service_price_version (service_id, active);

-- -----------------------------------------------------------------------------
-- Service Request + immutable versions
-- -----------------------------------------------------------------------------

CREATE TABLE core_service_request (
    request_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id            TEXT NOT NULL,
    customer_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    service_id           UUID NOT NULL REFERENCES core_service (service_id),
    state                service_request_state NOT NULL DEFAULT 'PENDING_ACCEPTANCE',
    -- The version number currently authoritative. An amendment proposes a NEW
    -- version; the committed one stays authoritative until adoption.
    current_version      INTEGER NOT NULL DEFAULT 1,
    lock_version         INTEGER NOT NULL DEFAULT 1,  -- optimistic concurrency
    created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_request_versions_positive CHECK (current_version >= 1 AND lock_version >= 1)
);

CREATE INDEX idx_request_market_state ON core_service_request (market_id, state);

-- Append-only. Never UPDATE a version row; propose a new one.
CREATE TABLE core_service_request_version (
    request_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id         UUID NOT NULL REFERENCES core_service_request (request_id),
    version            INTEGER NOT NULL,
    service_id         UUID NOT NULL REFERENCES core_service (service_id),
    price_version_id   UUID NOT NULL REFERENCES core_service_price_version (price_version_id),
    -- Locked commercial snapshot.
    price_minor_units  BIGINT NOT NULL,
    currency_code      TEXT NOT NULL,
    -- BASE + ADD-ONS + BUFFER, computed once and frozen.
    duration_minutes   INTEGER NOT NULL,
    addons_snapshot    JSONB NOT NULL DEFAULT '[]'::jsonb,
    start_time         TIMESTAMPTZ NOT NULL,
    end_time           TIMESTAMPTZ NOT NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_request_version UNIQUE (request_id, version),
    CONSTRAINT chk_version_window CHECK (end_time > start_time),
    CONSTRAINT chk_version_duration CHECK (duration_minutes > 0)
);

-- -----------------------------------------------------------------------------
-- Amendment — versioned sub-record, never a top-level request state
-- -----------------------------------------------------------------------------

CREATE TABLE core_amendment (
    amendment_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id              UUID NOT NULL REFERENCES core_service_request (request_id),
    -- The version authoritative when this amendment was proposed.
    from_version            INTEGER NOT NULL,
    -- The candidate version; NULL until a concrete replacement is drafted.
    proposed_version_id     UUID REFERENCES core_service_request_version (request_version_id),
    state                   amendment_state NOT NULL DEFAULT 'PROPOSED',
    requires_reconfirmation BOOLEAN NOT NULL DEFAULT FALSE,
    proposed_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    reason                  TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at             TIMESTAMPTZ,

    CONSTRAINT chk_amendment_from_version CHECK (from_version >= 1)
);

CREATE INDEX idx_amendment_request ON core_amendment (request_id, state);

-- At most one amendment may be in flight per request, so "which replacement is
-- being considered" is never ambiguous.
CREATE UNIQUE INDEX uq_amendment_single_open
    ON core_amendment (request_id)
    WHERE state IN ('PROPOSED', 'VALIDATING', 'REQUIRES_RECONFIRMATION');

-- -----------------------------------------------------------------------------
-- Capacity — Location x Provider x Service x Resource x Time
-- -----------------------------------------------------------------------------

-- Provider-declared availability. Distinct from business operating policy,
-- which lives in the market configuration plane (CAPACITY_MODEL requirement 1).
CREATE TABLE core_capacity_window (
    window_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id   TEXT NOT NULL,
    provider_id UUID NOT NULL REFERENCES core_provider (provider_id),
    location_id TEXT NOT NULL,
    during      TSTZRANGE NOT NULL,
    active      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_window_nonempty CHECK (NOT isempty(during))
);

CREATE INDEX idx_capacity_window_lookup ON core_capacity_window USING gist (provider_id, during);

-- Exclusive capacity. The EXCLUDE constraint is the actual enforcement of
-- non-overlap — application-level checking alone loses races. RELEASED holds
-- are excluded from the constraint so a released slot is immediately reusable.
CREATE TABLE core_capacity_hold (
    hold_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id    TEXT NOT NULL,
    provider_id  UUID NOT NULL REFERENCES core_provider (provider_id),
    location_id  TEXT NOT NULL,
    -- Exclusive resource discriminator. Defaults to the provider's own person;
    -- a room/chair/device uses its own key so two providers can share a room
    -- only if the room key differs.
    resource_key TEXT NOT NULL,
    request_id   UUID REFERENCES core_service_request (request_id),
    during       TSTZRANGE NOT NULL,
    state        capacity_hold_state NOT NULL DEFAULT 'HELD',
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    released_at  TIMESTAMPTZ,

    CONSTRAINT chk_hold_nonempty CHECK (NOT isempty(during)),
    CONSTRAINT chk_hold_released_consistency
        CHECK ((state = 'RELEASED') = (released_at IS NOT NULL)),

    CONSTRAINT excl_capacity_no_overlap
        EXCLUDE USING gist (
            provider_id WITH =,
            resource_key WITH =,
            during WITH &&
        ) WHERE (state <> 'RELEASED')
);

CREATE INDEX idx_capacity_hold_request ON core_capacity_hold (request_id) WHERE request_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Dispatch Offer -> Assignment -> Customer Confirmation (three distinct gates)
-- -----------------------------------------------------------------------------

CREATE TABLE core_dispatch_offer (
    offer_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    market_id              TEXT NOT NULL,
    request_id             UUID NOT NULL REFERENCES core_service_request (request_id),
    provider_id            UUID NOT NULL REFERENCES core_provider (provider_id),
    state                  dispatch_offer_state NOT NULL DEFAULT 'OFFERED',
    offered_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at             TIMESTAMPTZ NOT NULL,
    decided_at             TIMESTAMPTZ,
    decided_by_identity_id UUID REFERENCES core_identity (identity_id),

    CONSTRAINT chk_offer_expiry_after_offer CHECK (expires_at > offered_at),
    CONSTRAINT chk_offer_decided_consistency
        CHECK ((state IN ('ACCEPTED', 'DECLINED')) = (decided_at IS NOT NULL))
);

CREATE INDEX idx_offer_request ON core_dispatch_offer (request_id, state);
-- The sweep's only query shape.
CREATE INDEX idx_offer_expiry_scan ON core_dispatch_offer (expires_at) WHERE state = 'OFFERED';
-- One live offer per request: a request cannot be double-offered.
CREATE UNIQUE INDEX uq_offer_single_live ON core_dispatch_offer (request_id) WHERE state = 'OFFERED';

CREATE TABLE core_assignment (
    assignment_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id              UUID NOT NULL REFERENCES core_service_request (request_id),
    provider_id             UUID NOT NULL REFERENCES core_provider (provider_id),
    offer_id                UUID NOT NULL REFERENCES core_dispatch_offer (offer_id),
    assigned_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    assigned_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at              TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_assignment_single_active
    ON core_assignment (request_id) WHERE revoked_at IS NULL;

CREATE TABLE core_customer_confirmation (
    confirmation_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id               UUID NOT NULL REFERENCES core_service_request (request_id),
    -- The exact request version the customer agreed to. A later amendment that
    -- changes the customer-facing commitment invalidates this confirmation.
    confirmed_version        INTEGER NOT NULL,
    confirmed_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    confirmed_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    superseded_at            TIMESTAMPTZ
);

CREATE UNIQUE INDEX uq_confirmation_single_active
    ON core_customer_confirmation (request_id) WHERE superseded_at IS NULL;

CREATE TABLE core_fulfillment (
    fulfillment_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    request_id              UUID NOT NULL REFERENCES core_service_request (request_id),
    result                  fulfillment_result NOT NULL,
    recorded_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    recorded_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes                   TEXT
);

CREATE UNIQUE INDEX uq_fulfillment_single ON core_fulfillment (request_id);

-- -----------------------------------------------------------------------------
-- Event / audit — append-only, one row per canonical transition
-- -----------------------------------------------------------------------------

CREATE TABLE core_event (
    event_id          BIGSERIAL PRIMARY KEY,
    market_id         TEXT NOT NULL,
    object_type       TEXT NOT NULL,   -- SERVICE_REQUEST | DISPATCH_OFFER | ...
    object_id         UUID NOT NULL,
    from_state        TEXT,
    to_state          TEXT NOT NULL,
    actor_identity_id UUID REFERENCES core_identity (identity_id),
    actor_role        scp_role NOT NULL,
    actor_authority   TEXT NOT NULL,   -- how authority was established
    governing_ref     TEXT,            -- offer/assignment/version this traces to
    -- Idempotency: replaying the same governed command is a no-op, not a
    -- duplicate transition (EVENT_AUDIT requirement 4).
    idempotency_key   TEXT NOT NULL UNIQUE,
    occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    payload           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_core_event_object ON core_event (object_type, object_id, occurred_at);

COMMIT;
