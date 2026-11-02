const conversation = document.querySelector('#conversation');
const welcome = document.querySelector('#welcome');
const messages = document.querySelector('#messages');
const form = document.querySelector('#chat-form');
const input = document.querySelector('#question');
const send = document.querySelector('#send');
const count = document.querySelector('#char-count');
const history = [];
let sessions = [];
let activeSessionId = null;
let chatAttachments = [];
let webSearchEnabled = false;

async function refreshSessions() {
  const result = await fetch('/api/sessions').then(r => r.json()); sessions = result.sessions || [];
  const list = document.querySelector('#session-list'); list.replaceChildren();
  for (const session of sessions) {
    const row = document.createElement('div'); row.className = `session-row${session.id === activeSessionId ? ' active' : ''}`;
    const button = document.createElement('button'); button.className = 'session-item'; button.textContent = session.title; button.title = session.title; button.addEventListener('click', () => openSession(session.id));
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'delete-session'; remove.textContent = '×'; remove.title = '删除会话'; remove.setAttribute('aria-label', `删除会话：${session.title}`);
    remove.addEventListener('click', async event => {
      event.stopPropagation(); if (!confirm(`删除会话“${session.title}”？此操作不可撤销。`)) return;
      const response = await fetch(`/api/sessions/${session.id}`, { method: 'DELETE' });
      if (!response.ok) { alert('删除失败，请重试。'); return; }
      if (activeSessionId === session.id) {
        activeSessionId = null; history.splice(0, history.length); messages.replaceChildren();
        const remaining = sessions.filter(item => item.id !== session.id); sessions = remaining;
        if (remaining.length) await openSession(remaining[0].id);
        else { welcome.hidden = false; await refreshSessions(); }
      } else await refreshSessions();
    });
    row.append(button, remove); list.append(row);
  }
}
async function openSession(id) {
  if (!sessions.some(item => item.id === id)) return;
  const response = await fetch(`/api/sessions/${id}`); if (!response.ok) return;
  const { session } = await response.json();
  activeSessionId = id; history.splice(0, history.length); messages.replaceChildren(); welcome.hidden = session.messages.length > 0;
  for (const msg of session.messages) { history.push({ role: msg.role, content: msg.content }); addMessage(msg.role, msg.content, { sources: msg.sources }); }
  await refreshSessions(); scrollBottom();
}
async function ensureSession() {
  if (activeSessionId) return;
  const response = await fetch('/api/sessions', { method: 'POST' }); const data = await response.json();
  activeSessionId = data.session.id; sessions.unshift(data.session); await refreshSessions();
}
refreshSessions().then(() => { activeSessionId = null; history.splice(0, history.length); messages.replaceChildren(); welcome.hidden = false; }).catch(() => {});
async function refreshDocuments() {
  const { documents = [] } = await fetch('/api/documents').then(r => r.json()); const list = document.querySelector('#document-list'); list.replaceChildren();
  for (const doc of documents) { const row = document.createElement('div'); row.className = 'document-item'; const name = document.createElement('span'); name.textContent = doc.title; name.title = doc.title; const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '删除文档'; remove.setAttribute('aria-label', `删除 ${doc.title}`); remove.addEventListener('click', async () => { await fetch(`/api/documents/${doc.id}`, { method: 'DELETE' }); refreshDocuments(); }); row.append(name, remove); list.append(row); }
}
function renderAttachments() {
  const list = document.querySelector('#attachment-list'); list.replaceChildren();
  chatAttachments.forEach((file, index) => { const chip = document.createElement('span'); chip.className = 'attachment-chip'; chip.textContent = `${file.type.startsWith('image/') ? '▧' : '▤'} ${file.name}`; const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `移除 ${file.name}`); remove.onclick = () => { chatAttachments.splice(index, 1); renderAttachments(); }; chip.append(remove); list.append(chip); });
}
document.querySelector('#attach-file').addEventListener('click', () => document.querySelector('#chat-files').click());
document.querySelector('#web-search-toggle').addEventListener('click', event => {
  webSearchEnabled = !webSearchEnabled; const button = event.currentTarget;
  button.classList.toggle('enabled', webSearchEnabled); button.setAttribute('aria-pressed', String(webSearchEnabled));
});
document.querySelector('#chat-files').addEventListener('change', async event => {
  const files = [...event.target.files];
  if (chatAttachments.length + files.length > 5) { alert('每轮最多添加 5 个附件。'); event.target.value = ''; return; }
  try {
    for (const file of files) {
      if (file.size > 5 * 1024 * 1024) throw new Error(`${file.name} 超过 5 MB。`);
      if (file.type.startsWith('image/')) {
        if (chatAttachments.reduce((sum, item) => sum + item.size, 0) + file.size > 8 * 1024 * 1024) throw new Error('本轮附件合计不能超过 8 MB。');
        const image = await createImageBitmap(file);
        const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
        canvas.getContext('2d').drawImage(image, 0, 0); image.close();
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        if (!blob) throw new Error(`${file.name} 无法转换为 PNG 图片。`);
        if (blob.size > 5 * 1024 * 1024) throw new Error(`${file.name} 转换后超过 5 MB，请缩小图片后重试。`);
        if (chatAttachments.reduce((sum, item) => sum + item.size, 0) + blob.size > 8 * 1024 * 1024) throw new Error('转换后的附件合计超过 8 MB。');
        const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
        chatAttachments.push({ name: file.name, type: 'image/png', size: blob.size, dataUrl });
      }
      else if (['.txt', '.md'].includes(file.name.slice(file.name.lastIndexOf('.')).toLowerCase())) chatAttachments.push({ name: file.name, type: file.name.toLowerCase().endsWith('.md') ? 'text/markdown' : 'text/plain', size: file.size, text: (await file.text()).slice(0, 100000) });
      else throw new Error('支持图片、TXT 和 Markdown 文件。');
    }
    renderAttachments();
  } catch (error) { alert(error.message); }
  event.target.value = '';
});
refreshDocuments().catch(() => {});
const docUploadButton = document.querySelector('#upload-doc');
const docFileInput = document.querySelector('#doc-file');
const docUploadStatus = document.querySelector('#doc-upload-status');
docUploadButton.addEventListener('click', () => docFileInput.click());
function uploadKnowledgeFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', '/api/documents');
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(Math.round(event.loaded / event.total * 100));
    });
    request.addEventListener('load', () => {
      let result = {};
      try { result = JSON.parse(request.responseText); } catch {}
      if (request.status >= 200 && request.status < 300) resolve(result);
      else reject(new Error(result.error || `上传失败（${request.status}）`));
    });
    request.addEventListener('error', () => reject(new Error('网络错误，请检查连接后重试。')));
    request.addEventListener('abort', () => reject(new Error('上传已取消。')));
    request.send(file);
  });
}
docFileInput.addEventListener('change', async event => {
  const files = [...event.target.files]; if (!files.length) return;
  const rows = [];
  docUploadStatus.replaceChildren();
  for (const file of files) {
    const row = document.createElement('div'); row.className = 'doc-upload-item';
    const name = document.createElement('span'); name.className = 'doc-upload-name'; name.textContent = file.name; name.title = file.name;
    const progress = document.createElement('progress'); progress.max = 100; progress.value = 0; progress.setAttribute('aria-label', `上传进度：${file.name}`);
    const detail = document.createElement('small'); detail.textContent = '等待上传';
    row.append(name, progress, detail); docUploadStatus.append(row);
    rows.push({ file, row, progress, detail });
  }

  docUploadButton.disabled = true;
  let next = 0, completed = 0, succeeded = 0;
  docUploadButton.textContent = `上传中 0/${files.length}`;
  const uploadNext = async () => {
    while (next < rows.length) {
      const item = rows[next++]; const { file, row, progress, detail } = item;
      const extension = file.name.toLowerCase().slice(file.name.lastIndexOf('.'));
      if (!['.txt', '.md'].includes(extension)) {
        row.classList.add('failed'); detail.textContent = '失败：仅支持 TXT 和 Markdown 文件'; completed++; continue;
      }
      if (file.size > 1024 * 1024) {
        row.classList.add('failed'); detail.textContent = '失败：单文件不能超过 1 MB'; completed++; continue;
      }
      row.classList.add('uploading'); detail.textContent = '上传中 0%';
      try {
        await uploadKnowledgeFile(file, percent => { progress.value = percent; detail.textContent = `上传中 ${percent}%`; });
        row.classList.remove('uploading'); row.classList.add('uploaded'); progress.value = 100; detail.textContent = '已上传，后台正在建立索引'; succeeded++;
      } catch (error) {
        row.classList.remove('uploading'); row.classList.add('failed'); detail.textContent = `失败：${error.message}`;
      }
      completed++; docUploadButton.textContent = `上传中 ${completed}/${files.length}`;
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.min(3, rows.length) }, () => uploadNext()));
    await refreshDocuments();
    docUploadButton.textContent = succeeded ? `完成 ${succeeded}/${files.length}` : '上传失败';
  } catch { docUploadButton.textContent = '刷新文档失败'; }
  finally {
    docFileInput.value = ''; docUploadButton.disabled = false;
    setTimeout(() => { docUploadButton.textContent = '＋ 批量上传'; }, 2200);
  }
});

