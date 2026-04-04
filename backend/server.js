/**
 * MyHomeschoolCurriculum — Production API Server v2.0
 * Features: Stripe billing, newsletter, user accounts, PDF export,
 *           full admin endpoints, Google Analytics events, blog/legal CMS
 */

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const nodemailer = require('nodemailer');

// Optional: Stripe (gracefully disabled if no key)
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
  }
} catch(e) {}

// Optional: Mailchimp
let mailchimp = null;
try {
  if (process.env.MAILCHIMP_API_KEY) {
    mailchimp = require('@mailchimp/mailchimp_marketing');
    mailchimp.setConfig({
      apiKey: process.env.MAILCHIMP_API_KEY,
      server: process.env.MAILCHIMP_SERVER_PREFIX || 'us1'
    });
  }
} catch(e) {}

const app = express();
const PORT = process.env.PORT || 3001;
const DB_PATH = path.join(__dirname, 'db/database.json');

// ─── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));

// Trust Railway's proxy and force HTTPS in production
app.set('trust proxy', 1);
app.use((req, res, next) => {
  if (process.env.NODE_ENV === 'production' && req.headers['x-forwarded-proto'] !== 'https') {
    return res.redirect(301, `https://${req.headers.host}${req.url}`);
  }
  next();
});
app.use(cors({
  origin: process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

// Raw body for Stripe webhooks BEFORE express.json()
app.use('/api/billing/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'frontend')));

// Rate limiting
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const submitLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Submission limit reached.' } });
const authLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many auth attempts.' } });
app.use('/api/', generalLimiter);

// ─── DATABASE HELPERS ────────────────────────────────────────────────────────
function readDB() {
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch(e) { console.error('DB read error:', e); return null; }
}
function writeDB(data) {
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8'); return true; }
  catch(e) { console.error('DB write error:', e); return false; }
}

// Ensure all collections exist on startup
function ensureDB() {
  const db = readDB() || {};
  const defaults = {
    curricula: [], reviews: [], affiliateClicks: [], listingInquiries: [],
    contactMessages: [], quizResults: [], users: [], userFavorites: [],
    sessions: [], blogPosts: [], newsletterSubscribers: [], stripeSubscriptions: [],
    analytics: { totalVisits: 0, totalClicks: 0, totalReviews: 0, totalInquiries: 0 }
  };
  let changed = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (db[k] === undefined) { db[k] = v; changed = true; }
  }
  if (changed) writeDB(db);
}
ensureDB();

// ─── EMAIL ───────────────────────────────────────────────────────────────────
async function sendEmail(to, subject, html) {
  if (!process.env.SMTP_USER) { console.log('[Email skipped - no SMTP config]', subject); return true; }
  console.log(`[Email] Sending to ${to}: "${subject}"`);
  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: parseInt(process.env.SMTP_PORT) || 587,
      secure: false,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({ from: `"MyHomeschoolCurriculum" <${process.env.SMTP_USER}>`, to, subject, html });
    console.log(`[Email] ✅ Sent to ${to}: "${subject}"`);
    return true;
  } catch(e) { console.error(`[Email] ❌ Failed to ${to}: "${subject}" — ${e.message}`); return false; }
}

// ─── AUTH HELPERS ────────────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token || token !== process.env.ADMIN_TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.pbkdf2Sync(password, salt, 10000, 64, 'sha512').toString('hex');
  return { hash, salt };
}

function requireUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Login required' });
  const db = readDB();
  const session = (db.sessions || []).find(s => s.token === token && new Date(s.expiresAt) > new Date());
  if (!session) return res.status(401).json({ error: 'Session expired, please log in again' });
  req.userId = session.userId;
  req.userEmail = session.email;
  next();
}

// ════════════════════════════════════════════════════════════════════════════════
// ─── CURRICULUM ROUTES ───────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/curricula', (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  let results = db.curricula.filter(c => c.active);
  const { grade, style, worldview, format, subject, special, search, priceMax, sort } = req.query;
  if (search) {
    const q = search.toLowerCase();
    results = results.filter(c =>
      c.name.toLowerCase().includes(q) || (c.tagline||'').toLowerCase().includes(q) ||
      (c.description||'').toLowerCase().includes(q));
  }
  if (grade)     { const v = grade.split(',');     results = results.filter(c => v.some(x => c.grades?.includes(x))); }
  if (style)     { const v = style.split(',');     results = results.filter(c => v.some(x => c.style?.includes(x))); }
  if (worldview) { const v = worldview.split(','); results = results.filter(c => v.some(x => c.worldview?.includes(x))); }
  if (format)    { const v = format.split(',');    results = results.filter(c => v.some(x => c.format?.includes(x))); }
  if (subject)   { const v = subject.split(',');   results = results.filter(c => v.some(x => c.subject?.includes(x))); }
  if (special)   { const v = special.split(',');   results = results.filter(c => v.some(x => c.special?.includes(x))); }
  if (priceMax)  { results = results.filter(c => (c.priceMin || 0) <= parseInt(priceMax)); }
  const tierScore = { platinum: 3, gold: 2, silver: 1 };
  switch (sort) {
    case 'rating':     results.sort((a,b) => (b.rating||0) - (a.rating||0)); break;
    case 'price-low':  results.sort((a,b) => (a.priceMin||0) - (b.priceMin||0)); break;
    case 'price-high': results.sort((a,b) => (b.priceMax||0) - (a.priceMax||0)); break;
    case 'reviews':    results.sort((a,b) => (b.reviewCount||0) - (a.reviewCount||0)); break;
    default:
      results.sort((a,b) => {
        const as = (a.featured?2:0) + (tierScore[a.sponsorTier]||0);
        const bs = (b.featured?2:0) + (tierScore[b.sponsorTier]||0);
        return bs - as;
      });
  }
  res.json({ count: results.length, curricula: results });
});

app.get('/api/curricula/:slug', (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const c = db.curricula.find(c => c.slug === req.params.slug && c.active);
  if (!c) return res.status(404).json({ error: 'Curriculum not found' });
  const reviews = db.reviews.filter(r => r.curriculumId === c.id && r.approved)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ ...c, reviews });
});

app.post('/api/curricula/:id/click', (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const c = db.curricula.find(c => c.id === parseInt(req.params.id));
  if (!c) return res.status(404).json({ error: 'Not found' });
  db.affiliateClicks.push({
    id: uuidv4(), curriculumId: c.id, curriculumName: c.name, affiliateCode: c.affiliateCode,
    ip: req.ip, userAgent: req.headers['user-agent'], referrer: req.headers.referer || null,
    timestamp: new Date().toISOString()
  });
  db.analytics.totalClicks++;
  writeDB(db);
  res.json({ success: true, affiliateLink: c.affiliateLink });
});

// ─── REVIEW ROUTES ───────────────────────────────────────────────────────────
app.get('/api/reviews/:curriculumSlug', (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const reviews = db.reviews
    .filter(r => r.curriculumSlug === req.params.curriculumSlug && r.approved)
    .sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json({ count: reviews.length, reviews });
});

