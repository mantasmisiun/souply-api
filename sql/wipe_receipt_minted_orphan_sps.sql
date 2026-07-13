-- ============================================================================
-- Wipe RECEIPT-MINTED ORPHAN StoreProducts and all their associated data. DEV ONLY.
--
-- WHY: re-scanning a garbled receipt mints StoreProducts from garbled OCR names
-- ("RAUDONOSIOS PAPR1KOS", "ATLAINES LASIŠOS BE GAL"). They DO get fallback Price
-- rows (so the price-less wipe misses them), but they carry NO SCRAPED price, and
-- their garbled names then out-rank the clean catalog on the next scan. The
-- catalog-first matcher tiebreak + the widened weighable self-heal stop NEW ones;
-- this clears the ones already minted.
--
-- TARGET = a StoreProduct with NO scraped price (no Price row with receiptId IS NULL).
-- A real scraped SKU always has at least one receiptId-NULL price; a receipt-minted
-- orphan has only receipt-derived prices. Indexed by idx_price_receipt_sp.
--
-- FK notes (base schema): Price.storeProductId and ShoppingListItem.storeProductId
-- are RESTRICT → delete them first. ReceiptSwipeCandidate, OrphanSwipeCandidate,
-- StoreProductMerge(+Vote), UserStoreProductEquivalence, ImagePropagationLog,
-- ProductInteraction are ON DELETE CASCADE; AdminReviewFlag.spId is SET NULL.
-- ============================================================================

-- ---- PREVIEW ---------------------------------------------------------------
SELECT sp.id, sp.chainId, sp.storeProductName,
       (SELECT COUNT(*) FROM Price p WHERE p.storeProductId = sp.id) AS priceRows
FROM StoreProduct sp
WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.receiptId IS NULL)
ORDER BY sp.chainId, sp.id;

-- ---- DELETE (one transaction; predicate is invariant under the deletes — the
--      targets have no scraped price, and removing their receipt-derived prices
--      can never add one) -----------------------------------------------------
START TRANSACTION;

DELETE sli FROM ShoppingListItem sli
WHERE sli.storeProductId IN (
  SELECT spId FROM (
    SELECT sp.id AS spId FROM StoreProduct sp
    WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.receiptId IS NULL)
  ) AS d
);

DELETE pr FROM Price pr
WHERE pr.storeProductId IN (
  SELECT spId FROM (
    SELECT sp.id AS spId FROM StoreProduct sp
    WHERE NOT EXISTS (SELECT 1 FROM Price p2 WHERE p2.storeProductId = sp.id AND p2.receiptId IS NULL)
  ) AS d
);

DELETE sp FROM StoreProduct sp
WHERE NOT EXISTS (SELECT 1 FROM Price p WHERE p.storeProductId = sp.id AND p.receiptId IS NULL);

DELETE p FROM Product p
WHERE NOT EXISTS (SELECT 1 FROM StoreProduct     sp  WHERE sp.productId    = p.id)
  AND NOT EXISTS (SELECT 1 FROM Product          c   WHERE c.baseProductId = p.id)
  AND NOT EXISTS (SELECT 1 FROM Product          m   WHERE m.mergedIntoId  = p.id)
  AND NOT EXISTS (SELECT 1 FROM BasketItem       bi  WHERE bi.productId    = p.id)
  AND NOT EXISTS (SELECT 1 FROM ShoppingListItem sli WHERE sli.productId   = p.id);

COMMIT;
