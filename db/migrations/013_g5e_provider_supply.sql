-- =============================================================================
-- SCP-G5-E-01 — provider experience and governed supply ingress.
-- Migration 013. Additive over 002-012. No Core object is altered.
--
-- WHAT THIS IS NOT: a second supply model. `core_provider` remains the single
-- authoritative supply aggregate and `supply_status = 'APPROVED'` remains the
-- one dispatchability gate, exactly as G2 established. `core_provider_service`,
-- `core_service_area` and `core_capacity_window` remain the constructs G3 reads.
-- Nothing here duplicates a provider's approval state or its bookable time.
--
-- WHAT THIS IS: the governed workflow around those constructs, which Core
-- deliberately does not model —
--
--   core_provider_profile            append-only profile versions. A submitted
--                                    profile is an application, not supply.
--   core_provider_card               Card submission and the SEPARATE Owner
--                                    approval that activates supply.
--   core_provider_public_id          the server-assigned Partner ID. A client
--                                    cannot author one because it is written
--                                    only by the Owner approval path.
--   core_provider_availability_*     weekly schedule VERSIONS, and the separate
--                                    Owner confirmation of one. Editing a
--                                    confirmed week supersedes it rather than
--                                    quietly inheriting its confirmation.
--   core_provider_service_area       the MOBILE analogue of the existing
--                                    core_provider_location link. G3 does not
--                                    read it today, so no G3 semantic changes.
--   core_supply_window_link          which availability version produced which
--                                    capacity window, so supersession can
--                                    withdraw precisely what it granted.
--   core_provider_session            server-issued, server-verified sessions.
--                                    Only the SHA-256 of a token is stored.
--   core_provider_media              portrait bytes behind a server boundary.
--   core_provider_ingress            append-only idempotency + lineage envelope
--                                    for every binding provider command.
--
-- Every row carries tenant / market / environment lineage, enforced by NOT NULL
-- plus a non-empty CHECK rather than by convention.
-- =============================================================================

BEGIN;

CREATE TYPE provider_card_state AS ENUM (
    'SUBMITTED',   -- awaiting Owner review; grants nothing
    'APPROVED',    -- Owner approved; this is what activates supply
    'REJECTED',
    'SUPERSEDED'   -- replaced by a later submission
);

CREATE TYPE provider_availability_state AS ENUM (
    'SUBMITTED',   -- provider stated a week; NOT approved supply
    'CONFIRMED',   -- Owner confirmed THIS version
    'SUPERSEDED',  -- a later version replaced it
    'WITHDRAWN'
);

