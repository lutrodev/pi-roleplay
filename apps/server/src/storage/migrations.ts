/** Released migrations are immutable: create a new version for every schema change. */
export const migrations = [{
  version: 1,
  sql: `
    CREATE TABLE stories (
      id TEXT PRIMARY KEY NOT NULL,
      title TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data TEXT NOT NULL CHECK (json_valid(data)),
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      UNIQUE (story_id, idempotency_key)
    );
    CREATE INDEX events_story_cursor ON events(story_id, seq);
    CREATE TABLE assets (
      id TEXT PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('character','lorebook','persona','preset','writingStyle')),
      name TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      data TEXT NOT NULL CHECK (json_valid(data)),
      source_hash TEXT,
      source_character_id TEXT,
      avatar_file_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX assets_kind_name ON assets(kind, name);
    CREATE UNIQUE INDEX assets_import_hash ON assets(kind, source_hash) WHERE source_hash IS NOT NULL;
    CREATE INDEX assets_source_character ON assets(source_character_id);
    CREATE TABLE files (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size INTEGER NOT NULL CHECK (size >= 0),
      sha256 TEXT NOT NULL,
      storage_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE TABLE runs (
      id TEXT PRIMARY KEY NOT NULL,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      turn_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued','running','waiting_user','completed','failed','cancelled','interrupted')),
      draft TEXT NOT NULL DEFAULT '',
      error TEXT CHECK (error IS NULL OR json_valid(error)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (story_id, request_id)
    );
    CREATE UNIQUE INDEX runs_one_pending_per_story ON runs(story_id) WHERE status IN ('queued','running','waiting_user');
    CREATE UNIQUE INDEX runs_one_active_global ON runs((1)) WHERE status IN ('running','waiting_user');
    CREATE INDEX runs_queue ON runs(status, created_at);
    CREATE TABLE settings (key TEXT PRIMARY KEY NOT NULL, value TEXT NOT NULL CHECK (json_valid(value)));
  `,
}, {
  version: 2,
  sql: `
    CREATE INDEX events_story_type_cursor ON events(story_id, type, seq);
    CREATE INDEX events_story_run_cursor ON events(story_id, type, json_extract(data, '$.runId'), seq);
    CREATE INDEX events_story_call_cursor ON events(story_id, type, json_extract(data, '$.callId'), seq);
  `,
}, {
  version: 3,
  sql: `
    CREATE TABLE pending_inputs (
      id TEXT PRIMARY KEY NOT NULL,
      story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE,
      request_id TEXT NOT NULL,
      request_hash TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
      target_run_id TEXT REFERENCES runs(id),
      inputs TEXT NOT NULL CHECK (json_valid(inputs)),
      status TEXT NOT NULL CHECK (status IN ('pending','applied','cancelled')),
      applied_run_id TEXT REFERENCES runs(id),
      created_at TEXT NOT NULL,
      position INTEGER NOT NULL,
      UNIQUE (story_id, request_id)
    );
    CREATE INDEX pending_inputs_order ON pending_inputs(status, position);
    CREATE INDEX pending_inputs_story ON pending_inputs(story_id, status, position);
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE workspaces (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      directory TEXT NOT NULL UNIQUE,
      access TEXT NOT NULL CHECK (access IN ('read-only','read-write')),
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
}, {
  version: 5,
  sql: `DELETE FROM settings WHERE key = 'app.workspaces';`,
}, {
  version: 6,
  sql: `
    CREATE TABLE background_images (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      width INTEGER NOT NULL CHECK (width > 0),
      height INTEGER NOT NULL CHECK (height > 0),
      size INTEGER NOT NULL CHECK (size > 0),
      content BLOB NOT NULL,
      thumbnail BLOB NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
}, {
  version: 7,
  sql: `
    UPDATE settings
    SET value = json_set(
      json_remove(value, '$.settings.subagentModels'),
      '$.version', 2,
      '$.revision', json_extract(value, '$.revision') + 1
    )
    WHERE key = 'tools.settings' AND json_extract(value, '$.version') = 1;
  `,
}, {
  version: 8,
  sql: `
    CREATE TABLE deleted_stories (
      id TEXT PRIMARY KEY NOT NULL,
      deleted_at TEXT NOT NULL
    );
  `,
}, {
  version: 9,
  sql: `DROP INDEX runs_one_active_global;`,
}] as const
