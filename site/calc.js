// Federal tax + W-4 withholding projection. Pure functions, no DOM access,
// so this module can be unit-tested under Node (see test/calc.test.js).

export const TAX_YEAR = 2026;

export const PERIODS_PER_YEAR = {
  weekly: 52,
  biweekly: 26,
  semimonthly: 24,
  monthly: 12,
};

// 2026 figures: IRS Rev. Proc. 2025-32 (post-OBBBA), SSA 2026 wage base.
// Each bracket is [upper bound of taxable income, rate].
export const TABLES = {
  brackets: {
    single: [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [640600, 0.35], [Infinity, 0.37]],
    mfj:    [[24800, 0.10], [100800, 0.12], [211400, 0.22], [403550, 0.24], [512450, 0.32], [768700, 0.35], [Infinity, 0.37]],
    mfs:    [[12400, 0.10], [50400, 0.12], [105700, 0.22], [201775, 0.24], [256225, 0.32], [384350, 0.35], [Infinity, 0.37]],
    hoh:    [[17700, 0.10], [67450, 0.12], [105700, 0.22], [201750, 0.24], [256200, 0.32], [640600, 0.35], [Infinity, 0.37]],
  },
  standardDeduction: { single: 16100, mfj: 32200, mfs: 16100, hoh: 24150 },
  // Extra standard deduction per box checked (65+ or blind).
  additionalStdDeduction: { married: 1650, unmarried: 2050 },
  // Top of the 0% and 15% bands for qualified dividends / long-term gains.
  capitalGainsBands: { single: [49450, 545500], mfj: [98900, 613700], mfs: [49450, 306850], hoh: [66200, 579600] },
  childTaxCredit: 2200,
  otherDependentCredit: 500,
  ctcPhaseoutStart: { mfj: 400000, other: 200000 },
  // OBBBA "senior deduction", 2025-2028: $6,000 per person 65+, phased out 6% above MAGI threshold.
  seniorDeduction: 6000,
  seniorPhaseoutStart: { mfj: 150000, other: 75000 },
  seniorPhaseoutRate: 0.06,
  ssWageBase: 184500,
  // Additional Medicare tax and NIIT share these thresholds (not inflation-indexed).
  surtaxThreshold: { single: 200000, mfj: 250000, mfs: 125000, hoh: 200000 },
  employerAddlMedicareThreshold: 200000,
  supplementalRate: 0.22,
  // Prior-year safe harbor rises to 110% above this prior-year AGI.
  safeHarborHighAgi: { mfs: 75000, other: 150000 },
};

const nz = (x) => (Number.isFinite(x) ? x : 0);
const pos = (x) => Math.max(0, nz(x));

export function taxFromBrackets(taxable, brackets) {
  let tax = 0;
  let lower = 0;
  for (const [upper, rate] of brackets) {
    if (taxable <= lower) break;
    tax += (Math.min(taxable, upper) - lower) * rate;
    lower = upper;
  }
  return tax;
}

export function marginalRate(taxable, brackets) {
  for (const [upper, rate] of brackets) {
    if (taxable < upper) return rate;
  }
  return brackets[brackets.length - 1][1];
}

// Qualified Dividends and Capital Gain Tax Worksheet.
export function incomeTaxWithPreferential(taxable, preferential, status) {
  const brackets = TABLES.brackets[status];
  const [top0, top15] = TABLES.capitalGainsBands[status];
  const pref = Math.min(pos(preferential), taxable);
  const ordinary = taxable - pref;
  let remaining = pref;
  const at0 = Math.min(remaining, Math.max(0, Math.min(taxable, top0) - ordinary));
  remaining -= at0;
  const at15 = Math.min(remaining, Math.max(0, Math.min(taxable, top15) - ordinary - at0));
  remaining -= at15;
  const at20 = remaining;
  return {
    ordinaryIncome: ordinary,
    ordinaryTax: taxFromBrackets(ordinary, brackets),
    preferentialTax: at15 * 0.15 + at20 * 0.20,
    tax: taxFromBrackets(ordinary, brackets) + at15 * 0.15 + at20 * 0.20,
  };
}

