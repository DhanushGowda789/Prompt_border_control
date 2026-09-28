/**
 * Sovereign Shield — Sensitivity Classifier
 * Fast pattern + keyword scoring. Runs in < 1ms.
 */

const CATEGORIES = {
  PII: {
    label: 'Personal Identifiable Information',
    icon: '🪪',
    color: '#ff9944',
    patterns: [
      /\b\d{3}-\d{2}-\d{4}\b/,
      /\b\d{16}\b|\b\d{4}[- ]\d{4}[- ]\d{4}[- ]\d{4}\b/,
      /\bpassport\s*(no|number|#)?\s*[:\-]?\s*[A-Z0-9]{6,9}\b/i,
      /\bdriver['\s]*s?\s*licen[sc]e\b/i,
      /\bdate\s+of\s+birth\b|\bdob\b/i,
      /\b(aadhaar|pan\s+card|voter\s+id)\b/i,
    ],
    keywords: [
      'social security', 'ssn', 'passport number', 'national id',
      'aadhaar', 'pan number', 'identity card', 'birth certificate',
      'date of birth', 'my address is', 'home address',
    ],
    weight: 10,
  },
  HEALTH: {
    label: 'Health & Medical Data',
    icon: '🏥',
    color: '#ff6677',
    patterns: [
      /\b(diagnosed\s+with|diagnosis\s+of)\b/i,
      /\b(HIV|AIDS|cancer|diabetes|hypertension|depression|bipolar|schizophrenia)\b/i,
      /\bmedical\s+record(s)?\b|\bpatient\s+(id|record|data)\b/i,
      /\bprescription\s+for\b/i,
    ],
    keywords: [
      'medical history', 'health record', 'patient data', 'diagnosis',
      'prescription', 'medication', 'therapy session', 'mental health',
      'lab results', 'hospital record', 'ehr', 'hipaa', 'insurance claim',
    ],
    weight: 9,
  },
  GOV_CONTRACT: {
    label: 'Government / Contract Data',
    icon: '🏛️',
    color: '#a855f7',
    patterns: [
      /\b(classified|top\s+secret|confidential)\b/i,
      /\bcontract\s+number\s*[:\-]?\s*[A-Z0-9\-]{5,}/i,
      /\b(RFP|RFQ|SOW|MOA|MOU)\s*#?\s*\d+/i,
      /\bFAR\s+\d+\.\d+\b/i,
    ],
    keywords: [
      'government contract', 'defense contract', 'classified',
      'statement of work', 'sow', 'rfp', 'request for proposal',
      'national security', 'procurement', 'federal acquisition',
      'contract terms', 'nda', 'non-disclosure', 'proprietary',
    ],
    weight: 10,
  },
  FINANCIAL: {
    label: 'Financial / Banking Data',
    icon: '💰',
    color: '#ffcc00',
    patterns: [
      /\baccount\s*(number|no\.?|#)\s*[:\-]?\s*\d{6,}/i,
      /\b(routing|aba)\s*(number|no\.?)?\s*[:\-]?\s*\d{9}\b/i,
      /\bIBAN\s*[:\-]?\s*[A-Z]{2}\d{2}[A-Z0-9]{11,}/i,
      /\bswift\s*(code)?\s*[:\-]?\s*[A-Z]{6,11}\b/i,
    ],
    keywords: [
      'bank account', 'account number', 'routing number', 'wire transfer',
      'swift code', 'iban', 'tax return', 'salary details', 'payroll',
    ],
    weight: 8,
  },
  LEGAL: {
    label: 'Legal / Privileged',
    icon: '⚖️',
    color: '#38bdf8',
    patterns: [
      /\battorney.client\s*privilege\b/i,
      /\bwork\s*product\s*doctrine\b/i,
      /\blitigation\s*(hold|strategy)\b/i,
    ],
    keywords: [
      'attorney-client', 'privileged communication', 'legal strategy',
      'lawsuit', 'under seal', 'deposition', 'settlement terms',
      'without prejudice', 'legal advice',
    ],
    weight: 7,
  },
};

const THRESHOLD = 6;

export function classifyText(text) {
  if (!text || typeof text !== 'string') return { sensitive: false, score: 0, triggers: [] };
  const lower = text.toLowerCase();
  const triggers = [];
  let total = 0;

  for (const [key, cat] of Object.entries(CATEGORIES)) {
    let catScore = 0;
    const matched = [];
    for (const p of cat.patterns) {
      if (p.test(text)) { catScore += cat.weight; matched.push('pattern match'); }
    }
    for (const kw of cat.keywords) {
      if (lower.includes(kw)) { catScore += 3; matched.push(kw); }
    }
    if (catScore > 0) {
      triggers.push({ category: key, label: cat.label, icon: cat.icon, color: cat.color, score: catScore, matched: [...new Set(matched)].slice(0, 3) });
      total += catScore;
    }
  }

  triggers.sort((a, b) => b.score - a.score);
  return { sensitive: total >= THRESHOLD, score: total, triggers, threshold: THRESHOLD };
}

export function extractText(body) {
  if (!body) return '';
  const parts = [];
  if (Array.isArray(body.messages)) {
    for (const m of body.messages) {
      if (typeof m.content === 'string') parts.push(m.content);
      else if (Array.isArray(m.content)) m.content.forEach(b => b.type === 'text' && parts.push(b.text));
    }
  }
  if (typeof body.system === 'string') parts.push(body.system);
  if (typeof body.prompt === 'string') parts.push(body.prompt);
  return parts.join('\n');
}
