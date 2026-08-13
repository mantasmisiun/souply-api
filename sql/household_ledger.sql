-- Souply 2.0 — FAMILY SHOPPING LEDGER (spec §1). The append-only event log per
-- household. Balances are DERIVED by folding this log (see
-- src/services/householdLedger.ts) and are NEVER stored: there is no balance
-- column anywhere, so there is nothing to drift.
-- Idempotent; FK-less like the other 2.0 tables.
--
-- ONE polymorphic table rather than a table per event type, because:
--   · The fold reads EVERY event of a household in ONE deterministic order.
--     Six tables would need a six-way UNION plus a merge key just to
--     reconstruct that order — the ordering guarantee would live in a query
--     instead of in the schema.
--   · AUTO_INCREMENT `id` IS the total order, so ties on `at` can never make
--     the fold non-deterministic.
--   · There is exactly ONE append path to audit for the append-only property.
--   · The payloads are never queried field-by-field (the fold loads whole
--     events), so a JSON blob costs nothing and a per-type column set buys
--     nothing. The two fields that ARE queried (receiptId for the §4.4 lock
--     window, settlementId for confirm lookups) are lifted out and indexed.
--
-- The materialised shares (§1.3) live INSIDE the receipt_recorded payload, not
-- in a child table, deliberately: one row = one atomic INSERT, so
-- `sum(shares) === amountCents` cannot be broken by a half-written child set.

CREATE TABLE IF NOT EXISTS HouseholdLedgerEvent (
    id BIGINT(20) NOT NULL AUTO_INCREMENT,
    householdId INT(11) NOT NULL,
    type ENUM(
        'receipt_recorded',
        'member_joined',
        'member_left',
        'settlement_proposed',
        'settlement_confirmed',
        'adjustment'
    ) NOT NULL,
    -- Server timestamp (§1.4). Millisecond precision so same-second events
    -- still order sensibly; `id` breaks any remaining tie.
    at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    -- Correlation keys lifted out of the payload ONLY where a query needs them.
    receiptId INT(11) DEFAULT NULL,
    settlementId VARCHAR(64) DEFAULT NULL,
    -- Who caused the event (payer / joiner / leaver / proposer / confirmer).
    actorUserId CHAR(36) DEFAULT NULL,

    -- The full event body, exactly as folded. MariaDB stores JSON as LONGTEXT
    -- with CHECK(json_valid(...)) — same as the other JSON columns here.
    payload JSON NOT NULL,

    -- At-most-once key for the events that must never double-apply:
    --   'receipt:<receiptId>', 'propose:<settlementId>', 'confirm:<settlementId>'
    -- NULL for the events that legitimately repeat (join / leave / adjustment);
    -- a UNIQUE key admits any number of NULLs, so those are unconstrained.
    dedupeKey VARCHAR(191) DEFAULT NULL,

    PRIMARY KEY (id),
    UNIQUE KEY uq_hle_dedupe (householdId, dedupeKey),
    -- The fold's only read path: all events for household H, in order.
    KEY idx_hle_household (householdId, at, id),
    KEY idx_hle_receipt (householdId, receiptId),
    KEY idx_hle_settlement (householdId, settlementId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Append-only is enforced in the MODEL (householdLedgerModel exports no UPDATE
-- and no DELETE), not by a trigger: user deletion (sql/user_deletion_v1.sql)
-- and the dev receipt purge both need a physical delete path, and a SIGNAL
-- trigger would make those operations impossible rather than merely audited.