-- -----------------------------------------------------------------------------
-- Provider profile — append-only versions
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_profile (
    profile_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES core_provider (provider_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    -- Monotonic per provider. The current profile is the highest version;
    -- there is no mutable "current" pointer to fall out of step with it.
    version      INTEGER NOT NULL,

    legal_name        TEXT NOT NULL,
    display_name      TEXT NOT NULL,
    contact_handle    TEXT NOT NULL,
    -- Governed role code (BB/MS/NT/FX/EC style), validated at the boundary
    -- against the tenant's configured displayIdPrefixes. Not SCP domain law.
    role_code         TEXT NOT NULL,
    -- Governed catalogue service codes this provider can deliver.
    service_codes     TEXT[] NOT NULL DEFAULT '{}',
    how_you_work      TEXT,
    about_me          TEXT,
    -- Accepted UX chips. Interaction compression; never lifecycle authority.
    profile_chips     TEXT[] NOT NULL DEFAULT '{}',
    portrait_media_id UUID,

    submitted_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_provider_profile_version UNIQUE (provider_id, version),
    CONSTRAINT chk_provider_profile_version CHECK (version >= 1),
    CONSTRAINT chk_provider_profile_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    CONSTRAINT chk_provider_profile_names
        CHECK (length(btrim(legal_name)) > 0
               AND length(btrim(display_name)) > 0
               AND length(btrim(contact_handle)) > 0)
);

CREATE INDEX idx_provider_profile_current
    ON core_provider_profile (provider_id, version DESC);

-- -----------------------------------------------------------------------------
-- Provider Card — submission and the separate Owner approval
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_card (
    card_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES core_provider (provider_id),
    -- The profile version this Card was cut from. A Card is a PROJECTION over
    -- profile truth; it owns no field of its own that could diverge.
    profile_id   UUID NOT NULL REFERENCES core_provider_profile (profile_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    state        provider_card_state NOT NULL DEFAULT 'SUBMITTED',

    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),

    -- Owner authority. Null until an Owner acts; never written by the provider
    -- path, which is what keeps approval separate from submission.
    decided_at   TIMESTAMPTZ,
    decided_by_identity_id UUID REFERENCES core_identity (identity_id),
    decision_reason TEXT,

    CONSTRAINT chk_provider_card_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    -- A decided card names its decider and when. A submitted one names neither.
    CONSTRAINT chk_provider_card_decision
        CHECK ((state IN ('APPROVED', 'REJECTED'))
               = (decided_at IS NOT NULL AND decided_by_identity_id IS NOT NULL))
);

-- At most one card awaiting review per provider, so "which card is being
-- considered" is never ambiguous.
CREATE UNIQUE INDEX uq_provider_card_single_open
    ON core_provider_card (provider_id)
    WHERE state = 'SUBMITTED';

CREATE INDEX idx_provider_card_scope
    ON core_provider_card (tenant_id, market_id, environment, state);

-- -----------------------------------------------------------------------------
-- Partner ID — server-governed public identifier
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_public_id (
    provider_id  UUID PRIMARY KEY REFERENCES core_provider (provider_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    role_code    TEXT NOT NULL,
    sequence     INTEGER NOT NULL,
    public_id    TEXT NOT NULL,

    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    -- The Owner card approval that assigned it.
    assigned_by_card_id UUID NOT NULL REFERENCES core_provider_card (card_id),

    CONSTRAINT uq_provider_public_id UNIQUE (tenant_id, market_id, environment, public_id),
    CONSTRAINT uq_provider_public_sequence
        UNIQUE (tenant_id, market_id, environment, role_code, sequence),
    CONSTRAINT chk_provider_public_sequence CHECK (sequence >= 1)
);

-- -----------------------------------------------------------------------------
-- Weekly availability — versions and the separate Owner confirmation
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_availability_version (
    availability_version_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES core_provider (provider_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    -- Server-normalized Monday, in the governed market timezone.
    week_start_date DATE NOT NULL,
    version      INTEGER NOT NULL,
    state        provider_availability_state NOT NULL DEFAULT 'SUBMITTED',

    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    submitted_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),

    -- Owner authority, distinct from and later than submission.
    confirmed_at TIMESTAMPTZ,
    confirmed_by_identity_id UUID REFERENCES core_identity (identity_id),

    superseded_at TIMESTAMPTZ,
    -- Deterministic digest of the canonical seven-day content. Equal digests
    -- mean equal schedules however they were entered, which is what makes
    -- apply-to-all and per-day editing provably the same truth.
    content_digest TEXT NOT NULL,

    CONSTRAINT uq_availability_version UNIQUE (provider_id, week_start_date, version),
    CONSTRAINT chk_availability_version CHECK (version >= 1),
    CONSTRAINT chk_availability_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    -- A CONFIRMED version names its confirmer and when. A SUPERSEDED one
    -- legitimately RETAINS that record: the fact that an Owner once confirmed
    -- this week is history worth keeping, and an equivalence here would force
    -- supersession to erase it.
    CONSTRAINT chk_availability_confirmed_requires_confirmer
        CHECK (state <> 'CONFIRMED'
               OR (confirmed_at IS NOT NULL AND confirmed_by_identity_id IS NOT NULL)),
    CONSTRAINT chk_availability_confirmation_complete
        CHECK ((confirmed_at IS NULL) = (confirmed_by_identity_id IS NULL)),
    CONSTRAINT chk_availability_week_is_monday
        CHECK (EXTRACT(ISODOW FROM week_start_date) = 1),
    CONSTRAINT chk_availability_digest CHECK (length(btrim(content_digest)) = 64)
);

-- At most one CONFIRMED version per provider-week. This is the constraint that
-- makes "only the current confirmed version is approved supply" structural.
CREATE UNIQUE INDEX uq_availability_single_confirmed
    ON core_provider_availability_version (provider_id, week_start_date)
    WHERE state = 'CONFIRMED';

-- At most one open SUBMITTED version per provider-week.
CREATE UNIQUE INDEX uq_availability_single_submitted
    ON core_provider_availability_version (provider_id, week_start_date)
    WHERE state = 'SUBMITTED';

CREATE INDEX idx_availability_scope
    ON core_provider_availability_version (tenant_id, market_id, environment, state);

CREATE TABLE core_provider_availability_day (
    availability_day_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    availability_version_id UUID NOT NULL
        REFERENCES core_provider_availability_version (availability_version_id) ON DELETE CASCADE,

    -- ISO day of week: 1 = Monday .. 7 = Sunday. The week starts on Monday
    -- because the accepted Freshline Partner experience does.
    iso_day      SMALLINT NOT NULL,
    available    BOOLEAN NOT NULL,
    -- Market-local wall times, HH:MM. Null exactly when the day is unavailable.
    start_time_local TEXT,
    end_time_local   TEXT,
    -- Governed region coverage for THIS day.
    regions      TEXT[] NOT NULL DEFAULT '{}',

    CONSTRAINT uq_availability_day UNIQUE (availability_version_id, iso_day),
    CONSTRAINT chk_availability_iso_day CHECK (iso_day BETWEEN 1 AND 7),
    -- An available day states hours and at least one region; an unavailable one
    -- states neither. There is no half-stated day.
    CONSTRAINT chk_availability_day_shape
        CHECK ((available AND start_time_local IS NOT NULL AND end_time_local IS NOT NULL
                AND cardinality(regions) > 0)
            OR (NOT available AND start_time_local IS NULL AND end_time_local IS NULL
                AND cardinality(regions) = 0)),
    CONSTRAINT chk_availability_day_time_format
        CHECK ((start_time_local IS NULL OR start_time_local ~ '^[0-2][0-9]:[0-5][0-9]$')
           AND (end_time_local IS NULL OR end_time_local ~ '^[0-2][0-9]:[0-5][0-9]$')),
    CONSTRAINT chk_availability_day_ordering
        CHECK (start_time_local IS NULL OR end_time_local > start_time_local)
);

-- -----------------------------------------------------------------------------
-- Provider coverage — the MOBILE analogue of core_provider_location
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_service_area (
    provider_id     UUID NOT NULL REFERENCES core_provider (provider_id),
    service_area_id UUID NOT NULL REFERENCES core_service_area (service_area_id),
    PRIMARY KEY (provider_id, service_area_id)
);

-- -----------------------------------------------------------------------------
-- Supply provenance — which availability version granted which capacity window
-- -----------------------------------------------------------------------------

CREATE TABLE core_supply_window_link (
    window_id UUID PRIMARY KEY REFERENCES core_capacity_window (window_id),
    availability_version_id UUID NOT NULL
        REFERENCES core_provider_availability_version (availability_version_id),
    iso_day   SMALLINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT chk_supply_window_iso_day CHECK (iso_day BETWEEN 1 AND 7)
);

CREATE INDEX idx_supply_window_version ON core_supply_window_link (availability_version_id);

-- -----------------------------------------------------------------------------
-- Provider sessions — server-issued, server-verified
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_session (
    session_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Only the digest is stored. A database read cannot recover a usable token,
    -- and a client-supplied identifier is never sufficient authority.
    token_sha256 TEXT NOT NULL UNIQUE,

    identity_id  UUID NOT NULL REFERENCES core_identity (identity_id),
    -- Null while the session belongs to an applicant with no Provider yet.
    provider_id  UUID REFERENCES core_provider (provider_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    -- PROVIDER or OWNER. The role a session carries is fixed at issue by the
    -- server; it can never be widened by anything the holder sends.
    session_role TEXT NOT NULL,

    issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at   TIMESTAMPTZ NOT NULL,
    revoked_at   TIMESTAMPTZ,

    CONSTRAINT chk_provider_session_role CHECK (session_role IN ('PROVIDER', 'OWNER')),
    CONSTRAINT chk_provider_session_digest CHECK (length(token_sha256) = 64),
    CONSTRAINT chk_provider_session_expiry CHECK (expires_at > issued_at),
    CONSTRAINT chk_provider_session_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0)
);

CREATE INDEX idx_provider_session_identity ON core_provider_session (identity_id, expires_at);

-- -----------------------------------------------------------------------------
-- Protected provider media
-- -----------------------------------------------------------------------------

-- Bytes live here, behind the server. No browser ever holds a storage
-- credential and no bucket is publicly writable, because there is no bucket:
-- the authoritative database the runtime already verifies at startup is also
-- what stores the portrait.
CREATE TABLE core_provider_media (
    media_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id  UUID NOT NULL REFERENCES core_provider (provider_id),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    content_type TEXT NOT NULL,
    byte_size    INTEGER NOT NULL,
    sha256       TEXT NOT NULL,
    bytes        BYTEA NOT NULL,

    uploaded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    uploaded_by_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),

    CONSTRAINT chk_provider_media_type
        CHECK (content_type IN ('image/png', 'image/jpeg', 'image/webp')),
    CONSTRAINT chk_provider_media_size CHECK (byte_size > 0 AND byte_size <= 5242880),
    CONSTRAINT chk_provider_media_digest CHECK (length(sha256) = 64),
    CONSTRAINT chk_provider_media_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0)
);

