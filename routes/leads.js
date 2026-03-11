'use strict';
const express = require('express');
const router = express.Router();
const db = require('../database');
const { scoreAndSaveLead } = require('../leads/scorer');
const { deliverLead } = require('../leads/delivery');

// POST /api/leads/capture
router.post('/capture', async (req, res) => {
  try {
    const { name, email, phone, docType, country, state, timeline, budget, source, whyNow } = req.body;

    // Validation
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name is required' });
    if (!email || !email.trim()) return res.status(400).json({ error: 'Email is required' });
    if (!docType || !docType.trim()) return res.status(400).json({ error: 'Document type is required' });
    if (!country || !country.trim()) return res.status(400).json({ error: 'Country is required' });

    // Save lead
    const stmt = db.prepare(`
      INSERT INTO leads (email, country, doc_type, budget, created_at, name, phone, state, timeline, budget_detail, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'new')
    `);
    const result = stmt.run(
      email.trim(), country.trim(), docType.trim(),
      budget || null, new Date().toISOString(),
      name.trim(), phone || null, state || null,
      timeline || null, budget || null
    );
    const leadId = result.lastInsertRowid;

    // Score the lead
    const scoreResult = scoreAndSaveLead(leadId, { docType, timeline, budget, phone, state, whyNow, country });
    console.log(`✅ Lead #${leadId} scored: ${scoreResult.score} (${scoreResult.classification})`);

    // Deliver the lead (async, don't await)
    deliverLead(leadId).catch(e => console.error('Deliver error:', e.message));

    res.json({
      success: true,
      leadId,
      score: scoreResult.score,
      classification: scoreResult.classification,
      message: "We'll match you with the best service shortly!"
    });
  } catch (err) {
    console.error('Capture error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads/form-config/:docType
router.get('/form-config/:docType', (req, res) => {
  const { docType } = req.params;
  const dt = docType.toLowerCase();

  const base = [
    { field: 'name', label: 'Full Name', type: 'text', required: true },
    { field: 'email', label: 'Email Address', type: 'email', required: true },
    { field: 'phone', label: 'Phone Number', type: 'tel', required: false },
    { field: 'country', label: 'Country', type: 'select', required: true,
      options: ['US', 'UK', 'Canada', 'Australia', 'Ireland', 'India'] },
    { field: 'state', label: 'State/Province', type: 'text', required: false, conditional: 'country' },
    { field: 'timeline', label: 'When do you need this?', type: 'radio', required: true,
      options: ['This week', 'This month', 'No rush'] },
    { field: 'budget', label: 'Your budget', type: 'radio', required: false,
      options: ['Free if possible', 'Under $100', '$100-$300', '$300+', 'No limit'] }
  ];

  let extraFields = [];

  if (dt.includes('trust') || dt.includes('estate')) {
    extraFields = [
      { field: 'married', label: 'Are you married?', type: 'radio', options: ['Yes', 'No'] },
      { field: 'children', label: 'Do you have children?', type: 'radio', options: ['Yes', 'No'] },
      { field: 'assets', label: 'Estimated asset value', type: 'select',
        options: ['Under $100k', '$100k-$500k', '$500k-$1M', 'Over $1M'] }
    ];
  } else if (dt.includes('will')) {
    extraFields = [
      { field: 'dependents', label: 'Number of dependents', type: 'number' },
      { field: 'executor', label: 'Do you have an executor in mind?', type: 'radio', options: ['Yes', 'No'] }
    ];
  } else if (dt.includes('poa') || dt.includes('power')) {
    extraFields = [
      { field: 'poaType', label: 'Type of POA needed', type: 'select',
        options: ['Financial', 'Healthcare', 'Both', 'Not sure'] }
    ];
  } else if (dt.includes('llc') || dt.includes('business')) {
    extraFields = [
      { field: 'businessType', label: 'Type of business', type: 'text' },
      { field: 'members', label: 'Number of members/owners', type: 'number' }
    ];
  }

  res.json({ docType, fields: [...base, ...extraFields] });
});

// GET /api/leads/score/:id (admin)
router.get('/score/:id', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const lead = db.prepare('SELECT id, email, doc_type, score, score_breakdown, status, created_at FROM leads WHERE id = ?').get(req.params.id);
    if (!lead) return res.status(404).json({ error: 'Lead not found' });
    lead.score_breakdown = lead.score_breakdown ? JSON.parse(lead.score_breakdown) : null;
    res.json({ lead });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/leads (admin)
router.get('/', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.ADMIN_TOKEN}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  try {
    const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC LIMIT 100').all();
    res.json({ leads, total: leads.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
