-- =============================================================================
-- SCP-G2R-01 — Amendment durable proposal record.
-- Migration 003. Additive correction over 002; no existing object is redesigned.
--
-- Closes residual R2 (AUDIT_REPLAY_WEAKNESS). Before this migration an
-- Amendment persisted only its identity and state: the change-set it was
-- proposing lived in the event payload and was re-supplied by the caller at
-- validation time. DTS proved the consequence — propose Oct 5, validate the
-- same amendment_id with Oct 20, and the system evaluated Oct 20 with no
-- cross-check.
--
-- The proposal is now stored on the amendment itself, as a canonical normalized
-- document plus its SHA-256, and is immutable for the life of the row.
-- =============================================================================

BEGIN;

ALTER TABLE core_amendment ADD COLUMN proposal JSONB;
ALTER TABLE core_amendment ADD COLUMN proposal_hash TEXT;

-- Pre-correction rows cannot have a durable proposal, and inventing one would
-- manufacture evidence. Fail loudly instead.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM core_amendment WHERE proposal IS NULL) THEN
        RAISE EXCEPTION
            'core_amendment contains rows with no durable proposal; migration 003 will not fabricate proposal content for them';
    END IF;
END
$$;

ALTER TABLE core_amendment ALTER COLUMN proposal SET NOT NULL;
ALTER TABLE core_amendment ALTER COLUMN proposal_hash SET NOT NULL;

-- Structural guard: the hash column holds a lowercase SHA-256 hex digest and
-- nothing else, so a caller cannot park an arbitrary token there.
ALTER TABLE core_amendment
    ADD CONSTRAINT chk_amendment_proposal_hash_shape
    CHECK (proposal_hash ~ '^[0-9a-f]{64}$');

-- The proposal must name its own schema so a replayer knows how to read it.
ALTER TABLE core_amendment
    ADD CONSTRAINT chk_amendment_proposal_schema
    CHECK (proposal ->> 'schema' = 'scp.amendment.proposal.v1');

-- Immutability is enforced in the database, not by convention. Validation may
-- add derived results (proposed_version_id, state, requires_reconfirmation);
-- it may never rewrite what was originally proposed.
CREATE OR REPLACE FUNCTION core_amendment_proposal_immutable()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.proposal IS DISTINCT FROM OLD.proposal
       OR NEW.proposal_hash IS DISTINCT FROM OLD.proposal_hash THEN
        RAISE EXCEPTION
            'core_amendment.proposal is immutable (amendment_id=%)', OLD.amendment_id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_core_amendment_proposal_immutable
    BEFORE UPDATE ON core_amendment
    FOR EACH ROW
    EXECUTE FUNCTION core_amendment_proposal_immutable();

COMMIT;
