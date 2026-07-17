/**
 * Node smoke tests for calculator-core.js
 * Run: node js/calculator-core.test.js
 */
const C = require('./calculator-core.js');
let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log('  ✓', msg);
  } else {
    failed++;
    console.error('  ✗', msg);
  }
}

function approx(a, b, tol) {
  return Math.abs(a - b) <= (tol == null ? 1 : tol);
}

console.log('\nP&I formula');
const pmt = C.calculateMonthlyPayment(370000, 5.875, 30);
assert(approx(pmt, 2188.69, 0.5), '370k @ 5.875% 30yr ≈ $2,188.69 (got ' + pmt.toFixed(2) + ')');
assert(C.calculateMonthlyPayment(0, 5, 30) === 0, 'zero principal → 0');
assert(approx(C.calculateMonthlyPayment(120000, 0, 10), 1000, 0.01), '0% rate → principal/n');

console.log('\nEquity / LTV');
assert(C.equity(450000, 320000) === 130000, 'equity 450k-320k');
assert(approx(C.ltv(320000, 450000), 71.11, 0.1), 'LTV ~71%');
assert(C.ltv(100, 0) === 0, 'LTV home 0 → 0');

console.log('\nEscrow / P&I derivation');
assert(C.derivePi(2400, 350, 150, 0, true) === 1900, 'escrow included P&I');
assert(C.derivePi(1900, 350, 150, 0, false) === 1900, 'escrow not included P&I');
assert(C.totalHousingCost(1900, 350, 150, 0, false) === 2400, 'housing when escrow separate');
assert(C.totalHousingCost(2400, 350, 150, 0, true) === 2400, 'housing when escrow included');

console.log('\nCash at closing');
const debts = [
  { name: 'Current Mortgage', bal: 320000, pay: 1900, payOff: true },
  { name: 'Card', bal: 10000, pay: 300, payOff: true }
];
assert(C.cashAtClosing(360000, 320000, debts, 6000) === 24000, 'cash back with debts');
assert(C.cashAtClosing(320000, 320000, [], 6000) === -6000, 'cash to close rate-and-term');

console.log('\nMax loan LTV');
assert(C.maxLoanAmount(500000, [{ name: 'Card', payOff: true }]) === 400000, 'cash-out 80%');
assert(C.maxLoanAmount(500000, []) === 485000, 'rate-term 97%');

console.log('\nInterest remaining');
const keep = C.remainingInterest(320000, 6.75, 27);
const refi = C.totalInterestPaid(320000, 5.875, 30);
assert(keep > 0 && refi > 0, 'interest figures positive');
const cmp = C.mortgageInterestComparison(320000, 6.75, 27, 320000, 5.875, 30);
assert(typeof cmp.savings === 'number', 'interest comparison returns savings');

console.log('\nFull scenario consistency');
const s = C.computeScenario({
  homeValue: 450000,
  currentBalance: 320000,
  currentRate: 6.75,
  yearsRemaining: 27,
  totalPayment: 2400,
  taxes: 350,
  insurance: 150,
  pmi: 0,
  escrowIncluded: true,
  newLoanAmount: 326000,
  newRate: 5.875,
  newTerm: 30,
  closingCosts: 6000,
  debts: [{ name: 'Current Mortgage', bal: 320000, pay: 1900, payOff: true }]
});
assert(s.equity === 130000, 'scenario equity');
assert(s.oldPi === 1900, 'scenario old P&I');
assert(s.oldHousing === 2400, 'scenario old housing');
assert(s.newPi > 0 && s.newHousing > s.newPi, 'new housing includes escrow');
assert(s.cashAtClosing === 0, '326k - 320k - 6k costs = 0 cash');
assert(s.ltv === 71, 'scenario LTV rounded');
assert(s.breakEvenMonths == null || s.breakEvenMonths >= 0, 'break-even null or months');

const s2 = C.computeScenario({
  homeValue: 450000,
  currentBalance: 320000,
  currentRate: 6.75,
  yearsRemaining: 27,
  totalPayment: 2400,
  taxes: 350,
  insurance: 150,
  pmi: 0,
  escrowIncluded: true,
  newLoanAmount: 320000,
  newRate: 5.0,
  newTerm: 30,
  closingCosts: 6000,
  debts: []
});
assert(s2.monthlyCashFlowChange > 0, 'lower rate → positive cash flow');
assert(s2.breakEvenMonths > 0, 'positive savings → break-even months');

