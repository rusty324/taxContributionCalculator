import { project, estimateRemainingPeriods, TABLES, TAX_YEAR } from './calc.js';
import { projectColorado, CO_TABLES } from './colorado.js';

const STORAGE_KEY = 'w4-check-v1';
const form = document.getElementById('form');
const jobsEl = document.getElementById('jobs');
const jobTpl = document.getElementById('job-template');
const adjustSel = document.getElementById('adjust-job');
const resultsEl = document.getElementById('results');
const coForm = document.getElementById('co-form');
const coJobsEl = document.getElementById('co-jobs');
const coJobTpl = document.getElementById('co-job-template');
const coAdjustSel = document.getElementById('co-adjust-job');
const coResultsEl = document.getElementById('co-results');

// Colorado per-job inputs, keyed by the federal job's id.
let coJobState = {};
let coJobsSignature = '';
const newId = () => Math.random().toString(36).slice(2, 10);

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const pct = (x) => `${(x * 100).toFixed(1).replace(/\.0$/, '')}%`;
const money = (x) => usd.format(Math.round(x) === 0 ? 0 : x);
// Round per-paycheck amounts up to whole dollars so the W-4 number is easy to write down.
const perCheck = (x) => usd.format(Math.ceil(x - 0.005));

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function num(el) {
  if (!el || el.value.trim() === '') return NaN;
  return Number(el.value);
}

function jobName(job, i) {
  return job.label?.trim() || `Job ${i + 1}`;
}

// ---------- jobs UI

function addJob(data = {}) {
  const node = jobTpl.content.firstElementChild.cloneNode(true);
  node.dataset.id = data.id || newId();
  for (const el of node.querySelectorAll('[data-field]')) {
    const v = data[el.dataset.field];
    if (v !== undefined && v !== null) el.value = v;
  }
  node.querySelector('.remove-job').addEventListener('click', () => {
    node.remove();
    update();
  });
  jobsEl.appendChild(node);
  return node;
}

function readJobs() {
  return [...jobsEl.querySelectorAll('.job')].map((node) => {
    const f = (name) => node.querySelector(`[data-field="${name}"]`);
    return {
      id: node.dataset.id,
      label: f('label').value,
      owner: f('owner').value,
      frequency: f('frequency').value,
      remainingPeriods: num(f('remainingPeriods')),
      grossPerPeriod: num(f('grossPerPeriod')),
      pretaxPerPeriod: num(f('pretaxPerPeriod')),
      fedWithheldPerPeriod: num(f('fedWithheldPerPeriod')),
      current4c: num(f('current4c')),
      ytdTaxableWages: num(f('ytdTaxableWages')),
      ytdWithheld: num(f('ytdWithheld')),
      bonusRemaining: num(f('bonusRemaining')),
    };
  });
}

function refreshJobHints(today) {
  for (const node of jobsEl.querySelectorAll('.job')) {
    const freq = node.querySelector('[data-field="frequency"]').value;
    const input = node.querySelector('[data-field="remainingPeriods"]');
    const est = estimateRemainingPeriods(freq, today);
    input.placeholder = `${est} (estimated)`;
  }
}

function fillAdjustOptions(sel, jobs) {
  const prev = sel.value;
  sel.innerHTML = '<option value="auto">Highest-paying job</option>' +
    jobs.map((j, i) => `<option value="${i}">${esc(jobName(j, i))}</option>`).join('');
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'auto';
}

function refreshAdjustOptions(jobs) {
  fillAdjustOptions(adjustSel, jobs);
  fillAdjustOptions(coAdjustSel, jobs);
}

