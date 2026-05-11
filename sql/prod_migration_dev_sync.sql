-- Production migration: sync Basket_DB to match Basket-DB-Test (dev branch state)
-- Safe to re-run: all changes are guarded by INFORMATION_SCHEMA checks.
-- Run in DBeaver with default delimiter handling (DBeaver auto-detects DELIMITER //).

DROP PROCEDURE IF EXISTS run_migration;

DELIMITER //

CREATE PROCEDURE run_migration()
BEGIN

    -- ─────────────────────────────────────────────
    -- 1. Missing columns on existing tables
    -- ─────────────────────────────────────────────

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Price' AND COLUMN_NAME = 'requiresCoupon'
    ) THEN
        ALTER TABLE Price ADD COLUMN requiresCoupon TINYINT(1) NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Product' AND COLUMN_NAME = 'globalScore'
    ) THEN
        ALTER TABLE Product ADD COLUMN globalScore DECIMAL(10,4) NOT NULL DEFAULT 0.0000;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt' AND COLUMN_NAME = 'mandatorySwipesRequired'
    ) THEN
        ALTER TABLE Receipt ADD COLUMN mandatorySwipesRequired TINYINT NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt' AND COLUMN_NAME = 'mandatorySwipesCompleted'
    ) THEN
        ALTER TABLE Receipt ADD COLUMN mandatorySwipesCompleted TINYINT NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt' AND COLUMN_NAME = 'hasBurstSwipes'
    ) THEN
        ALTER TABLE Receipt ADD COLUMN hasBurstSwipes TINYINT(1) NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt' AND COLUMN_NAME = 'savedAmount'
    ) THEN
        ALTER TABLE Receipt ADD COLUMN savedAmount DECIMAL(10,2) NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'points'
    ) THEN
        ALTER TABLE User ADD COLUMN points INT NOT NULL DEFAULT 0;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'StoreProductMatchVote' AND COLUMN_NAME = 'updatedAt'
    ) THEN
        ALTER TABLE StoreProductMatchVote
            ADD COLUMN updatedAt TIMESTAMP NOT NULL
                DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP;
    END IF;

    -- ─────────────────────────────────────────────
    -- 2. Column type/nullability changes
    -- ─────────────────────────────────────────────

    ALTER TABLE StoreProductMatchVote
        MODIFY COLUMN userId VARCHAR(64) DEFAULT NULL,
        MODIFY COLUMN dwellMs INT DEFAULT NULL;

    -- ─────────────────────────────────────────────
    -- 3. Missing tables
    -- ─────────────────────────────────────────────

    CREATE TABLE IF NOT EXISTS UserStoreProductEquivalence (
        id          INT UNSIGNED NOT NULL AUTO_INCREMENT,
        userId      VARCHAR(36) NOT NULL,
        spIdA       INT NOT NULL,
        spIdB       INT NOT NULL,
        verdict     ENUM('same','different') NOT NULL,
        createdAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updatedAt   DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        needsReverification TINYINT(1) NOT NULL DEFAULT 0,
        PRIMARY KEY (id),
        UNIQUE KEY uq_user_pair (userId, spIdA, spIdB)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS ProductInteraction (
        id        BIGINT NOT NULL AUTO_INCREMENT,
        userId    VARCHAR(36) NOT NULL,
        productId INT NOT NULL,
        type      ENUM('basket_add','list_add','list_check') NOT NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_pi_user_product (userId, productId),
        KEY idx_pi_product (productId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS UserProductScore (
        userId           VARCHAR(36) NOT NULL,
        productId        INT NOT NULL,
        score            DECIMAL(10,4) NOT NULL DEFAULT 0.0000,
        interactionCount INT NOT NULL DEFAULT 0,
        updatedAt        DATETIME NOT NULL,
        PRIMARY KEY (userId, productId)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    CREATE TABLE IF NOT EXISTS AdminReviewFlag (
        id        INT UNSIGNED NOT NULL AUTO_INCREMENT,
        type      ENUM('self-pair-rejected') NOT NULL,
        receiptId INT DEFAULT NULL,
        lineIdx   INT DEFAULT NULL,
        spId      INT DEFAULT NULL,
        flaggedBy VARCHAR(64) NOT NULL,
        status    ENUM('pending','resolved','dismissed') NOT NULL DEFAULT 'pending',
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_arf_status   (status),
        KEY idx_arf_reporter (flaggedBy),
        CONSTRAINT fk_arf_receipt FOREIGN KEY (receiptId) REFERENCES Receipt  (id) ON DELETE SET NULL,
        CONSTRAINT fk_arf_sp      FOREIGN KEY (spId)      REFERENCES StoreProduct (id) ON DELETE SET NULL,
        CONSTRAINT fk_arf_user    FOREIGN KEY (flaggedBy)  REFERENCES User (id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

    -- ─────────────────────────────────────────────
    -- 4. Performance indexes
    -- ─────────────────────────────────────────────

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'StoreProductMatchVote' AND INDEX_NAME = 'idx_spmv_user_created'
    ) THEN
        CREATE INDEX idx_spmv_user_created ON StoreProductMatchVote (userId, createdAt);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Price' AND INDEX_NAME = 'idx_price_receipt_sp'
    ) THEN
        CREATE INDEX idx_price_receipt_sp ON Price (receiptId, storeProductId, isFallback);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Price' AND INDEX_NAME = 'idx_price_receipt_verified'
    ) THEN
        CREATE INDEX idx_price_receipt_verified ON Price (receiptId, isFallback, priceVerified, storeProductId);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Receipt' AND INDEX_NAME = 'idx_receipt_user_status'
    ) THEN
        CREATE INDEX idx_receipt_user_status ON Receipt (userId, processingStatus);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Price' AND INDEX_NAME = 'idx_price_store_verified'
    ) THEN
        CREATE INDEX idx_price_store_verified ON Price (storeId, priceVerified, storeProductId);
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Price' AND INDEX_NAME = 'idx_price_promo_end'
    ) THEN
        CREATE INDEX idx_price_promo_end ON Price (promoEnd, storeProductId);
    END IF;

END//

DELIMITER ;

CALL run_migration();

DROP PROCEDURE IF EXISTS run_migration;
