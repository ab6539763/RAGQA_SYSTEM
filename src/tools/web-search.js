export async function searchWeb(question) {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error('联网搜索需要配置 DeepSeek LLM_API_KEY。');
  const query = [...question.trim()].slice(0, 128).join('');
  const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const response = await fetch(`${base}/v1/tools/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query, ori_question: query, count: 5, need_content: true }), signal: AbortSignal.timeout(45_000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`联网搜索失败（${response.status}）：${data.error?.message || '请稍后重试。'}`);
  return (data.results || []).filter(item => item.title && /^https?:\/\//i.test(item.url || '')).slice(0, 5).map(item => ({
    title: item.title, url: item.url, snippet: item.snippet || '', summary: item.summary || '', content: (item.content || '').slice(0, 6000), date: item.date || null, score: item.rerank_score ?? null
  }));
}
