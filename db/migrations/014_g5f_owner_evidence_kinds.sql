-- =============================================================================
-- SCP-G5-F-01 — Owner operational evidence kinds.
-- Migration 014. Additive over 002-013.
--
-- NO transaction block, for the same reason as migrations 004, 006, 010 and 012:
-- PostgreSQL will not add an enum value inside a transaction that later uses it.
-- ON_ERROR_STOP still makes a partial apply fail loudly.
--
-- These record what the OWNER OPERATING BOUNDARY did. Operational evidence,
-- never business truth: canonical SCP events and the core_operational_action
-- audit trail remain the authority, and nothing here is read back as authority
-- for a qualification, an assignment or a lifecycle decision.
-- =============================================================================

ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_SESSION_ISSUED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_COMMAND_ACCEPTED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_COMMAND_REPLAYED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_COMMAND_REFUSED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_QUALIFICATION_RECORDED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_MATCH_EVALUATED';
ALTER TYPE runtime_evidence_kind ADD VALUE IF NOT EXISTS 'OWNER_SUPPLY_SYNCHRONIZED';
