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
// Use Node's built-in crypto.randomUUID() instead of the uuid package —
// avoids the ERR_REQUIRE_ESM crash with newer uuid versions on CommonJS.
// Works on Node 14.17+. Same API: uuidv4() → "uuid-v4-string"
const { randomUUID } = require('crypto');
const uuidv4 = () => randomUUID();
const nodemailer = require('nodemailer');
const { Resend } = require('resend');

// Optional: Resend email API (preferred over SMTP for cloud hosting)
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

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
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'frontend')));
app.use('/admin', express.static(path.join(__dirname, 'admin')));

// Rate limiting
const generalLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 300 });
const submitLimiter  = rateLimit({ windowMs: 60 * 60 * 1000, max: 10, message: { error: 'Submission limit reached.' } });
const authLimiter    = rateLimit({ windowMs: 15 * 60 * 1000, max: 20, message: { error: 'Too many auth attempts.' } });
app.use('/api/', generalLimiter);

// ─── DATABASE HELPERS ────────────────────────────────────────────────────────
const { Pool } = require('pg');

// PostgreSQL connection (preferred) or fallback to JSON file
let pgPool = null;
let dbCache = null; // in-memory cache for PostgreSQL mode

if (process.env.DATABASE_URL) {
  pgPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
  });
}

const DB_DEFAULTS = {
  curricula: [], reviews: [], affiliateClicks: [], listingInquiries: [],
  contactMessages: [], quizResults: [], users: [], userFavorites: [],
  sessions: [], blogPosts: [], newsletterSubscribers: [], publishers: [],
  publisherSessions: [], stripeSubscriptions: [], conversations: [],
  analytics: { totalVisits: 0, totalClicks: 0, totalReviews: 0, totalInquiries: 0 }
};

function readDB() {
  if (pgPool) {
    // Return cached data (loaded from PostgreSQL on startup, synced on every write)
    return dbCache;
  }
  try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); }
  catch(e) { console.error('DB read error:', e); return null; }
}

