import './src/env.js';
import { Worker } from 'bullmq';
import { initDb, closeDb, appendMessage, getDocumentRecord, setDocumentIndexStatus } from './src/db.js';
import { createRedisConnection, publishEvent, acquireModelSlot, createQueues } from './src/queue.js';
import { streamAnswer } from './src/agent.js';
import { builtinDocuments, chunkText } from './src/tools/knowledge.js';
import { indexSource } from './src/tools/vector-store.js';
import { readUpload } from './src/storage.js';
import { migrateLegacyData } from './src/legacy-migration.js';

await initDb();
const redis = createRedisConnection();
const { documents } = createQueues(redis);
await migrateLegacyData(documents);
const chatConnection = createRedisConnection();
const documentConnection = createRedisConnection();

const chatWorker = new Worker('agent-qa-chat', async job => {
  if (job.attemptsMade > 0) await publishEvent(redis, job.id, 'reset', { message: '服务正在重试…' });
  const controller = new AbortController();
  const attachments = [];
  for (const item of job.data.attachments || []) {
    const bytes = await readUpload(item.objectKey);
    attachments.push({ name: item.name, dataUrl: `data:${item.type};base64,${bytes.toString('base64')}` });
  }
  let answer = '', meta = {}, releaseSlot;
  try {
    for await (const event of streamAnswer(job.data.question, job.data.history, controller.signal, attachments, job.data.webSearch)) {
      if (event.type === 'status') {
        if (event.stage === 'generating' && process.env.LLM_API_KEY) {
          await publishEvent(redis, job.id, 'status', { stage: 'queued', queue: true });
          releaseSlot = await acquireModelSlot(redis, job.id, controller.signal);
        }
        await publishEvent(redis, job.id, 'status', event);
      } else if (event.type === 'delta') {
        answer += event.text;
        await publishEvent(redis, job.id, 'delta', { text: event.text });
      } else meta = event;
    }
    await appendMessage(job.data.sessionId, { role: 'assistant', content: answer, sources: meta.sources || [], mode: meta.mode });
    await publishEvent(redis, job.id, 'done', { ...meta, answer });
    return { ok: true };
  } finally { if (releaseSlot) await releaseSlot(); }
}, { connection: chatConnection, concurrency: Number(process.env.CHAT_WORKER_CONCURRENCY || 16) });

const documentWorker = new Worker('agent-qa-documents', async job => {
  if (job.name === 'index-builtin') { await indexSource(job.data.document, chunkText); return; }
  if (job.name !== 'index-document') return;
  await setDocumentIndexStatus(job.data.documentId, 'indexing');
  const doc = await getDocumentRecord(job.data.documentId);
  if (!doc) return;
  await indexSource({ ...doc, url: null }, chunkText);
  await setDocumentIndexStatus(doc.id, 'indexed');
}, { connection: documentConnection, concurrency: Number(process.env.DOCUMENT_WORKER_CONCURRENCY || 2) });

chatWorker.on('failed', (job, error) => {
  if (!job) return;
  if (job.attemptsMade >= (job.opts.attempts || 1)) publishEvent(redis, job.id, 'error', { error: error.message || '问答任务失败，请稍后重试。' }).catch(() => {});
});
documentWorker.on('failed', (job, error) => {
  if (job?.data?.documentId && job.attemptsMade >= (job.opts.attempts || 1)) setDocumentIndexStatus(job.data.documentId, 'failed', error.message).catch(() => {});
});

for (const doc of builtinDocuments) documents.add('index-builtin', { document: doc }, { jobId: `builtin-${doc.id}` }).catch(() => {});
console.log(`Agent QA workers ready (chat concurrency ${process.env.MODEL_CONCURRENCY || 8}; document concurrency ${process.env.DOCUMENT_WORKER_CONCURRENCY || 2}).`);

async function shutdown() {
  await Promise.all([chatWorker.close(), documentWorker.close(), documents.close()]);
  await Promise.all([redis.quit(), chatConnection.quit(), documentConnection.quit()]);
  await closeDb(); process.exit(0);
}
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