console.log('\nShorter term savings');
const short = C.shorterTermInterestSavings(320000, 5.875, 15);
assert(short != null && short > 0, '15yr saves vs 30yr');
assert(C.shorterTermInterestSavings(320000, 5.875, 30) === null, '30yr → null');

console.log('\nAmortization series');
const series = C.amortizationBalanceSeries(320000, 6.75, 27, 12);
assert(series.points.length > 5, 'yearly points exist');
assert(series.points[0].balance === 320000, 'starts at principal');
assert(series.points[series.points.length-1].balance < 1000, 'ends near zero (got '+series.points[series.points.length-1].balance+')');
assert(series.payment > 0, 'payment positive');

console.log('\nCanonical numbers');
const canon = C.buildCanonicalNumbers(s, { clientName: 'Test' });
assert(canon.currentPi === s.oldPi, 'canonical matches scenario');
assert(canon.cashAtClosingLabel === 'cash_back' || canon.cashAtClosingLabel === 'cash_to_close', 'cash label');

console.log('\nSize loan to cover + closing floor');
const sizeDebts = [
  { name: 'Current Mortgage', bal: 320000, pay: 1900, payOff: true },
  { name: 'Card', bal: 10000, pay: 300, rate: 22.9, months: 48, payOff: true }
];
const sized = C.sizeLoanToCover(320000, sizeDebts, 6000, 450000);
assert(sized.closingCostsUsed === 6000, 'uses entered closing costs');
assert(sized.needed === 336000, '320k + 10k + 6k costs');
assert(sized.target === 336000, 'under LTV cap → target = needed');
assert(sized.usedClosingFloor === false, 'not using floor when costs entered');
const sizedFloor = C.sizeLoanToCover(320000, sizeDebts, 0, 450000);
assert(sizedFloor.usedClosingFloor === true, 'blank costs → floor flag');
assert(sizedFloor.closingCostsUsed === 6000, 'floor is $6,000');
assert(sizedFloor.needed === 336000, 'floor still 320k+10k+6k');

console.log('\nDebt rate/term in interest avoided + canonical');
const withRates = C.computeScenario({
  homeValue: 450000,
  currentBalance: 320000,
  currentRate: 6.75,
  yearsRemaining: 27,
  totalPayment: 2400,
  taxes: 350,
  insurance: 150,
  pmi: 0,
  escrowIncluded: true,
  newLoanAmount: 336000,
  newRate: 5.875,
  newTerm: 30,
  closingCosts: 6000,
  debts: sizeDebts
});
assert(withRates.consumerDebtInterestAvoided > 0, 'interest avoided uses card rate/term');
const canonRates = C.buildCanonicalNumbers(withRates, { clientName: 'Test' });
const card = (canonRates.debts || []).find(function (d) { return d.name === 'Card'; });
assert(card && card.interestRate === 22.9, 'canonical debt rate passed');
assert(card && card.remainingMonths === 48, 'canonical debt term passed');
assert(card && card.interestAvoidedIfPaidOff > 0, 'per-debt interest avoided');
assert(canonRates.debtInsights && canonRates.debtInsights.highAprDebtsToHighlight.length >= 1, 'high APR insights');

console.log('\nScenario alternatives for AI');
const altPack = C.buildScenarioAlternatives({
  homeValue: 450000,
  currentBalance: 320000,
  currentRate: 6.75,
  yearsRemaining: 27,
  totalPayment: 2400,
  taxes: 350,
  insurance: 150,
  pmi: 0,
  escrowIncluded: true,
  newLoanAmount: 336000,
  newRate: 5.875,
  newTerm: 30,
  closingCosts: 6000,
  debts: sizeDebts
});
assert(altPack.alternatives && altPack.alternatives.length >= 2, 'at least primary + rate-and-term');
assert(altPack.alternatives.some(function (a) { return a.id === 'rate_and_term_only'; }), 'rate-and-term alt present');
assert(altPack.alternatives.some(function (a) { return a.id === 'primary'; }), 'primary alt present');
const rateTermAlt = altPack.alternatives.find(function (a) { return a.id === 'rate_and_term_only'; });
assert(rateTermAlt.otherDebtsPaidOff === 0, 'rate-and-term pays no consumer debts');
assert(typeof altPack.comparisonHints.bestMonthlyCashFlowId === 'string', 'comparison hint present');

console.log('\n────────────────────');
console.log(passed + ' passed,', failed + ' failed');
process.exit(failed ? 1 : 0);
