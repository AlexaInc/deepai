-- ============================================================================
--  Alexa AI — PostgreSQL schema
--  Safe to run repeatedly (idempotent).
--
--  Identity model
--  --------------
--  WhatsApp gives us two independent identifiers:
--     user  : 78151912841263@lid   or  94771234567@s.whatsapp.net
--     group : 120363413125431525@g.us
--
--  A user is ONE row in wa_users keyed by their jid. That row is shared across
--  every group and the DM, so "recognise user data in any group" works by
--  construction: memories hang off user_id, never off the group.
--
--  Conversations are separate threads (DM vs each group) so chat context never
--  bleeds between rooms, while the user's identity and memories stay global.
-- ============================================================================

-- ---------------------------------------------------------------- users -----
CREATE TABLE IF NOT EXISTS wa_users (
    id              BIGSERIAL PRIMARY KEY,
    jid             TEXT        NOT NULL UNIQUE,            -- canonical: 78151912841263@lid
    jid_local       TEXT        NOT NULL,                   -- 78151912841263
    jid_server      TEXT        NOT NULL,                   -- lid | s.whatsapp.net
    jid_type        TEXT        NOT NULL DEFAULT 'user',    -- lid | user
    phone           TEXT,                                   -- NULL for @lid (privacy id)
    push_name       TEXT,                                   -- WhatsApp display name
    display_name    TEXT,                                   -- name Alexa learned/prefers
    is_blocked      BOOLEAN     NOT NULL DEFAULT FALSE,
    is_admin        BOOLEAN     NOT NULL DEFAULT FALSE,
    locale          TEXT,
    message_count   BIGINT      NOT NULL DEFAULT 0,
    token_estimate  BIGINT      NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_users_phone      ON wa_users (phone) WHERE phone IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wa_users_last_seen  ON wa_users (last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_users_local      ON wa_users (jid_local);

-- --------------------------------------------------------------- groups -----
CREATE TABLE IF NOT EXISTS wa_groups (
    id              BIGSERIAL PRIMARY KEY,
    jid             TEXT        NOT NULL UNIQUE,            -- 120363413125431525@g.us
    subject         TEXT,                                   -- group title
    description     TEXT,
    is_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,      -- AI on/off per group
    message_count   BIGINT      NOT NULL DEFAULT 0,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_groups_last_seen ON wa_groups (last_seen_at DESC);

-- ------------------------------------------------------- group membership ---
-- Tracks which user was seen in which group (per-room stats, admin flags).
-- Identity still lives in wa_users, so memories remain global.
CREATE TABLE IF NOT EXISTS wa_group_members (
    id              BIGSERIAL PRIMARY KEY,
    group_id        BIGINT      NOT NULL REFERENCES wa_groups(id) ON DELETE CASCADE,
    user_id         BIGINT      NOT NULL REFERENCES wa_users(id)  ON DELETE CASCADE,
    is_admin        BOOLEAN     NOT NULL DEFAULT FALSE,
    message_count   BIGINT      NOT NULL DEFAULT 0,
    first_seen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_wa_group_members_user ON wa_group_members (user_id);

-- -------------------------------------------------------- conversations -----
-- One row per thread. DM => group_id NULL. Group => (group_id, user_id).
CREATE TABLE IF NOT EXISTS wa_conversations (
    id              BIGSERIAL PRIMARY KEY,
    context_key     TEXT        NOT NULL UNIQUE,            -- dm:<jid> | group:<gjid>:<ujid>
    user_id         BIGINT      REFERENCES wa_users(id)  ON DELETE CASCADE,
    group_id        BIGINT      REFERENCES wa_groups(id) ON DELETE CASCADE,
    kind            TEXT        NOT NULL DEFAULT 'dm',      -- dm | group
    title           TEXT,
    message_count   BIGINT      NOT NULL DEFAULT 0,
    last_message_at TIMESTAMPTZ,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_conversations_user  ON wa_conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_group ON wa_conversations (group_id);
CREATE INDEX IF NOT EXISTS idx_wa_conversations_last  ON wa_conversations (last_message_at DESC NULLS LAST);

-- ------------------------------------------------------------- messages -----
CREATE TABLE IF NOT EXISTS wa_messages (
    id              BIGSERIAL PRIMARY KEY,
    conversation_id BIGINT      NOT NULL REFERENCES wa_conversations(id) ON DELETE CASCADE,
    user_id         BIGINT      REFERENCES wa_users(id) ON DELETE SET NULL,
    role            TEXT        NOT NULL CHECK (role IN ('user','assistant','system')),
    content         TEXT        NOT NULL,
    has_media       BOOLEAN     NOT NULL DEFAULT FALSE,
    media_type      TEXT,
    wa_message_id   TEXT,                                   -- WhatsApp msg id (dedupe)
    tokens          INTEGER,
    metadata        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Primary read path: newest N messages of a thread.
CREATE INDEX IF NOT EXISTS idx_wa_messages_convo_time
    ON wa_messages (conversation_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_wa_messages_user ON wa_messages (user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_messages_wa_id
    ON wa_messages (conversation_id, wa_message_id) WHERE wa_message_id IS NOT NULL;

-- ------------------------------------------------------------- memories -----
-- Long-term facts, keyed to the USER (never the group) so Alexa recognises the
-- same person in a DM and in every group. `key` is unique per user: re-learning
-- "name" overwrites rather than duplicating.
CREATE TABLE IF NOT EXISTS wa_memories (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      NOT NULL REFERENCES wa_users(id) ON DELETE CASCADE,
    key             TEXT        NOT NULL,
    value           TEXT        NOT NULL,
    source          TEXT        NOT NULL DEFAULT 'auto',    -- auto | manual | import
    confidence      REAL        NOT NULL DEFAULT 1.0,
    hit_count       INTEGER     NOT NULL DEFAULT 0,         -- times injected into a prompt
    learned_in      TEXT,                                   -- context_key where learned
    expires_at      TIMESTAMPTZ,                            -- NULL = permanent
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, key)
);

CREATE INDEX IF NOT EXISTS idx_wa_memories_user    ON wa_memories (user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_memories_expires ON wa_memories (expires_at) WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------- audit ------
CREATE TABLE IF NOT EXISTS wa_ai_usage (
    id              BIGSERIAL PRIMARY KEY,
    user_id         BIGINT      REFERENCES wa_users(id) ON DELETE SET NULL,
    conversation_id BIGINT      REFERENCES wa_conversations(id) ON DELETE SET NULL,
    model           TEXT,
    ok              BOOLEAN     NOT NULL DEFAULT TRUE,
    error_code      TEXT,
    latency_ms      INTEGER,
    prompt_chars    INTEGER,
    reply_chars     INTEGER,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_wa_ai_usage_time ON wa_ai_usage (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wa_ai_usage_user ON wa_ai_usage (user_id);

-- --------------------------------------------------- updated_at triggers -----
CREATE OR REPLACE FUNCTION wa_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['wa_users','wa_groups','wa_conversations','wa_memories']
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_trigger
            WHERE tgname = 'trg_touch_' || t
        ) THEN
            EXECUTE format(
                'CREATE TRIGGER trg_touch_%1$s BEFORE UPDATE ON %1$s
                 FOR EACH ROW EXECUTE FUNCTION wa_touch_updated_at()', t);
        END IF;
    END LOOP;
END;
$$;
