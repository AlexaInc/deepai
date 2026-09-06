'use strict';

/**
 * Test doubles
 * ------------
 * A tiny in-memory stand-in for PostgreSQL and for the DeepAI HTTP API, so the
 * full `AlexaAI.chat()` pipeline — identity resolution, memory injection,
 * guards, formatting, persistence — can be exercised with no network and no
 * database. The fake DB understands only the handful of statements the engine
 * actually issues; anything else returns an empty result.
 */

function createFakeDb() {
    const state = { users: [], identities: [], convos: [], messages: [], memories: [] };
    let seq = 1;

    const one = (sql, p = []) => {
        const q = String(sql).replace(/\s+/g, ' ').trim();

        if (/JOIN wa_user_identities i ON i.user_id = u.id WHERE i.jid/.test(q)) {
            const alias = state.identities.find((i) => i.jid === p[0]);
            return alias ? state.users.find((u) => u.id === alias.user_id) || null : null;
        }
        if (/^SELECT u\.\* FROM wa_users u JOIN wa_user_identities i ON i.user_id = u.id WHERE i.phone/.test(q)) {
            const alias = state.identities.find((i) => i.phone === p[0]);
            return alias ? state.users.find((u) => u.id === alias.user_id) || null : null;
        }
        if (/^INSERT INTO wa_users/.test(q)) {
            let user = state.users.find((u) => u.jid === p[0]);
            if (!user) {
                user = {
                    id: seq++,
                    jid: p[0],
                    jid_local: p[1],
                    jid_server: p[2],
                    jid_type: p[3],
                    phone: p[4],
                    push_name: p[5],
                    display_name: null,
                    is_blocked: false,
                    is_admin: false,
                    message_count: 0,
                    token_estimate: 0,
                    metadata: {},
                    first_seen_at: new Date(),
                    last_seen_at: new Date(),
                };
                state.users.push(user);
            } else if (p[5]) {
                user.push_name = user.push_name || p[5];
            }
            return user;
        }
        if (/^UPDATE wa_users SET last_seen_at/.test(q)) return state.users.find((u) => u.id === p[0]) || null;
        if (/^SELECT \* FROM wa_users WHERE id/.test(q)) return state.users.find((u) => u.id === p[0]) || null;
        if (/^SELECT \* FROM wa_user_identities WHERE jid/.test(q)) {
            return state.identities.find((i) => i.jid === p[0]) || null;
        }
        if (/^SELECT jid FROM wa_user_identities/.test(q)) {
            const rows = state.identities.filter((i) => i.user_id === p[0]);
            const primary = rows.find((r) => r.is_primary) || rows[0];
            return primary ? { jid: primary.jid } : null;
        }
        if (/^INSERT INTO wa_groups/.test(q)) {
            return { id: seq++, jid: p[0], subject: p[1], is_enabled: true };
        }
        if (/^INSERT INTO wa_group_members/.test(q)) return { id: seq++ };
        if (/^INSERT INTO wa_conversations/.test(q)) {
            let convo = state.convos.find((c) => c.context_key === p[0]);
            if (!convo) {
                convo = { id: seq++, context_key: p[0], user_id: p[1], group_id: p[2], kind: p[3] };
                state.convos.push(convo);
            }
            return convo;
        }
        if (/SELECT COALESCE\(\s*u.display_name/.test(q)) {
            const user = state.users.find((u) => u.id === p[0]);
            const named = state.memories.find((m) => m.user_id === p[0] && m.key === 'name');
            return { name: user?.display_name || named?.value || user?.push_name || null };
        }
        if (/^INSERT INTO wa_messages/.test(q)) {
            const row = { id: seq++, conversation_id: p[0], user_id: p[1], role: p[2], content: p[3] };
            state.messages.push(row);
            return row;
        }
        if (/^INSERT INTO wa_memories/.test(q)) {
            const row = { user_id: p[0], key: p[1], value: p[2] };
            state.memories = state.memories.filter((m) => !(m.user_id === row.user_id && m.key === row.key));
            state.memories.push(row);
            return row;
        }
        return null;
    };

    const many = (sql, p = []) => {
        const q = String(sql).replace(/\s+/g, ' ').trim();
        if (/FROM wa_messages/.test(q)) {
            return state.messages
                .filter((m) => m.conversation_id === p[0])
                .map((m) => ({ role: m.role, content: m.content }));
        }
        if (/FROM wa_memories/.test(q)) {
            return state.memories.filter((m) => m.user_id === p[0]).map((m) => ({ key: m.key, value: m.value }));
        }
        if (/FROM wa_user_identities/.test(q)) {
            return state.identities.filter((i) => i.user_id === p[0]);
        }
        return [];
    };

    const db = {
        state,
        connect: async () => {},
        migrate: async () => {},
        close: async () => {},
        one: async (sql, p) => one(sql, p),
        many: async (sql, p) => many(sql, p),
        query: async (sql, p = []) => {
            const q = String(sql).replace(/\s+/g, ' ').trim();
            if (/^INSERT INTO wa_user_identities/.test(q)) {
                if (!state.identities.find((i) => i.jid === p[1])) {
                    state.identities.push({
                        user_id: p[0],
                        jid: p[1],
                        jid_type: p[4],
                        phone: p[5],
                        is_primary: Boolean(p[6]),
                        first_seen_at: new Date(),
                    });
                }
                return { rows: [], rowCount: 1 };
            }
            const row = one(sql, p);
            return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        },
        transaction: async (fn) => fn({ query: async (sql, p) => db.query(sql, p) }),
    };
    return db;
}

/**
 * Replace global.fetch with a queue-driven DeepAI stub.
 * @param {string[]} replies bodies returned by successive chat calls
 * @returns {{ restore: () => void, calls: object[], push: (body:string)=>void }}
 */
function installFakeDeepAI(replies = []) {
    const queue = [...replies];
    const calls = [];
    const realFetch = global.fetch;

    global.fetch = async (url, init = {}) => {
        const fields = {};
        if (init.body && typeof init.body.forEach === 'function') {
            init.body.forEach((value, key) => {
                fields[key] = typeof value === 'string' ? value : '[file]';
            });
        }
        calls.push({ url: String(url), fields });
        const body = queue.length ? queue.shift() : 'Hello!';
        return {
            status: 200,
            headers: { get: () => 'text/plain' },
            text: async () => body,
            body: null,
        };
    };

    return { calls, push: (body) => queue.push(body), restore: () => { global.fetch = realFetch; } };
}

module.exports = { createFakeDb, installFakeDeepAI };
