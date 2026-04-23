// One-off script to add SEO metadata to all blog posts
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db', 'database.json');
const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));

const SITE_NAME = 'My Homeschool Curriculum';
const DEFAULT_AUTHOR = 'My Homeschool Curriculum Team';

// Per-post SEO metadata tuned for search intent + length
// Titles kept under 60 chars for SERP; descriptions under 160
const SEO_OVERRIDES = {
  'how-to-choose-homeschool-curriculum': {
    metaTitle: 'How to Choose a Homeschool Curriculum (5-Step Guide)',
    metaDescription: 'A simple 5-step framework to pick the right homeschool curriculum for your child — without spending weeks in Facebook groups.',
    keywords: ['choosing homeschool curriculum','how to pick curriculum','homeschool curriculum guide','best curriculum for my child']
  },
  'classical-vs-charlotte-mason': {
    metaTitle: 'Classical vs Charlotte Mason: Which Is Right for You?',
    metaDescription: 'A side-by-side comparison of Classical and Charlotte Mason homeschool methods so you can choose the philosophy that fits your family.',
    keywords: ['classical homeschool','charlotte mason method','homeschool philosophies','classical vs charlotte mason']
  },
  'free-homeschool-curriculum-options': {
    metaTitle: '7 Best Free Homeschool Curriculum Options (2026)',
    metaDescription: 'Seven genuinely free homeschool curricula that cover K-12 — no upsells, no trials. Reviews, grade ranges, and who each is best for.',
    keywords: ['free homeschool curriculum','homeschool on a budget','free curriculum','homeschool for free']
  },
  'homeschooling-adhd-child': {
    metaTitle: 'Homeschooling a Child with ADHD: What Actually Works',
    metaDescription: 'Practical, parent-tested strategies for homeschooling kids with ADHD — from scheduling to curriculum picks that keep focus and reduce meltdowns.',
    keywords: ['homeschool ADHD','ADHD curriculum','homeschooling ADHD child','ADHD homeschool schedule']
  },
  'high-school-homeschool-transcripts': {
    metaTitle: 'Homeschool Transcripts for College (Complete Guide)',
    metaDescription: 'How to create a homeschool high school transcript colleges actually accept — with templates, GPA tips, and what admissions officers look for.',
    keywords: ['homeschool transcripts','high school homeschool','homeschool college admission','homeschool GPA']
  },
  'homeschool-co-ops-guide': {
    metaTitle: 'Homeschool Co-ops: Everything to Know Before Joining',
    metaDescription: 'What homeschool co-ops are, how they work, the pros and cons, and how to find the right one for your family before you commit.',
    keywords: ['homeschool co-op','homeschool community','homeschool group','homeschool co-ops']
  },
  'homeschool-burnout-prevention': {
    metaTitle: 'Homeschool Burnout: Signs, Causes, and How to Prevent It',
    metaDescription: 'Homeschool burnout is real. Learn the warning signs, why it happens, and proven ways to recover so you can keep going strong.',
    keywords: ['homeschool burnout','homeschool mom burnout','homeschool fatigue','preventing homeschool burnout']
  },
  'best-homeschool-curriculum-kindergarten-2026': {
    metaTitle: 'Best Homeschool Curriculum for Kindergarten (2026)',
    metaDescription: 'The best kindergarten homeschool curriculum options for 2026 — including gentle, play-based, Christian, and secular picks, honestly reviewed.',
    keywords: ['kindergarten homeschool curriculum','best kindergarten curriculum','homeschool kindergarten 2026','kindergarten homeschool']
  },
  'best-homeschool-curriculum-multiple-children': {
    metaTitle: 'Best Homeschool Curriculum for Multiple Children',
    metaDescription: 'Top curricula that let you teach multiple ages at once — from unit studies to family-style programs that save time and keep everyone engaged.',
    keywords: ['homeschool multiple children','family style homeschool','multi-age curriculum','homeschooling siblings']
  },
  'what-to-do-when-curriculum-isnt-working': {
    metaTitle: "When Your Homeschool Curriculum Isn't Working",
    metaDescription: 'How to tell if your curriculum is the real problem, when to push through, and when it is okay to switch — without wasting money.',
    keywords: ['curriculum not working','switching homeschool curriculum','homeschool curriculum change','hate our curriculum']
  },
  'how-to-homeschool-when-both-parents-work': {
    metaTitle: 'How to Homeschool When Both Parents Work',
    metaDescription: 'Real schedules and curriculum picks for working parents who homeschool — plus tips for independent learning, mornings, and evenings.',
    keywords: ['working parents homeschool','homeschool and work','working mom homeschool','homeschool schedule working']
  },
  'how-to-homeschool-on-a-tight-budget': {
    metaTitle: 'How to Homeschool on a Tight Budget (Under $100/yr)',
    metaDescription: 'Practical tips and free curriculum picks for homeschooling your whole family on a tight budget — without sacrificing quality.',
    keywords: ['cheap homeschool','homeschool on a budget','free homeschool','affordable homeschool curriculum']
  },
  'how-to-start-homeschooling-beginners-guide': {
    metaTitle: "How to Start Homeschooling: A Beginner's Guide",
    metaDescription: 'The complete step-by-step guide to starting homeschooling — from legal requirements to picking curriculum and creating your first schedule.',
    keywords: ['how to start homeschooling','homeschool beginners guide','new homeschool mom','start homeschooling']
  },
  'how-much-does-homeschooling-cost': {
    metaTitle: 'How Much Does Homeschooling Cost? Real Budget',
    metaDescription: 'A real budget breakdown of homeschool costs — curriculum, supplies, activities, and extras — plus how to homeschool for under $200/year.',
    keywords: ['homeschool cost','how much does homeschooling cost','homeschool budget','homeschool price']
  },
  'what-does-a-homeschool-day-look-like': {
    metaTitle: 'What Does a Homeschool Day Actually Look Like?',
    metaDescription: 'Real homeschool schedules and daily routines from real families — plus how to build a rhythm that fits your life, not Instagram.',
    keywords: ['homeschool schedule','homeschool day','homeschool routine','typical homeschool day']
  },
  'what-is-unschooling': {
    metaTitle: 'What Is Unschooling? Is It Right for Your Family?',
    metaDescription: 'Unschooling explained plainly — what it is, how it works, the research behind it, and who it is (and is not) a good fit for.',
    keywords: ['unschooling','what is unschooling','child-led learning','interest-led homeschool']
  },
  'what-is-charlotte-mason-method': {
    metaTitle: 'What Is the Charlotte Mason Method? A Full Guide',
    metaDescription: 'The Charlotte Mason homeschool method explained — living books, nature study, short lessons, narration, and how to start using it today.',
    keywords: ['charlotte mason method','charlotte mason homeschool','living books','nature study']
  },
  'what-is-a-unit-study': {
    metaTitle: 'What Is a Unit Study? How to Use One in Homeschool',
    metaDescription: 'Unit studies explained — how they work, why families love them, and how to design your own around any topic your kids are into.',
    keywords: ['unit study','homeschool unit study','thematic learning','unit studies homeschool']
  },
  'homeschool-curriculum-sales-when-to-buy': {
    metaTitle: 'Homeschool Curriculum Sales: When to Buy & Save',
    metaDescription: 'The best times of year to buy homeschool curriculum on sale — plus where to find discount codes, used books, and bundle deals.',
    keywords: ['homeschool curriculum sales','curriculum discount','homeschool deals','cheap curriculum']
  },
  'homeschool-curriculum-fair-guide': {
    metaTitle: 'Homeschool Curriculum Fair Guide: What to Buy & Skip',
    metaDescription: 'Your survival guide to curriculum fairs — what to bring, questions to ask vendors, what is worth buying, and what to walk past.',
    keywords: ['homeschool curriculum fair','homeschool convention','curriculum convention','homeschool vendors']
  }
};