function writeDB(data) {
  if (pgPool) {
    dbCache = data;
    // Async write to PostgreSQL (fire-and-forget for performance, data is in cache)
    pgPool.query(
      `INSERT INTO app_data (id, data) VALUES (1, $1) ON CONFLICT (id) DO UPDATE SET data = $1, updated_at = NOW()`,
      [JSON.stringify(data)]
    ).catch(e => console.error('DB write error:', e.message));
    return true;
  }
  try { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf-8'); return true; }
  catch(e) { console.error('DB write error:', e); return false; }
}

// Initialize database
async function initDB() {
  if (pgPool) {
    try {
      // Create table if not exists
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS app_data (
          id INTEGER PRIMARY KEY DEFAULT 1,
          data JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMP DEFAULT NOW()
        )
      `);
      // Load existing data or seed with defaults
      const result = await pgPool.query('SELECT data FROM app_data WHERE id = 1');
      if (result.rows.length > 0) {
        dbCache = result.rows[0].data;
        // Ensure all collections exist
        let changed = false;
        for (const [k, v] of Object.entries(DB_DEFAULTS)) {
          if (dbCache[k] === undefined) { dbCache[k] = v; changed = true; }
        }
        if (changed) writeDB(dbCache);
      } else {
        // First time: try to migrate from JSON file, or use defaults
        let seedData = DB_DEFAULTS;
        try {
          const fileData = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
          if (fileData && fileData.curricula) {
            seedData = { ...DB_DEFAULTS, ...fileData };
            console.log('[DB] Migrated existing data from database.json to PostgreSQL');
          }
        } catch(e) {}
        dbCache = seedData;
        await pgPool.query(
          'INSERT INTO app_data (id, data) VALUES (1, $1)',
          [JSON.stringify(seedData)]
        );
      }
      console.log('[DB] ✅ PostgreSQL connected');
    } catch(e) {
      console.error('[DB] ❌ PostgreSQL error:', e.message);
      console.log('[DB] Falling back to JSON file');
      pgPool = null;
      ensureFileDB();
    }
  } else {
    ensureFileDB();
  }
}

function ensureFileDB() {
  const db = (() => { try { return JSON.parse(fs.readFileSync(DB_PATH, 'utf-8')); } catch(e) { return {}; } })();
  let changed = false;
  for (const [k, v] of Object.entries(DB_DEFAULTS)) {
    if (db[k] === undefined) { db[k] = v; changed = true; }
  }
  if (changed) {
    try { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8'); } catch(e) {}
  }
}

// ─── EMAIL ───────────────────────────────────────────────────────────────────
const FROM_EMAIL = process.env.SMTP_USER || 'contact@myhomeschoolcurriculum.com';

async function sendEmail(to, subject, html) {
  console.log(`[Email] Sending to ${to}: "${subject}"`);

  // Prefer Resend (works over HTTPS, no SMTP port issues)
  if (resend) {
    try {
      await resend.emails.send({ from: `MyHomeschoolCurriculum <${FROM_EMAIL}>`, to, subject, html });
      console.log(`[Email] ✅ Sent via Resend to ${to}: "${subject}"`);
      return true;
    } catch(e) { console.error(`[Email] ❌ Resend failed to ${to}: "${subject}" — ${e.message}`); return false; }
  }

  // Fallback to SMTP
  if (!process.env.SMTP_USER) { console.log('[Email skipped - no email config]', subject); return true; }
  try {
    const port = parseInt(process.env.SMTP_PORT) || 465;
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port,
      secure: port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
      tls: { rejectUnauthorized: false }
    });
    await transporter.sendMail({ from: `"MyHomeschoolCurriculum" <${FROM_EMAIL}>`, to, subject, html });
    console.log(`[Email] ✅ Sent via SMTP to ${to}: "${subject}"`);
    return true;
  } catch(e) { console.error(`[Email] ❌ SMTP failed to ${to}: "${subject}" — ${e.message}`); return false; }
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
  if (subject)   {
    const v = subject.split(',');
    const coreSubjects = ['Math','Language Arts','History','Science'];
    results = results.filter(c => v.some(x => c.subject?.includes(x) || (coreSubjects.includes(x) && c.subject?.includes('Full Curriculum'))));
  }
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
  const isTest = !!(req.body && req.body.isTest);
  db.affiliateClicks.push({
    id: uuidv4(), curriculumId: c.id, curriculumName: c.name, affiliateCode: c.affiliateCode,
    ip: req.ip, userAgent: req.headers['user-agent'], referrer: req.headers.referer || null,
    isTest,
    timestamp: new Date().toISOString()
  });
  // Only count real visitor clicks in the top-line totalClicks tally
  if (!isTest) db.analytics.totalClicks++;
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
  const maxBudget = parseInt(budget);
  if (maxBudget > 0 && maxBudget < 99999) {
    matches = matches.filter(c => (c.priceMin || 0) <= maxBudget);
  } else if (maxBudget === 0) {
    matches = matches.filter(c => (c.priceMin || 0) === 0 && (c.priceMax || 0) === 0);
  }
  matches = matches.map(c => {
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

// ════════════════════════════════════════════════════════════════════════════
// ─── AI CURRICULUM ADVISOR (Gemini-powered chat) ────────────────────────────
// ════════════════════════════════════════════════════════════════════════════
//
// Uses Google's Gemini 2.0 Flash (free tier — 1500 requests/day, generous
// rate limits) with function calling so the model is grounded in our actual
// curriculum database rather than hallucinating from training data.
//
// Tools available to the model:
//   search_curricula(grade?, style?, worldview?, format?, subject?, special?,
//                    priceMax?, query?) — returns matching curricula
//   get_curriculum_details(slug) — returns full info for a single curriculum

// gemini-1.5-flash is the most reliable free-tier-enabled model for new
// API keys. gemini-2.0-flash often shows "limit: 0" on freshly-created
// projects until the user upgrades their Cloud project tier. Override
// via GEMINI_MODEL env var if you've enabled a different model.
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
const GEMINI_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const ADVISOR_SYSTEM_PROMPT = `You are a homeschool curriculum advisor for My Homeschool Curriculum (myhomeschoolcurriculum.com), a free comparison tool with 60+ curricula. Most visitors are NEW to homeschooling. Your job is to help them narrow down to 2-3 specific curricula they should look at more closely — not to make the decision for them.

VOICE
- Warm, direct, no-BS — like a friend who already did the research
- Plain English. Never use words like "leverage", "synergize", "robust solution"
- 2-4 sentences per turn unless asked for detail
- Ask ONE clarifying question at a time, never a list of 5
- Sign off naturally; don't end every message with "Let me know if you have more questions!"

PROCESS
1. If you don't already know it, ask for: grade level, teaching style, worldview preference (Christian / Catholic / Secular / no preference), and rough budget
2. Use the search_curricula tool — DO NOT recommend curricula from memory. Always search first.
3. Pick 2-3 strongest fits and explain in one sentence per curriculum WHY this family
4. Suggest the user click "View" on any that interest them, or compare side-by-side using the site's compare tool

AFFILIATE BEHAVIOR (NON-NEGOTIABLE)
- When a curriculum's response object includes a discountLink or affiliateLink, share that link as a clickable markdown link
- Format: [Curriculum Name](URL) (affiliate link — we may earn a small commission at no cost to you)
- ONLY when the curriculum is genuinely a good fit. NEVER recommend something just because it has an affiliate.
- If the best fit doesn't have an affiliate link, recommend it without one anyway.
- If asked directly about affiliate relationships, be transparent.

DO NOT
- Hallucinate curricula. Always use search_curricula to verify they exist.
- Promise outcomes ("this WILL work for your family")
- Recommend more than 3 curricula in one response — overwhelm is the problem you're solving
- Replace a parent's judgment

OUT OF SCOPE
For state homeschool laws, point to /legal.html. For deeper guides, /blog. For who runs the site, /about.`;

const ADVISOR_TOOLS = [{
  functionDeclarations: [
    {
      name: 'search_curricula',
      description: 'Search the curriculum database by any combination of filters. Returns up to 8 curricula matching ALL provided filters. Always call this before recommending — never recommend from memory.',
      parameters: {
        type: 'object',
        properties: {
          grade: { type: 'string', description: 'Grade level: Pre-K, K-2, 3-5, 6-8, 9-12, or "All Grades"' },
          style: { type: 'string', description: 'Teaching style. Valid values: Traditional, Charlotte Mason, Classical, Unit Study, Interest-Led, Online, Eclectic, Montessori' },
          worldview: { type: 'string', description: 'Worldview. Valid values: Christian, Catholic, Jewish, Faith-Neutral, Secular' },
          format: { type: 'string', description: 'Material format. Valid values: Physical Books, Digital, Video, App, Online Platform, Hands-On, Audio, Hybrid' },
          subject: { type: 'string', description: 'Subject coverage. Valid values: Full Curriculum, Math, Language Arts, History, Science, Bible / Theology, Latin / Classical Languages, Foreign Language, Logic, Fine Arts, Electives, STEM, Test Prep' },
          special: { type: 'string', description: 'Special-needs accommodations. Valid values: Dyslexia, ADHD, Autism, Gifted, Learning Differences, Multiple Ages' },
          priceMax: { type: 'number', description: 'Maximum annual budget in USD. Use 0 to mean "free only".' },
          search: { type: 'string', description: 'Free-text search across name/description (e.g., "Charlotte Mason math"). Optional.' }
        }
      }
    },
    {
      name: 'get_curriculum_details',
      description: 'Fetch full details for one curriculum, including pros/cons, pricing notes, and the affiliate link if any. Use this after searching to share specifics.',
      parameters: {
        type: 'object',
        properties: {
          slug: { type: 'string', description: 'The curriculum slug (e.g., "the-good-and-the-beautiful")' }
        },
        required: ['slug']
      }
    }
  ]
}];

// Trim curriculum data to just what the model needs — keeps tokens low and
// makes the model less likely to leak internal fields it shouldn't share.
function trimCurriculumForAdvisor(c, includeFull = false) {
  const base = {
    name: c.name,
    slug: c.slug,
    tagline: c.tagline,
    grades: c.grades || [],
    style: c.style || [],
    worldview: c.worldview || [],
    format: c.format || [],
    subject: c.subject || [],
    special: c.special || [],
    price: c.price,
    priceMin: c.priceMin || 0,
    priceMax: c.priceMax || 0
  };
  if (includeFull) {
    base.description = c.description;
    base.pros = c.pros || [];
    base.cons = c.cons || [];
    base.pricingNote = c.pricingNote || '';
    base.affiliateLink = c.discountLink || c.affiliateLink || '';
    base.discountCode = c.discountCode || '';
    base.discountDesc = c.discountDesc || '';
    base.hasAffiliate = !!(c.discountLink || c.affiliateLink);
  } else {
    base.hasAffiliate = !!(c.discountLink || c.affiliateLink);
  }
  return base;
}

function runAdvisorTool(name, args) {
  const db = readDB();
  if (!db) return { error: 'Database unavailable' };
  if (name === 'search_curricula') {
    let results = db.curricula.filter(c => c.active);
    if (args.search) {
      const q = args.search.toLowerCase();
      results = results.filter(c =>
        c.name.toLowerCase().includes(q) ||
        (c.tagline||'').toLowerCase().includes(q) ||
        (c.description||'').toLowerCase().includes(q));
    }
    if (args.grade) results = results.filter(c => (c.grades||[]).includes(args.grade));
    if (args.style) results = results.filter(c => (c.style||[]).includes(args.style));
    if (args.worldview) results = results.filter(c => (c.worldview||[]).includes(args.worldview));
    if (args.format) results = results.filter(c => (c.format||[]).includes(args.format));
    if (args.special) results = results.filter(c => (c.special||[]).includes(args.special));
    if (args.subject) {
      const x = args.subject;
      const core = ['Math','Language Arts','History','Science'];
      results = results.filter(c => (c.subject||[]).includes(x) || (core.includes(x) && (c.subject||[]).includes('Full Curriculum')));
    }
    if (args.priceMax !== undefined) {
      if (args.priceMax === 0) results = results.filter(c => (c.priceMin||0) === 0 && (c.priceMax||0) === 0);
      else results = results.filter(c => (c.priceMin||0) <= args.priceMax);
    }
    return {
      count: results.length,
      curricula: results.slice(0, 8).map(c => trimCurriculumForAdvisor(c))
    };
  }
  if (name === 'get_curriculum_details') {
    const c = db.curricula.find(x => x.slug === args.slug);
    if (!c) return { error: `No curriculum with slug "${args.slug}"` };
    return trimCurriculumForAdvisor(c, true);
  }
  return { error: `Unknown tool: ${name}` };
}

const chatLimiter = rateLimit({
  windowMs: 60 * 1000, max: 12,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Slow down — try again in a minute.' }
});

app.post('/api/chat', chatLimiter, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Advisor unavailable. Set GEMINI_API_KEY in environment.' });

  const { message, history = [], sessionId } = req.body || {};
  if (typeof message !== 'string' || !message.trim() || message.length > 2000)
    return res.status(400).json({ error: 'Message required (≤ 2000 chars).' });

  // Build conversation history in Gemini format. The frontend sends
  // alternating { role: 'user' | 'model', text } entries.
  const contents = [];
  for (const turn of history.slice(-20)) {
    if (!turn || typeof turn.text !== 'string') continue;
    if (turn.role !== 'user' && turn.role !== 'model') continue;
    contents.push({ role: turn.role, parts: [{ text: turn.text }] });
  }
  contents.push({ role: 'user', parts: [{ text: message.trim() }] });

  // Tool-call loop. Gemini may call multiple tools in sequence; we cap
  // iterations to prevent runaway cost.
  const MAX_TOOL_ITERATIONS = 5;
  let finalText = '';
  let toolCallsExecuted = [];

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const reqBody = {
        systemInstruction: { parts: [{ text: ADVISOR_SYSTEM_PROMPT }] },
        contents,
        tools: ADVISOR_TOOLS,
        generationConfig: { temperature: 0.4, maxOutputTokens: 1024 },
        safetySettings: [
          { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
          { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
        ]
      };

      const apiRes = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(reqBody)
      });

      if (!apiRes.ok) {
        const err = await apiRes.text();
        console.error('[advisor] Gemini error:', apiRes.status, err.slice(0, 300));
        return res.status(502).json({ error: "The advisor is having trouble right now — try again in a moment." });
      }

      const data = await apiRes.json();
      const candidate = data.candidates?.[0];
      const parts = candidate?.content?.parts || [];

      // Collect any function calls from this response
      const functionCalls = parts.filter(p => p.functionCall).map(p => p.functionCall);
      const textParts = parts.filter(p => p.text).map(p => p.text).join('');

      if (functionCalls.length === 0) {
        finalText = textParts || "I didn't catch that — could you rephrase?";
        break;
      }

      // Push the model's tool-call message and execute each tool
      contents.push({ role: 'model', parts: parts });
      const responseParts = [];
      for (const fc of functionCalls) {
        const result = runAdvisorTool(fc.name, fc.args || {});
        toolCallsExecuted.push({ name: fc.name, args: fc.args, resultSize: JSON.stringify(result).length });
        responseParts.push({ functionResponse: { name: fc.name, response: result } });
      }
      contents.push({ role: 'user', parts: responseParts });
    }
    if (!finalText) finalText = "I'm thinking too hard about this — let me try a simpler answer. Can you tell me your child's grade level and what teaching style you're drawn to?";
  } catch (err) {
    console.error('[advisor] Exception:', err);
    return res.status(500).json({ error: "Something went wrong on our end. Try again in a moment." });
  }

  // Persist conversation. Reuse session if provided; otherwise create new.
  const db = readDB();
  if (db) {
    if (!db.conversations) db.conversations = [];
    let convo = sessionId ? db.conversations.find(c => c.id === sessionId) : null;
    const now = new Date().toISOString();
    if (!convo) {
      convo = {
        id: sessionId || uuidv4(),
        ip: req.ip,
        userAgent: (req.headers['user-agent'] || '').slice(0, 200),
        createdAt: now,
        messages: []
      };
      db.conversations.push(convo);
    }
    convo.messages.push({ role: 'user', text: message.trim(), at: now });
    convo.messages.push({ role: 'model', text: finalText, at: new Date().toISOString(), tools: toolCallsExecuted.map(t => t.name) });
    convo.updatedAt = new Date().toISOString();
    convo.messageCount = convo.messages.length;
    // Cap stored conversations at 5000 to keep DB lean
    if (db.conversations.length > 5000) db.conversations = db.conversations.slice(-5000);
    writeDB(db);
    res.json({ reply: finalText, sessionId: convo.id });
  } else {
    res.json({ reply: finalText });
  }
});

// Admin: list conversations (newest first, most recent message preview)
// Diagnostic — admin-only. Hits Gemini with a minimal test prompt and
// returns the raw response (or error). Use to debug "advisor is having
// trouble" without exposing internals to public users.
//   curl -H "Authorization: Bearer $ADMIN_TOKEN" https://your-site/api/admin/chat-diagnostic
app.get('/api/admin/chat-diagnostic', requireAdmin, async (req, res) => {
  const apiKey = process.env.GEMINI_API_KEY;
  const result = {
    apiKey_set: !!apiKey,
    apiKey_length: apiKey ? apiKey.length : 0,
    apiKey_prefix: apiKey ? apiKey.slice(0, 6) + '…' : null,
    model: GEMINI_MODEL,
    endpoint: GEMINI_ENDPOINT
  };
  if (!apiKey) return res.json({ ...result, error: 'GEMINI_API_KEY not set' });
  try {
    const apiRes = await fetch(`${GEMINI_ENDPOINT}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: 'Say "ok" and nothing else.' }] }],
        generationConfig: { maxOutputTokens: 10 }
      })
    });
    result.http_status = apiRes.status;
    const text = await apiRes.text();
    if (!apiRes.ok) {
      result.error = 'Gemini rejected the request';
      result.gemini_response = text.slice(0, 600);
    } else {
      try {
        const data = JSON.parse(text);
        result.success = true;
        result.reply = data.candidates?.[0]?.content?.parts?.[0]?.text || '(empty)';
      } catch (e) {
        result.error = 'Could not parse Gemini response';
        result.raw = text.slice(0, 300);
      }
    }
  } catch (e) {
    result.error = 'Network error reaching Gemini';
    result.message = String(e.message || e);
  }
  res.json(result);
});

app.get('/api/admin/conversations', requireAdmin, (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const all = (db.conversations || []).slice().sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  const summarized = all.slice(0, 200).map(c => ({
    id: c.id,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    messageCount: c.messageCount || (c.messages || []).length,
    firstMessage: (c.messages || []).find(m => m.role === 'user')?.text?.slice(0, 120) || '',
    lastMessage: (c.messages || []).slice(-1)[0]?.text?.slice(0, 120) || ''
  }));
  res.json({ total: all.length, conversations: summarized });
});

