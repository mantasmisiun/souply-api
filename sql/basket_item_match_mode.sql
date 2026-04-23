-- BasketItem.matchMode: resolution strategy for the item when the basket is
-- priced across stores.
--   'sku'  = resolve to the specific Product stored in productId (current
--            behavior; the user picked this exact SKU)
--   'base' = resolve to the cheapest Product in the same BaseProduct cluster
--            at each store (the user said "any variant of this will do")
--
-- Default 'sku' preserves old row semantics: rows that existed before this
-- column was added continue to behave exactly as they always did.

ALTER TABLE BasketItem
  ADD COLUMN matchMode ENUM('sku','base') NOT NULL DEFAULT 'sku';
