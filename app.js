const $ = (id) => document.getElementById(id);
const messagesEl = $('messages'), form = $('form'), input = $('input'), sendBtn = $('send');
const fileInput = $('file'), preview = $('preview'), previewImg = $('previewImg'), statusEl = $('status');
let history = [];
let pendingImage = null;
let busy = false;
let convId = null;

function toast(text) {
  const t = $('toast'); t.textContent = text; t.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), 3500);
}
function setStatus(text, cls = '') { statusEl.textContent = text; statusEl.className = 'status ' + cls; }

function addMsg(role, text) {
  const div = document.createElement('div');
  div.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  div.textContent = text; // textContent يمنع تنفيذ أي كود داخل الرد
  if (role === 'assistant') {
    const btn = document.createElement('button');
    btn.className = 'btn small ghost msg-copy'; btn.textContent = 'نسخ';
    btn.onclick = async () => {
      try { await navigator.clipboard.writeText(text); toast('تم النسخ'); }
      catch { toast('تعذر النسخ'); }
    };
    div.appendChild(btn);
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return div;
}

function setBusy(v) {
  busy = v; sendBtn.disabled = v;
  setStatus(v ? 'MN AI يفكر...' : 'متصل', v ? 'busy' : '');
}

async function postJSON(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res;
}

async function sendText(text) {
  history.push({ role: 'user', content: text });
  addMsg('user', text);
  const loader = addMsg('assistant', '...'); loader.classList.add('loading');
  loader.querySelector('.msg-copy')?.remove();
  try {
    const res = await postJSON('/api/chat', { messages: history.slice(-30), conversationId: convId });
    const data = await res.json().catch(() => ({}));
    loader.remove();
    if (!res.ok) throw new Error(data.error || 'حدث خطأ');
    history.push({ role: 'assistant', content: data.reply });
    if (data.conversationId) { convId = data.conversationId; loadConversations(); }
    addMsg('assistant', data.reply);
    setStatus('متصل');
  } catch (err) {
    loader.remove();
    history.pop();
    addMsg('assistant', '⚠️ ' + (navigator.onLine ? err.message : 'لا يوجد اتصال بالإنترنت. تحقق من الشبكة وحاول مرة أخرى.'));
    setStatus('خطأ في الاتصال', 'err');
  }
}

async function sendImage(file, question) {
  const label = (question || 'تحليل صورة الواجب') + ' 📷';
  addMsg('user', label);
  const loader = addMsg('assistant', 'جارٍ تحليل الصورة...'); loader.classList.add('loading');
  loader.querySelector('.msg-copy')?.remove();
  try {
    const fd = new FormData();
    fd.append('image', file); fd.append('question', question || '');
    const res = await fetch('/api/analyze-image', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    loader.remove();
    if (!res.ok) throw new Error(data.error || 'تعذر تحليل الصورة');
    history.push({ role: 'user', content: '[صورة] ' + (question || '') }, { role: 'assistant', content: data.reply });
    addMsg('assistant', data.reply);
    setStatus('متصل');
  } catch (err) {
    loader.remove();
    addMsg('assistant', '⚠️ ' + (navigator.onLine ? err.message : 'لا يوجد اتصال بالإنترنت.'));
    setStatus('خطأ في الاتصال', 'err');
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (busy) return;
  const text = input.value.trim();
  if (!text && !pendingImage) return;
  setBusy(true);
  const img = pendingImage;
  input.value = ''; autoResize(); clearPreview();
  try {
    if (img) await sendImage(img, text);
    else await sendText(text);
  } finally { setBusy(false); }
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); }
});
input.addEventListener('input', autoResize);
function autoResize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 140) + 'px'; }

fileInput.addEventListener('change', () => {
  const f = fileInput.files[0];
  if (!f) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(f.type)) { toast('الصيغة غير مدعومة. استخدم jpg أو png أو webp'); fileInput.value = ''; return; }
  if (f.size > 5 * 1024 * 1024) { toast('الحجم أكبر من 5 ميجابايت'); fileInput.value = ''; return; }
  pendingImage = f;
  previewImg.src = URL.createObjectURL(f);
  preview.hidden = false;
  fileInput.value = '';
});
function clearPreview() {
  pendingImage = null; preview.hidden = true;
  if (previewImg.src.startsWith('blob:')) URL.revokeObjectURL(previewImg.src);
  previewImg.removeAttribute('src');
}
$('removeImg').addEventListener('click', clearPreview);

$('newChat').addEventListener('click', () => {
  if (busy) return;
  history = []; convId = null; messagesEl.innerHTML = '';
  addMsg('assistant', 'بدأنا محادثة جديدة. كيف أساعدك؟');
});

(async () => {
  try {
    const r = await fetch('/api/health'); const d = await r.json();
    if (!d.aiConfigured) setStatus('المدرس الذكي غير مفعّل على الخادم', 'err');
  } catch { setStatus('تعذر الاتصال بالخادم', 'err'); }
})();

// ===== الحسابات والمحادثات المحفوظة واللوحة =====
let currentUser = null;
let authMode = 'login';
const authArea = $('authArea'), authModal = $('authModal'), authForm = $('authForm');

async function api(url, method = 'GET', body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'حدث خطأ');
  return data;
}

