import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { db } from './db.js';

const COOKIE = 'mna_session';
const MAX_AGE_SEC = 30 * 24 * 3600;
const hash = (t) => crypto.createHash('sha256').update(t).digest('hex');

const insertUser = db.prepare('INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)');
const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
const findById = db.prepare('SELECT id, name, email, grade, role, created_at FROM users WHERE id = ?');
const insertSession = db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)');
const findSession = db.prepare('SELECT user_id, expires_at FROM sessions WHERE token_hash = ?');
const deleteSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
const cleanExpired = db.prepare('DELETE FROM sessions WHERE expires_at < ?');

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, limit: 15, standardHeaders: true, legacyHeaders: false,
  message: { error: 'محاولات كثيرة، حاول بعد 15 دقيقة.' }
});

function readToken(req) {
  const raw = req.headers.cookie || '';
  const part = raw.split(';').map(s => s.trim()).find(s => s.startsWith(COOKIE + '='));
  return part ? decodeURIComponent(part.slice(COOKIE.length + 1)) : null;
}

function setCookie(res, value, maxAge) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${COOKIE}=${encodeURIComponent(value)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}

function createSession(res, userId) {
  cleanExpired.run(Date.now());
  const token = crypto.randomBytes(32).toString('hex');
  insertSession.run(hash(token), userId, Date.now() + MAX_AGE_SEC * 1000);
  setCookie(res, token, MAX_AGE_SEC);
}

export function currentUser(req) {
  const token = readToken(req);
  if (!token) return null;
  const s = findSession.get(hash(token));
  if (!s || s.expires_at < Date.now()) return null;
  return findById.get(s.user_id) || null;
}

export function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'سجّل الدخول أولًا.' });
  req.user = user;
  next();
}

export function registerAuthRoutes(app) {
  app.get('/api/auth/me', (req, res) => res.json({ user: currentUser(req) }));

  app.post('/api/auth/register', authLimiter, async (req, res) => {
    const name = String(req.body?.name || '').trim().slice(0, 80);
    const email = String(req.body?.email || '').trim().toLowerCase().slice(0, 120);
    const password = String(req.body?.password || '');
    if (name.length < 2) return res.status(400).json({ error: 'الاسم قصير جدًا.' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'البريد الإلكتروني غير صالح.' });
    if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'كلمة السر لازم تكون 8 حروف على الأقل.' });
    if (findByEmail.get(email)) return res.status(409).json({ error: 'البريد مسجل بالفعل.' });
    const hashed = await bcrypt.hash(password, 12);
    const info = insertUser.run(name, email, hashed);
    createSession(res, info.lastInsertRowid);
    res.status(201).json({ user: findById.get(info.lastInsertRowid) });
  });

  app.post('/api/auth/login', authLimiter, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const row = findByEmail.get(email);
    const ok = row && await bcrypt.compare(password, row.password_hash);
    if (!ok) return res.status(401).json({ error: 'البريد أو كلمة السر غير صحيحة.' });
    createSession(res, row.id);
    res.json({ user: findById.get(row.id) });
  });

  app.post('/api/auth/logout', (req, res) => {
    const token = readToken(req);
    if (token) deleteSession.run(hash(token));
    setCookie(res, '', 0);
    res.json({ ok: true });
  });
}
