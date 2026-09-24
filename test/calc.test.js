import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLiability, project, estimateRemainingPeriods, TABLES, taxFromBrackets } from '../site/calc.js';

const close = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

test('single, $100k wages, standard deduction', () => {
  const r = computeLiability({ filingStatus: 'single', wages: { you: 100000 } });
  close(r.taxable, 83900);
  // 1,240 + 4,560 + 22% * 33,500
  close(r.total, 13170);
  assert.equal(r.marginal, 0.22);
});

test('MFJ, $150k wages, two kids', () => {
  const r = computeLiability({ filingStatus: 'mfj', wages: { you: 90000, spouse: 60000 }, kids: 2 });
  close(r.taxable, 117800);
  close(r.incomeTax, 15340);
  close(r.total, 15340 - 4400);
});

test('child credit phases out $50 per $1,000 over threshold', () => {
  const r = computeLiability({ filingStatus: 'single', wages: { you: 210500 }, kids: 1 });
  // 10,500 over -> 11 steps -> $550 reduction
  close(r.dependentCredits, 2200 - 550);
});

test('long-term gains stack on top of ordinary income', () => {
  const r = computeLiability({ filingStatus: 'single', wages: { you: 50000 }, ltcg: 20000 });
  // ordinary taxable 33,900 -> 3,820; 15,550 at 0%, 4,450 at 15%
  close(r.total, 3820 + 4450 * 0.15);
});

test('self-employment tax and half-SE deduction', () => {
  const r = computeLiability({ filingStatus: 'single', seIncome: 50000 });
  const se = 50000 * 0.9235 * 0.153;
  close(r.seTax, se);
  const taxable = 50000 - se / 2 - 16100;
  close(r.total, taxFromBrackets(taxable, TABLES.brackets.single) + se);
});

test('SE social security portion respects wage base already used by W-2 wages', () => {
  const r = computeLiability({ filingStatus: 'single', wages: { you: 184500 }, seIncome: 20000 });
  close(r.seTax, 20000 * 0.9235 * 0.029);
});

test('additional Medicare and NIIT', () => {
  const r = computeLiability({ filingStatus: 'mfj', wages: { you: 150000, spouse: 150000 }, investOrdinary: 10000 });
  close(r.addlMedicare, 0.009 * 50000);
  close(r.niit, 0.038 * 10000);
});

test('senior deduction phases out per person', () => {
  const r = computeLiability({ filingStatus: 'mfj', wages: { you: 170000 }, you65: true, spouse65: true });
  // AGI 170k -> 20k over -> each $6,000 reduced by $1,200
  close(r.seniorDeduction, 2 * 4800);
  close(r.standard, 32200 + 2 * 1650);
});

test('remaining pay periods estimate', () => {
  const d = new Date(2026, 8, 24); // Sep 24, 2026
  assert.equal(estimateRemainingPeriods('monthly', d), 4); // Sep 30, Oct, Nov, Dec
  assert.equal(estimateRemainingPeriods('semimonthly', d), 7); // Sep 30 + 3 * 2
  assert.equal(estimateRemainingPeriods('biweekly', d), 7);
  assert.equal(estimateRemainingPeriods('weekly', d), 14);
});

test('under-withheld single job -> positive Step 4(c) spread over remaining checks', () => {
  const r = project({
    filingStatus: 'single',
    jobs: [{
      frequency: 'biweekly', grossPerPeriod: 4000, pretaxPerPeriod: 0, fedWithheldPerPeriod: 400,
      current4c: 0, ytdTaxableWages: 72000, ytdWithheld: 7200, remainingPeriods: 8, bonusRemaining: 0,
    }],
    targetRefund: 0,
  });
  // wages 104,000 -> taxable 87,900 -> tax 14,050; withheld 7,200 + 3,200 = 10,400
  close(r.liability.total, 14050);
  close(r.shortfall, 3650);
  close(r.thisYear.step4c, 3650 / 8);
  // Steady state: 26 * 400 = 10,400 withheld vs same 14,050 tax
  close(r.nextYear.rec.step4c, 3650 / 26);
});

test('over-withheld job -> 4(c) zeroed, remainder moved to Step 3', () => {
  const r = project({
    filingStatus: 'single',
    jobs: [{
      frequency: 'biweekly', grossPerPeriod: 4000, pretaxPerPeriod: 0, fedWithheldPerPeriod: 800,
      current4c: 100, ytdTaxableWages: 72000, ytdWithheld: 14400, remainingPeriods: 8,
    }],
  });
  // withheld 14,400 + 6,400 = 20,800 vs 14,050 -> reduce 6,750 over 8 checks = 843.75/check
  // 4(c) 100 -> 0 covers 100; remaining 743.75/check * 26 in Step 3; base withholding is 700 so capped
  assert.equal(r.thisYear.step4c, 0);
  assert.equal(r.thisYear.capped, true);
  close(r.thisYear.step3Add, 700 * 26);
});
