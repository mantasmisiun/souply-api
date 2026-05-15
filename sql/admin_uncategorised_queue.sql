-- Migration: Admin panel — Uncategorised (Nepriskirti) tab.
--
-- Tab 4 surfaces Products that need rescue: missing categoryId, name
-- cleanup, or outright deletion. Same lease + audit chassis as the
-- earlier tabs. AdminCardLease.spId carries `Product.id` for this
-- queueKind (it's a single bigint, productId fits the same column).

ALTER TABLE AdminCardLease
    MODIFY COLUMN queueKind ENUM('image', 'amount', 'flag', 'uncategorised') NOT NULL;
