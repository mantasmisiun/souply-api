-- Template item anchor + intent snapshot.
--
-- Problem: a template stores only a global Product id. A creator builds it
-- from their view of a product, but the canonical Product is a loose cluster
-- of StoreProducts across chains — so when someone else opens the QR, the
-- cheapest-store resolution can land on a different variant, or the live
-- Product can drift over time (admin re-merge/split, store rename).
--
-- Fix: capture, at save time, the concrete thing the creator meant.
--   anchorSpId   — the Product's representative StoreProduct (the SKU its
--                  name/image came from). The cluster is still followed live
--                  via productId, but this anchors the intended variant so
--                  resolution can prefer the nearest-attribute match.
--   snap*        — a frozen snapshot of what the creator saw (name / amount /
--                  unit / image). A shared template can always show the right
--                  thing even if the live Product drifts, and drift is
--                  detectable: live Product.name <> snapName.
--
-- All nullable + backfilled lazily; existing rows keep working (resolution
-- falls back to the live Product exactly as before when these are null).

ALTER TABLE BasketTemplateItem
  ADD COLUMN IF NOT EXISTS anchorSpId   INT           NULL,
  ADD COLUMN IF NOT EXISTS snapName     VARCHAR(255)  NULL,
  ADD COLUMN IF NOT EXISTS snapAmount   DECIMAL(10,3) NULL,
  ADD COLUMN IF NOT EXISTS snapUnit     VARCHAR(8)    NULL,
  ADD COLUMN IF NOT EXISTS snapImageUrl VARCHAR(512)  NULL;

-- The anchor follows the item into the basket it spawns, so the scanner's own
-- cross-store recalculation prefers the creator's intended pack size too (not
-- just the share-preview). Carried as amount+unit — that's all the calc's
-- nearest-attribute step needs. NULL on manual (non-template) basket items, so
-- those resolve exactly as before.
ALTER TABLE BasketItem
  ADD COLUMN IF NOT EXISTS anchorAmount DECIMAL(10,3) NULL,
  ADD COLUMN IF NOT EXISTS anchorUnit   VARCHAR(8)    NULL;