app.post('/api/reviews', submitLimiter, (req, res) => {
  const { curriculumId, curriculumSlug, name, location, rating, title, body, gradesUsed, yearsUsing, email } = req.body;
  if (!curriculumId || !name || !rating || !title || !body)
    return res.status(400).json({ error: 'Missing required fields' });
  if (rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
  if ((body||'').length < 20) return res.status(400).json({ error: 'Review too short (min 20 chars)' });
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const c = db.curricula.find(c => c.id === parseInt(curriculumId));
  if (!c) return res.status(404).json({ error: 'Curriculum not found' });
  const review = {
    id: db.reviews.length + 1, curriculumId: parseInt(curriculumId),
    curriculumSlug: curriculumSlug || c.slug,
    name: name.trim().substring(0,100), email: email||null,
    location: (location||'').trim().substring(0,100), rating: parseInt(rating),
    title: title.trim().substring(0,200), body: body.trim().substring(0,2000),
    gradesUsed: gradesUsed||'', yearsUsing: yearsUsing||'',
    verified: false, approved: false, createdAt: new Date().toISOString()
  };
  db.reviews.push(review);
  writeDB(db);
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    `New Review Pending — ${c.name}`,
    `<h2>New Review for ${c.name}</h2><p>${review.name}: ★${review.rating} — ${review.title}</p><p>${review.body}</p><p><a href="${process.env.SITE_URL||'http://localhost:3001'}/admin">Approve in Admin →</a></p>`);
  res.status(201).json({ success: true, message: 'Review submitted! It will appear after approval.' });
});

// ─── QUIZ ─────────────────────────────────────────────────────────────────────
app.post('/api/quiz', (req, res) => {
  const { grade, style, worldview, budget } = req.body;
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  db.quizResults.push({ id: uuidv4(), grade, style, worldview, budget, timestamp: new Date().toISOString() });
  writeDB(db);
  let matches = db.curricula.filter(c => c.active);
  const budgetMap = { free: 30, low: 200, mid: 600, high: 1200, any: 99999 };
  const maxBudget = budgetMap[budget] || 99999;
  matches = matches.filter(c => (c.priceMin||0) <= maxBudget).map(c => {
    let score = 0;
    if (grade && c.grades?.includes(grade)) score += 3;
    if (style && c.style?.includes(style)) score += 3;
    if (worldview && c.worldview?.includes(worldview)) score += 2;
    if (c.featured) score += 1;
    if ((c.rating||0) >= 4.5) score += 1;
    return { ...c, matchScore: score };
  }).sort((a,b) => b.matchScore - a.matchScore);
  res.json({ matches: matches.slice(0, 4).filter(m => m.matchScore > 0) });
});

// ─── CONTACT ─────────────────────────────────────────────────────────────────
app.post('/api/contact', submitLimiter, (req, res) => {
  const { name, email, subject, message } = req.body;
  if (!name || !email || !message) return res.status(400).json({ error: 'Name, email, and message required.' });
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const contact = {
    id: uuidv4(), name: name.trim(), email: email.trim().toLowerCase(),
    subject: (subject||'').trim(), message: message.trim().substring(0,3000),
    createdAt: new Date().toISOString(), handled: false
  };
  db.contactMessages.push(contact);
  writeDB(db);
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    `Contact: ${contact.subject||'General'}`,
    `<h2>New Message</h2><p><strong>${contact.name}</strong> &lt;${contact.email}&gt;</p><p>${contact.message.replace(/\n/g,'<br>')}</p>`);
  sendEmail(contact.email, 'Thanks for reaching out — MyHomeschoolCurriculum',
    `<p>Hi ${contact.name},</p><p>Thanks for contacting us! We'll get back to you within 1–2 business days.</p><p>— The MyHomeschoolCurriculum Team</p>`);
  res.status(201).json({ success: true, message: "Message sent! We'll be in touch within 1–2 business days." });
});

// ─── LISTING INQUIRY ─────────────────────────────────────────────────────────
app.post('/api/listing-inquiry', submitLimiter, (req, res) => {
  const { companyName, contactName, email, phone, website, curriculumName, grades, description, listingType, message } = req.body;
  if (!companyName || !contactName || !email || !curriculumName)
    return res.status(400).json({ error: 'Required fields missing.' });
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const inquiry = {
    id: uuidv4(), companyName: companyName.trim(), contactName: contactName.trim(),
    email: email.trim().toLowerCase(), phone: (phone||'').trim(), website: (website||'').trim(),
    curriculumName: curriculumName.trim(), grades: grades||[], description: (description||'').trim(),
    listingType: listingType||'affiliate', message: (message||'').trim(),
    status: 'new', createdAt: new Date().toISOString()
  };
  db.listingInquiries.push(inquiry);
  db.analytics.totalInquiries++;
  writeDB(db);
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    `New Listing Inquiry: ${inquiry.curriculumName} (${inquiry.listingType})`,
    `<h2>Publisher Inquiry</h2><p><strong>${inquiry.companyName}</strong><br>${inquiry.contactName} &lt;${inquiry.email}&gt;</p><p>Curriculum: <strong>${inquiry.curriculumName}</strong> | Type: <strong>${inquiry.listingType}</strong></p>`);
  sendEmail(inquiry.email, `Thanks for your listing inquiry — MyHomeschoolCurriculum`,
    `<p>Hi ${inquiry.contactName},</p><p>Thanks for your interest in listing <strong>${inquiry.curriculumName}</strong>! We'll be in touch within 2–3 business days.</p><p>— MyHomeschoolCurriculum Team</p>`);
  res.status(201).json({ success: true, message: "Inquiry received! We'll be in touch within 2–3 business days." });
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── USER ACCOUNT ROUTES ─────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/auth/register', authLimiter, (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email, and password required.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  if (db.users.find(u => u.email === email.toLowerCase()))
    return res.status(409).json({ error: 'An account with this email already exists.' });
  const { hash, salt } = hashPassword(password);
  const verifyToken = crypto.randomBytes(32).toString('hex');
  const user = {
    id: uuidv4(), name: name.trim(), email: email.trim().toLowerCase(),
    passwordHash: hash, passwordSalt: salt, verifyToken, emailVerified: false,
    createdAt: new Date().toISOString(), lastLoginAt: null,
    stripeCustomerId: null, activeSubscription: null
  };
  db.users.push(user);
  writeDB(db);
  const verifyUrl = `${process.env.SITE_URL||'http://localhost:3001'}/account?verify=${verifyToken}`;
  sendEmail(user.email, 'Verify your MyHomeschoolCurriculum account',
    `<h2>Welcome, ${user.name}!</h2><p>Please verify your email:</p><p><a href="${verifyUrl}" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Verify Email →</a></p>`);
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    `👤 New User Registration — ${user.email}`,
    `<h2>New User Signup</h2><p><strong>Name:</strong> ${user.name}</p><p><strong>Email:</strong> ${user.email}</p><p><strong>Date:</strong> ${user.createdAt}</p><p>Total users: ${db.users.length}</p>`);
  res.status(201).json({ success: true, message: 'Account created! Check your email to verify.' });
});

app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const user = db.users.find(u => u.email === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid email or password.' });
  const { hash } = hashPassword(password, user.passwordSalt);
  if (hash !== user.passwordHash) return res.status(401).json({ error: 'Invalid email or password.' });
  const sessionToken = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  if (!db.sessions) db.sessions = [];
  db.sessions.push({ token: sessionToken, userId: user.id, email: user.email, expiresAt });
  db.sessions = db.sessions.filter(s => new Date(s.expiresAt) > new Date());
  user.lastLoginAt = new Date().toISOString();
  writeDB(db);
  res.json({
    success: true, token: sessionToken,
    user: { id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified, activeSubscription: user.activeSubscription }
  });
});

