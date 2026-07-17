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
  const WIZARD_STEP_KEY = 'ruoff.wizardStep.' + MODE;
  const MAX_WIZARD_REACHED_KEY = 'ruoff.wizardMax.' + MODE;
  const SCENARIOS_KEY = 'ruoff.scenarios.' + MODE;

  /**
   * Grok proxy — API key stays on the server (Render in production).
   * Browser never sends a key; only POSTs model + messages to the proxy.
   *
   * Override options (no code change needed):
   *   window.RUOFF_GROK_URL = 'http://localhost:3003/grok'  // force local proxy
   *   ?grokProxy=https://other.onrender.com/grok           // one-off URL override
   *   ?localGrok=1                                         // force same-origin /grok
   *
   * On localhost: uses local /grok only if /health reports hasKey; otherwise
   * routes to the Render proxy so Generate Plan works without a local env key.
   */
  const RENDER_GROK_PROXY = 'https://ruofflorefinancecalculator.onrender.com/grok';
  let resolvedGrokEndpoint = null;
  let resolvingGrokEndpoint = null;

  function getGrokEndpointSync() {
    if (window.RUOFF_GROK_URL) return window.RUOFF_GROK_URL;
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('grokProxy');
      if (q) return q;
      if (params.get('localGrok') === '1') return '/grok';
    } catch (e) { /* ignore */ }

    const host = (window.location && window.location.hostname) || '';
    if (host.includes('ruofflorefinancecalculator.onrender.com')) return '/grok';
    // Prefer cached resolution; default to Render until /health is checked
    if (resolvedGrokEndpoint) return resolvedGrokEndpoint;
    if (host === 'localhost' || host === '127.0.0.1') return RENDER_GROK_PROXY;
    return RENDER_GROK_PROXY;
  }

  async function resolveGrokEndpoint() {
    if (window.RUOFF_GROK_URL) {
      resolvedGrokEndpoint = window.RUOFF_GROK_URL;
      return resolvedGrokEndpoint;
    }
    try {
      const params = new URLSearchParams(window.location.search);
      const q = params.get('grokProxy');
      if (q) {
        resolvedGrokEndpoint = q;
        return resolvedGrokEndpoint;
      }
      if (params.get('localGrok') === '1') {
        resolvedGrokEndpoint = '/grok';
        return resolvedGrokEndpoint;
      }
    } catch (e) { /* ignore */ }

    const host = (window.location && window.location.hostname) || '';
    if (host.includes('ruofflorefinancecalculator.onrender.com')) {
      resolvedGrokEndpoint = '/grok';
      return resolvedGrokEndpoint;
    }

    // Localhost: only use same-origin if this process has GROK_API_KEY
    if (host === 'localhost' || host === '127.0.0.1') {
      try {
        const health = await fetch('/health', { cache: 'no-store' }).then(function (r) {
          return r.ok ? r.json() : null;
        });
        if (health && health.hasKey) {
          resolvedGrokEndpoint = '/grok';
          return resolvedGrokEndpoint;
        }
      } catch (e) { /* fall through to Render */ }
      resolvedGrokEndpoint = RENDER_GROK_PROXY;
      return resolvedGrokEndpoint;
    }

    resolvedGrokEndpoint = RENDER_GROK_PROXY;
    return resolvedGrokEndpoint;
  }

  function getGrokEndpoint() {
    return resolvedGrokEndpoint || getGrokEndpointSync();
  }

  /** POST to Render (or local) Grok proxy — never attach Authorization from the browser */
  async function callGrokAPI(body) {
    if (!resolvedGrokEndpoint) {
      if (!resolvingGrokEndpoint) resolvingGrokEndpoint = resolveGrokEndpoint();
      await resolvingGrokEndpoint;
      resolvingGrokEndpoint = null;
    }
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
        detail = await res.text().catch(function () { return ''; });
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
    branding: { name: '', nmls: '', email: '', cell: '', color: '#00A89D', accent: '#F15A29', photo: '' },
    loContact: { name: '', email: '', phone: '', nmls: '', color: '', accent: '', photo: '' }
  };

  let lastScenario = null;
  let mortgageModalSource = 'main';
  let editingDebtIndex = undefined;
  let expandedDebtIndex = null; // inline edit in debts list
  let generatingPlan = false;
  let openModalIds = [];
  let experienceMode = 'guided'; // 'guided' | 'expert'
  let wizardStep = 0;
  let wizardMaxReached = 0;
  const animState = {}; // id -> last numeric value for count-up
  let prevCashFlowSign = null; // for confetti on flip to positive
  let confettiCooldownUntil = 0;
  let savedScenarios = []; // A/B compare slots

  const WIZARD_STEPS = MODE === 'lo'
    ? [
        { key: 'setup', label: 'Setup' },
        { key: 'home', label: 'Home' },
        { key: 'mortgage', label: 'Mortgage' },
        { key: 'debts', label: 'Debts' },
        { key: 'scenario', label: 'Scenario' },
        { key: 'plan', label: 'Plan' }
      ]
    : [
        { key: 'setup', label: 'You' },
        { key: 'home', label: 'Home' },
        { key: 'mortgage', label: 'Mortgage' },
        { key: 'debts', label: 'Debts' },
        { key: 'scenario', label: 'Scenario' },
        { key: 'plan', label: 'Plan' }
      ];

  // ─── Helpers ─────────────────────────────────────────────
  const $ = (id) => document.getElementById(id);
  const money = (n, signed) => C.formatMoney(n, { signed: !!signed });

  function setModalOpen(id, open) {
    const el = $(id);
    if (!el) return;
    if (open) {
      el.classList.remove('hidden');
      if (openModalIds.indexOf(id) === -1) openModalIds.push(id);
    } else {
      el.classList.add('hidden');
      openModalIds = openModalIds.filter(x => x !== id);
    }
    document.body.classList.toggle('modal-open', openModalIds.length > 0);
  }

  function closeTopModal() {
    const stack = ['add-debt-modal', 'detail-modal', 'help-modal', 'mortgage-modal', 'debts-modal', 'loading-modal', 'email-loading-modal'];
    for (let i = 0; i < stack.length; i++) {
      const el = $(stack[i]);
      if (el && !el.classList.contains('hidden')) {
        if (stack[i] === 'mortgage-modal') { closeMortgageModal(); return; }
        if (stack[i] === 'debts-modal') { closeDebtsModal(); return; }
        if (stack[i] === 'add-debt-modal') { closeAddDebtModal(); return; }
        if (stack[i] === 'detail-modal') { closeDetailModal(); return; }
        if (stack[i] === 'help-modal') { closeHelp(); return; }
        // Don't dismiss loading with Escape
        return;
      }
    }
  }

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
      cell: ($('branding-cell') && $('branding-cell').value.trim()) || '',
      color: ($('branding-color') && $('branding-color').value) || '#00A89D',
      accent: ($('branding-accent') && $('branding-accent').value) || '#F15A29',
      photo: ($('branding-photo') && $('branding-photo').value.trim()) || ''
    };
    try { localStorage.setItem(BRANDING_KEY, JSON.stringify(state.branding)); } catch (e) {}
    updateBrandingChip();
    toggleAccordion('branding-content', 'branding-chevron', false);
    toast('Branding saved — it will appear on plans, emails, and borrower links.');
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
    if ($('branding-color')) $('branding-color').value = state.branding.color || '#00A89D';
    if ($('branding-accent')) $('branding-accent').value = state.branding.accent || '#F15A29';
    if ($('branding-photo')) $('branding-photo').value = state.branding.photo || '';
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
      nmls: params.get('loNmls') || params.get('nmls') || '',
      color: params.get('loColor') || params.get('color') || '',
      accent: params.get('loAccent') || params.get('accent') || '',
      photo: params.get('loPhoto') || params.get('photo') || ''
    };
    if (MODE === 'borrower') {
      applyLoBrandTheme(state.loContact);
      renderLoContactBanner();
    }
  }

  function safeHexColor(val, fallback) {
    const v = String(val || '').trim();
    if (/^#[0-9A-Fa-f]{6}$/.test(v)) return v;
    if (/^#[0-9A-Fa-f]{3}$/.test(v)) {
      return '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
    }
    return fallback;
  }

  function applyLoBrandTheme(lo) {
    if (!lo) return;
    const primary = safeHexColor(lo.color, '');
    const accent = safeHexColor(lo.accent, '');
    const root = document.documentElement;
    if (primary) {
      root.style.setProperty('--ruoff-teal', primary);
      root.style.setProperty('--ruoff-teal-bright', primary);
      document.body.classList.add('lo-branded');
    }
    if (accent) {
      root.style.setProperty('--ruoff-orange', accent);
      document.body.classList.add('lo-branded');
    }
    // Header gradient follows brand colors
    const header = document.querySelector('.app-header');
    if (header && (primary || accent)) {
      const c1 = primary || '#002B5C';
      const c2 = accent || primary || '#00A89D';
      header.style.background = 'linear-gradient(105deg, #002B5C 0%, ' + c1 + ' 48%, ' + c2 + ' 100%)';
    }
  }

  function initialsFromName(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return 'LO';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function renderLoContactBanner() {
    const banner = $('lo-contact-banner');
    if (!banner || MODE !== 'borrower') return;
    const lo = state.loContact;
    if (!lo.name && !lo.email && !lo.photo) {
      banner.classList.add('hidden');
      return;
    }
    banner.classList.remove('hidden');
    const photo = lo.photo;
    const avatar = photo
      ? '<img class="lo-avatar-img" src="' + escapeHtml(photo) + '" alt="">'
      : '<span class="lo-avatar-initials">' + escapeHtml(initialsFromName(lo.name)) + '</span>';
    banner.innerHTML =
      '<div class="lo-avatar">' + avatar + '</div>' +
      '<div class="lo-banner-text min-w-0 flex-1">' +
        '<div class="font-bold truncate">' + escapeHtml(lo.name || 'Your loan officer') + '</div>' +
        '<div class="text-sm opacity-75 truncate">' +
          (lo.nmls ? 'NMLS ' + escapeHtml(lo.nmls) : '') +
          (lo.nmls && lo.phone ? ' · ' : '') +
          (lo.phone ? escapeHtml(lo.phone) : '') +
          ((lo.nmls || lo.phone) && lo.email ? ' · ' : '') +
          (lo.email ? escapeHtml(lo.email) : '') +
        '</div>' +
      '</div>' +
      (lo.email
        ? '<a class="lo-banner-cta" href="mailto:' + encodeURIComponent(lo.email) + '">Email</a>'
        : '');
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

  function toast(msg, type) {
    const el = $('toast');
    if (!el) {
      alert(msg);
      return;
    }
    el.textContent = msg;
    el.classList.remove('hidden', 'toast-ok', 'toast-warn', 'toast-err');
    el.classList.add(type === 'error' ? 'toast-err' : type === 'warn' ? 'toast-warn' : 'toast-ok');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => el.classList.add('hidden'), 3400);
  }

  function updateBrandingChip() {
    const chip = $('branding-chip');
    if (!chip) return;
    if (state.branding && state.branding.name) {
      chip.classList.remove('hidden');
      chip.textContent = state.branding.name + (state.branding.nmls ? ' · NMLS ' + state.branding.nmls : '');
    } else {
      chip.classList.add('hidden');
      chip.textContent = '';
    }
  }

  function updateValidationBanner(scenario) {
    const banner = $('validation-banner');
    if (!banner) return;
    const issues = [];
    if (state.homeValue > 0 && state.currentBalance > state.homeValue) {
      issues.push('Mortgage balance is higher than home value — check your numbers.');
    }
    if (state.currentRate <= 0) {
      issues.push('Add your current rate (Edit mortgage) for accurate interest comparisons.');
    }
    if (state.yearsRemaining <= 0) {
      issues.push('Add years remaining on your current loan for interest comparisons.');
    }
    if (state.newRate <= 0) {
      issues.push('Enter a proposed interest rate greater than 0.');
    }
    if (state.newLoanAmount < state.currentBalance && !scenario.isCashOutScenario) {
      // rate-and-term with smaller loan is OK (principal curtailment) — soft note only if much smaller
      if (state.newLoanAmount < state.currentBalance * 0.9) {
        issues.push('New loan is well below current balance — confirm you intend to bring cash to close.');
      }
    }
    if (scenario && scenario.overMaxLoan) {
      issues.push('Loan amount exceeds the ' + scenario.maxLtvPct + '% LTV guideline for this scenario.');
    }
    if (!issues.length) {
      banner.classList.add('hidden');
      banner.innerHTML = '';
      return;
    }
    banner.classList.remove('hidden');
    banner.innerHTML = '<i class="fas fa-triangle-exclamation flex-shrink-0 mt-0.5"></i><div><strong class="font-semibold">Double-check:</strong> ' +
      issues.map(escapeHtml).join(' ') + '</div>';
  }

  function appendGoalChip(text) {
    const ta = $('client-notes');
    if (!ta) return;
    const chip = String(text || '').trim();
    if (!chip) return;
    const cur = ta.value.trim();
    if (cur.toLowerCase().indexOf(chip.toLowerCase()) !== -1) {
      toast('Already in your goals', 'warn');
      return;
    }
    ta.value = cur ? (cur.replace(/[;\s]*$/, '') + '; ' + chip) : chip;
    saveClient();
    toast('Added to goals');
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
    animateStat('equity', scenario.equity, { money: true });
    animateStat('ltv', scenario.ltv, { money: false, suffix: '%' });
    setText('summary-balance', money(scenario.currentBalance));
    setText('summary-total-pay', money(scenario.oldHousing));
    setText('summary-pi', money(scenario.oldPi));
    setText('summary-escrow', money(scenario.oldEscrow));

    // Before / after mirrors
    animateStat('before-housing-mirror', scenario.oldHousing, { money: true });
    setText('before-pi-mirror', money(scenario.oldPi));

    // New scenario KPIs
    setText('new-pi-display', money(scenario.newPi));
    animateStat('new-housing-display', scenario.newHousing, { money: true, className: 'text-3xl sm:text-4xl font-black pos number mt-1' });
    animateStat('new-equity', scenario.newEquity, { money: true });
    animateStat('new-ltv', scenario.newLtv, { money: false, suffix: '%' });

    // Cash flow
    const cf = scenario.monthlyCashFlowChange;
    animateStat('monthly-cashflow', cf, {
      money: true,
      signed: true,
      className: 'kpi-value number ' + (cf > 0 ? 'pos' : cf < 0 ? 'neg' : '')
    });
    setText('monthly-cashflow-hint',
      cf > 0
        ? 'More cash flow each month vs today'
        : cf < 0
          ? 'Higher combined payment than today'
          : 'About the same monthly cash flow as today');

    animateStat('total-debts-paid', scenario.totalDebtsPaidOff, { money: true, className: 'kpi-value number' });

    // Cash at closing
    const cashEl = $('cash-at-closing');
    const cashLabel = $('cash-at-closing-label');
    if (cashEl) {
      if (scenario.cashAtClosing === 0) {
        animateStat('cash-at-closing', 0, { money: true, className: 'kpi-value number', color: '' });
        if (cashLabel) cashLabel.textContent = 'Even at closing';
      } else if (scenario.isCashBack) {
        animateStat('cash-at-closing', Math.abs(scenario.cashAtClosing), {
          money: true,
          className: 'kpi-value number',
          color: '#F15A29'
        });
        if (cashLabel) cashLabel.textContent = 'Est. cash back at closing';
      } else {
        animateStat('cash-at-closing', Math.abs(scenario.cashAtClosing), {
          money: true,
          className: 'kpi-value number neg',
          color: ''
        });
        if (cashLabel) cashLabel.textContent = 'Est. cash to close';
      }
    }
    setText('closing-costs-note', 'After ' + money(scenario.closingCosts) + ' estimated closing costs');

    // Break-even
    const beEl = $('break-even');
    if (beEl) {
      if (scenario.breakEvenMonths == null) {
        beEl.textContent = cf <= 0 ? 'N/A' : '—';
        animState['break-even'] = null;
        setText('break-even-hint', cf <= 0 ? 'Needs positive monthly savings' : '');
      } else {
        animateStat('break-even', scenario.breakEvenMonths, {
          money: false,
          suffix: ' mo',
          className: 'kpi-value number'
        });
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

    // Sticky bar + wizard dock live metrics
    updateDockMetrics(scenario, cf);

    updateValidationBanner(scenario);
    updateBrandingChip();
    updateDebtSummaryStrip();
    updateWizardPreviews(scenario);
    syncTermSegmented();
    updateStepTip(scenario);
    maybeCelebrateWin(scenario);
    renderScenarioCompare();
    updateAmortizationChart(scenario);
    saveToStorage();
  }

  // ─── Amortization chart ──────────────────────────────────
  function updateAmortizationChart(scenario) {
    const wrap = $('amort-chart');
    if (!wrap || !scenario) return;

    const keep = C.amortizationBalanceSeries(
      scenario.currentBalance,
      scenario.currentRate,
      scenario.yearsRemaining,
      12
    );
    const refi = C.amortizationBalanceSeries(
      scenario.newLoanAmount,
      scenario.newRate,
      scenario.newTerm,
      12
    );

    const maxBal = Math.max(
      scenario.currentBalance || 0,
      scenario.newLoanAmount || 0,
      1
    );
    const maxYears = Math.max(
      scenario.yearsRemaining || 0,
      scenario.newTerm || 0,
      1
    );

    const W = 400;
    const H = 168;
    const pad = { t: 16, r: 12, b: 28, l: 44 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;

    function xOf(year) {
      return pad.l + (year / maxYears) * plotW;
    }
    function yOf(bal) {
      return pad.t + plotH - (bal / maxBal) * plotH;
    }

    function toPolyline(series) {
      return series.points.map(function (pt) {
        return xOf(pt.year).toFixed(1) + ',' + yOf(pt.balance).toFixed(1);
      }).join(' ');
    }

    const keepLine = toPolyline(keep);
    const refiLine = toPolyline(refi);

    // Grid years: 0, mid, end
    const ticks = [0, Math.round(maxYears / 2), Math.round(maxYears)];
    const grid = ticks.map(function (y) {
      const x = xOf(y);
      return '<line x1="' + x + '" y1="' + pad.t + '" x2="' + x + '" y2="' + (pad.t + plotH) +
        '" stroke="currentColor" stroke-opacity="0.08"/>' +
        '<text x="' + x + '" y="' + (H - 8) + '" text-anchor="middle" class="amort-axis">' + y + 'y</text>';
    }).join('');

    const yLabels = [0, 0.5, 1].map(function (f) {
      const bal = maxBal * (1 - f);
      const y = pad.t + plotH * f;
      return '<text x="' + (pad.l - 6) + '" y="' + (y + 4) + '" text-anchor="end" class="amort-axis">' +
        (bal >= 1000 ? Math.round(bal / 1000) + 'k' : Math.round(bal)) + '</text>';
    }).join('');

    wrap.innerHTML =
      '<div class="amort-head">' +
        '<div><div class="label-caps">Loan balance over time</div>' +
        '<h3 class="amort-title">Keep current vs proposed refinance</h3></div>' +
        '<div class="amort-legend">' +
          '<span class="amort-leg amort-leg-keep">Keep current</span>' +
          '<span class="amort-leg amort-leg-refi">Proposed refi</span>' +
        '</div>' +
      '</div>' +
      '<svg class="amort-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Amortization balance chart">' +
        '<rect x="' + pad.l + '" y="' + pad.t + '" width="' + plotW + '" height="' + plotH +
          '" fill="currentColor" fill-opacity="0.03" rx="8"/>' +
        grid + yLabels +
        '<polyline fill="none" stroke="#94a3b8" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="' + keepLine + '"/>' +
        '<polyline fill="none" stroke="var(--ruoff-teal)" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" points="' + refiLine + '"/>' +
      '</svg>' +
      '<div class="amort-foot">' +
        '<div>Interest left if you keep loan: <strong class="number">' + money(scenario.mortgageInterest.keepInterest) + '</strong></div>' +
        '<div>Interest on proposed loan: <strong class="number">' + money(scenario.mortgageInterest.refiInterest) + '</strong></div>' +
        '<div class="' + (scenario.mortgageInterest.savings >= 0 ? 'pos' : 'neg') + '">' +
          (scenario.mortgageInterest.savings >= 0 ? 'You save ' : 'You pay ') +
          '<strong class="number">' + money(Math.abs(scenario.mortgageInterest.savings)) + '</strong> interest' +
        '</div>' +
      '</div>';
  }

  function maybeCelebrateWin(scenario) {
    const cf = scenario.monthlyCashFlowChange;
    const sign = cf > 25 ? 1 : cf < -25 ? -1 : 0;
    if (prevCashFlowSign === null) {
      prevCashFlowSign = sign;
      return;
    }
    // Fire once when flipping into meaningful positive cash flow
    if (sign === 1 && prevCashFlowSign !== 1 && Date.now() > confettiCooldownUntil) {
      confettiCooldownUntil = Date.now() + 8000;
      fireWinConfetti();
      toast('Nice — this scenario improves monthly cash flow');
    }
    prevCashFlowSign = sign;
  }

  function fireWinConfetti() {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (typeof confetti !== 'function') return;
    const colors = ['#00A89D', '#F15A29', '#002B5C', '#34d399', '#ffffff'];
    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.65 },
      colors: colors,
      disableForReducedMotion: true
    });
    setTimeout(function () {
      confetti({ particleCount: 40, angle: 60, spread: 55, origin: { x: 0, y: 0.7 }, colors: colors });
      confetti({ particleCount: 40, angle: 120, spread: 55, origin: { x: 1, y: 0.7 }, colors: colors });
    }, 180);
  }

  function updateDockMetrics(scenario, cf) {
    const cfText = (cf > 0 ? '+' : '') + money(cf);
    const cashText = scenario.cashAtClosing === 0
      ? 'Even'
      : ((scenario.isCashBack ? 'Back ' : 'Due ') + money(Math.abs(scenario.cashAtClosing)));
    const beText = scenario.breakEvenMonths != null ? scenario.breakEvenMonths + ' mo' : 'N/A';
    const housingText = money(scenario.oldHousing) + ' → ' + money(scenario.newHousing);

    ['sticky-cashflow', 'dock-cashflow', 'ms-cashflow'].forEach(function (id) {
      const el = $(id);
      if (!el) return;
      el.textContent = cfText;
      el.className = (el.className || '').replace(/\b(pos|neg)\b/g, '').trim() + ' ' + (cf > 0 ? 'pos' : cf < 0 ? 'neg' : '');
    });
    ['sticky-cash', 'dock-cash', 'ms-cash'].forEach(function (id) {
      setText(id, cashText);
    });
    ['sticky-breakeven', 'ms-breakeven'].forEach(function (id) {
      setText(id, beText);
    });
    setText('ms-housing', housingText);
  }

  function updateWizardPreviews(scenario) {
    if (!scenario) return;
    setText('wiz-preview-equity', money(scenario.equity));
    setText('wiz-preview-ltv', scenario.ltv + '%');
    setText('wiz-preview-housing', money(scenario.oldHousing));
    setText('wiz-preview-pi', money(scenario.oldPi));
    setText('plan-before-housing', money(scenario.oldHousing));
    setText('plan-after-housing', money(scenario.newHousing));
    const cf = scenario.monthlyCashFlowChange;
    setText('plan-cf', (cf > 0 ? '+' : '') + money(cf));
    setText('plan-cash', money(Math.abs(scenario.cashAtClosing)));
    setText('plan-be', scenario.breakEvenMonths != null ? scenario.breakEvenMonths + ' mo' : 'N/A');
  }

  /** Contextual tip under wizard footer / step */
  function updateStepTip(scenario) {
    const tip = $('wizard-step-tip');
    if (!tip || !scenario) return;
    const tips = {
      0: MODE === 'lo'
        ? 'Tip: Save branding once — it rides on every plan and borrower link.'
        : 'Tip: Goals help your loan officer tailor recommendations.',
      1: 'Tip: A close estimate is fine — you can refine later with an appraisal.',
      2: 'Tip: Add current rate + years remaining for honest interest comparisons.',
      3: selectedOtherDebtsCount() > 0
        ? 'Nice — ' + selectedOtherDebtsCount() + ' debt(s) selected. Continue when ready.'
        : 'Optional step. Skip if this is a simple rate-and-term refinance.',
      4: scenario.monthlyCashFlowChange > 0
        ? 'Looking strong: about ' + money(scenario.monthlyCashFlowChange) + ' more monthly cash flow in this scenario.'
        : scenario.monthlyCashFlowChange < 0
          ? 'Cash flow is higher than today — try rate, term, or which debts you include.'
          : 'Tune rate, term, or loan amount to explore trade-offs.',
      5: 'Numbers stay locked. AI will narrate this path and compare calculated debt-payoff alternatives.'
    };
    tip.textContent = tips[wizardStep] || '';
  }

  // ─── Experience mode + wizard ────────────────────────────
  function setExperienceMode(mode, opts) {
    const options = opts || {};
    experienceMode = (mode === 'expert' || mode === 'full') ? 'expert' : 'guided';

    // Hard-set classes (avoid toggle edge cases leaving both/neither)
    document.body.classList.remove('mode-guided', 'mode-expert');
    document.body.classList.add(experienceMode === 'expert' ? 'mode-expert' : 'mode-guided');

    // Sync toggle buttons (support id or data-mode)
    document.querySelectorAll('[data-mode], #mode-guided, #mode-expert').forEach(function (btn) {
      const btnMode = btn.getAttribute('data-mode')
        || (btn.id === 'mode-expert' ? 'expert' : btn.id === 'mode-guided' ? 'guided' : '');
      if (!btnMode) return;
      const active = (btnMode === 'expert' && experienceMode === 'expert')
        || (btnMode === 'guided' && experienceMode === 'guided');
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });

    try { localStorage.setItem('ruoff.experienceMode.' + MODE, experienceMode); } catch (err) {}

    if (experienceMode === 'guided') {
      goToWizardStep(wizardStep, { silent: !!options.silent });
      if (!options.silent) toast('Guided tour mode');
    } else {
      // Show every calculator section
      document.querySelectorAll('.wizard-panel').forEach(function (p) {
        p.classList.add('active-step');
        p.style.removeProperty('display');
      });
      // Scroll to top of workspace so the change is obvious
      if (!options.silent) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        toast('Full workspace — all sections visible');
      }
    }
  }

  function wireModeToggle() {
    const bar = document.querySelector('.mode-bar');
    if (!bar) return;
    // Capture-phase so nothing steals the click
    bar.addEventListener('click', function (e) {
      const btn = e.target.closest('[data-mode], #mode-guided, #mode-expert');
      if (!btn || !bar.contains(btn)) return;
      e.preventDefault();
      e.stopPropagation();
      const mode = btn.getAttribute('data-mode')
        || (btn.id === 'mode-expert' ? 'expert' : 'guided');
      setExperienceMode(mode);
    }, true);
  }

  function renderWizardRail() {
    const rail = $('wizard-rail');
    if (!rail) return;
    rail.innerHTML = WIZARD_STEPS.map(function (s, i) {
      let cls = '';
      if (i === wizardStep) cls = 'active';
      else if (i <= wizardMaxReached) cls = 'done';
      const displayIcon = i === wizardStep
        ? String(i + 1)
        : (i <= wizardMaxReached ? '<i class="fas fa-check"></i>' : String(i + 1));
      return '<button type="button" class="wizard-rail-step ' + cls + '" data-wiz-goto="' + i + '" title="' + s.label + '">' +
        '<span class="wizard-dot">' + displayIcon + '</span>' +
        '<span class="wizard-rail-label">' + s.label + '</span></button>';
    }).join('');
    rail.querySelectorAll('[data-wiz-goto]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const i = parseInt(btn.getAttribute('data-wiz-goto'), 10);
        // Allow jump to any step already reached, or next step
        if (i <= wizardMaxReached || i <= wizardStep + 1) goToWizardStep(i);
        else toast('Finish the earlier steps first — or jump back to where you left off', 'warn');
      });
    });
  }

  function goToWizardStep(step, opts) {
    const options = opts || {};
    wizardStep = Math.max(0, Math.min(WIZARD_STEPS.length - 1, step));
    if (wizardStep > wizardMaxReached) wizardMaxReached = wizardStep;
    try {
      localStorage.setItem(WIZARD_STEP_KEY, String(wizardStep));
      localStorage.setItem(MAX_WIZARD_REACHED_KEY, String(wizardMaxReached));
    } catch (e) { /* ignore */ }

    document.querySelectorAll('.wizard-panel').forEach(function (panel) {
      const s = parseInt(panel.getAttribute('data-wizard-step'), 10);
      panel.classList.toggle('active-step', s === wizardStep);
    });
    renderWizardRail();
    const meta = $('wizard-footer-meta');
    if (meta) {
      meta.textContent = 'Step ' + (wizardStep + 1) + ' of ' + WIZARD_STEPS.length + ' · ' + WIZARD_STEPS[wizardStep].label;
    }
    const back = $('wizard-back');
    const next = $('wizard-next');
    if (back) back.style.visibility = wizardStep === 0 ? 'hidden' : 'visible';
    if (next) {
      if (wizardStep >= WIZARD_STEPS.length - 1) {
        next.textContent = MODE === 'borrower' ? 'Create my plan' : 'Generate plan';
        next.onclick = function () { generateSmartPlan(); };
      } else {
        const labels = {
          0: 'Continue',
          1: 'Continue',
          2: 'Continue',
          3: 'Continue to scenario',
          4: 'Review & generate'
        };
        next.textContent = labels[wizardStep] || 'Continue';
        next.onclick = function () { wizardNext(); };
      }
    }
    if (lastScenario) updateStepTip(lastScenario);
    if (!options.silent) dismissResumeBanner();
    // Always land at the top of the new step (skip on silent restore / init)
    if (!options.silent && experienceMode === 'guided') {
      scrollWizardStepIntoView();
    }
  }

  /**
   * Scroll so the new wizard step starts at the top of the viewport
   * (just below the sticky header). Runs after layout so panel height is correct.
   */
  function scrollWizardStepIntoView() {
    if (experienceMode !== 'guided') return;

    const reduceMotion = window.matchMedia &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior = reduceMotion ? 'auto' : 'smooth';

    function targetY() {
      // Mode bar + rail + step: land so the progress rail is under the header
      const rail = $('wizard-rail');
      const active = document.querySelector('.wizard-panel.active-step');
      const target = (rail && rail.offsetParent !== null) ? rail : active;
      if (!target) return 0;
      const header = document.querySelector('.app-header');
      const offset = (header ? header.getBoundingClientRect().height : 0) + 8;
      return Math.max(0, target.getBoundingClientRect().top + window.pageYOffset - offset);
    }

    // Wait for the new panel to paint (display swap), then scroll
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        window.scrollTo({ top: targetY(), behavior: behavior });
        // Instant correction if smooth scroll undershot (layout shift / long previous step)
        setTimeout(function () {
          const y = targetY();
          if (Math.abs(window.pageYOffset - y) > 24) {
            window.scrollTo({ top: y, behavior: 'auto' });
          }
        }, reduceMotion ? 0 : 280);
      });
    });
  }

  function wizardNext() {
    if (wizardStep >= WIZARD_STEPS.length - 1) {
      generateSmartPlan();
      return;
    }
    goToWizardStep(wizardStep + 1);
  }

  function wizardBack() {
    if (wizardStep <= 0) return;
    goToWizardStep(wizardStep - 1);
  }

  function restoreWizardProgress() {
    try {
      const saved = parseInt(localStorage.getItem(WIZARD_STEP_KEY), 10);
      const maxR = parseInt(localStorage.getItem(MAX_WIZARD_REACHED_KEY), 10);
      if (!isNaN(maxR)) wizardMaxReached = Math.max(0, Math.min(WIZARD_STEPS.length - 1, maxR));
      if (!isNaN(saved)) {
        wizardStep = Math.max(0, Math.min(WIZARD_STEPS.length - 1, saved));
        wizardMaxReached = Math.max(wizardMaxReached, wizardStep);
      }
    } catch (e) { /* ignore */ }
  }

  function setTerm(years) {
    state.newTerm = Number(years) || 30;
    if ($('new-term')) $('new-term').value = String(state.newTerm);
    syncTermSegmented();
    liveUpdate();
  }

  function syncTermSegmented() {
    const term = String(parseNum($('new-term') && $('new-term').value) || state.newTerm || 30);
    document.querySelectorAll('#term-segmented [data-term]').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-term') === term);
    });
  }

  function setText(id, text) {
    const el = $(id);
    if (el) el.textContent = text;
  }

  /**
   * Animate a numeric display toward a target value (money or plain).
   * @param {string} id
   * @param {number} target
   * @param {{ money?: boolean, signed?: boolean, suffix?: string, className?: string, color?: string }} opts
   */
  function animateStat(id, target, opts) {
    const el = $(id);
    if (!el) return;
    const options = opts || {};
    const to = Number(target) || 0;
    const from = animState[id] != null ? animState[id] : to;
    animState[id] = to;

    if (options.className) el.className = options.className;
    if (options.color !== undefined) el.style.color = options.color || '';

    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduce || Math.abs(to - from) < 0.5) {
      el.textContent = formatAnimValue(to, options);
      return;
    }

    const start = performance.now();
    const duration = Math.min(700, 280 + Math.abs(to - from) / 50);
    if (el._animFrame) cancelAnimationFrame(el._animFrame);

    function frame(now) {
      const t = Math.min(1, (now - start) / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const cur = from + (to - from) * eased;
      el.textContent = formatAnimValue(cur, options);
      if (t < 1) {
        el._animFrame = requestAnimationFrame(frame);
      } else {
        el.textContent = formatAnimValue(to, options);
        el._animFrame = null;
      }
    }
    el._animFrame = requestAnimationFrame(frame);
  }

  function formatAnimValue(n, options) {
    const rounded = options.money !== false ? Math.round(n) : Math.round(n);
    if (options.suffix === '%') return rounded + '%';
    if (options.suffix === ' mo') {
      if (n == null || !isFinite(n)) return options.naText || 'N/A';
      return rounded + ' mo';
    }
    if (options.signed) {
      if (rounded > 0) return '+' + money(rounded);
      return money(rounded);
    }
    return money(Math.abs(rounded));
  }

  // ─── Inputs ──────────────────────────────────────────────
  function formatHomeValue() {
    // Live type: update math without fighting the caret via aggressive reformat
    const raw = parseNum($('home-value').value);
    if (raw > 0) state.homeValue = raw;
    liveUpdate();
  }

  function formatHomeValueBlur() {
    const raw = parseNum($('home-value').value);
    state.homeValue = raw || state.homeValue;
    if ($('home-value')) $('home-value').value = Number(state.homeValue).toLocaleString();
    liveUpdate();
  }

  function syncHomeSlider() {
    state.homeValue = parseNum($('home-slider').value);
    $('home-value').value = state.homeValue.toLocaleString();
    liveUpdate();
  }

  function onNewLoanInput() {
    liveUpdate();
  }

  function onNewRateInput() {
    readStateFromDom();
    if ($('new-rate-slider') && state.newRate >= 2.5 && state.newRate <= 10) {
      $('new-rate-slider').value = state.newRate;
    }
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
    setModalOpen('mortgage-modal', true);
    if (fromDebts) setModalOpen('debts-modal', false);
    setTimeout(function () {
      if ($('modal-balance')) $('modal-balance').focus();
    }, 50);
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
      setModalOpen('mortgage-modal', false);
      liveUpdate();
      if (mortgageModalSource === 'debts') {
        setTimeout(openDebtsModal, 200);
      }
    } catch (e) {
      console.error(e);
      setModalOpen('mortgage-modal', false);
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
  const DEBT_TYPES = [
    { key: 'Credit Card', icon: 'fa-credit-card', tip: 'Usually high interest — strong refi candidate' },
    { key: 'Auto Loan', icon: 'fa-car', tip: 'Balance + monthly payment from your statement' },
    { key: 'Student Loan', icon: 'fa-graduation-cap', tip: 'Include federal or private loans you may consolidate' },
    { key: 'Personal Loan', icon: 'fa-hand-holding-dollar', tip: 'Unsecured loans and installment debt' },
    { key: 'HELOC', icon: 'fa-house-chimney', tip: 'Home equity line — often paid off in cash-out' },
    { key: 'Other', icon: 'fa-file-invoice-dollar', tip: 'Any other monthly debt obligation' }
  ];

  function debtIconFor(name) {
    const n = String(name || '').toLowerCase();
    if (n.indexOf('mortgage') !== -1) return 'fa-house';
    if (n.indexOf('card') !== -1 || n.indexOf('visa') !== -1 || n.indexOf('master') !== -1) return 'fa-credit-card';
    if (n.indexOf('auto') !== -1 || n.indexOf('car') !== -1) return 'fa-car';
    if (n.indexOf('student') !== -1) return 'fa-graduation-cap';
    if (n.indexOf('heloc') !== -1 || n.indexOf('equity') !== -1) return 'fa-house-chimney';
    if (n.indexOf('personal') !== -1) return 'fa-hand-holding-dollar';
    return 'fa-file-invoice-dollar';
  }

  function otherDebtsCount() {
    return state.debts.filter(function (d) { return d.name !== 'Current Mortgage'; }).length;
  }

  function selectedOtherDebtsCount() {
    return state.debts.filter(function (d) {
      return d.name !== 'Current Mortgage' && d.payOff;
    }).length;
  }

  function updateDebtSummaryStrip() {
    const count = otherDebtsCount();
    const selected = selectedOtherDebtsCount();
    const badge = $('debts-count-badge');
    if (badge) {
      if (count > 0) {
        badge.classList.remove('hidden');
        badge.textContent = String(count);
      } else {
        badge.classList.add('hidden');
      }
    }
    const htmlEmpty =
      '<button type="button" class="debts-summary-cta" onclick="RuoffApp.openDebtsModal()">' +
      '<i class="fas fa-plus-circle"></i> Add credit cards, auto loans, or other debts to model payoff</button>';
    let htmlFilled = '';
    if (count > 0) {
      const otherBal = C.otherDebtsPaidOff(state.debts);
      const otherPay = C.otherDebtMonthlyPayments(state.debts);
      const sizeNeeded = computeSizeLoanTarget();
      htmlFilled =
        '<div class="debts-summary-row">' +
          '<div><span class="font-semibold">' + selected + ' of ' + count + '</span> other debt' + (count === 1 ? '' : 's') +
          ' selected to pay off</div>' +
          '<div class="text-sm opacity-80">' +
            '<span class="font-bold number pos">' + money(otherPay) + '/mo</span> · ' +
            '<span class="font-bold number" style="color:var(--ruoff-orange)">' + money(otherBal) + '</span> balances' +
          '</div>' +
          '<div class="flex flex-wrap gap-2">' +
            (selected > 0
              ? '<button type="button" class="size-loan-btn" onclick="RuoffApp.sizeLoanToCoverDebts()"><i class="fas fa-magic mr-1"></i> Size loan to cover (' + money(sizeNeeded.target) + ')</button>'
              : '') +
            '<button type="button" class="text-sm font-semibold text-[var(--ruoff-teal)] hover:underline" onclick="RuoffApp.openDebtsModal()">Edit debts →</button>' +
          '</div>' +
        '</div>';
    }
    ['debts-summary-strip', 'debts-summary-strip-wizard'].forEach(function (id) {
      const strip = $(id);
      if (!strip) return;
      strip.innerHTML = count === 0 ? htmlEmpty : htmlFilled;
    });
  }

  /**
   * Loan amount to cover mortgage + selected debts + closing costs (capped by LTV).
   * Closing costs come from the Scenario field; if blank/zero, engine uses a $6,000 floor
   * so sizing does not understate cash needed.
   */
  function computeSizeLoanTarget() {
    readStateFromDom();
    ensureMortgageDebt();
    return C.sizeLoanToCover(
      state.currentBalance,
      state.debts,
      state.closingCosts,
      state.homeValue
    );
  }

  function sizeLoanDisclosureHtml(r) {
    const floorNote = r.usedClosingFloor
      ? ' (default $' + (r.closingFloor || 6000).toLocaleString() + ' — none entered)'
      : '';
    return (
      '<p class="size-loan-disclosure">' +
        '<span class="size-loan-disclosure-line">' +
          'Includes <strong class="number">' + money(r.closingCostsUsed) + '</strong> est. closing costs' +
          floorNote +
        '</span>' +
        '<span class="size-loan-disclosure-break">' +
          money(r.mortgagePayoff) + ' mortgage + ' +
          money(r.otherDebts) + ' debts + ' +
          money(r.closingCostsUsed) + ' costs' +
          (r.capped ? ' → capped at ' + r.maxLtvPct + '% LTV' : '') +
        '</span>' +
      '</p>'
    );
  }

  function sizeLoanToCoverDebts() {
    const r = computeSizeLoanTarget();
    // Persist the closing-cost assumption so cash-at-closing math matches the sized loan
    if (r.usedClosingFloor) {
      state.closingCosts = r.closingCostsUsed;
      if ($('closing-costs')) $('closing-costs').value = r.closingCostsUsed;
    }
    state.newLoanAmount = r.target;
    if ($('new-loan-amt')) $('new-loan-amt').value = r.target;
    liveUpdate();
    if (r.capped) {
      toast(
        'Loan sized to ' + money(r.target) + ' (max ' + r.maxLtvPct + '% LTV). ' +
        'Needed ' + money(r.needed) + ' including ' + money(r.closingCostsUsed) + ' est. closing costs.',
        'warn'
      );
    } else {
      toast(
        'New loan set to ' + money(r.target) +
        ' — mortgage + selected debts + ' + money(r.closingCostsUsed) + ' est. closing costs' +
        (r.usedClosingFloor ? ' (default applied)' : '')
      );
    }
    // Keep user in context: close debts modal so they see scenario update
    if ($('debts-modal') && !$('debts-modal').classList.contains('hidden')) {
      closeDebtsModal();
    }
    scrollToSection('scenario');
  }

  function openDebtsModal() {
    ensureMortgageDebt();
    expandedDebtIndex = null;
    renderDebts();
    setModalOpen('debts-modal', true);
    setActiveNav('debts');
  }

  function closeDebtsModal() {
    // If inline edit open, discard unsaved expand (data already saved on Save)
    expandedDebtIndex = null;
    saveToStorage();
    setModalOpen('debts-modal', false);
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
    let otherCount = 0;

    // Toolbar: size loan + quick add
    const toolbar = document.createElement('div');
    toolbar.className = 'debt-list-toolbar';
    const sizeInfo = computeSizeLoanTarget();
    toolbar.innerHTML =
      '<button type="button" class="size-loan-btn size-loan-btn-block" data-size-loan>' +
        '<i class="fas fa-magic"></i> Size new loan to cover selected debts' +
        '<span class="size-loan-amt">' + money(sizeInfo.target) + '</span>' +
      '</button>' +
      sizeLoanDisclosureHtml(sizeInfo) +
      (sizeInfo.capped
        ? '<p class="text-xs warn mt-1">Capped at ' + sizeInfo.maxLtvPct + '% LTV max (' + money(sizeInfo.maxLoan) + '). Full need ' + money(sizeInfo.needed) + '.</p>'
        : '');
    container.appendChild(toolbar);
    toolbar.querySelector('[data-size-loan]').addEventListener('click', sizeLoanToCoverDebts);

    // Quick-add row
    const quick = document.createElement('div');
    quick.className = 'debt-quick-add';
    quick.innerHTML =
      '<div class="text-xs font-semibold opacity-70 mb-2">Quick add</div>' +
      '<div class="flex flex-wrap gap-2">' +
      DEBT_TYPES.map(function (t) {
        return '<button type="button" class="debt-type-chip" data-quick-type="' + escapeHtml(t.key) + '">' +
          '<i class="fas ' + t.icon + '"></i> ' + escapeHtml(t.key) + '</button>';
      }).join('') +
      '</div>';
    container.appendChild(quick);
    quick.querySelectorAll('[data-quick-type]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        openAddDebtModal(btn.getAttribute('data-quick-type'));
      });
    });

    state.debts.forEach((d, i) => {
      if (d.name === 'Current Mortgage') {
        d.payOff = true;
        d.bal = state.currentBalance;
        d.pay = C.derivePi(state.totalPayment, state.taxes, state.insurance, state.pmi, state.escrowIncluded);
      } else {
        otherCount++;
      }
      if (d.payOff) {
        totalMonthly += Number(d.pay) || 0;
        totalPayoff += Number(d.bal) || 0;
      }

      const isMortgage = d.name === 'Current Mortgage';
      const isExpanded = !isMortgage && expandedDebtIndex === i;
      const row = document.createElement('div');
      row.className = 'debt-row glass rounded-2xl p-4 sm:p-5 ' +
        (isMortgage ? 'debt-row-mortgage' : (d.payOff ? 'debt-row-active' : 'debt-row-off')) +
        (isExpanded ? ' debt-row-expanded' : '');
      row.setAttribute('data-debt-index', String(i));

      if (isExpanded) {
        row.innerHTML = buildInlineEditHtml(d, i);
        container.appendChild(row);
        wireInlineEdit(row, i);
        return;
      }

      const meta = [];
      if (d.rate) meta.push(d.rate + '% APR');
      if (d.months) meta.push(d.months + ' mo left');
      const metaHtml = meta.length
        ? '<div class="text-xs opacity-60 mt-1">' + escapeHtml(meta.join(' · ')) + '</div>'
        : (isMortgage ? '' : '<div class="text-xs opacity-50 mt-1">Tap Edit to update · optional rate improves interest math</div>');

      row.innerHTML =
        '<div class="flex gap-3 items-start">' +
          '<div class="debt-icon" aria-hidden="true"><i class="fas ' + debtIconFor(d.name) + '"></i></div>' +
          '<div class="flex-1 min-w-0">' +
            '<div class="flex flex-wrap items-center gap-2">' +
              '<div class="text-base sm:text-lg font-semibold truncate">' + escapeHtml(d.name) + '</div>' +
              (isMortgage ? '<span class="debt-pill debt-pill-lock"><i class="fas fa-lock"></i> Always paid off</span>' : '') +
            '</div>' +
            '<div class="grid grid-cols-2 gap-3 mt-2">' +
              '<div><div class="text-[10px] uppercase tracking-wide opacity-50">Balance</div>' +
                '<div class="text-lg sm:text-xl font-black number">' + money(d.bal) + '</div></div>' +
              '<div><div class="text-[10px] uppercase tracking-wide opacity-50">Monthly</div>' +
                '<div class="text-lg sm:text-xl font-black number">' + money(d.pay) + '</div></div>' +
            '</div>' +
            metaHtml +
          '</div>' +
        '</div>' +
        '<div class="debt-row-actions mt-3 pt-3 border-t border-black/5 dark:border-white/10 flex flex-wrap items-center justify-between gap-3">' +
          (isMortgage
            ? '<button type="button" class="debt-action-btn" data-edit-mortgage><i class="fas fa-pencil-alt"></i> Edit mortgage</button>'
            : '<label class="debt-include-label">' +
                '<span class="debt-toggle"><input type="checkbox" data-debt-toggle="' + i + '" ' + (d.payOff ? 'checked' : '') + '>' +
                '<span class="debt-toggle-slider"></span></span>' +
                '<span class="text-sm font-medium">' + (d.payOff ? 'Include in refi' : 'Leave as-is') + '</span>' +
              '</label>') +
          (!isMortgage
            ? '<div class="flex items-center gap-1">' +
                '<button type="button" class="debt-action-btn" data-inline-edit="' + i + '"><i class="fas fa-pencil-alt"></i> Edit</button>' +
                '<button type="button" class="debt-action-btn debt-action-danger" data-remove-debt="' + i + '"><i class="fas fa-trash"></i></button>' +
              '</div>'
            : '') +
        '</div>';

      container.appendChild(row);
    });

    // Empty state for other debts
    if (otherCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'debt-empty-state';
      empty.innerHTML =
        '<div class="debt-empty-icon"><i class="fas fa-layer-group"></i></div>' +
        '<h4 class="font-bold text-lg mb-1">No other debts yet</h4>' +
        '<p class="text-sm opacity-70 mb-4 max-w-sm mx-auto">Add credit cards, auto loans, or student loans to see how paying them off with a refinance changes your monthly cash flow.</p>' +
        '<button type="button" class="px-5 py-2.5 bg-gradient-to-r from-[#00A89D] to-[#F15A29] text-white rounded-xl text-sm font-bold" data-empty-add>' +
        '<i class="fas fa-plus mr-1"></i> Add your first debt</button>';
      container.appendChild(empty);
      empty.querySelector('[data-empty-add]').addEventListener('click', function () {
        openAddDebtModal('Credit Card');
      });
    }

    container.querySelectorAll('[data-debt-toggle]').forEach(el => {
      el.addEventListener('change', () => {
        const i = parseInt(el.getAttribute('data-debt-toggle'), 10);
        state.debts[i].payOff = el.checked;
        renderDebts();
        liveUpdate();
      });
    });
    container.querySelectorAll('[data-inline-edit]').forEach(el => {
      el.addEventListener('click', () => {
        expandDebtInline(parseInt(el.getAttribute('data-inline-edit'), 10));
      });
    });
    container.querySelectorAll('[data-remove-debt]').forEach(el => {
      el.addEventListener('click', () => {
        const i = parseInt(el.getAttribute('data-remove-debt'), 10);
        const name = state.debts[i] && state.debts[i].name;
        if (confirm('Remove “' + (name || 'this debt') + '”?')) removeDebt(i);
      });
    });
    container.querySelectorAll('[data-edit-mortgage]').forEach(el => {
      el.addEventListener('click', switchToMortgageModal);
    });

    setText('modal-total-monthly', money(totalMonthly));
    setText('modal-total-payoff', money(totalPayoff));
    setText('modal-other-count', String(otherCount));
    updateDebtSummaryStrip();
  }

  function buildInlineEditHtml(d, i) {
    return (
      '<div class="inline-edit-header flex items-center justify-between gap-2 mb-3">' +
        '<div class="font-bold text-base"><i class="fas fa-pencil-alt text-[var(--ruoff-teal)] mr-2"></i>Edit debt</div>' +
        '<button type="button" class="text-sm opacity-60 hover:opacity-100" data-inline-cancel="' + i + '">Cancel</button>' +
      '</div>' +
      '<div class="space-y-3">' +
        '<div>' +
          '<label class="block text-xs opacity-70 mb-1">Name</label>' +
          '<input type="text" class="input-field" data-ie-name value="' + escapeHtml(d.name || '') + '" autocomplete="off">' +
        '</div>' +
        '<div class="grid grid-cols-2 gap-3">' +
          '<div><label class="block text-xs opacity-70 mb-1">Balance</label>' +
            '<div class="dollar-wrap"><span class="prefix">$</span>' +
            '<input type="text" inputmode="decimal" class="input-field" data-ie-bal value="' + (d.bal || '') + '" placeholder="0"></div></div>' +
          '<div><label class="block text-xs opacity-70 mb-1">Monthly</label>' +
            '<div class="dollar-wrap"><span class="prefix">$</span>' +
            '<input type="text" inputmode="decimal" class="input-field" data-ie-pay value="' + (d.pay || '') + '" placeholder="0"></div></div>' +
        '</div>' +
        '<div class="grid grid-cols-2 gap-3">' +
          '<div><label class="block text-xs opacity-70 mb-1">Rate % <span class="opacity-50">(optional)</span></label>' +
            '<input type="number" step="0.1" class="input-field text-center" data-ie-rate value="' + (d.rate || '') + '" placeholder="e.g. 22.9"></div>' +
          '<div><label class="block text-xs opacity-70 mb-1">Months left</label>' +
            '<input type="number" class="input-field text-center" data-ie-months value="' + (d.months || '') + '" placeholder="e.g. 36"></div>' +
        '</div>' +
        '<div class="flex flex-wrap gap-2 pt-1">' +
          '<button type="button" class="flex-1 py-2.5 bg-gradient-to-r from-[#00A89D] to-[#F15A29] text-white rounded-xl font-bold text-sm" data-inline-save="' + i + '">Save</button>' +
          '<button type="button" class="py-2.5 px-4 border border-zinc-300 dark:border-white/20 rounded-xl text-sm font-medium" data-inline-cancel="' + i + '">Cancel</button>' +
          '<button type="button" class="py-2.5 px-4 text-red-500 text-sm font-medium" data-remove-debt="' + i + '"><i class="fas fa-trash mr-1"></i>Remove</button>' +
        '</div>' +
      '</div>'
    );
  }

  function wireInlineEdit(row, i) {
    const save = function () {
      const name = (row.querySelector('[data-ie-name]').value || '').trim() || 'Debt';
      const bal = parseNum(row.querySelector('[data-ie-bal]').value);
      const pay = parseNum(row.querySelector('[data-ie-pay]').value);
      const rate = parseNum(row.querySelector('[data-ie-rate]').value);
      const months = parseNum(row.querySelector('[data-ie-months]').value);
      if (bal <= 0 && pay <= 0) {
        toast('Enter a balance or monthly payment', 'warn');
        return;
      }
      const prev = state.debts[i];
      state.debts[i] = {
        name: name,
        bal: bal,
        pay: pay,
        rate: rate,
        months: months,
        payOff: prev.payOff !== false,
        type: prev.type || ''
      };
      expandedDebtIndex = null;
      renderDebts();
      liveUpdate();
      saveToStorage();
      toast('Debt updated');
    };
    row.querySelectorAll('[data-inline-save]').forEach(function (btn) {
      btn.addEventListener('click', save);
    });
    row.querySelectorAll('[data-inline-cancel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        expandedDebtIndex = null;
        renderDebts();
      });
    });
    row.querySelectorAll('[data-remove-debt]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        if (confirm('Remove this debt?')) removeDebt(i);
      });
    });
    row.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        save();
      }
      if (e.key === 'Escape') {
        expandedDebtIndex = null;
        renderDebts();
      }
    });
    setTimeout(function () {
      const bal = row.querySelector('[data-ie-bal]');
      if (bal) bal.focus();
    }, 40);
  }

  function expandDebtInline(i) {
    const d = state.debts[i];
    if (!d || d.name === 'Current Mortgage') return;
    expandedDebtIndex = i;
    renderDebts();
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function resetAddDebtForm(prefillType) {
    const type = prefillType || '';
    if ($('new-debt-type')) $('new-debt-type').value = type;
    if ($('new-debt-name')) $('new-debt-name').value = type || '';
    if ($('new-debt-balance')) $('new-debt-balance').value = '';
    if ($('new-debt-pay')) $('new-debt-pay').value = '';
    if ($('new-debt-rate')) $('new-debt-rate').value = '';
    if ($('new-debt-months')) $('new-debt-months').value = '';
    syncDebtTypeChips(type);
    const tip = $('debt-type-tip');
    if (tip) {
      const found = DEBT_TYPES.find(function (t) { return t.key === type; });
      tip.textContent = found ? found.tip : 'Pick a type, then enter balance and monthly payment.';
    }
    const opt = $('debt-optional-fields');
    if (opt) opt.classList.add('hidden');
    const optToggle = $('debt-optional-toggle');
    if (optToggle) optToggle.setAttribute('aria-expanded', 'false');
  }

  function syncDebtTypeChips(activeType) {
    document.querySelectorAll('#add-debt-modal [data-debt-type-chip]').forEach(function (chip) {
      chip.classList.toggle('active', chip.getAttribute('data-debt-type-chip') === activeType);
    });
  }

  function selectDebtType(type) {
    if ($('new-debt-type')) $('new-debt-type').value = type;
    const nameEl = $('new-debt-name');
    if (nameEl) {
      // Only overwrite name if empty or still a known type label
      const cur = (nameEl.value || '').trim();
      const known = DEBT_TYPES.some(function (t) { return t.key === cur; });
      if (!cur || known) nameEl.value = type;
    }
    syncDebtTypeChips(type);
    const tip = $('debt-type-tip');
    if (tip) {
      const found = DEBT_TYPES.find(function (t) { return t.key === type; });
      tip.textContent = found ? found.tip : '';
    }
    if ($('new-debt-balance')) $('new-debt-balance').focus();
  }

  function toggleDebtOptional() {
    const opt = $('debt-optional-fields');
    const btn = $('debt-optional-toggle');
    if (!opt) return;
    const open = opt.classList.contains('hidden');
    opt.classList.toggle('hidden', !open);
    if (btn) {
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.innerHTML = open
        ? '<i class="fas fa-chevron-up mr-1"></i> Hide rate &amp; months'
        : '<i class="fas fa-chevron-down mr-1"></i> Optional: interest rate &amp; months left';
    }
  }

  function clearZeroOnFocus(el) {
    if (!el) return;
    el.addEventListener('focus', function () {
      if (el.value === '0' || el.value === '0.0' || el.value === '0.00') el.value = '';
    });
  }

  function setAddDebtSubmitLabel(text) {
    const label = $('add-debt-submit-label');
    if (label) label.textContent = text;
    else {
      const btn = $('add-debt-submit');
      if (btn) btn.textContent = text;
    }
  }

  function openAddDebtModal(prefillType) {
    const title = $('add-debt-title');
    if (editingDebtIndex === undefined) {
      resetAddDebtForm(prefillType || '');
      if (title) title.textContent = 'Add a debt';
      setAddDebtSubmitLabel('Save debt');
      const btn2 = $('add-debt-submit-another');
      if (btn2) {
        btn2.classList.remove('hidden');
        btn2.classList.remove('is-saved');
      }
    } else {
      if (title) title.textContent = 'Edit debt';
      setAddDebtSubmitLabel('Save changes');
      const btn2 = $('add-debt-submit-another');
      if (btn2) btn2.classList.add('hidden');
    }
    setModalOpen('add-debt-modal', true);
    setTimeout(function () {
      const focusEl = $('new-debt-balance') || $('new-debt-name');
      if (focusEl) focusEl.focus();
    }, 80);
  }

  function closeAddDebtModal() {
    setModalOpen('add-debt-modal', false);
    editingDebtIndex = undefined;
    setAddDebtSubmitLabel('Save debt');
    const btn2 = $('add-debt-submit-another');
    if (btn2) btn2.classList.remove('is-saved');
  }

  function readDebtForm() {
    const type = $('new-debt-type') ? $('new-debt-type').value : '';
    let name = ($('new-debt-name') && $('new-debt-name').value || '').trim();
    if (!name) name = type || 'Debt';
    return {
      type: type,
      name: name,
      bal: parseNum($('new-debt-balance') && $('new-debt-balance').value),
      pay: parseNum($('new-debt-pay') && $('new-debt-pay').value),
      rate: parseNum($('new-debt-rate') && $('new-debt-rate').value),
      months: parseNum($('new-debt-months') && $('new-debt-months').value)
    };
  }

  function addNewDebt(andAnother) {
    const form = readDebtForm();
    if (form.bal <= 0 && form.pay <= 0) {
      toast('Enter a balance or monthly payment', 'warn');
      if ($('new-debt-balance')) $('new-debt-balance').focus();
      return false;
    }

    if (editingDebtIndex !== undefined) {
      const prev = state.debts[editingDebtIndex];
      state.debts[editingDebtIndex] = {
        name: form.name,
        bal: form.bal,
        pay: form.pay,
        rate: form.rate,
        months: form.months,
        payOff: prev.payOff !== false,
        type: form.type || prev.type || ''
      };
      editingDebtIndex = undefined;
      toast('Debt updated');
      closeAddDebtModal();
    } else {
      state.debts.push({
        name: form.name,
        bal: form.bal,
        pay: form.pay,
        rate: form.rate,
        months: form.months,
        payOff: true,
        type: form.type || ''
      });
      toast(andAnother ? 'Saved — add the next one' : 'Debt added');
      if (andAnother) {
        resetAddDebtForm(form.type || '');
        const btn2 = $('add-debt-submit-another');
        if (btn2) {
          const icon = btn2.querySelector('.btn-debt-another-icon i');
          btn2.classList.remove('is-saved');
          void btn2.offsetWidth; // reflow so pulse restarts
          btn2.classList.add('is-saved');
          if (icon) {
            icon.classList.remove('fa-plus');
            icon.classList.add('fa-check');
          }
          clearTimeout(btn2._savedTimer);
          btn2._savedTimer = setTimeout(function () {
            btn2.classList.remove('is-saved');
            if (icon) {
              icon.classList.remove('fa-check');
              icon.classList.add('fa-plus');
            }
          }, 700);
        }
        setTimeout(function () {
          if ($('new-debt-balance')) $('new-debt-balance').focus();
        }, 50);
      } else {
        closeAddDebtModal();
      }
    }
    renderDebts();
    liveUpdate();
    saveToStorage();
    return true;
  }

  function editDebt(i) {
    // Prefer inline expand when debts list is open; fallback to modal
    if ($('debts-modal') && !$('debts-modal').classList.contains('hidden')) {
      expandDebtInline(i);
      return;
    }
    const d = state.debts[i];
    if (!d || d.name === 'Current Mortgage') return;
    editingDebtIndex = i;
    const typeGuess = d.type || (DEBT_TYPES.find(function (t) {
      return d.name && d.name.indexOf(t.key) === 0;
    }) || {}).key || '';
    if ($('new-debt-type')) $('new-debt-type').value = typeGuess;
    if ($('new-debt-name')) $('new-debt-name').value = d.name || '';
    if ($('new-debt-balance')) $('new-debt-balance').value = d.bal ? String(d.bal) : '';
    if ($('new-debt-pay')) $('new-debt-pay').value = d.pay ? String(d.pay) : '';
    if ($('new-debt-rate')) $('new-debt-rate').value = d.rate ? String(d.rate) : '';
    if ($('new-debt-months')) $('new-debt-months').value = d.months ? String(d.months) : '';
    syncDebtTypeChips(typeGuess);
    if ((d.rate || d.months) && $('debt-optional-fields')) {
      $('debt-optional-fields').classList.remove('hidden');
    }
    openAddDebtModal();
  }

  // ─── Mini-nav ────────────────────────────────────────────
  function scrollToSection(key) {
    const map = {
      home: 'section-home',
      mortgage: 'section-mortgage',
      scenario: 'section-scenario',
      debts: 'section-scenario',
      plan: 'section-plan'
    };
    if (key === 'debts') {
      openDebtsModal();
      return;
    }
    if (key === 'mortgage') {
      const el = $(map.mortgage);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveNav('mortgage');
      return;
    }
    const id = map[key];
    const el = id ? $(id) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      setActiveNav(key);
    }
    if (key === 'plan') {
      const results = $('results-area');
      if (results && !results.classList.contains('hidden')) {
        results.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    }
  }

  function setActiveNav(key) {
    document.querySelectorAll('.mini-nav-btn').forEach(function (btn) {
      btn.classList.toggle('active', btn.getAttribute('data-nav') === key);
    });
  }

  function initMiniNav() {
    document.querySelectorAll('.mini-nav-btn').forEach(function (btn) {
      btn.addEventListener('click', function () {
        scrollToSection(btn.getAttribute('data-nav'));
      });
    });
    // Highlight section in view
    const sections = [
      { key: 'home', id: 'section-home' },
      { key: 'mortgage', id: 'section-mortgage' },
      { key: 'scenario', id: 'section-scenario' },
      { key: 'plan', id: 'section-plan' }
    ];
    if ('IntersectionObserver' in window) {
      const obs = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          const found = sections.find(function (s) { return s.id === entry.target.id; });
          if (found) setActiveNav(found.key);
        });
      }, { rootMargin: '-30% 0px -50% 0px', threshold: 0.01 });
      sections.forEach(function (s) {
        const el = $(s.id);
        if (el) obs.observe(el);
      });
    }
  }

  function removeDebt(i) {
    if (state.debts[i] && state.debts[i].name === 'Current Mortgage') return;
    state.debts.splice(i, 1);
    if (expandedDebtIndex === i) expandedDebtIndex = null;
    else if (expandedDebtIndex != null && expandedDebtIndex > i) expandedDebtIndex -= 1;
    renderDebts();
    liveUpdate();
    toast('Debt removed');
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
    setModalOpen('detail-modal', true);
  }

  function closeDetailModal() {
    setModalOpen('detail-modal', false);
  }

  function showHelp(title, content) {
    $('help-title').textContent = title;
    $('help-content').innerHTML = content;
    setModalOpen('help-modal', true);
  }

  function closeHelp() {
    setModalOpen('help-modal', false);
  }

  // ─── Smart Plan loading modal ────────────────────────────
  let planLoadingTimer = null;
  let planLoadingStep = 0;

  const PLAN_LOADING_STATUSES = MODE === 'borrower'
    ? [
        'Locking in your scenario numbers…',
        'Comparing rate-and-term vs debt payoff options…',
        'Writing a clear plan in plain language…',
        'Almost done — assembling your summary…'
      ]
    : [
        'Locking in your scenario numbers…',
        'Comparing rate-and-term vs debt payoff alternatives…',
        'Writing client narrative, scripts, and follow-up…',
        'Assembling tabs for the meeting…'
      ];

  function fillPlanLoadingKpis(scenario) {
    const s = scenario || lastScenario;
    if (!s) return;
    const cf = s.monthlyCashFlowChange;
    const cfEl = $('plan-loading-cf');
    if (cfEl) {
      cfEl.textContent = (cf > 0 ? '+' : '') + money(cf);
      cfEl.className = 'plan-kpi-value number ' + (cf > 0 ? 'pos' : cf < 0 ? 'neg' : '');
    }
    setText('plan-loading-loan', money(s.newLoanAmount));
    const cashEl = $('plan-loading-cash');
    if (cashEl) {
      cashEl.textContent = s.cashAtClosing === 0
        ? 'Even'
        : ((s.isCashBack ? 'Back ' : 'Due ') + money(Math.abs(s.cashAtClosing)));
    }
  }

  function setPlanLoadingStep(step) {
    planLoadingStep = Math.max(0, Math.min(PLAN_LOADING_STATUSES.length - 1, step));
    const bar = $('plan-loading-bar');
    if (bar) {
      const pct = 12 + (planLoadingStep / (PLAN_LOADING_STATUSES.length - 1)) * 78;
      bar.style.width = pct + '%';
    }
    const status = $('plan-loading-status');
    if (status) {
      status.classList.add('is-fading');
      setTimeout(function () {
        status.textContent = PLAN_LOADING_STATUSES[planLoadingStep] || PLAN_LOADING_STATUSES[0];
        status.classList.remove('is-fading');
      }, 160);
    }
    document.querySelectorAll('#plan-loading-steps [data-plan-step]').forEach(function (li) {
      const i = parseInt(li.getAttribute('data-plan-step'), 10);
      li.classList.toggle('active', i === planLoadingStep);
      li.classList.toggle('done', i < planLoadingStep);
      const dot = li.querySelector('.pls-dot');
      if (dot) {
        if (i < planLoadingStep) {
          dot.innerHTML = '<i class="fas fa-check" style="font-size:0.6rem"></i>';
        } else {
          dot.textContent = String(i + 1);
        }
      }
    });
  }

  function startPlanLoadingUI(scenario) {
    fillPlanLoadingKpis(scenario);
    setPlanLoadingStep(0);
    const bar = $('plan-loading-bar');
    if (bar) bar.style.width = '10%';
    clearInterval(planLoadingTimer);
    let step = 0;
    planLoadingTimer = setInterval(function () {
      step = Math.min(step + 1, PLAN_LOADING_STATUSES.length - 1);
      setPlanLoadingStep(step);
      if (step >= PLAN_LOADING_STATUSES.length - 1) {
        clearInterval(planLoadingTimer);
        planLoadingTimer = null;
      }
    }, 2200);
  }

  function stopPlanLoadingUI(complete) {
    clearInterval(planLoadingTimer);
    planLoadingTimer = null;
    if (complete) {
      const bar = $('plan-loading-bar');
      if (bar) bar.style.width = '100%';
      setPlanLoadingStep(PLAN_LOADING_STATUSES.length - 1);
      const status = $('plan-loading-status');
      if (status) status.textContent = MODE === 'borrower' ? 'Plan ready' : 'Smart Plan ready';
    }
  }

  // ─── AI plan generation ──────────────────────────────────
  async function generateSmartPlan() {
    if (generatingPlan) return;
    if (!lastScenario) liveUpdate();

    // Soft block only for hard math problems
    if (state.homeValue <= 0 || state.currentBalance < 0) {
      toast('Enter a valid home value and mortgage balance first', 'warn');
      return;
    }

    generatingPlan = true;
    document.querySelectorAll('[data-generate-btn]').forEach(function (btn) {
      btn.disabled = true;
      btn.classList.add('opacity-70', 'pointer-events-none');
    });
    const modal = $('loading-modal');
    startPlanLoadingUI(lastScenario);
    if (modal) setModalOpen('loading-modal', true);

    const client = collectClient();
    saveClient();
    readStateFromDom();
    ensureMortgageDebt();
    const numbers = C.buildCanonicalNumbers(lastScenario, client);
    // Precomputed alternate paths (same engine) so AI can recommend debt payoff vs rate-and-term safely
    const altPack = C.buildScenarioAlternatives({
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
    numbers.scenarioAlternatives = altPack.alternatives;
    numbers.comparisonHints = altPack.comparisonHints;
    window.clientCalcData = numbers;
    window.__canonicalNumbers = numbers;

    const branding = state.branding;
    const isLo = MODE === 'lo';

    const systemRules =
      'You are the Refinance Strategist for Ruoff Mortgage. ' +
      'CRITICAL: CANONICAL NUMBERS and SCENARIO ALTERNATIVES are provided. Use ONLY those figures. ' +
      'Do not recalculate payments, interest, LTV, cash back, or break-even. ' +
      'If a value is null, say it is not applicable. ' +
      'Never use emojis. Return ONLY valid JSON. Use semantic HTML in string values: h2,h3,p,ul,li,table,strong,em.\n' +
      'PRIMARY vs ALTERNATIVE:\n' +
      '- The PRIMARY path is the current calculator selection (id "primary" in scenarioAlternatives). ' +
      'Narrate it as the plan the LO/client just modeled — all top-level canonical numbers match primary.\n' +
      '- SCENARIO ALTERNATIVES are other paths the engine already calculated (rate-and-term only, high-APR debts only, all debts, etc.).\n' +
      '- You MUST include an "Alternative recommendation" subsection in recommendedPlan that compares at least one non-primary alternative when it is present.\n' +
      '- If an alternative has better monthlyCashFlowChange and/or consumerDebtInterestAvoided (especially high-APR payoff), say so clearly and recommend discussing that path — still using only the alternative object figures.\n' +
      '- If primary is already the stronger path, say why (cite the metrics) and still briefly note what rate-and-term-only would look like.\n' +
      '- Never invent a loan amount, payment, or interest figure that is not in primary or an alternative object.\n' +
      'DEBT RATE & TERM RULES:\n' +
      '- Each debt may include interestRate, remainingMonths, interestAvoidedIfPaidOff, and priorityHint.\n' +
      '- When interestRate or remainingMonths is present (>0), cite them in benefits and recommendations.\n' +
      '- Prioritize high_apr_priority debts when explaining why consolidation may make more sense than rate-and-term alone.\n' +
      '- If hasRateOrTermDetail is false, do NOT invent an APR or term — note that rate/term was not provided.';

    let outputSchema;
    let sectionInstructions;

    if (isLo) {
      outputSchema = '{ "executiveSummary": "...", "scenarioComparison": "...", "recommendedPlan": "...", "salesScripts": "...", "followUpSequence": "..." }';
      sectionInstructions =
        'executiveSummary: Client-facing. Warm headline, biggest wins for the PRIMARY path (cash flow, debts paid, consumerDebtInterestAvoided when >0). Brief one-sentence teaser if an alternative is stronger for debt payoff. Before/after for primary, break-even, LO contact.\n' +
        'scenarioComparison: HTML table Current vs PRIMARY proposed; optional second mini-table or rows comparing primary vs best alternative cash-flow and debts paid (from scenarioAlternatives only).\n' +
        'recommendedPlan: (1) Primary plan with exact loan amount/rate/term and debts marked payOff. (2) Required h3 "Alternative recommendation" — compare rate-and-term-only and/or high-APR consolidation using scenarioAlternatives metrics; say which may make more sense and why (cash flow, interest avoided, LTV/cash at close trade-offs). (3) Risks and timeline.\n' +
        'salesScripts: 5 scripts; at least one can open the alternative debt-payoff conversation when alternatives show a win.\n' +
        'followUpSequence: 30-day Day 1/3/7/14/30 touchpoints with full copy.\n' +
        'LO Profile: ' + (branding.name || 'Loan Officer') + ', NMLS ' + (branding.nmls || '—') +
        ', ' + (branding.cell || '') + ', ' + (branding.email || '');
    } else {
      outputSchema = '{ "summary": "...", "scenarioComparison": "...", "recommendedPlan": "..." }';
      sectionInstructions =
        'summary: Warm borrower summary for the PRIMARY path. Mention cash-flow change and consumerDebtInterestAvoided when >0. Soft CTA to contact LO.\n' +
        'scenarioComparison: Clean HTML table Current vs Primary. If useful, one short note comparing to an alternative from scenarioAlternatives.\n' +
        'recommendedPlan: Clear primary recommendation; respect years remaining (' + numbers.yearsRemaining +
        '). Required section "Another option to discuss" using scenarioAlternatives (e.g. rate-and-term only vs paying off higher-rate debts). List debts with rate/months when provided. Do not invent numbers.';
    }

    const prompt =
      systemRules + '\n\nOUTPUT JSON SHAPE:\n' + outputSchema + '\n\nSECTION RULES:\n' + sectionInstructions +
      '\n\nDEBT INSIGHTS (precomputed — do not recalculate):\n' +
      JSON.stringify(numbers.debtInsights || {}, null, 2) +
      '\n\nSCENARIO ALTERNATIVES (precomputed — use for alternative recommendation):\n' +
      JSON.stringify({
        alternatives: numbers.scenarioAlternatives,
        comparisonHints: numbers.comparisonHints
      }, null, 2) +
      '\n\nCANONICAL NUMBERS — PRIMARY PATH (source of truth):\n' + JSON.stringify(numbers, null, 2);

    try {
      $('results-area').classList.remove('hidden');
      // Keep results area calm while the modal carries the progress UI
      $('tab-content').innerHTML =
        '<div class="text-center py-16 opacity-70">' +
        '<p class="text-sm font-semibold">Generating Smart Plan…</p>' +
        '<p class="text-xs mt-2 opacity-70">Your locked numbers stay on screen in the progress modal.</p></div>';

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
      $('results-area').classList.remove('hidden');
      setActiveNav('plan');
      stopPlanLoadingUI(true);
      // Brief beat so the full progress bar is visible before close
      await new Promise(function (r) { setTimeout(r, 280); });
      $('results-area').scrollIntoView({ behavior: 'smooth', block: 'start' });
      toast('Smart Plan ready');
      celebrateGenerateSuccess();
    } catch (e) {
      console.error(e);
      // Offline / API-down fallback: deterministic plan from numbers
      window.currentPlan = { tabs: buildFallbackPlan(numbers, isLo) };
      setResultsClientName(numbers.clientName);
      showTab(0);
      $('results-area').classList.remove('hidden');
      setActiveNav('plan');
      stopPlanLoadingUI(true);
      await new Promise(function (r) { setTimeout(r, 200); });
      toast('AI unavailable — showing calculated plan instead', 'warn');
      celebrateGenerateSuccess();
    } finally {
      generatingPlan = false;
      stopPlanLoadingUI(false);
      if (modal) setModalOpen('loading-modal', false);
      document.querySelectorAll('[data-generate-btn]').forEach(function (btn) {
        btn.disabled = false;
        btn.classList.remove('opacity-70', 'pointer-events-none');
      });
    }
  }

  function buildFallbackPlan(n, isLo) {
    const cashLabel = n.cashAtClosingLabel === 'cash_back' ? 'Estimated cash back' : 'Estimated cash to close';
    const consumerDebts = (n.debts || []).filter(function (d) {
      return d.payOff && d.name !== 'Current Mortgage' && !d.isMortgage;
    });
    const debtListHtml = consumerDebts.length
      ? '<ul>' + consumerDebts.map(function (d) {
          const bits = [money(d.balance) + ' balance', money(d.monthlyPayment) + '/mo'];
          if (d.interestRate > 0) bits.push(d.interestRate + '% APR');
          if (d.remainingMonths > 0) bits.push(d.remainingMonths + ' mo left');
          if (d.interestAvoidedIfPaidOff > 0) bits.push('~' + money(d.interestAvoidedIfPaidOff) + ' interest avoided');
          return '<li><strong>' + escapeHtml(d.name) + '</strong> — ' + bits.join(' · ') + '</li>';
        }).join('') + '</ul>'
      : '<p class="opacity-70">No other consumer debts marked for payoff.</p>';

    const summary =
      '<h2>Great News, ' + escapeHtml((n.clientName || 'there').split(' ')[0]) + '!</h2>' +
      '<p>Based on the numbers in your calculator (not a loan offer), here is a clear snapshot.</p>' +
      '<div class="glass rounded-2xl p-6 my-4">' +
      '<p><strong>Monthly cash-flow change:</strong> ' + money(n.monthlyCashFlowChange) + '</p>' +
      '<p><strong>New total housing (est.):</strong> ' + money(n.newTotalHousing) + ' (P&I ' + money(n.newPi) + ')</p>' +
      '<p><strong>Debts paid off:</strong> ' + money(n.totalDebtsPaidOff) + '</p>' +
      (n.consumerDebtInterestAvoided > 0
        ? '<p><strong>Est. consumer debt interest avoided:</strong> ' + money(n.consumerDebtInterestAvoided) + ' (from rates/terms entered)</p>'
        : '') +
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
      '</tbody></table>' +
      '<h3 class="mt-4">Debts marked for payoff</h3>' + debtListHtml;

    let altHtml = '';
    const alts = n.scenarioAlternatives || [];
    if (alts.length > 1) {
      altHtml =
        '<h3>Alternative paths (calculated)</h3>' +
        '<p class="text-sm opacity-80">Same engine as the primary path — compare before choosing.</p><ul>' +
        alts.filter(function (a) { return a.id !== 'primary'; }).map(function (a) {
          return '<li><strong>' + escapeHtml(a.label) + '</strong>: loan ' + money(a.newLoanAmount) +
            ', cash-flow ' + money(a.monthlyCashFlowChange) +
            ', consumer interest avoided ' + money(a.consumerDebtInterestAvoided || 0) +
            (a.debtsPaidOffNames && a.debtsPaidOffNames.length
              ? ' · pays off ' + escapeHtml(a.debtsPaidOffNames.join(', '))
              : ' · mortgage only') +
            '</li>';
        }).join('') +
        '</ul>';
    }

    const plan =
      '<h2>Recommended discussion points</h2>' +
      '<ul>' +
      '<li>Proposed loan: ' + money(n.newLoanAmount) + ' at ' + n.newRate + '% for ' + n.newTerm + ' years</li>' +
      '<li>Monthly cash-flow change: ' + money(n.monthlyCashFlowChange) + '</li>' +
      '<li>' + cashLabel + ': ' + money(Math.abs(n.cashAtClosing)) + ' (includes ' + money(n.closingCosts) + ' est. closing costs)</li>' +
      (n.consumerDebtInterestAvoided > 0
        ? '<li>Consumer debt interest avoided (est.): ' + money(n.consumerDebtInterestAvoided) + '</li>'
        : '<li>Add optional rate &amp; months on high-APR debts for stronger interest-avoided estimates</li>') +
      '<li>Review each debt marked for payoff with your loan officer</li>' +
      '</ul>' +
      debtListHtml +
      altHtml +
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
    if (emailModal) setModalOpen('email-loading-modal', true);

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
      if (emailModal) setModalOpen('email-loading-modal', false);
    }
  }

  function buildBorrowerSnapshotBody(client, s, loName) {
    const cf = s.monthlyCashFlowChange;
    const debts = (state.debts || []).filter(function (d) {
      return d.payOff && d.name !== 'Current Mortgage';
    });
    const debtLines = debts.length
      ? debts.map(function (d) {
          return '  · ' + d.name + ': ' + money(d.bal) + ' balance · ' + money(d.pay) + '/mo';
        }).join('\n')
      : '  · Mortgage only (no extra debts selected)';
    const interestLine = s.mortgageInterest
      ? (s.mortgageInterest.savings >= 0
          ? money(s.mortgageInterest.savings) + ' less interest vs keep current (est.)'
          : money(Math.abs(s.mortgageInterest.savings)) + ' more interest vs keep current (est.)')
      : 'N/A';

    return (
      'Hi ' + loName + ',\n\n' +
      'I used the Ruoff Smart Savings Calculator and would like to talk through this scenario.\n\n' +
      '── My contact ──\n' +
      'Name: ' + (client.clientName || '') + '\n' +
      'Phone: ' + (client.clientPhone || '(not provided)') + '\n' +
      'Email: ' + (client.clientEmail || '(not provided)') + '\n\n' +
      '── Snapshot (estimates only — not a loan offer) ──\n' +
      'Today housing: ' + money(s.oldHousing) + ' (P&I ' + money(s.oldPi) + ')\n' +
      'Proposed housing: ' + money(s.newHousing) + ' (P&I ' + money(s.newPi) + ')\n' +
      'Cash-flow change: ' + (cf > 0 ? '+' : '') + money(cf) + ' / month\n' +
      (s.cashAtClosing === 0
        ? 'At closing: even\n'
        : (s.isCashBack ? 'Est. cash back: ' : 'Est. cash to close: ') + money(Math.abs(s.cashAtClosing)) + '\n') +
      'Break-even: ' + (s.breakEvenMonths != null ? s.breakEvenMonths + ' months' : 'N/A') + '\n' +
      'Home value: ' + money(s.homeValue) + ' · Equity: ' + money(s.equity) + ' · LTV: ' + s.ltv + '%\n' +
      'Proposed loan: ' + money(s.newLoanAmount) + ' @ ' + s.newRate + '% / ' + s.newTerm + ' years\n' +
      'New LTV: ' + s.newLtv + '% · Closing costs (est.): ' + money(s.closingCosts) + '\n' +
      'Interest: ' + interestLine + '\n' +
      'Debts included in payoff:\n' + debtLines + '\n\n' +
      'Goals / notes:\n' + (client.clientNotes || 'None entered') + '\n\n' +
      'Thank you!\n' + (client.clientName || '')
    );
  }

  function contactMyLO() {
    const client = collectClient();
    saveClient();
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const loEmail = (state.loContact && state.loContact.email) || '';
    const loName = (state.loContact && state.loContact.name) || 'there';

    const subject = 'Refinance snapshot – ' + (client.clientName || 'borrower') +
      ' · ' + (s.monthlyCashFlowChange > 0 ? '+' : '') + money(s.monthlyCashFlowChange) + ' cash flow';
    const body = buildBorrowerSnapshotBody(client, s, loName);

    if (!loEmail) {
      toast('Tip: ask your LO for a personal link so their email is pre-filled. Opening your mail app…');
    } else {
      toast('Opening email to ' + (state.loContact.name || 'your loan officer') + '…');
    }
    window.location.href =
      'mailto:' + encodeURIComponent(loEmail) +
      '?subject=' + encodeURIComponent(subject) +
      '&body=' + encodeURIComponent(body);
  }

  /** Alias used by borrower CTAs */
  function sendToMyLO() {
    contactMyLO();
  }

  function copyBorrowerLink() {
    // Pull latest branding fields even if not re-saved
    if ($('branding-name')) {
      state.branding.name = $('branding-name').value.trim() || state.branding.name;
      state.branding.nmls = $('branding-nmls') ? $('branding-nmls').value.trim() : state.branding.nmls;
      state.branding.email = $('branding-email') ? $('branding-email').value.trim() : state.branding.email;
      state.branding.cell = $('branding-cell') ? $('branding-cell').value.trim() : state.branding.cell;
      state.branding.color = $('branding-color') ? $('branding-color').value : state.branding.color;
      state.branding.accent = $('branding-accent') ? $('branding-accent').value : state.branding.accent;
      state.branding.photo = $('branding-photo') ? $('branding-photo').value.trim() : state.branding.photo;
    }
    if (!state.branding.email && !state.branding.name) {
      toast('Save your branding first so the link includes your contact info', 'warn');
    }
    let base = window.location.origin + '/borrower.html';
    if (/index\.html$/i.test(window.location.pathname)) {
      base = window.location.origin + window.location.pathname.replace(/index\.html$/i, 'borrower.html');
    } else if (window.location.pathname && window.location.pathname !== '/') {
      const dir = window.location.pathname.replace(/\/[^/]*$/, '/');
      base = window.location.origin + dir + 'borrower.html';
    }
    const params = new URLSearchParams();
    if (state.branding.name) params.set('loName', state.branding.name);
    if (state.branding.email) params.set('loEmail', state.branding.email);
    if (state.branding.cell) params.set('loPhone', state.branding.cell);
    if (state.branding.nmls) params.set('loNmls', state.branding.nmls);
    if (state.branding.color) params.set('loColor', state.branding.color);
    if (state.branding.accent) params.set('loAccent', state.branding.accent);
    if (state.branding.photo) params.set('loPhoto', state.branding.photo);
    const url = base + (params.toString() ? '?' + params.toString() : '');
    navigator.clipboard.writeText(url).then(function () {
      toast('Branded borrower link copied');
    }).catch(function () {
      prompt('Copy this borrower link:', url);
    });
  }

  // ─── Theme ───────────────────────────────────────────────
  function initTheme() {
    const toggle = $('theme-toggle');
    const saved = localStorage.getItem(THEME_KEY);
    // Dark-first glam default for presentation quality
    const dark = saved ? saved === 'dark' : true;
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

    // Resolve Grok proxy (local /grok only if hasKey; else Render — key never in browser)
    resolveGrokEndpoint().then(function (ep) {
      console.info('[Ruoff] Grok proxy:', ep, '(API key stays on server)');
    }).catch(function () { /* ignore */ });

    // Accordion maxHeight fix on resize
    window.addEventListener('resize', () => {
      ['client-info-content', 'branding-content'].forEach(id => {
        const el = $(id);
        if (el && el.style.maxHeight && el.style.maxHeight !== '0px') {
          el.style.maxHeight = el.scrollHeight + 'px';
        }
      });
    });

    // Escape closes topmost modal (not loading)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeTopModal();
    });

    updateBrandingChip();
    updateDebtSummaryStrip();
    initMiniNav();
    syncTermSegmented();
    loadSavedScenarios();
    renderScenarioCompare();

    // Experience mode: LO defaults to Full workspace; borrower to Guided.
    // Only honor a saved preference if the user has toggled before.
    wireModeToggle();
    let savedMode = null;
    try { savedMode = localStorage.getItem('ruoff.experienceMode.' + MODE); } catch (e) {}
    if (!savedMode) {
      savedMode = MODE === 'lo' ? 'expert' : 'guided';
    }
    restoreWizardProgress();
    setExperienceMode(savedMode, { silent: true });
    if (experienceMode === 'guided') {
      goToWizardStep(wizardStep, { silent: true });
    }

    // Resume banner if returning mid-flow
    if (wizardStep > 0 && experienceMode === 'guided') {
      const banner = $('resume-banner');
      if (banner) {
        banner.classList.remove('hidden');
        setText('resume-banner-text',
          'Welcome back — resuming at “' + WIZARD_STEPS[wizardStep].label + '” (step ' + (wizardStep + 1) + ' of ' + WIZARD_STEPS.length + ').');
      }
    }

    // Debt form: clear placeholder zeros, Enter to save
    ['new-debt-balance', 'new-debt-pay', 'new-debt-rate', 'new-debt-months'].forEach(function (id) {
      clearZeroOnFocus($(id));
    });
    const addDebtModal = $('add-debt-modal');
    if (addDebtModal) {
      addDebtModal.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target && e.target.tagName !== 'TEXTAREA') {
          e.preventDefault();
          addNewDebt(false);
        }
      });
    }

    // Arrow keys for wizard (when not typing in an input)
    document.addEventListener('keydown', function (e) {
      if (experienceMode !== 'guided') return;
      if (openModalIds.length) return;
      const tag = (e.target && e.target.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable)) return;
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        if (e.key === 'Enter' && tag === 'BUTTON') return;
        // don't hijack Enter globally — only ArrowRight
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          wizardNext();
        }
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        wizardBack();
      }
    });
  }

  function dismissResumeBanner() {
    const banner = $('resume-banner');
    if (banner) banner.classList.add('hidden');
  }

  function restartWizard() {
    wizardStep = 0;
    wizardMaxReached = 0;
    try {
      localStorage.setItem(WIZARD_STEP_KEY, '0');
      localStorage.setItem(MAX_WIZARD_REACHED_KEY, '0');
    } catch (e) { /* ignore */ }
    dismissResumeBanner();
    setExperienceMode('guided');
    goToWizardStep(0);
    toast('Starting from the beginning');
  }

  // ─── Multi-scenario A/B compare ──────────────────────────
  function loadSavedScenarios() {
    try {
      const raw = localStorage.getItem(SCENARIOS_KEY);
      savedScenarios = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(savedScenarios)) savedScenarios = [];
    } catch (e) {
      savedScenarios = [];
    }
  }

  function persistScenarios() {
    try { localStorage.setItem(SCENARIOS_KEY, JSON.stringify(savedScenarios.slice(0, 4))); } catch (e) {}
  }

  function captureScenarioSnapshot(label) {
    if (!lastScenario) liveUpdate();
    readStateFromDom();
    return {
      id: 's_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      label: label || ('Scenario ' + (savedScenarios.length + 1)),
      savedAt: new Date().toISOString(),
      inputs: {
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
        debts: JSON.parse(JSON.stringify(state.debts || []))
      },
      metrics: {
        monthlyCashFlowChange: lastScenario.monthlyCashFlowChange,
        newHousing: lastScenario.newHousing,
        oldHousing: lastScenario.oldHousing,
        cashAtClosing: lastScenario.cashAtClosing,
        isCashBack: lastScenario.isCashBack,
        breakEvenMonths: lastScenario.breakEvenMonths,
        totalDebtsPaidOff: lastScenario.totalDebtsPaidOff,
        newPi: lastScenario.newPi,
        mortgageInterestSavings: lastScenario.mortgageInterest && lastScenario.mortgageInterest.savings,
        newLtv: lastScenario.newLtv
      }
    };
  }

  function saveScenarioSlot(slot) {
    // slot: 'A' | 'B' | null (auto)
    const label = slot === 'A' || slot === 'B'
      ? slot
      : prompt('Name this scenario', 'Scenario ' + (savedScenarios.length + 1));
    if (label === null) return;
    const snap = captureScenarioSnapshot(String(label).trim() || 'Scenario');
    // Replace existing same label A/B
    if (snap.label === 'A' || snap.label === 'B') {
      savedScenarios = savedScenarios.filter(function (s) { return s.label !== snap.label; });
    }
    savedScenarios.unshift(snap);
    savedScenarios = savedScenarios.slice(0, 4);
    persistScenarios();
    renderScenarioCompare();
    toast('Saved “' + snap.label + '”');
  }

  function loadScenarioById(id) {
    const snap = savedScenarios.find(function (s) { return s.id === id; });
    if (!snap) return;
    const i = snap.inputs;
    state.homeValue = i.homeValue;
    state.currentBalance = i.currentBalance;
    state.currentRate = i.currentRate;
    state.yearsRemaining = i.yearsRemaining;
    state.totalPayment = i.totalPayment;
    state.taxes = i.taxes;
    state.insurance = i.insurance;
    state.pmi = i.pmi;
    state.escrowIncluded = i.escrowIncluded;
    state.newLoanAmount = i.newLoanAmount;
    state.newRate = i.newRate;
    state.newTerm = i.newTerm;
    state.closingCosts = i.closingCosts;
    state.debts = i.debts || [];
    hydrateDomFromState();
    ensureMortgageDebt();
    liveUpdate();
    toast('Loaded “' + snap.label + '”');
    if (experienceMode === 'guided') goToWizardStep(4); // scenario step
  }

  function deleteScenario(id) {
    savedScenarios = savedScenarios.filter(function (s) { return s.id !== id; });
    persistScenarios();
    renderScenarioCompare();
  }

  function clearScenarios() {
    if (!savedScenarios.length) return;
    if (!confirm('Clear all saved scenarios?')) return;
    savedScenarios = [];
    persistScenarios();
    renderScenarioCompare();
    toast('Scenarios cleared');
  }

  function renderScenarioCompare() {
    const el = $('scenario-compare');
    if (!el) return;
    if (!savedScenarios.length) {
      el.innerHTML =
        '<div class="scenario-compare-empty">' +
        '<p class="text-sm opacity-70 mb-3">Save scenarios to compare side-by-side (great for client meetings).</p>' +
        '<div class="flex flex-wrap gap-2">' +
        '<button type="button" class="size-loan-btn" onclick="RuoffApp.saveScenarioSlot(\'A\')">Save as A</button>' +
        '<button type="button" class="size-loan-btn" onclick="RuoffApp.saveScenarioSlot(\'B\')">Save as B</button>' +
        '<button type="button" class="btn-ghost text-sm py-2" onclick="RuoffApp.saveScenarioSlot()">Save named…</button>' +
        '</div></div>';
      return;
    }

    const current = lastScenario ? {
      label: 'Current',
      metrics: {
        monthlyCashFlowChange: lastScenario.monthlyCashFlowChange,
        newHousing: lastScenario.newHousing,
        cashAtClosing: lastScenario.cashAtClosing,
        isCashBack: lastScenario.isCashBack,
        breakEvenMonths: lastScenario.breakEvenMonths,
        totalDebtsPaidOff: lastScenario.totalDebtsPaidOff,
        newPi: lastScenario.newPi,
        newLtv: lastScenario.newLtv
      },
      inputs: { newLoanAmount: state.newLoanAmount, newRate: state.newRate, newTerm: state.newTerm }
    } : null;

    const cols = (current ? [current] : []).concat(savedScenarios.slice(0, 3));
    let head = '<th></th>' + cols.map(function (c) {
      return '<th>' + escapeHtml(c.label) + '</th>';
    }).join('');

    function row(label, fn) {
      return '<tr><td class="sc-metric">' + label + '</td>' +
        cols.map(function (c) { return '<td class="number">' + fn(c) + '</td>'; }).join('') +
        '</tr>';
    }

    const table =
      '<div class="flex flex-wrap gap-2 mb-3">' +
      '<button type="button" class="size-loan-btn" onclick="RuoffApp.saveScenarioSlot(\'A\')">Save as A</button>' +
      '<button type="button" class="size-loan-btn" onclick="RuoffApp.saveScenarioSlot(\'B\')">Save as B</button>' +
      '<button type="button" class="btn-ghost text-sm py-2" onclick="RuoffApp.saveScenarioSlot()">Save named…</button>' +
      '<button type="button" class="btn-ghost text-sm py-2" onclick="RuoffApp.clearScenarios()">Clear</button>' +
      '</div>' +
      '<div class="scenario-table-wrap"><table class="scenario-table"><thead><tr>' + head + '</tr></thead><tbody>' +
      row('Loan', function (c) {
        const amt = c.inputs ? c.inputs.newLoanAmount : (c.metrics && c.metrics.newLoanAmount);
        const rate = c.inputs ? c.inputs.newRate : '';
        const term = c.inputs ? c.inputs.newTerm : '';
        if (c.inputs) return money(c.inputs.newLoanAmount) + '<div class="sc-sub">' + c.inputs.newRate + '% · ' + c.inputs.newTerm + 'yr</div>';
        return '—';
      }) +
      row('New housing', function (c) { return money(c.metrics.newHousing); }) +
      row('Cash-flow Δ', function (c) {
        const v = c.metrics.monthlyCashFlowChange;
        const cls = v > 0 ? 'pos' : v < 0 ? 'neg' : '';
        return '<span class="' + cls + '">' + (v > 0 ? '+' : '') + money(v) + '</span>';
      }) +
      row('Cash at close', function (c) {
        const v = c.metrics.cashAtClosing;
        return (c.metrics.isCashBack || v >= 0 ? '' : 'Due ') + money(Math.abs(v));
      }) +
      row('Break-even', function (c) {
        return c.metrics.breakEvenMonths != null ? c.metrics.breakEvenMonths + ' mo' : 'N/A';
      }) +
      row('Debts paid', function (c) { return money(c.metrics.totalDebtsPaidOff); }) +
      row('New LTV', function (c) { return (c.metrics.newLtv != null ? c.metrics.newLtv + '%' : '—'); }) +
      '</tbody></table></div>';

    const cards = savedScenarios.map(function (s) {
      const m = s.metrics;
      return '<div class="scenario-card glass">' +
        '<div class="flex justify-between items-start gap-2">' +
        '<div><div class="font-bold">' + escapeHtml(s.label) + '</div>' +
        '<div class="text-xs opacity-60">' + money(s.inputs.newLoanAmount) + ' @ ' + s.inputs.newRate + '% / ' + s.inputs.newTerm + 'yr</div></div>' +
        '<div class="flex gap-1">' +
        '<button type="button" class="debt-action-btn" data-load-sc="' + s.id + '">Load</button>' +
        '<button type="button" class="debt-action-btn debt-action-danger" data-del-sc="' + s.id + '"><i class="fas fa-trash"></i></button>' +
        '</div></div>' +
        '<div class="grid grid-cols-2 gap-2 mt-3 text-sm">' +
        '<div>Cash flow<br><strong class="number ' + (m.monthlyCashFlowChange > 0 ? 'pos' : m.monthlyCashFlowChange < 0 ? 'neg' : '') + '">' +
        (m.monthlyCashFlowChange > 0 ? '+' : '') + money(m.monthlyCashFlowChange) + '</strong></div>' +
        '<div>Housing<br><strong class="number">' + money(m.newHousing) + '</strong></div>' +
        '</div></div>';
    }).join('');

    el.innerHTML = table + '<div class="scenario-cards mt-4">' + cards + '</div>';
    el.querySelectorAll('[data-load-sc]').forEach(function (btn) {
      btn.addEventListener('click', function () { loadScenarioById(btn.getAttribute('data-load-sc')); });
    });
    el.querySelectorAll('[data-del-sc]').forEach(function (btn) {
      btn.addEventListener('click', function () { deleteScenario(btn.getAttribute('data-del-sc')); });
    });
  }

  // ─── Print / PDF one-pager + share ───────────────────────
  function buildMiniAmortSvg(s) {
    if (!C.amortizationBalanceSeries || !s) return '';
    const keep = C.amortizationBalanceSeries(s.currentBalance, s.currentRate, s.yearsRemaining, 12);
    const refi = C.amortizationBalanceSeries(s.newLoanAmount, s.newRate, s.newTerm, 12);
    const maxBal = Math.max(s.currentBalance || 0, s.newLoanAmount || 0, 1);
    const maxYears = Math.max(s.yearsRemaining || 0, s.newTerm || 0, 1);
    const W = 520;
    const H = 120;
    const pad = { t: 10, r: 10, b: 22, l: 36 };
    const plotW = W - pad.l - pad.r;
    const plotH = H - pad.t - pad.b;
    function xOf(year) { return pad.l + (year / maxYears) * plotW; }
    function yOf(bal) { return pad.t + plotH - (bal / maxBal) * plotH; }
    function toPolyline(series) {
      return series.points.map(function (pt) {
        return xOf(pt.year).toFixed(1) + ',' + yOf(pt.balance).toFixed(1);
      }).join(' ');
    }
    const ticks = [0, Math.round(maxYears / 2), Math.round(maxYears)];
    const grid = ticks.map(function (y) {
      const x = xOf(y);
      return '<line x1="' + x + '" y1="' + pad.t + '" x2="' + x + '" y2="' + (pad.t + plotH) +
        '" stroke="#cbd5e1" stroke-width="1"/>' +
        '<text x="' + x + '" y="' + (H - 6) + '" text-anchor="middle" class="op-amort-axis">' + y + 'y</text>';
    }).join('');
    return (
      '<svg class="op-amort-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Balance over time">' +
      '<rect x="' + pad.l + '" y="' + pad.t + '" width="' + plotW + '" height="' + plotH +
        '" fill="#f8fafc" rx="6"/>' +
      grid +
      '<polyline fill="none" stroke="#94a3b8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" points="' +
        toPolyline(keep) + '"/>' +
      '<polyline fill="none" stroke="#00A89D" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" points="' +
        toPolyline(refi) + '"/>' +
      '</svg>' +
      '<div class="op-amort-legend"><span class="op-leg-keep">Keep current</span><span class="op-leg-refi">Proposed refi</span></div>'
    );
  }

  function buildLoCardHtml(lo) {
    if (!lo || (!lo.name && !lo.email && !lo.cell && !lo.nmls && !lo.phone)) return '';
    const phone = lo.cell || lo.phone || '';
    const initials = (lo.name || 'LO').split(/\s+/).filter(Boolean).slice(0, 2)
      .map(function (p) { return p.charAt(0).toUpperCase(); }).join('') || 'LO';
    const photo = lo.photo
      ? '<img class="op-lo-photo" src="' + escapeHtml(lo.photo) + '" alt="">'
      : '<div class="op-lo-initials">' + escapeHtml(initials) + '</div>';
    return (
      '<aside class="op-lo-card">' +
      photo +
      '<div class="op-lo-meta">' +
      '<div class="op-label">Your loan officer</div>' +
      (lo.name ? '<div class="op-lo-name">' + escapeHtml(lo.name) + '</div>' : '') +
      (lo.nmls ? '<div class="op-lo-line">NMLS ' + escapeHtml(lo.nmls) + '</div>' : '') +
      (phone ? '<div class="op-lo-line">' + escapeHtml(phone) + '</div>' : '') +
      (lo.email ? '<div class="op-lo-line">' + escapeHtml(lo.email) + '</div>' : '') +
      '</div></aside>'
    );
  }

  function buildOnePagerHtml() {
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const client = collectClient();
    const brand = state.branding || {};
    const lo = MODE === 'borrower' ? state.loContact : brand;
    // Normalize phone field for LO branding (cell) vs borrower link (phone)
    const loNorm = lo ? {
      name: lo.name || '',
      nmls: lo.nmls || '',
      email: lo.email || '',
      cell: lo.cell || lo.phone || '',
      phone: lo.phone || lo.cell || '',
      photo: lo.photo || ''
    } : {};
    const brandColor = safeHexColor(
      (MODE === 'borrower' ? (state.loContact && state.loContact.color) : brand.color) || '',
      '#00A89D'
    );
    const cf = s.monthlyCashFlowChange;
    const cashLabel = s.cashAtClosing === 0 ? 'Even at closing' : (s.isCashBack ? 'Est. cash back' : 'Est. cash to close');
    const debts = (state.debts || []).filter(function (d) { return d.payOff; });
    const debtRows = debts.map(function (d) {
      return '<tr><td>' + escapeHtml(d.name) + '</td><td class="num">' + money(d.bal) + '</td><td class="num">' + money(d.pay) + '/mo</td></tr>';
    }).join('') || '<tr><td colspan="3">Mortgage only</td></tr>';

    return (
      '<div class="onepager" style="--op-brand:' + brandColor + '">' +
      '<header class="op-header">' +
      '<div><div class="op-brand">Ruoff Mortgage</div>' +
      '<h1>Smart Savings Snapshot</h1>' +
      '<p class="op-sub">Prepared for ' + escapeHtml(client.clientName || 'Client') +
      (loNorm.name ? ' · ' + escapeHtml(loNorm.name) : '') +
      (loNorm.nmls ? ' · NMLS ' + escapeHtml(loNorm.nmls) : '') +
      '</p></div>' +
      '<div class="op-date">' + new Date().toLocaleDateString() + '</div>' +
      '</header>' +
      buildLoCardHtml(loNorm) +
      '<section class="op-hero">' +
      '<div class="op-before"><div class="op-label">Today</div><div class="op-big">' + money(s.oldHousing) + '</div><div class="op-muted">Total housing · P&amp;I ' + money(s.oldPi) + '</div></div>' +
      '<div class="op-arrow">→</div>' +
      '<div class="op-after"><div class="op-label">Proposed</div><div class="op-big teal">' + money(s.newHousing) + '</div><div class="op-muted">Est. housing · P&amp;I ' + money(s.newPi) + '</div></div>' +
      '</section>' +
      '<section class="op-kpis">' +
      '<div><div class="op-label">Cash-flow change</div><div class="op-kpi ' + (cf > 0 ? 'teal' : cf < 0 ? 'red' : '') + '">' + (cf > 0 ? '+' : '') + money(cf) + '</div></div>' +
      '<div><div class="op-label">' + cashLabel + '</div><div class="op-kpi orange">' + money(Math.abs(s.cashAtClosing)) + '</div></div>' +
      '<div><div class="op-label">Break-even</div><div class="op-kpi">' + (s.breakEvenMonths != null ? s.breakEvenMonths + ' months' : 'N/A') + '</div></div>' +
      '<div><div class="op-label">Debts paid off</div><div class="op-kpi">' + money(s.totalDebtsPaidOff) + '</div></div>' +
      '</section>' +
      '<section class="op-grid">' +
      '<div><h3>Home</h3><p>Value ' + money(s.homeValue) + '<br>Equity ' + money(s.equity) + ' · LTV ' + s.ltv + '%<br>New LTV ' + s.newLtv + '% · Equity ' + money(s.newEquity) + '</p></div>' +
      '<div><h3>Proposed loan</h3><p>' + money(s.newLoanAmount) + ' at ' + s.newRate + '% for ' + s.newTerm + ' years<br>Closing costs (est.) ' + money(s.closingCosts) + '</p></div>' +
      '</section>' +
      '<section class="op-amort"><h3>Loan balance over time</h3>' +
      buildMiniAmortSvg(s) +
      (s.mortgageInterest
        ? '<p class="op-amort-note ' + (s.mortgageInterest.savings >= 0 ? 'teal' : 'red') + '">' +
          money(Math.abs(s.mortgageInterest.savings)) + (s.mortgageInterest.savings >= 0 ? ' less' : ' more') +
          ' interest vs keeping the current loan (estimate).</p>'
        : '') +
      '</section>' +
      '<section><h3>Debts included in payoff</h3>' +
      '<table class="op-table"><thead><tr><th>Debt</th><th>Balance</th><th>Payment</th></tr></thead><tbody>' + debtRows + '</tbody></table></section>' +
      (s.halfSavingsPaydown
        ? '<section><h3>Optional: apply half of savings to principal</h3><p>About ' + money(s.halfSavingsPaydown.extraMonthly) +
          '/mo could finish ~' + s.halfSavingsPaydown.yearsSaved + ' years sooner and save ~' +
          money(s.halfSavingsPaydown.interestSavedVsBaseline) + ' more interest.</p></section>'
        : '') +
      '<footer class="op-foot">Estimates only. Not a commitment to lend. Rates, costs, and eligibility subject to underwriting and change. ' +
      'Ruoff Mortgage · NMLS#141868' +
      (loNorm.cell ? ' · ' + escapeHtml(loNorm.cell) : '') +
      (loNorm.email ? ' · ' + escapeHtml(loNorm.email) : '') +
      '</footer></div>'
    );
  }

  function printOnePager() {
    if (!lastScenario) liveUpdate();
    const root = $('print-one-pager');
    if (!root) {
      toast('Print view unavailable', 'error');
      return;
    }
    root.innerHTML = buildOnePagerHtml();
    root.classList.remove('hidden');
    document.body.classList.add('printing-onepager');
    setTimeout(function () {
      window.print();
      setTimeout(function () {
        document.body.classList.remove('printing-onepager');
        root.classList.add('hidden');
      }, 300);
    }, 100);
  }

  function shareSnapshot() {
    if (!lastScenario) liveUpdate();
    const s = lastScenario;
    const client = collectClient();
    const cf = s.monthlyCashFlowChange;
    const text =
      'Ruoff Smart Savings Snapshot' + (client.clientName ? ' — ' + client.clientName : '') + '\n' +
      'Today housing: ' + money(s.oldHousing) + '\n' +
      'Proposed housing: ' + money(s.newHousing) + '\n' +
      'Cash-flow change: ' + (cf > 0 ? '+' : '') + money(cf) + '\n' +
      (s.isCashBack ? 'Cash back: ' : 'Cash to close: ') + money(Math.abs(s.cashAtClosing)) + '\n' +
      'Break-even: ' + (s.breakEvenMonths != null ? s.breakEvenMonths + ' months' : 'N/A') + '\n' +
      'Loan: ' + money(s.newLoanAmount) + ' @ ' + s.newRate + '% / ' + s.newTerm + ' years\n' +
      '(Estimates only — not a commitment to lend)';

    if (navigator.share) {
      navigator.share({ title: 'Ruoff Smart Savings Snapshot', text: text }).catch(function () {
        copyText(text);
      });
    } else {
      copyText(text);
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        toast('Snapshot copied — paste into email or text');
      }).catch(function () {
        prompt('Copy this snapshot:', text);
      });
    } else {
      prompt('Copy this snapshot:', text);
    }
  }

  function celebrateGenerateSuccess() {
    if (lastScenario && lastScenario.monthlyCashFlowChange > 0) {
      confettiCooldownUntil = 0;
      fireWinConfetti();
    }
  }

  // Public API for onclick handlers
  window.RuoffApp = {
    getGrokEndpoint,
    callGrokAPI,
    liveUpdate,
    formatHomeValue,
    formatHomeValueBlur,
    syncHomeSlider,
    syncNewLoanSlider,
    syncNewRateSlider,
    onNewLoanInput,
    onNewRateInput,
    applyPreset,
    appendGoalChip,
    selectDebtType,
    toggleDebtOptional,
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
    expandDebtInline,
    sizeLoanToCoverDebts,
    scrollToSection,
    setExperienceMode,
    wizardNext,
    wizardBack,
    goToWizardStep,
    restartWizard,
    dismissResumeBanner,
    setTerm,
    syncTermSegmented,
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
    printOnePager,
    shareSnapshot,
    saveScenarioSlot,
    loadScenarioById,
    clearScenarios,
    draftInitialEmail,
    contactMyLO,
    sendToMyLO,
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
