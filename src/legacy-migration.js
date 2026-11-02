import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { getPool, initDb } from './db.js';
import { storeUpload } from './storage.js';

const migrationName = 'legacy-json-to-postgres-minio-v1';
const dataDir = path.resolve(process.env.LEGACY_DATA_DIR || 'data');

export async function migrateLegacyData(documentQueue) {
  await initDb();
  const client = await getPool().connect();
  try {
    await client.query('SELECT pg_advisory_lock(74381502)');
    const already = await client.query('SELECT 1 FROM app_migrations WHERE name=$1', [migrationName]);
    if (!already.rowCount) {
      const sessions = await readJson(path.join(dataDir, 'sessions.json'), []);
      await client.query('BEGIN');
      try {
        for (const session of sessions) {
          if (!session?.id) continue;
          const inserted = await client.query(`INSERT INTO sessions(id,title,created_at,updated_at) VALUES($1,$2,$3,$4)
            ON CONFLICT(id) DO NOTHING RETURNING id`, [session.id, session.title || '新对话', session.createdAt || new Date(), session.updatedAt || session.createdAt || new Date()]);
          if (!inserted.rowCount) continue;
          for (const message of Array.isArray(session.messages) ? session.messages : []) {
            if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') continue;
            await client.query(`INSERT INTO messages(session_id,role,content,attachments,sources,web_search,mode,created_at)
              VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`, [session.id, message.role, message.content,
              JSON.stringify(message.attachments || []), JSON.stringify(message.sources || []), Boolean(message.webSearch), message.mode || null, message.createdAt || new Date()]);
          }
        }
        await client.query('COMMIT');
      } catch (error) { await client.query('ROLLBACK'); throw error; }

      const legacyDocs = await readJson(path.join(dataDir, 'documents.json'), []);
      for (const doc of legacyDocs) {
        if (!doc?.id || typeof doc.content !== 'string') continue;
        const objectKey = `legacy/${doc.id}-${String(doc.title || 'document.txt').replace(/[^\p{L}\p{N}._-]/gu, '_')}`;
        await storeUpload(doc.title || `${doc.id}.txt`, Buffer.from(doc.content, 'utf8'), 'text/plain', objectKey);
        await client.query(`INSERT INTO documents(id,title,content,size,object_key) VALUES($1,$2,$3,$4,$5)
          ON CONFLICT(id) DO NOTHING`, [doc.id, doc.title || '历史文档', doc.content, doc.size || Buffer.byteLength(doc.content, 'utf8'), objectKey]);
      }
      await client.query('INSERT INTO app_migrations(name) VALUES($1) ON CONFLICT DO NOTHING', [migrationName]);
    }

    const { rows: pendingDocs } = await client.query("SELECT id FROM documents WHERE index_status='pending'");
    for (const doc of pendingDocs) await documentQueue.add('index-document', { documentId: doc.id }, { jobId: `document-${doc.id}` });
    console.log(`Legacy JSON migration checked; queued ${pendingDocs.length} document(s) for indexing.`);
  } finally {
    await client.query('SELECT pg_advisory_unlock(74381502)').catch(() => {});
    client.release();
  }
}

async function readJson(file, fallback) {
  try { const value = JSON.parse(await readFile(file, 'utf8')); return Array.isArray(value) ? value : fallback; }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw new Error(`无法读取旧数据 ${file}: ${error.message}`); }
}
