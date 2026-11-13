/*
 * Vercel の Postgres（Vercel Marketplace の Neon）への接続。
 * Vercel で Storage を接続すると DATABASE_URL（または POSTGRES_URL）が自動で設定される。
 * テーブル（sites: Making Site / decks: スライド）は最初のリクエストで自動作成する。
 */
const { Pool } = require('pg');

let pool = null;
let ready = null;

function getPool() {
  if (!pool) {
    const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
    if (!connectionString) {
      throw Object.assign(new Error('サーバーの設定が不足しています（DATABASE_URL）。'), { status: 500 });
    }
    pool = new Pool({ connectionString, max: 3 });
  }
  return pool;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sites (
    id          text PRIMARY KEY,
    uid         text NOT NULL,
    title       text NOT NULL DEFAULT '',
    html        text,
    state       jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS sites_uid_created_idx ON sites (uid, created_at DESC);

  CREATE TABLE IF NOT EXISTS decks (
    uid         text NOT NULL,
    id          text NOT NULL,
    title       text NOT NULL DEFAULT '',
    data        jsonb NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (uid, id)
  );
`;

async function query(text, params) {
  const p = getPool();
  if (!ready) ready = p.query(SCHEMA).catch((e) => { ready = null; throw e; });
  await ready;
  return p.query(text, params);
}

module.exports = { query };
