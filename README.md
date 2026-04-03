# 🧭 MyHomeschoolCurriculum — Production Setup Guide

A full-stack homeschool curriculum discovery site with affiliate monetization, review system, publisher portal, and admin dashboard.

---

## 📁 Project Structure

```
myhomeschoolcurriculum/
├── backend/              ← Node.js + Express API
│   ├── server.js         ← Main API server
│   ├── package.json
│   └── node_modules/
├── frontend/             ← Public-facing website
│   ├── index.html        ← Main browse/search page
│   └── publisher.html    ← Publisher listing portal
├── admin/
│   └── index.html        ← Admin dashboard (token-protected)
├── db/
│   └── database.json     ← JSON database (migrate to Postgres later)
├── .env.example          ← Environment variable template
└── README.md
```

---

## 🚀 Quick Start (Local Development)

### 1. Install Dependencies
```bash
cd backend
npm install
```

### 2. Configure Environment
```bash
cp ../.env.example .env
# Edit .env with your values:
nano .env
```

**Required `.env` values:**
```env
PORT=3001
ADMIN_TOKEN=your-very-strong-random-token-here
```

**Optional (for email notifications):**
```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=your-email@gmail.com
SMTP_PASS=your-gmail-app-password
ADMIN_EMAIL=admin@yourdomain.com
```

> **Gmail tip:** Use an App Password, not your main password.  
> Create one at: https://myaccount.google.com/apppasswords

### 3. Generate a Secure Admin Token
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Copy the output into .env as ADMIN_TOKEN
```

### 4. Start the Server
```bash
# Production
npm start

# Development (auto-reload)
npm run dev
```

### 5. Open the App
- **Main site:** http://localhost:3001
- **Publisher portal:** http://localhost:3001/publisher
- **Admin dashboard:** http://localhost:3001/admin

---

## 🌐 Deployment (Production)

### Option A: Railway (Easiest — free tier available)
1. Push your code to GitHub
2. Go to https://railway.app → New Project → Deploy from GitHub
3. Set environment variables in Railway dashboard
4. Done! Railway handles HTTPS, scaling, and uptime.

### Option B: Render.com
1. Create account at https://render.com
2. New Web Service → Connect GitHub repo
3. Build command: `cd backend && npm install`
4. Start command: `cd backend && node server.js`
5. Add environment variables in Render dashboard

### Option C: VPS (DigitalOcean, Linode, etc.)
```bash
# Install Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# Install PM2 for process management
npm install -g pm2

# Clone your repo
git clone https://github.com/yourname/myhomeschoolcurriculum.git
cd myhomeschoolcurriculum/backend
npm install
cp ../.env.example .env
nano .env  # Fill in values

# Start with PM2
pm2 start server.js --name myhomeschoolcurriculum
pm2 save
pm2 startup

# Set up Nginx reverse proxy (optional, for custom domain)
```

### Custom Domain (all providers)
Point your domain's DNS A record to your server IP.
Add to `.env`:
```env
myhomeschoolcurriculum.com=https://www.myhomeschoolcurriculum.com
ALLOWED_ORIGINS=https://myhomeschoolcurriculum.com,https://www.myhomeschoolcurriculum.com
```

---

## 🗄️ Upgrading to a Real Database (PostgreSQL)

The JSON file database is great for getting started but won't scale beyond ~10k records. When you're ready:

### 1. Install PostgreSQL adapter
```bash
npm install pg
```

### 2. Create tables
```sql
CREATE TABLE curricula (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  data JSONB NOT NULL,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  curriculum_id INTEGER REFERENCES curricula(id),
  curriculum_slug VARCHAR(255),
  name VARCHAR(255),
  email VARCHAR(255),
  rating INTEGER CHECK (rating BETWEEN 1 AND 5),
  title VARCHAR(500),
  body TEXT,
  approved BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE affiliate_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id INTEGER,
  curriculum_name VARCHAR(255),
  affiliate_code VARCHAR(100),
  ip VARCHAR(64),
  timestamp TIMESTAMP DEFAULT NOW()
);

