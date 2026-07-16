/**
 * Ruoff Smart Savings Calculator — pure calculation engine
 * Source of truth for all money math. No DOM. Safe for unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RuoffCalc = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const DEFAULTS = {
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
    newRate: 5.875,
    newTerm: 30,
    closingCosts: 6000,
    debts: []
  };

  function roundMoney(n) {
    return Math.round((Number(n) || 0) * 100) / 100;
  }

  function roundDollar(n) {
    return Math.round(Number(n) || 0);
  }

  function clamp(n, min, max) {
    return Math.min(max, Math.max(min, n));
  }

  /** Standard amortizing monthly P&I payment */
  function calculateMonthlyPayment(principal, annualRate, years) {
    const p = Number(principal) || 0;
    if (p <= 0) return 0;
    const yearsNum = Number(years) || 0;
    if (yearsNum <= 0) return 0;
    const monthlyRate = (Number(annualRate) || 0) / 100 / 12;
    const numPayments = yearsNum * 12;
    if (monthlyRate <= 0) return p / numPayments;
    const power = Math.pow(1 + monthlyRate, numPayments);
    return p * monthlyRate * power / (power - 1);
  }

  /** Total interest paid over full amortizing loan life */
  function totalInterestPaid(principal, annualRate, years) {
    const p = Number(principal) || 0;
    const payment = calculateMonthlyPayment(p, annualRate, years);
    const n = (Number(years) || 0) * 12;
    if (n <= 0) return 0;
    return Math.max(0, payment * n - p);
  }

  /**
   * Remaining interest if balance amortizes at rate for remaining years.
   * Uses contractual P&I from balance/rate/term (not the escrowed total payment).
   */
  function remainingInterest(balance, annualRate, yearsRemaining) {
    return totalInterestPaid(balance, annualRate, yearsRemaining);
  }

  /** Months to amortize a debt given balance, rate, and fixed monthly payment */
  function monthsToPayOff(balance, annualRate, monthlyPayment) {
    const b = Number(balance) || 0;
    const pay = Number(monthlyPayment) || 0;
    if (b <= 0) return 0;
    if (pay <= 0) return Infinity;
    const r = (Number(annualRate) || 0) / 100 / 12;
    if (r <= 0) return Math.ceil(b / pay);
    if (pay <= b * r) return Infinity; // never pays down
    const n = -Math.log(1 - (b * r) / pay) / Math.log(1 + r);
    return Math.ceil(n);
  }

  /** Interest remaining on a consumer debt with fixed payment */
  function debtRemainingInterest(balance, annualRate, monthlyPayment, remainingMonths) {
    const b = Number(balance) || 0;
    const pay = Number(monthlyPayment) || 0;
    let months = Number(remainingMonths) || 0;
    if (months <= 0 && pay > 0) {
      months = monthsToPayOff(b, annualRate, pay);
    }
    if (!isFinite(months) || months <= 0) {
      // fallback: crude estimate
      return Math.max(0, pay * 12 * 5 - b);
    }
    const r = (Number(annualRate) || 0) / 100 / 12;
    let bal = b;
    let interest = 0;
    for (let i = 0; i < months && bal > 0.01; i++) {
      const int = bal * r;
      interest += int;
      const principal = Math.min(bal, pay - int);
      if (principal <= 0) {
        // payment doesn't cover interest
        interest += int * (months - i - 1);
        break;
      }
      bal -= principal;
    }
    return Math.max(0, interest);
  }

  function equity(homeValue, balance) {
    return Math.max(0, (Number(homeValue) || 0) - (Number(balance) || 0));
  }

  function ltv(balance, homeValue) {
    const h = Number(homeValue) || 0;
    if (h <= 0) return 0;
    return ((Number(balance) || 0) / h) * 100;
  }

  function derivePi(totalPayment, taxes, insurance, pmi, escrowIncluded) {
    const total = Number(totalPayment) || 0;
    const t = Number(taxes) || 0;
    const ins = Number(insurance) || 0;
    const p = Number(pmi) || 0;
    if (escrowIncluded) {
      return Math.max(0, total - t - ins - p);
    }
    return Math.max(0, total - p);
  }

  function totalHousingCost(totalPayment, taxes, insurance, pmi, escrowIncluded) {
    const total = Number(totalPayment) || 0;
    const t = Number(taxes) || 0;
    const ins = Number(insurance) || 0;
    if (escrowIncluded) return total;
    return total + t + ins;
  }

  function escrowMonthly(taxes, insurance, pmi) {
    return (Number(taxes) || 0) + (Number(insurance) || 0) + (Number(pmi) || 0);
  }

  /**
   * Rough PMI estimate if new LTV > 80%. Uses ~0.5% annual of loan / 12.
   * Returns 0 if LTV <= 80 or existing PMI should roll off.
   */
  function estimateNewPmi(newLoan, homeValue, annualFactor) {
    const factor = annualFactor == null ? 0.005 : annualFactor;
    const l = ltv(newLoan, homeValue);
    if (l <= 80) return 0;
    return (Number(newLoan) || 0) * factor / 12;
  }

  function hasCashOutDebts(debts) {
    return (debts || []).some(function (d) {
      return d.payOff && d.name !== 'Current Mortgage';
    });
  }

  /**
   * Max LTV: cash-out (other debts paid) 80%; rate-and-term conventional-style 97%.
   */
  function maxLtvRatio(debts) {
    return hasCashOutDebts(debts) ? 0.80 : 0.97;
  }

  function maxLoanAmount(homeValue, debts) {
    return Math.floor((Number(homeValue) || 0) * maxLtvRatio(debts));
  }

  function otherDebtsPaidOff(debts) {
    return (debts || []).reduce(function (sum, d) {
      if (d.payOff && d.name !== 'Current Mortgage') return sum + (Number(d.bal) || 0);
      return sum;
    }, 0);
  }

  function otherDebtMonthlyPayments(debts) {
    return (debts || []).reduce(function (sum, d) {
      if (d.payOff && d.name !== 'Current Mortgage') return sum + (Number(d.pay) || 0);
      return sum;
    }, 0);
  }

  function totalDebtsPaidOff(currentBalance, debts) {
    return (Number(currentBalance) || 0) + otherDebtsPaidOff(debts);
  }

  /**
   * Cash at closing (positive = cash back; negative = cash to close).
   * cashAtClosing = newLoan - mortgagePayoff - otherDebts - closingCosts
   */
  function cashAtClosing(newLoan, currentBalance, debts, closingCosts) {
    return (Number(newLoan) || 0)
      - (Number(currentBalance) || 0)
      - otherDebtsPaidOff(debts)
      - (Number(closingCosts) || 0);
  }

  /**
   * Lifetime interest: shorter new term vs 30-year same new loan (educational comparison).
   */
  function shorterTermInterestSavings(newLoan, newRate, newTerm) {
    const term = Number(newTerm) || 30;
    if (term >= 30) return null;
    const pi30 = calculateMonthlyPayment(newLoan, newRate, 30);
    const piShort = calculateMonthlyPayment(newLoan, newRate, term);
    return roundDollar(pi30 * 360 - piShort * term * 12);
  }

  /**
   * True keep-vs-refi mortgage interest comparison (ignores consumer debt).
   */
  function mortgageInterestComparison(currentBalance, currentRate, yearsRemaining, newLoan, newRate, newTerm) {
    const keepInterest = remainingInterest(currentBalance, currentRate, yearsRemaining);
    const refiInterest = totalInterestPaid(newLoan, newRate, newTerm);
    return {
      keepInterest: roundDollar(keepInterest),
      refiInterest: roundDollar(refiInterest),
      savings: roundDollar(keepInterest - refiInterest)
    };
  }

  /**
   * Interest avoided by paying off selected non-mortgage debts.
   */
  function consumerDebtInterestAvoided(debts) {
    return roundDollar((debts || []).reduce(function (sum, d) {
      if (!d.payOff || d.name === 'Current Mortgage') return sum;
      if (!(Number(d.rate) > 0) && !(Number(d.months) > 0)) return sum;
      return sum + debtRemainingInterest(d.bal, d.rate, d.pay, d.months);
    }, 0));
  }

  /**
   * Full scenario snapshot — single source for UI + AI prompts.
   */
  function computeScenario(input) {
    const s = Object.assign({}, DEFAULTS, input || {});
    s.debts = Array.isArray(s.debts) ? s.debts : [];
    s.closingCosts = Number(s.closingCosts) || 0;

    const home = Number(s.homeValue) || 0;
    const bal = Number(s.currentBalance) || 0;
    const currentEq = equity(home, bal);
    const currentLtv = ltv(bal, home);

    const oldPi = derivePi(s.totalPayment, s.taxes, s.insurance, s.pmi, s.escrowIncluded);
    const oldHousing = totalHousingCost(s.totalPayment, s.taxes, s.insurance, s.pmi, s.escrowIncluded);
    const oldEscrow = escrowMonthly(s.taxes, s.insurance, s.pmi);

    const newLoan = Number(s.newLoanAmount) || 0;
    const newRate = Number(s.newRate) || 0;
    const newTerm = Number(s.newTerm) || 30;
    const newPi = calculateMonthlyPayment(newLoan, newRate, newTerm);

    // Project PMI: if new LTV <= 80, PMI drops; else estimate if currently would need it
    const newPmi = estimateNewPmi(newLoan, home);
    const newEscrow = (Number(s.taxes) || 0) + (Number(s.insurance) || 0) + newPmi;
    const newHousing = newPi + newEscrow;

    const otherBal = otherDebtsPaidOff(s.debts);
    const otherPay = otherDebtMonthlyPayments(s.debts);
    const debtsTotal = bal + otherBal;

    // Old total monthly obligations (housing P&I path + selected debts)
    // Cash-flow change: (old housing + debt pays) - (new housing)
    // Using total housing (incl taxes/ins) on both sides for honesty.
    const oldMonthlyObligations = oldHousing + otherPay;
    const newMonthlyObligations = newHousing;
    const monthlyCashFlowChange = oldMonthlyObligations - newMonthlyObligations;

    // P&I-only delta (useful detail)
    const piOnlyChange = (oldPi + otherPay) - newPi;

    const cash = cashAtClosing(newLoan, bal, s.debts, s.closingCosts);
    const newEq = equity(home, newLoan);
    const newLtvPct = ltv(newLoan, home);
    const maxLoan = maxLoanAmount(home, s.debts);
    const cashOut = hasCashOutDebts(s.debts);

    const shorter = shorterTermInterestSavings(newLoan, newRate, newTerm);
    const mortInt = mortgageInterestComparison(
      bal, s.currentRate, s.yearsRemaining, newLoan, newRate, newTerm
    );
    const consumerInt = consumerDebtInterestAvoided(s.debts);

    // Break-even: months of positive cash flow to recover closing costs
    // Only meaningful when monthly cash flow improves
    let breakEvenMonths = null;
    if (monthlyCashFlowChange > 0 && s.closingCosts > 0) {
      breakEvenMonths = Math.ceil(s.closingCosts / monthlyCashFlowChange);
    } else if (monthlyCashFlowChange <= 0) {
      breakEvenMonths = null; // never breaks even on cash flow alone
    } else {
      breakEvenMonths = 0;
    }

    // Extra principal strategy: apply 50% of positive monthly savings to principal
    let halfSavingsPaydown = null;
    if (monthlyCashFlowChange > 0) {
      const extra = monthlyCashFlowChange / 2;
      const accelerated = simulatePaydown(newLoan, newRate, newTerm, extra);
      const baseline = {
        months: newTerm * 12,
        totalInterest: mortInt.refiInterest
      };
      halfSavingsPaydown = {
        extraMonthly: roundDollar(extra),
        months: accelerated.months,
        years: roundMoney(accelerated.months / 12),
        totalInterest: accelerated.totalInterest,
        interestSavedVsBaseline: roundDollar(baseline.totalInterest - accelerated.totalInterest),
        yearsSaved: roundMoney((baseline.months - accelerated.months) / 12)
      };
    }

    return {
      homeValue: home,
      currentBalance: bal,
      currentRate: Number(s.currentRate) || 0,
      yearsRemaining: Number(s.yearsRemaining) || 0,
      equity: roundDollar(currentEq),
      ltv: Math.round(currentLtv),
      ltvExact: roundMoney(currentLtv),

      oldPi: roundDollar(oldPi),
      oldHousing: roundDollar(oldHousing),
      oldEscrow: roundDollar(oldEscrow),
      escrowIncluded: !!s.escrowIncluded,
      taxes: Number(s.taxes) || 0,
      insurance: Number(s.insurance) || 0,
      pmi: Number(s.pmi) || 0,
      totalPayment: Number(s.totalPayment) || 0,

      newLoanAmount: newLoan,
      newRate: newRate,
      newTerm: newTerm,
      newPi: roundDollar(newPi),
      newPmi: roundDollar(newPmi),
      newEscrow: roundDollar(newEscrow),
      newHousing: roundDollar(newHousing),
      newEquity: roundDollar(newEq),
      newLtv: Math.round(newLtvPct),
      newLtvExact: roundMoney(newLtvPct),

      otherDebtsPaidOff: roundDollar(otherBal),
      otherDebtMonthly: roundDollar(otherPay),
      totalDebtsPaidOff: roundDollar(debtsTotal),
      closingCosts: roundDollar(s.closingCosts),
      cashAtClosing: roundDollar(cash),
      isCashBack: cash >= 0,

      monthlyCashFlowChange: roundDollar(monthlyCashFlowChange),
      piOnlyChange: roundDollar(piOnlyChange),
      oldMonthlyObligations: roundDollar(oldMonthlyObligations),
      newMonthlyObligations: roundDollar(newMonthlyObligations),

      breakEvenMonths: breakEvenMonths,
      shorterTermInterestSavings: shorter,
      mortgageInterest: mortInt,
      consumerDebtInterestAvoided: consumerInt,
      totalInterestPicture: roundDollar(mortInt.savings + consumerInt),

      halfSavingsPaydown: halfSavingsPaydown,

      maxLoanAmount: maxLoan,
      maxLtvPct: Math.round(maxLtvRatio(s.debts) * 100),
      isCashOutScenario: cashOut,
      overMaxLoan: newLoan > maxLoan,

      debts: s.debts
    };
  }

  /** Amortization with optional extra principal each month */
  function simulatePaydown(principal, annualRate, years, extraMonthly) {
    let bal = Number(principal) || 0;
    const scheduled = calculateMonthlyPayment(bal, annualRate, years);
    const r = (Number(annualRate) || 0) / 100 / 12;
    const extra = Number(extraMonthly) || 0;
    const maxMonths = (Number(years) || 0) * 12 + 600;
    let months = 0;
    let totalInterest = 0;
    while (bal > 0.01 && months < maxMonths) {
      const int = bal * r;
      totalInterest += int;
      let principalPaid = scheduled - int + extra;
      if (principalPaid <= 0) {
        // can't pay down
        return { months: Infinity, totalInterest: roundDollar(totalInterest) };
      }
      if (principalPaid > bal) principalPaid = bal;
      bal -= principalPaid;
      months++;
    }
    return { months: months, totalInterest: roundDollar(totalInterest) };
  }

  function formatMoney(n, opts) {
    const options = opts || {};
    const v = Number(n) || 0;
    const abs = Math.abs(v);
    const formatted = abs.toLocaleString(undefined, {
      maximumFractionDigits: options.cents ? 2 : 0,
      minimumFractionDigits: options.cents ? 2 : 0
    });
    if (options.signed) {
      return (v < 0 ? '-$' : '+$') + formatted;
    }
    if (v < 0) return '-$' + formatted;
    return '$' + formatted;
  }

  function applyPreset(preset, state) {
    const home = Number(state.homeValue) || 0;
    const bal = Number(state.currentBalance) || 0;
    const debts = state.debts || [];
    const costs = Number(state.closingCosts) || 6000;
    const other = otherDebtsPaidOff(debts);
    const rate = Number(state.newRate) || 5.875;
    const yearsRem = Number(state.yearsRemaining) || 27;

    switch (preset) {
      case 'rate-term': {
        // Pay off mortgage only + closing costs rolled in optionally
        const loan = Math.min(bal + costs, maxLoanAmount(home, debts.filter(function (d) {
          return d.name === 'Current Mortgage';
        })));
        return { newLoanAmount: roundDollar(loan), newTerm: Math.min(30, Math.max(10, Math.ceil(yearsRem))), newRate: rate };
      }
      case 'lower-payment': {
        const loan = Math.min(bal + costs, Math.floor(home * 0.97));
        return { newLoanAmount: roundDollar(loan), newTerm: 30, newRate: rate };
      }
      case 'shorten-term': {
        const loan = Math.min(bal + costs, Math.floor(home * 0.97));
        const term = yearsRem <= 15 ? 10 : 15;
        return { newLoanAmount: roundDollar(loan), newTerm: term, newRate: rate };
      }
      case 'debt-wipeout': {
        // Ensure all non-mortgage debts marked payoff in caller; size loan for all
        const needed = bal + other + costs;
        const max = Math.floor(home * 0.80);
        return { newLoanAmount: roundDollar(Math.min(needed, max)), newTerm: 30, newRate: rate, markAllDebtsPayoff: true };
      }
      case 'cash-project': {
        const targetCash = Number(state.projectCash) || 30000;
        const needed = bal + other + costs + targetCash;
        const max = Math.floor(home * 0.80);
        return { newLoanAmount: roundDollar(Math.min(needed, max)), newTerm: 30, newRate: rate };
      }
      default:
        return {};
    }
  }

  /** Canonical numbers blob for AI — model must not recalculate */
  function buildCanonicalNumbers(scenario, client) {
    const c = client || {};
    const s = scenario;
    return {
      clientName: c.clientName || 'Valued Client',
      clientEmail: c.clientEmail || '',
      clientPhone: c.clientPhone || '',
      clientNotes: c.clientNotes || '',
      homeValue: s.homeValue,
      currentBalance: s.currentBalance,
      currentRate: s.currentRate,
      yearsRemaining: s.yearsRemaining,
      currentEquity: s.equity,
      currentLtv: s.ltv,
      currentPi: s.oldPi,
      currentTotalHousing: s.oldHousing,
      currentEscrow: s.oldEscrow,
      taxes: s.taxes,
      insurance: s.insurance,
      currentPmi: s.pmi,
      newLoanAmount: s.newLoanAmount,
      newRate: s.newRate,
      newTerm: s.newTerm,
      newPi: s.newPi,
      newPmi: s.newPmi,
      newTotalHousing: s.newHousing,
      newEquity: s.newEquity,
      newLtv: s.newLtv,
      monthlyCashFlowChange: s.monthlyCashFlowChange,
      totalDebtsPaidOff: s.totalDebtsPaidOff,
      otherDebtsPaidOff: s.otherDebtsPaidOff,
      closingCosts: s.closingCosts,
      cashAtClosing: s.cashAtClosing,
      cashAtClosingLabel: s.isCashBack ? 'cash_back' : 'cash_to_close',
      breakEvenMonths: s.breakEvenMonths,
      keepMortgageInterest: s.mortgageInterest.keepInterest,
      refiMortgageInterest: s.mortgageInterest.refiInterest,
      mortgageInterestSavings: s.mortgageInterest.savings,
      consumerDebtInterestAvoided: s.consumerDebtInterestAvoided,
      shorterTermInterestSavings: s.shorterTermInterestSavings,
      halfSavingsPaydown: s.halfSavingsPaydown,
      maxLoanAmount: s.maxLoanAmount,
      isCashOutScenario: s.isCashOutScenario,
      debts: (s.debts || []).map(function (d) {
        return {
          name: d.name,
          balance: d.bal || 0,
          monthlyPayment: d.pay || 0,
          interestRate: d.rate || 0,
          remainingMonths: d.months || 0,
          payOff: !!d.payOff
        };
      })
    };
  }

  return {
    DEFAULTS: DEFAULTS,
    roundMoney: roundMoney,
    roundDollar: roundDollar,
    clamp: clamp,
    calculateMonthlyPayment: calculateMonthlyPayment,
    totalInterestPaid: totalInterestPaid,
    remainingInterest: remainingInterest,
    monthsToPayOff: monthsToPayOff,
    debtRemainingInterest: debtRemainingInterest,
    equity: equity,
    ltv: ltv,
    derivePi: derivePi,
    totalHousingCost: totalHousingCost,
    escrowMonthly: escrowMonthly,
    estimateNewPmi: estimateNewPmi,
    hasCashOutDebts: hasCashOutDebts,
    maxLtvRatio: maxLtvRatio,
    maxLoanAmount: maxLoanAmount,
    otherDebtsPaidOff: otherDebtsPaidOff,
    otherDebtMonthlyPayments: otherDebtMonthlyPayments,
    totalDebtsPaidOff: totalDebtsPaidOff,
    cashAtClosing: cashAtClosing,
    shorterTermInterestSavings: shorterTermInterestSavings,
    mortgageInterestComparison: mortgageInterestComparison,
    consumerDebtInterestAvoided: consumerDebtInterestAvoided,
    computeScenario: computeScenario,
    simulatePaydown: simulatePaydown,
    formatMoney: formatMoney,
    applyPreset: applyPreset,
    buildCanonicalNumbers: buildCanonicalNumbers
  };
});