function addMessage(role, content, extra = {}) {
  const article = document.createElement('article'); article.className = `message ${role}`;
  const icon = document.createElement('span'); icon.className = 'role-icon'; icon.textContent = role === 'user' ? '我' : '知';
  const wrap = document.createElement('div'); wrap.className = 'message-content';
  const meta = document.createElement('div'); meta.className = 'message-meta'; meta.textContent = role === 'user' ? '你' : '寻知 · AI 助手';
  const bubble = document.createElement('div'); bubble.className = `bubble${role === 'assistant' ? ' markdown-body' : ''}`;
  if (role === 'assistant') bubble.append(renderMarkdown(content, extra.sources || [])); else bubble.textContent = content;
  wrap.append(meta, bubble);
  if (extra.sources?.length) {
    const section = document.createElement('div'); section.className = 'sources';
    const label = document.createElement('div'); label.className = 'sources-label'; label.textContent = '参考来源'; section.append(label);
    extra.sources.forEach((source, index) => { const link = document.createElement('a'); link.className = 'source-link'; link.id = `source-${index + 1}`; link.textContent = `[${index + 1}] ${source.title}`; link.href = source.url || '#'; if (/^https?:/.test(source.url || '')) { link.target = '_blank'; link.rel = 'noopener noreferrer'; } section.append(link); });
    wrap.append(section);
  }
  if (extra.notice) { const notice = document.createElement('div'); notice.className = 'answer-notice'; notice.textContent = extra.notice; wrap.append(notice); }
  if (role === 'assistant' && content) {
    const actions = document.createElement('div'); actions.className = 'answer-actions';
    const copy = document.createElement('button'); copy.type = 'button'; copy.className = 'copy-answer'; copy.textContent = '▢ 复制回答'; copy.setAttribute('aria-label', '复制回答');
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(content); copy.textContent = '✓ 已复制'; }
      catch { copy.textContent = '复制失败'; }
      copy.classList.add('copy-feedback'); setTimeout(() => { copy.textContent = '▢ 复制回答'; copy.classList.remove('copy-feedback'); }, 1600);
    });
    actions.append(copy); wrap.append(actions);
    const regenerate = document.createElement('button'); regenerate.type = 'button'; regenerate.className = 'copy-answer regenerate-answer'; regenerate.textContent = '↻ 重新生成'; regenerate.setAttribute('aria-label', '重新生成回答');
    regenerate.addEventListener('click', async () => {
      regenerate.disabled = true; regenerate.textContent = '正在生成…';
      try {
        const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: activeSessionId, regenerate: true }) });
        const bubble = article.querySelector('.bubble'); let streamed = '';
        const data = await readEventStream(response, (text, status) => { if (status) { if (status.stage === 'reset') { streamed = ''; bubble.textContent = '服务短暂波动，正在自动重试…'; } else if (status.stage === 'queued') bubble.textContent = '请求已进入队列，正在等待模型资源…'; else bubble.textContent = status.stage === 'retrieving' ? '正在检索知识库…' : status.stage === 'websearch' ? '正在搜索互联网…' : `已检索到 ${status.retrieved} 条知识库内容${status.webResults ? `和 ${status.webResults} 条网页` : ''}，正在组织回答…`; } else { streamed += text; bubble.replaceChildren(renderMarkdown(streamed)); scrollBottom(); } });
        const index = history.findLastIndex(item => item.role === 'assistant'); if (index >= 0) history[index].content = data.answer;
        const replacement = addMessage('assistant', data.answer, { sources: data.sources }); replacement.querySelector('.message-meta').textContent = `寻知 · ${data.mode === 'online' ? '在线模型' : '演示模式'} · ${(data.elapsedMs / 1000).toFixed(1)} 秒`;
        article.replaceWith(replacement); await refreshSessions(); scrollBottom();
      } catch (error) { regenerate.disabled = false; regenerate.textContent = '↻ 重新生成'; regenerate.title = error.message; }
    });
    actions.append(regenerate);
  }
  article.append(icon, wrap); messages.append(article); return article;
}

