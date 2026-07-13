-- ReceiptItem: a receipt LINE as a first-class relational row (see
-- shared/RECEIPT_ITEM_MIGRATION.md). Replaces the per-line `parsedData.products[]`
-- JSON array on Receipt. A line is an OBSERVATION (store/day/OCR text/price), NOT a
-- catalog entity — the receipt identifies an existing product + updates its price, and
-- never mints a StoreProduct/Product. Unmatched lines carry matchedSpId = NULL.
--
-- Design: hot / individually-mutated fields are COLUMNS so a swipe is a single-column
-- UPDATE (no whole-blob rewrite under FOR UPDATE); heavy whole-read fields are JSON;
-- `extra` is a catch-all that makes blob<->row reconstruction lossless (parity by
-- construction — required for the hard cutover). One row per (receiptId, lineIdx).

CREATE TABLE IF NOT EXISTS ReceiptItem (
    -- signed INT (not UNSIGNED) to match Receipt/StoreProduct/Price ids so the
    -- Price.receiptItemId FK below is well-formed (FK needs matching signedness).
    id                    INT NOT NULL AUTO_INCREMENT,
    receiptId             INT NOT NULL,
    lineIdx               INT NOT NULL,               -- position in the original products[]

    -- immutable OCR / parse
    name                  VARCHAR(512) NOT NULL DEFAULT '',
    price                 DECIMAL(10,2) NULL,
    promoPrice            DECIMAL(10,2) NULL,
    quantity              DECIMAL(10,3) NULL,         -- item count
    unit                  VARCHAR(20) NULL,           -- display unit (vnt/kg)
    amount                DECIMAL(10,3) NULL,         -- pack size
    sizeUnit              VARCHAR(20) NULL,           -- pack unit (g/ml)
    isWeighable           TINYINT(1) NOT NULL DEFAULT 0,
    pricePerUnit          DECIMAL(10,4) NULL,
    brandName             VARCHAR(255) NULL,

    -- match binding (mutated by resolver + Card-B swipes)
    matchedSpId           INT NULL,                   -- was line.storeProductId; NULL = unmatched
    matchSource           VARCHAR(24) NULL,           -- reused|bootstrapped|created|skipped_unpriced
    matchedName           VARCHAR(512) NULL,
    storeProductImageUrl  VARCHAR(1024) NULL,
    matchConfidence       DECIMAL(4,3) NULL,
    matchConfirmed        TINYINT(1) NOT NULL DEFAULT 0,
    priceVerified         TINYINT(1) NOT NULL DEFAULT 0,
    variantUncertain      TINYINT(1) NOT NULL DEFAULT 0,
    priceImplausible      TINYINT(1) NOT NULL DEFAULT 0,

    -- confidence + category (display / queue priority)
    band                  VARCHAR(8) NULL,            -- itemConfidence.band, denormalised for queries
    needsHuman            DECIMAL(8,2) NULL,
    categoryId            INT NULL,
    categoryName          VARCHAR(255) NULL,
    categoryL2Name        VARCHAR(255) NULL,

    -- cold JSON (read whole, not per-field)
    itemConfidence        JSON NULL,                  -- {band, score, vetoes[]}
    altMatches            JSON NULL,                  -- candidate SPs for swipe voting
    region                JSON NULL,                  -- crop geometry
    rawLines              JSON NULL,                  -- OCR line fragments
    extra                 JSON NULL,                  -- catch-all: any unmapped line key (lossless)

    createdAt             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updatedAt             DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

    PRIMARY KEY (id),
    UNIQUE KEY uq_receipt_line (receiptId, lineIdx),
    KEY idx_ri_receipt (receiptId, lineIdx),
    KEY idx_ri_sp (matchedSpId),

    CONSTRAINT fk_ri_receipt FOREIGN KEY (receiptId) REFERENCES Receipt(id) ON DELETE CASCADE,
    CONSTRAINT fk_ri_sp FOREIGN KEY (matchedSpId) REFERENCES StoreProduct(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- A receipt-derived Price now links to the exact ReceiptItem it came from, so it is
-- trivially removable / re-assignable when a line's match changes. receiptId stays
-- (denormalised from the item's receipt) so existing Price indexes/queries are unchanged.
-- Guarded so re-running the migration is safe (MariaDB has no ADD COLUMN IF NOT EXISTS
-- on all versions; this uses the information_schema check pattern).
SET @col_exists := (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'Price' AND COLUMN_NAME = 'receiptItemId'
);
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE Price
        ADD COLUMN receiptItemId INT NULL AFTER receiptId,
        ADD KEY idx_price_receiptitem (receiptItemId),
        ADD CONSTRAINT fk_price_receiptitem FOREIGN KEY (receiptItemId) REFERENCES ReceiptItem(id) ON DELETE CASCADE',
    'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
