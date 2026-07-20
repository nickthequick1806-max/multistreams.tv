CREATE TABLE IF NOT EXISTS profile_media (
  key TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  media_type TEXT NOT NULL CHECK(media_type IN ('avatar', 'banner')),
  content_type TEXT NOT NULL,
  body BLOB NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS profile_media_user_idx
  ON profile_media(user_id, media_type, created_at DESC);
