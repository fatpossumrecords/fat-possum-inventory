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
  _settingsSetCheck('s-card-preorders',    s.dashCards.preOrders);
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

  // Show admin section if user is admin
  if (window.adminInitSettings) adminInitSettings();

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
  s.dashCards.preOrders      = _settingsGetCheck('s-card-preorders');
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
    mfgPredictions:'mfg predictions', stockoutClock:'stockout', preOrders:'open pre-orders',
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

  // Apply table density immediately
  const invTable = document.getElementById('inventory-table');
  if (invTable) invTable.classList.toggle('density-compact', s.tableDensity === 'compact');

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

// ── STATUS PERSISTENCE ───────────────────────────────────────
// Save sync status to localStorage so it survives page refresh
(function() {
  const STATUS_KEY = 'fp_sync_status';

  function saveStatus() {
    try {
      const statuses = {};
      ['packiyo', 'orchard', 'shopify', 'gist', 'sheets'].forEach(function(id) {
        const dot  = document.getElementById(id + '-dot');
        const text = document.getElementById(id + '-status-text');
        if (dot && text && text.textContent && text.textContent !== '—') {
          statuses[id] = { cls: dot.className, text: text.textContent };
        }
      });
      localStorage.setItem(STATUS_KEY, JSON.stringify(statuses));
    } catch(e) {}
  }

  function restoreStatus() {
    try {
      const saved = JSON.parse(localStorage.getItem(STATUS_KEY) || '{}');
      Object.entries(saved).forEach(function([id, val]) {
        const dot  = document.getElementById(id + '-dot');
        const text = document.getElementById(id + '-status-text');
        if (dot && text) {
          dot.className  = val.cls;
          text.textContent = val.text;
        }
      });
    } catch(e) {}
  }

  document.addEventListener('DOMContentLoaded', function() {
    // Restore saved statuses immediately
    setTimeout(restoreStatus, 500);

    // Watch for status changes and save them
    const sidebar = document.querySelector('.sidebar-footer');
    if (sidebar) {
      new MutationObserver(function() {
        clearTimeout(window._fpStatusSaveTimer);
        window._fpStatusSaveTimer = setTimeout(saveStatus, 300);
      }).observe(sidebar, { childList: true, subtree: true, characterData: true });
    }
  });
})();

// ── GIST SIZE STATUS ─────────────────────────────────────────
(function() {
  const GIST_LIMIT_KB = 10240;

  function _fpUpdateGistSizes() {
    let gistId, token;
    try { gistId = CONFIG.GIST_ID; token = CONFIG.GIST_TOKEN; } catch(e) {}
    if (!gistId) {
      try {
        const c = JSON.parse(localStorage.getItem('fp_config_cache') || '{}');
        gistId = c.GIST_ID; token = c.GIST_TOKEN;
      } catch(e) {}
    }
    if (!gistId || !token) return;

    fetch('https://api.github.com/gists/' + gistId, {
      headers: { 'Authorization': 'token ' + token },
      cache: 'no-store'
    }).then(function(r) { return r.json(); }).then(function(g) {
      const files = Object.values(g.files || {});
      const totalKb  = files.reduce(function(s, f) { return s + (f.size || 0); }, 0) / 1024;
      const largestKb = Math.max.apply(null, files.map(function(f) { return (f.size || 0) / 1024; }));
      const pct = Math.min(100, (largestKb / GIST_LIMIT_KB) * 100);

      const dot  = document.getElementById('gist-dot');
      const text = document.getElementById('gist-status-text');
      const bar  = document.getElementById('gist-bar');

      if (dot)  dot.className = 'status-dot ok';
      if (text) text.textContent = totalKb.toFixed(0) + 'kb total · largest ' + largestKb.toFixed(0) + 'kb / 10MB';
      if (bar)  { bar.style.width = pct + '%'; bar.style.background = pct > 80 ? 'var(--red)' : pct > 50 ? 'var(--yellow)' : 'var(--green)'; }
    }).catch(function() {});
  }

  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(_fpUpdateGistSizes, 4000);
  });
})();

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
      stockoutClock:  'stockout clock',
      preOrders:      'open pre-orders',
    };
    window._fpHiddenCards = Object.entries(cardMap)
      .filter(function(entry) { return s.dashCards && s.dashCards[entry[0]] === false; })
      .map(function(entry) { return entry[1]; });

    // Expose as global so wh_module.js can call after every grid rebuild
    window._fpApplyCardVisibility = function() {
      document.querySelectorAll('.dash-card').forEach(function(card) {
        const lbl = card.querySelector('.dash-label');
        if (!lbl) return;
        const text = lbl.textContent.toLowerCase();
        const shouldHide = (window._fpHiddenCards || []).some(function(h) { return text.includes(h); });
        card.style.display = shouldHide ? 'none' : '';
      });
    };
    window._fpApplyCardVisibility();

    // Default warehouse filter
    if (s.defaultWarehouse) {
      const whFilter = document.getElementById('filter-warehouse');
      if (whFilter && !whFilter.value) whFilter.value = s.defaultWarehouse;
    }

  }, 2000);
});

