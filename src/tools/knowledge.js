import { randomUUID } from 'node:crypto';
import { addDocumentRecord, deleteDocumentRecord, getPool, initDb, listDocumentRecords } from '../db.js';
import { removeSourceFromIndex, searchVectors, vectorSearchEnabled } from './vector-store.js';

export const builtinDocuments = [
  { title: 'AI Agent 基础概念', url: 'https://en.wikipedia.org/wiki/Intelligent_agent', content: 'AI Agent 是能够感知环境、根据目标进行推理并采取行动的软件系统。常见结构包括语言模型、指令、记忆、规划能力和工具。Agent 可以调用搜索、代码执行或知识检索工具来完成任务。' },
  { title: '检索增强生成（RAG）', url: 'https://en.wikipedia.org/wiki/Retrieval-augmented_generation', content: '检索增强生成（RAG）在生成回答前从外部知识库检索相关内容，并将检索结果作为上下文提供给语言模型。这有助于回答依据可更新资料、降低幻觉，并通过引用展示信息来源。典型流程包括文档切分、向量化、检索、重排和生成。' },
  { title: 'Agent 工具调用', url: 'https://platform.openai.com/docs/guides/function-calling', content: '工具调用让模型能够请求应用执行结构化操作，例如搜索资料或查询数据库。应用收到工具调用后执行对应函数，再把工具结果交回模型，由模型生成最终回答。工具应有清晰的输入参数和可处理的错误结果。' },
  { title: '构建可靠问答系统', url: 'https://en.wikipedia.org/wiki/Question_answering', content: '问答系统应根据用户问题检索信息并生成直接、可理解的回答。可靠的系统应展示信息来源、识别不确定性、验证输入，并妥善处理知识缺失和服务错误。' },
].map((doc, i) => ({ ...doc, id: `builtin-${i}` }));

export async function listDocuments() { return listDocumentRecords(); }
export async function addDocument(filename, content, objectKey) {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (!['.txt', '.md'].includes(ext)) throw new Error('目前支持 .txt 和 .md 文档。');
  const title = filename.split(/[\\/]/).at(-1).replace(/[<>:"/\\|?*]/g, '_').slice(0, 120);
  const text = content.replace(/\u0000/g, '').trim();
  if (!text) throw new Error('文档内容为空或无法读取。');
  if (text.length > 1_000_000) throw new Error('文档文本不能超过 1 MB。');
  return addDocumentRecord({ id: randomUUID(), title, content: text, size: Buffer.byteLength(text, 'utf8'), objectKey });
}
export async function deleteDocument(id) {
  const deleted = await deleteDocumentRecord(id);
  if (!deleted) return false;
  await removeSourceFromIndex(id);
  return true;
}

export async function retrieve(query, { limit = 3 } = {}) {
  if (process.env.RETRIEVAL_FAIL === '1') throw new Error('知识检索工具暂时不可用，请稍后重试。');
  await initDb();
  const { rows } = await getPool().query("SELECT id,title,content FROM documents WHERE index_status='indexed' ORDER BY uploaded_at DESC");
  const allDocuments = [...builtinDocuments, ...rows.map(doc => ({ ...doc, url: null }))];
  if (vectorSearchEnabled()) return searchVectors(query, allDocuments, chunkText, limit);
  const terms = [...new Set(tokenize(query))]; if (!terms.length) return [];
  const candidates = allDocuments.flatMap(doc => chunkText(doc.content).map(content => {
    const docTerms = new Set(tokenize(`${doc.title} ${content}`));
    const overlap = terms.reduce((sum, term) => sum + (docTerms.has(term) ? 1 : 0), 0);
    const titleMatches = terms.reduce((sum, term) => sum + (tokenize(doc.title).includes(term) ? 1 : 0), 0);
    return { title: doc.title, url: doc.url, content, score: overlap / Math.sqrt(terms.length) + titleMatches * 0.8 };
  }));
  const seen = new Set();
  return candidates.sort((a, b) => b.score - a.score).filter(doc => {
    if (doc.score < 0.45) return false;
    const key = `${doc.title}:${doc.url || ''}`; if (seen.has(key)) return false; seen.add(key); return true;
  }).slice(0, limit).map(({ title, url, content }) => ({ title, url, content }));
}
function tokenize(text) {
  const normalized = text.toLowerCase(); const terms = normalized.match(/[a-z0-9]+(?:[._+-][a-z0-9]+)*/g) || [];
  const chineseRuns = normalized.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of chineseRuns) { for (let i = 0; i < run.length - 1; i++) terms.push(run.slice(i, i + 2)); if (run.length === 1) terms.push(run); }
  return terms.filter(term => !['什么','怎么','如何','请问','可以','一个','这个','以及','是否'].includes(term));
}
export function chunkText(text, size = 1000, overlap = 120) {
  const clean = String(text || '').trim(); if (clean.length <= size) return clean ? [clean] : [];
  const chunks = []; let start = 0;
  while (start < clean.length) { let end = Math.min(start + size, clean.length); if (end < clean.length) { const boundary = clean.lastIndexOf('\n', end); if (boundary > start + size * 0.65) end = boundary; } chunks.push(clean.slice(start, end).trim()); if (end === clean.length) break; start = Math.max(start + 1, end - overlap); }
  return chunks;
}
