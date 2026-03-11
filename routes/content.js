require('dotenv').config();
const express = require('express');
const router = express.Router();
const { generateBlogPost, generateComparisonPage, generateFAQ } = require('../content/generator');

// Auth middleware
function adminAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// POST /api/content/generate
router.post('/generate', adminAuth, async (req, res) => {
  try {
    const { type, topic, country = 'US', product1, product2 } = req.body;

    let result;
    switch (type) {
      case 'blog':
        if (!topic) return res.status(400).json({ error: 'topic required' });
        result = await generateBlogPost(topic, country);
        break;
      case 'comparison':
        if (!product1 || !product2) return res.status(400).json({ error: 'product1 and product2 required' });
        result = await generateComparisonPage(product1, product2, country);
        break;
      case 'faq':
        if (!topic) return res.status(400).json({ error: 'topic required' });
        result = await generateFAQ(topic, country);
        break;
      default:
        return res.status(400).json({ error: 'type must be blog|comparison|faq' });
    }

    res.json({ success: true, result });
  } catch (err) {
    console.error('Content gen error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
