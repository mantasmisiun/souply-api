-- Client version gating (roadmap project_roadmap_version_gating). Server-driven,
-- runtime-flippable floors per platform so an outdated frontend can be nudged (soft) or
-- hard-blocked against a newer backend WITHOUT a redeploy.
--
-- FAIL-OPEN by construction: a NULL minVersion blocks NOBODY, a NULL recommendedVersion
-- nudges nobody. Seeded with NULL floors so DEPLOYING this changes nothing until an
-- operator intentionally raises a floor (UPDATE ... SET minVersion = '1.2.0' WHERE platform='android').
--
-- Operate it per the runbook: raise a platform's floor ONLY after that store is live at
-- 100%; rollback = lower the floor (instant, no redeploy). Idempotent (safe to re-run).

CREATE TABLE IF NOT EXISTS ClientVersionPolicy (
    platform            ENUM('ios','android','web') NOT NULL,
    -- Hard floor: clients STRICTLY BELOW this are blocked (426 / hard gate). NULL = no block.
    minVersion          VARCHAR(32) NULL,
    -- Soft floor: clients strictly below this get a dismissible "update available" nudge. NULL = none.
    recommendedVersion  VARCHAR(32) NULL,
    -- Where the gate's button sends the user (store page). Per platform.
    storeUrl            VARCHAR(512) NULL,
    -- Optional operator override message (else the client shows localized default copy).
    message             VARCHAR(512) NULL,
    updatedAt           TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (platform)
);

-- Seed one row per platform with NULL floors (no-op). storeUrl pre-filled where derivable;
-- the App Store numeric id can be pasted in later (closed testing → public listing).
INSERT INTO ClientVersionPolicy (platform, minVersion, recommendedVersion, storeUrl, message)
VALUES
    ('android', NULL, NULL, 'https://play.google.com/store/apps/details?id=lt.souply.app', NULL),
    ('ios',     NULL, NULL, 'https://apps.apple.com/app/lt.souply.app', NULL),
    ('web',     NULL, NULL, NULL, NULL)
ON DUPLICATE KEY UPDATE platform = platform; -- keep existing rows/floors on re-run