CREATE TABLE listing_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name VARCHAR(255),
  contact_name VARCHAR(255),
  email VARCHAR(255),
  curriculum_name VARCHAR(255),
  listing_type VARCHAR(50),
  data JSONB,
  status VARCHAR(50) DEFAULT 'new',
  created_at TIMESTAMP DEFAULT NOW()
);
```

### 3. Replace `readDB()`/`writeDB()` in server.js with `pg` queries.

---

## 💰 Monetization Setup

### Affiliate Links
Each curriculum in `database.json` has:
- `affiliateLink` — the tracked referral URL
- `affiliateCode` — discount code to offer users
- `commissionRate` — your commission % (for tracking)

**To add real affiliate links:**
1. Sign up for each curriculum's affiliate program
2. Update `affiliateLink` in `database.json` or via Admin → Edit Curriculum
3. All clicks are tracked in `affiliateClicks` array with timestamps

### Sponsored/Featured Listings
Set in the database:
```json
{
  "type": "sponsored",
  "featured": true,
  "sponsorTier": "platinum"
}
```

Tiers: `standard` (free) → `affiliate` → `silver` ($49/mo) → `gold` ($149/mo) → `platinum` ($299/mo)

**Payment processing** — integrate Stripe for recurring billing:
```bash
npm install stripe
```
Then create a `/api/billing/subscribe` endpoint using Stripe Subscriptions.

---

## 📧 Email Configuration

All contact form submissions and review notifications use Nodemailer.

**For Gmail:**
1. Enable 2FA on your Google account
2. Visit https://myaccount.google.com/apppasswords
3. Generate an App Password for "Mail"
4. Add to `.env`:
```env
SMTP_USER=you@gmail.com
SMTP_PASS=abcd efgh ijkl mnop  (your 16-char app password)
```

**For production (Sendgrid, Mailgun, etc.):**
```env
SMTP_HOST=smtp.sendgrid.net
SMTP_PORT=587
SMTP_USER=apikey
SMTP_PASS=your-sendgrid-api-key
```

---

## 🔐 Admin Dashboard

Access at: `/admin`

**Token-based auth:** Set `ADMIN_TOKEN` in `.env`. Enter this token when prompted.

### Features:
- 📊 Analytics: clicks, reviews, inquiries
- 📚 Manage curricula: edit, activate/deactivate
- ⭐ Review moderation: approve or delete
- 💼 Listing inquiries: track publisher interest
- ➕ Add new curriculum listings

---

## 🧪 API Reference

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| GET | `/api/curricula` | — | List curricula with filters |
| GET | `/api/curricula/:slug` | — | Single curriculum + reviews |
| POST | `/api/curricula/:id/click` | — | Track affiliate click |
| GET | `/api/reviews/:slug` | — | Get approved reviews |
| POST | `/api/reviews` | — | Submit a review |
| POST | `/api/contact` | — | Contact form |
| POST | `/api/listing-inquiry` | — | Publisher inquiry |
| POST | `/api/quiz` | — | Get quiz matches |
| POST | `/api/auth/register` | — | Create user account |
| POST | `/api/auth/login` | — | Login, returns session token |
| GET | `/api/auth/me` | User | Get current user |
| GET | `/api/favorites` | User | Get saved curricula |
| POST | `/api/favorites/:id` | User | Save curriculum |
| DELETE | `/api/favorites/:id` | User | Remove saved curriculum |
| GET | `/api/blog` | — | List published blog posts |
| GET | `/api/blog/:slug` | — | Single blog post |
| POST | `/api/newsletter/subscribe` | — | Subscribe to newsletter |
| GET | `/api/legal/states` | — | All 50 state homeschool laws |
| GET | `/api/legal/states/:state` | — | Single state detail |
| GET | `/api/billing/plans` | — | Subscription tier info |
| POST | `/api/billing/create-subscription` | User | Start Stripe subscription |
| POST | `/api/billing/webhook` | — | Stripe webhook handler |
| GET | `/api/analytics` | Admin | Site analytics |
| GET | `/api/admin/curricula` | Admin | All curricula |
| POST | `/api/admin/curricula` | Admin | Add curriculum |
| PUT | `/api/admin/curricula/:id` | Admin | Update curriculum |
| PUT | `/api/admin/reviews/:id/approve` | Admin | Approve review |
| DELETE | `/api/admin/reviews/:id` | Admin | Delete review |
| GET | `/api/admin/inquiries` | Admin | All listing inquiries |
| PUT | `/api/admin/inquiries/:id` | Admin | Update inquiry status |
| GET | `/api/admin/messages` | Admin | All contact messages |
| GET | `/api/admin/users` | Admin | All users |
| GET | `/api/admin/blog` | Admin | All blog posts (incl. drafts) |
| GET | `/sitemap.xml` | — | Dynamic XML sitemap |
| GET | `/robots.txt` | — | Robots crawl rules |

**Filter params for GET /api/curricula:**
- `grade`, `style`, `worldview`, `format`, `subject`, `special` — comma-separated values
- `priceMax` — max annual price integer
- `search` — text search
- `sort` — `featured`, `rating`, `price-low`, `price-high`, `reviews`

---


## 📈 Features & Status

| Feature | Status |
|---|---|
| Curriculum browse + filter | ✅ Live |
| Affiliate click tracking | ✅ Live |
| Review system (with moderation) | ✅ Live |
| Quiz / curriculum matcher | ✅ Live |
| Publisher inquiry portal | ✅ Live |
| User accounts + saved favorites | ✅ Live |
| Stripe subscription billing | ✅ Live (requires Stripe keys) |
| Newsletter (Mailchimp sync) | ✅ Live (requires Mailchimp key) |
| Blog with 7 full articles | ✅ Live |
| State homeschool laws (all 50) | ✅ Live |
| Admin dashboard | ✅ Live |
| PDF comparison export | ✅ Live |
| Google Analytics 4 | ✅ Ready (add your GA4 ID) |
| Sitemap.xml + robots.txt | ✅ Live (dynamic, auto-updates) |
| PostgreSQL migration | 📋 See guide below |
| Mobile app | 🔮 Future |

---

## 🐘 PostgreSQL Migration Guide

The JSON file database works well up to ~50,000 requests/day. When you're ready to scale, migrate to PostgreSQL with this schema.

### Step 1: Install pg
```bash
cd backend
npm install pg
```

### Step 2: Create the schema
```sql
-- Run this in your PostgreSQL database