app.get('/api/admin/conversations/:id', requireAdmin, (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const c = (db.conversations || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
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
    `New Listing Request: ${inquiry.curriculumName}`,
    `<h2>New Listing Request</h2><p><strong>${inquiry.companyName}</strong><br>${inquiry.contactName} &lt;${inquiry.email}&gt;</p><p>Curriculum: <strong>${inquiry.curriculumName}</strong></p>${inquiry.description ? `<p>${inquiry.description.substring(0,200)}</p>` : ''}<p><a href="${process.env.SITE_URL||'http://localhost:3001'}/admin">Review in Admin →</a></p>`);
  sendEmail(inquiry.email, `We received your listing request — MyHomeschoolCurriculum`,
    `<p>Hi ${inquiry.contactName},</p><p>Thanks for your interest in listing <strong>${inquiry.curriculumName}</strong> on MyHomeschoolCurriculum! Our team will review your request and get back to you within 2–3 business days.</p><p>In the meantime, if you have any questions, feel free to reply to this email.</p><p>— The MyHomeschoolCurriculum Team</p>`);
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
};

app.post('/api/billing/create-checkout', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured. Add STRIPE_SECRET_KEY to .env' });
  const { tier, email, companyName, publisherId } = req.body;
  if (!tier || !STRIPE_PRICES[tier]) return res.status(400).json({ error: 'Invalid tier. Valid: silver, gold' });
  const siteUrl = process.env.SITE_URL || 'http://localhost:3001';
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'subscription',
      customer_email: email,
      line_items: [{ price: STRIPE_PRICES[tier], quantity: 1 }],
      metadata: { tier, companyName: companyName||'', publisherId: publisherId||'' },
      success_url: `${siteUrl}/publisher-portal.html?success=1&tier=${tier}`,
      cancel_url:  `${siteUrl}/publisher-portal.html?canceled=1`,
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

// Publisher billing portal (manage/cancel subscription)
app.post('/api/billing/publisher-portal', requirePublisher, async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Billing not configured' });
  const db = readDB();
  const publisher = (db.publishers||[]).find(p => p.id === req.publisherId);
  if (!publisher?.stripeCustomerId) return res.status(400).json({ error: 'No billing account found. Contact support.' });
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: publisher.stripeCustomerId,
      return_url: `${process.env.SITE_URL||'http://localhost:3001'}/publisher-portal.html`
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
      publisherId: s.metadata.publisherId||null,
      status: 'active', createdAt: new Date().toISOString()
    });
    // Update publisher tier and store Stripe customer ID
    if (s.metadata.publisherId) {
      const publisher = (db.publishers||[]).find(p => p.id === s.metadata.publisherId);
      if (publisher) {
        publisher.tier = s.metadata.tier;
        publisher.stripeCustomerId = s.customer;
        publisher.stripeSubscriptionId = s.subscription;
      }
    }
    sendEmail(process.env.ADMIN_EMAIL||process.env.SMTP_USER,
      `🎉 New ${s.metadata.tier} Subscription — ${s.customer_email}`,
      `<h2>New Subscription!</h2><p>Tier: <strong>${s.metadata.tier}</strong></p><p>Email: ${s.customer_email}</p>${s.metadata.companyName?`<p>Company: ${s.metadata.companyName}</p>`:''}`);
  }
  if (event.type === 'customer.subscription.deleted') {
    const sub = db.stripeSubscriptions.find(s => s.stripeSubscriptionId === event.data.object.id);
    if (sub) {
      sub.status = 'canceled';
      // Downgrade publisher back to standard
      if (sub.publisherId) {
        const publisher = (db.publishers||[]).find(p => p.id === sub.publisherId);
        if (publisher) {
          publisher.tier = 'standard';
          publisher.stripeSubscriptionId = null;
        }
      }
      sendEmail(process.env.ADMIN_EMAIL||process.env.SMTP_USER,
        `⚠️ Subscription Canceled — ${sub.email}`,
        `<h2>Subscription Canceled</h2><p>Email: ${sub.email}</p><p>Tier: ${sub.tier}</p><p>Publisher has been downgraded to Standard.</p>`);
    }
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
  const siteUrl = process.env.SITE_URL || 'http://localhost:3001';
  // Route to the right welcome email based on source.
  // For the checklist popup, the PDF-delivery email IS the welcome.
  if (source === 'popup_checklist') {
    sendChecklistEmail(subscriber.email, siteUrl);
  } else {
    sendEmail(subscriber.email, 'Welcome to MyHomeschoolCurriculum! 🧭',
      `<h2>Welcome${subscriber.name ? ', '+subscriber.name : ''}!</h2><p>Thanks for subscribing! You'll receive new reviews, deals, and homeschool tips.</p><p><a href="${siteUrl}">Browse curricula →</a></p><p style="font-size:12px;color:#999;margin-top:24px">Don't want these emails? <a href="${siteUrl}/unsubscribe.html?email=${encodeURIComponent(subscriber.email)}" style="color:#999">Unsubscribe</a></p>`);
  }
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
    `📬 New Newsletter Subscriber — ${subscriber.email}`,
    `<h2>New Newsletter Signup</h2><p><strong>Email:</strong> ${subscriber.email}</p>${subscriber.name ? `<p><strong>Name:</strong> ${subscriber.name}</p>` : ''}<p><strong>Source:</strong> ${subscriber.source||'website'}</p><p><strong>Date:</strong> ${subscriber.subscribedAt}</p><p>Total active subscribers: ${(db.newsletterSubscribers||[]).filter(s => s.active).length}</p>`);
  res.status(201).json({ success: true, message: "You're subscribed! Check your inbox for a welcome email." });
});

// Quiz results email — sends the user's personalized curriculum matches so they
// can come back to them later. Unlike the newsletter subscribe, this always
// fires (even if the email is already subscribed) because it's a 1:1 transaction.
app.post('/api/quiz/email-results', submitLimiter, async (req, res) => {
  const { email, matches, answers } = req.body;
  if (!email || !/\S+@\S+\.\S+/.test(email))
    return res.status(400).json({ error: 'Valid email required.' });
  if (!Array.isArray(matches) || matches.length === 0)
    return res.status(400).json({ error: 'No matches to email.' });
  const db = readDB();
  const siteUrl = (process.env.SITE_URL || 'http://localhost:3001').replace(/\/$/, '');
  const cleanEmail = email.trim().toLowerCase();

  // Silently add them to the newsletter list if they're not there — admin can
  // filter by source="quiz_results" to see who came from the quiz.
  if (!(db.newsletterSubscribers||[]).find(s => s.email === cleanEmail)) {
    db.newsletterSubscribers.push({
      id: uuidv4(), email: cleanEmail, name: '',
      source: 'quiz_results', subscribedAt: new Date().toISOString(), active: true
    });
    writeDB(db);
    sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER,
      `📬 New Newsletter Subscriber — ${cleanEmail}`,
      `<h2>New Newsletter Signup</h2><p><strong>Email:</strong> ${cleanEmail}</p><p><strong>Source:</strong> quiz_results</p><p><strong>Date:</strong> ${new Date().toISOString()}</p>`);
  }

  // Build the match list HTML
  const matchesHtml = matches.map((m, i) => `
    <tr>
      <td style="padding:14px 16px;border-bottom:1px solid #E8DDD0;vertical-align:top;width:44px;font-size:1.4rem">${m.emoji || '📘'}</td>
      <td style="padding:14px 0 14px 4px;border-bottom:1px solid #E8DDD0;vertical-align:top">
        <div style="font-family:Georgia,serif;font-size:1.02rem;font-weight:700;color:#1F3A4D;margin-bottom:4px">${m.name || 'Curriculum'}</div>
        <div style="font-size:.86rem;color:#6B6B60;line-height:1.55">${m.tagline || ''}</div>
      </td>
      <td style="padding:14px 16px;border-bottom:1px solid #E8DDD0;vertical-align:top;text-align:right">
        <a href="${siteUrl}/?curriculum=${encodeURIComponent(m.slug||'')}" style="background:#4A7550;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-size:.8rem;font-weight:600;white-space:nowrap">View →</a>
      </td>
    </tr>`).join('');

  // Summarize answers as a caption
  const summaryBits = [];
  if (answers?.grade) summaryBits.push(answers.grade);
  if (answers?.style) summaryBits.push(answers.style);
  if (answers?.worldview) summaryBits.push(answers.worldview);
  const summary = summaryBits.length ? `Based on: ${summaryBits.join(' · ')}` : '';

  const html = `
  <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:600px;margin:0 auto;color:#2C3E3F">
    <div style="background:#1F3A4D;padding:28px 32px;border-radius:12px 12px 0 0">
      <p style="font-family:Georgia,'Times New Roman',serif;font-size:1.3rem;color:#fff;margin:0">
        My Homeschool <span style="color:#D4A84C;font-style:italic">Curriculum</span>
      </p>
    </div>
    <div style="background:#FFFBF5;padding:36px 32px;border:1px solid #E8DDD0;border-top:none;border-radius:0 0 12px 12px;line-height:1.65">
      <p style="margin-top:0">Hi there,</p>
      <p>Here are your top curriculum matches from the quiz — so you can come back to them later.</p>
      ${summary ? `<p style="font-size:.84rem;color:#6B6B60;font-style:italic;margin-bottom:20px">${summary}</p>` : ''}
      <table style="width:100%;border-collapse:collapse;margin:14px 0 24px;border:1px solid #E8DDD0;border-radius:10px;overflow:hidden;background:#fff">
        ${matchesHtml}
      </table>
      <p style="font-size:.92rem;color:#6B6B60">A few things to know before you dig in:</p>
      <ul style="font-size:.92rem;color:#6B6B60;line-height:1.8;padding-left:20px">
        <li>These matches are based on your answers — not paid placement.</li>
        <li>Use our <a href="${siteUrl}" style="color:#4A7550">side-by-side comparison tool</a> to narrow down to 2–3 finalists.</li>
        <li>Read parent reviews on each curriculum's listing for real-world experience.</li>
      </ul>
      <p style="font-size:.92rem">Questions? Reply to this email — I read every one.</p>
      <p style="font-size:.92rem;margin-bottom:4px">— Vanessa</p>
      <p style="font-size:.82rem;color:#6B6B60;margin-top:0">Founder, My Homeschool Curriculum</p>
      <hr style="border:none;border-top:1px solid #E8DDD0;margin:24px 0">
      <p style="font-size:.74rem;color:#8B8B7E;margin:0">You requested this email at MyHomeschoolCurriculum.com.
        <a href="${siteUrl}/unsubscribe.html?email=${encodeURIComponent(cleanEmail)}" style="color:#8B8B7E">Unsubscribe</a>.
      </p>
    </div>
  </div>`;

  const sent = await sendEmail(cleanEmail, `Your curriculum matches · ${matches.length} picks for your family`, html);
  res.json({ success: !!sent, message: sent ? "Sent! Check your inbox." : "Subscription saved but email failed — we'll retry." });
});

