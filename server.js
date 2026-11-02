import './src/env.js';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { appendMessage, createSession, deleteSession, getDocumentRecord, getPool, getSession, initDb, listSessions, removeLastAssistant } from './src/db.js';
import { addDocument, deleteDocument, listDocuments } from './src/tools/knowledge.js';
import { createQueues, createRedisConnection, chatChannel } from './src/queue.js';
import { deleteUpload, storeUpload } from './src/storage.js';

const root = path.resolve('public');
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const stats = { requests: 0, errors: 0, durationMs: 0, buckets: [0, 0, 0, 0, 0, 0] };
const redis = createRedisConnection();
const subscriber = createRedisConnection();
const { chat, documents } = createQueues(redis);

export function createServer() {
  return http.createServer(async (req, res) => {
    const started = Date.now(); stats.requests++;
    res.on('finish', () => { if (res.statusCode >= 400) stats.errors++; });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Request-Id', randomUUID());
    try {
      const url = new URL(req.url, 'http://localhost');
      if (req.method === 'GET' && url.pathname === '/api/health') return await health(res);
      if (req.method === 'GET' && url.pathname === '/metrics') return await metrics(res);
      if (req.method === 'GET' && url.pathname === '/api/sessions') return json(res, 200, { sessions: await listSessions() });
      if (req.method === 'POST' && url.pathname === '/api/sessions') return json(res, 201, { session: await createSession(randomUUID()) });
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([\w-]+)$/);
      if (req.method === 'GET' && sessionMatch) { const session = await getSession(sessionMatch[1]); return session ? json(res, 200, { session }) : json(res, 404, { error: '会话不存在。' }); }
      if (req.method === 'DELETE' && sessionMatch) return json(res, 200, { ok: await deleteSession(sessionMatch[1]) });
      if (req.method === 'GET' && url.pathname === '/api/documents') return json(res, 200, { documents: await listDocuments() });
      if (req.method === 'POST' && url.pathname === '/api/documents') return await uploadDocument(req, res);
      const documentMatch = url.pathname.match(/^\/api\/documents\/([\w-]+)$/);
      if (req.method === 'DELETE' && documentMatch) return await removeDocument(documentMatch[1], res);
      if (req.method === 'POST' && url.pathname === '/api/chat') return await chatRequest(req, res);
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: '不支持的请求方式。' });
      return await serveStatic(req, res, url.pathname);
    } catch (error) {
      stats.errors++;
      if (!res.headersSent) return json(res, error.statusCode || 500, { error: error.message || '服务暂时不可用。' });
      if (!res.writableEnded) res.end();
    } finally {
      const duration = Date.now() - started; stats.durationMs += duration;
      [100, 300, 1000, 3000, 10000].forEach((bound, index) => { if (duration <= bound) stats.buckets[index]++; });
      stats.buckets[5]++;
    }
  });
}

async function uploadDocument(req, res) {
  const body = await readBody(req, 2_000_000);
  const name = decodeURIComponent(req.headers['x-file-name'] || '');
  let objectKey;
  try {
    objectKey = await storeUpload(name || 'document.txt', body, req.headers['content-type'] || 'text/plain');
    const document = await addDocument(name, body.toString('utf8'), objectKey);
    await documents.add('index-document', { documentId: document.id }, { jobId: `document-${document.id}` });
    return json(res, 202, { document, message: '文档已保存，正在后台解析并建立索引。' });
  } catch (error) { if (objectKey) await deleteUpload(objectKey).catch(() => {}); throw error; }
}

async function removeDocument(id, res) {
  const previous = await getDocumentRecord(id);
  const ok = await deleteDocument(id);
  if (ok && previous?.objectKey) await deleteUpload(previous.objectKey).catch(() => {});
  return json(res, 200, { ok });
}

