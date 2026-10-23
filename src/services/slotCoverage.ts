/**
 * PRODUCT-LEVEL FULFILMENT for a planned store slot.
 *
 * A slot used to close only when a receipt FROM THAT STORE landed on the trip.
 * That asks the wrong question: you go shopping for products, and the store is
 * the means. Plan IKI + Norfa, buy the IKI list at Maxima, and the IKI slot
 * stayed open forever while a Maxima receipt sat on the trip — so the trip could
 * never reach stage 5 even though every planned item was bought.
 *
 * So a slot is also fulfilled when EVERY item on its list was bought somewhere on
 * this trip. The store slot remains the PLAN (where to go, what to pick up); the
 * products are what "done" means.
 *
 * Matching is deliberately EXACT (productId), not the fuzzy same-kind pairing the
 * planning score uses: closing a slot is a state change the user sees, so a
 * name-similarity guess is too weak a reason. A slot that fuzzy-matches but
 * doesn't exact-match simply stays open — the receipt is still on the trip, the
 * score still counts it, and "Nepirkau čia" remains the manual out.
 *
 * An EMPTY list never auto-closes: nothing was planned, so nothing was fulfilled.
 */
export const SLOT_ITEMS_COVERED_SQL = `
    (SELECT COUNT(*) FROM ShoppingListItem sli WHERE sli.listId = sl.id) > 0
    AND NOT EXISTS (
        SELECT 1
          FROM ShoppingListItem sli
         WHERE sli.listId = sl.id
           AND NOT EXISTS (
                SELECT 1
                  FROM ReceiptItem ri
                  JOIN Receipt r ON r.id = ri.receiptId
                                AND r.tripId = sl.tripId
                                AND r.userDeletedAt IS NULL
                  JOIN StoreProduct sp ON sp.id = ri.matchedSpId
                 WHERE sp.productId = COALESCE(
                        sli.productId,
                        (SELECT sp2.productId FROM StoreProduct sp2 WHERE sp2.id = sli.storeProductId))
           )
    )`;
