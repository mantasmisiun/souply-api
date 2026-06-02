# Test database

Integration tests (the `admin*` suites and anything that imports the real
`src/config/db.js`) run against a **dedicated, otherwise-empty** database —
configured as `DB_NAME` in `.env.test` (`souply_test_ci`).

They must **not** run against the populated `souply_test` mirror: the
admin-queue endpoints query globally with a `LIMIT`, so real rows crowd out the
test fixtures and the assertions fail.

## One-time server setup

`souply_app` cannot create databases, so an admin creates the DB and grants
access once (run as root on the DB host):

```sql
CREATE DATABASE souply_test_ci CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
GRANT ALL PRIVILEGES ON souply_test_ci.* TO 'souply_app'@'%';
FLUSH PRIVILEGES;
```

That's it. On the next `npm test`, `tests/globalSetup.ts` detects the empty DB
and loads `schema.sql` automatically.

## schema.sql

Structure-only dump (no data) of the production schema. Regenerate after a
schema migration with:

```sh
MYSQL_PWD="$DB_PASSWORD" mariadb-dump --no-data --skip-comments \
  --single-transaction --no-tablespaces --routines --events \
  -h <host> -P <port> -u souply_app souply_test > tests/schema/schema.sql
```

To rebuild a corrupted test DB from scratch, drop every table in
`souply_test_ci` (or `DROP DATABASE` + recreate per above) and re-run the tests;
the schema reloads on the next run.

## Execution

The api `test` script runs `jest --runInBand` so the DB-backed suites execute
serially and don't collide on the shared connection.
