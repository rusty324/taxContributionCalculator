import { test } from 'node:test';
import assert from 'node:assert/strict';
import { project, computeLiability } from '../site/calc.js';
import { coloradoLiability, projectColorado, impliedAllowance } from '../site/colorado.js';

const close = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

test('flat 4.4% on federal taxable income', () => {
  const fed = computeLiability({ filingStatus: 'single', wages: { you: 100000 } });
  const co = coloradoLiability(fed, 'single', {});
  close(co.taxable, 83900);
  close(co.total, 83900 * 0.044);
});

test('overtime addback, subtractions and credits', () => {
  const fed = computeLiability({ filingStatus: 'single', wages: { you: 100000 }, otherDeductions: 5000 });
  const co = coloradoLiability(fed, 'single', { overtimeAddback: 5000, subtractions: 2000, credits: 100 });
  close(co.taxable, 78900 + 5000 - 2000);
  close(co.total, 81900 * 0.044 - 100);
});

test('state income tax addback limited to itemized excess over standard', () => {
  const fed = computeLiability({ filingStatus: 'single', wages: { you: 150000 }, itemized: 20000 });
  const co = coloradoLiability(fed, 'single', { stateIncomeTaxItemized: 6000 });
  close(co.stateTaxAddback, 20000 - 16100);
});

test('Prop MM deduction limit above $300k AGI', () => {
  const fed = computeLiability({ filingStatus: 'mfj', wages: { you: 350000 } });
  const co = coloradoLiability(fed, 'mfj', {});
  close(co.deductionAddback, 32200 - 2000);
  const under = coloradoLiability(computeLiability({ filingStatus: 'mfj', wages: { you: 290000 } }), 'mfj', {});
  assert.equal(under.deductionAddback, 0);
});

test('implied allowance recovers the DR 1098 formula', () => {
  // $4,000 biweekly, W-4-only default $5,500: (104,000 - 5,500) * 4.4% / 26 = 166.69
  const job = { periodsPerYear: 26, taxablePerPeriod: 4000 };
  const withheld = ((104000 - 5500) * 0.044) / 26;
  close(impliedAllowance(job, { withheldPerPeriod: withheld }, 0.044), 5500);
});

const baseFed = (coWithheld, extra = 0) => {
  const fed = project({
    filingStatus: 'single',
    jobs: [{
      id: 'a', frequency: 'biweekly', grossPerPeriod: 4000, fedWithheldPerPeriod: 400,
      ytdTaxableWages: 72000, ytdWithheld: 7200, remainingPeriods: 8,
    }],
  });
  const co = projectColorado(fed, 'single', {
    jobs: { a: { withheldPerPeriod: coWithheld, ytdWithheld: coWithheld * 18, currentExtra: extra } },
  });
  return { fed, co };
};

test('under-withheld: additional withholding per paycheck, steady state via allowance', () => {
  // Liability: 87,900 * 4.4% = 3,867.60
  const perCheck = ((104000 - 30000) * 0.044) / 26; // allowance set too high
  const { co } = baseFed(perCheck);
  close(co.liability.total, 3867.6);
  const shortfall = 3867.6 - perCheck * 26;
  assert.ok(shortfall > 0);
  close(co.shortfall, shortfall);
  close(co.thisYear.extra, shortfall / 8);
  assert.equal(co.thisYear.allowanceChanged, false);
  // Steady state: allowance such that (104,000 - A) * 4.4% = 3,867.60 -> A = 16,100
  close(co.nextYear.rec.allowance, 16100);
  close(co.nextYear.rec.extra, 0);
});

test('over-withheld: extra removed first, then allowance raised', () => {
  const perCheck = ((104000 - 5500) * 0.044) / 26;
  const { co } = baseFed(perCheck + 20, 20);
  // Over by 20/check for 26 checks = 520 more than needed (+ shortfall from default allowance)
  const shortfall = 3867.6 - (perCheck + 20) * 26;
  assert.ok(shortfall < 0);
  const reduce = -shortfall / 8; // per check
  assert.equal(co.thisYear.extra, 0);
  close(co.thisYear.allowance, 5500 + ((reduce - 20) * 26) / 0.044);
});

test('DR 0004 Table 1 reference allowance by status and number of jobs', () => {
  const job = (id) => ({ id, frequency: 'biweekly', grossPerPeriod: 3000, remainingPeriods: 0 });
  const fed2 = project({ filingStatus: 'mfj', jobs: [job('a'), job('b')] });
  assert.equal(projectColorado(fed2, 'mfj', {}).table1Allowance, 15000);
  const fed5 = project({ filingStatus: 'hoh', jobs: ['a', 'b', 'c', 'd', 'e'].map(job) });
  assert.equal(projectColorado(fed5, 'hoh', {}).table1Allowance, 5500);
});
