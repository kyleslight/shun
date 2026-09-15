-- Shun plugin registry schema.
--
-- `submissions` is the durable record of everything anyone handed over, whatever
-- state it is in. `plugins` and `plugin_versions` are the published projection
-- the store reads, so a submission under review is invisible to clients and a
-- rejected one leaves no trace in the catalog.
--
-- Publishing is curated: a first submission lands in `review`, and only a
-- reviewer's decision moves it into the catalog. Versions are immutable — a
-- published (id, version) pair is never overwritten, and yanking is recorded
-- rather than performed by deletion, so an installed copy keeps resolving.

CREATE TABLE IF NOT EXISTS publishers (
  handle TEXT PRIMARY KEY,
  -- Only a hash and a domain: the registry never needs the address itself.
  email_hash TEXT NOT NULL UNIQUE,
  email_domain TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  publisher_handle TEXT NOT NULL,
  public_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT
);

CREATE INDEX IF NOT EXISTS devices_publisher ON devices (publisher_handle);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  publisher_handle TEXT NOT NULL,
  archive_sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  archive_bytes INTEGER NOT NULL,
  manifest TEXT NOT NULL,
  changelog TEXT,
  submitted_at TEXT NOT NULL,
  state TEXT NOT NULL,
  reviewed_at TEXT,
  review_note TEXT
);

CREATE INDEX IF NOT EXISTS submissions_state ON submissions (state, submitted_at);
CREATE INDEX IF NOT EXISTS submissions_plugin ON submissions (plugin_id, version);

-- Ids owned by the application itself: a bundled package ships inside Shun, so
-- nobody may publish under its id.
CREATE TABLE IF NOT EXISTS reserved_ids (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  note TEXT
);

CREATE TABLE IF NOT EXISTS plugins (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  publisher TEXT NOT NULL,
  icon TEXT,
  keywords TEXT,
  -- Store categories from the registry-owned vocabulary, and the package-relative
  -- cover images the latest version declares. Both are JSON arrays.
  categories TEXT,
  screenshots TEXT,
  license TEXT,
  homepage TEXT,
  repository TEXT,
  permissions TEXT NOT NULL,
  latest TEXT NOT NULL,
  featured INTEGER,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published'
);

CREATE TABLE IF NOT EXISTS plugin_versions (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  published_at TEXT NOT NULL,
  engines TEXT,
  archive_sha256 TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  files INTEGER NOT NULL,
  bytes INTEGER NOT NULL,
  archive_bytes INTEGER NOT NULL,
  changelog TEXT,
  yanked_at TEXT,
  PRIMARY KEY (plugin_id, version)
);

-- A publisher proves control of an email address once. The code is stored as a
-- hash of the pepper, the challenge id, and the code itself, so the table is not
-- a list of live credentials. Verification creates a device key; every later
-- publish is a signature over the request rather than a bearer secret.
CREATE TABLE IF NOT EXISTS challenges (
  id TEXT PRIMARY KEY,
  email_hash TEXT NOT NULL,
  email_domain TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  handle TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  consumed_at TEXT
);

CREATE INDEX IF NOT EXISTS challenges_email ON challenges (email_hash, created_at);

-- The kill switch. Yanking stops new installs; blocking also withdraws the
-- version from copies that are already on disk, which is the only way to react
-- to a package that turned out to be harmful. A row with version '*' blocks
-- every version of that plugin.
CREATE TABLE IF NOT EXISTS blocked (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  reason TEXT NOT NULL,
  blocked_at TEXT NOT NULL,
  PRIMARY KEY (plugin_id, version)
);
