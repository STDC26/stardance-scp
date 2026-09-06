-- =============================================================================
-- SCP-G4-EXEC-01 — lifecycle enum vocabulary.
-- Migration 006.
--
-- Own file, no surrounding transaction: PostgreSQL will not let a value added
-- to an enum be USED in the transaction that adds it, and 007 uses SUPERSEDED
-- in a partial index predicate.
--
-- G4-A requires DispatchAttempt dispositions OPEN / ACCEPTED / REJECTED /
-- EXPIRED / SUPERSEDED. The existing core_dispatch_offer already carries
-- OFFERED (= OPEN), ACCEPTED, DECLINED (= REJECTED) and EXPIRED. Only
-- SUPERSEDED is genuinely new, so the dispatch concept keeps exactly one owner
-- rather than gaining a competing table.
-- =============================================================================

ALTER TYPE dispatch_offer_state ADD VALUE IF NOT EXISTS 'SUPERSEDED';
