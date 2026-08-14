PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS youtube_subscriptions (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  channel_title TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  uploads_playlist_id TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS youtube_subscriptions_user_idx
  ON youtube_subscriptions(user_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS youtube_live_state (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id TEXT NOT NULL,
  video_id TEXT NOT NULL DEFAULT '',
  is_live INTEGER NOT NULL DEFAULT 0,
  notified_video_id TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  PRIMARY KEY(user_id, channel_id)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  user_low_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_high_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(user_low_id, user_high_id),
  CHECK(user_low_id <> user_high_id)
);
CREATE INDEX IF NOT EXISTS conversations_low_idx ON conversations(user_low_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS conversations_high_idx ON conversations(user_high_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  read_at TEXT,
  created_at TEXT NOT NULL,
  CHECK(sender_user_id <> recipient_user_id)
);
CREATE INDEX IF NOT EXISTS direct_messages_conversation_idx
  ON direct_messages(conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS direct_messages_recipient_idx
  ON direct_messages(recipient_user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS profile_panels (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  link_url TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS profile_panels_user_idx
  ON profile_panels(user_id, position, created_at);
