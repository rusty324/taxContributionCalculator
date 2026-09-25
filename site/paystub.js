// Paystub text -> job fields. Pure functions (no DOM), so they can be tested under Node.
// Input is the stub as lines of text, from pdf.js or OCR. Layouts vary a lot between
// payroll providers, so everything here is a heuristic and the UI makes the user confirm.

const MONEY = /^\(?-?\$?(\d{1,3}(,\d{3})+|\d+)\.\d{2}\)?-?$/;
const D = String.raw`(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})`;
// "Period Beginning: 09/01/2026 ... Period Ending: 09/14/2026" (possibly on separate lines)
const BEGIN_END = new RegExp(String.raw`(?:begin\w*|start\w*|from)\W{0,4}(?:date\W{0,3})?${D}[\s\S]{0,80}?(?:end\w*|through|thru)\W{0,4}(?:date\W{0,3})?${D}`, 'i');
// "Pay Period 09/06/2026 - 09/19/2026"
const RANGE = new RegExp(String.raw`${D}\s*(?:-|–|to|thru|through)\s*${D}`, 'i');

export function parseMoney(token) {
  const t = token.replace(/[$,()\s]/g, '').replace(/-$/, '');
  const n = Number(t.replace(/^-/, ''));
  return Number.isFinite(n) ? n : NaN;
}

// Common OCR confusions inside numeric tokens. (No regex lookbehind: older Safari lacks it.)
function cleanToken(tok) {
  if (!/\d/.test(tok) || !/^[-($\dOoIl|,.)]+$/.test(tok)) return tok;
  let t = tok.replace(/[Oo]/g, '0').replace(/[lI|]/g, '1');
  t = t.replace(/(\d),(\d{2})$/, '$1.$2'); // "1,234,56" -> "1,234.56"
  return t;
}

/**
 * Split a line into label + numbers segments. Side-by-side columns on one physical
 * line ("Regular 40.00 1,000.00  Federal Income Tax 95.00 1,710.00") become two segments.
 */
export function segmentLine(line) {
  const tokens = line
    .replace(/\$\s*(\d{1,3})[\s,.](\d{3})[\s.](\d{2})(?!\d)/g, '$$$1,$2.$3') // OCR: "$2 903 26"
    .replace(/\$\s+/g, '$')
    .split(/\s+/).filter(Boolean).map(cleanToken);
  const lineHasMoney = tokens.some((t) => MONEY.test(t));
  const segments = [];
  let cur = null;
  for (const tok of tokens) {
    if (tok === '$') continue;
    // OCR often drops the decimal point ("477216" for 4,772.16). Accept a bare digit run
    // as implied cents only after a label, on a line that has other amounts.
    const impliedCents = lineHasMoney && cur?.label && /^-?\$?\d{3,7}-?$/.test(tok);
    if (MONEY.test(tok) || impliedCents) {
      if (!cur) cur = { label: '', values: [], repaired: false };
      cur.values.push(impliedCents ? parseMoney(tok) / 100 : parseMoney(tok));
      if (impliedCents) cur.repaired = true;
    } else {
      if (!cur || cur.values.length) {
        if (cur) segments.push(cur);
        cur = { label: tok, values: [], repaired: false };
      } else {
        cur.label += (cur.label ? ' ' : '') + tok;
      }
    }
  }
  if (cur) segments.push(cur);
  return segments.map((s) => ({ ...s, label: s.label.trim(), norm: normalize(s.label) }));
}