app.post('/api/auth/verify-email', (req, res) => {
  const { token } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.verifyToken === token);
  if (!user) return res.status(400).json({ error: 'Invalid or expired verification link.' });
  user.emailVerified = true; user.verifyToken = null;
  writeDB(db);
  res.json({ success: true, message: 'Email verified!' });
});

app.post('/api/auth/request-reset', authLimiter, (req, res) => {
  const { email } = req.body;
  const db = readDB();
  const user = db.users.find(u => u.email === email?.toLowerCase());
  if (user) {
    const resetToken = crypto.randomBytes(32).toString('hex');
    user.resetToken = resetToken;
    user.resetTokenExpires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    writeDB(db);
    const resetUrl = `${process.env.SITE_URL||'http://localhost:3001'}/account?reset=${resetToken}`;
    sendEmail(user.email, 'Reset your MyHomeschoolCurriculum password',
      `<p>Hi ${user.name},</p><p>Click to reset your password (expires in 1 hour):</p><p><a href="${resetUrl}" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Reset Password →</a></p>`);
  }
  res.json({ success: true, message: 'If an account exists with that email, a reset link has been sent.' });
});

app.post('/api/auth/reset-password', authLimiter, (req, res) => {
  const { token, password } = req.body;
  if (!token || !password || password.length < 8)
    return res.status(400).json({ error: 'Token and new password (8+ chars) required.' });
  const db = readDB();
  const user = db.users.find(u => u.resetToken === token && new Date(u.resetTokenExpires) > new Date());
  if (!user) return res.status(400).json({ error: 'Invalid or expired reset link.' });
  const { hash, salt } = hashPassword(password);
  user.passwordHash = hash; user.passwordSalt = salt;
  user.resetToken = null; user.resetTokenExpires = null;
  writeDB(db);
  res.json({ success: true, message: 'Password reset! You can now log in.' });
});

app.get('/api/auth/me', requireUser, (req, res) => {
  const db = readDB();
  const user = db.users.find(u => u.id === req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  res.json({ id: user.id, name: user.name, email: user.email, emailVerified: user.emailVerified,
    activeSubscription: user.activeSubscription, createdAt: user.createdAt });
});

app.post('/api/auth/logout', requireUser, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const db = readDB();
  db.sessions = (db.sessions||[]).filter(s => s.token !== token);
  writeDB(db);
  res.json({ success: true });
});

// ─── USER FAVORITES ───────────────────────────────────────────────────────────
app.get('/api/favorites', requireUser, (req, res) => {
  const db = readDB();
  const favIds = (db.userFavorites||[]).filter(f => f.userId === req.userId).map(f => f.curriculumId);
  res.json({ favorites: db.curricula.filter(c => favIds.includes(c.id)) });
});

app.post('/api/favorites/:curriculumId', requireUser, (req, res) => {
  const db = readDB();
  const curriculumId = parseInt(req.params.curriculumId);
  if (!db.curricula.find(c => c.id === curriculumId)) return res.status(404).json({ error: 'Not found' });
  if (db.userFavorites.find(f => f.userId === req.userId && f.curriculumId === curriculumId))
    return res.json({ success: true, message: 'Already saved' });
  db.userFavorites.push({ id: uuidv4(), userId: req.userId, curriculumId, savedAt: new Date().toISOString() });
  writeDB(db);
  res.json({ success: true, message: 'Saved to favorites!' });
});

app.delete('/api/favorites/:curriculumId', requireUser, (req, res) => {
  const db = readDB();
  db.userFavorites = db.userFavorites.filter(
    f => !(f.userId === req.userId && f.curriculumId === parseInt(req.params.curriculumId)));
  writeDB(db);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── STRIPE BILLING ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

const STRIPE_PRICES = {
  silver:   process.env.STRIPE_PRICE_SILVER   || null,
  gold:     process.env.STRIPE_PRICE_GOLD     || null,
  platinum: process.env.STRIPE_PRICE_PLATINUM || null,
};

app.post('/api/billing/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured. Add STRIPE_SECRET_KEY to .env' });
  const { tier, email, companyName } = req.body;
  if (!tier || !STRIPE_PRICES[tier]) return res.status(400).json({ error: 'Invalid tier. Valid: silver, gold, platinum' });
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_PRICES[tier], quantity: 1 }],
      metadata: { tier, companyName: companyName||'' },
      success_url: `${process.env.SITE_URL||'http://localhost:3001'}/publisher?success=1&tier=${tier}`,
      cancel_url:  `${process.env.SITE_URL||'http://localhost:3001'}/publisher?canceled=1`,
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/billing/create-portal', requireUser, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const db = readDB();
  const user = db.users.find(u => u.id === req.userId);
  if (!user?.stripeCustomerId) return res.status(400).json({ error: 'No billing account found' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: user.stripeCustomerId,
      return_url: `${process.env.SITE_URL||'http://localhost:3001'}/account`
    });
    res.json({ url: session.url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/billing/webhook', (req, res) => {
  if (!stripe) return res.status(503).send('Billing not configured');
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch(e) { return res.status(400).send(`Webhook Error: ${e.message}`); }
  const db = readDB();
  if (event.type === 'checkout.session.completed') {
    const s = event.data.object;
    db.stripeSubscriptions.push({
      id: uuidv4(), stripeSessionId: s.id, stripeSubscriptionId: s.subscription,
      stripeCustomerId: s.customer, email: s.customer_email,
      tier: s.metadata.tier, companyName: s.metadata.companyName,
      status: 'active', createdAt: new Date().toISOString()
    });
    sendEmail(process.env.ADMIN_EMAIL||process.env.SMTP_USER,
      `🎉 New ${s.metadata.tier} Subscription — ${s.customer_email}`,
      `<h2>New Subscription!</h2><p>Tier: <strong>${s.metadata.tier}</strong></p><p>Email: ${s.customer_email}</p>`);
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = db.stripeSubscriptions.find(s => s.stripeSubscriptionId === event.data.object.id);
    if (sub) sub.status = 'canceled';
  }
  writeDB(db);
  res.json({ received: true });
});

