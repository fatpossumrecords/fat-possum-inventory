/* ============================================================
   FAT POSSUM -- SETTINGS MODULE
   settings_module.js
   User preferences saved to localStorage under fp_user_prefs
   ============================================================ */

const SETTINGS_KEY = 'fp_user_prefs';

// ── DEFAULTS ─────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  // Appearance
  defaultDarkMode:        false,
  // Dashboard
  showNeedsAttention:     true,
  dashCards: {
    totalProducts:        true,
    globalStock:          true,
    reorderAlerts:        true,
    resolved:             true,
    walkReplenish:        true,
    productionRuns:       true,
    mfgPredictions:       true,
    stockoutClock:        true,
  },
  // Inventory
  defaultWarehouse:       'fp',   // fp | us | total
  tableDensity:           'comfortable', // comfortable | compact
  // Alerts
  alertBadges: {
    reorder:              true,
    movements:            false,
    productionRuns:       false,
  },
  // Replenishment defaults (applied on page load)
  replen: {
    lookback:             30,
    daysSupply:           7,
    outlier:              20,
    maxUnits:             50,
    minUnits:             5,
  },
  // Pre-order
  poAutoRefresh:          false,  // auto-refresh orders on view load
};

// ── LOAD / SAVE ───────────────────────────────────────────────
function loadSettings() {
  try {
    const saved = localStorage.getItem(SETTINGS_KEY);
    if (saved) {
      const parsed = JSON.parse(saved);
      // Deep merge with defaults so new keys always exist
      return deepMerge(SETTINGS_DEFAULTS, parsed);
    }
  } catch(e) {}
  return JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch(e) {}
}

function deepMerge(defaults, overrides) {
  const result = JSON.parse(JSON.stringify(defaults));
  for (const key of Object.keys(overrides)) {
    if (key in result && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], overrides[key]);
    } else {
      result[key] = overrides[key];
    }
  }
  return result;
}

// Global settings object
window._FPUserSettings = loadSettings();

// ── APPLY SETTINGS ON BOOT ────────────────────────────────────
function applySettings(s) {
  s = s || window._FPUserSettings;

  // Dark mode
  if (s.defaultDarkMode && !document.body.classList.contains('dark-mode')) {
    document.body.classList.add('dark-mode');
    const icon = document.getElementById('darkmode-icon');
    if (icon) icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
  }

  // Needs attention banner
  const banner = document.getElementById('needs-attention-banner');
  if (banner && !s.showNeedsAttention) banner.style.display = 'none';

  // Apply replen defaults to the inputs
  applyReplenDefaults(s.replen);
}

function applyReplenDefaults(replen) {
  if (!replen) return;
  const fields = [
    ['wh-lookback',    replen.lookback],
    ['wh-days-supply', replen.daysSupply],
    ['wh-outlier',     replen.outlier],
    ['wh-max-units',   replen.maxUnits],
    ['wh-min-units',   replen.minUnits],
  ];
  const obj = {};
  fields.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) { el.value = val; obj[id] = String(val); }
  });
  // Also update the WH settings cache so whLoadSettings doesn't overwrite us
  try { localStorage.setItem('fp_wh_replen_settings', JSON.stringify(obj)); } catch(e) {}
}

// ── SETTINGS PANEL ────────────────────────────────────────────
window.openSettings = function() {
  const s = window._FPUserSettings;
  const modal = document.getElementById('settings-modal');
  if (!modal) return;

  // Populate all fields
  _settingsSetCheck('s-dark-mode',         s.defaultDarkMode);
  _settingsSetCheck('s-needs-attention',   s.showNeedsAttention);
  _settingsSetCheck('s-card-total',        s.dashCards.totalProducts);
  _settingsSetCheck('s-card-global',       s.dashCards.globalStock);
  _settingsSetCheck('s-card-alerts',       s.dashCards.reorderAlerts);
  _settingsSetCheck('s-card-resolved',     s.dashCards.resolved);
  _settingsSetCheck('s-card-wh',           s.dashCards.walkReplenish);
  _settingsSetCheck('s-card-runs',         s.dashCards.productionRuns);
  _settingsSetCheck('s-card-mfg',          s.dashCards.mfgPredictions);
  _settingsSetCheck('s-card-clock',        s.dashCards.stockoutClock);
  _settingsSetVal('s-default-warehouse',   s.defaultWarehouse);
  _settingsSetVal('s-table-density',       s.tableDensity);
  _settingsSetCheck('s-badge-reorder',     s.alertBadges.reorder);
  _settingsSetCheck('s-badge-movements',   s.alertBadges.movements);
  _settingsSetCheck('s-badge-runs',        s.alertBadges.productionRuns);
  _settingsSetVal('s-replen-lookback',     s.replen.lookback);
  _settingsSetVal('s-replen-supply',       s.replen.daysSupply);
  _settingsSetVal('s-replen-outlier',      s.replen.outlier);
  _settingsSetVal('s-replen-max',          s.replen.maxUnits);
  _settingsSetVal('s-replen-min',          s.replen.minUnits);
  _settingsSetCheck('s-po-autorefresh',    s.poAutoRefresh);

  modal.style.display = 'flex';
};

