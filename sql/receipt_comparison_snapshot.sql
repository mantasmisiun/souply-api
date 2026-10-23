-- Souply 2.0 Phase 5 — frozen per-receipt comparison deltas (spec: Sutaupyta
-- = median comparable-store total − paid, SIGNED; Galėjai sutaupyti = paid −
-- cheapest alternative). Computed with as-of-save prices and PERSISTED so the
-- figures never drift as catalog prices move; recomputed only when the
-- receipt itself changes (autosave/reparse). Idempotent.
--
-- Apply order: dev → staging → prod (batch into the prod checklist).

CREATE TABLE IF NOT EXISTS ReceiptComparisonSnapshot (
    receiptId INT(11) NOT NULL,
    paidTotal DECIMAL(10,2) NOT NULL,
    medianAltTotal DECIMAL(10,2) DEFAULT NULL,
    cheapestAltTotal DECIMAL(10,2) DEFAULT NULL,
    altCount INT(11) NOT NULL DEFAULT 0,
    computedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (receiptId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