CREATE INDEX idx_provider_media_provider ON core_provider_media (provider_id, uploaded_at DESC);

-- The profile references media; media never references approval. Deleting or
-- replacing bytes therefore cannot move a Provider's supply status.
ALTER TABLE core_provider_profile
    ADD CONSTRAINT fk_provider_profile_media
    FOREIGN KEY (portrait_media_id) REFERENCES core_provider_media (media_id);

-- -----------------------------------------------------------------------------
-- Provider ingress — append-only idempotency and lineage envelope
-- -----------------------------------------------------------------------------

CREATE TABLE core_provider_ingress (
    ingress_id   BIGSERIAL PRIMARY KEY,

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,

    command      TEXT NOT NULL,
    idempotency_key     TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,

    actor_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    actor_role   TEXT NOT NULL,
    provider_id  UUID REFERENCES core_provider (provider_id),

    -- Whatever canonical object the command produced, so a replay can answer
    -- with the original outcome rather than doing the work again.
    result_ref   TEXT,

    configuration_version  INTEGER NOT NULL,
    configuration_checksum TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    server_received_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_provider_ingress_idempotency
        UNIQUE (tenant_id, market_id, environment, idempotency_key),
    CONSTRAINT chk_provider_ingress_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    CONSTRAINT chk_provider_ingress_configuration
        CHECK (configuration_version >= 1 AND length(btrim(configuration_checksum)) = 64)
);

CREATE INDEX idx_provider_ingress_scope
    ON core_provider_ingress (tenant_id, market_id, environment, server_received_at);

-- Append-only. Correcting an accepted command is a new governed command against
-- canonical truth, never a rewrite of what arrived.
CREATE OR REPLACE FUNCTION core_provider_ingress_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'core_provider_ingress is append-only (ingress_id=%); issue a new governed command instead',
        OLD.ingress_id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_provider_ingress_append_only
    BEFORE UPDATE OR DELETE ON core_provider_ingress
    FOR EACH ROW
    EXECUTE FUNCTION core_provider_ingress_append_only();

-- Profile versions are append-only for the same reason: an edited profile is a
-- new version, so a Card approved against version 2 cannot silently come to
-- describe version 3.
CREATE OR REPLACE FUNCTION core_provider_profile_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'core_provider_profile is append-only (profile_id=%); submit a new profile version instead',
        OLD.profile_id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_provider_profile_append_only
    BEFORE UPDATE OR DELETE ON core_provider_profile
    FOR EACH ROW
    EXECUTE FUNCTION core_provider_profile_append_only();

COMMIT;