app.get('/api/billing/subscriptions', requireAdmin, (req, res) => {
  const db = readDB();
  res.json({ subscriptions: db.stripeSubscriptions||[] });
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── NEWSLETTER ──────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

app.post('/api/newsletter/subscribe', submitLimiter, async (req, res) => {
  const { email, name, source } = req.body;
  if (!email || !/\S+@\S+\.\S+/.test(email))
    return res.status(400).json({ error: 'Valid email required.' });
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  if ((db.newsletterSubscribers||[]).find(s => s.email === email.toLowerCase()))
    return res.json({ success: true, message: "You're already subscribed!" });
  const subscriber = {
    id: uuidv4(), email: email.trim().toLowerCase(), name: (name||'').trim(),
    source: source||'website', subscribedAt: new Date().toISOString(), active: true
  };
  db.newsletterSubscribers.push(subscriber);
  writeDB(db);
  if (mailchimp && process.env.MAILCHIMP_LIST_ID) {
    try {
      await mailchimp.lists.addListMember(process.env.MAILCHIMP_LIST_ID, {
        email_address: subscriber.email, status: 'subscribed',
        merge_fields: { FNAME: subscriber.name }
      });
    } catch(e) { console.log('Mailchimp error:', e.message); }
  }
  sendEmail(subscriber.email, 'Welcome to MyHomeschoolCurriculum! 🧭',
    `<h2>Welcome${subscriber.name ? ', '+subscriber.name : ''}!</h2><p>Thanks for subscribing! You'll receive new reviews, deals, and homeschool tips.</p><p><a href="${process.env.SITE_URL||'http://localhost:3001'}">Browse curricula →</a></p>`);
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    `📬 New Newsletter Subscriber — ${subscriber.email}`,
    `<h2>New Newsletter Signup</h2><p><strong>Email:</strong> ${subscriber.email}</p>${subscriber.name ? `<p><strong>Name:</strong> ${subscriber.name}</p>` : ''}<p><strong>Source:</strong> ${subscriber.source||'website'}</p><p><strong>Date:</strong> ${subscriber.subscribedAt}</p><p>Total active subscribers: ${(db.newsletterSubscribers||[]).filter(s => s.active).length}</p>`);
  res.status(201).json({ success: true, message: "You're subscribed! Check your inbox for a welcome email." });
});

app.post('/api/newsletter/unsubscribe', (req, res) => {
  const { email } = req.body;
  const db = readDB();
  const sub = (db.newsletterSubscribers||[]).find(s => s.email === email?.toLowerCase());
  if (sub) { sub.active = false; writeDB(db); }
  res.json({ success: true, message: "You've been unsubscribed." });
});

app.get('/api/newsletter/subscribers', requireAdmin, (req, res) => {
  const db = readDB();
  const active = (db.newsletterSubscribers||[]).filter(s => s.active);
  res.json({ count: active.length, subscribers: active });
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── BLOG ROUTES ─────────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/blog', (req, res) => {
  const db = readDB();
  const posts = (db.blogPosts||[]).filter(p => p.published)
    .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  res.json({ count: posts.length, posts: posts.map(p => ({ ...p, content: undefined })) });
});

app.get('/api/blog/:slug', (req, res) => {
  const db = readDB();
  const post = (db.blogPosts||[]).find(p => p.slug === req.params.slug && p.published);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  res.json(post);
});

app.post('/api/blog', requireAdmin, (req, res) => {
  const { title, slug, excerpt, content, category, tags, published, featuredImage } = req.body;
  if (!title || !content) return res.status(400).json({ error: 'Title and content required.' });
  const db = readDB();
  const post = {
    id: uuidv4(),
    slug: slug || title.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/^-|-$/g,''),
    title, excerpt: excerpt||(content.substring(0,160)+'…'), content,
    category: category||'General', tags: tags||[], featuredImage: featuredImage||null,
    published: published !== false,
    publishedAt: published !== false ? new Date().toISOString() : null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  if (!db.blogPosts) db.blogPosts = [];
  db.blogPosts.push(post);
  writeDB(db);
  res.status(201).json({ success: true, post });
});

app.put('/api/blog/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const post = (db.blogPosts||[]).find(p => p.id === req.params.id);
  if (!post) return res.status(404).json({ error: 'Post not found' });
  Object.assign(post, req.body, { updatedAt: new Date().toISOString() });
  if (req.body.published && !post.publishedAt) post.publishedAt = new Date().toISOString();
  writeDB(db);
  res.json({ success: true, post });
});

