BEGIN;

-- Required for GiST equality operators on uuid columns used by exclusion constraints.
CREATE EXTENSION IF NOT EXISTS btree_gist;

COMMIT;