// Pay dates remaining after `today` through Dec 31, assuming evenly spaced paydays.
export function estimateRemainingPeriods(frequency, today = new Date()) {
  const y = today.getFullYear();
  const start = new Date(y, today.getMonth(), today.getDate());
  const end = new Date(y, 11, 31);
  const daysLeft = Math.round((end - start) / 86400000);
  switch (frequency) {
    case 'weekly': return Math.round(daysLeft / 7);
    case 'biweekly': return Math.round(daysLeft / 14);
    case 'semimonthly': {
      let n = 0;
      for (let m = today.getMonth(); m < 12; m++) {
        const lastDay = new Date(y, m + 1, 0);
        for (const d of [new Date(y, m, 15), lastDay]) if (d > start) n++;
      }
      return n;
    }
    case 'monthly': {
      let n = 0;
      for (let m = today.getMonth(); m < 12; m++) if (new Date(y, m + 1, 0) > start) n++;
      return n;
    }
    default: return 0;
  }
}

/**
 * Annual federal liability.
 * p.wages: { you, spouse } federal taxable (box 1) wages.
 */
export function computeLiability(p) {
  const status = p.filingStatus;
  const married = status === 'mfj' || status === 'mfs';
  const joint = status === 'mfj';
  const T = TABLES;

  const wagesYou = pos(p.wages?.you);
  const wagesSpouse = joint ? pos(p.wages?.spouse) : 0;
  const wages = wagesYou + wagesSpouse;

  // Self-employment tax (Schedule SE). The wage base is per person.
  const se = nz(p.seIncome);
  const seBase = se >= 400 ? se * 0.9235 : 0;
  const seOwnerWages = joint && p.seOwner === 'spouse' ? wagesSpouse : wagesYou;
  const seSocialSecurity = 0.124 * Math.min(seBase, Math.max(0, T.ssWageBase - seOwnerWages));
  const seMedicare = 0.029 * seBase;
  const seTax = seSocialSecurity + seMedicare;
  const halfSeTax = seTax / 2;

  const investOrdinary = nz(p.investOrdinary);
  const qualDiv = pos(p.qualifiedDividends);
  const ltcg = pos(p.ltcg);
  const otherIncome = nz(p.otherIncome);
  // Colorado FAMLI benefits: federally taxable (Form 1099-G), not wages, not investment income.
  const famliBenefits = pos(p.famliBenefits);

  const totalIncome = wages + investOrdinary + qualDiv + ltcg + otherIncome + famliBenefits + se;
  const agi = Math.max(0, totalIncome - halfSeTax - pos(p.adjustments));

  // Deductions
  const boxes = (p.you65 ? 1 : 0) + (p.youBlind ? 1 : 0) +
    (joint ? (p.spouse65 ? 1 : 0) + (p.spouseBlind ? 1 : 0) : 0);
  const standard = T.standardDeduction[status] +
    boxes * (married ? T.additionalStdDeduction.married : T.additionalStdDeduction.unmarried);
  const itemized = pos(p.itemized);
  const usesItemized = itemized > standard;
  const baseDeduction = usesItemized ? itemized : standard;

  const seniors = status === 'mfs' ? 0 : (p.you65 ? 1 : 0) + (joint && p.spouse65 ? 1 : 0);
  const seniorExcess = Math.max(0, agi - (joint ? T.seniorPhaseoutStart.mfj : T.seniorPhaseoutStart.other));
  const seniorDeduction = seniors * Math.max(0, T.seniorDeduction - T.seniorPhaseoutRate * seniorExcess);

  const otherDeductions = pos(p.otherDeductions);
  const totalDeductions = baseDeduction + seniorDeduction + otherDeductions;
  const taxable = Math.max(0, agi - totalDeductions);

  const it = incomeTaxWithPreferential(taxable, qualDiv + ltcg, status);

  // Credits (nonrefundable portion only; the refundable ACTC is not modeled).
  const creditBase = T.childTaxCredit * pos(p.kids) + T.otherDependentCredit * pos(p.otherDependents);
  const phaseStart = joint ? T.ctcPhaseoutStart.mfj : T.ctcPhaseoutStart.other;
  const ctcReduction = agi > phaseStart ? Math.ceil((agi - phaseStart) / 1000) * 50 : 0;
  const dependentCredits = Math.max(0, creditBase - ctcReduction);
  const credits = Math.min(it.tax, dependentCredits + pos(p.otherCredits));
  const creditsUnused = dependentCredits + pos(p.otherCredits) - credits;

  const surtaxTh = T.surtaxThreshold[status];
  const addlMedicare = 0.009 * Math.max(0, wages + seBase - surtaxTh);
  const nii = pos(investOrdinary) + qualDiv + ltcg;
  const niit = 0.038 * Math.min(nii, Math.max(0, agi - surtaxTh));

  const incomeTaxAfterCredits = it.tax - credits;
  const total = incomeTaxAfterCredits + seTax + addlMedicare + niit;

  return {
    wages, famliBenefits, totalIncome, agi, standard, itemized, usesItemized, seniorDeduction, otherDeductions,
    totalDeductions, taxable,
    ordinaryTax: it.ordinaryTax, preferentialTax: it.preferentialTax, incomeTax: it.tax,
    dependentCredits, credits, creditsUnused, incomeTaxAfterCredits,
    seTax, halfSeTax, addlMedicare, niit, total,
    marginal: marginalRate(it.ordinaryIncome, T.brackets[status]),
    effective: totalIncome > 0 ? total / totalIncome : 0,
  };
}