async function chatRequest(req, res) {
  const clientIp = String(req.headers['x-real-ip'] || req.socket.remoteAddress || 'unknown').slice(0, 80);
  const rate = await redis.incr(`agent-qa:rate:${clientIp}`);
  if (rate === 1) await redis.expire(`agent-qa:rate:${clientIp}`, 60);
  if (rate > Number(process.env.CHAT_RATE_LIMIT_PER_MINUTE || 30)) return json(res, 429, { error: '请求过于频繁，请稍后再试。' });

  const body = JSON.parse((await readBody(req, 12_000_000)).toString('utf8') || '{}');
  const regenerating = body.regenerate === true;
  if (!regenerating && (typeof body.question !== 'string' || !body.question.trim()) && !(body.attachments || []).length) return json(res, 400, { error: '请输入你的问题。' });
  if (!regenerating && typeof body.question === 'string' && body.question.length > 2000) return json(res, 400, { error: '问题请控制在 2000 字以内。' });
  const counts = await chat.getJobCounts('waiting', 'active', 'delayed');
  if ((counts.waiting || 0) >= Number(process.env.MAX_CHAT_QUEUE || 1000)) return json(res, 503, { error: '当前问答队列已满，请稍后重试。' });

  const session = await getSession(body.sessionId);
  if (!session) return json(res, 404, { error: '会话不存在，请新建会话后重试。' });
  let question, useWebSearch, imageRefs = [], contextMessages;
  if (regenerating) {
    const last = session.messages.at(-1), user = session.messages.at(-2);
    if (last?.role !== 'assistant' || user?.role !== 'user') return json(res, 400, { error: '当前没有可重新生成的回答。' });
    await removeLastAssistant(session.id);
    question = user.content; useWebSearch = Boolean(user.webSearch);
    imageRefs = (user.attachments || []).filter(item => item.objectKey && item.type?.startsWith('image/'));
    contextMessages = session.messages.slice(0, -2);
  } else {
    question = typeof body.question === 'string' ? body.question.trim() : ''; useWebSearch = body.webSearch === true;
    const attachments = Array.isArray(body.attachments) ? body.attachments : [];
    if (attachments.length > 5) return json(res, 400, { error: '每轮最多添加 5 个附件。' });
    if (attachments.reduce((sum, file) => sum + (Number(file.size) || 0), 0) > 8 * 1024 * 1024) return json(res, 400, { error: '本轮附件合计不能超过 8 MB。' });
    const names = [];
    for (const file of attachments) {
      if (typeof file.name !== 'string' || typeof file.type !== 'string') return json(res, 400, { error: '附件信息无效。' });
      names.push({ name: file.name, type: file.type });
      if (file.type.startsWith('image/')) {
        const match = typeof file.dataUrl === 'string' && file.dataUrl.match(/^data:image\/(png|jpeg|webp|gif);base64,([\s\S]+)$/);
        if (!match) return json(res, 400, { error: '图片格式仅支持 PNG、JPEG、WEBP、GIF。' });
        const bytes = Buffer.from(match[2], 'base64');
        const objectKey = await storeUpload(file.name, bytes, file.type);
        imageRefs.push({ name: file.name, type: file.type, objectKey });
        names[names.length - 1] = { name: file.name, type: file.type, objectKey };
      } else if (!['text/plain', 'text/markdown'].includes(file.type)) return json(res, 400, { error: '附件仅支持图片、TXT 和 Markdown。' });
    }
    const textFiles = attachments.filter(file => !file.type.startsWith('image/')).map(file => `\n\n[附件：${file.name}]\n${String(file.text || '').slice(0, 100000)}`).join('');
    question += textFiles;
    if (!body.question.trim() && attachments.length) question = `请查看我附加的文件。${textFiles}`;
    await appendMessage(session.id, { role: 'user', content: question, attachments: names, webSearch: useWebSearch });
    contextMessages = session.messages;
  }

  const history = contextMessages.filter(message => ['user', 'assistant'].includes(message.role)).slice(-8).map(({ role, content }) => ({ role, content: content.slice(0, 4000) }));
  const jobId = randomUUID();
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const send = (event, data) => { if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
  const channel = chatChannel(jobId);
  const onMessage = (received, raw) => {
    if (received !== channel) return;
    let packet; try { packet = JSON.parse(raw); } catch { return; }
    send(packet.event, packet.data);
    if (['done', 'error'].includes(packet.event)) { clearInterval(heartbeat); subscriber.unsubscribe(channel).catch(() => {}); res.end(); }
  };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(': keep-alive\n\n'); }, 15000);
  subscriber.on('message', onMessage);
  await subscriber.subscribe(channel);
  res.on('close', () => { clearInterval(heartbeat); subscriber.off('message', onMessage); subscriber.unsubscribe(channel).catch(() => {}); });
  try {
    const job = await chat.add('answer', { sessionId: session.id, question, history, attachments: imageRefs, webSearch: useWebSearch }, { jobId, priority: 10 });
    const waiting = await chat.getJobCounts('waiting');
    send('status', { stage: 'queued', position: waiting.waiting || 1, jobId: job.id });
  } catch (error) { send('error', { error: error.message || '任务入队失败，请稍后重试。' }); clearInterval(heartbeat); await subscriber.unsubscribe(channel); res.end(); }
}

async function health(res) {
  const checks = {};
  try { await getPool().query('SELECT 1'); checks.postgres = 'ok'; } catch { checks.postgres = 'down'; }
  try { await redis.ping(); checks.redis = 'ok'; } catch { checks.redis = 'down'; }
  try { const response = await fetch(`${(process.env.QDRANT_URL || 'http://127.0.0.1:6333').replace(/\/$/, '')}/readyz`, { signal: AbortSignal.timeout(1500) }); checks.qdrant = response.ok ? 'ok' : 'down'; } catch { checks.qdrant = 'down'; }
  if (process.env.EMBEDDING_PROVIDER === 'ollama') {
    try { const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(1500) }); checks.ollama = response.ok ? 'ok' : 'down'; } catch { checks.ollama = 'down'; }
  }
  const ok = Object.values(checks).every(value => value === 'ok');
  return json(res, ok ? 200 : 503, { status: ok ? 'ok' : 'degraded', checks });
}