CREATE TABLE curricula (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  emoji VARCHAR(10),
  tagline TEXT,
  description TEXT,
  long_description TEXT,
  rating DECIMAL(3,1) DEFAULT 0,
  review_count INTEGER DEFAULT 0,
  price VARCHAR(100),
  price_min INTEGER,
  price_max INTEGER,
  grades TEXT[], -- e.g. ARRAY['K-2', '3-5']
  style TEXT[],
  worldview TEXT[],
  format TEXT[],
  subject TEXT[],
  special TEXT[],
  badges TEXT[],
  type VARCHAR(50) DEFAULT 'standard',
  website VARCHAR(500),
  affiliate_link VARCHAR(500),
  affiliate_code VARCHAR(100),
  commission_rate DECIMAL(5,2),
  featured BOOLEAN DEFAULT false,
  sponsored BOOLEAN DEFAULT false,
  sponsor_tier VARCHAR(50),
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE reviews (
  id SERIAL PRIMARY KEY,
  curriculum_id INTEGER REFERENCES curricula(id),
  author_name VARCHAR(255),
  rating INTEGER CHECK (rating >= 1 AND rating <= 5),
  title VARCHAR(255),
  body TEXT,
  approved BOOLEAN DEFAULT false,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255),
  email_verified BOOLEAN DEFAULT false,
  verify_token VARCHAR(255),
  reset_token VARCHAR(255),
  reset_token_expires TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  last_login_at TIMESTAMPTZ
);

