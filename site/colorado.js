// Colorado income tax + DR 0004 withholding projection. Builds on the federal
// projection from calc.js: Colorado taxable income starts from federal taxable income.
// Sources (docs/reference/): DR 1098 (10/21/25), DR 0004 (10/29/25), and the
// Colorado Individual Income Tax Guide (Jan 2026).

export const CO_TABLES = {
  rate: 0.044,
  // DR 1098 Step 2a: allowance an employer uses when DR 0004 Line 2 is blank.
  w4DefaultAllowance: { mfj: 11000, other: 5500 },
  // DR 0004 Table 1: standard allowance per job, indexed by number of jobs (1, 2, 3, 4+).
  table1Allowance: {
    single: [14000, 7000, 4500, 3500],
    mfs: [14000, 7000, 4500, 3500],
    hoh: [22000, 11000, 7500, 5500],
    mfj: [30000, 15000, 10000, 7500],
  },
  // Income Tax Guide Part 3 (Proposition MM, 2026+): above this federal AGI, the federal
  // standard/itemized deduction is limited to these amounts; the excess is added back.
  deductionLimitAgi: 300000,
  deductionLimit: { mfj: 2000, other: 1000 },
};

const nz = (x) => (Number.isFinite(x) ? x : 0);
const pos = (x) => Math.max(0, nz(x));

/**
 * Colorado liability for one federal liability result (see computeLiability in calc.js).
 */
export function coloradoLiability(fed, status, co) {
  const joint = status === 'mfj';
  const rate = Number.isFinite(co.rate) ? co.rate : CO_TABLES.rate;
  const baseDeduction = fed.usesItemized ? fed.itemized : fed.standard;

  // State income tax addback: lesser of state income tax deducted or the
  // amount itemized deductions exceed the standard deduction.
  const stateTaxAddback = fed.usesItemized
    ? Math.min(pos(co.stateIncomeTaxItemized), Math.max(0, fed.itemized - fed.standard))
    : 0;

  // The guide doesn't say how this coordinates with the state income tax addback; we
  // assume the two together can't add back more than (deduction - limit).
  const limit = joint ? CO_TABLES.deductionLimit.mfj : CO_TABLES.deductionLimit.other;
  const deductionAddback = fed.agi > CO_TABLES.deductionLimitAgi
    ? Math.max(0, baseDeduction - stateTaxAddback - limit)
    : 0;

  const overtimeAddback = pos(co.overtimeAddback);
  const otherAdditions = pos(co.otherAdditions);
  const additions = stateTaxAddback + deductionAddback + overtimeAddback + otherAdditions;
  // FAMLI benefits included in federal taxable income are exempt from Colorado tax
  // (rule 39-22-104(2)-1; DR 0104AD).
  const famliSubtraction = pos(fed.famliBenefits);
  const otherSubtractions = pos(co.subtractions);
  const subtractions = famliSubtraction + otherSubtractions;

  const taxable = Math.max(0, fed.taxable + additions - subtractions);
  const tax = taxable * rate;
  const credits = pos(co.credits);
  // Many Colorado credits (child tax credit, family affordability, EITC) are refundable.
  const total = tax - credits;

  return {
    federalTaxable: fed.taxable, stateTaxAddback, deductionAddback, overtimeAddback, otherAdditions,
    additions, famliSubtraction, otherSubtractions, subtractions, taxable, rate, tax, credits, total,
  };
}

// Allowance currently in effect, backed out of the paystub if not given, by inverting
// DR 1098 Step 2: withheld = max(0, annualWages - allowance) * rate / P + extra
export function impliedAllowance(job, coJob, rate) {
  if (Number.isFinite(coJob.currentAllowance)) return Math.max(0, coJob.currentAllowance);
  const P = job.periodsPerYear;
  const annual = job.taxablePerPeriod * P;
  const base = pos(coJob.withheldPerPeriod) - pos(coJob.currentExtra);
  if (base <= 0) return annual; // nothing withheld: allowance is at least the full wage
  return Math.max(0, annual - (base * P) / rate);
}

/**
 * Turn a shortfall into DR 0004 numbers for one job.
 * mode 'catchup' prefers the per-paycheck additional withholding line;
 * mode 'steady' prefers expressing everything through the annual allowance.
 */
