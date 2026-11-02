import pg from 'pg';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const { Pool } = pg;
let pool;
let ready;

export function getPool() {
  if (!pool) pool = new Pool({
    ...(process.env.DATABASE_URL ? { connectionString: process.env.DATABASE_URL } : {
      host: process.env.PGHOST || '127.0.0.1', port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'agentqa', user: process.env.PGUSER || 'agentqa', password: process.env.PGPASSWORD || 'agentqa',
    }),
    max: Number(process.env.PG_POOL_MAX || 20),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  return pool;
}

const schema = `
      CREATE TABLE IF NOT EXISTS sessions (
        id text PRIMARY KEY, title text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS messages (
        id bigserial PRIMARY KEY, session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role text NOT NULL CHECK (role IN ('user','assistant')), content text NOT NULL,
        attachments jsonb NOT NULL DEFAULT '[]'::jsonb, sources jsonb NOT NULL DEFAULT '[]'::jsonb,
        web_search boolean NOT NULL DEFAULT false, mode text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS messages_session_id_id_idx ON messages(session_id, id);
      CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at DESC);
      CREATE TABLE IF NOT EXISTS documents (
        id text PRIMARY KEY, title text NOT NULL, content text NOT NULL, size bigint NOT NULL,
        object_key text, index_status text NOT NULL DEFAULT 'pending', index_error text,
        uploaded_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS vector_index_state (
        source_id text PRIMARY KEY, model_key text NOT NULL, indexed_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS app_migrations (
        name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now()
      );
    `;

export async function initDb() {
  if (!ready) ready = (async () => {
    // 容器编排或主机重启时，数据库往往比应用晚就绪。在启动窗口内重试建表，
    // 而不是让首个连接失败直接终止进程（否则会形成 CrashLoopBackOff）。
    const deadline = Date.now() + Number(process.env.DB_STARTUP_TIMEOUT_MS || 60_000);
    const retryDelayMs = Number(process.env.DB_STARTUP_RETRY_MS || 2_000);
    for (;;) {
      try { await getPool().query(schema); return; }
      catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      }
    }
  })().catch(error => { ready = null; throw error; });
  return ready;
}

export async function listSessions() {
  await initDb();
  const { rows } = await getPool().query('SELECT id,title,created_at AS "createdAt",updated_at AS "updatedAt" FROM sessions ORDER BY updated_at DESC');
  return rows;
}

export async function getSession(id, client = getPool()) {
  await initDb();
  const { rows } = await client.query('SELECT id,title,created_at AS "createdAt",updated_at AS "updatedAt" FROM sessions WHERE id=$1', [id]);
  if (!rows[0]) return null;
  const result = await client.query(`SELECT role,content,attachments,sources,web_search AS "webSearch",mode,created_at AS "createdAt" FROM messages WHERE session_id=$1 ORDER BY id`, [id]);
  return { ...rows[0], messages: result.rows };
}

export async function createSession(id) {
  await initDb();
  const { rows } = await getPool().query(`INSERT INTO sessions(id,title) VALUES($1,'新对话') RETURNING id,title,created_at AS "createdAt",updated_at AS "updatedAt"`, [id]);
  return { ...rows[0], messages: [] };
}

export async function deleteSession(id) {
  await initDb();
  const result = await getPool().query('DELETE FROM sessions WHERE id=$1', [id]);
  return result.rowCount > 0;
}

export async function appendMessage(sessionId, message) {
  await initDb();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT title FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    if (!rows[0]) throw new Error('会话不存在，请新建会话后重试。');
    await client.query(`INSERT INTO messages(session_id,role,content,attachments,sources,web_search,mode)
      VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`, [sessionId, message.role, message.content,
      JSON.stringify(message.attachments || []), JSON.stringify(message.sources || []), Boolean(message.webSearch), message.mode || null]);
    await client.query(`UPDATE sessions SET updated_at=now(), title=CASE WHEN title='新对话' AND $2='user' THEN left($3,36) ELSE title END WHERE id=$1`, [sessionId, message.role, message.content]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function removeLastAssistant(sessionId) {
  await initDb();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
    const { rows } = await client.query('SELECT id,role FROM messages WHERE session_id=$1 ORDER BY id DESC LIMIT 2', [sessionId]);
    if (rows[0]?.role !== 'assistant' || rows[1]?.role !== 'user') throw new Error('当前没有可重新生成的回答。');
    await client.query('DELETE FROM messages WHERE id=$1', [rows[0].id]);
    await client.query('UPDATE sessions SET updated_at=now() WHERE id=$1', [sessionId]);
    await client.query('COMMIT');
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export async function addDocumentRecord(document) {
  await initDb();
  await getPool().query('INSERT INTO documents(id,title,content,size,object_key) VALUES($1,$2,$3,$4,$5)', [document.id, document.title, document.content, document.size, document.objectKey || null]);
  return { id: document.id, title: document.title, size: document.size, indexStatus: 'pending' };
}

export async function listDocumentRecords() {
  await initDb();
  const { rows } = await getPool().query('SELECT id,title,size,index_status AS "indexStatus",index_error AS "indexError" FROM documents ORDER BY uploaded_at DESC');
  return rows;
}

export async function getDocumentRecord(id) {
  await initDb();
  const { rows } = await getPool().query('SELECT id,title,content,size,object_key AS "objectKey" FROM documents WHERE id=$1', [id]);
  return rows[0] || null;
}

export async function setDocumentIndexStatus(id, status, error = null) {
  await initDb();
  await getPool().query('UPDATE documents SET index_status=$2,index_error=$3 WHERE id=$1', [id, status, error]);
}

export async function deleteDocumentRecord(id) {
  await initDb();
  const { rows } = await getPool().query('DELETE FROM documents WHERE id=$1 RETURNING object_key AS "objectKey"', [id]);
  return rows[0] || null;
}

export async function getIndexedSources(modelKey) {
  await initDb();
  const { rows } = await getPool().query('SELECT source_id FROM vector_index_state WHERE model_key=$1', [modelKey]);
  return new Set(rows.map(row => row.source_id));
}

export async function markSourceIndexed(sourceId, modelKey) {
  await initDb();
  await getPool().query(`INSERT INTO vector_index_state(source_id,model_key) VALUES($1,$2)
    ON CONFLICT(source_id) DO UPDATE SET model_key=EXCLUDED.model_key,indexed_at=now()`, [sourceId, modelKey]);
}

export async function removeSourceIndexState(sourceId) {
  await initDb();
  await getPool().query('DELETE FROM vector_index_state WHERE source_id=$1', [sourceId]);
}

export async function closeDb() { if (pool) await pool.end(); pool = null; ready = null; }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await initDb(); await closeDb(); console.log('PostgreSQL schema is ready.');
}
