-- Collation unification (2026-07-25) — kill "Illegal mix of collations".
--
-- The schema drifted across two MariaDB defaults. Tables created earlier are
-- utf8mb4_unicode_ci (User, Basket, Receipt, ShoppingList, …); tables created
-- later inherited MariaDB 11's new default utf8mb4_uca1400_ai_ci (Trip,
-- TripMember, Household, Notification, …). Any JOIN across that boundary throws
-- at RUNTIME, e.g. listTripMembers joining TripMember.userId = User.id:
--
--   Error: Illegal mix of collations (utf8mb4_unicode_ci,IMPLICIT)
--          and (utf8mb4_uca1400_ai_ci,IMPLICIT) for operation '='
--
-- Fixing it per query (explicit COLLATE) is whack-a-mole: every existing AND
-- future cross-generation join needs the same treatment and fails only when a
-- user hits it. (StoreProductTranslation already carries such a workaround —
-- the CONVERT(... USING utf8mb4) inside itemPreviewSql exists purely because
-- GROUP_CONCAT hit this same drift.) Normalising the schema fixes all of them
-- at once, so every drifted table moves to the majority collation.
--
-- SAFE: verified there are NO foreign keys defined on — or referencing — any of
-- these 13 tables, so there are no FK collation conflicts. CONVERT TO CHARACTER
-- SET rebuilds each table's string columns + indexes; quick on dev, but
-- Notification / StoreProductTranslation / ReceiptComparisonSnapshot are the
-- big ones, so run this in a maintenance window on prod. Idempotent in effect:
-- re-running on an already-converted table is a no-op rewrite, not an error.
--
-- Env status: dev = APPLIED 2026-07-25 (verified: 0 tables/columns left on
-- uca1400, listTripMembers join green), staging = PENDING, prod = PENDING.

ALTER TABLE ClientVersionPolicy      CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE ClientVersionSighting    CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE Household                CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE HouseholdMember          CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE InviteClaim              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE InviteToken              CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE Notification             CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE PushToken                CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE ReceiptComparisonSnapshot CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE StoreProductTranslation  CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE Trip                     CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE TripLineLink             CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE TripMember               CONVERT TO CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- Verify: this must return ZERO rows afterwards.
--   SELECT TABLE_NAME, COLUMN_NAME, COLLATION_NAME
--     FROM information_schema.COLUMNS
--    WHERE TABLE_SCHEMA = DATABASE() AND COLLATION_NAME = 'utf8mb4_uca1400_ai_ci';