function recommendDR0004(job, coJob, shortfall, periodsLeft, rate, mode) {
  const P = job.periodsPerYear;
  const annualWages = job.taxablePerPeriod * P;
  const allowance = impliedAllowance(job, coJob, rate);
  const extra = pos(coJob.currentExtra);
  if (periodsLeft <= 0) return { possible: false };
  const perPeriodChange = shortfall / periodsLeft;

  if (mode === 'catchup' && perPeriodChange >= 0) {
    return { possible: true, perPeriodChange, allowance, extra: extra + perPeriodChange, allowanceChanged: false, currentAllowance: allowance, currentExtra: extra };
  }

  // Express the target per-check withholding through allowance (and extra if needed).
  // Each $1 of allowance lowers withholding by rate / P per check.
  let newExtra = mode === 'steady' ? 0 : extra;
  let reduction = -perPeriodChange; // positive = withhold less
  if (mode === 'steady') reduction += extra; // moving any current extra into the allowance math
  if (mode === 'catchup') {
    const fromExtra = Math.min(newExtra, reduction);
    newExtra -= fromExtra;
    reduction -= fromExtra;
  }
  let newAllowance = allowance + (reduction * P) / rate;
  let capped = false;
  if (newAllowance < 0) {
    // Need more withholding than a zero allowance gives: put the rest on the extra line.
    newExtra += (-newAllowance * rate) / P;
    newAllowance = 0;
  } else if (newAllowance > annualWages) {
    newAllowance = annualWages;
    capped = true;
  }
  return {
    possible: true, perPeriodChange, allowance: newAllowance, extra: newExtra,
    allowanceChanged: Math.abs(newAllowance - allowance) >= 1, capped,
    currentAllowance: allowance, currentExtra: extra,
  };
}

/**
 * fedResult: output of project() in calc.js.
 * co: { rate, stateIncomeTaxItemized, overtimeAddback, otherAdditions, subtractions, credits,
 *       estimatedPayments, targetRefund, adjustJobIndex, jobs: { [jobId]: { withheldPerPeriod,
 *       ytdWithheld, currentExtra, currentAllowance } } }
 */
export function projectColorado(fedResult, status, co) {
  const rate = Number.isFinite(co.rate) ? co.rate : CO_TABLES.rate;
  const liability = coloradoLiability(fedResult.liability, status, { ...co, rate });

  const jobs = fedResult.jobs.map((j) => {
    const cj = co.jobs?.[j.id] || {};
    // DR 1098 has no separate supplemental rate: a bonus is annualized with the paycheck,
    // so once regular wages exceed the allowance it adds bonus * rate.
    const bonusWithholding = pos(j.bonusRemaining) * rate;
    const annualWithheld = pos(cj.ytdWithheld) + pos(cj.withheldPerPeriod) * j.remaining + bonusWithholding;
    return { job: j, co: cj, annualWithheld, steadyWithheld: pos(cj.withheldPerPeriod) * j.periodsPerYear };
  });

  const withheld = jobs.reduce((s, j) => s + j.annualWithheld, 0);
  const estimated = pos(co.estimatedPayments);
  const payments = withheld + estimated;
  const balance = payments - liability.total;
  const target = nz(co.targetRefund);
  const shortfall = liability.total + target - payments;

  let idx = Number.isInteger(co.adjustJobIndex) ? co.adjustJobIndex : -1;
  if (idx < 0 || idx >= jobs.length) idx = fedResult.adjustIdx;
  const adj = jobs[idx];
  const thisYear = adj ? recommendDR0004(adj.job, adj.co, shortfall, adj.job.remaining, rate, 'catchup') : null;

  let nextYear = null;
  if (adj && fedResult.nextYear) {
    const steadyLiability = coloradoLiability(fedResult.nextYear.liability, status, { ...co, rate });
    const steadyPayments = jobs.reduce((s, j) => s + j.steadyWithheld, 0);
    const steadyShortfall = steadyLiability.total + target - steadyPayments;
    nextYear = {
      liability: steadyLiability,
      payments: steadyPayments,
      shortfall: steadyShortfall,
      rec: recommendDR0004(adj.job, adj.co, steadyShortfall, adj.job.periodsPerYear, rate, 'steady'),
    };
  }

  const table1 = CO_TABLES.table1Allowance[status] || CO_TABLES.table1Allowance.single;
  const table1Allowance = jobs.length ? table1[Math.min(jobs.length, 4) - 1] : null;

  return {
    liability, jobs, withheld, estimated, payments, balance, target, shortfall,
    adjustIdx: idx, thisYear, nextYear, table1Allowance,
    defaultAllowance: status === 'mfj' ? CO_TABLES.w4DefaultAllowance.mfj : CO_TABLES.w4DefaultAllowance.other,
  };
}
