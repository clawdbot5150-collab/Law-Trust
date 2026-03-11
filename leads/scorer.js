'use strict';
const db = require('../database');

function scoreLead(leadData) {
  const { docType, timeline, budget, phone, state, whyNow, country } = leadData;
  let breakdown = { docType: 0, timeline: 0, budget: 0, completeness: 0, market: 0 };

  // --- DOCUMENT TYPE (0-20pts) ---
  const docTypeLower = (docType || '').toLowerCase();
  if (docTypeLower.includes('living trust') || docTypeLower.includes('estate plan bundle')) {
    breakdown.docType = 20;
  } else if (docTypeLower.includes('will + trust') || docTypeLower.includes('will and trust') || docTypeLower.includes('llc')) {
    breakdown.docType = 18;
  } else if (docTypeLower.includes('last will') || docTypeLower.includes('will')) {
    breakdown.docType = 15;
  } else if (docTypeLower.includes('power of attorney') || docTypeLower.includes('poa')) {
    breakdown.docType = 12;
  } else if (docTypeLower.includes('healthcare') || docTypeLower.includes('directive')) {
    breakdown.docType = 10;
  } else {
    breakdown.docType = 5; // "Not Sure" or unknown
  }

  // --- TIMELINE (0-25pts) ---
  const tl = (timeline || '').toLowerCase();
  if (tl.includes('this week') || tl.includes('week')) {
    breakdown.timeline = 25;
  } else if (tl.includes('this month') || tl.includes('month')) {
    breakdown.timeline = 15;
  } else {
    breakdown.timeline = 5; // "No rush" or unknown
  }

  // --- BUDGET (0-25pts) ---
  const bud = (budget || '').toLowerCase();
  if (bud.includes('no limit')) {
    breakdown.budget = 25;
  } else if (bud.includes('300+') || bud.includes('300 +')) {
    breakdown.budget = 20;
  } else if (bud.includes('100') && bud.includes('300')) {
    breakdown.budget = 15;
  } else if (bud.includes('under') && bud.includes('100')) {
    breakdown.budget = 8;
  } else if (bud.includes('free')) {
    breakdown.budget = 2;
  } else {
    breakdown.budget = 5;
  }

  // --- COMPLETENESS (0-15pts) ---
  if (phone && phone.trim().length > 4) breakdown.completeness += 5;
  if (state && state.trim().length > 1) breakdown.completeness += 5;
  if (whyNow && whyNow.trim().length > 10) breakdown.completeness += 5;

  // --- COUNTRY/MARKET (0-15pts) ---
  const ct = (country || '').toUpperCase();
  const stUpper = (state || '').toUpperCase();
  const premiumStates = ['CALIFORNIA', 'NEW YORK', 'TEXAS', 'FLORIDA', 'CA', 'NY', 'TX', 'FL'];
  if (ct === 'US' || ct === 'USA' || ct === 'UNITED STATES') {
    if (premiumStates.some(s => stUpper.includes(s))) {
      breakdown.market = 15;
    } else {
      breakdown.market = 12;
    }
  } else if (ct === 'CA' || ct === 'CANADA') {
    breakdown.market = 10;
  } else if (ct === 'UK' || ct === 'UNITED KINGDOM' || ct === 'GB') {
    breakdown.market = 10;
  } else if (ct === 'AU' || ct === 'AUSTRALIA') {
    breakdown.market = 8;
  } else {
    breakdown.market = 5;
  }

  const score = breakdown.docType + breakdown.timeline + breakdown.budget + breakdown.completeness + breakdown.market;

  let classification, estimatedValue;
  if (score >= 80) {
    classification = 'hot';
    estimatedValue = 120;
  } else if (score >= 60) {
    classification = 'warm';
    estimatedValue = 80;
  } else if (score >= 40) {
    classification = 'cool';
    estimatedValue = 50;
  } else {
    classification = 'cold';
    estimatedValue = 30;
  }

  return { score, classification, estimatedValue, breakdown };
}

function scoreAndSaveLead(leadId, leadData) {
  const result = scoreLead(leadData);
  try {
    db.prepare(`UPDATE leads SET score = ?, score_breakdown = ? WHERE id = ?`)
      .run(result.score, JSON.stringify(result.breakdown), leadId);
  } catch (e) {
    console.error('Error saving score:', e.message);
  }
  return result;
}

module.exports = { scoreLead, scoreAndSaveLead };