function employerAddlMedicare(annualWages) {
  return 0.009 * Math.max(0, annualWages - TABLES.employerAddlMedicareThreshold);
}

// Turn a shortfall into concrete W-4 numbers for one job.
// shortfall > 0 means more withholding is needed.
function recommendW4(job, shortfall, periodsLeft) {
  const P = PERIODS_PER_YEAR[job.frequency];
  const current4c = pos(job.current4c);
  const perPaycheck = pos(job.fedWithheldPerPeriod);
  if (periodsLeft <= 0) {
    return { possible: false, perPeriodChange: 0, step4c: current4c, step3Add: 0, capped: false };
  }
  const perPeriodChange = shortfall / periodsLeft;
  let step4c = current4c + perPeriodChange;
  let step3Add = 0;
  let capped = false;
  if (step4c < 0) {
    // Remove all extra withholding, then reduce the rest via Step 3, which lowers
    // withholding by (Step 3 amount / pay periods per year) each paycheck.
    let reduction = -step4c;
    const reducible = Math.max(0, perPaycheck - current4c);
    if (reduction > reducible) {
      reduction = reducible;
      capped = true;
    }
    step4c = 0;
    step3Add = reduction * P;
  }
  return { possible: true, perPeriodChange, step4c, step3Add, capped, periodsPerYear: P };
}

/**
 * Full projection for the current year plus a steady-state (next January) suggestion.
 */
