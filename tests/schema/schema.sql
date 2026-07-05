/*M!999999\- enable the sandbox mode */ 

/*!40101 SET @OLD_CHARACTER_SET_CLIENT=@@CHARACTER_SET_CLIENT */;
/*!40101 SET @OLD_CHARACTER_SET_RESULTS=@@CHARACTER_SET_RESULTS */;
/*!40101 SET @OLD_COLLATION_CONNECTION=@@COLLATION_CONNECTION */;
/*!40101 SET NAMES utf8mb4 */;
/*!40103 SET @OLD_TIME_ZONE=@@TIME_ZONE */;
/*!40103 SET TIME_ZONE='+00:00' */;
/*!40014 SET @OLD_UNIQUE_CHECKS=@@UNIQUE_CHECKS, UNIQUE_CHECKS=0 */;
/*!40014 SET @OLD_FOREIGN_KEY_CHECKS=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
/*!40101 SET @OLD_SQL_MODE=@@SQL_MODE, SQL_MODE='NO_AUTO_VALUE_ON_ZERO' */;
/*M!100616 SET @OLD_NOTE_VERBOSITY=@@NOTE_VERBOSITY, NOTE_VERBOSITY=0 */;
DROP TABLE IF EXISTS `AccountRecoveryAttempt`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `AccountRecoveryAttempt` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `deviceFingerprint` varchar(128) NOT NULL,
  `matchedUserId` char(36) DEFAULT NULL,
  `succeeded` tinyint(1) NOT NULL DEFAULT 0,
  `failureReason` varchar(64) DEFAULT NULL,
  `attemptedAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_device` (`deviceFingerprint`,`attemptedAt`),
  KEY `idx_user` (`matchedUserId`,`attemptedAt`)
) ENGINE=InnoDB AUTO_INCREMENT=26 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `AdminAuditLog`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `AdminAuditLog` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `adminUserId` varchar(64) NOT NULL,
  `action` varchar(64) NOT NULL,
  `targetType` varchar(32) NOT NULL,
  `targetId` bigint(20) NOT NULL,
  `valueBefore` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`valueBefore`)),
  `valueAfter` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`valueAfter`)),
  `reversedAt` datetime DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_admin` (`adminUserId`,`createdAt`),
  KEY `idx_target` (`targetType`,`targetId`,`createdAt`)
) ENGINE=InnoDB AUTO_INCREMENT=1358 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `AdminCardLease`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `AdminCardLease` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `spId` int(11) NOT NULL,
  `leasedTo` varchar(64) NOT NULL,
  `queueKind` enum('image','amount','flag','uncategorised') NOT NULL,
  `leasedAt` datetime NOT NULL DEFAULT current_timestamp(),
  `expiresAt` datetime NOT NULL,
  `completedAt` datetime DEFAULT NULL,
  `abandonedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_active` (`queueKind`,`completedAt`,`abandonedAt`,`expiresAt`),
  KEY `idx_admin` (`leasedTo`,`queueKind`,`completedAt`,`abandonedAt`),
  KEY `idx_sp` (`spId`,`queueKind`)
) ENGINE=InnoDB AUTO_INCREMENT=1878 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `AdminInvite`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `AdminInvite` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `tokenHash` char(64) NOT NULL,
  `email` varchar(255) NOT NULL,
  `firstName` varchar(100) NOT NULL,
  `lastName` varchar(100) NOT NULL,
  `role` enum('admin','superadmin') DEFAULT 'admin',
  `notes` text DEFAULT NULL,
  `status` enum('pending_scan','pending_email','claimed','expired','revoked') DEFAULT 'pending_scan',
  `expiresAt` datetime NOT NULL,
  `emailToken` char(64) DEFAULT NULL,
  `emailExpiry` datetime DEFAULT NULL,
  `claimedUserId` varchar(36) DEFAULT NULL,
  `claimedAt` datetime DEFAULT NULL,
  `createdAt` datetime DEFAULT current_timestamp(),
  `createdBy` varchar(255) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `tokenHash` (`tokenHash`),
  KEY `idx_tokenHash` (`tokenHash`),
  KEY `idx_email` (`email`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `AdminInviteLog`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `AdminInviteLog` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `userId` varchar(36) DEFAULT NULL,
  `inviteId` int(11) DEFAULT NULL,
  `action` varchar(64) NOT NULL,
  `detail` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`detail`)),
  `createdAt` datetime DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_userId` (`userId`),
  KEY `idx_action` (`action`)
) ENGINE=InnoDB AUTO_INCREMENT=8 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `AdminReviewFlag`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `AdminReviewFlag` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `type` enum('self-pair-rejected') NOT NULL,
  `receiptId` int(11) DEFAULT NULL,
  `lineIdx` int(11) DEFAULT NULL,
  `spId` int(11) DEFAULT NULL,
  `flaggedBy` varchar(64) DEFAULT NULL,
  `status` enum('pending','resolved','dismissed') NOT NULL DEFAULT 'pending',
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_arf_status` (`status`),
  KEY `idx_arf_reporter` (`flaggedBy`),
  KEY `fk_arf_receipt` (`receiptId`),
  KEY `fk_arf_sp` (`spId`),
  CONSTRAINT `fk_arf_receipt` FOREIGN KEY (`receiptId`) REFERENCES `Receipt` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arf_sp` FOREIGN KEY (`spId`) REFERENCES `StoreProduct` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_arf_user` FOREIGN KEY (`flaggedBy`) REFERENCES `User` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=7 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `BaseProductLink`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `BaseProductLink` (
  `bpIdA` int(11) NOT NULL,
  `bpIdB` int(11) NOT NULL,
  `similarVoteCount` int(11) NOT NULL DEFAULT 0,
  `lastVoteAt` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`bpIdA`,`bpIdB`),
  KEY `idx_bpl_b` (`bpIdB`),
  CONSTRAINT `fk_bpl_a` FOREIGN KEY (`bpIdA`) REFERENCES `Product` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bpl_b` FOREIGN KEY (`bpIdB`) REFERENCES `Product` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `Basket`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `Basket` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `userId` char(36) NOT NULL,
  `createdAt` datetime DEFAULT current_timestamp(),
  `updatedAt` datetime DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `status` enum('draft','compared','inProgress','completed') NOT NULL DEFAULT 'draft',
  `savedAmount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `name` varchar(255) DEFAULT NULL,
  `sourceTemplateId` int(11) DEFAULT NULL,
  `hasBeenCalculated` tinyint(1) NOT NULL DEFAULT 0,
  `userEditedAfterCreation` tinyint(1) NOT NULL DEFAULT 0,
  `cheapestTotal` decimal(10,2) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_basket_user_status_updated` (`userId`,`status`,`updatedAt`),
  KEY `idx_b_source_template` (`sourceTemplateId`),
  CONSTRAINT `Basket_ibfk_1` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=54 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `BasketItem`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `BasketItem` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `basketId` int(11) NOT NULL,
  `productId` int(11) NOT NULL,
  `quantity` decimal(6,2) NOT NULL DEFAULT 1.00,
  `unitPrice` decimal(10,2) DEFAULT NULL,
  `matchMode` enum('sku','base') NOT NULL DEFAULT 'sku',
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_basketitem_basket_product` (`basketId`,`productId`),
  KEY `productId` (`productId`),
  CONSTRAINT `BasketItem_ibfk_2` FOREIGN KEY (`productId`) REFERENCES `Product` (`id`),
  CONSTRAINT `fk_basketitem_basket` FOREIGN KEY (`basketId`) REFERENCES `Basket` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=200 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `BasketTemplate`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `BasketTemplate` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `userId` varchar(36) NOT NULL,
  `name` varchar(100) NOT NULL,
  `isDefault` tinyint(1) NOT NULL DEFAULT 0,
  `autoUpdate` tinyint(1) NOT NULL DEFAULT 0,
  `visibility` enum('private','unlisted','public') NOT NULL DEFAULT 'private',
  `shareSlug` varchar(32) DEFAULT NULL,
  `creatorHandle` varchar(50) DEFAULT NULL,
  `sourceTemplateId` int(11) DEFAULT NULL,
  `useCount` int(11) NOT NULL DEFAULT 0,
  `collectiveSavingsEur` decimal(10,2) NOT NULL DEFAULT 0.00,
  `snapshotCheapestChainId` int(11) DEFAULT NULL,
  `snapshotTotalEur` decimal(10,2) DEFAULT NULL,
  `snapshotRunnerUpEur` decimal(10,2) DEFAULT NULL,
  `snapshotCalculatedAt` datetime DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  `updatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `editedAt` datetime DEFAULT NULL,
  `lastAutoUpdateDelta` int(11) DEFAULT NULL,
  `lastAutoUpdateAt` datetime DEFAULT NULL,
  `snapshotMostExpensiveEur` decimal(10,2) DEFAULT NULL,
  `coverColor` varchar(16) DEFAULT NULL,
  `coverImage` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`coverImage`)),
  `visitCount` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `shareSlug` (`shareSlug`),
  KEY `idx_bt_user` (`userId`),
  KEY `idx_bt_slug` (`shareSlug`),
  KEY `idx_bt_visibility` (`visibility`,`userId`)
) ENGINE=InnoDB AUTO_INCREMENT=3 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `BasketTemplateItem`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `BasketTemplateItem` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `templateId` int(11) NOT NULL,
  `productId` int(11) NOT NULL,
  `quantity` decimal(10,3) NOT NULL DEFAULT 1.000,
  `unit` varchar(8) DEFAULT NULL,
  `sortOrder` int(11) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `idx_bti_template_sort` (`templateId`,`sortOrder`),
  CONSTRAINT `fk_bti_template` FOREIGN KEY (`templateId`) REFERENCES `BasketTemplate` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=9 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `BetaSignup`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `BetaSignup` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `email` varchar(255) NOT NULL,
  `platform` varchar(16) NOT NULL DEFAULT 'ios',
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_beta_email` (`email`)
) ENGINE=InnoDB AUTO_INCREMENT=2 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `Category`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `Category` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `parentCategoryId` int(11) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `isHidden` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `parentCategoryId` (`parentCategoryId`),
  CONSTRAINT `Category_ibfk_1` FOREIGN KEY (`parentCategoryId`) REFERENCES `Category` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=97002 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `CategoryTranslation`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `CategoryTranslation` (
  `categoryId` int(11) NOT NULL,
  `locale` varchar(8) NOT NULL,
  `name` varchar(255) NOT NULL,
  PRIMARY KEY (`categoryId`,`locale`),
  KEY `idx_locale` (`locale`),
  CONSTRAINT `fk_category_translation_category` FOREIGN KEY (`categoryId`) REFERENCES `Category` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `DiscountedProductSummary`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `DiscountedProductSummary` (
  `productId` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `categoryId` int(11) DEFAULT NULL,
  `l2CategoryId` int(11) DEFAULT NULL,
  `imageUrls` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`imageUrls`)),
  `chainLogos` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`chainLogos`)),
  `minAmount` int(11) DEFAULT NULL,
  `maxAmount` int(11) DEFAULT NULL,
  `unit` varchar(8) DEFAULT 'g',
  `hasWeighable` tinyint(1) DEFAULT 0,
  `bestDiscountPct` int(11) NOT NULL,
  `realDiscountPct` int(11) DEFAULT NULL,
  `cheapestChainId` int(11) DEFAULT NULL,
  `canonicalUnit` varchar(8) DEFAULT NULL,
  `canonicalStep` double DEFAULT NULL,
  `canonicalFamily` varchar(16) DEFAULT NULL,
  `updatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`productId`),
  KEY `idx_dps_discount` (`bestDiscountPct`),
  KEY `idx_dps_l2` (`l2CategoryId`,`bestDiscountPct`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `FailedReceiptLog`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `FailedReceiptLog` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `userId` varchar(36) DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  `failReason` enum('ocr_no_text','ocr_error','chain_unrecognized','store_unrecognized') NOT NULL,
  `ocrLineCount` int(11) DEFAULT NULL,
  `ocrPreview` text DEFAULT NULL,
  `detectedChainName` varchar(64) DEFAULT NULL,
  `extractedStoreAddress` varchar(255) DEFAULT NULL,
  `imageFilePath` varchar(512) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_created` (`createdAt`),
  KEY `idx_user_created` (`userId`,`createdAt`),
  KEY `idx_reason` (`failReason`)
) ENGINE=InnoDB AUTO_INCREMENT=17 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ImagePropagationLog`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ImagePropagationLog` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `spId` int(11) NOT NULL,
  `sourceType` enum('cross_chain_sibling','admin_adopt_candidate','admin_upload','user_upload_approved') NOT NULL,
  `sourceSpId` int(11) DEFAULT NULL,
  `fromImageUrl` varchar(500) DEFAULT NULL,
  `toImageUrl` varchar(500) NOT NULL,
  `actor` varchar(64) NOT NULL,
  `reversedAt` datetime DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_sp` (`spId`,`createdAt`),
  KEY `idx_actor` (`actor`,`createdAt`),
  CONSTRAINT `fk_ipl_sp` FOREIGN KEY (`spId`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=1767 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `OrphanSwipeCandidate`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `OrphanSwipeCandidate` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `orphanProductId` int(11) NOT NULL,
  `candidateProductId` int(11) NOT NULL,
  `orphanSpId` int(11) NOT NULL,
  `candidateSpId` int(11) NOT NULL,
  `similarityScore` decimal(4,3) NOT NULL,
  `rankPos` tinyint(3) unsigned NOT NULL,
  `tier` tinyint(3) unsigned NOT NULL DEFAULT 1,
  `resolved` tinyint(1) NOT NULL DEFAULT 0,
  `resolvedOutcome` enum('promoted','demoted') DEFAULT NULL,
  `resolvedAt` datetime DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_orphan_candidate` (`orphanProductId`,`candidateProductId`),
  KEY `idx_feed` (`resolved`,`tier`,`rankPos`,`similarityScore`),
  KEY `idx_orphan` (`orphanProductId`,`resolved`,`rankPos`),
  KEY `idx_candidate_product` (`candidateProductId`),
  KEY `fk_osc_orphan_sp` (`orphanSpId`),
  KEY `fk_osc_cand_sp` (`candidateSpId`),
  CONSTRAINT `fk_osc_cand_product` FOREIGN KEY (`candidateProductId`) REFERENCES `Product` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_osc_cand_sp` FOREIGN KEY (`candidateSpId`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_osc_orphan_product` FOREIGN KEY (`orphanProductId`) REFERENCES `Product` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_osc_orphan_sp` FOREIGN KEY (`orphanSpId`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=44031 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `PendingImageUpload`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `PendingImageUpload` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `spId` int(11) NOT NULL,
  `uploadedBy` varchar(64) NOT NULL,
  `filePath` varchar(500) NOT NULL,
  `status` enum('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `resolvedBy` varchar(64) DEFAULT NULL,
  `resolvedAt` datetime DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_sp_status` (`spId`,`status`),
  KEY `idx_status_created` (`status`,`createdAt`),
  CONSTRAINT `fk_piu_sp` FOREIGN KEY (`spId`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=4 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `Price`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `Price` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `storeProductId` int(11) NOT NULL,
  `storeId` int(11) NOT NULL,
  `price` decimal(10,2) NOT NULL,
  `promoPrice` decimal(10,2) DEFAULT NULL,
  `promoEnd` datetime DEFAULT NULL,
  `date` datetime DEFAULT current_timestamp(),
  `isFallback` tinyint(1) DEFAULT 0,
  `priceVerified` tinyint(1) DEFAULT 0,
  `receiptId` int(11) DEFAULT NULL,
  `receiptItemId` int(11) DEFAULT NULL,
  `requiresCoupon` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_price` (`storeProductId`,`storeId`,`date`),
  KEY `idx_price_receiptitem` (`receiptItemId`),
  KEY `idx_price_receipt_sp` (`receiptId`,`storeProductId`,`isFallback`),
  KEY `idx_price_receipt_verified` (`receiptId`,`isFallback`,`priceVerified`,`storeProductId`),
  KEY `idx_price_store_verified` (`storeId`,`priceVerified`,`storeProductId`),
  KEY `idx_price_promo_end` (`promoEnd`,`storeProductId`),
  CONSTRAINT `Price_ibfk_1` FOREIGN KEY (`storeProductId`) REFERENCES `StoreProduct` (`id`),
  CONSTRAINT `Price_ibfk_3` FOREIGN KEY (`storeId`) REFERENCES `Store` (`id`),
  CONSTRAINT `Price_ibfk_4` FOREIGN KEY (`receiptId`) REFERENCES `Receipt` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=16786710 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `Product`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `Product` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `categoryId` int(11) NOT NULL,
  `baseProductId` int(11) DEFAULT NULL,
  `mergedIntoId` int(11) DEFAULT NULL,
  `name` varchar(255) NOT NULL,
  `globalScore` decimal(10,4) NOT NULL DEFAULT 0.0000,
  PRIMARY KEY (`id`),
  KEY `baseProductId` (`baseProductId`),
  KEY `idx_product_mergedIntoId` (`mergedIntoId`),
  KEY `idx_category_score` (`categoryId`,`globalScore` DESC),
  KEY `idx_global_score` (`globalScore` DESC),
  FULLTEXT KEY `idx_product_name_ft` (`name`),
  CONSTRAINT `Product_ibfk_1` FOREIGN KEY (`categoryId`) REFERENCES `Category` (`id`),
  CONSTRAINT `Product_ibfk_2` FOREIGN KEY (`baseProductId`) REFERENCES `Product` (`id`),
  CONSTRAINT `fk_product_merged_into` FOREIGN KEY (`mergedIntoId`) REFERENCES `Product` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=97054 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ProductInteraction`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ProductInteraction` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `userId` varchar(36) NOT NULL,
  `productId` int(11) NOT NULL,
  `type` enum('basket_add','list_add','list_check') NOT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  KEY `idx_pi_user_product` (`userId`,`productId`),
  KEY `idx_pi_product` (`productId`)
) ENGINE=InnoDB AUTO_INCREMENT=134 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `Receipt`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `Receipt` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `userId` char(36) DEFAULT NULL,
  `storeId` int(11) DEFAULT NULL,
  `filePath` varchar(500) NOT NULL,
  `fileType` varchar(50) DEFAULT 'pending',
  `receiptDate` datetime DEFAULT current_timestamp(),
  `processingStatus` varchar(50) DEFAULT 'pending',
  `receiptNos` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`receiptNos`)),
  `receiptNoCanonical` varchar(50) GENERATED ALWAYS AS (json_unquote(json_extract(`receiptNos`,'$[0]'))) VIRTUAL,
  `parsedData` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`parsedData`)),
  `mandatorySwipesRequired` tinyint(4) NOT NULL DEFAULT 0,
  `mandatorySwipesCompleted` tinyint(4) NOT NULL DEFAULT 0,
  `hasBurstSwipes` tinyint(1) NOT NULL DEFAULT 0,
  `savedAmount` decimal(10,2) NOT NULL DEFAULT 0.00,
  `adminEditedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `unique_receipt` (`receiptNoCanonical`,`storeId`,`receiptDate`),
  KEY `storeId` (`storeId`),
  KEY `idx_receipt_user_status` (`userId`,`processingStatus`),
  KEY `userId` (`userId`),
  CONSTRAINT `Receipt_ibfk_1` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE SET NULL,
  CONSTRAINT `Receipt_ibfk_2` FOREIGN KEY (`storeId`) REFERENCES `Store` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=144 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ReceiptItem`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ReceiptItem` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `receiptId` int(11) NOT NULL,
  `lineIdx` int(11) NOT NULL,
  `name` varchar(512) NOT NULL DEFAULT '',
  `price` decimal(10,2) DEFAULT NULL,
  `promoPrice` decimal(10,2) DEFAULT NULL,
  `quantity` decimal(10,3) DEFAULT NULL,
  `unit` varchar(20) DEFAULT NULL,
  `amount` decimal(10,3) DEFAULT NULL,
  `sizeUnit` varchar(20) DEFAULT NULL,
  `isWeighable` tinyint(1) NOT NULL DEFAULT 0,
  `pricePerUnit` decimal(10,4) DEFAULT NULL,
  `brandName` varchar(255) DEFAULT NULL,
  `matchedSpId` int(11) DEFAULT NULL,
  `matchSource` varchar(24) DEFAULT NULL,
  `matchedName` varchar(512) DEFAULT NULL,
  `storeProductImageUrl` varchar(1024) DEFAULT NULL,
  `matchConfidence` decimal(4,3) DEFAULT NULL,
  `matchConfirmed` tinyint(1) NOT NULL DEFAULT 0,
  `priceVerified` tinyint(1) NOT NULL DEFAULT 0,
  `variantUncertain` tinyint(1) NOT NULL DEFAULT 0,
  `priceImplausible` tinyint(1) NOT NULL DEFAULT 0,
  `band` varchar(8) DEFAULT NULL,
  `needsHuman` decimal(8,2) DEFAULT NULL,
  `categoryId` int(11) DEFAULT NULL,
  `categoryName` varchar(255) DEFAULT NULL,
  `categoryL2Name` varchar(255) DEFAULT NULL,
  `itemConfidence` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`itemConfidence`)),
  `altMatches` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`altMatches`)),
  `region` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`region`)),
  `rawLines` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`rawLines`)),
  `extra` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL CHECK (json_valid(`extra`)),
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  `updatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_receipt_line` (`receiptId`,`lineIdx`),
  KEY `idx_ri_receipt` (`receiptId`,`lineIdx`),
  KEY `idx_ri_sp` (`matchedSpId`),
  CONSTRAINT `fk_ri_receipt` FOREIGN KEY (`receiptId`) REFERENCES `Receipt` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ri_sp` FOREIGN KEY (`matchedSpId`) REFERENCES `StoreProduct` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ReceiptLineIssue`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ReceiptLineIssue` (
  `receiptId` int(11) NOT NULL,
  `receiptLineIdx` int(11) NOT NULL,
  `userId` varchar(64) NOT NULL,
  `flags` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL CHECK (json_valid(`flags`)),
  `note` varchar(500) DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT current_timestamp(),
  `status` enum('pending','resolved','dismissed') NOT NULL DEFAULT 'pending',
  `resolvedBy` varchar(64) DEFAULT NULL,
  `resolvedAt` datetime DEFAULT NULL,
  PRIMARY KEY (`receiptId`,`receiptLineIdx`,`userId`),
  KEY `idx_rli_user` (`userId`),
  KEY `idx_status` (`status`,`createdAt`),
  CONSTRAINT `fk_rli_receipt` FOREIGN KEY (`receiptId`) REFERENCES `Receipt` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rli_user` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ReceiptSwipeCandidate`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ReceiptSwipeCandidate` (
  `receiptId` int(11) NOT NULL,
  `receiptLineIdx` int(11) NOT NULL,
  `rankPos` tinyint(4) NOT NULL,
  `storeProductId` int(11) NOT NULL,
  `matchScore` decimal(4,3) NOT NULL,
  `autoMatched` tinyint(1) NOT NULL DEFAULT 0,
  `createdAt` timestamp NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`receiptId`,`receiptLineIdx`,`rankPos`),
  KEY `idx_rsc_receipt` (`receiptId`),
  KEY `idx_rsc_storeproduct` (`storeProductId`),
  CONSTRAINT `fk_rsc_receipt` FOREIGN KEY (`receiptId`) REFERENCES `Receipt` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_rsc_storeproduct` FOREIGN KEY (`storeProductId`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ShoppingList`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ShoppingList` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `userId` char(36) NOT NULL,
  `storeId` int(11) NOT NULL,
  `createdAt` datetime DEFAULT current_timestamp(),
  `status` varchar(20) NOT NULL DEFAULT 'active',
  `basketId` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_sl_basket_store` (`basketId`,`storeId`),
  KEY `storeId` (`storeId`),
  KEY `ShoppingList_ibfk_1` (`userId`),
  CONSTRAINT `ShoppingList_ibfk_1` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE,
  CONSTRAINT `ShoppingList_ibfk_2` FOREIGN KEY (`storeId`) REFERENCES `Store` (`id`),
  CONSTRAINT `fk_basket` FOREIGN KEY (`basketId`) REFERENCES `Basket` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=34 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ShoppingListItem`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ShoppingListItem` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `listId` int(11) NOT NULL,
  `productId` int(11) DEFAULT NULL,
  `quantity` decimal(10,1) NOT NULL,
  `isChecked` tinyint(1) DEFAULT 0,
  `price` decimal(10,2) DEFAULT NULL,
  `customName` varchar(255) DEFAULT NULL,
  `storeProductId` int(11) DEFAULT NULL,
  `isWeighable` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  KEY `productId` (`productId`),
  KEY `ShoppingListItem_listId_fk` (`listId`),
  KEY `storeProductId` (`storeProductId`),
  CONSTRAINT `ShoppingListItem_ibfk_2` FOREIGN KEY (`productId`) REFERENCES `Product` (`id`),
  CONSTRAINT `ShoppingListItem_ibfk_3` FOREIGN KEY (`storeProductId`) REFERENCES `StoreProduct` (`id`),
  CONSTRAINT `ShoppingListItem_listId_fk` FOREIGN KEY (`listId`) REFERENCES `ShoppingList` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=175 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ShoppingListMember`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ShoppingListMember` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `listId` int(11) NOT NULL,
  `userId` varchar(255) NOT NULL,
  `role` enum('owner','member') NOT NULL DEFAULT 'member',
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slm_list_user` (`listId`,`userId`),
  CONSTRAINT `fk_slm_list` FOREIGN KEY (`listId`) REFERENCES `ShoppingList` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=38 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `ShoppingListShareToken`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `ShoppingListShareToken` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `listId` int(11) NOT NULL,
  `token` varchar(64) NOT NULL,
  `createdBy` varchar(255) NOT NULL,
  `expiresAt` datetime NOT NULL,
  `claimedAt` datetime DEFAULT NULL,
  `claimedBy` varchar(255) DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_slst_token` (`token`),
  KEY `fk_slst_list` (`listId`),
  CONSTRAINT `fk_slst_list` FOREIGN KEY (`listId`) REFERENCES `ShoppingList` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=16 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `Store`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `Store` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `chainId` int(11) NOT NULL,
  `name` varchar(255) NOT NULL,
  `address` varchar(500) DEFAULT NULL,
  `latitude` decimal(18,15) DEFAULT NULL,
  `longitude` decimal(18,15) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `chainId` (`chainId`),
  CONSTRAINT `Store_ibfk_1` FOREIGN KEY (`chainId`) REFERENCES `StoreChain` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=98002 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `StoreChain`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `StoreChain` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `name` varchar(255) NOT NULL,
  `logoUrl` varchar(500) DEFAULT NULL,
  `miniLogoUrl` varchar(500) DEFAULT NULL,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=97002 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `StoreProduct`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `StoreProduct` (
  `id` int(11) NOT NULL AUTO_INCREMENT,
  `productId` int(11) NOT NULL,
  `chainId` int(11) NOT NULL,
  `storeProductName` varchar(255) NOT NULL,
  `brandName` varchar(255) DEFAULT NULL,
  `amount` decimal(10,3) DEFAULT NULL,
  `unit` varchar(20) DEFAULT NULL,
  `isWeighable` tinyint(1) NOT NULL DEFAULT 0,
  `imageUrl` varchar(500) DEFAULT NULL,
  `provisional` tinyint(1) NOT NULL DEFAULT 0,
  `provisionalOwnerUserId` char(36) DEFAULT NULL,
  `mintedFromSpId` int(11) DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `productId` (`productId`),
  KEY `idx_sp_chainId` (`chainId`),
  CONSTRAINT `StoreProduct_ibfk_1` FOREIGN KEY (`productId`) REFERENCES `Product` (`id`),
  CONSTRAINT `StoreProduct_ibfk_2` FOREIGN KEY (`chainId`) REFERENCES `StoreChain` (`id`)
) ENGINE=InnoDB AUTO_INCREMENT=97057 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `StoreProductMatch`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `StoreProductMatch` (
  `spIdA` int(11) NOT NULL,
  `spIdB` int(11) NOT NULL,
  `identicalVotes` int(11) NOT NULL DEFAULT 0,
  `similarVotes` int(11) NOT NULL DEFAULT 0,
  `differentVotes` int(11) NOT NULL DEFAULT 0,
  `updatedAt` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`spIdA`,`spIdB`),
  KEY `idx_spm_b` (`spIdB`),
  CONSTRAINT `fk_spm_a` FOREIGN KEY (`spIdA`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spm_b` FOREIGN KEY (`spIdB`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `StoreProductMatchVote`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `StoreProductMatchVote` (
  `id` bigint(20) NOT NULL AUTO_INCREMENT,
  `userId` varchar(64) DEFAULT NULL,
  `spIdA` int(11) NOT NULL,
  `spIdB` int(11) NOT NULL,
  `vote` enum('identical','similar','different') NOT NULL,
  `dwellMs` int(11) DEFAULT NULL,
  `aggregated` tinyint(1) NOT NULL DEFAULT 1,
  `receiptId` int(11) DEFAULT NULL,
  `createdAt` timestamp NOT NULL DEFAULT current_timestamp(),
  `updatedAt` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_spmv_user_pair` (`userId`,`spIdA`,`spIdB`),
  KEY `idx_spmv_pair` (`spIdA`,`spIdB`),
  KEY `idx_spmv_user` (`userId`),
  KEY `fk_spmv_b` (`spIdB`),
  KEY `fk_spmv_receipt` (`receiptId`),
  KEY `idx_spmv_user_created` (`userId`,`createdAt`),
  CONSTRAINT `fk_spmv_a` FOREIGN KEY (`spIdA`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spmv_b` FOREIGN KEY (`spIdB`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_spmv_receipt` FOREIGN KEY (`receiptId`) REFERENCES `Receipt` (`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_spmv_user` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE SET NULL
) ENGINE=InnoDB AUTO_INCREMENT=637 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `User`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `User` (
  `id` char(36) NOT NULL,
  `createdAt` datetime DEFAULT current_timestamp(),
  `lastActiveAt` datetime DEFAULT current_timestamp(),
  `isAdmin` tinyint(1) NOT NULL DEFAULT 0,
  `points` int(11) NOT NULL DEFAULT 0,
  `firstName` varchar(100) DEFAULT NULL,
  `lastName` varchar(100) DEFAULT NULL,
  `adminEmail` varchar(255) DEFAULT NULL,
  `adminRole` enum('admin','superadmin') DEFAULT NULL,
  `adminGrantedAt` datetime DEFAULT NULL,
  `shadowBanned` tinyint(1) NOT NULL DEFAULT 0,
  `shadowBannedAt` datetime DEFAULT NULL,
  `shadowBannedNote` text DEFAULT NULL,
  `username` varchar(50) DEFAULT NULL,
  `usernameSetAt` datetime DEFAULT NULL,
  `displayName` varchar(60) DEFAULT NULL,
  `bio` varchar(160) DEFAULT NULL,
  `avatarUrl` varchar(500) DEFAULT NULL,
  `authProvider` enum('google','apple') DEFAULT NULL,
  `authSubject` varchar(255) DEFAULT NULL,
  `email` varchar(255) DEFAULT NULL,
  `emailVerified` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_username` (`username`),
  UNIQUE KEY `uq_user_provider_subject` (`authProvider`,`authSubject`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `UserProductScore`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `UserProductScore` (
  `userId` varchar(36) NOT NULL,
  `productId` int(11) NOT NULL,
  `score` decimal(10,4) NOT NULL DEFAULT 0.0000,
  `interactionCount` int(11) NOT NULL DEFAULT 0,
  `updatedAt` datetime NOT NULL,
  PRIMARY KEY (`userId`,`productId`),
  KEY `idx_user_score` (`userId`,`score` DESC)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
DROP TABLE IF EXISTS `UserStoreProductEquivalence`;
/*!40101 SET @saved_cs_client     = @@character_set_client */;
/*!40101 SET character_set_client = utf8mb4 */;
CREATE TABLE `UserStoreProductEquivalence` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `userId` varchar(36) NOT NULL,
  `spIdA` int(11) NOT NULL,
  `spIdB` int(11) NOT NULL,
  `verdict` enum('same','different') NOT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  `updatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  `needsReverification` tinyint(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_user_sp_pair` (`userId`,`spIdA`,`spIdB`),
  KEY `idx_user` (`userId`),
  KEY `idx_spA` (`spIdA`),
  KEY `idx_spB` (`spIdB`),
  CONSTRAINT `fk_uspe_spA` FOREIGN KEY (`spIdA`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_uspe_spB` FOREIGN KEY (`spIdB`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_uspe_user` FOREIGN KEY (`userId`) REFERENCES `User` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=172 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
/*!40101 SET character_set_client = @saved_cs_client */;
/*!40103 SET TIME_ZONE=@OLD_TIME_ZONE */;

/*!40101 SET SQL_MODE=@OLD_SQL_MODE */;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FOREIGN_KEY_CHECKS */;
/*!40014 SET UNIQUE_CHECKS=@OLD_UNIQUE_CHECKS */;
/*!40101 SET CHARACTER_SET_CLIENT=@OLD_CHARACTER_SET_CLIENT */;
/*!40101 SET CHARACTER_SET_RESULTS=@OLD_CHARACTER_SET_RESULTS */;
/*!40101 SET COLLATION_CONNECTION=@OLD_COLLATION_CONNECTION */;
/*M!100616 SET NOTE_VERBOSITY=@OLD_NOTE_VERBOSITY */;


-- Vocabulary (Issue H) tables — added for crossChainRescue integration tests
CREATE TABLE IF NOT EXISTS `StoreProductReceiptAlias` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `chainId` int(11) NOT NULL,
  `storeProductId` int(11) NOT NULL,
  `normalizedAlias` varchar(255) NOT NULL,
  `rawSample` varchar(255) DEFAULT NULL,
  `occurrences` int(10) unsigned NOT NULL DEFAULT 1,
  `identicalUsers` int(10) unsigned NOT NULL DEFAULT 0,
  `similarUsers` int(10) unsigned NOT NULL DEFAULT 0,
  `differentUsers` int(10) unsigned NOT NULL DEFAULT 0,
  `status` enum('pending','canonical','similarity','rejected') NOT NULL DEFAULT 'pending',
  `adminVerdict` enum('confirmed','rejected') DEFAULT NULL,
  `sampleReceiptId` int(11) DEFAULT NULL,
  `firstSeenAt` datetime NOT NULL DEFAULT current_timestamp(),
  `lastSeenAt` datetime NOT NULL DEFAULT current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_alias` (`chainId`,`storeProductId`,`normalizedAlias`),
  KEY `idx_match` (`chainId`,`status`,`normalizedAlias`),
  KEY `idx_curation` (`status`,`chainId`,`lastSeenAt`),
  KEY `idx_sp` (`storeProductId`,`status`),
  CONSTRAINT `fk_alias_sp` FOREIGN KEY (`storeProductId`) REFERENCES `StoreProduct` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=87 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS `StoreProductReceiptAliasVote` (
  `id` int(10) unsigned NOT NULL AUTO_INCREMENT,
  `aliasId` int(10) unsigned NOT NULL,
  `userId` varchar(64) NOT NULL,
  `vote` enum('identical','similar','different') NOT NULL,
  `receiptId` int(11) DEFAULT NULL,
  `createdAt` datetime NOT NULL DEFAULT current_timestamp(),
  `updatedAt` datetime NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp(),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_alias_user` (`aliasId`,`userId`),
  KEY `idx_user` (`userId`),
  CONSTRAINT `fk_aliasvote_alias` FOREIGN KEY (`aliasId`) REFERENCES `StoreProductReceiptAlias` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB AUTO_INCREMENT=88 DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
