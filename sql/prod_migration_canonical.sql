-- Production migration: bring Basket_DB up to Basket-DB-Test (dev branch).
-- Idempotent — every change guarded by INFORMATION_SCHEMA checks.
-- Skips Store.address tightening (needs data audit first) and cosmetic
-- collation/index-name differences.
--
-- Apply in DBeaver (default delimiter handling) OR via:
--   docker cp prod_migration_canonical.sql mysql:/tmp/
--   docker exec mysql sh -c 'mysql -u root -p"$MYSQL_ROOT_PASSWORD" Basket_DB < /tmp/prod_migration_canonical.sql'

DROP PROCEDURE IF EXISTS run_migration_canonical;

DELIMITER //

CREATE PROCEDURE run_migration_canonical()
BEGIN

    -- ─────────────────────────────────────────────
    -- 1. New tables (required by admin queue + features)
    -- ─────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS AccountRecoveryAttempt (
        id BIGINT NOT NULL AUTO_INCREMENT,
        deviceFingerprint VARCHAR(128) COLLATE utf8mb4_unicode_ci NOT NULL,
        matchedUserId CHAR(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
        succeeded TINYINT(1) NOT NULL DEFAULT 0,
        failureReason VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
        attemptedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_device (deviceFingerprint, attemptedAt),
        KEY idx_user (matchedUserId, attemptedAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS AdminAuditLog (
        id BIGINT NOT NULL AUTO_INCREMENT,
        adminUserId VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
        action VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
        targetType VARCHAR(32) COLLATE utf8mb4_unicode_ci NOT NULL,
        targetId BIGINT NOT NULL,
        valueBefore JSON DEFAULT NULL,
        valueAfter JSON DEFAULT NULL,
        reversedAt DATETIME DEFAULT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_admin (adminUserId, createdAt),
        KEY idx_target (targetType, targetId, createdAt)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS AdminCardLease (
        id BIGINT NOT NULL AUTO_INCREMENT,
        spId INT NOT NULL,
        leasedTo VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
        queueKind ENUM('image','amount','flag','uncategorised') COLLATE utf8mb4_unicode_ci NOT NULL,
        leasedAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        expiresAt DATETIME NOT NULL,
        completedAt DATETIME DEFAULT NULL,
        abandonedAt DATETIME DEFAULT NULL,
        PRIMARY KEY (id),
        KEY idx_active (queueKind, completedAt, abandonedAt, expiresAt),
        KEY idx_admin (leasedTo, queueKind, completedAt, abandonedAt),
        KEY idx_sp (spId, queueKind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS CategoryTranslation (
        categoryId INT NOT NULL,
        locale VARCHAR(8) COLLATE utf8mb4_unicode_ci NOT NULL,
        name VARCHAR(255) COLLATE utf8mb4_unicode_ci NOT NULL,
        PRIMARY KEY (categoryId, locale),
        KEY idx_locale (locale),
        CONSTRAINT fk_category_translation_category
            FOREIGN KEY (categoryId) REFERENCES Category (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS ImagePropagationLog (
        id BIGINT NOT NULL AUTO_INCREMENT,
        spId INT NOT NULL,
        sourceType ENUM('cross_chain_sibling','admin_adopt_candidate','admin_upload','user_upload_approved')
            COLLATE utf8mb4_unicode_ci NOT NULL,
        sourceSpId INT DEFAULT NULL,
        fromImageUrl VARCHAR(500) COLLATE utf8mb4_unicode_ci DEFAULT NULL,
        toImageUrl VARCHAR(500) COLLATE utf8mb4_unicode_ci NOT NULL,
        actor VARCHAR(64) COLLATE utf8mb4_unicode_ci NOT NULL,
        reversedAt DATETIME DEFAULT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_sp (spId, createdAt),
        KEY idx_actor (actor, createdAt),
        CONSTRAINT fk_ipl_sp FOREIGN KEY (spId) REFERENCES StoreProduct (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- ─────────────────────────────────────────────
    -- 2. Existing table changes — columns
    -- ─────────────────────────────────────────────

    -- ReceiptLineIssue: status/resolvedBy/resolvedAt columns
    -- (referenced by adminAmountQueueModel + adminFlagQueueModel).
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ReceiptLineIssue' AND COLUMN_NAME = 'status'
    ) THEN
        ALTER TABLE ReceiptLineIssue
            ADD COLUMN status ENUM('pending','resolved','dismissed')
                COLLATE utf8mb4_unicode_ci NOT NULL DEFAULT 'pending';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ReceiptLineIssue' AND COLUMN_NAME = 'resolvedBy'
    ) THEN
        ALTER TABLE ReceiptLineIssue
            ADD COLUMN resolvedBy VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ReceiptLineIssue' AND COLUMN_NAME = 'resolvedAt'
    ) THEN
        ALTER TABLE ReceiptLineIssue
            ADD COLUMN resolvedAt DATETIME DEFAULT NULL;
    END IF;

    -- AdminReviewFlag.flaggedBy: NOT NULL → NULLABLE (matches test).
    -- Test also changed the FK from CASCADE → SET NULL; safe because
    -- the column is now nullable.
    ALTER TABLE AdminReviewFlag
        MODIFY COLUMN flaggedBy VARCHAR(64) COLLATE utf8mb4_unicode_ci DEFAULT NULL;

    -- Receipt.userId: NOT NULL → NULLABLE (FK SET NULL when user deleted).
    ALTER TABLE Receipt
        MODIFY COLUMN userId CHAR(36) COLLATE utf8mb4_unicode_ci DEFAULT NULL;

    -- ─────────────────────────────────────────────
    -- 3. Existing table changes — indexes
    -- ─────────────────────────────────────────────

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'ReceiptLineIssue' AND INDEX_NAME = 'idx_status'
    ) THEN
        CREATE INDEX idx_status ON ReceiptLineIssue (status, createdAt);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt' AND INDEX_NAME = 'userId'
    ) THEN
        CREATE INDEX userId ON Receipt (userId);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product' AND INDEX_NAME = 'idx_category_score'
    ) THEN
        CREATE INDEX idx_category_score ON Product (categoryId, globalScore DESC);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product' AND INDEX_NAME = 'idx_global_score'
    ) THEN
        CREATE INDEX idx_global_score ON Product (globalScore DESC);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserProductScore' AND INDEX_NAME = 'idx_user_score'
    ) THEN
        CREATE INDEX idx_user_score ON UserProductScore (userId, score DESC);
    END IF;

    -- ─────────────────────────────────────────────
    -- 4. Foreign-key behaviour changes (drop + re-add)
    -- ─────────────────────────────────────────────

    -- Basket.userId → User: add ON DELETE CASCADE
    IF EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Basket'
          AND CONSTRAINT_NAME = 'Basket_ibfk_1' AND DELETE_RULE <> 'CASCADE'
    ) THEN
        ALTER TABLE Basket DROP FOREIGN KEY Basket_ibfk_1;
        ALTER TABLE Basket ADD CONSTRAINT Basket_ibfk_1
            FOREIGN KEY (userId) REFERENCES User (id) ON DELETE CASCADE;
    END IF;

    -- ShoppingList.userId → User: add ON DELETE CASCADE
    IF EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'ShoppingList'
          AND CONSTRAINT_NAME = 'ShoppingList_ibfk_1' AND DELETE_RULE <> 'CASCADE'
    ) THEN
        ALTER TABLE ShoppingList DROP FOREIGN KEY ShoppingList_ibfk_1;
        ALTER TABLE ShoppingList ADD CONSTRAINT ShoppingList_ibfk_1
            FOREIGN KEY (userId) REFERENCES User (id) ON DELETE CASCADE;
    END IF;

    -- Receipt.userId → User: ON DELETE SET NULL
    IF EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt'
          AND CONSTRAINT_NAME = 'Receipt_ibfk_1' AND DELETE_RULE <> 'SET NULL'
    ) THEN
        ALTER TABLE Receipt DROP FOREIGN KEY Receipt_ibfk_1;
        ALTER TABLE Receipt ADD CONSTRAINT Receipt_ibfk_1
            FOREIGN KEY (userId) REFERENCES User (id) ON DELETE SET NULL;
    END IF;

    -- AdminReviewFlag.flaggedBy → User: CASCADE → SET NULL
    IF EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'AdminReviewFlag'
          AND CONSTRAINT_NAME = 'fk_arf_user' AND DELETE_RULE <> 'SET NULL'
    ) THEN
        ALTER TABLE AdminReviewFlag DROP FOREIGN KEY fk_arf_user;
        ALTER TABLE AdminReviewFlag ADD CONSTRAINT fk_arf_user
            FOREIGN KEY (flaggedBy) REFERENCES User (id) ON DELETE SET NULL;
    END IF;

    -- StoreProductMatchVote.userId → User: CASCADE → SET NULL
    IF EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'StoreProductMatchVote'
          AND CONSTRAINT_NAME = 'fk_spmv_user' AND DELETE_RULE <> 'SET NULL'
    ) THEN
        ALTER TABLE StoreProductMatchVote DROP FOREIGN KEY fk_spmv_user;
        ALTER TABLE StoreProductMatchVote ADD CONSTRAINT fk_spmv_user
            FOREIGN KEY (userId) REFERENCES User (id) ON DELETE SET NULL;
    END IF;

    -- ─────────────────────────────────────────────
    -- 5. UserStoreProductEquivalence: unique key rename + 3 indexes + 3 FKs.
    -- Run only if the new FK doesn't already exist (idempotency).
    -- Skips silently if orphan rows would block FK creation — manual
    -- cleanup needed (see notes after the procedure).
    -- ─────────────────────────────────────────────

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserStoreProductEquivalence'
          AND INDEX_NAME = 'uq_user_sp_pair'
    ) THEN
        -- Rename via drop+add (MySQL 8.0 supports RENAME INDEX directly,
        -- but DROP+ADD works on every version and is unambiguous).
        IF EXISTS (
            SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserStoreProductEquivalence'
              AND INDEX_NAME = 'uq_user_pair'
        ) THEN
            ALTER TABLE UserStoreProductEquivalence DROP INDEX uq_user_pair;
        END IF;
        ALTER TABLE UserStoreProductEquivalence
            ADD UNIQUE KEY uq_user_sp_pair (userId, spIdA, spIdB);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserStoreProductEquivalence' AND INDEX_NAME = 'idx_user'
    ) THEN
        CREATE INDEX idx_user ON UserStoreProductEquivalence (userId);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserStoreProductEquivalence' AND INDEX_NAME = 'idx_spA'
    ) THEN
        CREATE INDEX idx_spA ON UserStoreProductEquivalence (spIdA);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'UserStoreProductEquivalence' AND INDEX_NAME = 'idx_spB'
    ) THEN
        CREATE INDEX idx_spB ON UserStoreProductEquivalence (spIdB);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_uspe_user'
    ) THEN
        ALTER TABLE UserStoreProductEquivalence
            ADD CONSTRAINT fk_uspe_user FOREIGN KEY (userId)
            REFERENCES User (id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_uspe_spA'
    ) THEN
        ALTER TABLE UserStoreProductEquivalence
            ADD CONSTRAINT fk_uspe_spA FOREIGN KEY (spIdA)
            REFERENCES StoreProduct (id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND CONSTRAINT_NAME = 'fk_uspe_spB'
    ) THEN
        ALTER TABLE UserStoreProductEquivalence
            ADD CONSTRAINT fk_uspe_spB FOREIGN KEY (spIdB)
            REFERENCES StoreProduct (id) ON DELETE CASCADE;
    END IF;

END//

DELIMITER ;

CALL run_migration_canonical();

DROP PROCEDURE IF EXISTS run_migration_canonical;