// Rebuild the Colorado job rows only when the set of jobs (or their names) changes,
// so typing in a Colorado field never loses focus.
function syncColoradoJobs(jobs, joint) {
  const sig = JSON.stringify(jobs.map((j) => [j.id, j.label, j.owner, joint]));
  if (sig === coJobsSignature) return;
  coJobsSignature = sig;
  coJobsEl.innerHTML = '';
  if (!jobs.length) {
    coJobsEl.innerHTML = '<p class="muted">Add a job on the Federal tab first.</p>';
    return;
  }
  jobs.forEach((j, i) => {
    const node = coJobTpl.content.firstElementChild.cloneNode(true);
    node.dataset.id = j.id;
    node.querySelector('.co-job-name').textContent =
      jobName(j, i) + (joint ? (j.owner === 'spouse' ? ' (spouse)' : ' (you)') : '');
    const state = coJobState[j.id] || {};
    for (const el of node.querySelectorAll('[data-co]')) {
      if (state[el.dataset.co] !== undefined) el.value = state[el.dataset.co];
    }
    coJobsEl.appendChild(node);
  });
}

function readColoradoJobs() {
  const out = {};
  for (const node of coJobsEl.querySelectorAll('.co-job')) {
    const raw = {};
    const parsed = {};
    for (const el of node.querySelectorAll('[data-co]')) {
      raw[el.dataset.co] = el.value;
      parsed[el.dataset.co] = num(el);
    }
    coJobState[node.dataset.id] = raw;
    out[node.dataset.id] = parsed;
  }
  return out;
}

function readColorado() {
  const fd = coForm.elements;
  const ratePct = num(fd.coRatePct);
  return {
    rate: Number.isFinite(ratePct) ? ratePct / 100 : CO_TABLES.rate,
    overtimeAddback: num(fd.coOvertimeAddback),
    stateIncomeTaxItemized: num(fd.coStateIncomeTaxItemized),
    otherAdditions: num(fd.coOtherAdditions),
    subtractions: num(fd.coSubtractions),
    credits: num(fd.coCredits),
    estimatedPayments: num(fd.coEstimatedPayments),
    targetRefund: num(fd.coTargetRefund),
    adjustJobIndex: coAdjustSel.value === 'auto' ? -1 : Number(coAdjustSel.value),
    jobs: readColoradoJobs(),
  };
}

// ---------- read / persist

function readInput() {
  const fd = form.elements;
  const jobs = readJobs();
  refreshAdjustOptions(jobs);
  return {
    filingStatus: fd.filingStatus.value,
    kids: num(fd.kids),
    otherDependents: num(fd.otherDependents),
    you65: fd.you65.checked,
    youBlind: fd.youBlind.checked,
    spouse65: fd.spouse65.checked,
    spouseBlind: fd.spouseBlind.checked,
    jobs,
    investOrdinary: num(fd.investOrdinary),
    qualifiedDividends: num(fd.qualifiedDividends),
    ltcg: num(fd.ltcg),
    otherIncome: num(fd.otherIncome),
    seIncome: num(fd.seIncome),
    seOwner: fd.seOwner.value,
    itemized: num(fd.itemized),
    adjustments: num(fd.adjustments),
    otherDeductions: num(fd.otherDeductions),
    otherCredits: num(fd.otherCredits),
    estimatedPayments: num(fd.estimatedPayments),
    priorYearTax: num(fd.priorYearTax),
    priorYearAgi: num(fd.priorYearAgi),
    targetRefund: num(fd.targetRefund),
    adjustJobIndex: adjustSel.value === 'auto' ? -1 : Number(adjustSel.value),
  };
}

function save() {
  const data = { fields: {}, jobs: [], co: { fields: {}, jobs: coJobState } };
  for (const el of form.querySelectorAll('[name]')) {
    data.fields[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  for (const el of coForm.querySelectorAll('[name]')) data.co.fields[el.name] = el.value;
  for (const node of jobsEl.querySelectorAll('.job')) {
    const job = { id: node.dataset.id };
    for (const el of node.querySelectorAll('[data-field]')) job[el.dataset.field] = el.value;
    data.jobs.push(job);
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); } catch { /* storage unavailable */ }
}

function load() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(STORAGE_KEY)); } catch { /* ignore */ }
  if (!data) {
    addJob();
    return;
  }
  for (const job of data.jobs || []) addJob(job);
  if (!data.jobs?.length) addJob();
  // Populate the adjust-job options before restoring its value.
  refreshAdjustOptions(readJobs());
  for (const [name, v] of Object.entries(data.fields || {})) {
    const el = form.elements[name];
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = !!v;
    else el.value = v;
  }
  coJobState = data.co?.jobs || {};
  for (const [name, v] of Object.entries(data.co?.fields || {})) {
    const el = coForm.elements[name];
    if (el) el.value = v;
  }
}

