require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3011;

// Middleware
app.use(cors());
app.use(helmet());
app.use(compression());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Products routes
app.get('/api/products', (req, res) => {
  try {
    let query = 'SELECT * FROM products';
    const params = [];
    const conditions = [];

    if (req.query.country) {
      conditions.push(`countries LIKE ?`);
      params.push(`%"${req.query.country}"%`);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY rating DESC';

    const products = db.prepare(query).all(...params);
    const parsed = products.map(p => ({
      ...p,
      features: JSON.parse(p.features || '[]'),
      countries: JSON.parse(p.countries || '[]')
    }));
    res.json({ products: parsed, total: parsed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/products/:slug', (req, res) => {
  try {
    const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(req.params.slug);
    if (!product) return res.status(404).json({ error: 'Product not found' });
    product.features = JSON.parse(product.features || '[]');
    product.countries = JSON.parse(product.countries || '[]');
    const reviews = db.prepare('SELECT * FROM reviews WHERE product_id = ?').all(product.id);
    res.json({ product, reviews });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Blog routes
app.get('/api/blog', (req, res) => {
  try {
    const posts = db.prepare('SELECT id, slug, title, meta_desc, created_at FROM blog_posts WHERE published = 1 ORDER BY created_at DESC LIMIT 20').all();
    res.json({ posts, total: posts.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/blog/:slug', (req, res) => {
  try {
    const post = db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND published = 1').get(req.params.slug);
    if (!post) return res.status(404).json({ error: 'Post not found' });
    res.json({ post });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Leads
app.post('/api/leads', (req, res) => {
  try {
    const { email, country, doc_type, budget } = req.body;
    if (!email) return res.status(400).json({ error: 'Email required' });
    db.prepare('INSERT INTO leads (email, country, doc_type, budget, created_at) VALUES (?, ?, ?, ?, ?)').run(
      email, country || null, doc_type || null, budget || null, new Date().toISOString()
    );
    res.json({ success: true, message: 'Lead saved' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Track events
app.post('/api/track', (req, res) => {
  try {
    const { event, page, ref } = req.body;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip_hash = crypto.createHash('sha256').update(ip).digest('hex');
    db.prepare('INSERT INTO analytics (event, page, ref, ip_hash, created_at) VALUES (?, ?, ?, ?, ?)').run(
      event || 'pageview', page || null, ref || null, ip_hash, new Date().toISOString()
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Affiliate redirect (enhanced with tracking module)
app.get('/go/:slug/:source', (req, res) => {
  try {
    const { slug, source } = req.params;
    const product = db.prepare('SELECT * FROM products WHERE slug = ?').get(slug);
    if (!product) return res.status(404).json({ error: 'Product not found' });

    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '';
    const ip_hash = crypto.createHash('sha256').update(ip).digest('hex');
    db.prepare('INSERT INTO affiliate_clicks (product_slug, source, ip_hash, created_at) VALUES (?, ?, ?, ?)').run(
      slug, source, ip_hash, new Date().toISOString()
    );

    const utmUrl = `${product.affiliate_url}?utm_source=law-trust&utm_medium=comparison&utm_campaign=${encodeURIComponent(source)}`;
    res.redirect(302, utmUrl);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stats (admin)
app.get('/api/stats', (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    const products = db.prepare('SELECT COUNT(*) as count FROM products').get();
    const leads = db.prepare('SELECT COUNT(*) as count FROM leads').get();
    const posts = db.prepare('SELECT COUNT(*) as count FROM blog_posts').get();
    const clicks = db.prepare('SELECT COUNT(*) as count FROM affiliate_clicks').get();
    const analytics = db.prepare('SELECT COUNT(*) as count FROM analytics').get();
    res.json({
      products: products.count,
      leads: leads.count,
      blog_posts: posts.count,
      affiliate_clicks: clicks.count,
      analytics_events: analytics.count
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Load chat routes (legacy — replaced by bots.js)
// try {
//   const chatRoutes = require('./routes/chat');
//   app.use('/api/chat', chatRoutes);
//   console.log('✅ Chat routes loaded');
// } catch (e) {
//   console.log('⚠️ Chat routes not yet available');
// }

// Load bot routes (Alex, Qualifier, Decider)
try {
  const botRoutes = require('./routes/bots');
  app.use('/api/chat', botRoutes);
  console.log('✅ Bot routes loaded (/api/chat/alex, /api/chat/qualify, /api/chat/decide)');
} catch (e) {
  console.log('⚠️ Bot routes error:', e.message);
}

// Load content routes
try {
  const contentRoutes = require('./routes/content');
  app.use('/api/content', contentRoutes);
  console.log('✅ Content routes loaded');
} catch (e) {
  console.log('⚠️ Content routes not yet available');
}

// Load leads routes
try {
  const leadsRoutes = require('./routes/leads');
  app.use('/api/leads', leadsRoutes);
  console.log('✅ Leads routes loaded');
} catch (e) {
  console.log('⚠️ Leads routes error:', e.message);
}

// Load buyers routes
try {
  const buyersRoutes = require('./routes/buyers');
  app.use('/api/buyers', buyersRoutes);
  console.log('✅ Buyers routes loaded');
} catch (e) {
  console.log('⚠️ Buyers routes error:', e.message);
}

// Start scheduler
try {
  require('./crons/scheduler');
  console.log('✅ Cron scheduler started');
} catch (e) {
  console.log('⚠️ Scheduler not yet available:', e.message);
}

app.listen(PORT, () => {
  console.log(`🚀 Law-Trust backend running on port ${PORT}`);
});

module.exports = app;