function normalize(label) {
  return ' ' + label.toLowerCase().replace(/[^a-z0-9/%]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';
}

const has = (norm, re) => re.test(norm);

// Each rule: which field, a label test, and a score (higher wins among candidates).
const EXCLUDE_FICA = / (social security|soc sec|oasdi|medicare|med ee|fica|ss ee|ss tax|mwt|swt fl) /;
const FIELD_RULES = [
  {
    field: 'fedTaxable',
    score: 3,
    test: (n) => has(n, / (fed(eral)?|fit|fwt) (income )?(tax )?taxable( wages| gross| earnings)? /) ||
      has(n, / taxable (wages|gross|earnings|income)( federal| fed| fit)? /) && !has(n, / (state|co |colorado|sit|medicare|social|oasdi|fica)/) ||
      has(n, / fed(eral)? (taxable )?gross /) && has(n, / taxable /),
  },
  {
    field: 'gross',
    score: 3,
    test: (n) => has(n, / (total )?gross( pay| earnings| wages| income)? /) && !has(n, / taxable | net /) && !has(n, / (fed|state|medicare|social|fica) /),
  },
  {
    field: 'gross',
    score: 1,
    test: (n) => has(n, / (total earnings|earnings total|total pay) /),
  },
  {
    field: 'fedWithheld',
    score: 3,
    test: (n) => !has(n, EXCLUDE_FICA) && !has(n, / taxable | gross /) &&
      (has(n, / (federal|fed) (income tax|inc tax|withholding|w\/h|wh|with|tax|it|fit) /) ||
        has(n, / (fitw?|fwt|fed it|federal income) /) || has(n, / federal( tax)? /) && has(n, / tax|withholding /)),
  },
  {
    field: 'coWithheld',
    score: 3,
    test: (n) => !has(n, / (famli|opt|occupational|local|city|county|sui|sdi|unemployment|taxable|gross) /) &&
      (has(n, / (co|colorado) (state )?(income )?(tax|withholding|w\/h|wh|sit|it|with) /) ||
        has(n, / (state income tax|state tax|state withholding|sit|swt) (co|colorado) /) ||
        has(n, / colorado /) && has(n, / tax|withholding /)),
  },
  {
    field: 'coWithheld',
    score: 1, // a state tax line that doesn't name the state
    test: (n) => !has(n, / (famli|sui|sdi|unemployment|disability|taxable|gross|local) /) &&
      has(n, / (state income tax|state tax|state withholding|state w\/h|st income tax|sit|swt) /),
  },
];

// Pre-tax deductions, used only if no federal taxable wage line is found.
const PRETAX = / (401 ?k|401 k|403 ?b|457|hsa|fsa|dep ?care|medical|dental|vision|health|section 125|sec 125|s125|pre ?tax|pretax|parking|transit) /;
const NOT_PRETAX = / (roth|after ?tax|employer|er match|company|match|ytd total) /;

function pickValues(values, norm = '') {
  // "Your federal taxable wages this period are $2,903.26" (ADP)
  if (values.length === 1 && / this period /.test(norm)) return { current: values[0], ytd: NaN, confidence: 'high' };
  if (values.length >= 2) {
    let [current, ytd] = values.slice(-2);
    const swapped = current > ytd && ytd > 0;
    if (swapped) [current, ytd] = [ytd, current];
    return { current, ytd, confidence: swapped ? 'medium' : 'high' };
  }
  if (values.length === 1) return { current: values[0], ytd: NaN, confidence: 'low' };
  return null;
}

const FREQ_WORDS = [
  [/\bbi-?weekly\b|\bevery (other|2) weeks?\b|\bfortnightly\b/i, 'biweekly'],
  [/\bsemi-?monthly\b|\btwice (a|per) month\b/i, 'semimonthly'],
  [/\bweekly\b/i, 'weekly'],
  [/\bmonthly\b/i, 'monthly'],
];

function toDate(m, d, y) {
  const yy = Number(y) < 100 ? 2000 + Number(y) : Number(y);
  const dt = new Date(yy, Number(m) - 1, Number(d));
  return Number.isNaN(dt.getTime()) ? null : dt;
}

export function detectFrequency(lines) {
  const text = lines.join('\n');
  const freqLine = lines.find((l) => /(pay )?(frequency|period type|pay cycle)/i.test(l));
  for (const src of [freqLine, text]) {
    if (!src) continue;
    for (const [re, f] of FREQ_WORDS) if (re.test(src)) return { value: f, confidence: src === freqLine ? 'high' : 'medium', source: freqLine || '' };
  }
  // Fall back to the length of the pay period. Only explicit begin/end or a date range
  // count, so a pay date or check date isn't mistaken for the end of the period.
  const joined = lines.join(' ');
  const m = joined.match(BEGIN_END) || joined.match(RANGE);
  if (m) {
    const a = toDate(m[1], m[2], m[3]);
    const b = toDate(m[4], m[5], m[6]);
    if (a && b) {
      const days = Math.round(Math.abs(b - a) / 86400000) + 1;
      const f = days <= 8 ? 'weekly' : days <= 14 ? 'biweekly' : days <= 17 ? 'semimonthly' : days <= 31 ? 'monthly' : null;
      if (f) return { value: f, confidence: 'medium', source: m[0].replace(/\s+/g, ' ').trim() };
    }
  }
  return null;
}

// Summary tables with column headers and Current / YTD rows (Workday and others):
//   Gross Pay  Pre Tax Deductions  Employee Taxes  Post Tax Deductions  Net Pay
//   Current    4,166.67  450.00     1,012.33       100.00               2,604.34
//   YTD        ...
const SUMMARY_HEADERS = [
  ['pretax', /pre[- ]?tax deductions?|before[- ]tax deductions?/i],
  ['posttax', /post[- ]?tax deductions?|after[- ]tax deductions?/i],
  ['taxes', /employee taxes|total taxes|taxes/i],
  ['net', /net pay/i],
  ['gross', /gross pay|gross earnings|total gross|gross/i],
];

function summaryHeader(line) {
  if (segmentLine(line).some((s) => s.values.length)) return null;
  const found = [];
  let rest = line;
  for (const [key, re] of SUMMARY_HEADERS) {
    const m = rest.match(re);
    if (!m) continue;
    found.push({ key, at: m.index });
    rest = rest.slice(0, m.index) + ' '.repeat(m[0].length) + rest.slice(m.index + m[0].length);
  }
  if (found.length < 3 || !found.some((f) => f.key === 'gross')) return null;
  return found.sort((a, b) => a.at - b.at).map((f) => f.key);
}

function parseSummary(lines) {
  for (let i = 0; i < lines.length; i++) {
    const header = summaryHeader(lines[i]);
    if (!header) continue;
    const out = {};
    for (const line of lines.slice(i + 1, i + 5)) {
      const seg = segmentLine(line)[0];
      if (!seg || seg.values.length !== header.length) continue;
      const kind = / (current|this period|period) /.test(seg.norm) ? 'current' : / (ytd|year to date) /.test(seg.norm) ? 'ytd' : null;
      if (!kind) continue;
      header.forEach((key, k) => { (out[key] ||= {})[kind] = seg.values[k]; });
      out.source = lines[i];
    }
    if (out.gross && Number.isFinite(out.gross.current)) return out;
  }
  return null;
}

/**
 * Returns { fields: { name: { value, confidence, source } }, lines }
 * Field names match the job inputs in app.js, plus coWithheldPerPeriod / coYtdWithheld.
 */
export function parsePaystub(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const best = {};
  let pretaxCur = 0;
  let pretaxYtd = 0;
  let pretaxSources = [];

  for (const line of lines) {
    for (const seg of segmentLine(line)) {
      const vals = pickValues(seg.values, seg.norm);
      if (vals && seg.repaired && vals.confidence === 'high') vals.confidence = 'medium';
      if (!vals || !seg.label) continue;
      for (const rule of FIELD_RULES) {
        if (!rule.test(seg.norm)) continue;
        const prev = best[rule.field];
        const rank = rule.score * 10 + (vals.confidence === 'high' ? 2 : vals.confidence === 'medium' ? 1 : 0);
        if (!prev || rank > prev.rank) best[rule.field] = { ...vals, rank, source: `${seg.label} ${seg.values.join(' ')}`, lowRule: rule.score < 3 };
        break; // one field per segment
      }
      if (has(seg.norm, PRETAX) && !has(seg.norm, NOT_PRETAX) && !has(seg.norm, EXCLUDE_FICA)) {
        pretaxCur += vals.current || 0;
        pretaxYtd += Number.isFinite(vals.ytd) ? vals.ytd : 0;
        pretaxSources.push(seg.label);
      }
    }
  }

  const fields = {};
  const put = (name, value, confidence, source) => {
    if (Number.isFinite(value)) fields[name] = { value: Math.round(value * 100) / 100, confidence, source };
  };
  const conf = (b) => (b.lowRule ? 'low' : b.confidence);

  const summary = parseSummary(lines);
  let g = best.gross;
  if (summary && (!g || conf(g) !== 'high')) {
    g = { current: summary.gross.current, ytd: summary.gross.ytd ?? NaN, confidence: 'high', source: `Summary: ${summary.source}` };
  }
  const ft = best.fedTaxable;
  if (g) put('grossPerPeriod', g.current, conf(g), g.source);
  if (g && ft && Number.isFinite(ft.current)) {
    put('pretaxPerPeriod', Math.max(0, g.current - ft.current), conf(ft) === 'high' && conf(g) === 'high' ? 'high' : 'medium', `Gross − federal taxable (${ft.source})`);
  } else if (summary?.pretax && Number.isFinite(summary.pretax.current)) {
    put('pretaxPerPeriod', summary.pretax.current, 'medium', `Summary: pre-tax deductions`);
  } else if (pretaxSources.length) {
    put('pretaxPerPeriod', pretaxCur, 'low', `Sum of ${pretaxSources.join(', ')}`);
  }
  if (ft && Number.isFinite(ft.ytd)) {
    put('ytdTaxableWages', ft.ytd, conf(ft), ft.source);
  } else if (g && Number.isFinite(g.ytd)) {
    const pre = summary?.pretax && Number.isFinite(summary.pretax.ytd) ? summary.pretax.ytd : pretaxYtd;
    put('ytdTaxableWages', Math.max(0, g.ytd - pre), 'low', `YTD gross − YTD pre-tax deductions`);
  }

  const fw = best.fedWithheld;
  if (fw) {
    put('fedWithheldPerPeriod', fw.current, conf(fw), fw.source);
    put('ytdWithheld', fw.ytd, conf(fw), fw.source);
  }
  const cw = best.coWithheld;
  if (cw) {
    put('coWithheldPerPeriod', cw.current, conf(cw), cw.source);
    put('coYtdWithheld', cw.ytd, conf(cw), cw.source);
  }
  sanityCheck(fields);
  const freq = detectFrequency(lines);
  if (freq) fields.frequency = freq;

  return { fields, lines };
}

// Drop or downgrade values that can't be right, which mostly catches OCR misreads.
function sanityCheck(fields) {
  const v = (k) => fields[k]?.value;
  const gross = v('grossPerPeriod');
  if (Number.isFinite(gross)) {
    for (const k of ['pretaxPerPeriod', 'fedWithheldPerPeriod', 'coWithheldPerPeriod']) {
      if (v(k) >= gross) delete fields[k];
    }
  }
  for (const [cur, ytd] of [['fedWithheldPerPeriod', 'ytdWithheld'], ['coWithheldPerPeriod', 'coYtdWithheld'], ['grossPerPeriod', 'ytdTaxableWages']]) {
    if (fields[ytd] && Number.isFinite(v(cur)) && v(ytd) < v(cur) * 0.9) fields[ytd].confidence = 'low';
  }
}

// ---------- PDF text layout -> lines (used by the browser; pure so it can be tested)

/**
 * pdf.js text items ({ str, transform: [a,b,c,d,x,y], width }) -> lines of text,
 * grouping by baseline and inserting wide gaps between columns.
 */
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    const h = Math.abs(it.transform[3]) || 10;
    let row = rows.find((r) => Math.abs(r.y - y) < h * 0.5);
    if (!row) rows.push((row = { y, h, items: [] }));
    row.items.push({ x, w: it.width || 0, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => {
    r.items.sort((a, b) => a.x - b.x);
    let out = '';
    let end = null;
    for (const it of r.items) {
      if (end !== null) out += it.x - end > r.h * 1.5 ? '   ' : it.x - end > r.h * 0.15 ? ' ' : '';
      out += it.str;
      end = it.x + it.w;
    }
    return out.trim();
  });
}
