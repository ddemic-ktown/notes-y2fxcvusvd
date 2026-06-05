// iif.js — Parse work notes and generate QuickBooks IIF files

const MONTH_NAMES = ['january','february','march','april','may','june',
  'july','august','september','october','november','december'];

// ---------- Fuzzy matching ----------
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

function normalize(s) {
  return s.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function wordOverlapScore(a, b) {
  const wa = normalize(a).split(' ').filter(w => w.length > 1);
  const wb = normalize(b).split(' ').filter(w => w.length > 1);
  if (!wa.length || !wb.length) return 0;
  const setB = new Set(wb);
  let overlap = 0;
  for (const w of wa) {
    if (setB.has(w)) { overlap++; continue; }
    for (const w2 of wb) {
      const dist = levenshtein(w, w2);
      if (dist <= Math.max(1, Math.floor(Math.max(w.length, w2.length) * 0.3))) {
        overlap += 0.7; break;
      }
    }
  }
  return overlap / Math.max(wa.length, wb.length);
}

export function fuzzyMatchCustomer(query, customerNames) {
  if (!customerNames.length) return { name: query, score: 0 };
  let best = { name: customerNames[0], score: 0 };
  for (const name of customerNames) {
    const score = wordOverlapScore(query, name);
    if (score > best.score) best = { name, score };
  }
  return best;
}

// ---------- Time parsing ----------
function parseTimeValue(s) {
  s = s.trim().toLowerCase();
  const ampm = s.endsWith('am') ? 'am' : s.endsWith('pm') ? 'pm' : null;
  const t = s.replace(/[amp]/g, '').trim();
  let hours = 0, minutes = 0;
  if (t.includes(':')) {
    [hours, minutes] = t.split(':').map(Number);
  } else if (t.includes('.')) {
    [hours, minutes] = t.split('.').map(Number);
  } else {
    hours = parseFloat(t) || 0;
  }
  if (ampm === 'pm' && hours < 12) hours += 12;
  if (ampm === 'am' && hours === 12) hours = 0;
  return hours + (minutes || 0) / 60;
}

function parseTimeRange(s) {
  const m = s.match(/^([\d.:]+(?:am|pm)?)\s*[-–]\s*([\d.:]+(?:am|pm)?)$/i);
  if (!m) return null;
  const start = parseTimeValue(m[1]);
  const end = parseTimeValue(m[2]);
  let diff = end - start;
  if (diff <= 0) diff += 12;
  return Math.round(diff * 100) / 100;
}

function parseHoursDuration(s) {
  const m = s.match(/^([\d.]+)\s*hrs?$/i);
  if (!m) return null;
  return parseFloat(m[1]);
}

// ---------- Date parsing ----------
function parseDate(line) {
  const clean = line.trim().replace(/,/g, '');
  const re = new RegExp(
    `^(${MONTH_NAMES.join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:[,\\s]+(\\d{4}))?$`, 'i'
  );
  const m = clean.match(re);
  if (!m) return null;
  const month = MONTH_NAMES.indexOf(m[1].toLowerCase());
  const day = parseInt(m[2], 10);
  const year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
  return new Date(year, month, day);
}

export function formatDate(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

export function formatDuration(hours) {
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return `${h}:${String(m).padStart(2, '0')}`;
}

// ---------- Main parser ----------
export function parseHoursNote(text, customerNames) {
  const lines = text.split('\n');
  const entries = [];
  let currentDate = null;
  let activeEmployees = [];

  for (const rawLine of lines) {
    // Strip inline comments (// and everything after)
    const uncommented = rawLine.replace(/\/\/.*$/, '');
    const line = uncommented.trim();
    if (!line) continue;

    const stripped = line.replace(/^[-•*]\s*/, '').trim();
    if (!stripped) continue;

    // Try date line
    const parsedDate = parseDate(stripped);
    if (parsedDate) {
      currentDate = parsedDate;
      activeEmployees = [];
      continue;
    }
    if (!currentDate) continue;

    // Detect employees
    let working = stripped;
    const hasDavor = /\bdavor\b/i.test(working);
    const hasJanet = /\bjanet\b/i.test(working);
    let employeesFound = [];
    let employeeConfidence = 1.0;

    if (hasDavor && hasJanet) {
      employeesFound = ['Davor', 'Janet'];
      activeEmployees = ['Davor', 'Janet'];
    } else if (hasDavor) {
      employeesFound = ['Davor'];
      activeEmployees = ['Davor'];
    } else if (hasJanet) {
      employeesFound = ['Janet'];
      activeEmployees = ['Janet'];
    } else {
      employeesFound = activeEmployees.slice();
      employeeConfidence = activeEmployees.length > 0 ? 0.85 : 0;
    }

    // Remove employee names
    let cleaned = working
      .replace(/\bdavor\b/gi, '')
      .replace(/\bjanet\b/gi, '')
      .replace(/\band\b/gi, '')
      .trim();

    // Extract time range
    let hours = null;
    let hoursConfidence = 1.0;
    const trMatch = cleaned.match(/([\d.:]+(?:am|pm)?)\s*[-–]\s*([\d.:]+(?:am|pm)?)/i);
    if (trMatch) {
      hours = parseTimeRange(trMatch[0]);
      cleaned = cleaned.replace(trMatch[0], '').trim();
    }

    // Extract duration
    if (hours === null) {
      const durMatch = cleaned.match(/([\d.]+\s*hrs?)/i);
      if (durMatch) {
        hours = parseHoursDuration(durMatch[1]);
        cleaned = cleaned.replace(durMatch[0], '').trim();
      }
    }

    if (!hours || hours <= 0) hoursConfidence = 0;

    // Clean up customer text
    const customerText = cleaned
      .replace(/^[-–,.\s]+/, '')
      .replace(/[-–,.\s]+$/, '')
      .replace(/\s+/g, ' ')
      .trim();

    // Fuzzy match
    const match = customerText ? fuzzyMatchCustomer(customerText, customerNames) : { name: '', score: 0 };

    const confidence = Math.round(
      (employeeConfidence * 0.3 + (match.score || 0) * 0.5 + hoursConfidence * 0.2) * 100
    );
    const needsReview = confidence < 80 || !hours || !customerText || employeesFound.length === 0;

    let issue = '';
    if (!employeesFound.length) issue = 'No employees detected';
    else if (!hours || hours <= 0) issue = 'Hours unclear';
    else if (!customerText) issue = 'No customer found';
    else if (match.score < 0.5) issue = 'Customer uncertain';

    entries.push({
      date: currentDate,
      dateFormatted: formatDate(currentDate),
      employees: employeesFound,
      customer: customerText,
      customerMatched: match.score >= 0.4 ? match.name : customerText,
      customerScore: match.score,
      hours: hours || 0,
      hoursFormatted: hours ? formatDuration(hours) : '',
      confidence,
      raw: rawLine.trim(),
      needsReview,
      issue,
    });
  }

  return entries;
}

// ---------- IIF generation ----------
export function generateIIF(entries, companyName = 'Company Organizer Ninja') {
  const lines = [
    `!TIMERHDR\tVER\tREV\tCOMPANYNAME`,
    `TIMERHDR\t8\t0\t${companyName}`,
    `!TIMEACT\tDATE\tJOB\tEMP\tITEM\tDURATION\tNOTE`,
  ];
  for (const e of entries) {
    if (!e.employees.length || !e.hours || !e.customerMatched) continue;
    for (const emp of e.employees) {
      lines.push(`TIMEACT\t${e.dateFormatted}\t${e.customerMatched}\t${emp}\tHourly\t${e.hoursFormatted}\t`);
    }
  }
  return lines.join('\n');
}