// Checklist PDF-delivery email — sent when someone subscribes via the lead-gen popup.
// Uses the existing Resend-backed sendEmail() helper. Configure CHECKLIST_PDF_URL
// in Railway env vars (Google Drive/Dropbox/S3 direct-download link).
function sendChecklistEmail(email, siteUrl) {
  // Default to the repo-hosted PDF. Override via CHECKLIST_PDF_URL env var if
  // you later move it to Google Drive, Dropbox, S3, etc.
  const pdfUrl = process.env.CHECKLIST_PDF_URL || `${siteUrl}/downloads/homeschool-curriculum-checklist.pdf`;
  const html = `
  <div style="font-family:'DM Sans',Helvetica,Arial,sans-serif;max-width:560px;margin:0 auto;color:#2C3E3F">
    <div style="background:#1F3A4D;padding:28px 32px;border-radius:12px 12px 0 0">
      <p style="font-family:Georgia,'Times New Roman',serif;font-size:1.3rem;color:#fff;margin:0">
        My Homeschool <span style="color:#D4A84C;font-style:italic">Curriculum</span>
      </p>
    </div>
    <div style="background:#FFFBF5;padding:36px 32px;border:1px solid #E8DDD0;border-top:none;border-radius:0 0 12px 12px;line-height:1.65">
      <p style="margin-top:0">Hi there,</p>
      <p>Here's your copy of <strong>Before You Buy: The Homeschool Curriculum Checklist</strong> — 10 questions to work through before you spend a dollar on curriculum.</p>
      <div style="text-align:center;margin:28px 0">
        <a href="${pdfUrl}" style="background:#4A7550;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600;font-size:.95rem;display:inline-block">
          Download Your Checklist →
        </a>
      </div>
      <p style="font-size:.92rem;color:#6B6B60">A few tips for using it:</p>
      <ul style="font-size:.92rem;color:#6B6B60;line-height:1.8;padding-left:20px">
        <li>Go through it once for each curriculum you're seriously considering.</li>
        <li>Be honest on question 4 — most curriculum regrets come from overestimating available prep time.</li>
        <li>Use our free <a href="${siteUrl}" style="color:#4A7550">curriculum comparison tool</a> to filter by grade, style, worldview, and budget.</li>
      </ul>
      <p style="font-size:.92rem">If you have questions or just want a second opinion, reply to this email — I read every one.</p>
      <p style="font-size:.92rem;margin-bottom:4px">— Vanessa</p>
      <p style="font-size:.82rem;color:#6B6B60;margin-top:0">Founder, My Homeschool Curriculum</p>
      <hr style="border:none;border-top:1px solid #E8DDD0;margin:24px 0">
      <p style="font-size:.74rem;color:#8B8B7E;margin:0">You're receiving this because you signed up at MyHomeschoolCurriculum.com.
        <a href="${siteUrl}/unsubscribe.html?email=${encodeURIComponent(email)}" style="color:#8B8B7E">Unsubscribe</a>.
      </p>
    </div>
  </div>`;
  sendEmail(email, "Your free curriculum checklist is here 📋", html);
}

app.post('/api/newsletter/unsubscribe', (req, res) => {
  const { email } = req.body;
  const db = readDB();
  const sub = (db.newsletterSubscribers||[]).find(s => s.email === email?.toLowerCase());
  if (sub) { sub.active = false; writeDB(db); }
  res.json({ success: true, message: "You've been unsubscribed." });
});