app.delete('/api/blog/:id', requireAdmin, (req, res) => {
  const db = readDB();
  if (db.blogPosts) db.blogPosts = db.blogPosts.filter(p => p.id !== req.params.id);
  writeDB(db);
  res.json({ success: true });
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── STATE HOMESCHOOL LAWS ───────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

const STATE_LAWS = {
  "Alabama":{"requirement":"Low","difficulty":"Easy","description":"Alabama parents must notify their local superintendent. Parent must have a high school diploma or GED.","withdrawalNotice":"Yes — notify superintendent","subjectRequirements":"Not specified","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/alabama"},
  "Alaska":{"requirement":"Low","difficulty":"Easy","description":"Alaska homeschoolers may operate as a private school or via state correspondence. Very relaxed.","withdrawalNotice":"No","subjectRequirements":"None if private school","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/alaska"},
  "Arizona":{"requirement":"Low","difficulty":"Easy","description":"Arizona requires an affidavit filed with the county school superintendent. Extremely family-friendly.","withdrawalNotice":"Affidavit only","subjectRequirements":"Reading, grammar, math, social studies, science","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/arizona"},
  "Arkansas":{"requirement":"Moderate","difficulty":"Moderate","description":"Arkansas requires annual notice, a portfolio, and standardized testing in grades 5, 7, and 10.","withdrawalNotice":"Yes — annual","subjectRequirements":"Several required subjects","testingRequirements":"Grades 5, 7, 10","portfolioRequirements":"Yes — parent maintained","moreInfo":"https://hslda.org/legal/arkansas"},
  "California":{"requirement":"Moderate","difficulty":"Moderate","description":"California homeschoolers typically file a Private School Affidavit (PSA) each year.","withdrawalNotice":"Annual PSA filing","subjectRequirements":"Several required subjects","testingRequirements":"None (as private school)","portfolioRequirements":"Records recommended","moreInfo":"https://hslda.org/legal/california"},
  "Colorado":{"requirement":"Low","difficulty":"Easy","description":"Colorado requires annual notification and choice of assessment method. Parent must have high school diploma.","withdrawalNotice":"Yes — annual","subjectRequirements":"Reading, writing, math, history, science, constitution","testingRequirements":"Annual assessment (parent choice)","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/colorado"},
  "Connecticut":{"requirement":"Moderate","difficulty":"Moderate","description":"Connecticut requires annual notice and a portfolio of the child's work.","withdrawalNotice":"Yes — annual to superintendent","subjectRequirements":"Several required subjects","testingRequirements":"None","portfolioRequirements":"Yes","moreInfo":"https://hslda.org/legal/connecticut"},
  "Florida":{"requirement":"Moderate","difficulty":"Moderate","description":"Florida requires annual notice and annual evaluation via portfolio, standardized test, or certified teacher assessment.","withdrawalNotice":"Yes — annual","subjectRequirements":"Reading, math, language arts, science, social studies, health, PE, art","testingRequirements":"Annual evaluation (multiple options)","portfolioRequirements":"Yes — portfolio maintained","moreInfo":"https://hslda.org/legal/florida"},
  "Georgia":{"requirement":"Low","difficulty":"Easy","description":"Georgia requires annual declaration and monthly attendance records.","withdrawalNotice":"Yes — annual declaration","subjectRequirements":"Reading, language arts, math, social studies, science, health/PE","testingRequirements":"Grades 3, 6, 9","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/georgia"},
  "Idaho":{"requirement":"Low","difficulty":"Easy","description":"Idaho has no homeschool laws — falls under compulsory attendance exemption. Extremely free.","withdrawalNotice":"No","subjectRequirements":"None","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/idaho"},
  "Illinois":{"requirement":"Low","difficulty":"Easy","description":"Illinois homeschool operates as a private school — no notice required. Must teach required subjects.","withdrawalNotice":"No","subjectRequirements":"Language arts, math, science, social studies, fine arts, health/PE","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/illinois"},
  "Indiana":{"requirement":"Low","difficulty":"Easy","description":"Indiana only requires education be 'equivalent' in length to public school. Very low oversight.","withdrawalNotice":"No","subjectRequirements":"None specifically","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/indiana"},
  "Iowa":{"requirement":"Moderate","difficulty":"Moderate","description":"Iowa requires competent private instruction and either licensed teacher instruction or portfolio evaluation.","withdrawalNotice":"Yes","subjectRequirements":"Required subjects","testingRequirements":"Annual evaluation","portfolioRequirements":"Portfolio or licensed teacher review","moreInfo":"https://hslda.org/legal/iowa"},
  "Kansas":{"requirement":"Low","difficulty":"Easy","description":"Kansas homeschool operates as a non-accredited private school. No notice required.","withdrawalNotice":"No","subjectRequirements":"None","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/kansas"},
  "Kentucky":{"requirement":"Low","difficulty":"Easy","description":"Kentucky homeschoolers operate as a private school. Must notify local school and keep attendance records.","withdrawalNotice":"Yes","subjectRequirements":"Substantial list of subjects","testingRequirements":"None","portfolioRequirements":"Attendance records","moreInfo":"https://hslda.org/legal/kentucky"},
  "Louisiana":{"requirement":"Moderate","difficulty":"Moderate","description":"Louisiana requires annual enrollment in an approved home study or church school program.","withdrawalNotice":"Annual enrollment","subjectRequirements":"Curriculum approval required","testingRequirements":"Varies","portfolioRequirements":"Varies","moreInfo":"https://hslda.org/legal/louisiana"},
  "Maine":{"requirement":"Moderate","difficulty":"Moderate","description":"Maine requires annual notice and annual evaluation.","withdrawalNotice":"Yes — annually","subjectRequirements":"English, math, science, social studies, health/PE, fine arts, Maine studies","testingRequirements":"Annual evaluation (multiple options)","portfolioRequirements":"Yes — one option","moreInfo":"https://hslda.org/legal/maine"},
  "Maryland":{"requirement":"Moderate","difficulty":"Moderate","description":"Maryland requires annual supervision through portfolio or umbrella school program.","withdrawalNotice":"Yes","subjectRequirements":"Yes — required subjects","testingRequirements":"Portfolio review or umbrella program","portfolioRequirements":"Yes","moreInfo":"https://hslda.org/legal/maryland"},
  "Massachusetts":{"requirement":"High","difficulty":"Strict","description":"Massachusetts has complex homeschool laws — approval from local school committee required.","withdrawalNotice":"Yes — approval required","subjectRequirements":"Many required subjects","testingRequirements":"Annual assessment","portfolioRequirements":"Yes","moreInfo":"https://hslda.org/legal/massachusetts"},
  "Michigan":{"requirement":"Low","difficulty":"Easy","description":"Michigan has no homeschool law — families operate under the compulsory education exemption.","withdrawalNotice":"No","subjectRequirements":"None","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/michigan"},
  "Minnesota":{"requirement":"Moderate","difficulty":"Moderate","description":"Minnesota requires annual notification and quarterly reports to the school district.","withdrawalNotice":"Yes — annual","subjectRequirements":"Yes — grade-level subjects","testingRequirements":"Annual nationally normed test or evaluation","portfolioRequirements":"Quarterly reports","moreInfo":"https://hslda.org/legal/minnesota"},
  "Mississippi":{"requirement":"Low","difficulty":"Easy","description":"Mississippi requires enrollment in an umbrella school or church school program.","withdrawalNotice":"Yes — enroll in umbrella","subjectRequirements":"Curriculum through umbrella school","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/mississippi"},
  "Missouri":{"requirement":"Low","difficulty":"Easy","description":"Missouri requires annual notice to the local school district and keeping records.","withdrawalNotice":"Yes — annual","subjectRequirements":"Language arts, math, science, social studies, health","testingRequirements":"None","portfolioRequirements":"Attendance, progress, immunization records","moreInfo":"https://hslda.org/legal/missouri"},
  "Montana":{"requirement":"Low","difficulty":"Easy","description":"Montana requires annual notice to county superintendent. Very parent-friendly.","withdrawalNotice":"Yes — annual","subjectRequirements":"Core subjects","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/montana"},
  "Nebraska":{"requirement":"Moderate","difficulty":"Moderate","description":"Nebraska requires annual filing with the state Department of Education.","withdrawalNotice":"Yes — annual to state DOE","subjectRequirements":"Language arts, math, science, social studies, health","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/nebraska"},
  "Nevada":{"requirement":"Moderate","difficulty":"Moderate","description":"Nevada requires annual notification and annual standardized testing.","withdrawalNotice":"Yes — annual","subjectRequirements":"Required subjects","testingRequirements":"Annual standardized test","portfolioRequirements":"Records recommended","moreInfo":"https://hslda.org/legal/nevada"},
  "New Hampshire":{"requirement":"Moderate","difficulty":"Moderate","description":"New Hampshire requires annual notice and annual assessment.","withdrawalNotice":"Yes — annual","subjectRequirements":"Yes","testingRequirements":"Annual assessment (multiple options)","portfolioRequirements":"Yes","moreInfo":"https://hslda.org/legal/new-hampshire"},
  "New Jersey":{"requirement":"Low","difficulty":"Easy","description":"New Jersey has no formal homeschool law — no notice required.","withdrawalNotice":"No","subjectRequirements":"Equivalent to public school subjects","testingRequirements":"None","portfolioRequirements":"None required","moreInfo":"https://hslda.org/legal/new-jersey"},
  "New Mexico":{"requirement":"Low","difficulty":"Easy","description":"New Mexico requires annual notice and 'equivalent' instruction. Very relaxed.","withdrawalNotice":"Yes — annual","subjectRequirements":"Language arts, math, science, social studies","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/new-mexico"},
  "New York":{"requirement":"High","difficulty":"Strict","description":"New York has demanding homeschool laws — annual IHIP, quarterly reports, and annual assessments required.","withdrawalNotice":"Yes — detailed IHIP required","subjectRequirements":"Extensive required subject list","testingRequirements":"Annual assessment grades 4+","portfolioRequirements":"Quarterly reports","moreInfo":"https://hslda.org/legal/new-york"},
  "North Carolina":{"requirement":"Low","difficulty":"Easy","description":"North Carolina requires annual notice and an annual nationally standardized test.","withdrawalNotice":"Yes — annual to state","subjectRequirements":"None specified","testingRequirements":"Annual nationally standardized test","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/north-carolina"},
  "North Dakota":{"requirement":"High","difficulty":"Strict","description":"North Dakota requires parent with teaching certificate or bachelor's degree, or supervision by certified teacher.","withdrawalNotice":"Yes — annual","subjectRequirements":"Yes — grade-level subjects","testingRequirements":"Annual standardized testing","portfolioRequirements":"Yes","moreInfo":"https://hslda.org/legal/north-dakota"},
  "Ohio":{"requirement":"Moderate","difficulty":"Moderate","description":"Ohio requires annual notice and assessment. Parent must have high school diploma.","withdrawalNotice":"Yes — annual","subjectRequirements":"Language arts, math, science, social studies, health, fine arts, electives","testingRequirements":"Annual assessment (multiple options)","portfolioRequirements":"Portfolio is one option","moreInfo":"https://hslda.org/legal/ohio"},
  "Oklahoma":{"requirement":"Low","difficulty":"Easy","description":"Oklahoma has very relaxed homeschool laws — no notice required, operate as a private school.","withdrawalNotice":"No","subjectRequirements":"None specified","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/oklahoma"},
  "Oregon":{"requirement":"Moderate","difficulty":"Moderate","description":"Oregon requires annual notice and testing in grades 3, 5, 8, and 10.","withdrawalNotice":"Yes — annual","subjectRequirements":"Substantial required subjects","testingRequirements":"Grades 3, 5, 8, 10","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/oregon"},
  "Pennsylvania":{"requirement":"High","difficulty":"Strict","description":"Pennsylvania has strict homeschool laws — detailed affidavit, portfolio, and PA-certified teacher evaluation required.","withdrawalNotice":"Yes — detailed annual affidavit","subjectRequirements":"Extensive required subjects by grade","testingRequirements":"Annual portfolio evaluation by certified teacher","portfolioRequirements":"Detailed portfolio required","moreInfo":"https://hslda.org/legal/pennsylvania"},
  "Rhode Island":{"requirement":"Moderate","difficulty":"Moderate","description":"Rhode Island requires annual approval from the local school committee.","withdrawalNotice":"Yes — annual approval","subjectRequirements":"Yes","testingRequirements":"Annual assessment","portfolioRequirements":"Yes","moreInfo":"https://hslda.org/legal/rhode-island"},
  "South Carolina":{"requirement":"Low","difficulty":"Easy","description":"South Carolina offers three options: self-teach, use an association, or use an umbrella school.","withdrawalNotice":"Yes — choose option annually","subjectRequirements":"Required subjects","testingRequirements":"Annual standardized test (one option)","portfolioRequirements":"Varies by option","moreInfo":"https://hslda.org/legal/south-carolina"},
  "South Dakota":{"requirement":"Low","difficulty":"Easy","description":"South Dakota requires annual notice and assessment. Parent must have high school diploma.","withdrawalNotice":"Yes — annual","subjectRequirements":"None specified","testingRequirements":"Annual assessment grades 2+","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/south-dakota"},
  "Tennessee":{"requirement":"Moderate","difficulty":"Moderate","description":"Tennessee offers three options including independent or church-related school.","withdrawalNotice":"Yes","subjectRequirements":"Yes — multiple required subjects","testingRequirements":"Annual standardized test grades 5, 7, 9 (some options)","portfolioRequirements":"Varies","moreInfo":"https://hslda.org/legal/tennessee"},
  "Texas":{"requirement":"Low","difficulty":"Easy","description":"Texas treats homeschool as a private school. No notice required, complete curriculum freedom.","withdrawalNotice":"No","subjectRequirements":"Reading, spelling, grammar, math, citizenship in a visual/textual curriculum","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/texas"},
  "Utah":{"requirement":"Low","difficulty":"Easy","description":"Utah requires annual affidavit of exemption. Very parent-friendly.","withdrawalNotice":"Yes — annual affidavit","subjectRequirements":"None specified","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/utah"},
  "Vermont":{"requirement":"Moderate","difficulty":"Moderate","description":"Vermont requires annual enrollment notice and annual assessment.","withdrawalNotice":"Yes — annual","subjectRequirements":"Multiple required subjects","testingRequirements":"Annual assessment (multiple options)","portfolioRequirements":"Portfolio is one option","moreInfo":"https://hslda.org/legal/vermont"},
  "Virginia":{"requirement":"Moderate","difficulty":"Moderate","description":"Virginia requires annual notice and test scores OR portfolio evaluation by a certified teacher.","withdrawalNotice":"Yes — annual to superintendent","subjectRequirements":"Yes","testingRequirements":"Annual assessment (test or portfolio)","portfolioRequirements":"Portfolio is one option","moreInfo":"https://hslda.org/legal/virginia"},
  "Washington":{"requirement":"Moderate","difficulty":"Moderate","description":"Washington requires annual declaration and assessment in grades 4, 8, and 11.","withdrawalNotice":"Yes — annual declaration","subjectRequirements":"Occupational ed, science, math, language, social studies, history, health, PE, art","testingRequirements":"Grades 4, 8, 11","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/washington"},
  "West Virginia":{"requirement":"Moderate","difficulty":"Moderate","description":"West Virginia requires annual notice and annual review of portfolio by a certified teacher.","withdrawalNotice":"Yes — annual","subjectRequirements":"Yes — required subjects","testingRequirements":"Annual portfolio review","portfolioRequirements":"Yes — annual portfolio","moreInfo":"https://hslda.org/legal/west-virginia"},
  "Wisconsin":{"requirement":"Low","difficulty":"Easy","description":"Wisconsin requires annual notice to the school district. Very simple and parent-friendly.","withdrawalNotice":"Yes — annual","subjectRequirements":"Required subjects","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/wisconsin"},
  "Wyoming":{"requirement":"Low","difficulty":"Easy","description":"Wyoming has no homeschool law — families are exempt from compulsory attendance.","withdrawalNotice":"No","subjectRequirements":"None","testingRequirements":"None","portfolioRequirements":"None","moreInfo":"https://hslda.org/legal/wyoming"}
};

app.get('/api/legal/states', (req, res) => {
  const states = Object.entries(STATE_LAWS).map(([state, data]) => ({
    state, requirement: data.requirement, difficulty: data.difficulty, description: data.description
  }));
  res.json({ count: states.length, states });
});

app.get('/api/legal/states/:state', (req, res) => {
  const state = decodeURIComponent(req.params.state);
  const data = STATE_LAWS[state];
  if (!data) return res.status(404).json({ error: 'State not found' });
  res.json({ state, ...data });
});

// ════════════════════════════════════════════════════════════════════════════════
// ─── FULL ANALYTICS ──────────────────────────────────────────────────────────
// ════════════════════════════════════════════════════════════════════════════════

app.get('/api/analytics', requireAdmin, (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const clicksByCurriculum = {};
  (db.affiliateClicks||[]).forEach(c => { clicksByCurriculum[c.curriculumName] = (clicksByCurriculum[c.curriculumName]||0) + 1; });
  const recentClicks = (db.affiliateClicks||[]).filter(c => new Date(c.timestamp) > thirtyDaysAgo).length;
  const quizGrades = {}, quizStyles = {}, quizWorldviews = {};
  (db.quizResults||[]).forEach(r => {
    if (r.grade) quizGrades[r.grade] = (quizGrades[r.grade]||0) + 1;
    if (r.style) quizStyles[r.style] = (quizStyles[r.style]||0) + 1;
    if (r.worldview) quizWorldviews[r.worldview] = (quizWorldviews[r.worldview]||0) + 1;
  });
  const activeSubs = (db.stripeSubscriptions||[]).filter(s => s.status === 'active');
  const tierRevenue = { silver: 49, gold: 149, platinum: 299 };
  const estimatedMRR = activeSubs.reduce((sum, s) => sum + (tierRevenue[s.tier]||0), 0);
  res.json({
    overview: {
      totalCurricula: db.curricula.filter(c => c.active).length,
      totalReviews: (db.reviews||[]).length,
      pendingReviews: (db.reviews||[]).filter(r => !r.approved).length,
      totalClicks: (db.affiliateClicks||[]).length,
      recentClicks,
      totalInquiries: (db.listingInquiries||[]).length,
      pendingInquiries: (db.listingInquiries||[]).filter(i => i.status === 'new').length,
      totalMessages: (db.contactMessages||[]).length,
      totalUsers: (db.users||[]).length,
      newsletterSubscribers: (db.newsletterSubscribers||[]).filter(s => s.active).length,
      activeSubscriptions: activeSubs.length,
      estimatedMRR,
      totalBlogPosts: (db.blogPosts||[]).filter(p => p.published).length,
    },
    clicksByCurriculum,
    quizInsights: { grades: quizGrades, styles: quizStyles, worldviews: quizWorldviews },
    recentInquiries: (db.listingInquiries||[]).slice(-10).reverse(),
    pendingReviews: (db.reviews||[]).filter(r => !r.approved).slice(-10),
    recentUsers: (db.users||[]).slice(-5).reverse().map(u => ({
      id: u.id, name: u.name, email: u.email, createdAt: u.createdAt
    })),
    subscriptions: activeSubs
  });
});

// ─── FULL ADMIN CRUD ─────────────────────────────────────────────────────────
app.get('/api/admin/curricula', requireAdmin, (req, res) => res.json(readDB().curricula));
app.put('/api/admin/curricula/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const idx = db.curricula.findIndex(c => c.id === parseInt(req.params.id));
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  db.curricula[idx] = { ...db.curricula[idx], ...req.body, updatedAt: new Date().toISOString() };
  writeDB(db); res.json({ success: true, curriculum: db.curricula[idx] });
});
app.post('/api/admin/curricula', requireAdmin, (req, res) => {
  const db = readDB();
  const c = { id: Math.max(0, ...db.curricula.map(c => c.id)) + 1, ...req.body, active: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  db.curricula.push(c); writeDB(db);
  res.status(201).json({ success: true, curriculum: c });
});
app.put('/api/admin/reviews/:id/approve', requireAdmin, (req, res) => {
  const db = readDB();
  const review = (db.reviews||[]).find(r => r.id === parseInt(req.params.id));
  if (!review) return res.status(404).json({ error: 'Not found' });
  review.approved = true; review.approvedAt = new Date().toISOString();
  const c = db.curricula.find(c => c.id === review.curriculumId);
  if (c) {
    const approved = db.reviews.filter(r => r.curriculumId === c.id && r.approved);
    c.rating = Math.round(approved.reduce((s,r) => s + r.rating, 0) / approved.length * 10) / 10;
    c.reviewCount = approved.length;
  }
  writeDB(db);
  if (review.email) {
    const currName = c ? c.name : 'a curriculum';
    sendEmail(review.email, `Your review of ${currName} is now live! ⭐`,
      `<h2>Your review has been approved!</h2><p>Hi ${review.name},</p><p>Thanks for sharing your experience with <strong>${currName}</strong>. Your review is now live on MyHomeschoolCurriculum and helping other families make their decision.</p><p><a href="${process.env.SITE_URL||'http://localhost:3001'}" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">See it on the site →</a></p>`);
  }
  res.json({ success: true });
});
app.delete('/api/admin/reviews/:id', requireAdmin, (req, res) => {
  const db = readDB();
  db.reviews = (db.reviews||[]).filter(r => r.id !== parseInt(req.params.id));
  writeDB(db); res.json({ success: true });
});
app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  const db = readDB(); res.json({ inquiries: (db.listingInquiries||[]).slice().reverse() });
});
app.put('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const inq = (db.listingInquiries||[]).find(i => i.id === req.params.id);
  if (!inq) return res.status(404).json({ error: 'Not found' });
  Object.assign(inq, req.body); writeDB(db); res.json({ success: true });
});
app.get('/api/admin/messages', requireAdmin, (req, res) => {
  const db = readDB(); res.json({ messages: (db.contactMessages||[]).slice().reverse() });
});
app.put('/api/admin/messages/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const msg = (db.contactMessages||[]).find(m => m.id === req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  Object.assign(msg, req.body); writeDB(db); res.json({ success: true });
});
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const db = readDB();
  res.json({ users: (db.users||[]).map(u => ({ id: u.id, name: u.name, email: u.email, emailVerified: u.emailVerified, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt })) });
});
app.get('/api/admin/blog', requireAdmin, (req, res) => {
  const db = readDB(); res.json({ posts: db.blogPosts||[] });
});

