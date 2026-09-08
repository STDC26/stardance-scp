-- =============================================================================
-- SCP-G5-G-01 — governed channel messaging.
-- Migration 017. Additive over 002-016. No Core object is altered.
--
-- WHAT THIS IS NOT: a second source of Service-Commerce truth. Not one column
-- below duplicates a request's state, an offer's decision, an assignment, a
-- confirmation or a lifecycle position. A channel row can say "we sent a
-- message and the network says it arrived"; it can never say "the provider
-- accepted". That distinction is the whole gate.
--
-- WHAT THIS IS: the transport record and the correlation that makes an inbound
-- human response attributable —
--
--   core_channel_message  one outbound communication, its delivery status, and
--                         the canonical object that authorized it. The status
--                         column tracks the NETWORK, never the business.
--
--   core_channel_event    one inbound channel event: its authenticity verdict,
--                         what it correlated to, what intent it resolved to, and
--                         whether SCP accepted or refused the consequence.
--                         Append-only — an inbound event is something that
--                         happened.
--
-- Every row carries tenant / market / environment lineage, enforced by NOT NULL
-- plus a non-empty CHECK rather than by convention.
-- =============================================================================

BEGIN;

CREATE TYPE channel_message_type AS ENUM (
    'PROVIDER_OFFER',
    'CUSTOMER_CONFIRMATION_REQUEST'
);

-- Deliberately a TRANSPORT vocabulary. There is no ACCEPTED, CONFIRMED or
-- ASSIGNED here, because a delivery pipeline has no opinion about those.
CREATE TYPE channel_message_status AS ENUM (
    'CREATED',      -- SCP authorized the communication; nothing has left yet
    'SENT',         -- the transport accepted it
    'SEND_FAILED',  -- the transport refused it; the business object is untouched
    'DELIVERED',    -- the network says it arrived
    'READ'          -- the network says it was opened. Still not agreement.
);

CREATE TYPE channel_event_outcome AS ENUM (
    'ACCEPTED',   -- resolved to a governed SCP action that was accepted
    'REFUSED',    -- authentic or not, it produced no canonical consequence
    'REPLAYED'    -- an event already processed; the original outcome stands
);

CREATE TYPE channel_authenticity AS ENUM ('VERIFIED', 'REJECTED');

-- -----------------------------------------------------------------------------
-- Outbound
-- -----------------------------------------------------------------------------

CREATE TABLE core_channel_message (
    message_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,
    channel      TEXT NOT NULL,

    message_type channel_message_type NOT NULL,

    -- The canonical object that AUTHORIZED this communication. A message may
    -- only exist because SCP truth already did; exactly one of these is set,
    -- which is what stops a message from being sent about nothing.
    request_id   UUID NOT NULL REFERENCES core_service_request (request_id),
    offer_id     UUID REFERENCES core_dispatch_offer (offer_id),
    confirmation_id UUID REFERENCES core_customer_confirmation (confirmation_id),

    recipient_identity_id UUID NOT NULL REFERENCES core_identity (identity_id),
    recipient_handle      TEXT NOT NULL,

    -- The opaque token a reply carries back. Unique, unguessable, and bound to
    -- exactly one message — a correlation token is how an inbound event becomes
    -- attributable without trusting anything the sender says.
    correlation_token TEXT NOT NULL,

    body         TEXT NOT NULL,
    status       channel_message_status NOT NULL DEFAULT 'CREATED',
    attempt      INTEGER NOT NULL DEFAULT 1,
    -- The transport's own id, when it gave one. Opaque; never an SCP identifier.
    external_message_id TEXT,
    failure_code TEXT,

    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at      TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,

    CONSTRAINT uq_channel_correlation_token UNIQUE (correlation_token),
    CONSTRAINT chk_channel_message_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    CONSTRAINT chk_channel_message_token CHECK (length(correlation_token) >= 24),
    CONSTRAINT chk_channel_message_attempt CHECK (attempt >= 1),
    -- A provider-offer message names an offer; a confirmation message names a
    -- confirmation context. Neither may name the other's object.
    CONSTRAINT chk_channel_message_subject
        CHECK ((message_type = 'PROVIDER_OFFER'
                AND offer_id IS NOT NULL AND confirmation_id IS NULL)
            OR (message_type = 'CUSTOMER_CONFIRMATION_REQUEST'
                AND confirmation_id IS NOT NULL AND offer_id IS NULL)),
    CONSTRAINT chk_channel_message_sent CHECK ((status = 'CREATED') = (sent_at IS NULL)
                                               OR status = 'SEND_FAILED'),
    CONSTRAINT chk_channel_message_failure
        CHECK ((status = 'SEND_FAILED') = (failure_code IS NOT NULL))
);

