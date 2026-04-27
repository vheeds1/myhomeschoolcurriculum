/* ────────────────────────────────────────────────────────────────────────────
   My Homeschool Curriculum — AI Curriculum Advisor widget
   Self-contained: single <script src="/chat-widget.js" defer> include and
   the floating chat button + panel appear on any page.

   - Powered by /api/chat (Gemini-backed, tool-grounded in real data)
   - Conversation persists in localStorage (cc_chat_session, cc_chat_history)
   - Respects prefers-reduced-motion
──────────────────────────────────────────────────────────────────────────── */
(function () {
  if (window.__mhcChatLoaded) return;
  window.__mhcChatLoaded = true;

  const API = window.location.hostname === 'localhost' ? 'http://localhost:3001/api' : '/api';
  const STORAGE_HISTORY = 'cc_chat_history';
  const STORAGE_SESSION = 'cc_chat_session';
  const STORAGE_SEEN = 'cc_chat_seen_intro';

  // ── Inject styles ────────────────────────────────────────────────────────
  const styles = `
  .mhc-chat-fab{position:fixed;bottom:24px;right:24px;width:60px;height:60px;border-radius:50%;background:#4A7550;color:#fff;border:none;cursor:pointer;box-shadow:0 6px 22px rgba(74,117,80,.4);z-index:9998;display:flex;align-items:center;justify-content:center;transition:transform .25s cubic-bezier(.22,1,.36,1), box-shadow .25s, background .2s}
  .mhc-chat-fab:hover{background:#3a6040;transform:translateY(-2px) scale(1.04);box-shadow:0 10px 28px rgba(74,117,80,.5)}
  .mhc-chat-fab:active{transform:scale(.94)}
  .mhc-chat-fab svg{width:26px;height:26px}
  .mhc-chat-fab .mhc-chat-dot{position:absolute;top:8px;right:8px;width:11px;height:11px;background:#D4A84C;border-radius:50%;border:2px solid #4A7550;animation:mhcPulse 2s ease-in-out infinite}
  @keyframes mhcPulse{0%,100%{transform:scale(1);opacity:1}50%{transform:scale(1.15);opacity:.85}}
  .mhc-chat-fab.open .mhc-chat-dot{display:none}
  @media(prefers-reduced-motion:reduce){.mhc-chat-fab,.mhc-chat-dot{animation:none!important;transition:none!important}}

  .mhc-chat-panel{position:fixed;bottom:96px;right:24px;width:380px;max-width:calc(100vw - 48px);height:560px;max-height:calc(100vh - 120px);background:#FFFBF5;border:1px solid #E8DDD0;border-radius:16px;box-shadow:0 18px 50px rgba(31,58,77,.18);z-index:9997;display:none;flex-direction:column;overflow:hidden;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,sans-serif}
  .mhc-chat-panel.open{display:flex;animation:mhcSlideUp .3s cubic-bezier(.22,1,.36,1) both}
  @keyframes mhcSlideUp{from{opacity:0;transform:translateY(12px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
  @media(prefers-reduced-motion:reduce){.mhc-chat-panel.open{animation:none}}

  .mhc-chat-head{background:#1F3A4D;color:#fff;padding:14px 18px;display:flex;align-items:center;gap:12px;flex-shrink:0}
  .mhc-chat-head .mhc-chat-icon{width:36px;height:36px;background:rgba(212,168,76,.2);border:1px solid rgba(212,168,76,.5);border-radius:50%;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#D4A84C}
  .mhc-chat-head .mhc-chat-icon svg{width:18px;height:18px}
  .mhc-chat-head .mhc-chat-title{font-family:'Fraunces','Playfair Display',serif;font-size:.98rem;font-weight:700;letter-spacing:-.2px;line-height:1.2}
  .mhc-chat-head .mhc-chat-sub{font-size:.7rem;color:rgba(255,255,255,.65);line-height:1.3;margin-top:2px}
  .mhc-chat-head .mhc-chat-close{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;padding:6px;display:flex;align-items:center;justify-content:center;border-radius:6px;transition:background .15s, color .15s}
  .mhc-chat-head .mhc-chat-close:hover{background:rgba(255,255,255,.1);color:#fff}

  .mhc-chat-body{flex:1;overflow-y:auto;padding:18px 16px;display:flex;flex-direction:column;gap:12px;background:#FFFBF5}
  .mhc-chat-body::-webkit-scrollbar{width:6px}
  .mhc-chat-body::-webkit-scrollbar-thumb{background:rgba(31,58,77,.18);border-radius:3px}

  .mhc-chat-msg{max-width:85%;font-size:.88rem;line-height:1.55;word-wrap:break-word}
  .mhc-chat-msg.user{align-self:flex-end;background:#1F3A4D;color:#fff;padding:9px 14px;border-radius:14px 14px 4px 14px}
  .mhc-chat-msg.bot{align-self:flex-start;color:#2C3E3F}
  .mhc-chat-msg.bot strong{color:#1F3A4D;font-weight:700}
  .mhc-chat-msg.bot a{color:#4A7550;font-weight:600;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px}
  .mhc-chat-msg.bot a:hover{color:#1F3A4D}
  .mhc-chat-msg.bot p{margin:0 0 8px}
  .mhc-chat-msg.bot p:last-child{margin-bottom:0}
  .mhc-chat-msg.bot ul,.mhc-chat-msg.bot ol{margin:6px 0 8px 20px}
  .mhc-chat-msg.bot li{margin-bottom:4px}
  .mhc-chat-msg.bot em{color:#6B6B60;font-style:italic;font-size:.82rem}

  .mhc-chat-typing{align-self:flex-start;display:flex;gap:4px;padding:10px 14px}
  .mhc-chat-typing span{width:7px;height:7px;background:rgba(31,58,77,.35);border-radius:50%;animation:mhcDot 1.2s ease-in-out infinite}
  .mhc-chat-typing span:nth-child(2){animation-delay:.2s}
  .mhc-chat-typing span:nth-child(3){animation-delay:.4s}
  @keyframes mhcDot{0%,80%,100%{transform:scale(.6);opacity:.4}40%{transform:scale(1);opacity:1}}
  @media(prefers-reduced-motion:reduce){.mhc-chat-typing span{animation:none;opacity:.7}}

  .mhc-chat-suggestions{display:flex;flex-direction:column;gap:8px;margin-top:8px}
  .mhc-chat-suggestion{background:#fff;border:1px solid #E8DDD0;color:#1F3A4D;padding:10px 14px;border-radius:10px;font-size:.84rem;cursor:pointer;text-align:left;font-family:inherit;line-height:1.45;transition:border-color .15s, background .15s, transform .15s cubic-bezier(.22,1,.36,1)}
  .mhc-chat-suggestion:hover{border-color:#7A9E7E;background:#F5F8F1}
  .mhc-chat-suggestion:active{transform:scale(.98)}

  .mhc-chat-disclosure{align-self:stretch;background:#F5F0E5;border:1px solid #E8DDD0;border-radius:10px;padding:11px 13px;font-size:.74rem;color:#6B6B60;line-height:1.55}
  .mhc-chat-disclosure strong{color:#1F3A4D;font-weight:600}

  .mhc-chat-foot{flex-shrink:0;padding:12px 14px 14px;background:#FFFBF5;border-top:1px solid #E8DDD0}
  .mhc-chat-form{display:flex;gap:8px;align-items:flex-end}
  .mhc-chat-input{flex:1;border:1.5px solid #E8DDD0;border-radius:12px;padding:10px 12px;font-family:inherit;font-size:.88rem;color:#2C3E3F;outline:none;resize:none;max-height:120px;background:#fff;transition:border-color .15s}
  .mhc-chat-input:focus{border-color:#4A7550}
  .mhc-chat-input::placeholder{color:#9E9E94}
  .mhc-chat-send{background:#4A7550;color:#fff;border:none;width:40px;height:40px;border-radius:12px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:background .15s, transform .15s cubic-bezier(.22,1,.36,1);flex-shrink:0}
  .mhc-chat-send:hover:not(:disabled){background:#3a6040}
  .mhc-chat-send:active{transform:scale(.92)}
  .mhc-chat-send:disabled{background:#B5C2A8;cursor:not-allowed}
  .mhc-chat-send svg{width:18px;height:18px}
  .mhc-chat-fine{font-size:.66rem;color:#9E9E94;text-align:center;margin-top:8px;letter-spacing:.2px}

  .mhc-chat-error{background:#FDF0ED;border:1px solid #F2C9B8;color:#8A3E25;padding:10px 12px;border-radius:10px;font-size:.82rem;align-self:stretch}

  @media(max-width:600px){
    .mhc-chat-fab{bottom:18px;right:18px;width:54px;height:54px}
    .mhc-chat-fab svg{width:22px;height:22px}
    .mhc-chat-panel{width:100vw;max-width:100vw;height:100vh;max-height:100vh;bottom:0;right:0;border-radius:0;border:none}
    .mhc-chat-panel.open{animation:none}
  }
  `;

  const styleTag = document.createElement('style');
  styleTag.textContent = styles;
  document.head.appendChild(styleTag);

  // ── Build DOM ────────────────────────────────────────────────────────────
  const fab = document.createElement('button');
  fab.className = 'mhc-chat-fab';
  fab.setAttribute('aria-label', 'Open homeschool curriculum advisor chat');
  fab.setAttribute('aria-expanded', 'false');
  fab.innerHTML = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
    </svg>
    <span class="mhc-chat-dot" aria-hidden="true"></span>`;
  document.body.appendChild(fab);

  const panel = document.createElement('div');
  panel.className = 'mhc-chat-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-label', 'Curriculum advisor');
  panel.innerHTML = `
    <div class="mhc-chat-head">
      <div class="mhc-chat-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
        </svg>
      </div>
      <div>
        <div class="mhc-chat-title">Curriculum Advisor</div>
        <div class="mhc-chat-sub">Honest help finding what fits your family</div>
      </div>
      <button class="mhc-chat-close" aria-label="Close chat">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="mhc-chat-body" id="mhcChatBody"></div>
    <div class="mhc-chat-foot">
      <form class="mhc-chat-form" id="mhcChatForm">
        <textarea class="mhc-chat-input" id="mhcChatInput" placeholder="Ask about curricula, grade levels, budget..." rows="1" maxlength="2000"></textarea>
        <button class="mhc-chat-send" type="submit" aria-label="Send message">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>
        </button>
      </form>
      <div class="mhc-chat-fine">Powered by AI · Conversations are saved to improve recommendations</div>
    </div>`;
  document.body.appendChild(panel);

  const body = panel.querySelector('#mhcChatBody');
  const form = panel.querySelector('#mhcChatForm');
  const input = panel.querySelector('#mhcChatInput');
  const sendBtn = panel.querySelector('.mhc-chat-send');
  const closeBtn = panel.querySelector('.mhc-chat-close');

  // ── State ────────────────────────────────────────────────────────────────
  let history = [];
  let sessionId = null;
  let isSending = false;

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_HISTORY) || '[]');
    if (Array.isArray(saved)) history = saved;
    sessionId = localStorage.getItem(STORAGE_SESSION) || null;
  } catch (e) { history = []; }

  // ── Render helpers ───────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  // Minimal markdown — bold, italic, links, lists, line breaks
  function renderMarkdown(text) {
    let html = escapeHtml(text);
    // links: [text](url)
    html = html.replace(/\[([^\]]+)\]\(((?:https?:|\/)[^)]+)\)/g, (m, label, url) =>
      `<a href="${url}" target="_blank" rel="noopener${url.includes('affiliate') || url.includes('?ref=') ? ' sponsored' : ''}">${label}</a>`);
    // bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // italic (not inside links)
    html = html.replace(/(^|\s)\*([^*]+)\*(?=\s|$|[.,!?])/g, '$1<em>$2</em>');
    // unordered lists — convert leading `- ` lines into <li>
    const lines = html.split('\n');
    const out = []; let inList = false;
    for (const line of lines) {
      const m = line.match(/^[\s]*[-*]\s+(.+)$/);
      if (m) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push(`<li>${m[1]}</li>`);
      } else {
        if (inList) { out.push('</ul>'); inList = false; }
        if (line.trim()) out.push(`<p>${line}</p>`);
      }
    }
    if (inList) out.push('</ul>');
    return out.join('');
  }

  function renderMessage(role, text, animate = false) {
    const div = document.createElement('div');
    div.className = `mhc-chat-msg ${role}`;
    if (role === 'bot') div.innerHTML = renderMarkdown(text);
    else div.textContent = text;
    body.appendChild(div);
    if (animate) requestAnimationFrame(() => body.scrollTop = body.scrollHeight);
    else body.scrollTop = body.scrollHeight;
    return div;
  }

  function renderTyping() {
    const div = document.createElement('div');
    div.className = 'mhc-chat-typing';
    div.setAttribute('aria-label', 'Advisor is typing');
    div.innerHTML = '<span></span><span></span><span></span>';
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  function renderSuggestions(suggestions) {
    const wrap = document.createElement('div');
    wrap.className = 'mhc-chat-suggestions';
    suggestions.forEach(text => {
      const btn = document.createElement('button');
      btn.className = 'mhc-chat-suggestion';
      btn.type = 'button';
      btn.textContent = text;
      btn.addEventListener('click', () => {
        wrap.remove();
        send(text);
      });
      wrap.appendChild(btn);
    });
    body.appendChild(wrap);
    body.scrollTop = body.scrollHeight;
    return wrap;
  }

  function renderDisclosure() {
    const div = document.createElement('div');
    div.className = 'mhc-chat-disclosure';
    div.innerHTML = `<strong>How this works:</strong> I'll suggest curricula from our 60+ listings based on what you tell me. When I share a curriculum that has an affiliate link, I'll mark it — we earn a small commission only if you choose to buy through it, never at extra cost to you. Recommendations are never influenced by affiliate status.`;
    body.appendChild(div);
    return div;
  }

  function renderError(text) {
    const div = document.createElement('div');
    div.className = 'mhc-chat-error';
    div.textContent = text;
    body.appendChild(div);
    body.scrollTop = body.scrollHeight;
    return div;
  }

  function paintHistory() {
    body.innerHTML = '';
    if (history.length === 0) {
      const intro = "Hi! I'm a curriculum advisor for this site. Tell me about your family — kids' grade levels, teaching style you like, worldview preference, rough budget — and I'll suggest 2–3 curricula worth a closer look.";
      renderMessage('bot', intro);
      if (!localStorage.getItem(STORAGE_SEEN)) {
        renderDisclosure();
        localStorage.setItem(STORAGE_SEEN, '1');
      }
      renderSuggestions([
        "We're brand new to homeschooling. Where do I start?",
        "Charlotte Mason curriculum for K-2, Christian, on a budget",
        "What's the best secular option for middle school?",
        "I have a child with dyslexia — what should I look at?"
      ]);
    } else {
      history.forEach(turn => renderMessage(turn.role === 'model' ? 'bot' : 'user', turn.text));
    }
  }

  // ── Send ────────────────────────────────────────────────────────────────
  async function send(message) {
    if (isSending) return;
    const text = message.trim();
    if (!text) return;
    isSending = true;
    sendBtn.disabled = true;

    renderMessage('user', text);
    history.push({ role: 'user', text });
    saveHistory();
    input.value = '';
    input.style.height = 'auto';

    const typing = renderTyping();
    try {
      const res = await fetch(`${API}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, history: history.slice(-20, -1), sessionId })
      });
      typing.remove();
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        renderError(data.error || 'The advisor is having trouble. Please try again in a moment.');
        history.pop(); saveHistory();
        return;
      }
      const data = await res.json();
      if (data.sessionId) { sessionId = data.sessionId; localStorage.setItem(STORAGE_SESSION, sessionId); }
      renderMessage('bot', data.reply);
      history.push({ role: 'model', text: data.reply });
      saveHistory();
    } catch (err) {
      typing.remove();
      renderError("I couldn't reach the advisor — check your connection and try again.");
      history.pop(); saveHistory();
    } finally {
      isSending = false;
      sendBtn.disabled = false;
      input.focus();
    }
  }

  function saveHistory() {
    try { localStorage.setItem(STORAGE_HISTORY, JSON.stringify(history.slice(-40))); } catch (e) {}
  }

  // ── Wire up events ───────────────────────────────────────────────────────
  function open() {
    panel.classList.add('open');
    fab.classList.add('open');
    fab.setAttribute('aria-expanded', 'true');
    if (body.children.length === 0) paintHistory();
    setTimeout(() => input.focus(), 100);
  }
  function close() {
    panel.classList.remove('open');
    fab.classList.remove('open');
    fab.setAttribute('aria-expanded', 'false');
  }
  fab.addEventListener('click', () => panel.classList.contains('open') ? close() : open());
  closeBtn.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && panel.classList.contains('open')) close(); });

  form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
})();
