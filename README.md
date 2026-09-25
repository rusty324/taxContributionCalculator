# Withholding Check

A static, client-side calculator that projects your 2026 federal and Colorado tax from your paystubs and tells you what to put on a new Form W-4 (Step 4(c) extra withholding, or Step 3 if you're over-withheld) and Colorado DR 0004 (annual withholding allowance and additional withholding) to hit a target refund.

Nothing leaves the browser. Inputs are saved to `localStorage` so you can come back later.

## Layout

- `site/` is the published website (`index.html`, `app.js` for the UI, `calc.js` for federal tax math, `colorado.js` for Colorado)
- `test/*.test.js` has unit tests for the tax math (`npm test`, Node 18+)
- `.github/workflows/pages.yml` runs the tests and then deploys `site/` to GitHub Pages on every push to `main`

## Enabling GitHub Pages

1. Merge to `main`.
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The site will be at `https://<user>.github.io/<repo>/`.

## Run locally

```sh
python3 -m http.server -d site 8000   # then open http://localhost:8000
npm test
```

ES modules don't load from `file://`, so opening `index.html` directly won't work.

## How the recommendation is computed

1. **Annual wages per job** = YTD federal taxable wages + (gross − pre-tax deductions) × remaining pay periods + remaining bonuses.
2. **Annual withholding per job** = YTD withheld + current per-check withholding × remaining periods + 22% of bonuses. Employer-withheld additional Medicare tax (0.9% over $200k per employer) counts as a payment.
3. **Tax**: 2026 brackets, standard/itemized deduction, 65+ extra standard deduction and senior deduction, 0/15/20% capital gains worksheet, child/other dependent credits with phase-out, SE tax, additional Medicare tax and NIIT.
4. **Shortfall** = tax + desired refund − projected payments, spread over the chosen job's remaining paychecks and added to its current Step 4(c). If that goes negative, 4(c) is zeroed and the rest becomes a Step 3 amount (the percentage method lowers withholding by Step 3 ÷ pay periods per year per check).
5. A **"revisit in January"** number reruns the same math for a full year of current paychecks, since a catch-up amount will over-withhold once the new year starts.

## Paystub scanning

Each job card has a **Scan a paystub** button (PDF or photo). `site/scan.js` loads pdf.js (legacy build, for older browsers) or Tesseract.js from jsDelivr on first use; `site/paystub.js` turns the extracted text into field values:

- Lines are split into label + amounts segments, so side-by-side columns work; the last two amounts are taken as current and YTD.
- Labels are matched against common provider wording (ADP, Workday, Paychex-style); FICA and Colorado FAMLI lines are excluded.
- Pre-tax deductions come from gross − federal taxable wages when available, else a Workday-style summary table, else a sum of 401(k)/HSA/medical/etc. lines.
- OCR repairs: O→0, l→1, dropped decimal points, split amounts. Impossible values (e.g. withholding ≥ gross) are dropped.
- Everything found is shown in a review panel with confidence badges; nothing is applied until the user confirms.

Test fixtures in `test/fixtures/` are synthetic stubs. Don't add real paystubs to the repo.

## Colorado tab

Colorado taxable income = federal taxable income + additions (2026 overtime add-back, state income tax add-back, Proposition MM deduction limit above $300k AGI, anything else you enter) − subtractions you enter, taxed at a flat 4.40%. Withholding follows DR 1098: `(annualized wages − annual withholding allowance) × 4.40% ÷ pay periods + additional withholding`. With only a W-4 on file employers use a $5,500 allowance ($11,000 MFJ). If you don't enter your current allowance, it's inferred from your paystub by inverting that formula.

Colorado FAMLI benefits (entered on the Federal tab) are added to federal income, any federal tax withheld from them counts as a payment, and they're subtracted automatically for Colorado. They're left out of the "revisit in January" projection since leave is usually a one-off.

The Colorado rules were checked against the official 2026 documents in `docs/reference/`: DR 1098 (withholding formula, default allowances), DR 0004 (Line 2/3, Table 1), the DR 0004 withholding calculator spreadsheet, and the January 2026 Individual Income Tax Guide (overtime add-back, Prop MM limits, QBI thresholds). `docs/` isn't published to Pages.

Federal items not modeled: state tax, refundable ACTC, EITC, QBI deduction, AMT, capital losses. Tax tables live in `TABLES` in `site/calc.js`; update them each year.
