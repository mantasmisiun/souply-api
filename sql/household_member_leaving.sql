-- Souply 2.0 FAMILY SHOPPING — the "leaving" membership state (spec §3.2.2).
-- Idempotent; FK-less like the other 2.0 tables.
--
-- §3.1 blocks a member from leaving with a non-zero balance, and §3.2.1 makes
-- settlement need BOTH parties. Together those two rules can trap a member
-- behind an unresponsive counterparty, so §3.2.2 introduces an intermediate
-- state: the member has REQUESTED to leave and is immediately excluded from
-- new trips, but is still in the household until their balance reaches zero.
--
-- WHY A COLUMN ON HouseholdMember AND NOT A SEPARATE TABLE
--   · HouseholdMember has PRIMARY KEY(userId) — exactly one membership row per
--     user, forever. A side table would therefore be strictly 1:0..1 against
--     that key: the same cardinality a nullable column already expresses, at
--     the cost of a join on every read.
--   · "Leaving" is a state OF the membership, not an entity with its own
--     lifetime. Every caller that needs it (participant eligibility, the
--     family-receipt upload gate, the roster) is ALREADY loading the member
--     row, so the flag rides along for free.
--   · Departure DELETEs the membership row, which disposes of the leaving
--     state atomically with it. A side table would need its own cleanup, and
--     a missed cleanup would resurrect a stale "leaving" flag on a rejoin.
--   · It deliberately does NOT live in HouseholdLedgerEvent: that log is the
--     MONEY model (§1.1 fixes its six event types, and `member_left` means
--     actually gone). Requesting to leave moves no money and must not change
--     the fold, so it belongs to membership state, not to the ledger.
--
-- A TIMESTAMP rather than an ENUM('active','leaving') because the request time
-- is load-bearing — it is what the notification copy and any future audit read
-- — and nullable-timestamp-as-state is the house convention already (revokedAt,
-- archivedAt, claimedAt, readAt).
ALTER TABLE HouseholdMember
    ADD COLUMN IF NOT EXISTS leavingRequestedAt DATETIME DEFAULT NULL,
    -- Who initiated it: the member themselves (§3.3 "any member may remove
    -- THEMSELVES") or the owner removing them. Drives the notification wording
    -- and is the only way to tell the two apart after the fact.
    ADD COLUMN IF NOT EXISTS leavingRequestedBy CHAR(36) DEFAULT NULL,
    -- The eligibility read: "the members of household H who may still be added
    -- as participants" (§3.2.2) — i.e. leavingRequestedAt IS NULL.
    ADD KEY IF NOT EXISTS idx_hm_leaving (householdId, leavingRequestedAt);