// ─── SEO — SITEMAP + ROBOTS ──────────────────────────────────────────────────
app.get('/robots.txt', (req, res) => {
  const siteUrl = process.env.SITE_URL || `http://localhost:${PORT}`;
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /api/\n\nSitemap: ${siteUrl}/sitemap.xml\n`
  );
});

app.get('/sitemap.xml', (req, res) => {
  const db = readDB();
  const siteUrl = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const posts = (db.blogPosts || []).filter(p => p.published);
  const curricula = (db.curricula || []).filter(c => c.active !== false);
  const states = Object.keys(STATE_LAWS || {});

  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'daily' },
    { loc: '/blog', priority: '0.9', changefreq: 'weekly' },
    { loc: '/legal', priority: '0.7', changefreq: 'monthly' },
    { loc: '/publisher', priority: '0.6', changefreq: 'monthly' },
    ...posts.map(p => ({ loc: `/blog?post=${p.slug}`, priority: '0.8', changefreq: 'monthly' })),
    ...states.map(s => ({ loc: `/legal?state=${encodeURIComponent(s)}`, priority: '0.5', changefreq: 'yearly' })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${siteUrl}${u.loc}</loc>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.type('application/xml').send(xml);
});

// ─── SERVE FRONTEND ──────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin/index.html')));
app.get('/publisher', (req, res) => res.sendFile(path.join(__dirname, 'frontend/publisher.html')));
app.get(['/blog', '/legal', '/account'], (req, res) => {
  const page = req.path.replace('/', '') + '.html';
  const file = path.join(__dirname, 'frontend', page);
  if (fs.existsSync(file)) res.sendFile(file);
  else res.sendFile(path.join(__dirname, 'frontend/index.html'));
});
app.use((req, res, next) => {
  if (req.path.startsWith('/api')) return next();
  const file = path.join(__dirname, 'frontend/index.html');
  if (fs.existsSync(file)) res.sendFile(file);
  else res.status(404).send('Not found');
});

// ─── START ───────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n🧭 MyHomeschoolCurriculum API v2.0 → http://localhost:${PORT}`);
  console.log(`   Stripe:     ${stripe ? '✅ configured' : '⚠️  not configured (add STRIPE_SECRET_KEY)'}`);
  console.log(`   Email:      ${process.env.SMTP_USER ? '✅ configured' : '⚠️  not configured (add SMTP_* vars)'}`);
  console.log(`   Newsletter: ${mailchimp ? '✅ Mailchimp connected' : '⚠️  local only (add MAILCHIMP_API_KEY)'}\n`);
});

