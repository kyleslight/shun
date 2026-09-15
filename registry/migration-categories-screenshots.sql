-- Store categories and package cover images.
--
-- `schema.sql` describes a fresh database, so an existing deployment needs this
-- once. Both columns are additive and nullable: a catalog read before the
-- migration simply has no categories or screenshots, and no query depends on them.
--
--   wrangler d1 execute <database> --remote --file=registry/migration-categories-screenshots.sql

ALTER TABLE plugins ADD COLUMN categories TEXT;
ALTER TABLE plugins ADD COLUMN screenshots TEXT;