app.get('/api/newsletter/subscribers', requireAdmin, (req, res) => {
  const db = readDB();
  const all = db.newsletterSubscribers || [];
  const activeCount = all.filter(s => s.active !== false).length;
  res.json({ count: activeCount, total: all.length, subscribers: all });
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

// Bulk import blog posts — adds new posts, upserts SEO fields on existing
// posts matched by id or slug. Content/title/excerpt on existing posts are
// preserved so admin edits in production aren't overwritten.
app.post('/api/admin/blog/bulk-import', requireAdmin, (req, res) => {
  const { posts } = req.body;
  if (!Array.isArray(posts)) return res.status(400).json({ error: 'posts array required' });
  const db = readDB();
  if (!db.blogPosts) db.blogPosts = [];
  const seoFields = ['featuredImage', 'ogImage', 'metaTitle', 'metaDescription', 'keywords', 'author', 'canonicalUrl', 'tags', 'category', 'wordCount', 'readingMinutes'];
  let added = 0, updated = 0, skipped = 0;
  for (const p of posts) {
    if (!p.title || !p.content) { skipped++; continue; }
    const existingIdx = db.blogPosts.findIndex(x => x.id === p.id || x.slug === p.slug);
    if (existingIdx === -1) {
      db.blogPosts.push(p);
      added++;
    } else {
      const existing = db.blogPosts[existingIdx];
      let changed = false;
      for (const field of seoFields) {
        if (p[field] !== undefined && p[field] !== null && p[field] !== existing[field]) {
          existing[field] = p[field];
          changed = true;
        }
      }
      if (changed) { existing.updatedAt = new Date().toISOString(); updated++; }
      else skipped++;
    }
  }
  writeDB(db);
  res.json({ success: true, added, updated, skipped, total: db.blogPosts.length });
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
  "Alabama":{"requirement": "Easy", "difficulty": "Easy", "description": "Homeschooling is usually done through a church school, private school, or private tutor option.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "No statewide subject list under the common church school/private school routes", "testingRequirements": "No statewide testing under the common homeschool routes", "portfolioRequirements": "No statewide portfolio requirement stated; keep attendance and enrollment records", "officialLink": "https://www.alabamaachieves.org/homeschool/", "moreInfo": "https://hslda.org/legal/alabama", "lastReviewed": "2026-04-07"},
  "Alaska":{"requirement": "Easy", "difficulty": "Easy", "description": "Families may homeschool independently with no district affiliation, or use a public correspondence program.", "withdrawalNotice": "Varies by option; not required for independent homeschooling", "subjectRequirements": "No statewide subject list for independent homeschooling", "testingRequirements": "None for independent homeschooling; correspondence programs may require assessments", "portfolioRequirements": "No statewide portfolio requirement for independent homeschooling; correspondence programs vary", "officialLink": "https://education.alaska.gov/alaskan_schools/schooloptions", "moreInfo": "https://hslda.org/legal/alaska", "lastReviewed": "2026-04-07"},
  "Arizona":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents file a one-time notarized affidavit with the county school superintendent.", "withdrawalNotice": "Yes, affidavit within 30 days of starting or withdrawing", "subjectRequirements": "Reading, grammar, math, social studies, and science", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep affidavit copy and records", "officialLink": "https://www.azed.gov/homeschool-kit-kids", "moreInfo": "https://hslda.org/legal/arizona", "lastReviewed": "2026-04-07"},
  "Arkansas":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file a Notice of Intent each school year with the state.", "withdrawalNotice": "Yes, annual notice of intent", "subjectRequirements": "No specific statewide subject list stated on the parent support page", "testingRequirements": "No statewide testing requirement for home school families", "portfolioRequirements": "No statewide portfolio requirement stated; keep notice and school records", "officialLink": "https://dese.ade.arkansas.gov/Offices/office-of-school-choice-and-parent-empowerment/home-schools/notice-of-intent", "moreInfo": "https://hslda.org/legal/arkansas", "lastReviewed": "2026-04-07"},
  "California":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families typically homeschool by filing a private school affidavit, using a private satellite program, or hiring a credentialed tutor.", "withdrawalNotice": "Yes under the private school affidavit or other chosen option", "subjectRequirements": "Required branches of study generally mirror public school branches in English", "testingRequirements": "No statewide testing for most independent homeschool options", "portfolioRequirements": "Keep school records; no statewide parent portfolio review under the common private school affidavit route", "officialLink": "https://www.cde.ca.gov/sp/ps/affidavit.asp", "moreInfo": "https://hslda.org/legal/california", "lastReviewed": "2026-04-07"},
  "Colorado":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents may homeschool directly or under an independent school/umbrella option.", "withdrawalNotice": "Yes, notice of intent for the direct homeschool statute route", "subjectRequirements": "Reading, writing, speaking, math, history, civics, literature, science, and constitution instruction", "testingRequirements": "Assessment required in grades 3, 5, 7, 9, and 11 for the direct statute route", "portfolioRequirements": "Maintain attendance, immunization/exemption, and test or evaluation records; not a parent portfolio review state", "officialLink": "https://www.cde.state.co.us/choice/homeschool", "moreInfo": "https://hslda.org/legal/colorado", "lastReviewed": "2026-04-07"},
  "Connecticut":{"requirement": "Easy", "difficulty": "Easy", "description": "Connecticut follows low-regulation practice guidance rather than a detailed homeschool statute.", "withdrawalNotice": "Usually yes if withdrawing from school", "subjectRequirements": "Parents are generally expected to provide equivalent instruction in required areas", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://portal.ct.gov/SDE/School-Choice/Home-Schooling-in-Connecticut", "moreInfo": "https://hslda.org/legal/connecticut", "lastReviewed": "2026-04-07"},
  "Delaware":{"requirement": "Easy", "difficulty": "Easy", "description": "Families usually homeschool through single-family homeschool, multi-family homeschool, or single-family coordinated program options.", "withdrawalNotice": "Yes, annual enrollment/notification in the state system", "subjectRequirements": "No statewide subject list for the common single-family homeschool option", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep attendance and work records recommended", "officialLink": "https://www.doe.k12.de.us/Page/1548", "moreInfo": "https://hslda.org/legal/delaware", "lastReviewed": "2026-04-07"},
  "Florida":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Under the home education statute, parents file a notice of intent, keep a portfolio, and complete an annual evaluation.", "withdrawalNotice": "Yes, notice of intent when establishing a home education program", "subjectRequirements": "No specific statewide subject list under the home education statute", "testingRequirements": "Annual evaluation required under the home education statute; no grade-band testing mandate", "portfolioRequirements": "Parent must keep a portfolio with a log of educational activities and samples of work", "officialLink": "https://www.fldoe.org/schools/school-choice/other-school-choice-options/home-edu/", "moreInfo": "https://hslda.org/legal/florida", "lastReviewed": "2026-04-07"},
  "Georgia":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file an annual declaration of intent and must teach the required basic program.", "withdrawalNotice": "Yes, annual declaration of intent", "subjectRequirements": "Reading, language arts, math, social studies, and science", "testingRequirements": "Nationally standardized test every three years beginning in grade 3", "portfolioRequirements": "Keep attendance records and annual progress reports for at least three years; not a formal state portfolio review", "officialLink": "https://www.gadoe.org/Curriculum-Instruction-and-Assessment/Pages/Home-Schools.aspx", "moreInfo": "https://hslda.org/legal/georgia", "lastReviewed": "2026-04-07"},
  "Hawaii":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents submit a notice and provide a curriculum plan, with annual progress reporting.", "withdrawalNotice": "Yes, notice to the principal when beginning homeschool", "subjectRequirements": "No fixed statewide subject list, but the program must be structured and cumulative", "testingRequirements": "Annual progress report required", "portfolioRequirements": "No statewide portfolio requirement stated; keep work samples and progress records recommended", "officialLink": "https://www.hawaiipublicschools.org/ParentsAndStudents/EnrollingInSchool/Choosingaschool/Pages/Home-schooling.aspx", "moreInfo": "https://hslda.org/legal/hawaii", "lastReviewed": "2026-04-07"},
  "Idaho":{"requirement": "Easy", "difficulty": "Easy", "description": "Homeschools are treated similarly to private schools for purposes of instruction.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "Instruction must be comparable to what is taught in public schools", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep attendance and academic records recommended", "officialLink": "https://www.sde.idaho.gov/schools/school-choice/files/homeschool/Homeschool-Frequently-Asked-Questions.pdf", "moreInfo": "https://hslda.org/legal/idaho", "lastReviewed": "2026-04-07"},
  "Illinois":{"requirement": "Easy", "difficulty": "Easy", "description": "Homeschools are recognized as private schools with low regulation.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "Language arts, math, biological and physical sciences, social sciences, fine arts, and physical development/health", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://www.isbe.net/Pages/Home-School.aspx", "moreInfo": "https://hslda.org/legal/illinois", "lastReviewed": "2026-04-07"},
  "Indiana":{"requirement": "Easy", "difficulty": "Easy", "description": "Homeschools operate as nonaccredited nonpublic schools.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "No specific statewide subject list", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep attendance records because instruction must occur 180 days", "officialLink": "https://www.in.gov/doe/students/homeschool-information/", "moreInfo": "https://hslda.org/legal/indiana", "lastReviewed": "2026-04-07"},
  "Iowa":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Iowa offers several homeschool-related pathways, including independent private instruction with very low regulation.", "withdrawalNotice": "Varies by option", "subjectRequirements": "Varies by option; some routes have no mandated subject list", "testingRequirements": "Varies by option; some routes require annual assessment", "portfolioRequirements": "Varies by option; keep records for the pathway you choose", "officialLink": "https://educate.iowa.gov/pk-12/parent-guardians-and-families/home-schooling", "moreInfo": "https://hslda.org/legal/iowa", "lastReviewed": "2026-04-07"},
  "Kansas":{"requirement": "Easy", "difficulty": "Easy", "description": "Families typically register as a nonaccredited private school.", "withdrawalNotice": "Yes when first starting the school", "subjectRequirements": "No statewide subject list stated", "testingRequirements": "Periodic assessment expectation exists, but no annual parent-filed testing system", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://www.ksde.gov/Agency/Division-of-Learning-Services/Kansas-Education-Systems-Accreditation/Non-Accredited-Private-Schools", "moreInfo": "https://hslda.org/legal/kansas", "lastReviewed": "2026-04-07"},
  "Kentucky":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Homeschools are typically operated as private schools and notify the local district annually.", "withdrawalNotice": "Yes, annual notice to local district", "subjectRequirements": "Reading, writing, spelling, grammar, history, math, civics, and similar core subjects", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep attendance and scholarship reports as applicable", "officialLink": "https://education.ky.gov/federal/fed/Pages/Non-Public-Schools.aspx", "moreInfo": "https://hslda.org/legal/kentucky", "lastReviewed": "2026-04-07"},
  "Louisiana":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families usually choose a home study approval route or a private school-at-home route.", "withdrawalNotice": "Varies by option", "subjectRequirements": "Varies by option; home study approval route generally follows a sustained educational program", "testingRequirements": "Varies by option; no routine statewide annual testing for the private school-at-home route", "portfolioRequirements": "No statewide portfolio requirement stated; keep approval and instructional records", "officialLink": "https://www.louisianabelieves.com/schools/home-study", "moreInfo": "https://hslda.org/legal/louisiana", "lastReviewed": "2026-04-07"},
  "Maine":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file an annual notice and submit yearly assessment results.", "withdrawalNotice": "Yes, annual notice", "subjectRequirements": "Required instruction includes English, math, science, social studies, physical education, health, library skills, fine arts, and computer proficiency", "testingRequirements": "Annual assessment required", "portfolioRequirements": "No formal statewide portfolio review, but keep records supporting the annual assessment", "officialLink": "https://www.maine.gov/doe/schools/safeschools/homeschooling", "moreInfo": "https://hslda.org/legal/maine", "lastReviewed": "2026-04-07"},
  "Maryland":{"requirement": "High", "difficulty": "High", "description": "Families either homeschool under the portfolio option or under an umbrella church/nonpublic school option.", "withdrawalNotice": "Yes, notice of consent for the portfolio option", "subjectRequirements": "Regular, thorough instruction in the required subjects", "testingRequirements": "No routine statewide test mandate, but the portfolio option requires periodic review", "portfolioRequirements": "Portfolio option requires a portfolio reviewed by the local superintendent or designee", "officialLink": "https://marylandpublicschools.org/about/Pages/DEE/PNPSA/Home-Instruction/index.aspx", "moreInfo": "https://hslda.org/legal/maryland", "lastReviewed": "2026-04-07"},
  "Massachusetts":{"requirement": "High", "difficulty": "High", "description": "Parents must obtain district approval before beginning home instruction.", "withdrawalNotice": "Yes, approval requested before starting", "subjectRequirements": "Subjects generally set by district approval based on compulsory instruction standards", "testingRequirements": "Assessment/evaluation is set through the district approval process", "portfolioRequirements": "No single statewide portfolio form, but districts may require work samples, plans, or progress evidence", "officialLink": "https://www.doe.mass.edu/homeschool/", "moreInfo": "https://hslda.org/legal/massachusetts", "lastReviewed": "2026-04-07"},
  "Michigan":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents may homeschool under the homeschool statute or operate as a nonpublic school.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "Reading, spelling, math, science, history, civics, literature, writing, and grammar under the homeschool statute", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://www.michigan.gov/mde/services/flexible-learning/home-schooling", "moreInfo": "https://hslda.org/legal/michigan", "lastReviewed": "2026-04-07"},
  "Minnesota":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file annual reporting and meet required instruction/teacher provisions.", "withdrawalNotice": "Yes, annual reporting", "subjectRequirements": "Required basic subjects include reading, writing, literature, fine arts, math, science, history, geography, economics, government, citizenship, health, and physical education", "testingRequirements": "Annual nationally normed test required", "portfolioRequirements": "No statewide portfolio review, but detailed records should be kept to support compliance", "officialLink": "https://education.mn.gov/MDE/fam/home/", "moreInfo": "https://hslda.org/legal/minnesota", "lastReviewed": "2026-04-07"},
  "Mississippi":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents file a simple certificate of enrollment annually with the local attendance officer.", "withdrawalNotice": "Yes, annual certificate of enrollment", "subjectRequirements": "No statewide subject list", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep enrollment and attendance records recommended", "officialLink": "https://www.mdek12.org/OTL/HomeSchool", "moreInfo": "https://hslda.org/legal/mississippi", "lastReviewed": "2026-04-07"},
  "Missouri":{"requirement": "Easy", "difficulty": "Easy", "description": "Missouri requires substantial recordkeeping but no notice filing.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "No rigid state subject checklist, but core instruction and minimum hours are required", "testingRequirements": "No statewide testing", "portfolioRequirements": "Parents must keep records such as a plan book, diary/log, samples, and evaluations", "officialLink": "https://dese.mo.gov/governmental-affairs/home-schooling", "moreInfo": "https://hslda.org/legal/missouri", "lastReviewed": "2026-04-07"},
  "Montana":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file annual notice and keep key records.", "withdrawalNotice": "Yes, annual notice", "subjectRequirements": "Instruction must include organized course of study in required basic subjects", "testingRequirements": "No statewide testing", "portfolioRequirements": "Keep attendance and immunization records plus course records; no statewide portfolio review", "officialLink": "https://opi.mt.gov/Parents-Students/School-Choices/Home-School", "moreInfo": "https://hslda.org/legal/montana", "lastReviewed": "2026-04-07"},
  "Nebraska":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families homeschool through the exempt school process and file yearly paperwork with the state.", "withdrawalNotice": "Yes, annual exempt school filing", "subjectRequirements": "Required instructional areas are addressed through the exempt school filing", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio review, but required paperwork and attendance/instructional records should be kept", "officialLink": "https://www.education.ne.gov/fos/parents/", "moreInfo": "https://hslda.org/legal/nebraska", "lastReviewed": "2026-04-07"},
  "Nevada":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents file a one-time notice of intent with an educational plan.", "withdrawalNotice": "Yes, one-time notice of intent", "subjectRequirements": "English, math, science, and social studies", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep notice and work records recommended", "officialLink": "https://doe.nv.gov/Parents/Homeschooling/", "moreInfo": "https://hslda.org/legal/nevada", "lastReviewed": "2026-04-07"},
  "New Hampshire":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families file one-time notification and complete an annual educational evaluation.", "withdrawalNotice": "Yes, one-time notification", "subjectRequirements": "Science, math, language, government, history, health, reading, writing, spelling, the history of the constitutions, and exposure to art and music", "testingRequirements": "Annual evaluation required", "portfolioRequirements": "No state-run portfolio review, but families typically maintain a portfolio for the annual evaluation", "officialLink": "https://www.education.nh.gov/parents-and-students/home-schooling", "moreInfo": "https://hslda.org/legal/new-hampshire", "lastReviewed": "2026-04-07"},
  "New Jersey":{"requirement": "Easy", "difficulty": "Easy", "description": "New Jersey has very low regulation if the child receives academically equivalent instruction elsewhere than public school.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "Instruction must be academically equivalent to what is provided in public school", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://www.nj.gov/education/nonpublic/home/", "moreInfo": "https://hslda.org/legal/new-jersey", "lastReviewed": "2026-04-07"},
  "New Mexico":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file annual notification and meet instructional day requirements.", "withdrawalNotice": "Yes, annual notification", "subjectRequirements": "Reading, language arts, math, social studies, and science", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep immunization/exemption and attendance records", "officialLink": "https://webnew.ped.state.nm.us/bureaus/options-parents-families/home-schools/", "moreInfo": "https://hslda.org/legal/new-mexico", "lastReviewed": "2026-04-07"},
  "New York":{"requirement": "High", "difficulty": "High", "description": "Parents submit a notice of intent, IHIP, quarterly reports, and an annual assessment.", "withdrawalNotice": "Yes, annual notice of intent", "subjectRequirements": "Required subjects vary by grade band and are detailed in regulation", "testingRequirements": "Annual assessment required, with standardized testing in certain grade bands", "portfolioRequirements": "Keep IHIP, quarterly reports, and supporting records; many families also maintain a working portfolio", "officialLink": "https://www.nysed.gov/nonpublic-schools/home-instruction", "moreInfo": "https://hslda.org/legal/new-york", "lastReviewed": "2026-04-07"},
  "North Carolina":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file a notice of intent and operate a home school while keeping required records.", "withdrawalNotice": "Yes, notice of intent to operate a homeschool", "subjectRequirements": "Math, English language arts, science, and social studies", "testingRequirements": "Nationally standardized test each year", "portfolioRequirements": "Keep attendance and immunization records plus yearly test results; not a portfolio review state", "officialLink": "https://www.doa.nc.gov/divisions/non-public-education/home-schools", "moreInfo": "https://hslda.org/legal/north-carolina", "lastReviewed": "2026-04-07"},
  "North Dakota":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents notify the district and meet qualification, monitoring, or assessment rules depending on circumstances.", "withdrawalNotice": "Yes", "subjectRequirements": "Required core subjects under state law", "testingRequirements": "Assessment or monitoring may apply depending on parent qualifications and student performance", "portfolioRequirements": "No statewide portfolio review, but keep instructional records and assessment records", "officialLink": "https://www.nd.gov/dpi/parentscommunity/choosing-school-educational-path/home-schooling", "moreInfo": "https://hslda.org/legal/north-dakota", "lastReviewed": "2026-04-07"},
  "Ohio":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families provide annual notification and an academic assessment for the previous year.", "withdrawalNotice": "Yes, annual notification", "subjectRequirements": "Required subjects are listed in Ohio's home education rule", "testingRequirements": "Annual assessment required through test, portfolio review, or other approved method", "portfolioRequirements": "No statewide portfolio filing, but a portfolio review may be used as the annual assessment method", "officialLink": "https://education.ohio.gov/Topics/Ohio-Education-Options/Home-Schooling", "moreInfo": "https://hslda.org/legal/ohio", "lastReviewed": "2026-04-07"},
  "Oklahoma":{"requirement": "Easy", "difficulty": "Easy", "description": "Oklahoma has among the least restrictive homeschool laws.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "No specific statewide subject list", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://sde.ok.gov/home-school", "moreInfo": "https://hslda.org/legal/oklahoma", "lastReviewed": "2026-04-07"},
  "Oregon":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents notify their local education service district and comply with testing at certain grades.", "withdrawalNotice": "Yes, one-time notice per child to ESD", "subjectRequirements": "No detailed statewide subject list, but instruction must progress appropriately", "testingRequirements": "Standardized testing required in grades 3, 5, 8, and 10", "portfolioRequirements": "No statewide portfolio requirement stated; keep instructional and test records", "officialLink": "https://www.oregon.gov/ode/learning-options/HomeSchool/Pages/default.aspx", "moreInfo": "https://hslda.org/legal/oregon", "lastReviewed": "2026-04-07"},
  "Pennsylvania":{"requirement": "High", "difficulty": "High", "description": "Parents file a notarized affidavit, maintain a portfolio, and obtain an annual evaluation.", "withdrawalNotice": "Yes, annual affidavit before homeschool begins", "subjectRequirements": "Extensive subject requirements by grade band", "testingRequirements": "Annual evaluation required; standardized testing in grades 3, 5, and 8", "portfolioRequirements": "A portfolio of records and materials is required", "officialLink": "https://www.education.pa.gov/K-12/Home%20Education%20and%20Private%20Tutoring/Pages/default.aspx", "moreInfo": "https://hslda.org/legal/pennsylvania", "lastReviewed": "2026-04-07"},
  "Rhode Island":{"requirement": "High", "difficulty": "High", "description": "Families generally obtain local school committee approval under the state's home instruction regulation.", "withdrawalNotice": "Yes, district approval process", "subjectRequirements": "Subjects and program details are reviewed in the approval process", "testingRequirements": "Assessment/reporting may be required by the approving district", "portfolioRequirements": "No single statewide portfolio rule; keep records and comply with district approval terms", "officialLink": "https://ride.ri.gov/studentsfamilies/educationprograms/home-schooling", "moreInfo": "https://hslda.org/legal/rhode-island", "lastReviewed": "2026-04-07"},
  "South Carolina":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families may homeschool under district approval, the SCAIHS option, or a 3rd-option accountability association.", "withdrawalNotice": "Varies by option", "subjectRequirements": "Reading, writing, math, science, and social studies are commonly required across options", "testingRequirements": "Varies by option; no universal statewide testing across all options", "portfolioRequirements": "Recordkeeping varies by option; maintain plan books, attendance, and student progress records", "officialLink": "https://ed.sc.gov/districts-schools/state-accountability/home-schooling/", "moreInfo": "https://hslda.org/legal/south-carolina", "lastReviewed": "2026-04-07"},
  "South Dakota":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file a notification and typically complete a standardized test in select grades.", "withdrawalNotice": "Yes, annual notification", "subjectRequirements": "Basic skills and core instruction required", "testingRequirements": "Standardized testing in grades 4, 8, and 11", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://doe.sd.gov/home-school/", "moreInfo": "https://hslda.org/legal/south-dakota", "lastReviewed": "2026-04-07"},
  "Tennessee":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families may homeschool independently, through a church-related school, or through an accredited online school.", "withdrawalNotice": "Varies by option", "subjectRequirements": "Independent homeschoolers teach required subjects under state law", "testingRequirements": "Testing applies to the independent option in certain grades", "portfolioRequirements": "No statewide portfolio review, but attendance and vaccination or exemption records may apply by option", "officialLink": "https://www.tn.gov/education/families/school-options/home-schooling.html", "moreInfo": "https://hslda.org/legal/tennessee", "lastReviewed": "2026-04-07"},
  "Texas":{"requirement": "Easy", "difficulty": "Easy", "description": "Homeschools are legally treated as private schools with very low regulation.", "withdrawalNotice": "Yes if withdrawing from public school", "subjectRequirements": "Reading, spelling, grammar, math, and good citizenship", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://tea.texas.gov/texas-schools/general-information/finding-a-school-for-your-child/alternative-schooling", "moreInfo": "https://hslda.org/legal/texas", "lastReviewed": "2026-04-07"},
  "Utah":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents file a simple affidavit with the local district.", "withdrawalNotice": "Yes, affidavit", "subjectRequirements": "No statewide subject list", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://www.schools.utah.gov/curr/homeschool", "moreInfo": "https://hslda.org/legal/utah", "lastReviewed": "2026-04-07"},
  "Vermont":{"requirement": "High", "difficulty": "High", "description": "Families file a home study enrollment notice and provide annual assessment results.", "withdrawalNotice": "Yes, annual enrollment notice", "subjectRequirements": "Minimum course of study is required by law", "testingRequirements": "Annual assessment required", "portfolioRequirements": "No single statewide portfolio filing, but families should keep work and progress records for compliance", "officialLink": "https://education.vermont.gov/student-learning/flexible-pathways/home-study", "moreInfo": "https://hslda.org/legal/vermont", "lastReviewed": "2026-04-07"},
  "Virginia":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Most families file annual notice and provide evidence of progress each year.", "withdrawalNotice": "Yes, annual notice", "subjectRequirements": "No universal detailed subject list, but a program of study must be provided", "testingRequirements": "Annual evidence of progress required through testing, evaluation, or another approved measure", "portfolioRequirements": "No statewide portfolio review, but records should support the annual progress submission", "officialLink": "https://www.doe.virginia.gov/parents-students/for-parents/home-instruction", "moreInfo": "https://hslda.org/legal/virginia", "lastReviewed": "2026-04-07"},
  "Washington":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Parents file an annual declaration of intent and must meet parent qualification rules.", "withdrawalNotice": "Yes, annual declaration of intent", "subjectRequirements": "Occupational education, science, math, language, social studies, history, health, reading, writing, spelling, art, and music appreciation", "testingRequirements": "Annual assessment or evaluation required", "portfolioRequirements": "No statewide portfolio filing, but families should keep records supporting the annual assessment", "officialLink": "https://ospi.k12.wa.us/student-success/learning-alternatives/home-schooling", "moreInfo": "https://hslda.org/legal/washington", "lastReviewed": "2026-04-07"},
  "West Virginia":{"requirement": "Moderate", "difficulty": "Moderate", "description": "Families may homeschool under notice, church school, or private school options.", "withdrawalNotice": "Varies by option", "subjectRequirements": "Required instruction varies by option", "testingRequirements": "Assessment may apply depending on the option chosen", "portfolioRequirements": "Recordkeeping varies by option; keep notice, attendance, and assessment records", "officialLink": "https://wvde.us/school-choice/home-schooling/", "moreInfo": "https://hslda.org/legal/west-virginia", "lastReviewed": "2026-04-07"},
  "Wisconsin":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents file an annual PI-1206 form and operate a home-based private educational program.", "withdrawalNotice": "Yes, annual PI-1206 form", "subjectRequirements": "A sequentially progressive curriculum in reading, language arts, math, social studies, science, and health", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep records recommended", "officialLink": "https://dpi.wi.gov/sms/home-based", "moreInfo": "https://hslda.org/legal/wisconsin", "lastReviewed": "2026-04-07"},
  "Wyoming":{"requirement": "Easy", "difficulty": "Easy", "description": "Parents submit a curriculum to the local board annually.", "withdrawalNotice": "Yes, annual curriculum submission", "subjectRequirements": "Reading, writing, math, civics, history, literature, and science", "testingRequirements": "No statewide testing", "portfolioRequirements": "No statewide portfolio requirement stated; keep curriculum submission and records recommended", "officialLink": "https://edu.wyoming.gov/for-parents/home-schools/", "moreInfo": "https://hslda.org/legal/wyoming", "lastReviewed": "2026-04-07"}
};