function mkBtn(text, cls, onClick) {
  const b = document.createElement('button');
  b.className = 'btn ' + cls; b.textContent = text; b.onclick = onClick;
  return b;
}

function renderAuth() {
  authArea.replaceChildren();
  if (currentUser) {
    authArea.append(
      mkBtn('لوحتي', 'ghost', () => $('dashboard').scrollIntoView({ behavior: 'smooth' })),
      mkBtn('خروج', 'ghost', logout)
    );
  } else {
    authArea.append(
      mkBtn('تسجيل الدخول', 'ghost', () => openAuth('login')),
      mkBtn('إنشاء حساب', 'primary', () => openAuth('register'))
    );
  }
}

function openAuth(mode) {
  authMode = mode;
  const isReg = mode === 'register';
  $('authTitle').textContent = isReg ? 'إنشاء حساب طالب' : 'تسجيل الدخول';
  $('authName').hidden = !isReg;
  $('authName').required = isReg;
  $('authSubmit').textContent = isReg ? 'إنشاء الحساب' : 'دخول';
  $('authSwitch').textContent = isReg ? 'عندي حساب بالفعل' : 'ليس لديّ حساب';
  $('authError').textContent = '';
  authForm.reset();
  authModal.hidden = false;
  $('authEmail').focus();
}

$('authClose').onclick = () => { authModal.hidden = true; };
$('authSwitch').onclick = () => openAuth(authMode === 'login' ? 'register' : 'login');
authModal.addEventListener('click', (e) => { if (e.target === authModal) authModal.hidden = true; });

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = { email: $('authEmail').value, password: $('authPass').value };
  if (authMode === 'register') body.name = $('authName').value;
  $('authSubmit').disabled = true;
  $('authError').textContent = '';
  try {
    const d = await api(authMode === 'register' ? '/api/auth/register' : '/api/auth/login', 'POST', body);
    currentUser = d.user;
    authModal.hidden = true;
    onLogin();
    toast('أهلًا ' + currentUser.name);
  } catch (err) {
    $('authError').textContent = err.message;
  } finally {
    $('authSubmit').disabled = false;
  }
});

async function logout() {
  await api('/api/auth/logout', 'POST').catch(() => {});
  currentUser = null; convId = null; history = [];
  messagesEl.replaceChildren();
  addMsg('assistant', 'تم تسجيل الخروج. يمكنك الاستمرار كزائر، لكن المحادثات لن تُحفظ.');
  $('convList').hidden = true;
  $('dashboard').hidden = true;
  renderAuth();
}

function onLogin() {
  renderAuth();
  $('convList').hidden = false;
  $('dashboard').hidden = false;
  loadConversations();
  loadDashboard();
}

function convItem(c, withDelete) {
  const row = document.createElement('div');
  row.className = 'conv-item' + (c.id === convId ? ' active' : '');
  const title = document.createElement('button');
  title.className = 'conv-title';
  title.textContent = c.title;
  title.onclick = () => openConversation(c.id);
  row.append(title);
  if (withDelete) {
    const del = document.createElement('button');
    del.className = 'btn small ghost';
    del.textContent = 'حذف';
    del.onclick = () => deleteConversation(c.id);
    row.append(del);
  }
  return row;
}

function emptyNote(text) {
  const s = document.createElement('span');
  s.className = 'muted'; s.textContent = text;
  return s;
}

async function loadConversations() {
  const box = $('convList');
  box.replaceChildren();
  if (!currentUser) return;
  const { conversations } = await api('/api/conversations').catch(() => ({ conversations: [] }));
  if (!conversations.length) return box.append(emptyNote('لا توجد محادثات محفوظة بعد.'));
  conversations.forEach(c => box.append(convItem(c, true)));
}

async function openConversation(id) {
  if (busy) return;
  try {
    const { messages } = await api('/api/conversations/' + id);
    convId = id;
    history = [];
    messagesEl.replaceChildren();
    messages.forEach(m => addMsg(m.role === 'user' ? 'user' : 'assistant', m.content));
    loadConversations();
  } catch (err) {
    toast(err.message);
  }
}

async function deleteConversation(id) {
  if (!confirm('تحذف المحادثة نهائيًا؟')) return;
  try {
    await api('/api/conversations/' + id, 'DELETE');
    if (convId === id) { convId = null; messagesEl.replaceChildren(); }
    toast('تم الحذف');
    loadConversations();
    loadDashboard();
  } catch (err) {
    toast(err.message);
  }
}

async function loadDashboard() {
  if (!currentUser) return;
  const d = await api('/api/dashboard').catch(() => null);
  if (!d) return;
  $('welcomeText').textContent = 'مرحبًا ' + d.user.name + ' 👋 — الصف الثالث الإعدادي';
  $('statConv').textContent = d.stats.conversations;
  $('statQ').textContent = d.stats.questions;
  const box = $('recentConv');
  box.replaceChildren();
  if (!d.recent.length) return box.append(emptyNote('ابدأ أول محادثة مع MN AI.'));
  d.recent.forEach(c => box.append(convItem(c, false)));
}

(async () => {
  try { currentUser = (await api('/api/auth/me')).user; } catch { currentUser = null; }
  renderAuth();
  if (currentUser) onLogin();
})();