// ---------- results

function recHtml(rec, job, jobLabel, periodsText) {
  const current4c = Number.isFinite(job.current4c) ? job.current4c : 0;
  if (rec.step3Add > 0) {
    return `
      <p class="rec-main">On the W-4 for <strong>${esc(jobLabel)}</strong>:</p>
      <ul class="rec-list">
        <li>Set <strong>Step 4(c)</strong> to <strong class="big">${usd.format(0)}</strong>${current4c > 0 ? ` <span class="muted">(now ${usd2.format(current4c)})</span>` : ''}</li>
        <li>Increase <strong>Step 3</strong> by <strong class="big">${usd.format(Math.floor(rec.step3Add))}</strong></li>
      </ul>
      <p class="muted">That lowers federal withholding by about ${usd2.format(Math.abs(rec.perPeriodChange))} per paycheck ${periodsText}.</p>
      ${rec.capped ? '<p class="warn">Even withholding nothing on this job leaves you over-withheld. Lower withholding on another job too, or accept a larger refund.</p>' : ''}`;
  }
  const dir = rec.perPeriodChange >= 0 ? 'more' : 'less';
  return `
    <p class="rec-main">On the W-4 for <strong>${esc(jobLabel)}</strong>, set <strong>Step 4(c)</strong> to</p>
    <p class="rec-figure">${perCheck(rec.step4c)} <span>per paycheck</span></p>
    <p class="muted">${current4c > 0 ? `Now ${usd2.format(current4c)}. ` : ''}That's ${usd2.format(Math.abs(rec.perPeriodChange))} ${dir} withheld per paycheck ${periodsText}.</p>`;
}

function row(label, value, cls = '') {
  return `<tr class="${cls}"><th scope="row">${label}</th><td>${value}</td></tr>`;
}

