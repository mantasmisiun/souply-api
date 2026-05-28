-- Split shopping lists: change uniqueness from per-basket to per-(basket, store).
--
-- The old UNIQUE(basketId) constraint (uq_sl_basket) allowed only one list
-- per basket total. Split combo lists need one list per store per basket.
--
-- Existing data is safe: each basket already has at most one list, so the
-- new composite constraint is automatically satisfied.

-- Add composite index first — (basketId, storeId) prefix covers the FK on basketId,
-- so MariaDB accepts dropping the old single-column index afterwards.
ALTER TABLE ShoppingList
  ADD CONSTRAINT uq_sl_basket_store UNIQUE (basketId, storeId);

ALTER TABLE ShoppingList
  DROP INDEX uq_sl_basket;
