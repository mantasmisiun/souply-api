-- ============================================================================
-- Wipe €0 / price-less StoreProducts and all their associated data.  DEV ONLY.
--
-- WHY: a garbled receipt parse could mint a StoreProduct from an unpriceable
-- line (price <= 0) — e.g. the pre-FUR-fix salmon whose NAME became the weight
-- calc "ATI 1INES ASISOS 8E GAL 1,068 kg v 16 99 FUR/ kg". Those SPs got NO
-- Price row (the writer skips price <= 0), so they slip past the receipt-delete
-- orphan cleanup and pollute future matching. (Going forward the resolver no
-- longer creates an SP for a price-less line; this clears the ones already made.)
--
-- TARGET = StoreProducts that have NEVER had a positive price. Scraped catalog
-- SPs always carry a positive scraped price, so this only hits receipt-spawned
-- junk. STILL: run the PREVIEW first and eyeball the names before deleting.
--
-- FK notes (base schema): Price.storeProductId and ShoppingListItem.storeProductId
-- are RESTRICT → delete them first. ReceiptSwipeCandidate, OrphanSwipeCandidate,
-- StoreProductMerge(+Vote), UserStoreProductEquivalence, ImagePropagationLog,
-- ProductInteraction are ON DELETE CASCADE; AdminReviewFlag.spId is SET NULL —
-- all clear automatically when the StoreProduct row is deleted.
-- ============================================================================

-- ---- PREVIEW: exactly what would be deleted (review before running DELETE) ---
SELECT sp.id,
       sp.chainId,
       sp.storeProductName,
       (SELECT COUNT(*) FROM Price p WHERE p.storeProductId = sp.id)                          AS priceRows,
       (SELECT COUNT(*) FROM ShoppingListItem s WHERE s.storeProductId = sp.id)               AS inLists
FROM StoreProduct sp
WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.price > 0)
ORDER BY sp.chainId, sp.id;


-- ---- DELETE: run as one transaction, check the counts, then COMMIT ----------
-- NO temp table — some SQL clients run each statement on a different pooled
-- connection, where a TEMPORARY table (per-connection) vanishes between
-- statements. Instead each step re-derives the target set inline. That is SAFE
-- because the criteria is INVARIANT under these deletes: the targets have no
-- positive price, and removing their (non-positive) Price rows can never add one,
-- so "has no Price with price > 0" still selects exactly the same SPs at step 2.

START TRANSACTION;

-- 1. RESTRICT children of StoreProduct first (Price + ShoppingListItem.storeProductId
--    have no ON DELETE rule and would otherwise block the SP delete). The derived
--    table `d` materialises the target SP ids so Price isn't both deleted-from and
--    selected-from in one statement.
DELETE sli FROM ShoppingListItem sli
WHERE sli.storeProductId IN (
  SELECT spId FROM (
    SELECT sp.id AS spId FROM StoreProduct sp
    WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.price > 0)
  ) AS d
);

DELETE pr FROM Price pr
WHERE pr.storeProductId IN (
  SELECT spId FROM (
    SELECT sp.id AS spId FROM StoreProduct sp
    WHERE NOT EXISTS (SELECT 1 FROM Price p2 WHERE p2.storeProductId = sp.id AND p2.price > 0)
  ) AS d
);

-- 2. The StoreProducts (now genuinely price-less). CASCADE clears the swipe /
--    merge / equivalence / image-prop / interaction children; SET NULL clears
--    AdminReviewFlag.
DELETE sp FROM StoreProduct sp
WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.price > 0);

-- 3. Orphan Products: any Product now left with zero StoreProducts AND no other
--    RESTRICT reference. The remaining no-ON-DELETE FKs into Product(id) are
--    Product.baseProductId, Product.mergedIntoId, BasketItem.productId,
--    ShoppingListItem.productId. A Product still in a basket / list / merge-chain
--    is KEPT (deleting it would corrupt that row); it's harmless as an orphan —
--    no StoreProduct, so it never surfaces in matching. (OrphanSwipeCandidate /
--    BaseProductLink FKs are CASCADE and clear when the Product does go.)
DELETE p FROM Product p
WHERE NOT EXISTS (SELECT 1 FROM StoreProduct     sp  WHERE sp.productId    = p.id)
  AND NOT EXISTS (SELECT 1 FROM Product          c   WHERE c.baseProductId = p.id)
  AND NOT EXISTS (SELECT 1 FROM Product          m   WHERE m.mergedIntoId  = p.id)
  AND NOT EXISTS (SELECT 1 FROM BasketItem       bi  WHERE bi.productId    = p.id)
  AND NOT EXISTS (SELECT 1 FROM ShoppingListItem sli WHERE sli.productId   = p.id);

-- Inspect the affected-row counts above, then:
COMMIT;     -- or ROLLBACK; if anything looks wrong
