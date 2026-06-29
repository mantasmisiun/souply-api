-- ReceiptLineResolution: the per-line "ask-once" ledger for the swipe-queue
-- redesign (see shared/SWIPE_QUEUE_REDESIGN.md, Decision 1).
--
-- One row per (receipt line) the moment we either ASK about it (a card was
-- served / a fast-swipe came in) or RESOLVE it (the user acted, or a system
-- action finished it). The swipe queue filters out any line that already has a
-- row, so a rejected or auto-resolved item is never re-carded — the "ask once,
-- never nag" guarantee. Keyed on (receiptId, receiptLineIdx): a receipt belongs
-- to a single user, so no userId is needed. Durable (survives a re-scan of the
-- same receipt id) and queryable for ranking/analytics.
--
--   status: 'asked'          — shown but not acted on (e.g. a burst/fast swipe).
--           'resolved_user'  — the user swiped identical/similar/different.
--           'resolved_system'— a no-card system action finished the line.
--   resolvedVia: free-text reason ('reject_runner_up','reject_orphan','confirm',
--           'similar','auto_repick','auto_demote','burst_skip', …) for analytics.

CREATE TABLE IF NOT EXISTS ReceiptLineResolution (
    id              INT UNSIGNED NOT NULL AUTO_INCREMENT,
    receiptId       INT NOT NULL,
    receiptLineIdx  INT NOT NULL,
    status          ENUM('asked', 'resolved_user', 'resolved_system') NOT NULL,
    resolvedVia     VARCHAR(40) NULL,
    createdAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_receipt_line (receiptId, receiptLineIdx),
    KEY idx_receipt (receiptId),

    CONSTRAINT fk_rlr_receipt FOREIGN KEY (receiptId) REFERENCES Receipt(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