function render(input, r) {
  const L = r.liability;
  const hasAnyIncome = L.totalIncome > 0;
  if (!hasAnyIncome) {
    resultsEl.innerHTML = `
      <h2>Your result</h2>
      <p class="muted">Enter your paystub numbers on the left. Results update as you type.</p>`;
    return;
  }

  const owe = r.balance < 0;
  const tolerance = Math.max(50, L.total * 0.005);
  const onTrack = Math.abs(r.shortfall) <= tolerance;
  const status = owe
    ? `<p class="status owe">On your current withholding you'd <strong>owe about ${money(-r.balance)}</strong>.</p>`
    : `<p class="status refund">On your current withholding you'd get a <strong>refund of about ${money(r.balance)}</strong>.</p>`;

  let rec = '';
  const job = r.jobs[r.adjustIdx];
  if (onTrack) {
    rec = `<div class="rec ok"><p class="rec-main"><strong>No change needed.</strong> You're within ${money(tolerance)} of your goal.</p></div>`;
  } else if (!job) {
    rec = r.shortfall > 0
      ? `<div class="rec"><p class="rec-main">With no W-2 job to adjust, cover the ${money(r.shortfall)} gap with estimated payments (Form 1040-ES).</p></div>`
      : '';
  } else if (!r.thisYear.possible) {
    rec = r.shortfall > 0
      ? `<div class="rec"><p class="rec-main">No paychecks left on ${esc(jobName(job, r.adjustIdx))}. Make an estimated payment of about <strong>${money(r.shortfall)}</strong> by January 15.</p></div>`
      : '';
  } else {
    const n = job.remaining;
    rec = `<div class="rec">${recHtml(r.thisYear, job, jobName(job, r.adjustIdx), `for the ${n} remaining paycheck${n === 1 ? '' : 's'}${job.remainingEstimated ? ' (estimated)' : ''}`)}</div>`;
  }

  // Next-year steady state: only worth showing when it differs from the catch-up figure.
  let next = '';
  if (job && r.nextYear && r.thisYear?.possible && !onTrack) {
    const ny = r.nextYear.rec;
    const nyOnTrack = Math.abs(r.nextYear.shortfall) <= tolerance;
    const differs = Math.abs(ny.step4c - r.thisYear.step4c) >= 5 || Math.abs(ny.step3Add - r.thisYear.step3Add) >= 50;
    if (differs) {
      const what = nyOnTrack
        ? 'your current W-4 would be about right'
        : ny.step3Add > 0
          ? `Step 4(c) should be $0 and Step 3 about ${usd.format(Math.floor(ny.step3Add))} higher than it is now`
          : `Step 4(c) should be about <strong>${perCheck(ny.step4c)}</strong> per paycheck`;
      next = `<div class="next">
        <h3>Revisit in January</h3>
        <p>The amount above is a catch-up for the rest of ${TAX_YEAR}. For a full year of your current paychecks (no bonuses), ${what}.</p>
      </div>`;
    }
  }

  const rows = [
    row('Total income', money(L.totalIncome)),
    row('Adjusted gross income', money(L.agi)),
    row(L.usesItemized ? 'Itemized deductions' : 'Standard deduction', `− ${money(L.usesItemized ? L.itemized : L.standard)}`),
    L.seniorDeduction > 0 ? row('Senior (65+) deduction', `− ${money(L.seniorDeduction)}`) : '',
    L.otherDeductions > 0 ? row('Other deductions', `− ${money(L.otherDeductions)}`) : '',
    row('Taxable income', money(L.taxable), 'sub'),
    row('Income tax', money(L.incomeTax)),
    L.credits > 0 ? row('Credits', `− ${money(L.credits)}`) : '',
    L.seTax > 0 ? row('Self-employment tax', money(L.seTax)) : '',
    L.addlMedicare > 0 ? row('Additional Medicare tax', money(L.addlMedicare)) : '',
    L.niit > 0 ? row('Net investment income tax', money(L.niit)) : '',
    row('Total federal tax', money(L.total), 'total'),
    row('Withholding (projected)', money(r.withheld)),
    r.addlMedicareWithheld > 0 ? row('Employer add\'l Medicare withheld', money(r.addlMedicareWithheld)) : '',
    r.estimated > 0 ? row('Estimated payments', money(r.estimated)) : '',
    row(owe ? 'Balance due' : 'Refund', money(Math.abs(r.balance)), 'total ' + (owe ? 'neg' : 'posv')),
  ].join('');

  let safe = '';
  if (r.safeHarbor && owe) {
    const s = r.safeHarbor;
    safe = s.met
      ? `<p class="note ok">No underpayment penalty expected: ${s.under1000 ? 'you would owe under $1,000' : `payments cover the safe harbor of ${money(s.required)}`}.</p>`
      : `<p class="note warn">Penalty risk: payments fall ${money(s.gap)} short of the safe harbor (${money(s.required)}, the lesser of 90% of this year's tax or ${Math.round(s.priorPct * 100)}% of last year's). Extra withholding counts as paid evenly through the year, so raising it now still fixes this.</p>`;
  }

  const unusedCredit = L.creditsUnused > 0.5
    ? `<p class="note">${money(L.creditsUnused)} of credits exceed your income tax. Part of the child tax credit may be refundable, which isn't modeled, so your refund may be higher.</p>`
    : '';

  resultsEl.innerHTML = `
    <h2>Your result</h2>
    ${status}
    ${rec}
    ${next}
    ${safe}
    <table class="breakdown">${rows}</table>
    <p class="rates">Marginal rate <strong>${pct(L.marginal)}</strong> · Effective rate <strong>${pct(L.effective)}</strong></p>
    ${unusedCredit}
  `;
}

// ---------- Colorado results

