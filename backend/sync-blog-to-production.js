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

  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await res.text();
    console.error(`❌ Server returned HTTP ${res.status} with non-JSON response.`);
    if (res.status === 404) console.error('   The endpoint does not exist yet. Railway may still be deploying — wait 1-2 minutes and retry.');
    else console.error('   Response body (first 300 chars):', text.slice(0, 300));
    process.exit(1);
  }

  const data = await res.json();
  if (!res.ok || !data.success) {
    console.error(`❌ HTTP ${res.status}:`, data);
    if (res.status === 401) console.error('   Check your ADMIN_TOKEN — it should match the token set in Railway env vars.');
    process.exit(1);
  }

  console.log(`✅ Added ${data.added} new post(s), updated ${data.updated || 0} existing post(s), skipped ${data.skipped}.`);
  console.log(`   Total blog posts in production: ${data.total}`);
}

main().catch(console.error);
