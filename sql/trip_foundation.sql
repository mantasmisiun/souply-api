-- Souply 2.0 Phase 1a — the Apsipirkimas (trip) aggregate foundation.
-- PURELY ADDITIVE: no existing column changes, no behavior change for v1.x
-- clients. Stages are NEVER stored — they derive from per-store slot facts
-- (see src/services/tripStageService.ts). Idempotent (IF NOT EXISTS
-- throughout); FK-less by design like the newer tables (advisory joins,
-- dangling rows tolerated; app-level integrity).
--
-- Apply order: dev → staging → prod (batch into the prod checklist).

CREATE TABLE IF NOT EXISTS Trip (
    id INT(11) NOT NULL AUTO_INCREMENT,
    createdByUserId CHAR(36) NOT NULL,
    -- Future Household table (Phase 1c); NULL = personal trip.
    householdId INT(11) DEFAULT NULL,
    name VARCHAR(255) DEFAULT NULL,
    -- List-less trip born at stage 5 (ad-hoc receipt upload / backfill).
    isAdHoc TINYINT(1) NOT NULL DEFAULT 0,
    -- Historic backfilled trips are EXCLUDED from the planning score
    -- (decision 2026-07-16: nobody starts 2.0 pre-punished).
    scoreExempt TINYINT(1) NOT NULL DEFAULT 0,
    -- Auto-archive (48 h stages 1-2 / 7 d stages 3-4) or manual. Archived:
    -- no notification-dot contribution, never an auto-add target.
    archivedAt DATETIME DEFAULT NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY idx_trip_user (createdByUserId, archivedAt),
    KEY idx_trip_household (householdId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Open membership (decoupled from household): owner = creator; members join
-- via QR/handle/email invites (Phase 1c). Stats are computed per (trip, member).
CREATE TABLE IF NOT EXISTS TripMember (
    tripId INT(11) NOT NULL,
    userId CHAR(36) NOT NULL,
    role ENUM('owner','member') NOT NULL DEFAULT 'member',
    joinedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (tripId, userId),
    KEY idx_tripmember_user (userId)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Attach the existing objects to trips. basketId/shoppingListId columns stay
-- (dual-read during the transition); tripId is the 2.0 spine.
ALTER TABLE Basket
    ADD COLUMN IF NOT EXISTS tripId INT(11) DEFAULT NULL,
    ADD KEY IF NOT EXISTS idx_basket_trip (tripId);

ALTER TABLE ShoppingList
    ADD COLUMN IF NOT EXISTS tripId INT(11) DEFAULT NULL,
    -- "Nepirkau čia": the user skipped this store's receipt slot — the slot
    -- counts as closed for stage derivation and stats recompute.
    ADD COLUMN IF NOT EXISTS receiptSkippedAt DATETIME DEFAULT NULL,
    ADD KEY IF NOT EXISTS idx_list_trip (tripId);

ALTER TABLE Receipt
    ADD COLUMN IF NOT EXISTS tripId INT(11) DEFAULT NULL,
    -- Which member uploaded it (bill-splitting payer foundation). For all
    -- existing rows this equals Receipt.userId (set by backfill).
    ADD COLUMN IF NOT EXISTS uploaderUserId CHAR(36) DEFAULT NULL,
    ADD KEY IF NOT EXISTS idx_receipt_trip (tripId);