const DEFAULT_OG_IMAGE = 'https://myhomeschoolcurriculum.com/og-default.png';

let updated = 0;
for (const post of db.blogPosts || []) {
  const seo = SEO_OVERRIDES[post.slug] || {};

  // Tighten excerpt if over 165 chars (meta description limit)
  if (post.excerpt && post.excerpt.length > 160) {
    const trimmed = post.excerpt.substring(0, 157);
    const lastSpace = trimmed.lastIndexOf(' ');
    post.excerpt = (lastSpace > 100 ? trimmed.substring(0, lastSpace) : trimmed).replace(/[.,;:\s]+$/, '') + '…';
  }

  // SEO fields
  post.metaTitle = seo.metaTitle || (post.title.length <= 60 ? post.title : post.title.substring(0, 57) + '…');
  post.metaDescription = seo.metaDescription || post.excerpt || '';
  post.keywords = seo.keywords || post.tags || [];
  post.author = post.author || DEFAULT_AUTHOR;
  post.canonicalUrl = `https://myhomeschoolcurriculum.com/blog.html?post=${post.slug}`;
  post.ogImage = post.featuredImage || DEFAULT_OG_IMAGE;

  // Word count + reading time for schema
  const words = (post.content || '').split(/\s+/).filter(Boolean).length;
  post.wordCount = words;
  post.readingMinutes = Math.max(1, Math.round(words / 200));

  post.updatedAt = new Date().toISOString();
  updated++;
}

fs.writeFileSync(dbPath, JSON.stringify(db, null, 2));
console.log(`✅ Optimized SEO for ${updated} blog posts`);
console.log('Fields added: metaTitle, metaDescription, keywords, author, canonicalUrl, ogImage, wordCount, readingMinutes');
