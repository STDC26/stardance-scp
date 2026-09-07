-- =============================================================================
-- SCP-G5-E-01 — provider supply-ingress runtime evidence kinds.
-- Migration 012. Additive over 002-011.
--
-- NO transaction block, for the same reason as migrations 004, 006 and 010:
-- PostgreSQL will not add an enum value inside a transaction that later uses it.
-- ON_ERROR_STOP still makes a partial apply fail loudly.
--
-- These record what the PROVIDER INGRESS BOUNDARY and the SUPPLY PROJECTION did.
-- Operational evidence, never business truth: canonical SCP events and records
-- remain the measurement authority and nothing here is read back as authority
-- for an approval, a confirmation or an eligibility decision.
-- =============================================================================

ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_SESSION_ISSUED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_SESSION_REFUSED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_INGRESS_ACCEPTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_INGRESS_REPLAYED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_INGRESS_REFUSED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_CARD_SUBMITTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_CARD_APPROVED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_CARD_REJECTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'AVAILABILITY_SUBMITTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'AVAILABILITY_CONFIRMED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'AVAILABILITY_INVALIDATED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'SERVICE_AREA_PROJECTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'APPROVED_SUPPLY_PROJECTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'PROVIDER_MEDIA_STORED';