app.get('/api/legal/states', (req, res) => {
  const states = Object.entries(STATE_LAWS).map(([state, data]) => ({
    state, requirement: data.requirement, difficulty: data.difficulty, description: data.description, officialLink: data.officialLink, lastReviewed: data.lastReviewed
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

// Detailed affiliate clicks — grouped per-day and per-curriculum, plus a raw list
// Query params:
//   days=30               time window
//   includeTest=1         include clicks tagged from admin/test browsers (default: exclude)
app.get('/api/admin/affiliate-clicks', requireAdmin, (req, res) => {
  const db = readDB();
  if (!db) return res.status(500).json({ error: 'Database error' });
  const includeTest = req.query.includeTest === '1' || req.query.includeTest === 'true';
  const allClicks = (db.affiliateClicks || []).slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
  const clicks = includeTest ? allClicks : allClicks.filter(c => !c.isTest);
  const days = parseInt(req.query.days) || 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const inRange = clicks.filter(c => new Date(c.timestamp) >= since);
  const testClicksInRange = allClicks.filter(c => c.isTest && new Date(c.timestamp) >= since).length;

  // Build a curriculum → affiliate-link lookup so we can show the actual URL
  const curriculumLookup = {};
  (db.curricula || []).forEach(c => { curriculumLookup[c.id] = { name: c.name, link: c.affiliateLink || c.discountLink || c.website, emoji: c.emoji }; });

  // Daily totals (YYYY-MM-DD → count)
  const daily = {};
  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    daily[d] = 0;
  }
  inRange.forEach(c => {
    const day = new Date(c.timestamp).toISOString().slice(0, 10);
    if (daily[day] !== undefined) daily[day]++;
  });
  const dailySeries = Object.entries(daily).sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count }));

  // Per-curriculum totals (in range)
  const byCurriculum = {};
  inRange.forEach(c => {
    const key = c.curriculumId;
    if (!byCurriculum[key]) {
      const info = curriculumLookup[key] || {};
      byCurriculum[key] = { curriculumId: key, name: c.curriculumName, emoji: info.emoji || '', link: info.link || '', count: 0, lastClick: c.timestamp };
    }
    byCurriculum[key].count++;
    if (new Date(c.timestamp) > new Date(byCurriculum[key].lastClick)) byCurriculum[key].lastClick = c.timestamp;
  });
  const topCurricula = Object.values(byCurriculum).sort((a, b) => b.count - a.count);

  // Recent raw clicks (enriched with the affiliate link + test flag)
  const recent = inRange.slice(0, 200).map(c => ({
    id: c.id,
    curriculumId: c.curriculumId,
    curriculumName: c.curriculumName,
    link: (curriculumLookup[c.curriculumId] && curriculumLookup[c.curriculumId].link) || '',
    timestamp: c.timestamp,
    referrer: c.referrer,
    userAgent: c.userAgent,
    isTest: !!c.isTest
  }));

  res.json({
    totalInRange: inRange.length,
    totalAllTime: clicks.length,
    testClicksInRange,
    includeTest,
    days,
    dailySeries,
    topCurricula,
    recent
  });
});

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

// One-time: update curricula (add missing, remove test entries)
app.post('/api/admin/update-curricula', requireAdmin, (req, res) => {
  const db = readDB();
  const testNames = ['Email Test', 'Port 465 Test', 'Resend Test', 'Test'];
  const removedCount = db.curricula.filter(c => testNames.includes(c.name)).length;
  db.curricula = db.curricula.filter(c => !testNames.includes(c.name));
  const newCurricula = req.body.curricula || [];
  const maxId = Math.max(0, ...db.curricula.map(c => c.id));
  let added = 0;
  newCurricula.forEach(c => {
    if (!db.curricula.find(ex => ex.slug === c.slug)) {
      db.curricula.push({ ...c, id: maxId + 1 + added, rating: 0, reviewCount: 0, active: true, featured: false, sponsored: false, longDescription: c.description, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      added++;
    }
  });
  writeDB(db);
  res.json({ success: true, message: `Added ${added}, removed ${removedCount} test entries. Total: ${db.curricula.length}` });
});

// One-time: reset all ratings and demo reviews
app.post('/api/admin/reset-reviews', requireAdmin, (req, res) => {
  const db = readDB();
  let count = 0;
  (db.curricula||[]).forEach(c => { c.rating = 0; c.reviewCount = 0; count++; });
  const reviewCount = (db.reviews||[]).length;
  db.reviews = [];
  writeDB(db);
  res.json({ success: true, message: `Reset ${count} curricula ratings, removed ${reviewCount} reviews` });
});
// Bulk update curricula filters
app.put('/api/admin/curricula/bulk-update', requireAdmin, (req, res) => {
  const { updates } = req.body; // Array of { id, style, worldview, format, special, subject }
  if (!Array.isArray(updates)) return res.status(400).json({ error: 'updates array required' });
  const db = readDB();
  let updated = 0;
  for (const u of updates) {
    const idx = db.curricula.findIndex(c => c.id === u.id);
    if (idx !== -1) {
      if (u.style) db.curricula[idx].style = u.style;
      if (u.worldview) db.curricula[idx].worldview = u.worldview;
      if (u.format) db.curricula[idx].format = u.format;
      if (u.subject) db.curricula[idx].subject = u.subject;
      if (u.special !== undefined) db.curricula[idx].special = u.special;
      if (u.price) db.curricula[idx].price = u.price;
      if (u.priceMin !== undefined) db.curricula[idx].priceMin = u.priceMin;
      if (u.priceMax !== undefined) db.curricula[idx].priceMax = u.priceMax;
      if (u.pricingNote !== undefined) db.curricula[idx].pricingNote = u.pricingNote;
      if (u.pricingModel) db.curricula[idx].pricingModel = u.pricingModel;
      if (u.grades) db.curricula[idx].grades = u.grades;
      // Pass clearExternalRatings:true to wipe the legacy fabricated ratings field
      if (u.clearExternalRatings === true) delete db.curricula[idx].externalRatings;
      db.curricula[idx].updatedAt = new Date().toISOString();
      updated++;
    }
  }
  writeDB(db);
  res.json({ success: true, updated });
});

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
  // Recalculate rating for affected curriculum
  const affectedCurricula = new Set(db.reviews.map(r => r.curriculumId));
  db.curricula.forEach(c => {
    const approved = db.reviews.filter(r => r.curriculumId === c.id && r.approved);
    c.rating = approved.length ? Math.round(approved.reduce((s,r) => s + r.rating, 0) / approved.length * 10) / 10 : 0;
    c.reviewCount = approved.length;
  });
  writeDB(db); res.json({ success: true });
});
// Admin: get all reviews
app.get('/api/admin/reviews', requireAdmin, (req, res) => {
  const db = readDB();
  const reviews = (db.reviews||[]).slice().reverse().map(r => {
    const c = (db.curricula||[]).find(c => c.id === r.curriculumId);
    return { ...r, curriculumName: c?.name || r.curriculumSlug || 'Unknown' };
  });
  res.json({ reviews });
});
app.get('/api/admin/inquiries', requireAdmin, (req, res) => {
  const db = readDB(); res.json({ inquiries: (db.listingInquiries||[]).slice().reverse() });
});
app.put('/api/admin/inquiries/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const inq = (db.listingInquiries||[]).find(i => i.id === req.params.id);
  if (!inq) return res.status(404).json({ error: 'Not found' });
  const prevStatus = inq.status;
  Object.assign(inq, req.body);
  writeDB(db);

  const siteUrl = process.env.SITE_URL || 'http://localhost:3001';

  // Send approval email
  if (req.body.status === 'approved' && prevStatus !== 'approved') {
    sendEmail(inq.email, `Your listing request has been approved! 🎉 — MyHomeschoolCurriculum`,
      `<h2>Great news, ${inq.contactName}!</h2>
       <p>Your listing request for <strong>${inq.curriculumName}</strong> has been approved.</p>
       <p>To get started, create your publisher account. Once you're set up, you'll be able to view analytics, manage your listing, and explore upgrade options from your dashboard.</p>
       <p><a href="${siteUrl}/publisher-portal.html" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Create Publisher Account →</a></p>
       <p>Questions? Email <a href="mailto:contact@myhomeschoolcurriculum.com">contact@myhomeschoolcurriculum.com</a></p>`);
  }

  // Send denial email
  if (req.body.status === 'denied' && prevStatus !== 'denied') {
    const reason = req.body.denyReason
      ? `<p><strong>Reason:</strong> ${req.body.denyReason}</p>`
      : '';
    sendEmail(inq.email, `Update on your listing request — MyHomeschoolCurriculum`,
      `<h2>Hi ${inq.contactName},</h2>
       <p>Thank you for your interest in listing <strong>${inq.curriculumName}</strong> on MyHomeschoolCurriculum.</p>
       <p>After reviewing your inquiry, we're unable to approve your listing at this time.</p>
       ${reason}
       <p>If you have questions or would like to discuss further, feel free to reach out to us at <a href="mailto:contact@myhomeschoolcurriculum.com">contact@myhomeschoolcurriculum.com</a>.</p>
       <p>— The MyHomeschoolCurriculum Team</p>`);
  }

  res.json({ success: true });
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
// Googlebot requests /favicon.ico by default — route it to the 48px PNG so the
// crawler always gets a real branded icon even though our primary is SVG.
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'frontend/brand/png/favicon-48.png'));
});

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

  const today = new Date().toISOString().split('T')[0];
  const urls = [
    { loc: '/', priority: '1.0', changefreq: 'daily', lastmod: today },
    { loc: '/blog', priority: '0.9', changefreq: 'weekly', lastmod: today },
    { loc: '/legal', priority: '0.7', changefreq: 'monthly', lastmod: today },
    { loc: '/about', priority: '0.6', changefreq: 'monthly', lastmod: today },
    { loc: '/publisher', priority: '0.5', changefreq: 'monthly', lastmod: today },
    ...posts.map(p => ({
      loc: `/blog?post=${p.slug}`,
      priority: '0.8',
      changefreq: 'monthly',
      lastmod: (p.updatedAt || p.publishedAt || p.createdAt || today).split('T')[0]
    })),
    ...states.map(s => ({
      loc: `/legal?state=${encodeURIComponent(s)}`,
      priority: '0.5',
      changefreq: 'yearly',
      lastmod: today
    })),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${siteUrl}${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;

  res.type('application/xml').send(xml);
});

