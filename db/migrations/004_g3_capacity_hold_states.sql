-- =============================================================================
-- SCP-G3-EXEC-01 — capacity hold state vocabulary.
-- Migration 004.
--
-- Deliberately its own file with no surrounding transaction: PostgreSQL will
-- not let a value added to an enum be USED in the same transaction that adds
-- it, and migration 005 rebuilds the exclusive-capacity exclusion constraint
-- using these values.
--
-- CapacityHold stays owned by the existing G2 capacity module — this widens
-- that owner's vocabulary rather than creating parallel capacity truth.
--
--   ACTIVE      first-class G3 hold, blocks exclusive capacity, expires
--   CONSUMED    consumed exactly once by a CommercialCommit
--   EXPIRED     TTL elapsed; capacity is reclaimable
--   INVALIDATED governing offer was invalidated/superseded
--
-- HELD and COMMITTED remain for the G2 dispatch path and are migration-era
-- aliases of ACTIVE and CONSUMED (see CAPACITY_HOLD_STATE_ALIAS in
-- src/core/capacity/capacity.ts). Both still block capacity.
-- =============================================================================

ALTER TYPE capacity_hold_state ADD VALUE IF NOT EXISTS 'ACTIVE';
ALTER TYPE capacity_hold_state ADD VALUE IF NOT EXISTS 'CONSUMED';
ALTER TYPE capacity_hold_state ADD VALUE IF NOT EXISTS 'EXPIRED';
ALTER TYPE capacity_hold_state ADD VALUE IF NOT EXISTS 'INVALIDATED';