window.closeSettings = function() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.style.display = 'none';
};

window.saveSettingsFromForm = function() {
  const s = window._FPUserSettings;

  s.defaultDarkMode        = _settingsGetCheck('s-dark-mode');
  s.showNeedsAttention     = _settingsGetCheck('s-needs-attention');
  s.dashCards.totalProducts  = _settingsGetCheck('s-card-total');
  s.dashCards.globalStock    = _settingsGetCheck('s-card-global');
  s.dashCards.reorderAlerts  = _settingsGetCheck('s-card-alerts');
  s.dashCards.resolved       = _settingsGetCheck('s-card-resolved');
  s.dashCards.walkReplenish  = _settingsGetCheck('s-card-wh');
  s.dashCards.productionRuns = _settingsGetCheck('s-card-runs');
  s.dashCards.mfgPredictions = _settingsGetCheck('s-card-mfg');
  s.dashCards.stockoutClock  = _settingsGetCheck('s-card-clock');
  s.defaultWarehouse         = _settingsGetVal('s-default-warehouse');
  s.tableDensity             = _settingsGetVal('s-table-density');
  s.alertBadges.reorder      = _settingsGetCheck('s-badge-reorder');
  s.alertBadges.movements    = _settingsGetCheck('s-badge-movements');
  s.alertBadges.productionRuns = _settingsGetCheck('s-badge-runs');
  s.replen.lookback          = parseInt(_settingsGetVal('s-replen-lookback'))  || 30;
  s.replen.daysSupply        = parseInt(_settingsGetVal('s-replen-supply'))    || 7;
  s.replen.outlier           = parseInt(_settingsGetVal('s-replen-outlier'))   || 20;
  s.replen.maxUnits          = parseInt(_settingsGetVal('s-replen-max'))       || 50;
  s.replen.minUnits          = parseInt(_settingsGetVal('s-replen-min'))       || 5;
  s.poAutoRefresh            = _settingsGetCheck('s-po-autorefresh');

  window._FPUserSettings = s;
  saveSettings(s);

  // Apply dark mode immediately on save
  if (s.defaultDarkMode && !document.body.classList.contains('dark-mode')) {
    document.body.classList.add('dark-mode');
  } else if (!s.defaultDarkMode && document.body.classList.contains('dark-mode')) {
    document.body.classList.remove('dark-mode');
  }

  // Apply banner immediately on save
  const existingStyle = document.getElementById('fp-hide-banner');
  if (!s.showNeedsAttention) {
    if (!existingStyle) document.head.insertAdjacentHTML('beforeend', '<style id="fp-hide-banner">#needs-attention-banner{display:none!important}</style>');
  } else {
    if (existingStyle) existingStyle.remove();
  }

  // Apply dashboard card visibility immediately on save
  const cardMap = {
    totalProducts:'total products', globalStock:'global stock',
    reorderAlerts:'reorder alerts', resolved:'resolved',
    walkReplenish:'walk replenish', productionRuns:'production runs',
    mfgPredictions:'mfg predictions', stockoutClock:'stockout',
  };
  window._fpHiddenCards = Object.entries(cardMap)
    .filter(([key]) => s.dashCards && s.dashCards[key] === false)
    .map(([, label]) => label);
  document.querySelectorAll('.dash-card').forEach(card => {
    const lbl = card.querySelector('.dash-label');
    if (!lbl) return;
    const text = lbl.textContent.toLowerCase();
    card.style.display = (window._fpHiddenCards || []).some(h => text.includes(h)) ? 'none' : '';
  });

  closeSettings();
  if (window.toast) toast('Settings saved.', 'success');
};

