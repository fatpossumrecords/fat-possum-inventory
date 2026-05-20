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
    ['wh-lookback',   replen.lookback],
    ['wh-days-supply', replen.daysSupply],
    ['wh-outlier',    replen.outlier],
    ['wh-max-units',  replen.maxUnits],
    ['wh-min-units',  replen.minUnits],
  ];
  fields.forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.value = val;
  });
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
  applySettings(s);
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

// ── BOOT — Step 1: no DOM changes on load, just modal functionality ──
document.addEventListener('DOMContentLoaded', function() {
  // applySettings intentionally not called yet — testing modal only
});