module.exports = app;

// ─── PUBLISHER PORTAL ────────────────────────────────────────────────────────

// Publisher registration
app.post('/api/publisher/register', submitLimiter, (req, res) => {
  const { name, email, password, companyName, website } = req.body;
  if (!name || !email || !password || !companyName)
    return res.status(400).json({ error: 'Name, email, password, and company name required.' });
  if (password.length < 8)
    return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  const db = readDB();
  if (!db.publishers) db.publishers = [];
  if (db.publishers.find(p => p.email === email.toLowerCase()))
    return res.status(409).json({ error: 'An account with this email already exists.' });
  const { hash, salt } = hashPassword(password);
  const publisher = {
    id: uuidv4(), name: name.trim(), email: email.trim().toLowerCase(),
    companyName: companyName.trim(), website: website || '',
    passwordHash: hash, passwordSalt: salt,
    status: 'pending', tier: null, approved: false,
    createdAt: new Date().toISOString(), lastLoginAt: null,
    curriculumIds: [], stripeCustomerId: null, stripeSubscriptionId: null,
  };
  db.publishers.push(publisher);
  if (!db.publisherSessions) db.publisherSessions = [];
  writeDB(db);
  sendEmail(process.env.ADMIN_EMAIL, 'New Publisher Registration — My Homeschool Curriculum',
    `<h2>New publisher registered</h2><p><strong>${name}</strong> (${companyName}) registered at ${email}.</p><p><a href="${process.env.SITE_URL||'http://localhost:3001'}/admin">Review in Admin →</a></p>`);
  res.status(201).json({ success: true, message: 'Account created! Our team will review and approve your account within 2 business days.' });
});

