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

const NOISE_WORDS = new Set(['and', 'the', 'at', 'in', 'of', 'a', 'an', 'for', 'on', 'to', 'by', 'or']);

function queryWords(s) {
  return normalize(s).split(' ').filter(w => w.length > 1 && !NOISE_WORDS.has(w));
}

// Recall-oriented: fraction of query words found in haystack
function recallScore(qWords, haystackText) {
  if (!qWords.length) return 0;
  const hWords = new Set(normalize(haystackText).split(' ').filter(w => w.length > 1));
  let matched = 0;
  for (const w of qWords) {
    if (hWords.has(w)) { matched++; continue; }
    for (const hw of hWords) {
      const dist = levenshtein(w, hw);
      if (dist <= Math.max(1, Math.floor(Math.max(w.length, hw.length) * 0.3))) {
        matched += 0.7; break;
      }
    }
  }
  return matched / qWords.length;
}

// Length-weighted recall: longer/more-distinctive words count more than short ones.
// e.g. "tamarack" (weight 6) vs "rob" (weight 1) — avoids short first-name false matches.
function weightedRecallScore(qWords, haystackText) {
  if (!qWords.length) return 0;
  const hWords = new Set(normalize(haystackText).split(' ').filter(w => w.length > 1));
  let matched = 0;
  let total = 0;
  for (const w of qWords) {
    const weight = Math.max(1, w.length - 2);
    total += weight;
    if (hWords.has(w)) { matched += weight; continue; }
    for (const hw of hWords) {
      const dist = levenshtein(w, hw);
      if (dist <= Math.max(1, Math.floor(Math.max(w.length, hw.length) * 0.3))) {
        matched += weight * 0.7; break;
      }
    }
  }
  return total > 0 ? matched / total : 0;
}

// Reverse-direction match: scans a chunk of free-form text (e.g. one line of
// a work note) for mentions of a *known* customer — checking both their name
// and any other recorded info (address, notes, etc. from their default note).
// This lets the parser pick out the right customer even when the line also
// contains unrelated narrative, instead of requiring that text be commented out.
// customers = [{ name, searchText }] where searchText includes full note body
// (title + everything else, e.g. address)
export function matchCustomerToText(text, customers) {
  if (!customers.length) return { name: '', score: 0 };
  const textWords = queryWords(text);
  let best = { name: '', score: 0 };
  for (const c of customers) {
    const nameWords = queryWords(c.name || '');
    if (!nameWords.length) continue;
    const infoWords = queryWords(c.searchText || c.name || '');
    const nameScore = recallScore(nameWords, text);
    const infoScore = recallScore(infoWords, text);
    // Reverse score: what fraction (by word weight) of the text's words appear
    // in this customer's full info? A customer whose note contains ALL the
    // clue words from the line (e.g. both "rob" and "tamarack") scores much
    // higher than one whose name merely shares a short word like "rob".
    const reverseScore = weightedRecallScore(textWords, c.searchText || c.name || '');
    const score = Math.max(
      nameScore,
      reverseScore * 0.7,
      nameScore * 0.5 + infoScore * 0.3 + reverseScore * 0.2
    );
    if (score > best.score) best = { name: c.name, score };
  }
  return best;
}