CREATE INDEX idx_channel_message_scope
    ON core_channel_message (tenant_id, market_id, environment, created_at);
CREATE INDEX idx_channel_message_request ON core_channel_message (request_id);
CREATE INDEX idx_channel_message_offer ON core_channel_message (offer_id)
    WHERE offer_id IS NOT NULL;

-- The identity of a message is immutable; only its DELIVERY STATUS may move.
-- Rewriting who a message was for, or what it was about, would break the one
-- thing correlation depends on.
CREATE OR REPLACE FUNCTION core_channel_message_identity_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.tenant_id       IS DISTINCT FROM OLD.tenant_id
       OR NEW.market_id    IS DISTINCT FROM OLD.market_id
       OR NEW.environment  IS DISTINCT FROM OLD.environment
       OR NEW.message_type IS DISTINCT FROM OLD.message_type
       OR NEW.request_id   IS DISTINCT FROM OLD.request_id
       OR NEW.offer_id     IS DISTINCT FROM OLD.offer_id
       OR NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id
       OR NEW.recipient_identity_id IS DISTINCT FROM OLD.recipient_identity_id
       OR NEW.correlation_token IS DISTINCT FROM OLD.correlation_token
       OR NEW.body IS DISTINCT FROM OLD.body THEN
        RAISE EXCEPTION
            'core_channel_message identity is immutable (message_id=%); only delivery status may change',
            OLD.message_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_channel_message_identity_immutable
    BEFORE UPDATE ON core_channel_message
    FOR EACH ROW
    EXECUTE FUNCTION core_channel_message_identity_immutable();

-- -----------------------------------------------------------------------------
-- Inbound
-- -----------------------------------------------------------------------------

CREATE TABLE core_channel_event (
    event_id     BIGSERIAL PRIMARY KEY,

    tenant_id    TEXT NOT NULL,
    market_id    TEXT NOT NULL,
    environment  TEXT NOT NULL,
    channel      TEXT NOT NULL,

    -- The transport's own event id. Unique per scope: this is the replay
    -- boundary, and it is the database that enforces it rather than the
    -- application remembering to.
    provider_event_id TEXT NOT NULL,

    sender_handle TEXT NOT NULL,
    -- Digest of the exact bytes the authenticity check ran over, so a later
    -- reader can tell what was actually signed.
    raw_body_sha256 TEXT NOT NULL,

    authenticity channel_authenticity NOT NULL,
    -- Null when the event failed authenticity or carried no usable token.
    correlation_token TEXT,
    correlated_message_id UUID REFERENCES core_channel_message (message_id),

    resolved_intent TEXT,
    outcome      channel_event_outcome NOT NULL,
    reason_code  TEXT,

    -- What SCP actually did, if anything. Null on every refusal, which is the
    -- point: a refused event is evidence that something arrived, not that
    -- anything happened.
    request_id   UUID REFERENCES core_service_request (request_id),
    action_id    UUID REFERENCES core_operational_action (action_id),

    received_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT uq_channel_event_provider_id
        UNIQUE (tenant_id, market_id, environment, channel, provider_event_id),
    CONSTRAINT chk_channel_event_lineage
        CHECK (length(btrim(tenant_id)) > 0
               AND length(btrim(market_id)) > 0
               AND length(btrim(environment)) > 0),
    CONSTRAINT chk_channel_event_digest CHECK (length(raw_body_sha256) = 64),
    -- A refusal must say why. An acceptance must not pretend to.
    CONSTRAINT chk_channel_event_reason
        CHECK ((outcome = 'REFUSED') = (reason_code IS NOT NULL)),
    -- A rejected webhook can never carry a canonical action.
    CONSTRAINT chk_channel_event_rejected_is_inert
        CHECK (authenticity = 'VERIFIED' OR (action_id IS NULL AND outcome = 'REFUSED'))
);

CREATE INDEX idx_channel_event_scope
    ON core_channel_event (tenant_id, market_id, environment, received_at);
CREATE INDEX idx_channel_event_message ON core_channel_event (correlated_message_id)
    WHERE correlated_message_id IS NOT NULL;
CREATE INDEX idx_channel_event_request ON core_channel_event (request_id)
    WHERE request_id IS NOT NULL;

-- Append-only. An inbound event is a thing that happened; the response to it is
-- a new event, never a rewrite of the old one.
CREATE OR REPLACE FUNCTION core_channel_event_append_only()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'core_channel_event is append-only (event_id=%); record a new event instead',
        OLD.event_id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_channel_event_append_only
    BEFORE UPDATE OR DELETE ON core_channel_event
    FOR EACH ROW
    EXECUTE FUNCTION core_channel_event_append_only();

COMMIT;
