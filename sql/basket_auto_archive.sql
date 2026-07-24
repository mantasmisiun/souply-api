-- Basket auto-archive (2026-07-24) — mirrors the Trip auto-archive pattern.
--
-- A personal draft/compared basket that is NOT converted into a shopping list
-- within 48 h of its last edit is an abandoned cart: it should leave the
-- resumable pool (chooser + silent-resume) instead of being silently
-- resurrected days later. `archivedAt` is the soft-archive marker (NULL = live),
-- swept hourly by sweepBasketAutoArchive() and filtered out of the user's basket
-- list. Family/shared baskets (householdId set) and converted baskets (a
-- ShoppingList exists / tripId set) are never archived.
ALTER TABLE Basket
  ADD COLUMN archivedAt DATETIME DEFAULT NULL AFTER householdId;

-- The archive sweep and every resumable-basket lookup scope by (userId, status,
-- archivedAt); extend the existing user/status index to keep them index-only.
ALTER TABLE Basket
  ADD KEY idx_basket_user_archived (userId, archivedAt, status);
