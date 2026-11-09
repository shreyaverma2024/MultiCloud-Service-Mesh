-- Render logical database: render_library
-- Members and notification history. Both logical databases live on the same
-- self-managed PostgreSQL server on AWS EC2.

CREATE TABLE IF NOT EXISTS members (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  phone TEXT,
  membership_type TEXT NOT NULL DEFAULT 'BASIC' CHECK (membership_type IN ('BASIC', 'PREMIUM', 'STUDENT')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS notifications (
  id SERIAL PRIMARY KEY,
  member_id INTEGER NOT NULL,
  book_id INTEGER,
  type TEXT NOT NULL CHECK (type IN ('BORROW', 'RETURN', 'SYSTEM')),
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'SENT', 'FAILED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_members_name ON members(name);
CREATE INDEX IF NOT EXISTS idx_notifications_member ON notifications(member_id);
CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications(status);
