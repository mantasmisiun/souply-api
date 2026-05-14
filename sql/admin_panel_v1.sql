-- Migration: Admin Panel v1 — image cleanup tab
--
-- Three new tables + one column add. All four are referenced from the
-- image-tab admin flow; the audit log + rate-limit support is shared
-- with future admin tabs (amounts, names, dead-end orphans, etc.) so
-- it's built once here.

-- ── ImagePropagationLog ─────────────────────────────────────────────
-- Every time an SP gets an image — from auto cross-chain propagation,
-- an admin adopt, or an admin upload — one row goes in. The reversal
-- path reads this to find the previous image and the source. `actor`
-- distinguishes auto vs admin so the nightly job's outputs can be
-- bulk-reverted if a bad sibling propagated.
CREATE TABLE IF NOT EXISTS ImagePropagationLog (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    spId INT NOT NULL,
    sourceType ENUM('cross_chain_sibling', 'admin_adopt_candidate', 'admin_upload', 'user_upload_approved') NOT NULL,
    sourceSpId INT NULL,                    -- non-null for cross_chain_sibling + admin_adopt_candidate
    fromImageUrl VARCHAR(500) NULL,         -- previous imageUrl on the SP (NULL = was empty)
    toImageUrl   VARCHAR(500) NOT NULL,
    actor VARCHAR(64) NOT NULL,             -- 'auto' or a User.id
    reversedAt DATETIME NULL,               -- set when reverted; the row itself is never deleted
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sp (spId, createdAt),
    INDEX idx_actor (actor, createdAt),
    CONSTRAINT fk_ipl_sp FOREIGN KEY (spId) REFERENCES StoreProduct(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── PendingImageUpload ───────────────────────────────────────────────
-- User uploads land here instead of writing StoreProduct.imageUrl
-- directly. Admin queue lists pending rows as candidate images
-- alongside cross-chain siblings. Approving copies filePath to the SP
-- and writes an ImagePropagationLog row with sourceType='user_upload_approved'.
CREATE TABLE IF NOT EXISTS PendingImageUpload (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    spId INT NOT NULL,
    uploadedBy VARCHAR(64) NOT NULL,        -- User.id of the contributor
    filePath VARCHAR(500) NOT NULL,         -- public MinIO URL
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    resolvedBy VARCHAR(64) NULL,            -- admin User.id who approved/rejected
    resolvedAt DATETIME NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_sp_status (spId, status),
    INDEX idx_status_created (status, createdAt),
    CONSTRAINT fk_piu_sp FOREIGN KEY (spId) REFERENCES StoreProduct(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ── ReceiptLineIssue.status ──────────────────────────────────────────
-- Flag rows from receipt-detail get a lifecycle so the image tab (and
-- future tabs) can mark them resolved without deleting them — the row
-- stays as part of the audit trail. Existing rows default to 'pending'.
ALTER TABLE ReceiptLineIssue
    ADD COLUMN status ENUM('pending','resolved','dismissed') NOT NULL DEFAULT 'pending',
    ADD COLUMN resolvedBy VARCHAR(64) NULL,
    ADD COLUMN resolvedAt DATETIME NULL,
    ADD INDEX idx_status (status, createdAt);

-- ── AdminAuditLog ────────────────────────────────────────────────────
-- One row per admin write. Shared across all admin tabs — the image
-- tab is the first user but the structure is generic. `targetType`
-- + `targetId` identifies what was acted on; `action` describes what
-- happened; before/after payloads are JSON so any tab's data shape
-- fits. `reversedAt` marks the row as undone (never delete audit
-- rows — auditability requires permanent records).
CREATE TABLE IF NOT EXISTS AdminAuditLog (
    id BIGINT PRIMARY KEY AUTO_INCREMENT,
    adminUserId VARCHAR(64) NOT NULL,
    action VARCHAR(64) NOT NULL,            -- e.g. 'image_adopt', 'image_remove', 'image_revert'
    targetType VARCHAR(32) NOT NULL,        -- e.g. 'StoreProduct'
    targetId BIGINT NOT NULL,
    valueBefore JSON NULL,
    valueAfter JSON NULL,
    reversedAt DATETIME NULL,
    createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_admin (adminUserId, createdAt),
    INDEX idx_target (targetType, targetId, createdAt)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
