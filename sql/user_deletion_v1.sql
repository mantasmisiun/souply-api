-- Migration: user deletion support
--
-- Two FK rule changes:
--   SET NULL  → vote/receipt/flag rows survive user deletion, userId becomes NULL
--   CASCADE   → basket/shopping-list rows are deleted with the user
--
-- Each ALTER is split into drop + add because MySQL rejects same-name
-- constraint drop and add in a single statement.

-- ── StoreProductMatchVote ────────────────────────────────────────────────────
ALTER TABLE StoreProductMatchVote
    MODIFY COLUMN userId VARCHAR(64) NULL,
    DROP FOREIGN KEY fk_spmv_user;

ALTER TABLE StoreProductMatchVote
    ADD CONSTRAINT fk_spmv_user
        FOREIGN KEY (userId) REFERENCES User(id) ON DELETE SET NULL;

-- ── Receipt ──────────────────────────────────────────────────────────────────
ALTER TABLE Receipt
    MODIFY COLUMN userId CHAR(36) NULL,
    DROP FOREIGN KEY Receipt_ibfk_1;

ALTER TABLE Receipt
    ADD CONSTRAINT Receipt_ibfk_1
        FOREIGN KEY (userId) REFERENCES User(id) ON DELETE SET NULL;

-- ── AdminReviewFlag ──────────────────────────────────────────────────────────
ALTER TABLE AdminReviewFlag
    MODIFY COLUMN flaggedBy VARCHAR(64) NULL,
    DROP FOREIGN KEY fk_arf_user;

ALTER TABLE AdminReviewFlag
    ADD CONSTRAINT fk_arf_user
        FOREIGN KEY (flaggedBy) REFERENCES User(id) ON DELETE SET NULL;

-- ── Basket ───────────────────────────────────────────────────────────────────
ALTER TABLE Basket DROP FOREIGN KEY Basket_ibfk_1;

ALTER TABLE Basket
    ADD CONSTRAINT Basket_ibfk_1
        FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE;

-- ── ShoppingList ─────────────────────────────────────────────────────────────
ALTER TABLE ShoppingList DROP FOREIGN KEY ShoppingList_ibfk_1;

ALTER TABLE ShoppingList
    ADD CONSTRAINT ShoppingList_ibfk_1
        FOREIGN KEY (userId) REFERENCES User(id) ON DELETE CASCADE;