// Publisher login
app.post('/api/publisher/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
  const db = readDB();
  if (!db.publishers) return res.status(401).json({ error: 'Invalid email or password.' });
  const publisher = db.publishers.find(p => p.email === email.toLowerCase());
  if (!publisher) return res.status(401).json({ error: 'Invalid email or password.' });
  const { hash } = hashPassword(password, publisher.passwordSalt);
  if (hash !== publisher.passwordHash) return res.status(401).json({ error: 'Invalid email or password.' });
  const token = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  if (!db.publisherSessions) db.publisherSessions = [];
  db.publisherSessions.push({ token, publisherId: publisher.id, expiresAt });
  db.publisherSessions = db.publisherSessions.filter(s => new Date(s.expiresAt) > new Date());
  publisher.lastLoginAt = new Date().toISOString();
  writeDB(db);
  res.json({ success: true, token, publisher: {
    id: publisher.id, name: publisher.name, email: publisher.email,
    companyName: publisher.companyName, status: publisher.status,
    tier: publisher.tier, approved: publisher.approved, website: publisher.website
  }});
});

// Publisher auth middleware
function requirePublisher(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Authentication required.' });
  const db = readDB();
  const session = (db.publisherSessions||[]).find(s => s.token === token && new Date(s.expiresAt) > new Date());
  if (!session) return res.status(401).json({ error: 'Session expired. Please log in again.' });
  req.publisherId = session.publisherId;
  next();
}

// Get publisher profile + stats
app.get('/api/publisher/me', requirePublisher, (req, res) => {
  const db = readDB();
  const publisher = (db.publishers||[]).find(p => p.id === req.publisherId);
  if (!publisher) return res.status(404).json({ error: 'Publisher not found.' });

  // Get their curricula
  const curricula = (db.curricula||[]).filter(c => publisher.curriculumIds.includes(c.id));

  // Aggregate click stats for their curricula
  const clicks = (db.affiliateClicks||[]).filter(c => publisher.curriculumIds.includes(c.curriculumId));
  const clicksByDay = {};
  clicks.forEach(c => {
    const day = c.createdAt?.slice(0, 10) || 'unknown';
    clicksByDay[day] = (clicksByDay[day] || 0) + 1;
  });

  // Reviews for their curricula
  const reviews = (db.reviews||[]).filter(r =>
    publisher.curriculumIds.includes(r.curriculumId) && r.approved
  );

  res.json({
    publisher: {
      id: publisher.id, name: publisher.name, email: publisher.email,
      companyName: publisher.companyName, website: publisher.website,
      status: publisher.status, tier: publisher.tier, approved: publisher.approved,
      createdAt: publisher.createdAt, lastLoginAt: publisher.lastLoginAt,
      stripeSubscriptionId: publisher.stripeSubscriptionId
    },
    analytics: {
      totalClicks: clicks.length,
      clicksThisMonth: clicks.filter(c => new Date(c.createdAt) > new Date(Date.now() - 30*24*60*60*1000)).length,
      clicksByDay: Object.entries(clicksByDay).sort().slice(-30).map(([date, count]) => ({ date, count })),
      totalReviews: reviews.length,
      averageRating: reviews.length ? Math.round(reviews.reduce((s,r) => s + r.rating, 0) / reviews.length * 10) / 10 : null,
    },
    curricula: curricula.map(c => ({
      id: c.id, name: c.name, emoji: c.emoji, slug: c.slug, rating: c.rating,
      reviewCount: c.reviewCount, active: c.active, tier: c.type,
      badges: c.badges, sponsored: c.sponsored, featured: c.featured,
      clicks: (db.affiliateClicks||[]).filter(cl => cl.curriculumId === c.id).length,
    }))
  });
});

// Update publisher profile
app.put('/api/publisher/profile', requirePublisher, (req, res) => {
  const db = readDB();
  const publisher = (db.publishers||[]).find(p => p.id === req.publisherId);
  if (!publisher) return res.status(404).json({ error: 'Not found.' });
  const { name, companyName, website } = req.body;
  if (name) publisher.name = name.trim();
  if (companyName) publisher.companyName = companyName.trim();
  if (website !== undefined) publisher.website = website;
  writeDB(db);
  res.json({ success: true });
});

// Publisher logout
app.post('/api/publisher/logout', requirePublisher, (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  const db = readDB();
  db.publisherSessions = (db.publisherSessions||[]).filter(s => s.token !== token);
  writeDB(db);
  res.json({ success: true });
});

// Admin: approve publisher + assign tier + link curricula
app.put('/api/admin/publishers/:id/approve', requireAdmin, (req, res) => {
  const db = readDB();
  if (!db.publishers) return res.status(404).json({ error: 'Not found.' });
  const publisher = db.publishers.find(p => p.id === req.params.id);
  if (!publisher) return res.status(404).json({ error: 'Publisher not found.' });
  const { tier, curriculumIds } = req.body;
  publisher.approved = true;
  publisher.status = 'active';
  if (tier) publisher.tier = tier;
  if (curriculumIds) publisher.curriculumIds = curriculumIds;
  writeDB(db);
  sendEmail(publisher.email, 'Your My Homeschool Curriculum publisher account is approved! 🎉',
    `<h2>Welcome to the publisher portal, ${publisher.name}!</h2>
    <p>Your account for <strong>${publisher.companyName}</strong> has been approved with a <strong>${tier||'Standard'}</strong> listing tier.</p>
    <p>Log in to your publisher dashboard to view analytics, manage your listing, and track performance:</p>
    <p><a href="${process.env.SITE_URL||'http://localhost:3001'}/publisher-portal.html" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Access Publisher Portal →</a></p>
    <p>Questions? Reply to this email or contact us at contact@myhomeschoolcurriculum.com</p>`);
  res.json({ success: true });
});

// Admin: get all publishers
app.get('/api/admin/publishers', requireAdmin, (req, res) => {
  const db = readDB();
  res.json({ publishers: (db.publishers||[]).slice().reverse() });
});

// Serve publisher portal page
app.get('/publisher-portal', (req, res) => res.sendFile(path.join(__dirname, 'frontend/publisher-portal.html')));