// Small safe Markdown renderer for common LLM output. Text is always inserted as text nodes.
function renderMarkdown(markdown, sources = []) {
  const fragment = document.createDocumentFragment();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  let paragraph = [], list = null, code = null;
  const flushParagraph = () => { if (!paragraph.length) return; const p = document.createElement('p'); p.append(inlineMarkdown(paragraph.join(' '), sources)); fragment.append(p); paragraph = []; };
  const flushList = () => { if (list) { fragment.append(list); list = null; } };
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const line = lines[lineIndex];
    if (line.includes('|') && lineIndex + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[lineIndex + 1])) {
      flushParagraph(); flushList();
      const table = document.createElement('table'), thead = document.createElement('thead'), tbody = document.createElement('tbody');
      const header = document.createElement('tr');
      for (const cell of tableCells(line)) { const th = document.createElement('th'); th.append(inlineMarkdown(cell, sources)); header.append(th); }
      thead.append(header); lineIndex += 2;
      while (lineIndex < lines.length && lines[lineIndex].includes('|') && lines[lineIndex].trim()) {
        const row = document.createElement('tr');
        for (const cell of tableCells(lines[lineIndex])) { const td = document.createElement('td'); td.append(inlineMarkdown(cell, sources)); row.append(td); }
        tbody.append(row); lineIndex++;
      }
      table.append(thead, tbody); const scroller = document.createElement('div'); scroller.className = 'table-scroll'; scroller.append(table); fragment.append(scroller); lineIndex--; continue;
    }
    const displayMath = line.trim().match(/^\\\[([\s\S]*)\\\]$/);
    if (displayMath) { flushParagraph(); flushList(); fragment.append(renderMath(displayMath[1], true)); continue; }
    const fence = line.match(/^\s*```\s*([\w+-]*)/);
    if (fence) { flushParagraph(); flushList(); if (code) { const pre = document.createElement('pre'), node = document.createElement('code'); if (code.lang) node.className = `language-${code.lang}`; node.textContent = code.lines.join('\n'); pre.append(node); fragment.append(pre); code = null; } else code = { lang: fence[1], lines: [] }; continue; }
    if (code) { code.lines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) { flushParagraph(); flushList(); const h = document.createElement(`h${heading[1].length}`); h.append(inlineMarkdown(heading[2], sources)); fragment.append(h); continue; }
    if (/^\s*(---+|___+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); flushList(); fragment.append(document.createElement('hr')); continue; }
    const item = line.match(/^\s*(?:[-+*]|\d+[.)])\s+(.+)$/);
    if (item) { flushParagraph(); const ordered = /^\s*\d/.test(line); if (!list || list.tagName === (ordered ? 'OL' : 'UL')) { if (!list) list = document.createElement(ordered ? 'ol' : 'ul'); } else { flushList(); list = document.createElement(ordered ? 'ol' : 'ul'); } const li = document.createElement('li'); li.append(inlineMarkdown(item[1], sources)); list.append(li); continue; }
    flushList(); const quote = line.match(/^\s*>\s?(.*)$/); if (quote) { flushParagraph(); const q = document.createElement('blockquote'); q.append(inlineMarkdown(quote[1], sources)); fragment.append(q); continue; }
    paragraph.push(line.trim());
  }
  if (code) { const pre = document.createElement('pre'), node = document.createElement('code'); node.textContent = code.lines.join('\n'); pre.append(node); fragment.append(pre); }
  flushParagraph(); flushList(); return fragment;
}
function tableCells(line) { return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim()); }
function inlineMarkdown(text, sources = []) {
  const fragment = document.createDocumentFragment();
  const pattern = /(`[^`]+`|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$\$[\s\S]+?\$\$|\$[^$\n]+\$|\[\d+\]|\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|(?<!\*)\*[^*]+\*|(?<!_)_[^_]+_|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > cursor) fragment.append(document.createTextNode(text.slice(cursor, match.index)));
    const value = match[0]; let node;
    if (/^\[\d+\]$/.test(value)) { const index = Number(value.slice(1, -1)); if (index <= sources.length) { node = document.createElement('a'); node.className = 'inline-citation'; node.href = `#source-${index}`; node.textContent = value; } else node = document.createTextNode(value); }
    else if (value.startsWith('\\[')) node = renderMath(value.slice(2, -2), true);
    else if (value.startsWith('\\(')) node = renderMath(value.slice(2, -2), false);
    else if (value.startsWith('$$')) node = renderMath(value.slice(2, -2), true);
    else if (value.startsWith('$')) node = renderMath(value.slice(1, -1), false);
    else if (value.startsWith('`')) { node = document.createElement('code'); node.textContent = value.slice(1, -1); }
    else if (value.startsWith('**') || value.startsWith('__')) { node = document.createElement('strong'); node.textContent = value.slice(2, -2); }
    else if (value.startsWith('~~')) { node = document.createElement('del'); node.textContent = value.slice(2, -2); }
    else if (value.startsWith('*') || value.startsWith('_')) { node = document.createElement('em'); node.textContent = value.slice(1, -1); }
    else { const link = value.match(/^\[([^\]]+)\]\(([^)]+)\)$/), url = safeUrl(link[2]); if (url) { node = document.createElement('a'); node.textContent = link[1]; node.href = url; node.target = '_blank'; node.rel = 'noopener noreferrer'; } else node = document.createTextNode(value); }
    fragment.append(node); cursor = match.index + value.length;
  }
  if (cursor < text.length) fragment.append(document.createTextNode(text.slice(cursor)));
  return fragment;
}
function renderMath(tex, display) {
  const node = document.createElement(display ? 'div' : 'span'); node.className = display ? 'math-display' : 'math-inline';
  if (window.katex) { try { node.innerHTML = window.katex.renderToString(tex.trim(), { displayMode: display, throwOnError: false, trust: false, strict: 'ignore' }); } catch { node.textContent = tex; } }
  else { node.classList.add('math-fallback'); node.textContent = readableTex(tex); }
  return node;
}
function readableTex(source) {
  let text = source.replace(/\\frac\s*\{([^{}]+)\}\s*\{([^{}]+)\}/g, '$1⁄$2').replace(/\\(?:left|right|displaystyle|textstyle)\b/g, '').replace(/\\(?:[,;:!]|quad\b|qquad\b)/g, ' ');
  const symbols = { theta:'θ',Theta:'Θ',alpha:'α',beta:'β',gamma:'γ',delta:'δ',epsilon:'ε',lambda:'λ',mu:'μ',pi:'π',sigma:'σ',phi:'φ',omega:'ω',ell:'ℓ',infty:'∞',times:'×',cdot:'·',pm:'±',le:'≤',leq:'≤',ge:'≥',geq:'≥',neq:'≠',approx:'≈',to:'→',in:'∈',notin:'∉',mid:'|',partial:'∂',nabla:'∇',sum:'∑',prod:'∏',log:'log',ln:'ln',exp:'exp',max:'max',min:'min',hat:'^',overline:'¯',mathbf:'',mathrm:'',text:'' };
  text = text.replace(/\\([A-Za-z]+)(\*?)/g, (_, command) => symbols[command] ?? command);
  text = text.replace(/\\([{}%$#&_])/g, '$1').replace(/\s+/g, ' ').trim();
  text = text.replace(/\{([^{}]*)\}/g, '$1');
  text = text.replace(/\^([A-Za-z0-9+-])/g, (_, c) => ({'0':'⁰','1':'¹','2':'²','3':'³','4':'⁴','5':'⁵','6':'⁶','7':'⁷','8':'⁸','9':'⁹','+':'⁺','-':'⁻','n':'ⁿ','i':'ⁱ'}[c] || c));
  text = text.replace(/_([A-Za-z0-9+-])/g, (_, c) => ({'0':'₀','1':'₁','2':'₂','3':'₃','4':'₄','5':'₅','6':'₆','7':'₇','8':'₈','9':'₉','+':'₊','-':'₋','i':'ᵢ','n':'ₙ','x':'ₓ'}[c] || c));
  text = text.replace(/\s*([=+])\s*/g, ' $1 ').replace(/\s+/g, ' ');
  return text;
}
function safeUrl(value) { try { const url = new URL(value, window.location.origin); return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null; } catch { return null; } }
async function readEventStream(response, onDelta) {
  if (!response.ok) { const error = await response.json().catch(() => ({})); throw new Error(error.error || '请求失败'); }
  const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', result = {};
  while (true) { const { value, done } = await reader.read(); buffer += decoder.decode(value || new Uint8Array(), { stream: !done }); const blocks = buffer.split(/\r?\n\r?\n/); buffer = blocks.pop() || ''; for (const block of blocks) { const type = block.match(/^event:\s*(\w+)/m)?.[1], raw = block.match(/^data:\s*(.+)$/m)?.[1]; if (!raw) continue; const item = JSON.parse(raw); if (type === 'delta') onDelta(item.text); else if (type === 'status') onDelta(null, item); else if (type === 'reset') onDelta(null, { stage: 'reset' }); else if (type === 'done') result = item; else if (type === 'error') throw new Error(item.error || '生成失败'); } if (done) break; }
  if (!result.mode) throw new Error('回答流意外中断。'); return result;
}
function scrollBottom() { conversation.scrollTop = conversation.scrollHeight; }
function autoSize() { input.style.height = 'auto'; input.style.height = `${Math.min(input.scrollHeight, 120)}px`; count.textContent = `${input.value.length} / 2000`; }
input.addEventListener('input', autoSize);
input.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); form.requestSubmit(); } });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => { input.value = button.dataset.prompt; autoSize(); input.focus(); if (button.classList.contains('suggestion')) form.requestSubmit(); }));
document.querySelector('#new-chat').addEventListener('click', async () => { activeSessionId = null; history.length = 0; messages.replaceChildren(); welcome.hidden = false; input.value = ''; autoSize(); await ensureSession(); input.focus(); });
form.addEventListener('submit', async event => {
  event.preventDefault(); const question = input.value.trim(); if ((!question && !chatAttachments.length) || send.disabled) return;
  const attachments = chatAttachments.splice(0); renderAttachments(); const displayQuestion = question || '请查看我附加的文件。';
  welcome.hidden = true; await ensureSession(); addMessage('user', `${displayQuestion}${attachments.length ? `\n[附件] ${attachments.map(f => f.name).join('、')}` : ''}`); history.push({ role: 'user', content: displayQuestion });
  input.value = ''; autoSize(); send.disabled = true;
  const pending = addMessage('assistant', ''); pending.querySelector('.bubble').innerHTML = '<span class="typing" aria-label="正在思考"><i></i><i></i><i></i></span>'; scrollBottom();
  try {
    const response = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question: displayQuestion, sessionId: activeSessionId, attachments, webSearch: webSearchEnabled }) });
    let streamed = ''; const data = await readEventStream(response, (text, status) => { if (status) { if (status.stage === 'reset') { streamed = ''; pending.querySelector('.bubble').textContent = '服务短暂波动，正在自动重试…'; } else if (status.stage === 'queued') pending.querySelector('.bubble').textContent = '请求已进入队列，正在等待模型资源…'; else pending.querySelector('.bubble').textContent = status.stage === 'retrieving' ? '正在检索知识库…' : status.stage === 'websearch' ? '正在搜索互联网…' : `已检索到 ${status.retrieved} 条知识库内容${status.webResults ? `和 ${status.webResults} 条网页` : ''}，正在组织回答…`; } else { streamed += text; pending.querySelector('.bubble').replaceChildren(renderMarkdown(streamed)); scrollBottom(); } });
    const answer = data.answer; history.push({ role: 'assistant', content: answer });
    const replacement = addMessage('assistant', answer, { sources: data.sources, notice: data.notice }); pending.remove();
    const meta = replacement.querySelector('.message-meta'); meta.textContent = `寻知 · ${data.mode === 'online' ? '在线模型' : '演示模式'} · ${(data.elapsedMs / 1000).toFixed(1)} 秒`; await refreshSessions(); scrollBottom();
  } catch (error) { pending.remove(); addMessage('assistant', error.message || '服务暂时不可用，请稍后重试。'); scrollBottom(); }
  finally { send.disabled = false; input.focus(); }
});
