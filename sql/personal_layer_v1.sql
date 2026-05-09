-- Personal layer v1 migrations
-- Run once on both Basket-DB-Test and Basket-DB (production).

-- 1. Re-verification flag on personal equivalences.
ALTER TABLE UserStoreProductEquivalence
    ADD COLUMN needsReverification TINYINT(1) NOT NULL DEFAULT 0;

-- 2. Track last-changed timestamp on vote rows separately from original swipe date.
ALTER TABLE StoreProductMatchVote
    ADD COLUMN updatedAt TIMESTAMP NOT NULL
        DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;

-- 3. Allow NULL dwellMs for votes edited via the history screen (no real dwell to measure).
ALTER TABLE StoreProductMatchVote
    MODIFY COLUMN dwellMs INT DEFAULT NULL;

-- 4. Admin review flags for self-pair rejections.
CREATE TABLE AdminReviewFlag (
    id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
    type        ENUM('self-pair-rejected') NOT NULL,
    receiptId   INT DEFAULT NULL,
    lineIdx     INT DEFAULT NULL,
    spId        INT DEFAULT NULL,
    flaggedBy   VARCHAR(64) NOT NULL,
    status      ENUM('pending', 'resolved', 'dismissed') NOT NULL DEFAULT 'pending',
    createdAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_arf_status   (status),
    KEY idx_arf_reporter (flaggedBy),
    CONSTRAINT fk_arf_receipt FOREIGN KEY (receiptId)
        REFERENCES Receipt  (id) ON DELETE SET NULL,
    CONSTRAINT fk_arf_sp     FOREIGN KEY (spId)
        REFERENCES StoreProduct (id) ON DELETE SET NULL,
    CONSTRAINT fk_arf_user   FOREIGN KEY (flaggedBy)
        REFERENCES User (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 5. One-time cleanup: remove personal equivalences written by burst swipes.
DELETE e
  FROM UserStoreProductEquivalence e
  JOIN StoreProductMatchVote v
    ON  v.userId = e.userId
    AND v.spIdA  = e.spIdA
    AND v.spIdB  = e.spIdB
 WHERE v.dwellMs IS NOT NULL
   AND v.dwellMs < 1000;