// ─── SERVE FRONTEND ──────────────────────────────────────────────────────────
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin/index.html')));
app.get('/publisher', (req, res) => res.sendFile(path.join(__dirname, 'frontend/publisher.html')));
function escapeHtmlAttr(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Inject server-side meta tags for blog post URLs so social crawlers (Facebook,
// Twitter, LinkedIn) that don't execute JS still get per-post Open Graph data.
app.get('/blog', (req, res) => {
  const file = path.join(__dirname, 'frontend', 'blog.html');
  if (!fs.existsSync(file)) return res.sendFile(path.join(__dirname, 'frontend/index.html'));
  const slug = req.query.post;
  if (!slug) return res.sendFile(file);
  const db = readDB();
  const post = (db.blogPosts || []).find(p => p.slug === slug && p.published);
  if (!post) return res.sendFile(file);

  const siteUrl = (process.env.SITE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
  const title = post.metaTitle || post.title;
  const desc = post.metaDescription || post.excerpt || '';
  const img = post.ogImage || post.featuredImage || `${siteUrl}/brand/png/og-image-1200x630.png`;
  const url = `${siteUrl}/blog?post=${post.slug}`;
  const keywords = (post.keywords || post.tags || []).join(', ');
  const published = post.publishedAt || post.createdAt || '';
  const modified = post.updatedAt || published;
  const wordCount = post.wordCount || (post.content || '').split(/\s+/).filter(Boolean).length;

  const schema = JSON.stringify({
    "@context": "https://schema.org",
    "@type": "BlogPosting",
    "headline": post.title,
    "description": desc,
    "image": img,
    "author": { "@type": "Organization", "name": post.author || "My Homeschool Curriculum Team" },
    "publisher": {
      "@type": "Organization",
      "name": "My Homeschool Curriculum",
      "url": siteUrl,
      "logo": { "@type": "ImageObject", "url": `${siteUrl}/brand/png/icon-512.png` }
    },
    "datePublished": published,
    "dateModified": modified,
    "mainEntityOfPage": { "@type": "WebPage", "@id": url },
    "articleSection": post.category || 'General',
    "keywords": keywords,
    "wordCount": wordCount,
    "inLanguage": "en-US"
  });

  let html = fs.readFileSync(file, 'utf8');
  const injected = `
<title>${escapeHtmlAttr(title)} — My Homeschool Curriculum</title>
<meta name="description" content="${escapeHtmlAttr(desc)}">
<meta name="keywords" content="${escapeHtmlAttr(keywords)}">
<meta name="author" content="${escapeHtmlAttr(post.author || 'My Homeschool Curriculum Team')}">
<link rel="canonical" href="${url}">
<meta property="og:title" content="${escapeHtmlAttr(title)}">
<meta property="og:description" content="${escapeHtmlAttr(desc)}">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${escapeHtmlAttr(img)}">
<meta property="og:site_name" content="My Homeschool Curriculum">
<meta property="article:published_time" content="${published}">
<meta property="article:modified_time" content="${modified}">
<meta property="article:section" content="${escapeHtmlAttr(post.category || 'General')}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeHtmlAttr(title)}">
<meta name="twitter:description" content="${escapeHtmlAttr(desc)}">
<meta name="twitter:image" content="${escapeHtmlAttr(img)}">
<script type="application/ld+json">${schema}</script>
`;
  // Strip existing title + OG/Twitter/canonical/description tags then inject new ones
  html = html
    .replace(/<title>[^<]*<\/title>/i, '')
    .replace(/<meta\s+name="description"[^>]*>/gi, '')
    .replace(/<meta\s+property="og:[^"]+"[^>]*>/gi, '')
    .replace(/<meta\s+name="twitter:[^"]+"[^>]*>/gi, '')
    .replace(/<link\s+rel="canonical"[^>]*>/gi, '')
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/i, '')
    .replace('</head>', `${injected}</head>`);

  res.type('text/html').send(html);
});

app.get(['/legal', '/account'], (req, res) => {
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
// Initialize database before starting server
initDB().then(() => {
  app.listen(PORT, () => {
    console.log(`\n🧭 MyHomeschoolCurriculum API v2.0 → http://localhost:${PORT}`);
    console.log(`   Database:   ${pgPool ? '✅ PostgreSQL' : '⚠️  JSON file (add DATABASE_URL for persistence)'}`);
    console.log(`   Stripe:     ${stripe ? '✅ configured' : '⚠️  not configured (add STRIPE_SECRET_KEY)'}`);
    console.log(`   Email:      ${resend ? '✅ Resend API' : process.env.SMTP_USER ? '✅ SMTP' : '⚠️  not configured (add RESEND_API_KEY or SMTP_* vars)'}`);
    console.log(`   Newsletter: ${mailchimp ? '✅ Mailchimp connected' : '⚠️  local only (add MAILCHIMP_API_KEY)'}\n`);
  });
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
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER || FROM_EMAIL,
    'New Publisher Registration — My Homeschool Curriculum',
    `<h2>New publisher registered</h2><p><strong>${name}</strong> (${companyName}) registered at ${email}.</p><p><a href="${process.env.SITE_URL||'http://localhost:3001'}/admin">Review in Admin →</a></p>`);
  const portalUrl = `${process.env.SITE_URL||'http://localhost:3001'}/publisher-portal.html`;
  sendEmail(publisher.email, 'Welcome to MyHomeschoolCurriculum — Account Under Review',
    `<h2>Thanks for registering, ${publisher.name}!</h2><p>Your publisher account for <strong>${publisher.companyName}</strong> is under review. Our team will approve your account within 2 business days.</p><p>You'll receive an email once approved. In the meantime, you can log in to explore the publisher portal:</p><p><a href="${portalUrl}" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Log in to Publisher Portal →</a></p><p>Questions? Email <a href="mailto:contact@myhomeschoolcurriculum.com">contact@myhomeschoolcurriculum.com</a></p>`);
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
    })),
    reviews: reviews.map(r => ({
      id: r.id, curriculumId: r.curriculumId, curriculumName: (curricula.find(c => c.id === r.curriculumId)||{}).name || 'Unknown',
      name: r.name, rating: r.rating, title: r.title, body: r.body,
      location: r.location, gradesUsed: r.gradesUsed, createdAt: r.createdAt
    }))
  });
});

