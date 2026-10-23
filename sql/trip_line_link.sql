-- Souply 2.0 Phase 5 — TripLineLink: persisted list↔receipt line pairs for
-- the planning score. AUTO pairs are recomputed on the fly (same productId);
-- this table stores the MANUAL corrections (connect/unconnect) made in the
-- stage-5 matching interface. Copying the ReceiptLineResolution shape:
-- FK-less, advisory joins, app-level integrity. Idempotent.
--
-- Apply order: dev → staging → prod (batch into the prod checklist).

CREATE TABLE IF NOT EXISTS TripLineLink (
    id INT(11) NOT NULL AUTO_INCREMENT,
    tripId INT(11) NOT NULL,
    -- ShoppingListItem.id ↔ ReceiptItem.id
    listItemId INT(11) NOT NULL,
    receiptItemId INT(11) NOT NULL,
    -- manual = user-connected (earns slightly less credit than auto);
    -- suppressed = user DISCONNECTED an auto pair (kills the auto match).
    kind ENUM('manual','suppressed') NOT NULL DEFAULT 'manual',
    createdByUserId CHAR(36) NOT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY uq_tll_pair (listItemId, receiptItemId),
    KEY idx_tll_trip (tripId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