function renderColorado(fed, r) {
  const L = r.liability;
  if (fed.liability.totalIncome <= 0) {
    coResultsEl.innerHTML = `
      <h2>Colorado result</h2>
      <p class="muted">Enter your jobs and income on the Federal tab first. Colorado tax is computed from your federal taxable income.</p>`;
    return;
  }
  const owe = r.balance < 0;
  const tolerance = Math.max(25, L.total * 0.005);
  const onTrack = Math.abs(r.shortfall) <= tolerance;
  const status = owe
    ? `<p class="status owe">On your current Colorado withholding you'd <strong>owe about ${money(-r.balance)}</strong>.</p>`
    : `<p class="status refund">On your current Colorado withholding you'd get a <strong>refund of about ${money(r.balance)}</strong>.</p>`;

  const adj = r.jobs[r.adjustIdx];
  const name = adj ? jobName(adj.job, r.adjustIdx) : '';
  const inferred = adj && !Number.isFinite(adj.co.currentAllowance);
  const allowanceNote = (rec) => {
    if (!rec.allowanceChanged) return ` <span class="muted">(unchanged${inferred ? '; inferred from your paystub' : ''})</span>`;
    return inferred ? ` <span class="muted">(now about ${usd.format(Math.round(rec.currentAllowance / 10) * 10)}, inferred from your paystub)</span>` : ` <span class="muted">(now ${usd.format(rec.currentAllowance)})</span>`;
  };
  const dr0004 = (rec) => `
    <ul class="rec-list">
      <li>Annual withholding allowance: <strong class="big">${usd.format(Math.floor(rec.allowance))}</strong>${allowanceNote(rec)}</li>
      <li>Additional withholding per paycheck: <strong class="big">${perCheck(rec.extra)}</strong>${rec.currentExtra > 0 ? ` <span class="muted">(now ${usd2.format(rec.currentExtra)})</span>` : ''}</li>
    </ul>`;

  let rec = '';
  if (onTrack) {
    rec = `<div class="rec ok"><p class="rec-main"><strong>No change needed.</strong> You're within ${money(tolerance)} of your goal.</p></div>`;
  } else if (!adj) {
    rec = r.shortfall > 0 ? `<div class="rec"><p class="rec-main">With no job to adjust, cover the ${money(r.shortfall)} gap with Colorado estimated payments (DR 0104EP).</p></div>` : '';
  } else if (!r.thisYear.possible) {
    rec = r.shortfall > 0 ? `<div class="rec"><p class="rec-main">No paychecks left on ${esc(name)}. Make a Colorado estimated payment of about <strong>${money(r.shortfall)}</strong>.</p></div>` : '';
  } else {
    const t = r.thisYear;
    const n = adj.job.remaining;
    rec = `<div class="rec">
      <p class="rec-main">Give <strong>${esc(name)}</strong> a new <strong>DR 0004</strong> with:</p>
      ${dr0004(t)}
      <p class="muted">That's ${usd2.format(Math.abs(t.perPeriodChange))} ${t.perPeriodChange >= 0 ? 'more' : 'less'} Colorado tax withheld per paycheck for the ${n} remaining paycheck${n === 1 ? '' : 's'}${adj.job.remainingEstimated ? ' (estimated)' : ''}.</p>
      ${t.capped ? '<p class="warn">Even withholding nothing on this job leaves you over-withheld.</p>' : ''}
    </div>`;
  }

  let next = '';
  if (adj && r.nextYear?.rec.possible && !onTrack) {
    const ny = r.nextYear.rec;
    const t = r.thisYear;
    const differs = !t?.possible || Math.abs(ny.allowance - t.allowance) >= 100 || Math.abs(ny.extra - t.extra) >= 2;
    if (differs) {
      next = `<div class="next">
        <h3>Revisit in January</h3>
        <p>For a full year of your current paychecks (no bonuses), a DR 0004 with an allowance of about <strong>${usd.format(Math.floor(ny.allowance / 10) * 10)}</strong>${ny.extra >= 1 ? ` and <strong>${perCheck(ny.extra)}</strong> additional per paycheck` : ' and no additional withholding'} would land on your goal.</p>
      </div>`;
    }
  }

  const rows = [
    row('Federal taxable income', money(L.federalTaxable)),
    L.overtimeAddback > 0 ? row('+ Overtime add-back', money(L.overtimeAddback)) : '',
    L.stateTaxAddback > 0 ? row('+ State income tax add-back', money(L.stateTaxAddback)) : '',
    L.deductionAddback > 0 ? row('+ Deduction add-back (Prop MM)', money(L.deductionAddback)) : '',
    L.otherAdditions > 0 ? row('+ Other additions', money(L.otherAdditions)) : '',
    L.subtractions > 0 ? row('− Subtractions', money(L.subtractions)) : '',
    row('Colorado taxable income', money(L.taxable), 'sub'),
    row(`Tax at ${(L.rate * 100).toFixed(2)}%`, money(L.tax)),
    L.credits > 0 ? row('Credits', `− ${money(L.credits)}`) : '',
    row('Total Colorado tax', money(L.total), 'total'),
    row('Withholding (projected)', money(r.withheld)),
    r.estimated > 0 ? row('Estimated payments', money(r.estimated)) : '',
    row(owe ? 'Balance due' : 'Refund', money(Math.abs(r.balance)), 'total ' + (owe ? 'neg' : 'posv')),
  ].join('');

  const noWithholding = r.jobs.length && r.jobs.every((j) => !(j.co.withheldPerPeriod > 0) && !(j.co.ytdWithheld > 0));
  coResultsEl.innerHTML = `
    <h2>Colorado result</h2>
    ${noWithholding ? '<p class="note warn">No Colorado withholding entered yet. Add it for each job on the left.</p>' : ''}
    ${status}
    ${rec}
    ${next}
    <table class="breakdown">${rows}</table>
    <p class="note">With only a federal W-4 on file, employers withhold as if your allowance were ${usd.format(r.defaultAllowance)}. A DR 0004 overrides that.</p>
  `;
}

