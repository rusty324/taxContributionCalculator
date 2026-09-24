import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePaystub, segmentLine, itemsToLines, detectFrequency } from '../site/paystub.js';

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');
const val = (r, f) => r.fields[f]?.value;

test('segments side-by-side columns on one line', () => {
  const segs = segmentLine('Regular 1,000.00 20,000.00   Federal Income Tax (95.00) 1,710.00');
  assert.equal(segs.length, 2);
  assert.equal(segs[1].label, 'Federal Income Tax');
  assert.deepEqual(segs[1].values, [95, 1710]);
});

test('ADP-style stub', () => {
  const r = parsePaystub(fixture('adp.txt'));
  assert.equal(val(r, 'grossPerPeriod'), 3192.3);
  assert.equal(val(r, 'pretaxPerPeriod'), 289.04);
  assert.equal(r.fields.pretaxPerPeriod.confidence, 'high');
  assert.equal(val(r, 'fedWithheldPerPeriod'), 265.12);
  assert.equal(val(r, 'ytdWithheld'), 4772.16);
  assert.equal(val(r, 'coWithheldPerPeriod'), 110.52); // not the FAMLI premium
  assert.equal(val(r, 'coYtdWithheld'), 1989.36);
  // No YTD federal taxable line: YTD gross - YTD pre-tax, flagged low confidence
  assert.equal(val(r, 'ytdTaxableWages'), 56422.98 - (3447.72 + 225 + 1530));
  assert.equal(r.fields.ytdTaxableWages.confidence, 'low');
  assert.equal(r.fields.frequency.value, 'biweekly');
});

test('Workday-style stub with summary table', () => {
  const r = parsePaystub(fixture('workday.txt'));
  assert.equal(val(r, 'grossPerPeriod'), 4166.67);
  assert.equal(val(r, 'pretaxPerPeriod'), 450);
  assert.equal(val(r, 'ytdTaxableWages'), 63183.39);
  assert.equal(val(r, 'fedWithheldPerPeriod'), 512.4);
  assert.equal(val(r, 'ytdWithheld'), 8710.8);
  assert.equal(val(r, 'coWithheldPerPeriod'), 164.97);
  assert.equal(r.fields.frequency.value, 'semimonthly');
});

test('OCR text with common misreads', () => {
  const r = parsePaystub(fixture('ocr-paychex.txt'));
  assert.equal(val(r, 'grossPerPeriod'), 2500);
  assert.equal(val(r, 'pretaxPerPeriod'), 125); // Roth excluded via federal taxable line
  assert.equal(val(r, 'ytdTaxableWages'), 45125);
  assert.equal(val(r, 'fedWithheldPerPeriod'), 182.1);
  assert.equal(val(r, 'coYtdWithheld'), 1839.2); // "1,839,20" repaired
  assert.equal(r.fields.frequency.value, 'biweekly');
});

test('social security and medicare are never taken as federal income tax', () => {
  const r = parsePaystub('Fed OASDI/EE 100.00 1,800.00\nFed MED/EE 23.39 421.02\nFed Withholding 250.00 4,500.00');
  assert.equal(val(r, 'fedWithheldPerPeriod'), 250);
});

test('explicit pay frequency wins', () => {
  assert.equal(detectFrequency(['Pay Frequency: Weekly', 'Period 09/01/2026 - 09/14/2026']).value, 'weekly');
});

test('pdf.js items are grouped into lines with column gaps', () => {
  const item = (str, x, y, width) => ({ str, transform: [10, 0, 0, 10, x, y], width });
  const lines = itemsToLines([
    item('Federal Income Tax', 50, 700, 90),
    item('265.12', 300, 700.4, 30),
    item('4,772.16', 380, 699.8, 40),
    item('Gross Pay', 50, 720, 45),
    item('3,192.30', 300, 720, 40),
  ]);
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Gross Pay\s+3,192\.30$/);
  assert.equal(parsePaystub(lines.join('\n')).fields.fedWithheldPerPeriod.value, 265.12);
});

test('pay date after the period end is not used as the period end', () => {
  const f = detectFrequency(['Period Beginning: 09/01/2026 Period Ending: 09/14/2026 Pay Date: 09/19/2026']);
  assert.equal(f.value, 'biweekly');
  assert.equal(detectFrequency(['Period Start 08/01/2026', 'Period End 08/31/2026']).value, 'monthly');
  assert.equal(detectFrequency(['Check Date 09/19/2026']), null);
});

test('degraded phone photo: dropped decimals and split amounts are repaired', () => {
  const r = parsePaystub(fixture('ocr-photo.txt'));
  assert.equal(val(r, 'grossPerPeriod'), 3192.3);
  assert.equal(val(r, 'pretaxPerPeriod'), 289.04); // from "$2 903 26"
  assert.equal(val(r, 'fedWithheldPerPeriod'), 265.12);
  assert.equal(val(r, 'ytdWithheld'), 4772.16); // from "477216"
  assert.equal(r.fields.ytdWithheld.confidence, 'medium');
  assert.equal(val(r, 'coWithheldPerPeriod'), 110.52);
});

test('impossible values are dropped', () => {
  const r = parsePaystub('Gross Pay 1,000.00 20,000.00\nFederal Income Tax 1,500.00 3,000.00');
  assert.equal(r.fields.fedWithheldPerPeriod, undefined);
});

test('a bare number at the start of a label is not read as money', () => {
  const r = parsePaystub('Gross Pay 2,000.00 40,000.00\n401 k 100.00 2,000.00');
  assert.equal(val(r, 'pretaxPerPeriod'), 100);
});
