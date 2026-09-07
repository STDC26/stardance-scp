-- =============================================================================
-- SCP-G5-D-01 — demand-ingress runtime evidence kinds.
-- Migration 010. Additive over 002-009.
--
-- NO transaction block. PostgreSQL will not add an enum value inside a
-- transaction that later uses it, and the migration runner applies each file
-- with ON_ERROR_STOP, so a partial apply still fails loudly. Same shape as
-- migrations 004 and 006.
--
-- These record what the CUSTOMER INGRESS BOUNDARY did. They are operational
-- evidence, never business truth: canonical SCP events and records remain the
-- measurement authority and nothing here is read back as authority for a
-- lifecycle decision.
-- =============================================================================

ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CATALOGUE_PROJECTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'DEMAND_INGRESS_ACCEPTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'DEMAND_INGRESS_REPLAYED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'DEMAND_INGRESS_REFUSED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'CHANNEL_HANDOFF_ATTEMPTED';
