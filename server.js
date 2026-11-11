import express from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { db } from './db.js';
import { registerAuthRoutes, requireAuth, currentUser } from './auth.js';

dotenv.config();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const KEY = process.env.GEMINI_API_KEY;
const genAI = KEY ? new GoogleGenerativeAI(KEY) : null;
if (!KEY) console.warn('تنبيه: GEMINI_API_KEY غير مضبوط في ملف .env');

const SYSTEM = `أنت MN AI، مدرس ذكي لطلاب الصف الثالث الإعدادي في مصر.
- تكلم بالعربية الواضحة المناسبة للطالب، واستخدم الإنجليزية عند شرح مادة اللغة الإنجليزية.
- اشرح خطوة بخطوة، ووضح سبب كل خطوة، ثم اذكر الإجابة النهائية بوضوح.
- لا تخترع معلومات أو قوانين غير مؤكدة، وقل بوضوح إن لم تكن متأكدًا.
- لا تعرض نفسك كبديل عن المنهج الرسمي؛ المرجع الأساسي هو كتب الوزارة.`;

const stmt = {
  convInsert: db.prepare('INSERT INTO conversations (user_id, title) VALUES (?, ?)'),
  convOwned: db.prepare('SELECT id, title, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?'),
  convList: db.prepare('SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100'),
  convDelete: db.prepare('DELETE FROM conversations WHERE id = ? AND user_id = ?'),
  convTouch: db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?"),
  msgInsert: db.prepare('INSERT INTO messages (conversation_id, role, content) VALUES (?, ?, ?)'),
  msgList: db.prepare('SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id'),
  dashStats: db.prepare(`SELECT
      (SELECT COUNT(*) FROM conversations WHERE user_id = ?) AS conversations,
      (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
        WHERE c.user_id = ? AND m.role = 'user') AS questions`)
};

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/api', rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كثيرة جدًا، انتظر دقيقة.' } }));

const aiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'طلبات كثيرة جدًا للمدرس الذكي، انتظر دقيقة.' } });

registerAuthRoutes(app);

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp'];
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => cb(null, ALLOWED_MIME.includes(file.mimetype))
});

function handleAIError(e, res) {
  console.error('AI error:', e?.status || '', String(e?.message || '').slice(0, 150));
  if (e?.status === 429) return res.status(429).json({ error: 'تم تجاوز حد الاستخدام لدى مزود الذكاء الاصطناعي. حاول لاحقًا.' });
  if (e?.status === 401 || e?.status === 403) return res.status(500).json({ error: 'مفتاح الذكاء الاصطناعي غير صالح. راجع إعدادات الخادم.' });
  return res.status(502).json({ error: 'تعذر الوصول إلى خدمة الذكاء الاصطناعي. تحقق من الاتصال وحاول مرة أخرى.' });
}

function saveExchange(userId, convId, userText, reply) {
  return db.transaction(() => {
    let id = convId;
    if (id) {
      if (!stmt.convOwned.get(id, userId)) throw Object.assign(new Error('not found'), { status: 404 });
    } else {
      id = stmt.convInsert.run(userId, userText.slice(0, 40)).lastInsertRowid;
    }
    stmt.msgInsert.run(id, 'user', userText);
    stmt.msgInsert.run(id, 'assistant', reply);
    stmt.convTouch.run(id);
    return id;
  })();
}

app.get('/api/health', (req, res) => res.json({ ok: true, aiConfigured: !!genAI, model: MODEL }));

app.post('/api/chat', aiLimiter, async (req, res) => {
  if (!genAI) return res.status(503).json({ error: 'خدمة الذكاء الاصطناعي غير مهيأة على الخادم.' });
  const user = currentUser(req);
  const convId = user && Number.isInteger(req.body?.conversationId) ? req.body.conversationId : null;
  if (convId && !stmt.convOwned.get(convId, user.id)) return res.status(404).json({ error: 'المحادثة غير موجودة.' });

  const msgs = Array.isArray(req.body?.messages) ? req.body.messages.slice(-30) : null;
  const last = msgs?.at(-1);
  if (!last || last.role !== 'user' || typeof last.content !== 'string' || !last.content.trim() || last.content.length > 4000) {
    return res.status(400).json({ error: 'الرسالة غير صالحة أو أطول من الحد المسموح.' });
  }
  const userText = last.content.trim();

  try {
    // للمستخدم المسجل: السياق يُقرأ من قاعدة البيانات وليس من المتصفح
    let history = convId
      ? stmt.msgList.all(convId).slice(-30).map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      : msgs.slice(0, -1)
          .filter(m => typeof m.content === 'string' && ['user', 'assistant'].includes(m.role))
          .map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content.slice(0, 4000) }] }));
    while (history.length && history[0].role === 'model') history.shift();

    const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: SYSTEM });
    const chat = model.startChat({ history });
    const result = await chat.sendMessage(userText);
    const reply = result.response.text();

    const savedId = user ? saveExchange(user.id, convId, userText, reply) : null;
    res.json({ reply, conversationId: savedId });
  } catch (e) {
    if (e?.status === 404) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
    handleAIError(e, res);
  }
});

app.post('/api/analyze-image', aiLimiter, upload.single('image'), async (req, res) => {
  if (!genAI) return res.status(503).json({ error: 'خدمة الذكاء الاصطناعي غير مهيأة على الخادم.' });
  if (!req.file) return res.status(400).json({ error: 'الصورة غير مدعومة (jpg/png/webp فقط) أو حجمها أكبر من 5 ميجابايت.' });
  const question = String(req.body?.question || 'حل السؤال الموجود في الصورة خطوة بخطوة').slice(0, 1000);
  try {
    const model = genAI.getGenerativeModel({ model: MODEL, systemInstruction: SYSTEM });
    const result = await model.generateContent([
      { text: `استخرج السؤال من الصورة أولًا، ثم اشرح المطلوب، ثم قدم الحل خطوة بخطوة، وأخيرًا الإجابة النهائية. طلب الطالب: ${question}` },
      { inlineData: { mimeType: req.file.mimetype, data: req.file.buffer.toString('base64') } }
    ]);
    res.json({ reply: result.response.text() });
  } catch (e) {
    handleAIError(e, res);
  }
});

app.get('/api/conversations', requireAuth, (req, res) => res.json({ conversations: stmt.convList.all(req.user.id) }));

app.get('/api/conversations/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const conv = Number.isInteger(id) && stmt.convOwned.get(id, req.user.id);
  if (!conv) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
  res.json({ conversation: conv, messages: stmt.msgList.all(id) });
});

app.delete('/api/conversations/:id', requireAuth, (req, res) => {
  const id = Number(req.params.id);
  const r = Number.isInteger(id) ? stmt.convDelete.run(id, req.user.id) : { changes: 0 };
  if (!r.changes) return res.status(404).json({ error: 'المحادثة غير موجودة.' });
  res.json({ ok: true });
});

app.get('/api/dashboard', requireAuth, (req, res) => {
  const stats = stmt.dashStats.get(req.user.id, req.user.id);
  res.json({ user: req.user, stats, recent: stmt.convList.all(req.user.id).slice(0, 5) });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: 'تعذر رفع الملف.' });
  console.error('Server error:', String(err?.message || '').slice(0, 150));
  res.status(500).json({ error: 'حدث خطأ غير متوقع على الخادم.' });
});

app.listen(PORT, () => console.log(`MN ACADEMY running on http://localhost:${PORT}`));