// customers = [{ name, searchText }] where searchText includes full note body
export function fuzzyMatchCustomer(query, customers) {
  if (!customers.length) return { name: query, score: 0 };
  const qw = queryWords(query);
  if (!qw.length) return { name: customers[0].name || query, score: 0 };

  let best = { name: customers[0].name || query, score: 0 };
  for (const c of customers) {
    const nameScore = recallScore(qw, c.name || '');
    const fullScore = recallScore(qw, c.searchText || c.name || '');
    // Use full-text score but give a small bonus when name alone is a strong match
    const score = Math.max(nameScore, nameScore * 0.4 + fullScore * 0.6);
    if (score > best.score) best = { name: c.name, score };
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

const EXPORT_MARKER_RE = /^\/\/\s*----\s*IIF exported:/i;

// ---------- Main parser ----------
// employees = [{ name: 'Davor' }, ...] — passed in from app settings
export function parseHoursNote(text, customers, employees) {
  // Normalise employee list — use passed-in list or fall back to defaults
  const empList = (employees && employees.length)
    ? employees.map(e => (typeof e === 'string' ? e : e.name).trim())
    : ['Davor', 'Janet'];

  const allLines = text.split('\n');

  // Only parse lines after the last export marker (if any)
  let startIndex = 0;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (EXPORT_MARKER_RE.test(allLines[i].trim())) {
      startIndex = i + 1;
      break;
    }
  }
  const lines = allLines.slice(startIndex);
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

    // Detect employees from the configured list
    let working = stripped;
    const foundEmps = empList.filter(emp =>
      new RegExp(`\\b${emp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(working)
    );

    let employeesFound = [];
    let employeeConfidence = 1.0;

    if (foundEmps.length > 0) {
      employeesFound = foundEmps.map(e => e.charAt(0).toUpperCase() + e.slice(1).toLowerCase());
      activeEmployees = employeesFound.slice();
    } else {
      employeesFound = activeEmployees.slice();
      employeeConfidence = activeEmployees.length > 0 ? 0.85 : 0;
    }

    // Remove employee names and "and" between them
    let cleaned = working;
    for (const emp of empList) {
      cleaned = cleaned.replace(new RegExp(`\\b${emp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), '');
    }
    cleaned = cleaned.replace(/\band\b/gi, '').trim();

    // Extract all time ranges (e.g. "9.15-3.05, 3.05-4.40") and sum them
    let hours = null;
    let hoursConfidence = 1.0;
    const timeRangeRe = /([\d.:]+(?:am|pm)?)\s*[-–]\s*([\d.:]+(?:am|pm)?)/gi;
    let trMatch;
    let totalHours = 0;
    let foundRanges = false;
    const usedRanges = [];
    while ((trMatch = timeRangeRe.exec(cleaned)) !== null) {
      const rangeHours = parseTimeRange(trMatch[0]);
      if (rangeHours !== null && rangeHours > 0) {
        totalHours += rangeHours;
        usedRanges.push(trMatch[0]);
        foundRanges = true;
      }
    }
    if (foundRanges) {
      hours = Math.round(totalHours * 100) / 100;
      for (const r of usedRanges) cleaned = cleaned.replace(r, '');
      cleaned = cleaned.trim();
    }

    // Extract duration (e.g. "3.5hrs")
    if (hours === null) {
      const durMatch = cleaned.match(/([\d.]+\s*hrs?)/i);
      if (durMatch) {
        hours = parseHoursDuration(durMatch[1]);
        cleaned = cleaned.replace(durMatch[0], '').trim();
      }
    }

    if (!hours || hours <= 0) hoursConfidence = 0;

    // First, look for a *known* customer mentioned anywhere in the remaining
    // text (by name and/or address/notes on file). This lets the parser
    // ignore surrounding narrative ("fixed the faucet, very happy, etc.")
    // without needing it commented out.
    const known = cleaned ? matchCustomerToText(cleaned, customers) : { name: '', score: 0 };

    let customerText, match;
    if (known.score >= 0.5) {
      customerText = known.name;
      match = known;
    } else {
      // No confident match to a known customer — use an obvious placeholder
      // so the entry stands out in review and is easy to fill in by hand.
      customerText = 'Bilbo Baggins';
      match = { name: customerText, score: 0 };
    }

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
// QuickBooks service items per employee classification. These must exist as
// Service-type items in the QB company file, with these exact names.
const ITEM_APPRENTICE = 'Service Rates: Labour Rate';
const ITEM_JOURNEYMAN = 'Service Rates: Standard Labour';

// employeeTypeMap: lowercased employee name → 'apprentice' | 'journeyman'
export function generateIIF(entries, employeeTypeMap = {}, companyName = 'Company Organizer Ninja') {
  const lines = [
    `!TIMERHDR\tVER\tREV\tCOMPANYNAME`,
    `TIMERHDR\t8\t0\t${companyName}`,
    `!TIMEACT\tDATE\tJOB\tEMP\tITEM\tDURATION\tNOTE`,
  ];
  for (const e of entries) {
    if (!e.employees.length || !e.hours || !e.customerMatched) continue;
    for (const emp of e.employees) {
      const item = employeeTypeMap[emp.toLowerCase()] === 'apprentice' ? ITEM_APPRENTICE : ITEM_JOURNEYMAN;
      lines.push(`TIMEACT\t${e.dateFormatted}\t${e.customerMatched}\t${emp}\t${item}\t${e.hoursFormatted}\t`);
    }
  }
  return lines.join('\n');
}
