# W-4 Withholding Check

A static, client-side calculator that projects your 2026 federal tax from your paystubs and tells you what to put on a new Form W-4 (Step 4(c) extra withholding, or Step 3 if you're over-withheld) to hit a target refund.

Nothing leaves the browser. Inputs are saved to `localStorage` so you can come back later.

## Layout

- `site/` is the published website (`index.html`, `app.js` for the UI, `calc.js` for the tax math)
- `test/calc.test.js` has unit tests for the tax math (`npm test`, Node 18+)
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

Not modeled: state tax, refundable ACTC, EITC, QBI deduction, AMT, capital losses. Tax tables live in `TABLES` in `site/calc.js`; update them each year.
