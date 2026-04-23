-- Shopping list ↔ basket: one-list-per-basket invariant.
--
-- Previously ShoppingList.basketId had no uniqueness, so a user could
-- spawn multiple lists from the same compared basket. When one of those
-- sibling lists was deleted, the basket reverted to `compared`, silently
-- stranding the remaining lists in a stale lifecycle.
--
-- Before applying the UNIQUE constraint, dedupe any existing violations:
-- keep the most recently created list per basketId, delete the rest.
--
-- The UNIQUE index permits multiple NULL basketId rows (MySQL's standard
-- behaviour), which is what we want for standalone lists that aren't tied
-- to any basket.

-- 1) Dedup — keep the newest list per basketId, drop older duplicates.
--    "Newest" = highest id (creation order is monotonic).
DELETE sl FROM ShoppingList sl
JOIN (
    SELECT basketId, MAX(id) AS keep_id
      FROM ShoppingList
     WHERE basketId IS NOT NULL
     GROUP BY basketId
    HAVING COUNT(*) > 1
) dup ON sl.basketId = dup.basketId AND sl.id <> dup.keep_id;

-- 2) Apply the constraint.
ALTER TABLE ShoppingList
  ADD CONSTRAINT uq_sl_basket UNIQUE (basketId);