CREATE TABLE user_favorites (
  id SERIAL PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  curriculum_id INTEGER REFERENCES curricula(id),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, curriculum_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  expires_at TIMESTAMPTZ
);

CREATE TABLE affiliate_clicks (
  id SERIAL PRIMARY KEY,
  curriculum_id INTEGER REFERENCES curricula(id),
  ip_hash VARCHAR(64),
  user_agent TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE listing_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name VARCHAR(255),
  contact_name VARCHAR(255),
  email VARCHAR(255),
  phone VARCHAR(50),
  curriculum_name VARCHAR(255),
  tier VARCHAR(50),
  message TEXT,
  status VARCHAR(50) DEFAULT 'new',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE contact_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255),
  email VARCHAR(255),
  subject VARCHAR(255),
  message TEXT,
  status VARCHAR(50) DEFAULT 'unread',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE blog_posts (
  id SERIAL PRIMARY KEY,
  slug VARCHAR(255) UNIQUE NOT NULL,
  title VARCHAR(500),
  excerpt TEXT,
  content TEXT,
  category VARCHAR(100),
  tags TEXT[],
  author VARCHAR(255),
  published BOOLEAN DEFAULT false,
  published_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE newsletter_subscribers (
  id SERIAL PRIMARY KEY,
  email VARCHAR(255) UNIQUE NOT NULL,
  source VARCHAR(100),
  subscribed_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE stripe_subscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  curriculum_id INTEGER REFERENCES curricula(id),
  stripe_customer_id VARCHAR(255),
  stripe_subscription_id VARCHAR(255),
  tier VARCHAR(50),
  status VARCHAR(50),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for performance
CREATE INDEX idx_curricula_active ON curricula(active);
CREATE INDEX idx_curricula_featured ON curricula(featured, sponsored);
CREATE INDEX idx_reviews_curriculum ON reviews(curriculum_id, approved);
CREATE INDEX idx_clicks_curriculum ON affiliate_clicks(curriculum_id);
CREATE INDEX idx_sessions_user ON sessions(user_id, expires_at);
CREATE INDEX idx_blog_published ON blog_posts(published, published_at DESC);
```

### Step 3: Add DATABASE_URL to .env
```env
DATABASE_URL=postgresql://username:password@host:5432/myhomeschoolcurriculum
```

### Step 4: Replace readDB/writeDB helpers
Replace the JSON file helpers in `server.js` with a `pg` pool:

```javascript
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

// Replace: const db = readDB();  →  const { rows } = await pool.query('SELECT * FROM curricula WHERE active = true');
```

### Migration Services
- **Neon** (neon.tech) — Serverless Postgres, free tier, easy Railway integration
- **Supabase** (supabase.com) — Postgres + auth + storage, generous free tier
- **Railway Postgres** — One-click add-on if you're already on Railway
- **PlanetScale** — MySQL (not Postgres) but excellent DX

---

## 🔍 SEO Setup

### Google Analytics 4
1. Create a property at analytics.google.com
2. Copy your Measurement ID (format: `G-XXXXXXXXXX`)
3. In each HTML file, find this comment and uncomment/update:
   ```javascript
   // gtag("config", "G-XXXXXXXXXX");
   ```
   Replace `G-XXXXXXXXXX` with your actual ID.

### Google Search Console
1. Go to search.google.com/search-console
2. Add your domain
3. Verify ownership via HTML tag or DNS record
4. Submit your sitemap: `https://yourdomain.com/sitemap.xml`

The sitemap is generated dynamically at `/sitemap.xml` — it automatically includes all published blog posts and state pages.

---

## 🆘 Support

Questions? Email: hello@myhomeschoolcurriculum.com

---

*Built with ❤️ for homeschool families everywhere.*