async function metrics(res) {
  const counts = await chat.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  const documentCounts = await documents.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
  const modelSlots = await redis.zcard('agent-qa:model-slots');
  const modelRequests = Number(await redis.get('agent-qa:model-requests') || 0);
  const modelErrors = Number(await redis.get('agent-qa:model-provider-errors') || 0);
  let ollamaMetrics = ['agentqa_ollama_up 0', 'agentqa_ollama_running_models 0'];
  if (process.env.EMBEDDING_PROVIDER === 'ollama') {
    try {
      const response = await fetch(`${(process.env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434').replace(/\/$/, '')}/api/ps`, { signal: AbortSignal.timeout(2000) });
      const data = await response.json(); const models = data.models || [];
      ollamaMetrics = ['agentqa_ollama_up 1', `agentqa_ollama_running_models ${models.length}`,
        '# HELP agentqa_ollama_model_size_vram_bytes VRAM bytes assigned to each running local model.', '# TYPE agentqa_ollama_model_size_vram_bytes gauge',
        ...models.map(model => `agentqa_ollama_model_size_vram_bytes{model="${promEscape(model.name)}"} ${Number(model.size_vram || 0)}`),
        '# HELP agentqa_ollama_model_size_bytes Total size in bytes of each running local model.', '# TYPE agentqa_ollama_model_size_bytes gauge',
        ...models.map(model => `agentqa_ollama_model_size_bytes{model="${promEscape(model.name)}"} ${Number(model.size || 0)}`)];
    } catch { /* keep explicit down gauges */ }
  }
  const body = [
    '# HELP agentqa_http_requests_total HTTP requests handled by this API replica.', '# TYPE agentqa_http_requests_total counter', `agentqa_http_requests_total ${stats.requests}`,
    '# HELP agentqa_http_errors_total HTTP errors returned by this API replica.', '# TYPE agentqa_http_errors_total counter', `agentqa_http_errors_total ${stats.errors}`,
    '# HELP agentqa_http_request_duration_ms_total Total server-side request duration in milliseconds.', '# TYPE agentqa_http_request_duration_ms_total counter', `agentqa_http_request_duration_ms_total ${stats.durationMs}`,
    '# HELP agentqa_http_request_duration_ms HTTP request duration buckets.', '# TYPE agentqa_http_request_duration_ms histogram',
    ...[100, 300, 1000, 3000, 10000].map((bound, index) => `agentqa_http_request_duration_ms_bucket{le="${bound}"} ${stats.buckets[index]}`),
    `agentqa_http_request_duration_ms_bucket{le="+Inf"} ${stats.buckets[5]}`, `agentqa_http_request_duration_ms_count ${stats.requests}`, `agentqa_http_request_duration_ms_sum ${stats.durationMs}`,
    '# HELP agentqa_chat_jobs Chat queue jobs by state.', '# TYPE agentqa_chat_jobs gauge', ...Object.entries(counts).map(([state, count]) => `agentqa_chat_jobs{state="${state}"} ${count}`),
    '# HELP agentqa_document_jobs Document indexing jobs by state.', '# TYPE agentqa_document_jobs gauge', ...Object.entries(documentCounts).map(([state, count]) => `agentqa_document_jobs{state="${state}"} ${count}`),
    '# HELP agentqa_model_slots_active Active distributed model call slots.', '# TYPE agentqa_model_slots_active gauge', `agentqa_model_slots_active ${modelSlots}`,
    '# HELP agentqa_model_requests_total LLM generation attempts dispatched to the provider.', '# TYPE agentqa_model_requests_total counter', `agentqa_model_requests_total ${modelRequests}`,
    '# HELP agentqa_model_provider_errors_total Model provider and rate limit errors.', '# TYPE agentqa_model_provider_errors_total counter', `agentqa_model_provider_errors_total ${modelErrors}`,
    ...ollamaMetrics,
  ].join('\n') + '\n';
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' }); res.end(body);
}

async function serveStatic(req, res, pathname) {
  const decoded = decodeURIComponent(pathname);
  const file = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const target = path.resolve(root, file);
  if (!target.startsWith(root + path.sep) && target !== path.join(root, 'index.html')) return json(res, 403, { error: '禁止访问。' });
  try { const data = await readFile(target); res.writeHead(200, { 'Content-Type': mime[path.extname(target)] || 'application/octet-stream' }); res.end(req.method === 'HEAD' ? undefined : data); }
  catch { json(res, 404, { error: '页面不存在。' }); }
}

async function readBody(req, max) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > max) { const error = new Error('请求内容过大。'); error.statusCode = 413; throw error; } chunks.push(chunk); }
  return Buffer.concat(chunks);
}
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); }
function promEscape(value) { return String(value || '').replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\n', '\\n'); }

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await initDb(); await redis.ping();
  const port = Number(process.env.PORT || 3000);
  createServer().listen(port, '0.0.0.0', () => console.log(`Agent QA API running on port ${port}`));
  const shutdown = async () => { await chat.close(); await documents.close(); await Promise.all([redis.quit(), subscriber.quit()]); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}
