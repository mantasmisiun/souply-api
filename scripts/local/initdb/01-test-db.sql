-- Runs once, on the first start of a fresh souply-local mariadb volume.
-- The image already created souply_local + souply_app (compose env); this adds
-- the empty integration-test DB. tests/globalSetup.ts loads its schema on the
-- first `npm run test:local`.
CREATE DATABASE IF NOT EXISTS souply_test_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON souply_test_ci.* TO 'souply_app'@'%';
FLUSH PRIVILEGES;
