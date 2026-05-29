-- Migration: User OAuth + creator identity — Pass B.4 of šablonai.
--
-- Source spec: Documentation/roadmap/sablonai.md Part 1.4 + Part 6.
--
-- Adds the columns required for OAuth-backed verified accounts:
--   * authProvider/authSubject — the (provider, subject) pair uniquely
--     identifies a verified user across sessions
--   * email/emailVerified     — from the OAuth ID token
--   * username                — globally unique handle (3-20 chars, lowercase)
--   * usernameSetAt           — drives the 30-day rate limit on changes
--   * displayName/bio/avatarUrl — profile polish (B.5 surface)
--
-- All idempotent via the same INFORMATION_SCHEMA + prepared statement
-- pattern as the earlier migrations.

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'username');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN username VARCHAR(50) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND INDEX_NAME = 'uq_user_username');
SET @sql := IF(@idx_exists = 0,
    'ALTER TABLE User ADD UNIQUE INDEX uq_user_username (username)',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'usernameSetAt');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN usernameSetAt DATETIME NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'displayName');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN displayName VARCHAR(60) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'bio');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN bio VARCHAR(160) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'avatarUrl');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN avatarUrl VARCHAR(500) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'authProvider');
SET @sql := IF(@col_exists = 0,
    "ALTER TABLE User ADD COLUMN authProvider ENUM('google','apple') NULL",
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'authSubject');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN authSubject VARCHAR(255) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND INDEX_NAME = 'uq_user_provider_subject');
SET @sql := IF(@idx_exists = 0,
    'ALTER TABLE User ADD UNIQUE INDEX uq_user_provider_subject (authProvider, authSubject)',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'email');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN email VARCHAR(255) NULL',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @col_exists := (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'User' AND COLUMN_NAME = 'emailVerified');
SET @sql := IF(@col_exists = 0,
    'ALTER TABLE User ADD COLUMN emailVerified TINYINT(1) NOT NULL DEFAULT 0',
    'DO 0');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