export function project(input, today = new Date()) {
  const status = input.filingStatus;
  const joint = status === 'mfj';
  const jobs = (input.jobs || []).map((j) => {
    const P = PERIODS_PER_YEAR[j.frequency] || 26;
    const est = estimateRemainingPeriods(j.frequency, today);
    const remaining = Number.isFinite(j.remainingPeriods) ? Math.max(0, j.remainingPeriods) : est;
    const taxablePerPeriod = Math.max(0, nz(j.grossPerPeriod) - nz(j.pretaxPerPeriod));
    const bonus = pos(j.bonusRemaining);
    const annualWages = pos(j.ytdTaxableWages) + taxablePerPeriod * remaining + bonus;
    const bonusWithholding = bonus * TABLES.supplementalRate;
    const annualWithheld = pos(j.ytdWithheld) + pos(j.fedWithheldPerPeriod) * remaining + bonusWithholding;
    return {
      ...j,
      owner: joint && j.owner === 'spouse' ? 'spouse' : 'you',
      periodsPerYear: P,
      remaining,
      remainingEstimated: !Number.isFinite(j.remainingPeriods),
      taxablePerPeriod,
      annualWages,
      annualWithheld,
      bonusWithholding,
      employerAddlMedicare: employerAddlMedicare(annualWages),
      steadyWages: taxablePerPeriod * P,
      steadyWithheld: pos(j.fedWithheldPerPeriod) * P,
    };
  });

  const common = { ...input };
  const sumWages = (key) => ({
    you: jobs.filter((j) => j.owner === 'you').reduce((s, j) => s + j[key], 0),
    spouse: jobs.filter((j) => j.owner === 'spouse').reduce((s, j) => s + j[key], 0),
  });

  // ---- This year
  const liability = computeLiability({ ...common, wages: sumWages('annualWages') });
  const withheld = jobs.reduce((s, j) => s + j.annualWithheld, 0);
  const addlMedicareWithheld = jobs.reduce((s, j) => s + j.employerAddlMedicare, 0);
  const famliWithheld = pos(input.famliFedWithheld);
  const estimated = pos(input.estimatedPayments);
  const payments = withheld + famliWithheld + addlMedicareWithheld + estimated;
  const balance = payments - liability.total; // + refund, - owed
  const target = nz(input.targetRefund);
  const shortfall = liability.total + target - payments;

  let adjustIdx = Number.isInteger(input.adjustJobIndex) ? input.adjustJobIndex : -1;
  if (adjustIdx < 0 || adjustIdx >= jobs.length) {
    adjustIdx = jobs.reduce((best, j, i) => (best < 0 || j.taxablePerPeriod > jobs[best].taxablePerPeriod ? i : best), -1);
  }
  const adjJob = jobs[adjustIdx];
  const thisYear = adjJob ? recommendW4(adjJob, shortfall, adjJob.remaining) : null;

  // ---- Safe harbor (IRC 6654) against the current plan, before any change
  let safeHarbor = null;
  if (Number.isFinite(input.priorYearTax)) {
    const highAgi = pos(input.priorYearAgi) > (status === 'mfs' ? TABLES.safeHarborHighAgi.mfs : TABLES.safeHarborHighAgi.other);
    const priorPct = highAgi ? 1.10 : 1.00;
    const required = Math.min(0.9 * liability.total, priorPct * pos(input.priorYearTax));
    const owed = Math.max(0, -balance);
    safeHarbor = {
      required,
      priorPct,
      met: payments >= required || owed < 1000,
      under1000: owed < 1000,
      gap: Math.max(0, required - payments),
    };
  }

  // ---- Steady state: a full year of current paychecks, no bonuses
  let nextYear = null;
  if (jobs.length) {
    // Leave benefits are treated as a one-off, so they're left out of next year's picture.
    const steadyLiability = computeLiability({ ...common, famliBenefits: 0, wages: sumWages('steadyWages') });
    const steadyPayments = jobs.reduce((s, j) => s + j.steadyWithheld + employerAddlMedicare(j.steadyWages), 0);
    const steadyShortfall = steadyLiability.total + target - steadyPayments;
    nextYear = {
      liability: steadyLiability,
      payments: steadyPayments,
      shortfall: steadyShortfall,
      rec: recommendW4(adjJob, steadyShortfall, adjJob.periodsPerYear),
    };
  }

  return {
    jobs, liability, withheld, famliWithheld, addlMedicareWithheld, estimated, payments, balance, target,
    shortfall, adjustIdx, thisYear, safeHarbor, nextYear,
  };
}