window.resetSettings = function() {
  if (!confirm('Reset all settings to defaults?')) return;
  window._FPUserSettings = JSON.parse(JSON.stringify(SETTINGS_DEFAULTS));
  saveSettings(window._FPUserSettings);
  applySettings(window._FPUserSettings);
  openSettings(); // re-open with reset values
  if (window.toast) toast('Settings reset to defaults.', '');
};

// Close on backdrop click
document.addEventListener('click', function(e) {
  if (e.target.id === 'settings-modal') closeSettings();
});

// ── HELPERS ───────────────────────────────────────────────────
function _settingsSetCheck(id, val) { const el = document.getElementById(id); if (el) el.checked = !!val; }
function _settingsGetCheck(id)      { const el = document.getElementById(id); return el ? el.checked : false; }
function _settingsSetVal(id, val)   { const el = document.getElementById(id); if (el) el.value = val; }
function _settingsGetVal(id)        { const el = document.getElementById(id); return el ? el.value : ''; }

// ── BOOT — Step 5: all settings ──
document.addEventListener('DOMContentLoaded', function() {
  setTimeout(function() {
    const s = window._FPUserSettings;
    if (!s) return;

    // Dark mode
    if (s.defaultDarkMode && !document.body.classList.contains('dark-mode')) {
      document.body.classList.add('dark-mode');
      const icon = document.getElementById('darkmode-icon');
      if (icon) icon.innerHTML = '<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>';
    }

    // Needs attention banner
    if (!s.showNeedsAttention) {
      if (!document.getElementById('fp-hide-banner'))
        document.head.insertAdjacentHTML('beforeend', '<style id="fp-hide-banner">#needs-attention-banner{display:none!important}</style>');
    } else {
      const existing = document.getElementById('fp-hide-banner');
      if (existing) existing.remove();
    }

    // Replen defaults
    applyReplenDefaults(s.replen);

    // Table density
    const invTable = document.getElementById('inventory-table');
    if (invTable) invTable.classList.toggle('density-compact', s.tableDensity === 'compact');

    // Dashboard cards — hide unchecked ones by finding cards by label text
    const cardMap = {
      totalProducts:  'total products',
      globalStock:    'global stock',
      reorderAlerts:  'reorder alerts',
      resolved:       'resolved',
      walkReplenish:  'walk replenish',
      productionRuns: 'production runs',
      mfgPredictions: 'mfg predictions',
      stockoutClock:  'stockout',
    };
    // Build a style that hides cards by ID where possible, otherwise use MutationObserver
    // Since cards are dynamic, store hidden list and apply via observer
    window._fpHiddenCards = Object.entries(cardMap)
      .filter(([key]) => s.dashCards && s.dashCards[key] === false)
      .map(([, label]) => label);

    function applyCardVisibility() {
      document.querySelectorAll('.dash-card').forEach(card => {
        const lbl = card.querySelector('.dash-label');
        if (!lbl) return;
        const text = lbl.textContent.toLowerCase();
        const shouldHide = (window._fpHiddenCards || []).some(h => text.includes(h));
        card.style.display = shouldHide ? 'none' : '';
      });
    }
    applyCardVisibility();
    // Re-apply whenever dashboard re-renders
    // Re-apply whenever dashboard view becomes active
    const _origSwitchView = window.switchView;
    if (_origSwitchView && !window._fpSwitchViewPatched) {
      window._fpSwitchViewPatched = true;
      window.switchView = function(viewName) {
        _origSwitchView(viewName);
        if (viewName === 'dashboard') {
          setTimeout(applyCardVisibility, 150);
        }
      };
    }

    if (!window._fpCardObserver) {
      const dashBody = document.getElementById('dashboard-body');
      if (dashBody) {
        window._fpCardObserver = new MutationObserver(() => {
          clearTimeout(window._fpCardTimer);
          window._fpCardTimer = setTimeout(applyCardVisibility, 100);
        });
        window._fpCardObserver.observe(dashBody, { childList: true, subtree: true });
      }
    }

    // Default warehouse filter
    if (s.defaultWarehouse) {
      const whFilter = document.getElementById('filter-warehouse');
      if (whFilter && !whFilter.value) whFilter.value = s.defaultWarehouse;
    }

  }, 2000);
});
