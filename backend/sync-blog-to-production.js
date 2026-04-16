#!/usr/bin/env node
/**
 * Sync blog posts from local database.json to production.
 * Usage: ADMIN_TOKEN=your_token node sync-blog-to-production.js
 */

const fs = require('fs');

const SITE_URL = process.env.SITE_URL || 'https://myhomeschoolcurriculum.com';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;

if (!ADMIN_TOKEN) {
  console.error('❌ Set ADMIN_TOKEN env var first');
  process.exit(1);
}

async function main() {
  const db = JSON.parse(fs.readFileSync(__dirname + '/db/database.json', 'utf8'));
  const posts = db.blogPosts || [];
  console.log(`Pushing ${posts.length} blog posts to ${SITE_URL}...`);

  const res = await fetch(`${SITE_URL}/api/admin/blog/bulk-import`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`
    },
    body: JSON.stringify({ posts })
  });

  const data = await res.json();
  if (data.success) {
    console.log(`✅ Added ${data.added} new post(s), skipped ${data.skipped} duplicate(s).`);
    console.log(`   Total blog posts in production: ${data.total}`);
  } else {
    console.error('❌ Error:', data);
  }
}

main().catch(console.error);
