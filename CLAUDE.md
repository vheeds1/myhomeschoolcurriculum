# My Homeschool Curriculum — Project Instructions for Claude

## What this project is

**myhomeschoolcurriculum.com** — a free web tool that helps homeschool parents
compare 60+ curricula by grade, teaching style, worldview, and budget. Includes
a recommendation quiz, side-by-side comparison, parent reviews, a 50-state
homeschool law guide, and an editorial blog (20+ posts).

## Stack

- **Backend**: Node.js + Express, all routes in `backend/server.js`
- **Frontend**: Vanilla HTML/CSS/JS (no build step) under `backend/frontend/`
- **Admin**: `backend/admin/index.html` — single-file dashboard
- **Database**: PostgreSQL on Railway via JSONB single-table pattern;
  `backend/db/database.json` is the local/dev fallback and source of truth
  for schema shape. `readDB()` / `writeDB()` helpers in `server.js`
- **Auth**: Admin token in env (`ADMIN_TOKEN`), stored client-side as
  `cc_admin_token` in localStorage. Publishers use session tokens via
  `requirePublisher` middleware. End users use `requireUser`
- **Email**: Resend API (Railway blocks SMTP ports; do NOT reintroduce SMTP)
- **Payments**: Stripe Checkout + webhooks for publisher subscriptions
  (Silver $49/mo, Gold $149/mo)
- **Deploy**: Railway auto-deploys from `main` branch on GitHub

## Key conventions

- Production DB is PostgreSQL; bulk changes to `database.json` must be pushed
  to production via the sync scripts (`sync-filters-to-production.js`,
  `sync-blog-to-production.js`) using `ADMIN_TOKEN` env var
- Every page shares the Athenaeum brand mark (inline SVG icon) and the
  Fraunces wordmark with italic-gold "Curriculum" — when adding new pages,
  copy the header from `index.html`
- Blog posts use a custom markdown flavor: `![alt](url)` for images,
  triple-backtick-`html` fences for raw HTML (Amazon widgets, iframes),
  `::product` blocks for affiliate product cards, and `> 💡 Tip:` /
  `> ⚠️ Warning:` for styled callouts
- Affiliate clicks from browsers with `cc_admin_token` in localStorage are
  auto-tagged `isTest: true` and excluded from analytics by default
- Always preserve: filters, quiz, newsletter signup, direct-URL navigation
  (browser back/forward), SSR meta injection for blog posts, mobile nav,
  skip links, focus-visible outlines

## Never

- Commit secrets or modify `.env` without the user asking
- Run destructive git commands (`push --force`, `reset --hard`) without
  explicit permission
- Use Clearbit Logo API (shut down 2024) — use Google favicons
  (`/s2/favicons?domain=X&sz=128`) instead
- Add the `<em>Perfect</em>` gold-italic styling to anything other than
  the hero h1 and wordmark "Curriculum" — it's the brand signature

---

## Design Context

### Users

**Primary user**: A parent (typically mom) who is new to homeschooling,
researching for the upcoming school year. Often at the kitchen table after
kids go to bed, or on her phone during nap time. 15-minute sessions, not
long ones. She arrives feeling overwhelmed.

**Job to be done**: Narrow 60+ options down to a confident shortlist of 2–3
that fit her family's grade, style, worldview, and budget.

**Emotional outcome** (what she should feel leaving a session):
1. Confident — "I can make this decision."
2. Validated — "My priorities are respected. This site isn't pushing me
   toward any one answer."

### Brand Personality

**Three words**: Trustworthy · Helpful · Grounded

**Voice**: Personal, no-BS helpful, like a friend who already did the research
and is handing you her notes. Matches founder Vanessa's voice — military
veteran + MBA + homeschool mom who "just wants something that works without
hours of extra planning."

**Not**:
- MLM landing page (no hype, no testimonial carousels)
- BuzzFeed listicle ("17 Things You Won't Believe…")
- Edtech SaaS demo (no neon gradients, no "powered by AI" badges)
- Corporate sterile (this is small, personal, hand-built — not VC-polished)

### Aesthetic Direction

**Palette** (committed brand system — see `/brand/` directory):

- Navy `#1F3A4D` — primary surface, headings
- Gold `#D4A84C` — accent, italic emphasis, CTAs on light
- Coral `#D57A5A` — secondary CTAs on navy
- Sage `#7A9E7E` / Deep Sage `#4A7550` — success, filters, tags
- Cream `#FDF6EC` / Warm White `#FFFBF5` — page backgrounds
- Paper `#F0EBE5` — subtle surface variation

**Typography** (committed):
- **Fraunces** — display + wordmark. Italic "Curriculum" is the signature.
- **DM Sans** — body + UI
- Playfair Display — fallback only

**Theme**: Light-only. (Dark mode not planned; revisit if late-night
analytics warrant it.)

**Tone**: Warm editorial. Reference: NYT Wirecutter, Cup of Jo. Avoid:
Linear, Notion, any dashboard aesthetic.

### Design Principles

1. **Trust over delight** — Warm, confident, clean beats playful every
   time. No decorative flourishes that don't serve the information.

2. **Editorial, not dashboard** — Magazine-style typography, real
   photography, long-form readability. Avoid metric tiles, gradient
   borders, glassmorphism.

3. **Founder voice is always visible** — Vanessa's face and story are the
   strongest trust signal. Design never competes with or abstracts away
   the personal-human-built feel.

4. **Respect the decision weight** — A curriculum is hundreds of dollars
   + a year of a child's education. No trivializing animations, no "fun"
   error states, no flippant copy.

5. **Accessibility is table stakes** — WCAG AA minimum. Dyslexia/ADHD/
   autism filters imply readers may include parents of kids with
   learning differences — clear sans for body copy, respect
   `prefers-reduced-motion`.

---

## Commits & PRs

- Follow the existing commit style: subject line under 70 chars, present
  tense, no leading emoji; body explains the **why** with bullet points
  listing the **what**
- Always include the Claude co-authorship trailer
- Only commit or push when the user asks. Otherwise just leave work
  unstaged for the user to review

## Testing

- No formal test suite. Verify changes by restarting the local backend
  preview (`mcp__Claude_Preview`) and curl-checking endpoints + loading
  affected pages
- Railway auto-deploys take ~2 minutes. Production API endpoint changes
  require waiting for the deploy before sync scripts will work