// ── ADMIN: USER MANAGEMENT ────────────────────────────────────────

const ADMIN_EMAIL    = 'patrick@fatpossum.com';
const USERS_GIST_FILE = 'fp_users.json';

// Roles: 'admin' | 'full' | 'warehouse'
// warehouse = Locations, Replenishment, Pre-Orders only
const ROLE_LABELS = {
  admin:     'Admin (Full Access)',
  full:      'Full Access',
  warehouse: 'Locations / Replenishment / Pre-Orders',
};

// Called from openSettings — show admin section only to admin
window.adminInitSettings = function() {
  const user = State.user;
  if (!user) return;
  const isAdmin = user.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()
    || (State.userRole && State.userRole === 'admin');
  const section = document.getElementById('s-admin-section');
  if (section) section.style.display = isAdmin ? 'block' : 'none';
  if (isAdmin) {
    adminRenderUsers();
    adminRenderLog();
  }
};

async function adminLoadUsers() {
  try {
    const res = await fetch('https://api.github.com/gists/' + CONFIG.GIST_ID, {
      headers: { Authorization: 'token ' + CONFIG.GIST_TOKEN },
      cache: 'no-store',
    });
    const data = await res.json();
    const content = data.files?.[USERS_GIST_FILE]?.content;
    return content ? JSON.parse(content) : { users: [], log: [] };
  } catch(e) {
    return { users: [], log: [] };
  }
}

async function adminSaveUsers(data) {
  await fetch('https://api.github.com/gists/' + CONFIG.GIST_ID, {
    method: 'PATCH',
    headers: { Authorization: 'token ' + CONFIG.GIST_TOKEN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [USERS_GIST_FILE]: { content: JSON.stringify(data, null, 2) } } }),
  });
}

async function adminRenderUsers() {
  const data  = await adminLoadUsers();
  const users = data.users || [];
  const el    = document.getElementById('s-users-list');
  if (!el) return;

  if (!users.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--text-muted);">No users added yet.</div>';
    return;
  }

  el.innerHTML = '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr>'
    + '<th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);">Email</th>'
    + '<th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);">Role</th>'
    + '<th style="text-align:left;padding:4px 8px;color:var(--text-muted);font-weight:600;border-bottom:1px solid var(--border);">Last Sign-in</th>'
    + '<th style="padding:4px 8px;border-bottom:1px solid var(--border);"></th>'
    + '</tr></thead><tbody>'
    + users.map((u, i) => {
        const isMe = u.email.toLowerCase() === ADMIN_EMAIL.toLowerCase();
        const lastSeen = u.lastSignIn ? new Date(u.lastSignIn).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : '—';
        return '<tr style="border-bottom:1px solid var(--border);">'
          + '<td style="padding:6px 8px;">' + u.email + (isMe ? ' <span style="font-size:9px;background:var(--accent);color:#fff;border-radius:3px;padding:1px 5px;">you</span>' : '') + '</td>'
          + '<td style="padding:6px 8px;">'
          + '<select onchange="adminChangeRole(' + i + ',this.value)" style="font-size:11px;padding:2px 6px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);"' + (isMe ? ' disabled' : '') + '>'
          + Object.entries(ROLE_LABELS).map(([k,v]) => '<option value="'+k+'"'+(u.role===k?' selected':'')+'>'+v+'</option>').join('')
          + '</select>'
          + '</td>'
          + '<td style="padding:6px 8px;color:var(--text-muted);">' + lastSeen + '</td>'
          + '<td style="padding:6px 8px;text-align:right;">'
          + (isMe ? '' : '<button onclick="adminRemoveUser('+i+')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:12px;" title="Remove">✕</button>')
          + '</td>'
          + '</tr>';
      }).join('')
    + '</tbody></table>';
}

