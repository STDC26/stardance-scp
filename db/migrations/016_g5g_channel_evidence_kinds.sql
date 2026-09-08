-- =============================================================================
-- SCP-G5-G-01 — WhatsApp channel evidence kinds.
-- Migration 016. Additive over 002-015.
--
-- NO transaction block, for the same reason as migrations 004, 006, 010, 012 and
-- 014: PostgreSQL will not add an enum value inside a transaction that later
-- uses it. ON_ERROR_STOP still makes a partial apply fail loudly.
--
-- These record what the CHANNEL did. Transport evidence, never business truth:
-- core_event and core_operational_action remain the Service-Commerce authority,
-- and nothing here is read back as authority for an acceptance, a confirmation
-- or a lifecycle decision. A message being delivered is not a person agreeing.
-- =============================================================================

ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_MESSAGE_CREATED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_MESSAGE_SENT';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_SEND_FAILED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_DELIVERY_RECEIPT';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_WEBHOOK_REJECTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_EVENT_ACCEPTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_EVENT_REPLAYED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_INTENT_REFUSED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_ACTION_INVOKED';
