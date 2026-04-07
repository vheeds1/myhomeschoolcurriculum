/**
 * One-time script: Reset all curriculum ratings/reviewCounts to zero
 * and clear all demo reviews. Run with: node reset-reviews.js
 *
 * This preserves all curriculum descriptions, pros/cons, and other listing data.
 * Only removes: rating, reviewCount, and all entries in the reviews array.
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'db/database.json');

async function reset() {
  let db;

  // Try PostgreSQL first
  if (process.env.DATABASE_URL) {
    const pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false }
    });
    try {
      const result = await pool.query('SELECT data FROM app_data WHERE id = 1');
      if (result.rows.length > 0) {
        db = result.rows[0].data;
        console.log('[DB] Loaded from PostgreSQL');
      }
    } catch(e) {
      console.error('PostgreSQL error:', e.message);
    }

    if (db) {
      // Reset
      let count = 0;
      (db.curricula || []).forEach(c => {
        c.rating = 0;
        c.reviewCount = 0;
        count++;
      });
      const reviewCount = (db.reviews || []).length;
      db.reviews = [];

      // Save back to PostgreSQL
      await pool.query(
        'UPDATE app_data SET data = $1, updated_at = NOW() WHERE id = 1',
        [JSON.stringify(db)]
      );
      console.log(`[Done] Reset ${count} curricula ratings to 0, removed ${reviewCount} demo reviews`);
      await pool.end();
      return;
    }
    await pool.end();
  }

  // Fallback to JSON file
  try {
    db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
    console.log('[DB] Loaded from database.json');
  } catch(e) {
    console.error('Could not read database:', e.message);
    return;
  }

  let count = 0;
  (db.curricula || []).forEach(c => {
    c.rating = 0;
    c.reviewCount = 0;
    count++;
  });
  const reviewCount = (db.reviews || []).length;
  db.reviews = [];

  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
  console.log(`[Done] Reset ${count} curricula ratings to 0, removed ${reviewCount} demo reviews`);
}

reset().catch(e => console.error('Error:', e));