async function adminRenderLog() {
  const data = await adminLoadUsers();
  const log  = (data.log || []).slice(-50).reverse();
  const el   = document.getElementById('s-access-log');
  if (!el) return;
  if (!log.length) { el.textContent = 'No sign-ins recorded yet.'; return; }
  el.innerHTML = log.map(e =>
    '<div style="padding:2px 0;border-bottom:1px solid var(--border);">'
    + '<span style="color:var(--text);">' + e.email + '</span>'
    + ' <span style="color:var(--text-dim);">·</span> '
    + new Date(e.at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})
    + '</div>'
  ).join('');
}

window.adminAddUser = async function() {
  const emailEl = document.getElementById('s-new-user-email');
  const roleEl  = document.getElementById('s-new-user-role');
  const email   = (emailEl?.value || '').trim().toLowerCase();
  const role    = roleEl?.value || 'full';
  if (!email || !email.includes('@')) { alert('Enter a valid email.'); return; }

  const data  = await adminLoadUsers();
  const users = data.users || [];
  if (users.find(u => u.email.toLowerCase() === email)) {
    alert(email + ' is already in the list.'); return;
  }
  users.push({ email, role, addedAt: new Date().toISOString(), addedBy: State.user?.email });
  data.users = users;
  await adminSaveUsers(data);
  if (emailEl) emailEl.value = '';
  adminRenderUsers();
  if (window.toast) toast('User added: ' + email, 'success');
};

window.adminRemoveUser = async function(idx) {
  const data  = await adminLoadUsers();
  const users = data.users || [];
  const user  = users[idx];
  if (!user) return;
  if (!confirm('Remove ' + user.email + '?')) return;
  users.splice(idx, 1);
  data.users = users;
  await adminSaveUsers(data);
  adminRenderUsers();
  if (window.toast) toast('User removed: ' + user.email, 'success');
};

window.adminChangeRole = async function(idx, newRole) {
  const data  = await adminLoadUsers();
  const users = data.users || [];
  if (!users[idx]) return;
  users[idx].role = newRole;
  data.users = users;
  await adminSaveUsers(data);
  if (window.toast) toast('Role updated', 'success');
};

// Called from app.js after login — looks up user role and applies nav restrictions
window.applyUserRole = function(role) {
  State.userRole = role;
  if (role === 'admin' || role === 'full') return; // full access — nothing to hide

  // warehouse role: hide everything except Locations, Replenishment, Pre-Orders
  const hideViews = ['dashboard','inventory','movements','manufacturing','alerts','invoices','reports'];
  hideViews.forEach(v => {
    const el = document.querySelector('.nav-item[data-view="' + v + '"]');
    if (el) el.style.display = 'none';
  });
  // Hide nav sub-sections
  ['#inv-nav-sub','#mfg-nav-sub'].forEach(sel => {
    const el = document.querySelector(sel);
    if (el) el.style.display = 'none';
  });
  // If current view is one of the hidden ones, redirect to replenishment
  if (hideViews.includes(State.currentView || 'dashboard')) {
    if (typeof switchView === 'function') switchView('replenishment');
  }
};
