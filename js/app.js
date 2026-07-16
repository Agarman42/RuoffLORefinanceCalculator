/**
 * Ruoff Smart Savings Calculator — shared UI application
 * Mode: window.APP_MODE = 'lo' | 'borrower'
 */
(function () {
  'use strict';

  const C = window.RuoffCalc;
  if (!C) {
    console.error('RuoffCalc core not loaded');
    return;
  }

  const MODE = window.APP_MODE === 'borrower' ? 'borrower' : 'lo';
  const STORAGE_KEY = MODE === 'lo' ? 'ruoff.lo.calculator' : 'ruoff.borrower.calculator';
  const BRANDING_KEY = 'ruoff.lo.branding';
  const CLIENT_KEY = MODE === 'lo' ? 'ruoff.lo.client' : 'ruoff.borrower.client';
  const THEME_KEY = 'ruoffTheme';

  /**
   * Grok proxy — API key stays on Render (same pattern as LO / Realtor coaching tools).
   * Browser never sends a key; only POSTs model + messages to the proxy.
   *
   * Override options (no code change needed):
   *   window.RUOFF_GROK_URL = 'http://localhost:3000/grok'  // local server.js
   *   ?grokProxy=https://other.onrender.com/grok           // one-off URL override
   */
  const RENDER_GROK_PROXY = 'https://ruofflorefinancecalculator.onrender.com/grok';

  function getGrokEndpoint() {
    if (window.RUOFF_GROK_URL) return window.RUOFF_GROK_URL;
    try {
      const q = new URLSearchParams(window.location.search).get('grokProxy');
      if (q) return q;
    } catch (e) { /* ignore */ }

    const host = (window.location && window.location.hostname) || '';
    // Same-origin when this app IS the Render service (or local proxy server)
    if (host === 'localhost' || host === '127.0.0.1' || host.includes('ruofflorefinancecalculator.onrender.com')) {
      return '/grok';
    }
    // Static hosting / HubSpot / other domain → always hit Render proxy
    return RENDER_GROK_PROXY;
  }

  /** POST to Render (or local) Grok proxy — never attach Authorization from the browser */
  async function callGrokAPI(body) {
    const endpoint = getGrokEndpoint();
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      let detail = '';
      try {
        const errJson = await res.json();
        detail = (errJson && (errJson.error || errJson.message)) || '';
        if (typeof detail === 'object') detail = detail.message || JSON.stringify(detail);
      } catch (e) {
        detail = await res.text().catch(() => '');
      }
      throw new Error('Grok proxy ' + res.status + (detail ? ': ' + String(detail).slice(0, 200) : ''));
    }
    return res.json();
  }

  // ─── State ───────────────────────────────────────────────
  let state = {
    homeValue: C.DEFAULTS.homeValue,
    currentBalance: C.DEFAULTS.currentBalance,
    currentRate: C.DEFAULTS.currentRate,
    yearsRemaining: C.DEFAULTS.yearsRemaining,
    closingDate: '',
    totalPayment: C.DEFAULTS.totalPayment,
    taxes: C.DEFAULTS.taxes,
    insurance: C.DEFAULTS.insurance,
    pmi: C.DEFAULTS.pmi,
    escrowIncluded: true,
    newLoanAmount: C.DEFAULTS.newLoanAmount,
    newRate: C.DEFAULTS.newRate,
    newTerm: C.DEFAULTS.newTerm,
    closingCosts: C.DEFAULTS.closingCosts,
    projectCash: 30000,
    debts: [],
    client: { name: '', email: '', phone: '', notes: '' },
    branding: { name: '', nmls: '', email: '', cell: '' },
    loContact: { name: '', email: '', phone: '', nmls: '' } // borrower shared-link LO
  };

  let lastScenario = null;
  let mortgageModalSource = 'main';
  let editingDebtIndex = undefined;

  // ─── Helpers ─────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const money = (n, signed) => C.formatMoney(n, { signed: !!signed });

  function parseNum(val) {
    if (val == null || val === '') return 0;
    return parseFloat(String(val).replace(/[^0-9.\-]/g, '')) || 0;
  }

  function ensureMortgageDebt() {
    const pi = C.derivePi(state.totalPayment, state.taxes, state.insurance, state.pmi, state.escrowIncluded);
    let m = state.debts.find(d => d.name === 'Current Mortgage');
    if (!m) {
      m = { name: 'Current Mortgage', bal: state.currentBalance, pay: pi, rate: state.currentRate, months: state.yearsRemaining * 12, payOff: true };
      state.debts.unshift(m);
    } else {
      m.bal = state.currentBalance;
      m.pay = pi;
      m.rate = state.currentRate;
      m.months = state.yearsRemaining * 12;
      m.payOff = true;
    }
  }

  function readStateFromDom() {
    if ($('home-value')) state.homeValue = parseNum($('home-value').value) || state.homeValue;
    if ($('new-loan-amt')) state.newLoanAmount = parseNum($('new-loan-amt').value);
    if ($('new-rate')) state.newRate = parseNum($('new-rate').value);
    if ($('new-term')) state.newTerm = parseNum($('new-term').value) || 30;
    if ($('closing-costs')) state.closingCosts = parseNum($('closing-costs').value);
    if ($('project-cash')) state.projectCash = parseNum($('project-cash').value);
  }

  function collectClient() {
    return {
      clientName: ($('client-name') && $('client-name').value.trim()) || 'Valued Client',
      clientEmail: ($('client-email') && $('client-email').value.trim()) || '',
      clientPhone: ($('client-phone') && $('client-phone').value.trim()) || '',
      clientNotes: ($('client-notes') && $('client-notes').value.trim()) || ''
    };
  }

  function saveClient() {
    const c = {
      name: ($('client-name') && $('client-name').value) || '',
      email: ($('client-email') && $('client-email').value) || '',
      phone: ($('client-phone') && $('client-phone').value) || '',
      notes: ($('client-notes') && $('client-notes').value) || ''
    };
    state.client = c;
    try { localStorage.setItem(CLIENT_KEY, JSON.stringify(c)); } catch (e) {}
  }

  function loadClient() {
    try {
      const raw = localStorage.getItem(CLIENT_KEY);
      if (raw) {
        state.client = Object.assign(state.client, JSON.parse(raw));
      }
    } catch (e) {}
    if ($('client-name')) $('client-name').value = state.client.name || '';
    if ($('client-email')) $('client-email').value = state.client.email || '';
    if ($('client-phone')) $('client-phone').value = state.client.phone || '';
    if ($('client-notes')) $('client-notes').value = state.client.notes || '';
  }

  function saveBranding() {
    state.branding = {
      name: ($('branding-name') && $('branding-name').value.trim()) || '',
      nmls: ($('branding-nmls') && $('branding-nmls').value.trim()) || '',
      email: ($('branding-email') && $('branding-email').value.trim()) || '',
      cell: ($('branding-cell') && $('branding-cell').value.trim()) || ''
    };
    try { localStorage.setItem(BRANDING_KEY, JSON.stringify(state.branding)); } catch (e) {}
    toggleAccordion('branding-content', 'branding-chevron', false);
    toast('Branding saved — it will appear on plans and emails.');
  }

  function loadBranding() {
    try {
      const raw = localStorage.getItem(BRANDING_KEY);
      if (raw) state.branding = Object.assign(state.branding, JSON.parse(raw));
    } catch (e) {}
    if ($('branding-name')) $('branding-name').value = state.branding.name || '';
    if ($('branding-nmls')) $('branding-nmls').value = state.branding.nmls || '';
    if ($('branding-email')) $('branding-email').value = state.branding.email || '';
    if ($('branding-cell')) $('branding-cell').value = state.branding.cell || '';
  }

  function saveToStorage() {
    readStateFromDom();
    const payload = {
      homeValue: state.homeValue,
      currentBalance: state.currentBalance,
      currentRate: state.currentRate,
      yearsRemaining: state.yearsRemaining,
      closingDate: state.closingDate,
      totalPayment: state.totalPayment,
      taxes: state.taxes,
      insurance: state.insurance,
      pmi: state.pmi,
      escrowIncluded: state.escrowIncluded,
      newLoanAmount: state.newLoanAmount,
      newRate: state.newRate,
      newTerm: state.newTerm,
      closingCosts: state.closingCosts,
      projectCash: state.projectCash,
      debts: state.debts
    };
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(payload)); } catch (e) {}
  }

  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw);
      Object.keys(data).forEach(k => {
        if (k === 'debts') state.debts = data.debts || [];
        else if (data[k] !== undefined) state[k] = data[k];
      });
    } catch (e) {}
  }

  function parseLoFromUrl() {
    const params = new URLSearchParams(window.location.search);
    state.loContact = {
      name: params.get('loName') || params.get('lo') || '',
      email: params.get('loEmail') || params.get('email') || '',
      phone: params.get('loPhone') || params.get('phone') || '',
      nmls: params.get('loNmls') || params.get('nmls') || ''
    };
    // Fall back to branding if borrower opens LO's saved branding somehow — skip
    if (MODE === 'borrower' && $('lo-contact-banner')) {
      if (state.loContact.name || state.loContact.email) {
        $('lo-contact-banner').classList.remove('hidden');
        $('lo-contact-banner-text').textContent =
          'Working with ' + (state.loContact.name || 'your loan officer') +
          (state.loContact.nmls ? ' · NMLS ' + state.loContact.nmls : '');
      }
    }
  }

  function setResultsClientName(name) {
    const el = $('results-client-name');
    if (!el) return;
    const n = (name || '').trim();
    if (!n || n === 'Valued Client') {
      el.textContent = MODE === 'lo' ? 'Client' : '';
      return;
    }
    el.textContent = MODE === 'borrower' ? ' · ' + n : n;
  }

  function toast(msg) {
    const el = $('toast');
    if (!el) {
      alert(msg);
      return;
    }
    el.textContent = msg;
    el.classList.remove('hidden');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
  }

  function toggleAccordion(contentId, chevronId, forceOpen) {
    const content = $(contentId);
    const chevron = $(chevronId);
    if (!content) return;
    const open = forceOpen === true || (forceOpen !== false && (!content.style.maxHeight || content.style.maxHeight === '0px'));
    if (open) {
      content.style.maxHeight = content.scrollHeight + 'px';
      if (chevron) chevron.style.transform = 'rotate(180deg)';
    } else {
      content.style.maxHeight = '0px';
      if (chevron) chevron.style.transform = 'rotate(0deg)';
    }
  }

  // ─── Live update ─────────────────────────────────────────
  function liveUpdate() {
    readStateFromDom();
    ensureMortgageDebt();

    // Clamp loan to max if needed
    const maxLoan = C.maxLoanAmount(state.homeValue, state.debts);
    if (state.newLoanAmount > maxLoan) {
      state.newLoanAmount = maxLoan;
      if ($('new-loan-amt')) $('new-loan-amt').value = maxLoan;
    }

    const scenario = C.computeScenario({
      homeValue: state.homeValue,
      currentBalance: state.currentBalance,
      currentRate: state.currentRate,
      yearsRemaining: state.yearsRemaining,
      totalPayment: state.totalPayment,
      taxes: state.taxes,
      insurance: state.insurance,
      pmi: state.pmi,
      escrowIncluded: state.escrowIncluded,
      newLoanAmount: state.newLoanAmount,
      newRate: state.newRate,
      newTerm: state.newTerm,
      closingCosts: state.closingCosts,
      debts: state.debts
    });
    lastScenario = scenario;
    window.__lastScenario = scenario;

    // Sync sliders
    if ($('home-slider')) {
      $('home-slider').max = Math.max(3000000, state.homeValue);
      $('home-slider').value = state.homeValue;
    }
    if ($('home-display')) $('home-display').textContent = money(state.homeValue);
    if ($('new-loan-slider')) {
      $('new-loan-slider').max = maxLoan;
      $('new-loan-slider').min = Math.min(50000, maxLoan);
      $('new-loan-slider').value = Math.min(state.newLoanAmount, maxLoan);
    }
    if ($('new-rate-slider')) $('new-rate-slider').value = state.newRate;

    // Current situation
    setText('equity', money(scenario.equity));
    setText('ltv', scenario.ltv + '%');
    setText('summary-balance', money(scenario.currentBalance));
    setText('summary-total-pay', money(scenario.oldHousing));
    setText('summary-pi', money(scenario.oldPi));
    setText('summary-escrow', money(scenario.oldEscrow));

    // New scenario KPIs
    setText('new-pi-display', money(scenario.newPi));
    setText('new-housing-display', money(scenario.newHousing));
    setText('new-equity', money(scenario.newEquity));
    setText('new-ltv', scenario.newLtv + '%');

    // Cash flow
    const cf = scenario.monthlyCashFlowChange;
    const cfEl = $('monthly-cashflow');
    if (cfEl) {
      cfEl.textContent = (cf > 0 ? '+' : '') + money(cf);
      cfEl.className = 'text-3xl md:text-4xl font-black number ' + (cf >= 0 ? 'pos' : 'neg');
    }
    setText('monthly-cashflow-hint',
      cf >= 0
        ? 'More cash flow each month vs today'
        : 'Higher combined payment than today');

    setText('total-debts-paid', money(scenario.totalDebtsPaidOff));

    // Cash at closing
    const cashEl = $('cash-at-closing');
    const cashLabel = $('cash-at-closing-label');
    if (cashEl) {
      cashEl.textContent = money(Math.abs(scenario.cashAtClosing));
      if (scenario.isCashBack) {
        cashEl.className = 'text-3xl md:text-4xl font-black number';
        cashEl.style.color = '#F15A29';
        if (cashLabel) cashLabel.textContent = 'Est. cash back at closing';
      } else {
        cashEl.className = 'text-3xl md:text-4xl font-black number neg';
        cashEl.style.color = '';
        if (cashLabel) cashLabel.textContent = 'Est. cash to close';
      }
    }
    setText('closing-costs-note', 'After ' + money(scenario.closingCosts) + ' estimated closing costs');

    // Break-even
    const beEl = $('break-even');
    if (beEl) {
      if (scenario.breakEvenMonths == null) {
        beEl.textContent = cf <= 0 ? 'N/A' : '—';
        setText('break-even-hint', cf <= 0 ? 'Needs positive monthly savings' : '');
      } else {
        beEl.textContent = scenario.breakEvenMonths + ' mo';
        setText('break-even-hint', 'Closing costs recovered via monthly savings');
      }
    }

    // Interest comparison
    const mi = scenario.mortgageInterest;
    const intEl = $('interest-comparison');
    if (intEl) {
      if (mi.savings >= 0) {
        intEl.innerHTML = '<span class="pos">' + money(mi.savings) + '</span> less interest vs keeping current loan';
      } else {
        intEl.innerHTML = '<span class="neg">' + money(Math.abs(mi.savings)) + '</span> more interest vs keeping current loan';
      }
    }

    // Shorter term card
    const shortEl = $('shorter-term-savings');
    if (shortEl) {
      if (scenario.shorterTermInterestSavings != null) {
        shortEl.innerHTML =
          '<div class="text-xs tracking-widest opacity-70 mb-1">VS 30-YEAR AT THIS RATE</div>' +
          '<div class="text-3xl font-black pos number">' + money(scenario.shorterTermInterestSavings) + '</div>' +
          '<div class="text-sm opacity-75 mt-1">lifetime interest saved with ' + scenario.newTerm + '-year term</div>';
      } else {
        shortEl.innerHTML =
          '<div class="text-xs tracking-widest opacity-70 mb-1">TERM COMPARISON</div>' +
          '<div class="text-lg font-semibold opacity-70">Choose a term under 30 years to compare lifetime interest</div>';
      }
    }

    // Half savings paydown
    const halfEl = $('half-savings-tip');
    if (halfEl) {
      if (scenario.halfSavingsPaydown) {
        const h = scenario.halfSavingsPaydown;
        halfEl.innerHTML =
          'If you apply <strong>' + money(h.extraMonthly) + '/mo</strong> (half of your savings) to principal, ' +
          'you could finish ~<strong>' + h.yearsSaved + ' years sooner</strong> and save about <strong>' +
          money(h.interestSavedVsBaseline) + '</strong> more in interest.';
        halfEl.classList.remove('hidden');
      } else {
        halfEl.classList.add('hidden');
      }
    }

    // Loan limit warning
    const warn = $('loan-limit-warning');
    if (warn) {
      if (scenario.isCashOutScenario || scenario.overMaxLoan) {
        warn.classList.remove('hidden');
        setText('warning-text',
          (scenario.isCashOutScenario ? 'Cash-out / debt consolidation limited to ' : 'Loan amount limited to ') +
          scenario.maxLtvPct + '% LTV (' + money(scenario.maxLoanAmount) + ')');
      } else {
        warn.classList.add('hidden');
      }
    }

    // Sticky bar (mobile)
    if ($('sticky-cashflow')) {
      $('sticky-cashflow').textContent = (cf > 0 ? '+' : '') + money(cf);
      $('sticky-cashflow').className = 'font-black number ' + (cf >= 0 ? 'pos' : 'neg');
    }
    if ($('sticky-cash')) {
      $('sticky-cash').textContent = (scenario.isCashBack ? 'Back ' : 'To close ') + money(Math.abs(scenario.cashAtClosing));
    }

    saveToStorage();
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  // ─── Inputs ──────────────────────────────────────────────
  function formatHomeValue() {
    const raw = parseNum($('home-value').value);
    state.homeValue = raw || state.homeValue;
    $('home-value').value = state.homeValue.toLocaleString();
    liveUpdate();
  }

  function syncHomeSlider() {
    state.homeValue = parseNum($('home-slider').value);
    $('home-value').value = state.homeValue.toLocaleString();
    liveUpdate();
  }

  function syncNewLoanSlider() {
    state.newLoanAmount = parseNum($('new-loan-slider').value);
    $('new-loan-amt').value = state.newLoanAmount;
    liveUpdate();
  }

  function syncNewRateSlider() {
    state.newRate = parseNum($('new-rate-slider').value);
    $('new-rate').value = state.newRate;
    liveUpdate();
  }

  function applyPreset(name) {
    readStateFromDom();
    if ($('project-cash')) state.projectCash = parseNum($('project-cash').value) || 30000;
    if (name === 'debt-wipeout') {
      state.debts.forEach(d => { d.payOff = true; });
    }
    const patch = C.applyPreset(name, state);
    if (patch.newLoanAmount != null) {
      state.newLoanAmount = patch.newLoanAmount;
      if ($('new-loan-amt')) $('new-loan-amt').value = patch.newLoanAmount;
    }
    if (patch.newTerm != null) {
      state.newTerm = patch.newTerm;
      if ($('new-term')) $('new-term').value = String(patch.newTerm);
    }
    if (patch.newRate != null) {
      state.newRate = patch.newRate;
      if ($('new-rate')) $('new-rate').value = patch.newRate;
    }
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-preset') === name);
    });
    liveUpdate();
    toast('Applied “' + name.replace(/-/g, ' ') + '” preset — fine-tune as needed.');
  }

  // ─── Mortgage modal ──────────────────────────────────────
  function openMortgageModal(fromDebts) {
    mortgageModalSource = fromDebts ? 'debts' : 'main';
    $('modal-balance').value = state.currentBalance;
    if ($('balance-slider')) $('balance-slider').value = state.currentBalance;
    $('total-payment').value = state.totalPayment;
    $('taxes').value = state.taxes;
    $('insurance').value = state.insurance;
    $('pmi').value = state.pmi;
    $('escrow-included').checked = state.escrowIncluded;
    if ($('current-rate')) $('current-rate').value = state.currentRate;
    if ($('years-remaining')) $('years-remaining').value = state.yearsRemaining;
    if ($('closing-date')) $('closing-date').value = state.closingDate || '';
    updateMortgageModal();
    $('mortgage-modal').classList.remove('hidden');
    if (fromDebts) $('debts-modal').classList.add('hidden');
  }

  function closeMortgageModal() {
    try {
      state.currentBalance = parseNum($('modal-balance').value) || state.currentBalance;
      state.totalPayment = parseNum($('total-payment').value) || state.totalPayment;
      state.taxes = parseNum($('taxes').value);
      state.insurance = parseNum($('insurance').value);
      state.pmi = parseNum($('pmi').value);
      state.escrowIncluded = $('escrow-included').checked;
      state.currentRate = parseNum($('current-rate').value) || state.currentRate;
      state.yearsRemaining = parseNum($('years-remaining').value) || state.yearsRemaining;
      state.closingDate = $('closing-date') ? $('closing-date').value : '';
      ensureMortgageDebt();
      saveToStorage();
      $('mortgage-modal').classList.add('hidden');
      liveUpdate();
      if (mortgageModalSource === 'debts') {
        setTimeout(openDebtsModal, 200);
      }
    } catch (e) {
      console.error(e);
      $('mortgage-modal').classList.add('hidden');
    }
  }

  function updateMortgageModal() {
    const isIncluded = $('escrow-included').checked;
    const totalToLender = parseNum($('total-payment').value);
    const taxesVal = parseNum($('taxes').value);
    const insuranceVal = parseNum($('insurance').value);
    const pmiVal = parseNum($('pmi').value);
    const pi = C.derivePi(totalToLender, taxesVal, insuranceVal, pmiVal, isIncluded);
    const housing = C.totalHousingCost(totalToLender, taxesVal, insuranceVal, pmiVal, isIncluded);
    $('taxes').disabled = isIncluded;
    $('insurance').disabled = isIncluded;
    setText('modal-pi', money(pi));
    setText('modal-total-housing', money(housing));
  }

  function syncBalanceSlider() {
    $('modal-balance').value = $('balance-slider').value;
    updateMortgageModal();
  }

  // ─── Debts ───────────────────────────────────────────────
  function openDebtsModal() {
    ensureMortgageDebt();
    renderDebts();
    $('debts-modal').classList.remove('hidden');
  }

  function closeDebtsModal() {
    saveToStorage();
    $('debts-modal').classList.add('hidden');
    liveUpdate();
  }

  function switchToMortgageModal() {
    closeDebtsModal();
    setTimeout(() => openMortgageModal(true), 250);
  }

  function renderDebts() {
    const container = $('debts-list');
    if (!container) return;
    container.innerHTML = '';
    let totalMonthly = 0;
    let totalPayoff = 0;

    state.debts.forEach((d, i) => {
      if (d.name === 'Current Mortgage') {
        d.payOff = true;
        d.bal = state.currentBalance;
        d.pay = C.derivePi(state.totalPayment, state.taxes, state.insurance, state.pmi, state.escrowIncluded);
      }
      if (d.payOff) {
        totalMonthly += Number(d.pay) || 0;
        totalPayoff += Number(d.bal) || 0;
      }

      const isMortgage = d.name === 'Current Mortgage';
      const row = document.createElement('div');
      row.className = 'glass rounded-2xl p-5 flex flex-col sm:flex-row gap-4 items-start ' +
        (isMortgage ? 'opacity-90 border border-zinc-300 dark:border-white/10' : '');

      row.innerHTML =
        '<div class="flex-1 min-w-0 w-full">' +
          '<div class="text-lg font-semibold">' + escapeHtml(d.name) + '</div>' +
          '<div class="grid grid-cols-2 gap-4 mt-3">' +
            '<div><div class="text-xs opacity-60">BALANCE</div><div class="text-xl font-black number">' + money(d.bal) + '</div></div>' +
            '<div><div class="text-xs opacity-60">MONTHLY</div><div class="text-xl font-black number">' + money(d.pay) + '</div></div>' +
          '</div>' +
          (d.rate ? '<div class="text-xs opacity-60 mt-2">' + d.rate + '% interest' + (d.months ? ' · ' + d.months + ' mo left' : '') + '</div>' : '') +
        '</div>' +
        '<div class="flex sm:flex-col items-center sm:items-end gap-3">' +
          (isMortgage
            ? '<div class="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><i class="fas fa-lock"></i> Always paid off</div>'
            : '<label class="debt-toggle"><input type="checkbox" data-debt-toggle="' + i + '" ' + (d.payOff ? 'checked' : '') + '><span class="debt-toggle-slider"></span></label>') +
          (isMortgage
            ? '<button type="button" class="text-[var(--ruoff-teal)] text-xl px-2" data-edit-mortgage><i class="fas fa-pencil-alt"></i></button>'
            : '<button type="button" class="text-[var(--ruoff-teal)] text-xl px-2" data-edit-debt="' + i + '"><i class="fas fa-pencil-alt"></i></button>') +
          (!isMortgage ? '<button type="button" class="text-red-400 text-xl px-2" data-remove-debt="' + i + '"><i class="fas fa-trash"></i></button>' : '') +
        '</div>';

      container.appendChild(row);
    });

    container.querySelectorAll('[data-debt-toggle]').forEach(el => {
      el.addEventListener('change', () => {
        const i = parseInt(el.getAttribute('data-debt-toggle'), 10);
        state.debts[i].payOff = el.checked;
        renderDebts();
        liveUpdate();
      });
    });
    container.querySelectorAll('[data-edit-debt]').forEach(el => {
      el.addEventListener('click', () => editDebt(parseInt(el.getAttribute('data-edit-debt'), 10)));
    });
    container.querySelectorAll('[data-remove-debt]').forEach(el => {
      el.addEventListener('click', () => {
        removeDebt(parseInt(el.getAttribute('data-remove-debt'), 10));
      });
    });
    container.querySelectorAll('[data-edit-mortgage]').forEach(el => {
      el.addEventListener('click', switchToMortgageModal);
    });

    setText('modal-total-monthly', money(totalMonthly));
    setText('modal-total-payoff', money(totalPayoff));
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function openAddDebtModal() {
    if (editingDebtIndex === undefined) {
      $('new-debt-name').value = 'New Debt';
      $('new-debt-balance').value = '0';
      $('new-debt-pay').value = '0';
      $('new-debt-rate').value = '0';
      $('new-debt-months').value = '0';
      const type = $('new-debt-type');
      if (type) type.value = '';
      const btn = $('add-debt-submit');
      if (btn) btn.textContent = 'Add Debt';
    }
    $('add-debt-modal').classList.remove('hidden');
    setTimeout(() => $('new-debt-name').focus(), 80);
  }

  function closeAddDebtModal() {
    $('add-debt-modal').classList.add('hidden');
    editingDebtIndex = undefined;
  }

  function addNewDebt() {
    const type = $('new-debt-type') ? $('new-debt-type').value : '';
    let name = ($('new-debt-name').value || '').trim() || 'New Debt';
    if (type && name === 'New Debt') name = type;
    const bal = parseNum($('new-debt-balance').value);
    const pay = parseNum($('new-debt-pay').value);
    const rate = parseNum($('new-debt-rate').value);
    const months = parseNum($('new-debt-months').value);

    if (editingDebtIndex !== undefined) {
      const prev = state.debts[editingDebtIndex];
      state.debts[editingDebtIndex] = { name, bal, pay, rate, months, payOff: prev.payOff !== false };
      editingDebtIndex = undefined;
    } else {
      state.debts.push({ name, bal, pay, rate, months, payOff: true });
    }
    closeAddDebtModal();
    renderDebts();
    liveUpdate();
    saveToStorage();
  }

  function editDebt(i) {
    const d = state.debts[i];
    if (!d || d.name === 'Current Mortgage') return;
    editingDebtIndex = i;
    $('new-debt-name').value = d.name || '';
    $('new-debt-balance').value = d.bal || 0;
    $('new-debt-pay').value = d.pay || 0;
    $('new-debt-rate').value = d.rate || 0;
    $('new-debt-months').value = d.months || 0;
    const btn = $('add-debt-submit');
    if (btn) btn.textContent = 'Save Changes';
    openAddDebtModal();
  }

  function removeDebt(i) {
    if (state.debts[i] && state.debts[i].name === 'Current Mortgage') return;
    state.debts.splice(i, 1);
    renderDebts();
    liveUpdate();
  }

  function clearAllData() {
    if (!confirm('Clear all calculator data and reset to defaults?')) return;
    localStorage.removeItem(STORAGE_KEY);
    state = Object.assign(state, {
      homeValue: C.DEFAULTS.homeValue,
      currentBalance: C.DEFAULTS.currentBalance,
      currentRate: C.DEFAULTS.currentRate,
      yearsRemaining: C.DEFAULTS.yearsRemaining,
      totalPayment: C.DEFAULTS.totalPayment,
      taxes: C.DEFAULTS.taxes,
      insurance: C.DEFAULTS.insurance,
      pmi: C.DEFAULTS.pmi,
      escrowIncluded: true,
      newLoanAmount: C.DEFAULTS.newLoanAmount,
      newRate: C.DEFAULTS.newRate,
      newTerm: C.DEFAULTS.newTerm,
      closingCosts: C.DEFAULTS.closingCosts,
      debts: []
    });
    hydrateDomFromState();
    closeDebtsModal();
    liveUpdate();
  }

  // ─── Detail modals ───────────────────────────────────────
  function showCashFlowModal() {
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const html =
      '<div class="space-y-4 text-base">' +
      row('Current total housing', money(s.oldHousing)) +
      row('Other debts being paid off (monthly)', money(s.otherDebtMonthly)) +
      row('Old combined obligations', money(s.oldMonthlyObligations), true) +
      row('New P&I', money(s.newPi)) +
      row('New taxes + ins + est. PMI', money(s.newEscrow)) +
      row('New total housing', money(s.newHousing), true) +
      '<div class="pt-4 border-t border-white/20 flex justify-between text-2xl font-black">' +
        '<span>Monthly cash-flow change</span><span class="' + (s.monthlyCashFlowChange >= 0 ? 'pos' : 'neg') + '">' +
        (s.monthlyCashFlowChange >= 0 ? '+' : '') + money(s.monthlyCashFlowChange) + '</span></div>' +
      '<p class="text-sm opacity-70 mt-2">Includes estimated housing costs on both sides. Consumer debt payments stop only for debts marked “pay off with refi.”</p>' +
      '</div>';
    showDetailModal('Monthly cash-flow change', html);
  }

  function showDebtsPaidModal() {
    if (!lastScenario) liveUpdate();
    let items = '';
    let total = 0;
    state.debts.forEach(d => {
      if (!d.payOff) return;
      total += Number(d.bal) || 0;
      items += '<div class="flex justify-between py-2 border-b border-white/10"><span>' + escapeHtml(d.name) +
        '</span><span class="font-bold number">' + money(d.bal) + '</span></div>';
    });
    if (!items) items = '<p class="opacity-60">No debts selected.</p>';
    showDetailModal('Debts paid off in this scenario', items +
      '<div class="flex justify-between text-2xl font-black mt-4"><span>Total</span><span>' + money(total) + '</span></div>');
  }

  function showCashClosingModal() {
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const html =
      row('New loan amount', money(s.newLoanAmount)) +
      row('Current mortgage payoff', '−' + money(s.currentBalance)) +
      row('Other debts paid off', '−' + money(s.otherDebtsPaidOff)) +
      row('Estimated closing costs', '−' + money(s.closingCosts)) +
      '<div class="pt-4 border-t border-white/20 flex justify-between text-2xl font-black">' +
        '<span>' + (s.isCashBack ? 'Cash you receive' : 'Cash to close') + '</span>' +
        '<span class="' + (s.isCashBack ? '' : 'neg') + '" style="' + (s.isCashBack ? 'color:#F15A29' : '') + '">' +
        money(Math.abs(s.cashAtClosing)) + '</span></div>' +
      '<p class="text-sm opacity-70 mt-3">Closing costs are an estimate and can be edited on the main screen. Prepaid interest and escrow deposits may change cash to close.</p>';
    showDetailModal('Cash at closing', html);
  }

  function showInterestModal() {
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const mi = s.mortgageInterest;
    let html =
      '<p class="text-sm opacity-75 mb-4">Comparing interest if you keep your current mortgage vs the proposed loan (using your current rate and years remaining).</p>' +
      row('Interest left on current loan', money(mi.keepInterest)) +
      row('Interest on new loan', money(mi.refiInterest)) +
      row('Mortgage interest difference', money(mi.savings), true) +
      row('Consumer debt interest avoided (est.)', money(s.consumerDebtInterestAvoided));

    html += '<div class="mt-6 space-y-3">';
    [25, 20, 15, 10].forEach(term => {
      const pi = C.calculateMonthlyPayment(s.newLoanAmount, s.newRate, term);
      const pi30 = C.calculateMonthlyPayment(s.newLoanAmount, s.newRate, 30);
      const saved = Math.round(pi30 * 360 - pi * term * 12);
      const increase = Math.round(pi - pi30);
      html += '<div class="flex justify-between glass p-4 rounded-xl">' +
        '<div><div class="font-bold">' + term + '-year term</div><div class="text-sm opacity-70">' + money(pi) + ' /mo P&I</div></div>' +
        '<div class="text-right"><div class="font-black pos">Save ' + money(saved) + '</div>' +
        '<div class="text-xs opacity-60">+' + money(increase) + '/mo vs 30yr</div></div></div>';
    });
    html += '</div>';
    showDetailModal('Interest comparison', html);
  }

  function row(label, value, strong) {
    return '<div class="flex justify-between py-2 ' + (strong ? 'font-bold text-lg' : '') + '"><span class="opacity-80">' +
      label + '</span><span class="number">' + value + '</span></div>';
  }

  function showDetailModal(title, bodyHtml) {
    $('detail-title').textContent = title;
    $('detail-body').innerHTML = bodyHtml;
    $('detail-modal').classList.remove('hidden');
  }

  function closeDetailModal() {
    $('detail-modal').classList.add('hidden');
  }

  function showHelp(title, content) {
    $('help-title').textContent = title;
    $('help-content').innerHTML = content;
    $('help-modal').classList.remove('hidden');
  }

  function closeHelp() {
    $('help-modal').classList.add('hidden');
  }

  // ─── AI plan generation ──────────────────────────────────
  async function generateSmartPlan() {
    if (!lastScenario) liveUpdate();
    const modal = $('loading-modal');
    if (modal) modal.classList.remove('hidden');

    const client = collectClient();
    saveClient();
    const numbers = C.buildCanonicalNumbers(lastScenario, client);
    window.clientCalcData = numbers;
    window.__canonicalNumbers = numbers;

    const branding = state.branding;
    const isLo = MODE === 'lo';

    const systemRules =
      'You are the Refinance Strategist for Ruoff Mortgage. ' +
      'CRITICAL: A JSON object of CANONICAL NUMBERS is provided. Use ONLY those numbers for every figure. ' +
      'Do not recalculate payments, interest, LTV, cash back, or break-even. ' +
      'If a value is null, say it is not applicable. ' +
      'Never use emojis. Return ONLY valid JSON. Use semantic HTML in string values: h2,h3,p,ul,li,table,strong,em.';

    let outputSchema;
    let sectionInstructions;

    if (isLo) {
      outputSchema = '{ "executiveSummary": "...", "scenarioComparison": "...", "recommendedPlan": "...", "salesScripts": "...", "followUpSequence": "..." }';
      sectionInstructions =
        'executiveSummary: Client-facing. Warm headline, biggest wins using canonical numbers, before/after table, break-even, half-savings principal tip if present, LO contact.\n' +
        'scenarioComparison: HTML table Current vs Proposed using only canonical numbers; 2-3 short takeaways.\n' +
        'recommendedPlan: Step plan with exact loan amount/rate/term from numbers; risks; timeline.\n' +
        'salesScripts: 5 natural phone/email scripts using the real monthly cash-flow and cash-at-closing figures.\n' +
        'followUpSequence: 30-day Day 1/3/7/14/30 touchpoints with full copy.\n' +
        'LO Profile: ' + (branding.name || 'Loan Officer') + ', NMLS ' + (branding.nmls || '—') +
        ', ' + (branding.cell || '') + ', ' + (branding.email || '');
    } else {
      outputSchema = '{ "summary": "...", "scenarioComparison": "...", "recommendedPlan": "..." }';
      sectionInstructions =
        'summary: Warm, trustworthy borrower summary. Great News headline. Use canonical numbers only. Before/after. Soft CTA to contact LO.\n' +
        'scenarioComparison: Clean HTML comparison table. Break-even and interest figures from canonical numbers.\n' +
        'recommendedPlan: Clear recommendation; respect years remaining (' + numbers.yearsRemaining +
        ') — do not extend term beyond it without explaining trade-off; list debts to pay off.';
    }

    const prompt =
      systemRules + '\n\nOUTPUT JSON SHAPE:\n' + outputSchema + '\n\nSECTION RULES:\n' + sectionInstructions +
      '\n\nCANONICAL NUMBERS (source of truth):\n' + JSON.stringify(numbers, null, 2);

    try {
      $('results-area').classList.remove('hidden');
      $('tab-content').innerHTML =
        '<div class="text-center py-24"><i class="fas fa-spinner fa-spin text-5xl text-[var(--ruoff-teal)]"></i>' +
        '<p class="mt-6 text-xl">Building your Smart Plan from the calculated numbers...</p></div>';

      const data = await callGrokAPI({
        model: 'grok-4-1-fast-reasoning',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.5,
        max_tokens: isLo ? 5500 : 4500
      });
      if (data.error) throw new Error(data.error.message || data.error || 'API error');

      let raw = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
      raw = raw.trim().replace(/^```json\s*/i, '').replace(/```\s*$/i, '').trim();
      // Try to extract JSON object if model added prose
      const brace = raw.indexOf('{');
      const lastBrace = raw.lastIndexOf('}');
      if (brace >= 0 && lastBrace > brace) raw = raw.slice(brace, lastBrace + 1);

      const planData = JSON.parse(raw);

      if (isLo) {
        window.currentPlan = {
          tabs: [
            planData.executiveSummary || '<p>Error loading Executive Summary</p>',
            planData.scenarioComparison || '<p>Error loading Scenario Comparison</p>',
            planData.recommendedPlan || '<p>Error loading Recommended Plan</p>',
            planData.salesScripts || '<p>Error loading Sales Scripts</p>',
            planData.followUpSequence || '<p>Error loading Follow-Up Sequence</p>'
          ]
        };
      } else {
        window.currentPlan = {
          tabs: [
            planData.summary || '<p>Error loading Summary</p>',
            planData.scenarioComparison || '<p>Error loading Scenario Comparison</p>',
            planData.recommendedPlan || '<p>Error loading Recommended Plan</p>'
          ]
        };
      }

      setResultsClientName(client.clientName);
      showTab(0);
      $('results-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      console.error(e);
      // Offline / API-down fallback: deterministic plan from numbers
      window.currentPlan = { tabs: buildFallbackPlan(numbers, isLo) };
      setResultsClientName(numbers.clientName);
      showTab(0);
      toast('AI unavailable — showing calculated plan summary instead. (' + (e.message || 'error') + ')');
    } finally {
      if (modal) modal.classList.add('hidden');
    }
  }

  function buildFallbackPlan(n, isLo) {
    const cashLabel = n.cashAtClosingLabel === 'cash_back' ? 'Estimated cash back' : 'Estimated cash to close';
    const summary =
      '<h2>Great News, ' + escapeHtml((n.clientName || 'there').split(' ')[0]) + '!</h2>' +
      '<p>Based on the numbers in your calculator (not a loan offer), here is a clear snapshot.</p>' +
      '<div class="glass rounded-2xl p-6 my-4">' +
      '<p><strong>Monthly cash-flow change:</strong> ' + money(n.monthlyCashFlowChange) + '</p>' +
      '<p><strong>New total housing (est.):</strong> ' + money(n.newTotalHousing) + ' (P&I ' + money(n.newPi) + ')</p>' +
      '<p><strong>Debts paid off:</strong> ' + money(n.totalDebtsPaidOff) + '</p>' +
      '<p><strong>' + cashLabel + ':</strong> ' + money(Math.abs(n.cashAtClosing)) + ' after ' + money(n.closingCosts) + ' closing costs</p>' +
      '<p><strong>Break-even:</strong> ' + (n.breakEvenMonths != null ? n.breakEvenMonths + ' months' : 'N/A') + '</p>' +
      '<p><strong>Mortgage interest vs keep current:</strong> ' + money(n.mortgageInterestSavings) + '</p>' +
      '</div>' +
      '<p class="text-sm opacity-75">These figures are estimates for discussion only and are not a commitment to lend.</p>';

    const table =
      '<h2>Scenario comparison</h2>' +
      '<table><thead><tr><th>Metric</th><th>Current</th><th>Proposed</th></tr></thead><tbody>' +
      '<tr><td>Loan / balance</td><td>' + money(n.currentBalance) + '</td><td>' + money(n.newLoanAmount) + '</td></tr>' +
      '<tr><td>Rate</td><td>' + n.currentRate + '%</td><td>' + n.newRate + '%</td></tr>' +
      '<tr><td>Term remaining / new</td><td>' + n.yearsRemaining + ' yrs</td><td>' + n.newTerm + ' yrs</td></tr>' +
      '<tr><td>P&I</td><td>' + money(n.currentPi) + '</td><td>' + money(n.newPi) + '</td></tr>' +
      '<tr><td>Total housing (est.)</td><td>' + money(n.currentTotalHousing) + '</td><td>' + money(n.newTotalHousing) + '</td></tr>' +
      '<tr><td>LTV</td><td>' + n.currentLtv + '%</td><td>' + n.newLtv + '%</td></tr>' +
      '<tr><td>Equity</td><td>' + money(n.currentEquity) + '</td><td>' + money(n.newEquity) + '</td></tr>' +
      '</tbody></table>';

    const plan =
      '<h2>Recommended discussion points</h2>' +
      '<ul>' +
      '<li>Proposed loan: ' + money(n.newLoanAmount) + ' at ' + n.newRate + '% for ' + n.newTerm + ' years</li>' +
      '<li>Monthly cash-flow change: ' + money(n.monthlyCashFlowChange) + '</li>' +
      '<li>' + cashLabel + ': ' + money(Math.abs(n.cashAtClosing)) + '</li>' +
      '<li>Review debts marked for payoff with your loan officer</li>' +
      '</ul>' +
      '<p>Next step: talk with your Ruoff loan officer to verify pricing, closing costs, and eligibility.</p>';

    if (!isLo) return [summary, table, plan];

    const scripts =
      '<h2>Sales scripts</h2>' +
      '<p><strong>Opener:</strong> \"I ran a smart savings scenario for you — it shows about ' +
      money(n.monthlyCashFlowChange) + ' in monthly cash-flow change and ' +
      money(Math.abs(n.cashAtClosing)) + ' ' + (n.cashAtClosingLabel === 'cash_back' ? 'cash back' : 'cash to close') +
      ' after estimated costs. Want to walk through it for 10 minutes?\"</p>';

    const follow =
      '<h2>Follow-up sequence</h2>' +
      '<ul>' +
      '<li><strong>Day 1:</strong> Send visual summary + executive summary</li>' +
      '<li><strong>Day 3:</strong> Short text referencing monthly cash-flow figure</li>' +
      '<li><strong>Day 7:</strong> Voicemail + email with break-even of ' +
      (n.breakEvenMonths != null ? n.breakEvenMonths + ' months' : 'N/A') + '</li>' +
      '<li><strong>Day 14 / 30:</strong> Value check-in; update rates if market moved</li>' +
      '</ul>';

    return [summary, table, plan, scripts, follow];
  }

  function showTab(n) {
    document.querySelectorAll('.tab-btn').forEach((btn, i) => btn.classList.toggle('active', i === n));
    const contentArea = $('tab-content');
    if (!window.currentPlan) {
      contentArea.innerHTML = '<div class="text-center py-16 text-lg opacity-60">Generate a plan first</div>';
      return;
    }
    contentArea.innerHTML = window.currentPlan.tabs[n] || '<p>Content not loaded.</p>';
  }

  function downloadAsWordDoc() {
    const element = $('tab-content');
    if (!element || !element.innerHTML.trim() || !window.currentPlan) {
      toast('Generate a plan first');
      return;
    }
    const name = ($('client-name') && $('client-name').value) || 'Client';
    const content = element.innerHTML;
    const blob = new Blob(
      ['<html><head><meta charset="UTF-8"><title>Ruoff Smart Plan</title></head><body>' + content + '</body></html>'],
      { type: 'application/msword' }
    );
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'Ruoff_Smart_Plan_' + name.replace(/\s+/g, '_') + '.doc';
    link.click();
  }

  function copyFormattedPlan() {
    const element = $('tab-content');
    if (!element || !window.currentPlan) {
      toast('Generate a plan first');
      return;
    }
    const htmlContent = element.innerHTML;
    const plainText = element.innerText;
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([htmlContent], { type: 'text/html' }),
        'text/plain': new Blob([plainText], { type: 'text/plain' })
      });
      navigator.clipboard.write([item]).then(() => toast('Formatted plan copied — paste into Word or email.'));
    } catch (err) {
      navigator.clipboard.writeText(plainText).then(() => toast('Copied as plain text.'));
    }
  }

  // ─── Visual summary (LO) ─────────────────────────────────
  function showVisualSummary() {
    if (!window.clientCalcData && lastScenario) {
      window.clientCalcData = C.buildCanonicalNumbers(lastScenario, collectClient());
    }
    if (!window.clientCalcData) {
      toast('Update the calculator or generate a plan first');
      return;
    }
    const d = window.clientCalcData;
    const s = lastScenario || C.computeScenario(state);

    let debtsHTML = '';
    (state.debts || []).filter(x => x.payOff).forEach(debt => {
      debtsHTML +=
        '<div class="flex justify-between items-center glass p-4 rounded-xl mb-2">' +
        '<div class="font-medium">' + escapeHtml(debt.name) + '</div>' +
        '<div class="text-right"><div class="font-bold number">' + money(debt.bal) + '</div>' +
        '<div class="text-xs opacity-60">' + money(debt.pay) + ' monthly</div></div></div>';
    });

    const cashLabel = s.isCashBack ? 'Est. cash back' : 'Est. cash to close';

    $('tab-content').innerHTML =
      '<div class="max-w-4xl mx-auto animate-fadeIn" id="visual-summary-root">' +
      '<div class="text-center mb-8">' +
      '<h1 class="text-3xl md:text-4xl font-black text-[var(--ruoff-teal)]">Smart Savings Summary</h1>' +
      '<p class="text-xl mt-2 opacity-75">for ' + escapeHtml(d.clientName || 'Client') + '</p></div>' +

      '<div class="glass rounded-2xl p-6 mb-4 text-center">' +
      '<div class="text-sm opacity-70">Home value</div>' +
      '<div class="text-4xl font-black number">' + money(s.homeValue) + '</div>' +
      '<div class="grid grid-cols-2 gap-6 mt-6">' +
      '<div><div class="text-sm opacity-70">Current equity</div><div class="text-2xl font-bold pos number">' + money(s.equity) + '</div></div>' +
      '<div><div class="text-sm opacity-70">Current LTV</div><div class="text-2xl font-bold number">' + s.ltv + '%</div></div>' +
      '</div></div>' +

      '<div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">' +
      '<div class="glass rounded-2xl p-6"><h3 class="font-bold mb-3">Before</h3>' +
      '<div class="space-y-2 text-sm">' +
      '<div class="flex justify-between"><span>Balance</span><span class="font-bold number">' + money(s.currentBalance) + '</span></div>' +
      '<div class="flex justify-between"><span>Total housing</span><span class="font-bold number">' + money(s.oldHousing) + '</span></div>' +
      '<div class="flex justify-between"><span>P&I</span><span class="number">' + money(s.oldPi) + '</span></div>' +
      '</div></div>' +
      '<div class="glass rounded-2xl p-6 border-2 border-[var(--ruoff-teal)]/30"><h3 class="font-bold mb-3">After (proposed)</h3>' +
      '<div class="space-y-2 text-sm">' +
      '<div class="flex justify-between"><span>New loan</span><span class="font-bold number">' + money(s.newLoanAmount) + '</span></div>' +
      '<div class="flex justify-between"><span>Total housing</span><span class="font-bold pos number">' + money(s.newHousing) + '</span></div>' +
      '<div class="flex justify-between"><span>P&I</span><span class="number">' + money(s.newPi) + '</span></div>' +
      '<div class="flex justify-between"><span>Rate / term</span><span>' + s.newRate + '% · ' + s.newTerm + ' yr</span></div>' +
      '</div></div></div>' +

      '<div class="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">' +
      '<div class="glass rounded-2xl p-5 text-center"><div class="text-xs opacity-70">Monthly cash-flow change</div>' +
      '<div class="text-3xl font-black number ' + (s.monthlyCashFlowChange >= 0 ? 'pos' : 'neg') + '">' +
      (s.monthlyCashFlowChange >= 0 ? '+' : '') + money(s.monthlyCashFlowChange) + '</div></div>' +
      '<div class="glass rounded-2xl p-5 text-center"><div class="text-xs opacity-70">Debts paid off</div>' +
      '<div class="text-3xl font-black number">' + money(s.totalDebtsPaidOff) + '</div></div>' +
      '<div class="glass rounded-2xl p-5 text-center"><div class="text-xs opacity-70">' + cashLabel + '</div>' +
      '<div class="text-3xl font-black number" style="color:#F15A29">' + money(Math.abs(s.cashAtClosing)) + '</div></div>' +
      '</div>' +

      '<div class="glass rounded-2xl p-6 mb-4"><h3 class="font-bold mb-3">Debts included</h3>' + (debtsHTML || '<p class="opacity-60">Mortgage only</p>') + '</div>' +

      '<div class="glass rounded-2xl p-6 mb-4 text-sm">' +
      '<div class="flex justify-between"><span>Break-even</span><span class="font-bold">' +
      (s.breakEvenMonths != null ? s.breakEvenMonths + ' months' : 'N/A') + '</span></div>' +
      '<div class="flex justify-between mt-2"><span>Interest vs keep current loan</span><span class="font-bold number">' +
      money(s.mortgageInterest.savings) + '</span></div>' +
      '<div class="flex justify-between mt-2"><span>New LTV / equity</span><span class="font-bold">' +
      s.newLtv + '% · ' + money(s.newEquity) + '</span></div>' +
      '</div>' +

      '<p class="text-xs opacity-60 text-center mb-6">Estimates only. Not a commitment to lend. Closing costs and pricing subject to change.</p>' +
      '<div class="text-center no-print">' +
      '<button type="button" class="px-8 py-4 bg-gradient-to-r from-[var(--ruoff-teal)] to-[var(--ruoff-orange)] text-white rounded-2xl font-bold" onclick="RuoffApp.copyVisualAsHTML()">Copy summary</button> ' +
      '<button type="button" class="px-6 py-4 opacity-80 hover:underline" onclick="RuoffApp.showTab(0)">← Back to plan tabs</button>' +
      '</div></div>';

    // Mark results visible
    $('results-area').classList.remove('hidden');
  }

  function copyVisualAsHTML() {
    const root = $('visual-summary-root') || $('tab-content');
    if (!root) return;
    const html = root.innerHTML;
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([root.innerText], { type: 'text/plain' })
      });
      navigator.clipboard.write([item]).then(() => toast('Visual summary copied.'));
    } catch (e) {
      navigator.clipboard.writeText(root.innerText);
      toast('Copied as plain text.');
    }
  }

  // ─── Email / contact ─────────────────────────────────────
  async function draftInitialEmail() {
    if (!lastScenario) liveUpdate();
    const numbers = window.clientCalcData || C.buildCanonicalNumbers(lastScenario, collectClient());
    const emailModal = $('email-loading-modal');
    if (emailModal) emailModal.classList.remove('hidden');

    const branding = state.branding;
    const firstName = (numbers.clientName || 'there').split(' ')[0];
    const cf = numbers.monthlyCashFlowChange;
    const cash = Math.abs(numbers.cashAtClosing);
    const cashPhrase = numbers.cashAtClosingLabel === 'cash_back' ? 'cash back' : 'cash to close';

    try {
      const prompt =
        'Write a short, warm, non-salesy first outreach email (200-280 words) from ' +
        (branding.name || 'a Ruoff loan officer') + ' (NMLS ' + (branding.nmls || '') + ') to ' + firstName + '.\n' +
        'Use ONLY these figures — do not invent others:\n' +
        '- Monthly cash-flow change: ' + money(cf) + '\n' +
        '- ' + cashPhrase + ': ' + money(cash) + '\n' +
        '- Debts paid off: ' + money(numbers.totalDebtsPaidOff) + '\n' +
        '- New payment housing est: ' + money(numbers.newTotalHousing) + '\n' +
        '- Break-even: ' + (numbers.breakEvenMonths != null ? numbers.breakEvenMonths + ' months' : 'N/A') + '\n' +
        '- Notes: ' + (numbers.clientNotes || 'None') + '\n' +
        'Lead with monthly cash-flow change. No hype or false urgency. Soft CTA.\n' +
        'Return ONLY:\nSubject: ...\nBody: ...';

      let subject = 'Your refinance snapshot – ' + money(cf) + ' monthly cash-flow change';
      let body =
        'Hi ' + firstName + ',\n\nI put together a refinance scenario for you. It shows about ' +
        money(cf) + ' in monthly cash-flow change and ' + money(cash) + ' ' + cashPhrase +
        ' after estimated closing costs.\n\nHappy to walk through the details on a quick call.\n\nBest,\n' +
        (branding.name || 'Your Loan Officer') + '\n' + (branding.cell || '') +
        (branding.nmls ? '\nNMLS ' + branding.nmls : '');

      try {
        const data = await callGrokAPI({
          model: 'grok-4-1-fast-reasoning',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.6,
          max_tokens: 1200
        });
        const emailText = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        const subjectMatch = emailText.match(/Subject:\s*(.+)/i);
        if (subjectMatch) subject = subjectMatch[1].trim();
        const bodyPart = emailText.replace(/Subject:?.+\n/i, '').replace(/^Body:\s*/i, '').trim();
        if (bodyPart) body = bodyPart;
      } catch (apiErr) {
        console.warn('Email AI draft unavailable, using template:', apiErr);
      }

      window.location.href =
        'mailto:' + encodeURIComponent(numbers.clientEmail || '') +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);
    } catch (e) {
      console.error(e);
      const subject = 'Your refinance snapshot';
      const body =
        'Hi ' + firstName + ',\n\nI ran a refinance scenario showing about ' + money(cf) +
        ' monthly cash-flow change. Happy to review together.\n\n' +
        (branding.name || '') + '\n' + (branding.cell || '');
      window.location.href =
        'mailto:' + encodeURIComponent(numbers.clientEmail || '') +
        '?subject=' + encodeURIComponent(subject) +
        '&body=' + encodeURIComponent(body);
    } finally {
      if (emailModal) emailModal.classList.add('hidden');
    }
  }

  function contactMyLO() {
    const client = collectClient();
    saveClient();
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const loEmail = state.loContact.email || '';
    const loName = state.loContact.name || 'there';

    const subject = 'Interested in discussing my refinance plan – ' + (client.clientName || '');
    const body =
      'Hi ' + loName + ',\n\n' +
      'I used the Ruoff Smart Savings Calculator and would like to talk through a scenario.\n\n' +
      'My contact info:\n' +
      '- Name: ' + (client.clientName || '') + '\n' +
      '- Phone: ' + (client.clientPhone || '(not provided)') + '\n' +
      '- Email: ' + (client.clientEmail || '(not provided)') + '\n\n' +
      'Calculator highlights (estimates only):\n' +
      '- Monthly cash-flow change: ' + money(s.monthlyCashFlowChange) + '\n' +
      '- Debts paid off: ' + money(s.totalDebtsPaidOff) + '\n' +
      '- ' + (s.isCashBack ? 'Cash back' : 'Cash to close') + ': ' + money(Math.abs(s.cashAtClosing)) + '\n' +
      '- Proposed loan: ' + money(s.newLoanAmount) + ' at ' + s.newRate + '% for ' + s.newTerm + ' years\n' +
      '- Break-even: ' + (s.breakEvenMonths != null ? s.breakEvenMonths + ' months' : 'N/A') + '\n\n' +
      'Goals / notes:\n' + (client.clientNotes || 'None entered') + '\n\n' +
      'Thank you!\n' + (client.clientName || '');

    if (!loEmail) {
      // No LO email in link — let borrower fill To: field, still compose body
      toast('Tip: ask your LO for a personal link so their email is pre-filled. Opening your mail app…');
    }
    window.location.href =
      'mailto:' + encodeURIComponent(loEmail) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  function copyBorrowerLink() {
    const base = window.location.origin + window.location.pathname.replace(/index\.html$/, 'borrower.html');
    const params = new URLSearchParams();
    if (state.branding.name) params.set('loName', state.branding.name);
    if (state.branding.email) params.set('loEmail', state.branding.email);
    if (state.branding.cell) params.set('loPhone', state.branding.cell);
    if (state.branding.nmls) params.set('loNmls', state.branding.nmls);
    const url = base + (params.toString() ? '?' + params.toString() : '');
    navigator.clipboard.writeText(url).then(() => toast('Borrower link copied — share so Contact LO emails you.'));
  }

  // ─── Theme ───────────────────────────────────────────────
  function initTheme() {
    const toggle = $('theme-toggle');
    const saved = localStorage.getItem(THEME_KEY);
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = saved ? saved === 'dark' : prefersDark;
    document.documentElement.classList.toggle('dark', dark);
    if (toggle) {
      toggle.checked = dark;
      toggle.addEventListener('change', () => {
        document.documentElement.classList.toggle('dark', toggle.checked);
        localStorage.setItem(THEME_KEY, toggle.checked ? 'dark' : 'light');
      });
    }
  }

  // ─── Hydrate DOM ─────────────────────────────────────────
  function hydrateDomFromState() {
    if ($('home-value')) $('home-value').value = Number(state.homeValue).toLocaleString();
    if ($('home-slider')) $('home-slider').value = state.homeValue;
    if ($('new-loan-amt')) $('new-loan-amt').value = state.newLoanAmount;
    if ($('new-loan-slider')) $('new-loan-slider').value = state.newLoanAmount;
    if ($('new-rate')) $('new-rate').value = state.newRate;
    if ($('new-rate-slider')) $('new-rate-slider').value = state.newRate;
    if ($('new-term')) $('new-term').value = String(state.newTerm);
    if ($('closing-costs')) $('closing-costs').value = state.closingCosts;
    if ($('project-cash')) $('project-cash').value = state.projectCash || 30000;
  }

  // ─── Init ────────────────────────────────────────────────
  function init() {
    initTheme();
    loadFromStorage();
    loadClient();
    if (MODE === 'lo') loadBranding();
    parseLoFromUrl();
    ensureMortgageDebt();
    hydrateDomFromState();
    liveUpdate();

    // Confirm which Grok proxy the browser will use (no key is ever sent)
    try {
      console.info('[Ruoff] Grok proxy:', getGrokEndpoint(), '(API key stays on server)');
    } catch (e) { /* ignore */ }

    // Accordion maxHeight fix on resize
    window.addEventListener('resize', () => {
      ['client-info-content', 'branding-content'].forEach(id => {
        const el = $(id);
        if (el && el.style.maxHeight && el.style.maxHeight !== '0px') {
          el.style.maxHeight = el.scrollHeight + 'px';
        }
      });
    });

    // Escape closes modals
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        ['mortgage-modal', 'debts-modal', 'add-debt-modal', 'help-modal', 'detail-modal'].forEach(id => {
          if ($(id)) $(id).classList.add('hidden');
        });
      }
    });
  }

  // Public API for onclick handlers
  window.RuoffApp = {
    getGrokEndpoint,
    callGrokAPI,
    liveUpdate,
    formatHomeValue,
    syncHomeSlider,
    syncNewLoanSlider,
    syncNewRateSlider,
    applyPreset,
    openMortgageModal,
    closeMortgageModal,
    updateMortgageModal,
    syncBalanceSlider,
    openDebtsModal,
    closeDebtsModal,
    switchToMortgageModal,
    openAddDebtModal,
    closeAddDebtModal,
    addNewDebt,
    clearAllData,
    showCashFlowModal,
    showDebtsPaidModal,
    showCashClosingModal,
    showInterestModal,
    closeDetailModal,
    showHelp,
    closeHelp,
    generateSmartPlan,
    showTab,
    downloadAsWordDoc,
    copyFormattedPlan,
    showVisualSummary,
    copyVisualAsHTML,
    draftInitialEmail,
    contactMyLO,
    copyBorrowerLink,
    saveBranding,
    saveClient,
    toggleAccordion: function (which) {
      if (which === 'client') toggleAccordion('client-info-content', 'client-chevron');
      if (which === 'branding') toggleAccordion('branding-content', 'branding-chevron');
    },
    getScenario: () => lastScenario,
    MODE
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
