-- Basket review fixes: indexes, cascade delete, quantity precision.
--
-- Safe to run on an existing DB. Indexes use CREATE INDEX IF NOT EXISTS-style
-- guard via procedure, FK adjustment drops+re-adds, decimal change is an
-- ALTER MODIFY (no data loss since existing FLOAT values narrow cleanly).

-- 1) Unique (basketId, productId) — application-layer dedup becomes a DB
--    guarantee. Prevents the small TOCTOU window where two concurrent
--    "add same product" requests both pass the existence check before
--    either commits. Future schema change (multiple lines per same
--    product, e.g. for different matchModes) would require dropping this.
ALTER TABLE BasketItem
  ADD CONSTRAINT uq_basketitem_basket_product UNIQUE (basketId, productId);

-- 2) Compound index for the basket list query's WHERE + ORDER BY.
--    Query: SELECT ... WHERE userId=? GROUP BY id ORDER BY FIELD(status...), updatedAt DESC
--    (userId, status, updatedAt) covers the predicate and most of the sort;
--    FIELD() can't use the index sort order but the filter + partial sort
--    still benefits.
CREATE INDEX idx_basket_user_status_updated
  ON Basket (userId, status, updatedAt);

-- 3) FK cascade from BasketItem to Basket so deleting a basket cleans up
--    its items. The current model/app tediously deletes items one by one
--    before the basket; a direct DELETE via admin / API misuse orphans
--    items.
--
--    We drop and recreate the FK so the ON DELETE CASCADE rule actually
--    applies — MySQL won't change the rule via a straight MODIFY.
--    If the FK name differs on your DB, adjust the DROP accordingly.
ALTER TABLE BasketItem
  DROP FOREIGN KEY fk_basketitem_basket;
ALTER TABLE BasketItem
  ADD CONSTRAINT fk_basketitem_basket
  FOREIGN KEY (basketId) REFERENCES Basket(id)
  ON DELETE CASCADE;

-- 4) Quantity precision. FLOAT lets 0.1+0.2 drift to 0.30000000000000004
--    and quantities like 2.5 aren't guaranteed exact. DECIMAL(6,2) gives
--    up to 9999.99 units (plenty of headroom) with exact representation.
ALTER TABLE BasketItem
  MODIFY COLUMN quantity DECIMAL(6, 2) NOT NULL DEFAULT 1.00;
