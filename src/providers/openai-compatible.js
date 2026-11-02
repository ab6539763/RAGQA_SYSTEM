export async function chatCompletion(messages) {
  const base = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const key = process.env.LLM_API_KEY;
  if (!base || !key) throw new Error('在线模型尚未完整配置，请设置 LLM_BASE_URL 和 LLM_API_KEY。');
  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL || 'deepseek-flash', messages, temperature: 0.3 }), signal: AbortSignal.timeout(30_000)
  });
  if (!response.ok) throw new Error(await providerError(response));
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== 'string' || !content.trim()) throw new Error('模型没有返回有效回答，请稍后重试。');
  return content.trim();
}

export async function* streamChatCompletion(messages, signal) {
  const base = process.env.LLM_BASE_URL || 'https://api.deepseek.com';
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error('在线模型尚未配置 API Key。');
  const response = await fetch(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: process.env.LLM_MODEL || 'deepseek-flash', messages, temperature: 0.3, stream: true }),
    signal: signal || AbortSignal.timeout(60_000)
  });
  if (!response.ok) throw new Error(await providerError(response));
  const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read(); if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/); buffer = events.pop() || '';
      for (const event of events) for (const line of event.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim(); if (data === '[DONE]') return;
        let parsed; try { parsed = JSON.parse(data); } catch { continue; }
        const text = parsed.choices?.[0]?.delta?.content; if (typeof text === 'string' && text) yield text;
      }
    }
  } finally { reader.releaseLock(); }
}

async function providerError(response) {
  let detail = '';
  try { const body = await response.json(); detail = body.error?.message || body.message || ''; }
  catch { detail = (await response.text().catch(() => '')).slice(0, 300); }
  return detail ? `模型服务错误（${response.status}）：${detail}` : `模型服务返回错误（${response.status}），请检查模型配置后重试。`;
}