// ---------- wiring

function update() {
  const today = new Date();
  const isJoint = form.elements.filingStatus.value === 'mfj';
  document.body.classList.toggle('is-joint', isJoint);
  const status = form.elements.filingStatus.value;
  document.getElementById('std-ded').textContent = usd.format(TABLES.standardDeduction[status]);
  refreshJobHints(today);
  const input = readInput();
  const fed = project(input, today);
  render(input, fed);
  syncColoradoJobs(input.jobs, isJoint);
  renderColorado(fed, projectColorado(fed, status, readColorado()));
  save();
}

document.getElementById('add-job').addEventListener('click', () => {
  addJob().querySelector('input').focus();
  update();
});
document.getElementById('reset').addEventListener('click', () => {
  if (!confirm('Clear every input?')) return;
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  form.reset();
  coForm.reset();
  coJobState = {};
  coJobsSignature = '';
  jobsEl.innerHTML = '';
  addJob();
  update();
});
form.addEventListener('input', update);
form.addEventListener('change', update);
coForm.addEventListener('input', update);
coForm.addEventListener('change', update);

// ---------- tabs

const tabs = [...document.querySelectorAll('[role="tab"]')];
function showTab(name, focus = false) {
  for (const t of tabs) {
    const on = t.dataset.tab === name;
    t.setAttribute('aria-selected', on);
    t.tabIndex = on ? 0 : -1;
    document.getElementById(t.getAttribute('aria-controls')).hidden = !on;
    if (on && focus) t.focus();
  }
  const hash = name === 'co' ? '#colorado' : '#federal';
  if (location.hash !== hash) history.replaceState(null, '', hash);
}
for (const t of tabs) {
  t.addEventListener('click', () => showTab(t.dataset.tab));
  t.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.indexOf(t);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    showTab(next.dataset.tab, true);
  });
}
for (const b of document.querySelectorAll('[data-goto]')) {
  b.addEventListener('click', () => {
    showTab(b.dataset.goto, true);
    window.scrollTo({ top: 0 });
  });
}
window.addEventListener('hashchange', () => showTab(location.hash === '#colorado' ? 'co' : 'federal'));
showTab(location.hash === '#colorado' ? 'co' : 'federal');

for (const el of document.querySelectorAll('#tax-year, .ty')) el.textContent = TAX_YEAR;
load();
update();
