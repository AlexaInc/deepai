'use strict';

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const { DatabaseError } = require('../core/errors');

/**
 * Database
 * --------
 * Owns the pg connection pool, runs migrations, and exposes small helpers
 * (`query`, `one`, `transaction`) used by the repositories.
 */
class Database {
    /** @param {import('../core/Config')} config */
    constructor(config) {
        this.config = config;
        this.log = config.logger;
        this.pool = null;
        this._ready = null;
        this._closed = false;
    }

    /** Lazily create the pool + run migrations exactly once. */
    async connect() {
        if (this._ready) return this._ready;

        this._ready = (async () => {
            this.pool = new Pool({
                connectionString: this.config.postgresUrl,
                ssl: this.config.ssl,
                ...this.config.pool,
            });

            // A pooled client can die (network blip, managed-PG restart).
            // Without this handler Node would crash the whole bot.
            this.pool.on('error', (err) => {
                this.log.error?.('[AlexaAI] Idle PostgreSQL client error:', err.message);
            });

            try {
                const client = await this.pool.connect();
                client.release();
            } catch (err) {
                this.pool = null;
                this._ready = null;
                throw new DatabaseError(`Cannot connect to PostgreSQL: ${err.message}`, {
                    code: 'DB_CONNECT_FAILED',
                    cause: err,
                });
            }

            if (this.config.autoMigrate) await this.migrate();
            if (this.config.debug) this.log.info?.('[AlexaAI] PostgreSQL ready');
            return this.pool;
        })();

        return this._ready;
    }

    /** Apply schema.sql. Idempotent. */
    async migrate() {
        const sqlPath = path.join(__dirname, 'schema.sql');
        let sql;
        try {
            sql = fs.readFileSync(sqlPath, 'utf8');
        } catch (err) {
            throw new DatabaseError(`Unable to read schema.sql: ${err.message}`, { cause: err });
        }

        try {
            await this.pool.query(sql);
        } catch (err) {
            throw new DatabaseError(`Migration failed: ${err.message}`, {
                code: 'DB_MIGRATION_FAILED',
                cause: err,
            });
        }
    }

    /**
     * @param {string} text
     * @param {Array<any>} [params]
     * @returns {Promise<import('pg').QueryResult>}
     */
    async query(text, params = []) {
        if (this._closed) throw new DatabaseError('Database pool is closed', { code: 'DB_CLOSED' });
        await this.connect();
        const started = this.config.debug ? Date.now() : 0;
        try {
            const result = await this.pool.query(text, params);
            if (this.config.debug) {
                this.log.debug?.(`[AlexaAI][sql ${Date.now() - started}ms] ${text.split('\n')[0].trim()}`);
            }
            return result;
        } catch (err) {
            throw new DatabaseError(`Query failed: ${err.message}`, {
                code: err.code || 'DB_QUERY_FAILED',
                cause: err,
            });
        }
    }

    /** First row or null. */
    async one(text, params = []) {
        const { rows } = await this.query(text, params);
        return rows[0] || null;
    }

    /** All rows. */
    async many(text, params = []) {
        const { rows } = await this.query(text, params);
        return rows;
    }

    /**
     * Run `fn` inside BEGIN/COMMIT, rolling back on throw.
     * @param {(client: import('pg').PoolClient) => Promise<any>} fn
     */
    async transaction(fn) {
        await this.connect();
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const result = await fn(client);
            await client.query('COMMIT');
            return result;
        } catch (err) {
            try {
                await client.query('ROLLBACK');
            } catch {
                /* connection already dead */
            }
            if (err instanceof DatabaseError) throw err;
            throw new DatabaseError(`Transaction failed: ${err.message}`, { cause: err });
        } finally {
            client.release();
        }
    }

    /** Simple health probe. */
    async healthCheck() {
        try {
            const row = await this.one('SELECT NOW() AS now, current_database() AS db');
            return { ok: true, now: row.now, database: row.db };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    async close() {
        if (this.pool && !this._closed) {
            this._closed = true;
            await this.pool.end();
            this.pool = null;
            this._ready = null;
        }
    }
}

module.exports = Database;