// Update publisher profile
app.put('/api/publisher/profile', requirePublisher, (req, res) => {
  const db = readDB();
  const publisher = (db.publishers||[]).find(p => p.id === req.publisherId);
  if (!publisher) return res.status(404).json({ error: 'Not found.' });
  const { name, companyName, website, tier } = req.body;
  if (name) publisher.name = name.trim();
  if (companyName) publisher.companyName = companyName.trim();
  if (website !== undefined) publisher.website = website;
  // Allow downgrade to standard (remove affiliate links from curricula)
  if (tier === 'standard' && publisher.tier !== 'standard') {
    publisher.tier = 'standard';
    // Remove affiliate links from their linked curricula
    (publisher.curriculumIds||[]).forEach(cid => {
      const c = (db.curricula||[]).find(cur => cur.id === cid);
      if (c && c.type === 'affiliate') { c.affiliateLink = ''; c.type = 'standard'; }
    });
  }
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

// Publisher: apply for affiliate (auto-approve with link per curriculum)
app.post('/api/publisher/apply-affiliate', requirePublisher, (req, res) => {
  const { affiliateLink, curriculumId } = req.body;
  if (!affiliateLink || !/^https?:\/\/.+/i.test(affiliateLink))
    return res.status(400).json({ error: 'Please provide a valid affiliate link (starting with http:// or https://).' });
  const db = readDB();
  const publisher = (db.publishers||[]).find(p => p.id === req.publisherId);
  if (!publisher) return res.status(404).json({ error: 'Publisher not found.' });

  // Update publisher tier to affiliate
  publisher.tier = 'affiliate';

  // Store affiliate link on the specific curriculum
  let curriculumName = 'their account';
  if (curriculumId) {
    const curriculum = (db.curricula||[]).find(c => c.id === curriculumId);
    if (curriculum && publisher.curriculumIds.includes(curriculumId)) {
      curriculum.affiliateLink = affiliateLink.trim();
      curriculum.type = 'affiliate';
      curriculumName = curriculum.name;
    }
  }

  writeDB(db);
  sendEmail(process.env.ADMIN_EMAIL || process.env.SMTP_USER || FROM_EMAIL,
    `🔗 Affiliate link added — ${publisher.companyName}`,
    `<h2>Affiliate Link Update</h2><p><strong>${publisher.name}</strong> (${publisher.companyName}) provided an affiliate link for <strong>${curriculumName}</strong>.</p><p><strong>Link:</strong> <a href="${affiliateLink}">${affiliateLink}</a></p><p>This has been automatically applied to the curriculum listing.</p>`);
  res.json({ success: true, message: 'Affiliate link added!' });
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
    <p>Your account for <strong>${publisher.companyName}</strong> has been approved!</p>
    <p>Log in to your publisher dashboard to view analytics, manage your listing, and explore available plans:</p>
    <p><a href="${process.env.SITE_URL||'http://localhost:3001'}/publisher-portal.html" style="background:#4A7550;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block">Access Publisher Portal →</a></p>
    <p>Questions? Reply to this email or contact us at contact@myhomeschoolcurriculum.com</p>`);
  res.json({ success: true });
});

// Admin: get all publishers
app.get('/api/admin/publishers', requireAdmin, (req, res) => {
  const db = readDB();
  res.json({ publishers: (db.publishers||[]).slice().reverse() });
});

// Admin: edit publisher
app.put('/api/admin/publishers/:id', requireAdmin, (req, res) => {
  const db = readDB();
  const publisher = (db.publishers||[]).find(p => p.id === req.params.id);
  if (!publisher) return res.status(404).json({ error: 'Publisher not found.' });
  const { name, companyName, email, website, tier, status, curriculumIds } = req.body;
  if (name !== undefined) publisher.name = name.trim();
  if (companyName !== undefined) publisher.companyName = companyName.trim();
  if (email !== undefined) publisher.email = email.trim().toLowerCase();
  if (website !== undefined) publisher.website = website.trim();
  if (tier !== undefined) publisher.tier = tier;
  if (curriculumIds !== undefined) publisher.curriculumIds = curriculumIds;
  if (status !== undefined) {
    publisher.status = status;
    if (status === 'deactivated') publisher.approved = false;
    if (status === 'active') publisher.approved = true;
  }
  writeDB(db);
  res.json({ success: true });
});

// Serve publisher portal page
app.get('/publisher-portal', (req, res) => res.sendFile(path.join(__dirname, 'frontend/publisher-portal.html')));
