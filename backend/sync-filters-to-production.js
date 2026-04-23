#!/usr/bin/env node
/**
 * Sync curriculum filter data from local database.json to production
 * Usage: ADMIN_TOKEN=your_token SITE_URL=https://myhomeschoolcurriculum.com node sync-filters-to-production.js
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

  const updates = db.curricula.map(c => ({
    id: c.id,
    style: c.style,
    worldview: c.worldview,
    format: c.format,
    subject: c.subject,
    special: c.special,
    price: c.price,
    priceMin: c.priceMin,
    priceMax: c.priceMax,
    pricingNote: c.pricingNote || '',
    pricingModel: c.pricingModel || '',
    grades: c.grades,
    clearExternalRatings: true
  }));

  console.log(`Pushing filter updates for ${updates.length} curricula to ${SITE_URL}...`);

  const res = await fetch(`${SITE_URL}/api/admin/curricula/bulk-update`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ADMIN_TOKEN}`
    },
    body: JSON.stringify({ updates })
  });

  const data = await res.json();
  if (data.success) {
    console.log(`✅ Updated ${data.updated} curricula in production!`);
  } else {
    console.error('❌ Error:', data);
  }
}

main().catch(console.error);
