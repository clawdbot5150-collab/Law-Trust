const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'lawtrust.db'));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT UNIQUE NOT NULL,
    tagline TEXT,
    rating REAL,
    price_from TEXT,
    price_unit TEXT,
    affiliate_url TEXT,
    features TEXT,
    countries TEXT,
    last_updated TEXT
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER,
    author TEXT,
    location TEXT,
    stars INTEGER,
    quote TEXT,
    date TEXT
  );

  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT UNIQUE NOT NULL,
    title TEXT,
    content TEXT,
    meta_desc TEXT,
    published INTEGER DEFAULT 0,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT,
    country TEXT,
    doc_type TEXT,
    budget TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event TEXT,
    page TEXT,
    ref TEXT,
    ip_hash TEXT,
    created_at TEXT
  );

  CREATE TABLE IF NOT EXISTS affiliate_clicks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_slug TEXT,
    source TEXT,
    ip_hash TEXT,
    created_at TEXT
  );
`);

// Seed products
const existingProducts = db.prepare('SELECT COUNT(*) as count FROM products').get();
if (existingProducts.count === 0) {
  const insert = db.prepare(`
    INSERT INTO products (name, slug, tagline, rating, price_from, affiliate_url, features, countries, last_updated)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const products = [
    {
      name: 'Trust & Will',
      slug: 'trust-and-will',
      tagline: 'The easiest way to create a will or living trust online',
      rating: 9.7,
      price_from: '$69',
      affiliate_url: 'https://trustandwill.com',
      features: JSON.stringify(['Attorney-reviewed', 'All US states', 'Healthcare directive', 'Unlimited updates']),
      countries: JSON.stringify(['US'])
    },
    {
      name: 'LegalZoom',
      slug: 'legalzoom',
      tagline: 'The most trusted name in online legal services',
      rating: 9.2,
      price_from: '$99',
      affiliate_url: 'https://legalzoom.com',
      features: JSON.stringify(['1M+ documents', 'Attorney consultation', 'Business formation', 'Money-back guarantee']),
      countries: JSON.stringify(['US', 'UK'])
    },
    {
      name: 'Rocket Lawyer',
      slug: 'rocket-lawyer',
      tagline: 'Legal made simple — documents, advice, and more',
      rating: 8.9,
      price_from: '$39.99/mo',
      affiliate_url: 'https://rocketlawyer.com',
      features: JSON.stringify(['Unlimited documents', 'Attorney Q&A', 'US & UK', '7-day trial']),
      countries: JSON.stringify(['US', 'UK'])
    },
    {
      name: 'Fabric by Gerber',
      slug: 'fabric',
      tagline: 'Free will creation — protect your family in 10 minutes',
      rating: 8.6,
      price_from: 'Free',
      affiliate_url: 'https://meetfabric.com',
      features: JSON.stringify(['100% free will', 'Guardianship', '10 minutes', 'Life insurance']),
      countries: JSON.stringify(['US'])
    },
    {
      name: 'Nolo/Quicken WillMaker',
      slug: 'nolo',
      tagline: 'Professional will software — one-time purchase, no subscription',
      rating: 8.4,
      price_from: '$59.99',
      affiliate_url: 'https://nolo.com',
      features: JSON.stringify(['35+ documents', 'Local storage', 'No subscription', 'One-time']),
      countries: JSON.stringify(['US'])
    },
    {
      name: 'Willful',
      slug: 'willful',
      tagline: "Canada's most trusted online will platform",
      rating: 9.0,
      price_from: 'CAD $99',
      affiliate_url: 'https://willful.co',
      features: JSON.stringify(['All provinces', 'English & French', 'Lawyer-reviewed', 'PIPEDA compliant']),
      countries: JSON.stringify(['CA'])
    }
  ];

  const now = new Date().toISOString();
  for (const p of products) {
    insert.run(p.name, p.slug, p.tagline, p.rating, p.price_from, p.affiliate_url, p.features, p.countries, now);
  }
  console.log('✅ Database seeded with 6 products');
}

module.exports = db;
