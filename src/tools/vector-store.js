import { createHash } from 'node:crypto';
import { getIndexedSources, markSourceIndexed, removeSourceIndexState } from '../db.js';

const collection = process.env.QDRANT_COLLECTION || 'agent_qa_knowledge';
let collectionReady;

export function vectorSearchEnabled() {
  return process.env.EMBEDDING_PROVIDER === 'ollama'
    ? Boolean(process.env.OLLAMA_BASE_URL && process.env.EMBEDDING_MODEL && process.env.QDRANT_URL)
    : Boolean(process.env.EMBEDDING_BASE_URL && process.env.EMBEDDING_API_KEY && process.env.EMBEDDING_MODEL && process.env.QDRANT_URL);
}

const modelKey = () => `${process.env.EMBEDDING_PROVIDER}|${process.env.OLLAMA_BASE_URL || process.env.EMBEDDING_BASE_URL}|${process.env.EMBEDDING_MODEL}`;

export async function indexSource(source, chunkText) {
  if (!vectorSearchEnabled()) return;
  const key = modelKey();
  const indexed = await getIndexedSources(key);
  if (indexed.has(source.id)) return;
  await ensureCollection();
  const chunks = chunkText(source.content);
  if (chunks.length) {
    // Replays are safe: deterministic point IDs prevent duplicate vectors after worker retries.
    const old = await qdrantRaw(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
      method: 'POST', body: JSON.stringify({ filter: { must: [{ key: 'sourceId', match: { value: source.id } }] } }),
    });
    if (!old.ok && old.status !== 404) throw await qdrantError(old);
    for (let offset = 0; offset < chunks.length; offset += 32) {
      const batch = chunks.slice(offset, offset + 32);
      const vectors = await embed(batch, 'document');
      if (vectors.length !== batch.length) throw new Error('Embedding 服务返回的向量数量不匹配。');
      const points = batch.map((content, index) => ({
        id: stableUuid(`${source.id}:${offset + index}`), vector: vectors[index],
        payload: { sourceId: source.id, title: source.title, url: source.url || null, content },
      }));
      await qdrant(`/collections/${encodeURIComponent(collection)}/points?wait=true`, { method: 'PUT', body: JSON.stringify({ points }) });
    }
  }
  await markSourceIndexed(source.id, key);
}

export async function removeSourceFromIndex(sourceId) {
  await removeSourceIndexState(sourceId);
  if (!process.env.QDRANT_URL) return;
  const response = await qdrantRaw(`/collections/${encodeURIComponent(collection)}/points/delete?wait=true`, {
    method: 'POST', body: JSON.stringify({ filter: { must: [{ key: 'sourceId', match: { value: sourceId } }] } }),
  });
  if (!response.ok && response.status !== 404) throw await qdrantError(response);
}

export async function searchVectors(query, sources, chunkText, limit = 3) {
  const indexed = await getIndexedSources(modelKey());
  const [vector] = await embed([query], 'query');
  const result = await qdrant(`/collections/${encodeURIComponent(collection)}/points/search`, { method: 'POST', body: JSON.stringify({ vector, limit: Math.max(limit * 3, limit), with_payload: true }) });
  const active = new Set(sources.filter(source => indexed.has(source.id)).map(source => source.id));
  const seen = new Set();
  return (result.result || []).filter(point => point.payload && active.has(point.payload.sourceId) && !seen.has(point.payload.sourceId) && seen.add(point.payload.sourceId))
    .map(point => ({ title: point.payload.title, url: point.payload.url || null, content: point.payload.content, score: point.score }))
    .slice(0, limit);
}

async function embed(input, kind) {
  if (process.env.EMBEDDING_PROVIDER === 'ollama') {
    const base = process.env.OLLAMA_BASE_URL.replace(/\/$/, '');
    const prefix = process.env.EMBEDDING_MODEL.toLowerCase().includes('nomic-embed') ? (kind === 'query' ? 'search_query: ' : 'search_document: ') : '';
    const response = await fetch(`${base}/api/embed`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, input: input.map(text => `${prefix}${text}`) }), signal: AbortSignal.timeout(90_000) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`本地 Ollama Embeddings 错误（${response.status}）：${data.error || '请确认 Ollama 正在运行且模型已下载。'}`);
    if (!Array.isArray(data.embeddings)) throw new Error('Ollama 没有返回有效向量。');
    return data.embeddings;
  }
  const base = process.env.EMBEDDING_BASE_URL.replace(/\/$/, '');
  const response = await fetch(`${base}/embeddings`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.EMBEDDING_API_KEY}` }, body: JSON.stringify({ model: process.env.EMBEDDING_MODEL, input }), signal: AbortSignal.timeout(45_000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Embedding 服务错误（${response.status}）：${data.error?.message || '请检查 Embedding 配置。'}`);
  const items = (data.data || []).sort((a, b) => a.index - b.index);
  if (!items.length || items.some(item => !Array.isArray(item.embedding))) throw new Error('Embedding 服务没有返回有效向量。');
  return items.map(item => item.embedding);
}

async function ensureCollection() {
  if (collectionReady) return collectionReady;
  collectionReady = (async () => {
    const name = encodeURIComponent(collection);
    const response = await qdrantRaw(`/collections/${name}`, { method: 'GET' });
    if (response.status === 404) {
      const [sample] = await embed(['vector dimension probe'], 'query');
      await qdrant(`/collections/${name}`, { method: 'PUT', body: JSON.stringify({ vectors: { size: sample.length, distance: 'Cosine' } }) });
    } else if (!response.ok) throw await qdrantError(response);
  })().catch(error => { collectionReady = null; throw error; });
  return collectionReady;
}

async function qdrant(route, options) { const response = await qdrantRaw(route, options); if (!response.ok) throw await qdrantError(response); return response.json(); }
async function qdrantRaw(route, options) {
  const base = process.env.QDRANT_URL.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (process.env.QDRANT_API_KEY) headers['api-key'] = process.env.QDRANT_API_KEY;
  return fetch(`${base}${route}`, { ...options, headers: { ...headers, ...options.headers }, signal: AbortSignal.timeout(30_000) });
}
async function qdrantError(response) { const data = await response.json().catch(() => ({})); return new Error(`Qdrant 错误（${response.status}）：${data.status?.error || data.result?.error || '请检查 QDRANT_URL 与服务状态。'}`); }
function stableUuid(value) {
  const bytes = createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex'); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}
