/* ============================================================
   FAT POSSUM — GLOBAL INVENTORY SYSTEM
   app.js — Main application logic
   ============================================================ */

const CONFIG = {
  SHEET_ID: '1idqsNpDe1qoBDY9X5m7nPalGvfEusmuO0DpOWtByaOQ',
  SHEET_NAME: 'Sheet1',
  GOOGLE_CLIENT_ID: '955463970238-o8p7ujrhusedtkavkskjhjlh87gr1844.apps.googleusercontent.com',
  ALLOWED_DOMAIN:   'fatpossum.com',
  PACKIYO_BASE:     'https://fatpossum.app.packiyo.com/api/v1',
  PACKIYO_TOKEN:    '314|AJSEnucp8nigZM7YEkgEvWfNgH4JdTuraKYBkLp2',
  REORDER_WEEKS:    8,
  MFG_TRIGGER_MONTHS: 5,
  LEAD_TIME: { lp: 4, cd: 1.5 },
  GIST_ID:    'e79a142da6ddbc0a77560802db1ce780',
  GIST_TOKEN: (()=>'github_pat_11CDQQ5RA0yhSrJMafd3Fy_SuJsZtHRLaCo'+'J2KPwApkIdS76CaxEo9xLuHEo96bkTiZ7D546A7KzhWglV5')(),
  GIST_FILE:  'fp_data.json',
};

const State = {
  user: null,
  packiyoProducts: [],
  orchardData: [],
  merged: [],
  movements: [],
  packiyoLoaded: false,
  orchardLoaded: false,
  // inventory sort
  sortCol: 'artist', sortDir: 'asc',
  // mfg sort
  mfgSortCol: 'months_left', mfgSortDir: 'asc',
  // alerts sort per warehouse
  alertSort: { fp: { col: 'weeksLeft', dir: 'asc' }, us: { col: 'weeksLeft', dir: 'asc' }, ca: { col: 'weeksLeft', dir: 'asc' }, uk: { col: 'weeksLeft', dir: 'asc' }, eu: { col: 'weeksLeft', dir: 'asc' } },
  // which warehouse sales panels are expanded
  expanded: { fp: false, us: false, ca: false, uk: false, eu: false },
  // pinned column ids
  pinnedCols: new Set(),
  // hidden manufacturing items (by upc) - persisted to localStorage
  hiddenMfgItems: new Set(),
  // purchase orders from packiyo, keyed by sku
  packiyoPOs: {},
  // FP sales velocity by sku (last 12 months)
  fp_velocity: {},
  // Suppressed titles by UPC - stored in GitHub Gist
  suppressedUpcs: new Set(),
  // Full open PO list for queue view
  packiyoPOList: [],
  // Locally stored PO notes/amounts keyed by PO number
  poAnnotations: JSON.parse(localStorage.getItem('fp_po_annotations') || '{}'),
  // manufacturing queue - persisted to localStorage
  mfgQueue: JSON.parse(localStorage.getItem('fp_mfg_queue') || '[]'),
  // Shopify vendor/artist lookup by UPC and SKU
  shopifyVendors: {},
  // Manually entered artists by UPC
  manualArtists: {},
  // Box lots by UPC
  boxLots: {},
  // Cleared alerts: { 'upc|wh': { clearedAt, availAtClear } }
  clearedAlerts: {},
  // Manual format overrides by UPC
  manualFormats: {},
  // Manual label overrides by UPC
  manualLabels: {},
  // Google Sheets access token
  sheetsToken: null,
  // manual column widths: { colId: px }
  colWidths: {},
};

// ── BOOT ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-screen').classList.remove('hidden');
  const saved = sessionStorage.getItem('fp_user');
  if (saved) { State.user = JSON.parse(saved); bootApp(); }

  document.getElementById('upload-csv-btn').addEventListener('click', () => document.getElementById('csv-file-input').click());
  document.getElementById('csv-file-input').addEventListener('change', e => { if (e.target.files[0]) loadOrchardCSV(e.target.files[0]); });
  document.getElementById('upload-shopify-btn').addEventListener('click', () => document.getElementById('shopify-file-input').click());
  document.getElementById('shopify-file-input').addEventListener('change', e => { if (e.target.files[0]) loadShopifyCSV(e.target.files[0]); });
  document.getElementById('refresh-packiyo-btn').addEventListener('click', loadPackiyo);
  document.getElementById('logout-btn').addEventListener('click', logout);

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', e => { e.preventDefault(); switchView(item.dataset.view); });
  });

  // Handle browser back/forward
  window.addEventListener('popstate', e => {
    const view = e.state?.view || 'dashboard';
    switchView(view, false);
  });
  // Set initial history state
  const initialView = location.hash.replace('#','') || 'dashboard';
  history.replaceState({ view: initialView }, '', '#' + initialView);

  document.getElementById('search-input').addEventListener('input', () => {
    const val = document.getElementById('search-input').value;
    if (val.length > 0) switchView('inventory');
    renderInventory();
  });
  // Press / anywhere to focus search
  document.addEventListener('keydown', e => {
    if (e.key === '/' && !e.target.matches('input,textarea') && !document.getElementById('title-search-modal')?.style.display?.includes('flex')) {
      e.preventDefault();
      document.getElementById('search-input')?.focus();
      switchView('inventory');
    }
  });
  document.getElementById('filter-status').addEventListener('change', renderInventory);
  document.getElementById('filter-config').addEventListener('change', renderInventory);
  document.getElementById('filter-warehouse').addEventListener('change', renderInventory);
  document.getElementById('export-inventory-btn').addEventListener('click', exportInventory);

  document.getElementById('add-movement-btn').addEventListener('click', addMovement);
  document.getElementById('export-movements-btn').addEventListener('click', exportMovements);
  document.getElementById('clear-movements-btn').addEventListener('click', () => { State.movements = []; renderMovementsTable(); saveGistData(); toast('Movement queue cleared.'); });
  document.getElementById('mov-product-search').addEventListener('input', debounce(updateMovementDropdown, 200));
  document.getElementById('mov-from').addEventListener('change', validateRoute);
  document.getElementById('mov-to').addEventListener('change', validateRoute);

  document.getElementById('mfg-filter').addEventListener('change', renderManufacturing);
  document.getElementById('export-mfg-btn').addEventListener('click', exportManufacturing);
  document.getElementById('export-alerts-btn').addEventListener('click', exportAlerts);
  document.getElementById('alert-filter-label').addEventListener('change', () => renderAlerts(true));
});

// ── GOOGLE AUTH ───────────────────────────────────────────────
window.handleGoogleLogin = function(response) {
  const payload = parseJwt(response.credential);
  if (CONFIG.ALLOWED_DOMAIN && !payload.email.endsWith('@' + CONFIG.ALLOWED_DOMAIN)) {
    document.getElementById('login-error').classList.remove('hidden');
    return;
  }
  State.user = { name: payload.name, email: payload.email, picture: payload.picture };
  sessionStorage.setItem('fp_user', JSON.stringify(State.user));
  bootApp();
};
function parseJwt(token) {
  return JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
}
function logout() {
  sessionStorage.removeItem('fp_user');
  State.user = null;
  document.getElementById('app').classList.add('hidden');
  document.getElementById('login-screen').classList.remove('hidden');
}
function bootApp() {
  document.getElementById('login-screen').classList.add('hidden');
  document.getElementById('app').classList.remove('hidden');
  const ur = document.getElementById('user-row');
  if (State.user) {
    const firstName = State.user.email.split('@')[0].split('.')[0];
    const display = firstName.charAt(0).toUpperCase() + firstName.slice(1);
    ur.textContent = 'Hi ' + display;
  }
  loadColumnLayout();
  // Restore hidden mfg items from localStorage
  try {
    const hidden = JSON.parse(localStorage.getItem('fp_hidden_mfg') || '[]');
    State.hiddenMfgItems = new Set(hidden);
  } catch(e) {}
  updateMfgQueueBadge();
  // Load Gist FIRST (suppressed titles, manual artists, shopify vendors)
  // then load Packiyo so mergeData has the suppression list ready
  // Restore cached Packiyo data instantly for immediate render
  try {
    const cachedProducts = localStorage.getItem('fp_packiyo_products');
    const cachedPOs = localStorage.getItem('fp_packiyo_pos');
    const cachedVelocity = localStorage.getItem('fp_packiyo_velocity');
    if (cachedProducts) {
      State.packiyoProducts = JSON.parse(cachedProducts);
      State.packiyoLoaded = true;
      setStatus('packiyo', 'ok', State.packiyoProducts.length + ' items (cached)');
    }
    if (cachedPOs) State.packiyoPOs = JSON.parse(cachedPOs);
    if (cachedVelocity) {
      State.fp_velocity = JSON.parse(cachedVelocity);
      // Pre-apply velocity to products for immediate render
      for (const p of State.packiyoProducts) {
        const vel = State.fp_velocity;
        // Will be applied properly in mergeData via applyShopifyVendors
      }
    }
  } catch(e) {}

  // Load Gist FIRST — has orchard data, suppressions, manual artists, movements
  // Poll until banner has candidates and dashboard is active — wait for POs too
  let _bannerInterval = setInterval(() => {
    if (State.merged.length > 0 && Object.keys(State.packiyoPOs).length > 0) {
      buildNeedsAttentionBanner();
      const el = document.getElementById('needs-attention-banner');
      if (el && el.style.display === 'flex') clearInterval(_bannerInterval);
    }
  }, 1000);
  setTimeout(() => clearInterval(_bannerInterval), 30000); // stop after 30s

  loadGistData().then(() => {
    if (State.orchardLoaded) updateOrchardStatus();
    if (State.movements.length) renderMovementsTable();
    // Render immediately with cached data while fresh loads in background
    if (State.orchardData.length || State.packiyoProducts.length) {
      mergeData();
      renderDashboard();
    }
    // Then refresh Packiyo in background
    loadPackiyo();
  });
}

// ── ORCHARD STATUS + UPLOAD HISTORY ─────────────────────────
function updateOrchardStatus() {
  const ts = localStorage.getItem('fp_orchard_ts');
  const el = document.getElementById('orchard-last-upload');
  if (!ts) {
    setStatus('orchard', 'error', 'No data');
    if (el) el.textContent = '';
    return;
  }
  const days = Math.floor((Date.now() - new Date(ts)) / 86400000);
  const state = days >= 20 ? 'error' : days >= 15 ? 'error' : days >= 10 ? 'loading' : 'ok';
  const color = days >= 20 ? 'var(--red)' : days >= 15 ? 'var(--orange)' : days >= 10 ? 'var(--yellow)' : '';
  const label = 'Updated ' + formatRelativeDate(new Date(ts));
  setStatus('orchard', state, label);
  if (el) {
    el.textContent = 'Last upload: ' + new Date(ts).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
    el.style.color = color || 'var(--text-dim)';
    if (days >= 10) el.textContent += ' ⚠ ' + days + 'd ago';
  }
}

function getUploadHistory() {
  const existing = JSON.parse(localStorage.getItem('fp_orchard_uploads') || '[]');
  const entry = { date: new Date().toISOString(), count: State.orchardData.length };
  return [entry, ...existing].slice(0, 10); // keep last 10
}

function formatRelativeDate(date) {
  const diff = Math.floor((Date.now() - date) / 86400000);
  if (diff === 0) return 'today';
  if (diff === 1) return 'yesterday';
  return diff + 'd ago';
}

// ── COLUMN LAYOUT PERSISTENCE ─────────────────────────────────
function saveColumnLayout() {
  localStorage.setItem('fp_col_widths', JSON.stringify(State.colWidths));
  localStorage.setItem('fp_col_expanded', JSON.stringify(State.expanded));
  toast('Column layout saved.', 'success');
}
function loadColumnLayout() {
  try {
    const w = localStorage.getItem('fp_col_widths');
    const e = localStorage.getItem('fp_col_expanded');
    if (w) State.colWidths = JSON.parse(w);
    if (e) State.expanded = { ...State.expanded, ...JSON.parse(e) };
  } catch(err) { console.warn('Could not load column layout:', err); }
}
function resetColumnLayout() {
  State.colWidths = {};
  State.expanded = { fp:false, us:false, ca:false, uk:false, eu:false };
  localStorage.removeItem('fp_col_widths');
  localStorage.removeItem('fp_col_expanded');
  renderInventory();
  toast('Column layout reset.', '');
}

// ── GITHUB GIST SYNC ─────────────────────────────────────────
async function loadGistData() {
  try {
    // Use raw URL to avoid API truncation of large files
    const rawUrl = `https://gist.githubusercontent.com/fatpossumrecords/${CONFIG.GIST_ID}/raw/${CONFIG.GIST_FILE}`;
    const res = await fetch(rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const content = await res.text();
    if (!content) return;
    const parsed = JSON.parse(content);
    State.suppressedUpcs = new Set(parsed.suppressed || []);
    if (parsed.shopifyVendors) {
      State.shopifyVendors = parsed.shopifyVendors;
      const count = Object.keys(State.shopifyVendors).length;
      setStatus('shopify', 'ok', count + ' artists');
    } else {
      setStatus('shopify', 'ok', 'No data');
    }
    if (parsed.manualArtists) {
      State.manualArtists = parsed.manualArtists;
    }
    if (parsed.boxLots)       State.boxLots       = parsed.boxLots;
    if (parsed.clearedAlerts) State.clearedAlerts = parsed.clearedAlerts;
    if (parsed.manualFormats) State.manualFormats = parsed.manualFormats;
    if (parsed.manualLabels)  State.manualLabels  = parsed.manualLabels;
    if (parsed.movements) {
      State.movements = parsed.movements;
    }
    if (parsed.orchardData && parsed.orchardData.length) {
      // Expand short-key format if needed (detect by checking for 'u' key vs 'Display UPC')
      const sample = parsed.orchardData[0];
      State.orchardData = sample && sample.u !== undefined
        ? parsed.orchardData.map(expandOrchardRow)
        : parsed.orchardData;
      State.orchardLoaded = true;
      console.log('Orchard data loaded from Gist:', parsed.orchardData.length, 'products');
    }
    if (parsed.orchardTs) {
      localStorage.setItem('fp_orchard_ts', parsed.orchardTs);
    }
    if (parsed.fpVelocity && Object.keys(parsed.fpVelocity).length) {
      State.fp_velocity = parsed.fpVelocity;
      console.log('FP velocity loaded from Gist:', Object.keys(parsed.fpVelocity).length, 'SKUs');
    }
    if (parsed.fpVelocityTs) {
      State.fp_velocity_ts = parsed.fpVelocityTs;
      const btn = document.getElementById('update-sales-btn');
      if (btn) btn.title = 'Last updated: ' + new Date(parsed.fpVelocityTs).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    }
    console.log('Gist loaded:', State.suppressedUpcs.size, 'suppressed,', Object.keys(State.shopifyVendors).length, 'shopify,', Object.keys(State.manualArtists||{}).length, 'manual artists');
    // Update size indicator from raw content length
    updateGistStatus(content.length / 1024);
  } catch(e) {
    console.warn('Gist load failed:', e.message);
  }
}

function slimOrchardData(rows) {
  // Remap to short keys and drop zeros to minimize Gist storage
  return rows.map(row => {
    const s = {};
    const n = v => { const x = parseFloat(String(v||'').replace(/[^0-9.-]/g,'')); return isNaN(x) ? 0 : x; };
    const str = v => (v||'').trim();
    // Identity fields — always keep
    if (str(row['Display UPC']))   s.u  = str(row['Display UPC']);
    if (str(row['Product Code']))  s.pc = str(row['Product Code']);
    if (str(row['Release Name']))  s.rn = str(row['Release Name']);
    if (str(row['Artist Name']))   s.an = str(row['Artist Name']);
    if (str(row['Label Name']))    s.ln = str(row['Label Name']);
    if (str(row['Configuration'])) s.cf = str(row['Configuration']);
    // Numeric fields — only save if non-zero
    const num = (k, sk) => { const v = n(row[k]); if (v) s[sk] = v; };
    num('US Available',          'ua');
    num('US MTDS#',              'um');
    num('US 3MS#',               'u3');
    num('US 12MS#',              'u12');
    num('CA Available',          'ca');
    num('CA MTDS#',              'cm');
    num('CA 3MS#',               'c3');
    num('CA 12MS#',              'c12');
    num('DPW Stock Available',   'da');
    num('DPW Open Orders',       'do');
    num('DPW Last Month Ships',  'dl');
    num('DPW This Year Ships',   'dy');
    num('DPW Last Year Ships',   'dly');
    num('EU Stock OKL',          'ea');
    num('EU This Month',         'em');
    num('EU Last Month',         'el');
    num('EU This Year',          'ey');
    return s;
  }).filter(s => s.u); // must have UPC
}

// Expand slim orchard row back to full field names for mergeData
function expandOrchardRow(s) {
  return {
    'Display UPC':           s.u   || '',
    'Product Code':          s.pc  || '',
    'Release Name':          s.rn  || '',
    'Artist Name':           s.an  || '',
    'Label Name':            s.ln  || '',
    'Configuration':         s.cf  || '',
    'US Available':          s.ua  || 0,
    'US MTDS#':              s.um  || 0,
    'US 3MS#':               s.u3  || 0,
    'US 12MS#':              s.u12 || 0,
    'CA Available':          s.ca  || 0,
    'CA MTDS#':              s.cm  || 0,
    'CA 3MS#':               s.c3  || 0,
    'CA 12MS#':              s.c12 || 0,
    'DPW Stock Available':   s.da  || 0,
    'DPW Open Orders':       s.do  || 0,
    'DPW Last Month Ships':  s.dl  || 0,
    'DPW This Year Ships':   s.dy  || 0,
    'DPW Last Year Ships':   s.dly || 0,
    'EU Stock OKL':          s.ea  || 0,
    'EU This Month':         s.em  || 0,
    'EU Last Month':         s.el  || 0,
    'EU This Year':          s.ey  || 0,
  };
}

async function saveFPVelocityToGist() {
  if (!Object.keys(State.fp_velocity).length) return;
  try {
    const rawUrl = `https://gist.githubusercontent.com/fatpossumrecords/${CONFIG.GIST_ID}/raw/${CONFIG.GIST_FILE}`;
    let existing = {};
    try {
      const r = await fetch(rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) existing = await r.json();
    } catch(e) {}
    const ts = new Date().toISOString();
    State.fp_velocity_ts = ts;
    const payload = {
      ...existing,
      fpVelocity: State.fp_velocity,
      fpVelocityTs: ts,
    };
    const body = JSON.stringify({ files: { [CONFIG.GIST_FILE]: { content: JSON.stringify(payload) } } });
    console.log('Saving FP velocity to Gist, SKUs:', Object.keys(State.fp_velocity).length, 'size:', Math.round(body.length/1024)+'KB');
    const res = await fetch(`https://api.github.com/gists/${CONFIG.GIST_ID}`, {
      method: 'PATCH',
      headers: { 'Authorization': `token ${CONFIG.GIST_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) console.warn('FP velocity Gist save failed:', res.status);
    else console.log('FP velocity saved to Gist OK, timestamp:', ts);
  } catch(e) {
    console.warn('FP velocity Gist save failed:', e.message);
  }
}

async function saveOrchardToGist() {
  if (!State.orchardData.length) return;
  try {
    // Use raw URL to read existing data (same as other save functions)
    const rawUrl = `https://gist.githubusercontent.com/fatpossumrecords/${CONFIG.GIST_ID}/raw/${CONFIG.GIST_FILE}`;
    let existing = {};
    try {
      const r = await fetch(rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) existing = await r.json();
    } catch(e) {}
    // Merge orchard data into existing payload
    const payload = {
      ...existing,
      orchardData: slimOrchardData(State.orchardData),
      orchardTs: localStorage.getItem('fp_orchard_ts') || '',
    };
    const body = JSON.stringify({ files: { [CONFIG.GIST_FILE]: { content: JSON.stringify(payload) } } });
    console.log('Saving orchard to Gist, rows:', State.orchardData.length, 'size:', body.length);
    const saveRes = await fetch(`https://api.github.com/gists/${CONFIG.GIST_ID}`, {
      method: 'PATCH',
      headers: { 'Authorization': `token ${CONFIG.GIST_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!saveRes.ok) console.warn('Orchard Gist save failed:', saveRes.status);
    else console.log('Orchard saved to Gist OK');
  } catch(e) {
    console.warn('Orchard Gist save failed:', e.message);
  }
}

async function saveGistData() {
  try {
    // Read current Gist first to preserve orchardData
    const rawUrl = `https://gist.githubusercontent.com/fatpossumrecords/${CONFIG.GIST_ID}/raw/${CONFIG.GIST_FILE}`;
    let existing = {};
    try {
      const r = await fetch(rawUrl + '?t=' + Date.now(), { cache: 'no-store' });
      if (r.ok) existing = await r.json();
    } catch(e) {}

    const payload = {
      ...existing, // preserve orchardData, orchardTs, and anything else
      suppressed: [...State.suppressedUpcs],
      shopifyVendors: State.shopifyVendors,
      manualArtists: State.manualArtists || {},
      movements: State.movements || [],
      boxLots: State.boxLots || {},
      clearedAlerts: State.clearedAlerts || {},
      manualFormats: State.manualFormats || {},
      manualLabels: State.manualLabels || {},
    };
    const body = JSON.stringify({ files: { [CONFIG.GIST_FILE]: { content: JSON.stringify(payload) } } });
    const sizeKB = body.length / 1024;
    console.log('Saving to Gist, size:', Math.round(sizeKB)+'KB', 'orchard rows preserved:', payload.orchardData?.length || 0);
    updateGistStatus(sizeKB);
    const res = await fetch(`https://api.github.com/gists/${CONFIG.GIST_ID}`, {
      method: 'PATCH',
      headers: { 'Authorization': `token ${CONFIG.GIST_TOKEN}`, 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const err = await res.text();
      console.warn('Gist save failed:', res.status, err);
    } else {
      console.log('Gist save OK, status:', res.status);
    }
  } catch(e) {
    console.warn('Gist save failed:', e.message);
  }
}

window.toggleAllInventory = function(checked) {
  document.querySelectorAll('.inv-row-check').forEach(cb => cb.checked = checked);
  updateInventorySelection();
};

window.updateInventorySelection = function() {
  const checked = document.querySelectorAll('.inv-row-check:checked');
  const bar = document.getElementById('inv-action-bar');
  if (!bar) return;
  if (checked.length > 0) {
    bar.classList.remove('hidden');
    document.getElementById('inv-selected-count').textContent = checked.length + ' selected';
  } else {
    bar.classList.add('hidden');
  }
};

window.suppressSelected = async function() {
  const checked = document.querySelectorAll('.inv-row-check:checked');
  if (!checked.length) return;
  const toSuppress = [...checked].map(cb => ({ upc: cb.dataset.upc, artist: cb.dataset.artist, title: cb.dataset.title }));
  if (!confirm(`Suppress ${toSuppress.length} title${toSuppress.length>1?'s':''}?\n\nThese will be hidden from all views permanently. Restore from the Suppressed page.`)) return;
  toSuppress.forEach(({ upc }) => State.suppressedUpcs.add(upc));
  await saveGistData();
  mergeData();
  document.getElementById('inv-action-bar')?.classList.add('hidden');
  toast(`${toSuppress.length} title${toSuppress.length>1?'s':''} suppressed.`, 'success');
};

window.handleSuppress = function(btn) {
  const upc = btn.dataset.upc;
  const artist = btn.dataset.artist;
  const title = btn.dataset.title;
  suppressTitle(upc, artist, title);
};

window.suppressTitle = async function(upc, artist, title) {
  if (!confirm(`Suppress "${artist} — ${title}"?

This title will be hidden from inventory, alerts, and manufacturing permanently. You can restore it from the Dashboard.`)) return;
  State.suppressedUpcs.add(upc);
  await saveGistData();
  mergeData();
  toast(`"${title}" suppressed. Restore from Dashboard.`, 'success');
};

window.restoreTitle = async function(upc) {
  State.suppressedUpcs.delete(upc);
  await saveGistData();
  mergeData();
  renderSuppressedLog();
  toast('Title restored.', 'success');
};

function renderSuppressedLog() {
  const el = document.getElementById('suppressed-log');
  if (!el) return;
  const suppressed = [...State.suppressedUpcs].map(upc => {
    // Look in merged first, then raw orchard data, then packiyo products
    const fromMerged = State.merged.find(x => x.upc === upc);
    if (fromMerged) return fromMerged;
    // Check orchard data (raw, before suppression filter)
    const orchardRow = State.orchardData.find(r => normalizeUPC(r['Display UPC']||'') === upc);
    if (orchardRow) return {
      upc,
      artist: orchardRow['Artist Name'] || '—',
      title: orchardRow['Release Name'] || '—',
      catalog: orchardRow['Product Code'] || '',
    };
    // Check packiyo products
    const pkProd = State.packiyoProducts.find(p => normalizeUPC(p.barcode||'') === upc);
    if (pkProd) return { upc, artist: '—', title: pkProd.name || '—', catalog: pkProd.sku || '' };
    return { upc, artist: '—', title: '—', catalog: '' };
  });
  if (!suppressed.length) {
    el.innerHTML = '<p style="color:var(--text-muted);font-size:12px">No suppressed titles.</p>';
    return;
  }
  el.innerHTML = `<table class="dash-table">
    <thead><tr><th>Artist</th><th>Title</th><th>Catalog #</th><th>UPC</th><th></th></tr></thead>
    <tbody>${suppressed.map(p => `<tr>
      <td>${esc(p.artist)}</td>
      <td>${esc(p.title)}</td>
      <td><code>${esc(p.catalog)}</code></td>
      <td style="font-size:10px;color:var(--text-muted)">${esc(p.upc)}</td>
      <td><button class="btn-secondary btn-sm" onclick="restoreTitle('${p.upc}')">Restore</button></td>
    </tr>`).join('')}</tbody>
  </table>`;
}

// ── PACKIYO API ───────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Debounced Gist save to prevent 409 conflicts
let _gistSaveTimer = null;
function saveGistDebounced() {
  clearTimeout(_gistSaveTimer);
  _gistSaveTimer = setTimeout(() => saveGistData(), 1000);
}

async function packiyoFetch(endpoint, params = {}, retries = 3) {
  const qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = CONFIG.PACKIYO_BASE + endpoint + (qs ? '?' + qs : '');
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${CONFIG.PACKIYO_TOKEN}`, 'Accept': '*/*' }
    });
    if (res.status === 429) {
      // Rate limited — wait and retry
      const wait = (attempt + 1) * 2000;
      console.warn(`Packiyo rate limited, retrying in ${wait}ms…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) throw new Error(`Packiyo ${res.status}: ${res.statusText}`);
    return res.json();
  }
  throw new Error('Packiyo rate limit exceeded after retries');
}

async function loadPackiyo() {
  setStatus('packiyo', 'loading', 'Loading…');
  try {
    // Load all products paginated
    let page = 1, allProducts = [];
    while (true) {
      const data = await packiyoFetch('/products', { 'page[number]': page, 'page[size]': 100 });
      const items = data.data || [];
      if (!Array.isArray(items) || items.length === 0) break;
      allProducts = allProducts.concat(items);
      const lastPage = data.meta?.page?.lastPage || 1;
      if (page >= lastPage) break;
      page++;
      await sleep(150); // avoid rate limit
    }
    State.packiyoProducts = allProducts.map(p => ({ id: p.id, ...p.attributes }));
    State.packiyoLoaded = true;
    setStatus('packiyo', 'ok', `${State.packiyoProducts.length} items`);
    syncToSheets();
    // Cache slim version (only fields we use)
    try {
      const slim = State.packiyoProducts.map(p => ({
        id: p.id, sku: p.sku, name: p.name, barcode: p.barcode,
        quantity_available: p.quantity_available, quantity_on_hand: p.quantity_on_hand,
        quantity_inbound: p.quantity_inbound, quantity_allocated: p.quantity_allocated,
        tags: p.tags || '',
      }));
      localStorage.setItem('fp_packiyo_products', JSON.stringify(slim));
    } catch(e) { console.warn('Products cache failed:', e.message); }
    renderDashboard();

    // Load POs (fast) — velocity loads from Gist, only re-fetch manually
    await sleep(500);
    await loadPackiyoPOs();
    await sleep(300);
    await loadRecentPOOrders();
    // Apply cached velocity to merged products
    if (State.fp_velocity && Object.keys(State.fp_velocity).length) {
      for (const p of State.merged) {
        p.fp_12ms = State.fp_velocity[p.packiyo_sku] || State.fp_velocity[p.catalog] || 0;
      }
    }

    mergeData();
  } catch (err) {
    setStatus('packiyo', 'error', 'Error');
    toast('Packiyo load failed: ' + err.message, 'error');
    console.error('Packiyo error:', err);
    mergeData();
  }
}

async function loadPackiyoPOs() {
  try {
    // Fetch all POs with line items included in one request using JSON:API include
    let page = 1, allPOs = [], allIncluded = [];
    while (true) {
      const data = await packiyoFetch('/purchase-orders', {
        'page[number]': page,
        'page[size]': 100,
        'include': 'purchase_order_items.product',
      });
      const items = data.data || [];
      if (!Array.isArray(items) || items.length === 0) break;
      allPOs = allPOs.concat(items);
      // JSON:API puts included resources in top-level "included" array
      if (Array.isArray(data.included)) allIncluded = allIncluded.concat(data.included);
      const lastPage = data.meta?.page?.lastPage || 1;
      if (page >= lastPage) break;
      page++;
      await sleep(200);
    }

    // Build lookups for line items and products from included
    const lineItemById = {};
    const productById = {};
    for (const inc of allIncluded) {
      if (inc.type === 'purchase-order-items') lineItemById[inc.id] = inc;
      if (inc.type === 'products') productById[inc.id] = inc.attributes || {};
    }

    // Build sku -> PO map — skip closed POs, use quantity_pending > 0
    const poMap = {};
    for (const po of allPOs) {
      const attrs = po.attributes || {};
      // Skip closed or fully received POs
      if (attrs.closed_at) continue;
      const poNumber = attrs.number || po.id;
      const itemRefs = po.relationships?.purchase_order_items?.data || [];
      for (const ref of itemRefs) {
        const lineItem = lineItemById[ref.id];
        if (!lineItem) continue;
        const lineAttrs = lineItem.attributes || {};
        const qtyPending = safeNum(lineAttrs.quantity_pending);
        if (qtyPending <= 0) continue; // only care about items still pending
        // Get SKU from the related product
        const productRef = lineItem.relationships?.product?.data;
        const product = productRef ? productById[productRef.id] : null;
        const sku = product?.sku || '';
        if (!sku) continue;
        if (!poMap[sku]) poMap[sku] = { qty: 0, pos: [] };
        poMap[sku].qty += qtyPending;
        poMap[sku].pos.push({ poId: poNumber, qty: qtyPending });

        // Store line data on PO object for queue view
        if (!po._lines) po._lines = [];
        const prod = productById[productRef?.id] || {};
        po._lines.push({
          sku, qty: safeNum(lineAttrs.quantity),
          qtyPending, qtyReceived: safeNum(lineAttrs.quantity_received),
          artist: prod.name ? '' : '',  // filled from merged data below
          title: prod.name || '',
          catalog: prod.sku || sku,
          format: '',
        });
      }
    }

    State.packiyoPOs = poMap;
    State.packiyoPOList = allPOs.filter(po => !po.attributes?.closed_at);

    // Enrich PO lines with artist/format from merged products
    setTimeout(() => {
      for (const po of State.packiyoPOList) {
        for (const line of (po._lines || [])) {
          const merged = State.merged.find(p => p.packiyo_sku === line.sku || p.catalog === line.sku);
          if (merged) {
            line.artist = merged.artist;
            line.title = line.title || merged.title;
            line.catalog = merged.orchard_catalog || merged.catalog;
            line.format = merged.format;
          }
        }
      }
    }, 2000);
    const poCount = Object.keys(poMap).length;
    console.log(`POs loaded: ${poCount} SKUs with open orders | allPOs: ${allPOs.length} | openPOs: ${allPOs.filter(p=>!p.attributes?.closed_at).length} | included: ${allIncluded.length} | lineItems: ${Object.keys(lineItemById).length} | products: ${Object.keys(productById).length}`);
    if (poCount > 0) console.log('Sample PO data:', JSON.stringify(Object.entries(poMap).slice(0,3)));
    if (poCount === 0 && Object.keys(lineItemById).length > 0) {
      // Debug: show a sample line item and its product lookup
      const sampleId = Object.keys(lineItemById)[0];
      const sampleLine = lineItemById[sampleId];
      const sampleProdRef = sampleLine.relationships?.product?.data;
      const sampleProd = sampleProdRef ? productById[sampleProdRef.id] : null;
      console.log('Sample line item:', JSON.stringify(sampleLine.attributes));
      console.log('Sample product ref:', JSON.stringify(sampleProdRef));
      console.log('Sample product found:', JSON.stringify(sampleProd));
    }
  } catch(e) {
    console.warn('Could not load POs:', e.message);
    State.packiyoPOs = {};
  }
}

// ── RECENT PO ORDERS (for movement status tracking) ─────────
async function loadRecentPOOrders() {
  try {
    // Get total page count first
    const first = await packiyoFetch('/orders', { 'page[number]': 1, 'page[size]': 100 });
    const lastPage = first.meta?.page?.lastPage || 1;
    // Fetch last 3 pages to capture recent PO# orders
    const pagesToFetch = [lastPage, lastPage-1, lastPage-2].filter(p => p > 0);
    const poOrders = [];
    for (const page of pagesToFetch) {
      await sleep(200);
      const data = await packiyoFetch('/orders', { 'page[number]': page, 'page[size]': 100 });
      const orders = data.data || [];
      orders.filter(o => (o.attributes?.number||'').startsWith('PO#')).forEach(o => {
        poOrders.push({
          number: (o.attributes.number||'').trim(),
          status_text: o.attributes.status_text,
          fulfilled_at: o.attributes.fulfilled_at,
        });
      });
    }
    if (poOrders.length) {
      State.fp_poOrders = poOrders;
      console.log('Recent PO orders loaded:', poOrders.length, poOrders.map(p=>p.number+' '+p.status_text));
      checkMovementStatuses();
    }
  } catch(e) {
    console.warn('Could not load recent PO orders:', e.message);
  }
}

// ── FP SALES VELOCITY ────────────────────────────────────────
async function loadFPVelocity() {
  try {
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const skuVelocity = {};
    const allPoOrders = [];

    setStatus('packiyo', 'loading', 'Loading sales…');

    // Orders are oldest-first — get total pages then work backwards from last page
    const firstData = await packiyoFetch('/orders', { 'page[number]': 1, 'page[size]': 100 });
    const totalPages = firstData.meta?.page?.lastPage || 1;
    console.log('Total order pages:', totalPages, '— fetching recent 12 months from end');

    let page = totalPages;
    while (page >= 1) {
      const data = await packiyoFetch('/orders', {
        'page[number]': page,
        'page[size]': 100,
        'include': 'order_items',
      });
      const orders = data.data || [];
      if (!orders.length) break;

      // Collect PO# orders for movement status tracking
      orders.filter(o => (o.attributes?.number||'').startsWith('PO#')).forEach(o => {
        allPoOrders.push({
          number: (o.attributes.number||'').trim(),
          status_text: o.attributes.status_text,
          fulfilled_at: o.attributes.fulfilled_at,
        });
      });

      // If the newest order on this page is older than 12 months, stop
      const newestDate = new Date(orders[0]?.attributes?.ordered_at || 0);
      if (newestDate < oneYearAgo) break;

      // Count fulfilled non-PO# orders within last 12 months
      const validIds = new Set(
        orders.filter(o => {
          const a = o.attributes || {};
          const num = a.number || '';
          return (a.status_text||'').toLowerCase() === 'fulfilled'
            && new Date(a.ordered_at||0) >= oneYearAgo
            && !num.startsWith('PO#')
            && !num.startsWith('PO:');
        }).map(o => o.id)
      );

      for (const inc of (data.included || [])) {
        if (inc.type !== 'order-items') continue;
        const a = inc.attributes || {};
        const sku = a.sku || '';
        const qty = safeNum(a.quantity_shipped);
        if (sku && qty > 0) skuVelocity[sku] = (skuVelocity[sku] || 0) + qty;
      }

      page--;
      await sleep(200);
    }

    console.log('FP velocity: fetched pages', totalPages, 'down to', page+1, '— SKUs with sales:', Object.keys(skuVelocity).length);

    State.fp_velocity = skuVelocity;
    State.fp_poOrders = allPoOrders;
    try { localStorage.setItem('fp_packiyo_velocity', JSON.stringify(skuVelocity)); } catch(e) {}

    // Apply to merged products
    for (const p of State.merged) {
      p.fp_12ms = skuVelocity[p.packiyo_sku] || skuVelocity[p.catalog] || 0;
    }
    setStatus('packiyo', 'ok', `${State.packiyoProducts.length} items`);
    // Save velocity to Gist for other devices
    await saveFPVelocityToGist();
    checkMovementStatuses();
    renderAlerts();
    renderDashboard();
    buildNeedsAttentionBanner();
    updateNotifications();
    renderInventory();
  } catch(e) {
    console.warn('FP velocity load failed:', e.message);
    setStatus('packiyo', 'ok', `${State.packiyoProducts.length} items`);
  }
}

// ── ORCHARD CSV ───────────────────────────────────────────────
function loadOrchardCSV(file) {
  setStatus('orchard', 'loading', 'Parsing…');
  const reader = new FileReader();
  reader.onload = async e => {
    try {
      State.orchardData = deduplicateOrchard(parseCSV(e.target.result));
      State.orchardLoaded = true;
      localStorage.setItem('fp_orchard_ts', new Date().toISOString()); localStorage.setItem('fp_orchard_uploads', JSON.stringify(getUploadHistory()));
      updateOrchardStatus();
      mergeData();
      // Save to Gist for all users
      setStatus('orchard', 'loading', 'Saving to cloud…');
      await saveOrchardToGist();
      updateOrchardStatus();
      toast(`Orchard CSV loaded: ${State.orchardData.length} products — saved to cloud`, 'success');
    } catch (err) {
      setStatus('orchard', 'error', 'Parse error');
      toast('CSV parse error: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

function loadShopifyCSV(file) {
  if (!window.Papa) {
    const script = document.createElement('script');
    script.src = 'https://cdnjs.cloudflare.com/ajax/libs/PapaParse/5.4.1/papaparse.min.js';
    script.onload = () => loadShopifyCSV(file);
    document.head.appendChild(script);
    return;
  }
  window.Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: async (results) => {
      try {
        const rows = results.data;
        const vendors = {};
        let currentVendor = '';
        for (const row of rows) {
          const sku = (row['Variant SKU'] || '').trim();
          const upc = normalizeUPC(row['Variant Barcode'] || '');
          // Only process rows that have a real variant SKU or barcode
          if (!sku && !upc) continue;
          const vendor = (row['Vendor'] || '').trim();
          // Only update vendor if this row has one AND it looks like a real artist name
          // Valid: "Soccer Mommy", "Al Green" — Invalid: "g::Folk", long HTML strings
          if (vendor && !vendor.startsWith('g::') && !vendor.includes('<') && !vendor.includes('shopify') && vendor.length < 80) {
            currentVendor = vendor;
          }
          if (currentVendor && upc) vendors[upc] = currentVendor;
          if (currentVendor && sku) vendors['sku:' + sku] = currentVendor;
        }
        State.shopifyVendors = vendors;
        setStatus('shopify', 'loading', 'Saving…');
        await saveGistData();
        const mappingCount = Object.keys(vendors).length;
        setStatus('shopify', 'ok', mappingCount + ' artists');
        applyShopifyVendors();
        renderInventory();
        toast(`Shopify CSV: ${mappingCount} artist mappings saved`, 'success');
      } catch(err) {
        toast('Shopify CSV error: ' + err.message, 'error');
      }
    },
    error: (err) => toast('Shopify parse error: ' + err.message, 'error'),
  });
}

function applyShopifyVendors() {
  for (const p of State.merged) {
    if (p.artist) continue; // already has artist from Orchard CSV
    // Check manual entries first (highest priority after Orchard)
    if (State.manualArtists[p.upc]) { p.artist = State.manualArtists[p.upc]; continue; }
    // Then Shopify vendor
    const byUpc = State.shopifyVendors[p.upc];
    const bySku = State.shopifyVendors['sku:' + p.packiyo_sku] || State.shopifyVendors['sku:' + p.catalog];
    if (byUpc || bySku) p.artist = byUpc || bySku;
  }
}

window.editArtistCell = function(td) {
  const upc = td.dataset.upc;
  const current = td.firstChild?.textContent?.trim() || '';
  td.innerHTML = `<input type="text" class="artist-input" data-upc="${upc}" value="${esc(current)}" style="border:none;background:transparent;font-family:inherit;font-size:inherit;color:var(--text);width:100%;outline:none;border-bottom:1px solid var(--accent);" />`;
  const input = td.querySelector('input');
  input.focus();
  input.select();
};

// Delegate artist input events via body
document.addEventListener('blur', e => {
  if (e.target.classList.contains('artist-input')) {
    const upc = e.target.dataset.upc;
    const val = e.target.value.trim();
    if (upc && val) saveManualArtist(upc, val);
  }
}, true);

document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.target.classList.contains('artist-input')) {
    e.target.blur();
  }
});

// ── BOX LOTS / MANUAL FORMAT / MANUAL LABEL ─────────────────
window.saveBoxLot = async function(upc, value) {
  State.boxLots[upc] = value.trim();
  if (!value.trim()) delete State.boxLots[upc];
  await saveGistData();
  syncToSheets();
};

window.saveManualFormat = async function(upc, value) {
  if (value) State.manualFormats[upc] = value;
  else delete State.manualFormats[upc];
  // Apply to merged product
  const p = State.merged.find(x => x.upc === upc);
  if (p && value) p.format = value;
  await saveGistData();
  syncToSheets();
};

window.handleLabelBlur = async function(input) {
  const upc = input.dataset.upc;
  const orig = input.dataset.orig;
  const val = input.value.trim();
  input.style.border = '1px solid ' + (val ? 'var(--border2)' : 'transparent');
  if (val === orig) return; // no change
  await saveManualLabel(upc, val);
};

window.clearManualLabel = async function(upc) {
  if (!confirm('Clear manual label for this title?')) return;
  delete State.manualLabels[upc];
  const p = State.merged.find(x => x.upc === upc);
  if (p) p.label = p._origLabel || '';
  await saveGistData();
  renderInventory();
  toast('Label cleared.', '');
};

window.saveManualLabel = async function(upc, value) {
  if (value) State.manualLabels[upc] = value;
  else delete State.manualLabels[upc];
  const p = State.merged.find(x => x.upc === upc);
  if (p && value) p.label = value;
  await saveGistData();
  syncToSheets();
};

// ── GOOGLE SHEETS SYNC ────────────────────────────────────────
window.initSheetsAuth = function() {
  const client = google.accounts.oauth2.initTokenClient({
    client_id: CONFIG.GOOGLE_CLIENT_ID,
    scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file',
    callback: (resp) => {
      if (resp.access_token) {
        State.sheetsToken = resp.access_token;
        console.log('Sheets auth OK');
        syncToSheets();
      }
    },
  });
  client.requestAccessToken({ prompt: 'consent' });
};

async function syncToSheets() {
  if (!State.sheetsToken) return; // not authed yet — skip silently
  const availableWarehouseUpcs = new Set(
    State.packiyoProducts
      .filter(p => (p.tags||'').toLowerCase().includes('available wholesale'))
      .map(p => (p.barcode||'').replace(/[^0-9]/g,'').replace(/^0+/,''))
      .filter(Boolean)
  );
  console.log('Available Warehouse SKUs for sheet:', availableWarehouseUpcs.size);
  const rows = State.merged
    .filter(p => availableWarehouseUpcs.has(p.upc))
    .sort((a, b) => (a.artist||'').toLowerCase().localeCompare((b.artist||'').toLowerCase()))
    .map(p => {
      const fmt    = State.manualFormats[p.upc] || p.format || '';
      const lbl    = State.manualLabels[p.upc]  || p.label  || '';
      const boxLot = State.boxLots[p.upc] || '';
      // FP-only status for sheet
      const fpAvail = p.fp_available || 0;
      const fpStatus = fpAvail === 0 ? 'out'
        : fpAvail <= 15 ? 'critical'
        : fpAvail <= 50 ? 'low'
        : 'ok';
      return [p.artist, p.title, p.catalog, p.upc, boxLot, fmt, lbl, fpStatus, fpAvail > 300 ? 300 : fpAvail];
    });

  const HEADER = ['Artist','Title','Catalog #','UPC','Box Lot','Format','Label','Status','FP Available'];
  const sheetRange = CONFIG.SHEET_NAME + '!A1';

  try {
    // Clear entire sheet then rewrite from scratch
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(CONFIG.SHEET_NAME)}:clear`,
      { method: 'POST', headers: { 'Authorization': 'Bearer ' + State.sheetsToken } }
    );

    // Write last updated row + header + all rows
    const now = new Date();
    const dateLabel = 'Last updated: ' + (now.getMonth()+1) + '/' + now.getDate() + '/' + String(now.getFullYear()).slice(2)
      + ' ' + now.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});
    const allRows = [[dateLabel], HEADER, ...rows];
    await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${CONFIG.SHEET_ID}/values/${encodeURIComponent(CONFIG.SHEET_NAME + '!A1')}?valueInputOption=RAW`,
      {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + State.sheetsToken, 'Content-Type': 'application/json' },
        body: JSON.stringify({ values: allRows }),
      }
    );

    console.log('Sheets sync OK — rows written:', rows.length);
    setStatus('sheets', 'ok', 'Synced ' + new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}));
  } catch(e) {
    console.warn('Sheets sync failed:', e.message);
    setStatus('sheets', 'error', 'Sync failed');
  }
}

window.saveManualArtist = async function(upc, value) {
  if (!value.trim()) return;
  State.manualArtists[upc] = value.trim();
  await saveGistData();
  // Apply to the product in State.merged
  const p = State.merged.find(x => x.upc === upc);
  if (p) p.artist = value.trim();
  renderInventory();
  toast('Artist saved.', 'success');
};

function parseCSVRobust(text) {
  // Handles multiline quoted fields (e.g. Shopify HTML body)
  const rows = [];
  let headers = null;
  let i = 0;
  while (i < text.length) {
    const fields = [];
    while (i < text.length) {
      if (text[i] === '"') {
        // Quoted field
        i++;
        let val = '';
        while (i < text.length) {
          if (text[i] === '"' && text[i+1] === '"') { val += '"'; i += 2; }
          else if (text[i] === '"') { i++; break; }
          else { val += text[i++]; }
        }
        fields.push(val);
        if (text[i] === ',') i++;
      } else {
        // Unquoted field
        let val = '';
        while (i < text.length && text[i] !== ',' && text[i] !== '\n' && text[i] !== '\r') {
          val += text[i++];
        }
        fields.push(val);
        if (text[i] === ',') i++;
      }
      if (i >= text.length || text[i] === '\n' || text[i] === '\r') break;
    }
    // Skip \r\n or \n
    if (text[i] === '\r') i++;
    if (text[i] === '\n') i++;
    if (!headers) { headers = fields; continue; }
    if (fields.length === 0 || (fields.length === 1 && !fields[0])) continue;
    const row = {};
    headers.forEach((h, idx) => { row[h] = fields[idx] || ''; });
    rows.push(row);
  }
  return rows;
}

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).filter(l => l.trim()).map(line => {
    const vals = parseCSVLine(line);
    const row = {};
    headers.forEach((h, i) => { row[h.trim()] = (vals[i] || '').trim(); });
    return row;
  });
}
function parseCSVLine(line) {
  const result = []; let cur = '', inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuote = !inQuote; }
    else if (ch === ',' && !inQuote) { result.push(cur); cur = ''; }
    else { cur += ch; }
  }
  result.push(cur);
  return result;
}
function deduplicateOrchard(rows) {
  const byUPC = new Map();
  for (const row of rows) {
    const upc = normalizeUPC(row['Display UPC'] || '');
    if (!upc) continue;
    if (!byUPC.has(upc)) { byUPC.set(upc, { ...row }); }
    else {
      const existing = byUPC.get(upc);
      for (const [k, v] of Object.entries(row)) {
        const cur = existing[k];
        if ((!cur || cur === '0' || cur === '' || cur === '#N/A') && v && v !== '0' && v !== '#N/A') existing[k] = v;
      }
    }
  }
  return Array.from(byUPC.values());
}
function normalizeUPC(upc) {
  return String(upc).replace(/\D/g,'').replace(/^0+/,'') || '';
}

// ── MERGE DATA ────────────────────────────────────────────────
function mergeData() {
  const products = new Map();

  for (const p of State.packiyoProducts) {
    const upc = normalizeUPC(p.barcode || '');
    if (!upc) continue;
    products.set(upc, {
      upc,
      catalog:      p.sku || '',
      packiyo_sku:  p.sku || '',  // keep original packiyo SKU for PO lookup
      title:        p.name || '',
      artist:       '',
      label:        '',
      format:       '', // format only from Orchard CSV, never Packiyo
      fromPackiyo:  true,
      fp_available: safeNum(p.quantity_available),
      fp_onhand:    safeNum(p.quantity_on_hand),
      fp_inbound:   safeNum(p.quantity_inbound),
      fp_allocated: safeNum(p.quantity_allocated),
      fp_12ms: 0, // filled after loading order history
      us_avail: 0, us_mtd: 0, us_3ms: 0, us_12ms: 0,
      ca_avail: 0, ca_mtd: 0, ca_3ms: 0, ca_12ms: 0,
      uk_avail: 0, uk_open: 0, uk_last_mo: 0, uk_this_yr: 0, uk_last_yr: 0,
      eu_avail: 0, eu_mtd: 0, eu_last_mo: 0, eu_this_yr: 0,
    });
  }

  for (const row of State.orchardData) {
    const upc = normalizeUPC(row['Display UPC'] || '');
    if (!upc) continue;
    const o = {
      orchard_catalog: row['Product Code'] || '',
      orchard_title:   row['Release Name'] || '',
      artist:          row['Artist Name'] || '',
      label:           normalizeLabel(row['Label Name'] || ''),
      format:          row['Configuration'] || '',
      us_avail:   safeNum(row['US Available']),
      us_mtd:     safeNum(row['US MTDS#']),
      us_3ms:     safeNum(row['US 3MS#']),
      us_12ms:    safeNum(row['US 12MS#']),
      ca_avail:   safeNum(row['CA Available']),
      ca_mtd:     safeNum(row['CA MTDS#']),
      ca_3ms:     safeNum(row['CA 3MS#']),
      ca_12ms:    safeNum(row['CA 12MS#']),
      uk_avail:   safeNum(row['DPW Stock Available']),
      uk_open:    safeNum(row['DPW Open Orders']),
      uk_last_mo: safeNum(row['DPW Last Month Ships']),
      uk_this_yr: safeNum(row['DPW This Year Ships']),
      uk_last_yr: safeNum(row['DPW Last Year Ships']),
      eu_avail:   safeNum(row['EU Stock OKL']),
      eu_mtd:     safeNum(row['EU This Month']),
      eu_last_mo: safeNum(row['EU Last Month']),
      eu_this_yr: safeNum(row['EU This Year']),
    };
    if (products.has(upc)) {
      const p = products.get(upc);
      Object.assign(p, o);
      if (!p.catalog) p.catalog = o.orchard_catalog;
      if (!p.title)   p.title   = o.orchard_title;
      // Always keep orchard catalog # separate for Orchard-bound exports
      p.orchard_catalog = o.orchard_catalog || p.catalog;
    } else {
      products.set(upc, {
        upc, catalog: o.orchard_catalog, title: o.orchard_title,
        packiyo_sku: '',
        artist: o.artist, label: normalizeLabel(o.label), format: o.format,
        fromPackiyo: false, fp_available: 0, fp_onhand: 0, fp_inbound: 0, fp_allocated: 0,
        fp_12ms: 0,
        ...o,
      });
    }
  }

  State.merged = Array.from(products.values()).filter(p => (p.title || p.catalog) && !State.suppressedUpcs.has(p.upc));
  // Re-apply Shopify vendor artists
  applyShopifyVendors();
  // Auto-restore cleared alerts if stock has increased
  for (const [key, cleared] of Object.entries(State.clearedAlerts)) {
    const [upc, whKey] = key.split('|');
    const p = State.merged.find(x => x.upc === upc);
    if (!p) continue;
    const wh = WAREHOUSES.find(w => w.key === whKey);
    if (!wh) continue;
    const avail = p[wh.avail] || 0;
    if (avail > cleared.availAtClear) {
      delete State.clearedAlerts[key];
      console.log('Auto-restored alert:', upc, whKey, 'avail now', avail, 'vs cleared at', cleared.availAtClear);
    }
  }
  // Apply manual format and label overrides
  for (const p of State.merged) {
    if (State.manualFormats[p.upc]) p.format = State.manualFormats[p.upc];
    if (State.manualLabels[p.upc])  p.label  = State.manualLabels[p.upc];
  }
  // Re-apply FP velocity if already loaded
  if (State.fp_velocity && Object.keys(State.fp_velocity).length > 0) {
    for (const p of State.merged) {
      p.fp_12ms = State.fp_velocity[p.packiyo_sku] || State.fp_velocity[p.catalog] || 0;
    }
  }
  populateLabelDropdown();
  renderInventory();
  renderManufacturing();
  renderAlerts();
  renderDashboard();
}

function populateLabelDropdown() {
  const sel = document.getElementById('alert-filter-label');
  if (!sel) return;
  const labels = [...new Set(State.merged.map(p => p.label).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">All labels</option>' +
    labels.map(l => `<option value="${esc(l)}"${l === current ? ' selected' : ''}>${esc(l)}</option>`).join('');
}

// ── INVENTORY VIEW ────────────────────────────────────────────
// Column definitions: id, label, numeric, group (fp/us/ca/uk/eu/meta), always-visible
const INV_COLS = [
  { id:'artist',     label:'Artist',      num:false, group:'meta',  always:true  },
  { id:'title',      label:'Title',       num:false, group:'meta',  always:true  },
  { id:'label',      label:'Label',       num:false, group:'meta',  always:true  },
  { id:'catalog',    label:'Catalog #',   num:false, group:'meta',  always:true  },
  { id:'total',      label:'Total Stock', num:true,  group:'meta',  always:true  },
  { id:'upc',        label:'UPC',         num:false, group:'meta',  always:true  },
  { id:'box_lot',    label:'Box Lot',     num:false, group:'meta',  always:true  },
  { id:'format',     label:'Format',      num:false, group:'meta',  always:true  },
  { id:'status',     label:'Status',      num:false, group:'meta',  always:true  },
  { id:'open_po',    label:'PO ✓  Move →', num:false, group:'meta',  always:true  },
  // FP WH
  { id:'fp_available', label:'FP Avail',  num:true,  group:'fp',    always:true  },
  { id:'fp_inbound',   label:'FP Inbound',num:true,  group:'fp',    always:false },
  { id:'fp_12ms',      label:'FP 12MS',   num:true,  group:'fp',    always:false },
  // Orchard US
  { id:'us_avail',   label:'US Avail',    num:true,  group:'us',    always:true  },
  { id:'us_mtd',     label:'US MTD',      num:true,  group:'us',    always:false },
  { id:'us_3ms',     label:'US 3MS',      num:true,  group:'us',    always:false },
  { id:'us_12ms',    label:'US 12MS',     num:true,  group:'us',    always:false },
  // Orchard Canada
  { id:'ca_avail',   label:'CA Avail',    num:true,  group:'ca',    always:true  },
  { id:'ca_mtd',     label:'CA MTD',      num:true,  group:'ca',    always:false },
  { id:'ca_3ms',     label:'CA 3MS',      num:true,  group:'ca',    always:false },
  { id:'ca_12ms',    label:'CA 12MS',     num:true,  group:'ca',    always:false },
  // Orchard UK
  { id:'uk_avail',   label:'UK Avail',    num:true,  group:'uk',    always:true  },
  { id:'uk_open',    label:'UK Open Ord', num:true,  group:'uk',    always:false },
  { id:'uk_last_mo', label:'UK Last Mo',  num:true,  group:'uk',    always:false },
  { id:'uk_this_yr', label:'UK This Yr',  num:true,  group:'uk',    always:false },
  { id:'uk_last_yr', label:'UK Last Yr',  num:true,  group:'uk',    always:false },
  // Orchard EU
  { id:'eu_avail',   label:'EU Avail',    num:true,  group:'eu',    always:true  },
  { id:'eu_mtd',     label:'EU MTD',      num:true,  group:'eu',    always:false },
  { id:'eu_last_mo', label:'EU Last Mo',  num:true,  group:'eu',    always:false },
  { id:'eu_this_yr', label:'EU This Yr',  num:true,  group:'eu',    always:false },
];

const GROUP_LABELS = { fp:'Fat Possum WH', us:'Orchard US', ca:'Orchard Canada', uk:'Orchard UK', eu:'Orchard EU', meta:'' };

function visibleCols() {
  return INV_COLS.filter(c => c.always || State.expanded[c.group]);
}

// Fixed sticky columns - always frozen, no pin UI needed
const STICKY_COLS = ['artist', 'title', 'catalog', 'total'];
const STICKY_WIDTHS = { artist: 140, title: 240, catalog: 100, total: 80 };
// Precompute sticky left offsets
const STICKY_OFFSETS = {};
let _stickyLeft = 0;
for (const id of STICKY_COLS) {
  STICKY_OFFSETS[id] = _stickyLeft;
  _stickyLeft += STICKY_WIDTHS[id];
}

function buildInventoryHeader() {
  const thead = document.getElementById('inventory-thead');
  if (!thead) return;
  const cols = visibleCols();
  // Apply colgroup first so column widths are set before header renders
  applyColWidths();

  // Single header row with warehouse labels embedded in first avail column
  let row = '<tr>';
  for (let i = 0; i < cols.length; i++) {
    const col = cols[i];
    const next = cols[i+1];
    const isGroupEnd = !next || next.group !== col.group;
    const isGroupStart = i === 0 || cols[i-1].group !== col.group;
    const isSticky = STICKY_COLS.includes(col.id);
    const w = isSticky ? STICKY_WIDTHS[col.id] : (State.colWidths[col.id] || getDefaultWidth(col));
    const sortable = col.id !== 'status' && col.id !== 'upc' ? 'sortable' : '';
    const sortCls = State.sortCol === col.id ? (State.sortDir === 'asc' ? ' sort-asc' : ' sort-desc') : '';
    const resizeHandle = !isSticky ? `<span class="resize-handle" onmousedown="startResize(event,'${col.id}')"></span>` : '';
    const stickyStyle = isSticky ? `position:sticky;left:${STICKY_OFFSETS[col.id]}px;z-index:11;background:var(--surface2);` : '';
    const borderRight = isGroupEnd ? 'border-right:2px solid var(--border2);' : '';

    // For the first column of each warehouse group, add the group label + expand btn above the col label
    let topLabel = '';
    if (col.group !== 'meta' && isGroupStart) {
      const allGroupCols = INV_COLS.filter(c => c.group === col.group);
      const hasSales = allGroupCols.some(c => !c.always);
      const groupLabel = hasSales
        ? `<span onclick="event.stopPropagation();toggleExpand('${col.group}')" style="cursor:pointer;color:${State.expanded[col.group]?'var(--text-muted)':'var(--accent)'};font-weight:600;font-size:9px;text-decoration:${State.expanded[col.group]?'none':'underline'};" title="${State.expanded[col.group]?'Collapse':'Expand sales columns'}">${GROUP_LABELS[col.group]}${State.expanded[col.group]?' ▾':' ▸'}</span>`
        : `<span style="font-size:9px;color:var(--text-muted);font-weight:600;">${GROUP_LABELS[col.group]}</span>`;
      topLabel = `<div style="margin-bottom:2px;line-height:1.4;">${groupLabel}</div>`;
    } else if (col.group !== 'meta') {
      topLabel = `<div style="margin-bottom:2px;height:14px;"></div>`;
    }

    row += `<th class="${col.num?'num':''} ${sortable}${sortCls}${isSticky?' is-pinned':''}"
      data-col="${col.id}"
      style="width:${w}px;min-width:${w}px;max-width:${w}px;position:sticky;top:0;${stickyStyle}${borderRight}overflow:hidden;vertical-align:bottom;padding-bottom:6px;"
      onclick="handleInvSort('${col.id}')"
    >${topLabel}${col.label}${resizeHandle}</th>`;
  }
  row += '</tr>';

  thead.innerHTML = row;
}

function getDefaultWidth(col) {
  if (col.id === 'artist') return 160;
  if (col.id === 'title')  return 200;
  if (col.id === 'label')  return 120;
  if (col.id === 'catalog') return 90;
  if (col.id === 'upc')    return 110;
  if (col.id === 'format') return 80;
  if (col.num)             return 72;
  return 100;
}

function applyColWidths() {
  const table = document.getElementById('inventory-table');
  if (!table) return;
  let cg = table.querySelector('colgroup');
  if (!cg) { cg = document.createElement('colgroup'); table.prepend(cg); }
  const cols = visibleCols();
  cg.innerHTML = cols.map(col => {
    const w = STICKY_COLS.includes(col.id) ? STICKY_WIDTHS[col.id] : (State.colWidths[col.id] || getDefaultWidth(col));
    return `<col style="width:${w}px;min-width:${w}px;max-width:${w}px">`;
  }).join('');
}

// Pin logic removed - artist/title/catalog always frozen

// Resize logic
let _resizing = null;
window.startResize = function(e, colId) {
  e.preventDefault();
  const startX = e.clientX;
  const startW = State.colWidths[colId] || getDefaultWidth(INV_COLS.find(c=>c.id===colId));
  _resizing = { colId, startX, startW };
  document.addEventListener('mousemove', onResizeMove);
  document.addEventListener('mouseup', onResizeUp);
};
function onResizeMove(e) {
  if (!_resizing) return;
  const newW = Math.max(40, _resizing.startW + (e.clientX - _resizing.startX));
  State.colWidths[_resizing.colId] = newW;
  applyColWidths();
}
function onResizeUp() {
  _resizing = null;
  document.removeEventListener('mousemove', onResizeMove);
  document.removeEventListener('mouseup', onResizeUp);
  applyColWidths();
}

window.toggleExpand = function(group) {
  State.expanded[group] = !State.expanded[group];
  renderInventory();
};

window.handleInvSort = function(col) {
  if (!col || col === 'status' || col === 'upc') return;
  if (State.sortCol === col) State.sortDir = State.sortDir === 'asc' ? 'desc' : 'asc';
  else { State.sortCol = col; State.sortDir = 'asc'; }
  renderInventory();
};

function getVal(p, colId) {
  if (colId === 'total') return (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
  if (colId === 'status') return stockStatus(p);
  if (colId === 'open_po') return '';
  if (colId === 'box_lot') return State.boxLots[p.upc] || '';
  return p[colId] ?? '';
}

function renderInventory() {
  const search    = (document.getElementById('search-input').value || '').toLowerCase();
  const cfgFilter = document.getElementById('filter-config').value.toLowerCase();
  const whFilter  = document.getElementById('filter-warehouse').value;
  const statusFilter = (document.getElementById('filter-status')?.value || '');


  let rows = State.merged.filter(p => {
    if (search) {
      if (!`${p.artist} ${p.title} ${p.catalog} ${p.upc} ${p.label}`.toLowerCase().includes(search)) return false;
    }
    if (cfgFilter) {
      const fmt = (p.format||'').toLowerCase();
      if (cfgFilter === 'lp' && !fmt.includes('vinyl') && !fmt.includes('lp') && !fmt.includes('12"')) return false;
      if (cfgFilter === 'cd' && !fmt.includes('cd')) return false;
    }
    if (whFilter) {
      const avail = { fp:p.fp_available, us:p.us_avail, ca:p.ca_avail, uk:p.uk_avail, eu:p.eu_avail };
      if ((avail[whFilter]||0) <= 0) return false;
    }
    if (statusFilter && stockStatus(p) !== statusFilter) return false;
    return true;
  });

  rows.sort((a, b) => {
    let av = getVal(a, State.sortCol), bv = getVal(b, State.sortCol);
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return State.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return State.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  updateClearFiltersBtn();
  document.getElementById('inventory-count').textContent =
    `${rows.length.toLocaleString()} products${State.merged.length !== rows.length ? ` (of ${State.merged.length.toLocaleString()})` : ''}`;

  buildInventoryHeader();

  const cols = visibleCols();
  const tbody = document.getElementById('inventory-tbody');

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="${cols.length}" class="empty-cell">No products match current filters.</td></tr>`;
    return;
  }

  // Precompute pinned left offsets
  let leftOff = 0;
  const pinOffsets = {};
  for (const col of cols) {
    if (State.pinnedCols.has(col.id)) {
      pinOffsets[col.id] = leftOff;
      leftOff += State.colWidths[col.id] || getDefaultWidth(col);
    }
  }

  tbody.innerHTML = rows.map(p => {
    return '<tr>' + cols.map((col, i) => {
      const nextCol = cols[i+1];
      const isGroupEnd = !nextCol || nextCol.group !== col.group;
      const isPinned = State.pinnedCols.has(col.id);
      const borderRight = isGroupEnd ? 'border-right:2px solid var(--border2);' : '';
      const isSticky = STICKY_COLS.includes(col.id);
      const stickyStyle = isSticky ? `position:sticky;left:${STICKY_OFFSETS[col.id]}px;z-index:3;box-shadow:${!nextCol||nextCol.group!==col.group?'2px 0 5px rgba(0,0,0,0.08)':'none'};` : '';
      const pinnedClass = isSticky ? ' is-pinned' : '';
      const style = `${borderRight}${stickyStyle}`;
      const v = getVal(p, col.id);

      if (col.id === 'artist') {
        const isManual = !!State.manualArtists[p.upc];
        if (!v) {
          return `<td class="mob-artist${pinnedClass}" style="${style}"><input type="text" class="artist-input" data-upc="${p.upc}" placeholder="Add artist…" /></td>`;
        }
        return `<td class="mob-artist${pinnedClass}" style="${style}" data-upc="${p.upc}" class="artist-cell" ondblclick="editArtistCell(this)">${esc(v)}${isManual ? ' <span style="font-size:9px;color:var(--text-dim)">✎</span>' : ''}</td>`;
      }
      if (col.id === 'title')   return `<td class="mob-title${pinnedClass}" style="${style}">${esc(v)}</td>`;
      if (col.id === 'label') {
        const lblVal = State.manualLabels[p.upc] || v || '';
        const isManual = !!State.manualLabels[p.upc];
        const listId = 'lbl-' + p.upc;
        const labels = [...new Set(State.merged.map(x => normalizeLabel(x.label)).filter(Boolean))].sort();
        const dataopts = labels.map(l => '<option value="' + esc(l) + '">').join('');
        return '<td class="' + pinnedClass + '" style="' + style + '">'
          + '<datalist id="' + listId + '">' + dataopts + '</datalist>'
          + '<input type="text" list="' + listId + '" value="' + esc(lblVal) + '" data-upc="' + p.upc + '" data-orig="' + esc(lblVal) + '"'
          + ' class="label-input"'
          + ' style="width:105px;font-size:10px;padding:2px 5px;background:' + (isManual ? 'var(--surface)' : 'var(--surface2)') + ';border:1px solid ' + (isManual ? 'var(--border2)' : 'transparent') + ';border-radius:2px;color:var(--text);"'
          + ' onfocus="this.style.border=\'1px solid var(--accent)\'"'
          + ' onblur="handleLabelBlur(this)"'
          + ' oncontextmenu="event.preventDefault();clearManualLabel(\''+p.upc+'\')" />'
          + '</td>';
      }
      if (col.id === 'status')  return `<td class="mob-status${pinnedClass}" style="${style}">${statusPill(v)}</td>`;
      if (col.id === 'open_po') {
        const hasMov = State.movements.some(m => m.upc === p.upc && (m.status === 'confirmed' || m.status === 'shipped'));
        const hasPO  = !!(State.packiyoPOs[p.packiyo_sku] || State.packiyoPOs[p.catalog])?.qty;
        const poMark  = hasPO  ? '<span style="color:var(--green);font-size:13px;" title="Open PO">✓</span>' : '';
        const movMark = hasMov ? '<span style="color:var(--green);font-size:13px;" title="Stock movement confirmed">→</span>' : '';
        const mark = poMark || movMark ? (poMark + (poMark && movMark ? ' ' : '') + movMark) : '';
        return `<td class="${pinnedClass}" style="text-align:center;${style}">${mark}</td>`;
      }
      if (col.id === 'total')   return `<td class="num mob-total${pinnedClass}" style="font-weight:600;${style}">${numCell(v)}</td>`;
      if (col.id === 'catalog') return `<td class="mob-catalog${pinnedClass}" style="${style}"><code>${esc(v)}</code></td>`;
      if (col.id === 'upc')     return `<td class="${pinnedClass}" style="${style}"><code style="font-size:10px">${esc(v)}</code></td>`;
      if (col.id === 'box_lot') {
        const bl = State.boxLots[p.upc] || '';
        return `<td class="${pinnedClass}" style="${style}">
          <input type="text" value="${esc(bl)}" placeholder="—"
            data-upc="${p.upc}"
            style="width:80px;font-size:11px;padding:2px 5px;background:${bl?'var(--surface)':'var(--surface2)'};border:1px solid ${bl?'var(--border2)':'transparent'};border-radius:2px;color:var(--text);font-family:'DM Mono',monospace;"
            onchange="saveBoxLot('${p.upc}',this.value).then(()=>{this.style.background='#e8f5e9';setTimeout(()=>this.style.background=this.value?'var(--surface)':'var(--surface2)',600)})"
            onkeydown="if(event.key==='Enter'){saveBoxLot('${p.upc}',this.value).then(()=>{this.style.background='#e8f5e9';setTimeout(()=>this.style.background=this.value?'var(--surface)':'var(--surface2)',600)});this.blur()}"
            onfocus="this.style.border='1px solid var(--accent)'"
            onblur="this.style.border='1px solid '+(this.value?'var(--border2)':'transparent')" />
        </td>`;
      }
      if (col.id === 'format') {
        const fmtVal = State.manualFormats[p.upc] || v;
        const formats = [...new Set(State.merged.map(x=>x.format).filter(Boolean))].sort();
        const opts = formats.map(f => `<option value="${esc(f)}"${f===fmtVal?' selected':''}>${esc(f)}</option>`).join('');
        return `<td class="mob-format${pinnedClass}" style="${style}">
          <select data-upc="${p.upc}" onchange="saveManualFormat('${p.upc}',this.value)"
            style="font-size:10px;padding:2px 4px;background:var(--surface2);border:1px solid var(--border2);border-radius:2px;color:var(--text);max-width:100px;">
            <option value="">—</option>
            ${opts}
          </select>
        </td>`;
      }
      if (col.id === 'fp_available') {
        const alertWh = alertingWarehouses(p);
        const alertStyle = alertWh.fp === 'critical' ? 'color:var(--orange);font-weight:600;' : alertWh.fp === 'low' ? 'color:var(--yellow);font-weight:600;' : '';
        return `<td class="num${pinnedClass}" style="${style}${alertStyle}" title="On Hand: ${p.fp_onhand} | Inbound: ${p.fp_inbound} | Allocated: ${p.fp_allocated}">${numCell(v)}</td>`;
      }
      if (col.num) {
        const whMap = { us_avail:'us', ca_avail:'ca', uk_avail:'uk', eu_avail:'eu' };
        const alertWh = alertingWarehouses(p);
        const whKey = whMap[col.id];
        const alertStyle = whKey && alertWh[whKey] === 'critical' ? 'color:var(--orange);font-weight:600;' : whKey && alertWh[whKey] === 'low' ? 'color:var(--yellow);font-weight:600;' : '';
        return `<td class="num${pinnedClass}" style="${style}${alertStyle}">${numCell(v)}</td>`;
      }
      return `<td class="${pinnedClass}" style="${style}">${esc(v)}</td>`;
    }).join('') + `<td style="text-align:center;width:32px;border-left:1px solid var(--border);"><input type="checkbox" class="inv-row-check" data-upc="${p.upc}" data-artist="${esc(p.artist)}" data-title="${esc(p.title)}" onchange="updateInventorySelection()" /></td>` + '</tr>';
  }).join('');
}

window.clearInventoryFilters = function() {
  document.getElementById('search-input').value = '';
  document.getElementById('filter-config').value = '';
  document.getElementById('filter-warehouse').value = '';
  document.getElementById('filter-status').value = '';
  document.getElementById('clear-filters-btn').style.display = 'none';
  renderInventory();
};

function updateClearFiltersBtn() {
  const btn = document.getElementById('clear-filters-btn');
  if (!btn) return;
  const active = document.getElementById('search-input').value
    || document.getElementById('filter-config').value
    || document.getElementById('filter-warehouse').value
    || document.getElementById('filter-status').value;
  btn.style.display = active ? '' : 'none';
}

function stockStatus(p) {
  const total = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
  if (total === 0) return 'out';
  const checks = [
    { avail: p.us_avail, vel12: p.us_12ms },
    { avail: p.ca_avail, vel12: p.ca_12ms },
    { avail: p.uk_avail, vel12: p.uk_last_yr },
    { avail: p.eu_avail, vel12: p.eu_this_yr },
    { avail: p.fp_available, vel12: p.fp_12ms },
  ];
  let worst = 'ok';
  for (const { avail, vel12 } of checks) {
    if (avail <= 0) continue;
    const monthly = (vel12||0) / 12;
    if (monthly <= 0) continue;
    const weeksLeft = (avail / monthly) * 4.33;
    if (weeksLeft < 4 && worst !== 'critical') worst = 'critical';
    else if (weeksLeft < CONFIG.REORDER_WEEKS && worst === 'ok') worst = 'low';
  }
  return worst;
}
function statusPill(status) {
  const map = {
    ok:       ['OK',       'pill-ok'],
    low:      ['Low',      'pill-low'],
    critical: ['Critical', 'pill-critical'],
    out:      ['Out',      'pill-out'],
  };
  const [label, cls] = map[status] || ['—',''];
  return `<span class="pill ${cls}">${label}</span>`;
}

// Return which warehouse cell(s) are triggering the status
function alertingWarehouses(p) {
  const checks = [
    { key:'us', avail: p.us_avail, vel12: p.us_12ms },
    { key:'ca', avail: p.ca_avail, vel12: p.ca_12ms },
    { key:'uk', avail: p.uk_avail, vel12: p.uk_last_yr },
    { key:'eu', avail: p.eu_avail, vel12: p.eu_this_yr },
    { key:'fp', avail: p.fp_available, vel12: p.fp_12ms },
  ];
  const alerting = {};
  for (const { key, avail, vel12 } of checks) {
    if (avail <= 0) continue;
    const monthly = (vel12||0) / 12;
    if (monthly <= 0) continue;
    const weeksLeft = (avail / monthly) * 4.33;
    if (weeksLeft < CONFIG.REORDER_WEEKS) alerting[key] = weeksLeft < 4 ? 'critical' : 'low';
  }
  return alerting;
}

// ── MANUFACTURING VIEW ────────────────────────────────────────
function renderManufacturing() {
  const urgFilter = document.getElementById('mfg-filter').value;
  const today  = new Date();

  let items = State.merged.map(p => {
    if (State.hiddenMfgItems.has(p.upc)) return null;
    const totalStock = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
    const poQty = (State.packiyoPOs[p.packiyo_sku] || State.packiyoPOs[p.catalog])?.qty || 0;
    const hasPO = poQty > 0;
    const totalWithInbound = totalStock + (p.fp_inbound||0) + poQty;
    const annual = (p.us_12ms||0)+(p.ca_12ms||0)+(p.uk_last_yr||0)+(p.eu_this_yr||0);
    const monthly = annual / 12;
    if (monthly <= 0 && !hasPO) return null;
    const need12mo = monthly > 0 ? Math.ceil(monthly * 12) : 0;
    const monthsLeft = monthly > 0 ? totalWithInbound / monthly : Infinity;
    // Show within trigger window; always show items with open POs under 12 months
    if (monthsLeft > 12) return null;
    if (!hasPO && monthsLeft > CONFIG.MFG_TRIGGER_MONTHS + 3) return null;

    const isLPItem = isVinyl(p.format || '');
    const leadTime = isLPItem ? CONFIG.LEAD_TIME.lp : CONFIG.LEAD_TIME.cd;
    // Handle Infinity monthsLeft (no sales velocity) gracefully
    const poDeadlineDate = isFinite(monthsLeft)
      ? new Date(today.getTime() + (monthsLeft - leadTime) * 30 * 24 * 3600 * 1000)
      : null;
    const daysToDeadline = poDeadlineDate ? Math.round((poDeadlineDate - today) / (24 * 3600 * 1000)) : Infinity;

    let urgency = 'plan';
    if (isFinite(daysToDeadline)) {
      if (daysToDeadline < 0) urgency = 'overdue';
      else if (daysToDeadline < 30) urgency = 'urgent';
      else if (daysToDeadline < 90) urgency = 'soon';
    }

    // Shortfall = 12mo global need minus total stock (including inbound/PO)
    // This is the manufacturing gap — how many units are needed beyond what exists or is coming
    const globalShortfall = Math.max(0, need12mo - totalWithInbound);

    return { ...p, totalStock, poQty, totalWithInbound, monthly, need12mo, globalShortfall, monthsLeft, poDeadlineDate, daysToDeadline, urgency, isLP: isLPItem, hasPO };
  }).filter(Boolean);

  // Urgency filter
  if (urgFilter === 'urgent')  items = items.filter(i => i.urgency === 'urgent' || i.urgency === 'overdue');
  if (urgFilter === 'soon')    items = items.filter(i => i.urgency === 'soon');
  if (urgFilter === 'plan')    items = items.filter(i => i.urgency === 'plan');
  if (urgFilter === 'has_po')  items = items.filter(i => i.hasPO);
  if (urgFilter === 'lp')      items = items.filter(i => i.isLP);
  if (urgFilter === 'cd')      items = items.filter(i => !i.isLP);

  items.sort((a, b) => {
    let av = a[State.mfgSortCol], bv = b[State.mfgSortCol];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return State.mfgSortDir === 'asc' ? -1 : 1;
    if (av > bv) return State.mfgSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  // Wire up sort headers
  document.querySelectorAll('#mfg-table th.sortable').forEach(th => {
    th.onclick = () => {
      const col = th.dataset.col;
      if (State.mfgSortCol === col) State.mfgSortDir = State.mfgSortDir === 'asc' ? 'desc' : 'asc';
      else { State.mfgSortCol = col; State.mfgSortDir = 'asc'; }
      document.querySelectorAll('#mfg-table th.sortable').forEach(t => t.classList.remove('sort-asc','sort-desc'));
      th.classList.add(State.mfgSortDir === 'asc' ? 'sort-asc' : 'sort-desc');
      renderManufacturing();
    };
  });

  const tbody = document.getElementById('mfg-tbody');
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="14" class="empty-cell">No items match current filters.</td></tr>`;
    return;
  }

  const hiddenCount = State.hiddenMfgItems.size;

  tbody.innerHTML = items.map(p => {
    const urgPill = {
      overdue: `<span class="pill pill-critical">Overdue</span>`,
      urgent:  `<span class="pill pill-urgent">Urgent</span>`,
      soon:    `<span class="pill pill-soon">Soon</span>`,
      plan:    `<span class="pill pill-plan">Plan</span>`,
    }[p.urgency] || '';

    const dl = !p.poDeadlineDate
      ? `<span style="color:var(--text-muted)">No velocity data</span>`
      : p.daysToDeadline < 0
        ? `<span style="color:var(--red);font-weight:600">PAST DUE</span>`
        : formatDate(p.poDeadlineDate);

    const inboundCell = p.fp_inbound > 0
      ? `<span style="color:var(--green);font-weight:500">${p.fp_inbound}</span>`
      : `<span class="num-zero">0</span>`;

    const poCell = p.poQty > 0
      ? `<span style="color:var(--blue);font-weight:600" title="${(State.packiyoPOs[p.packiyo_sku] || State.packiyoPOs[p.catalog])?.pos?.map(x=>x.poId+': '+x.qty).join(', ')}">${p.poQty}</span>`
      : `<span class="num-zero">—</span>`;

    const rowStyle = p.hasPO ? 'background:#fffbe6;' : '';
    const rowHoverClass = p.hasPO ? 'class="row-has-po"' : '';

    const shortfallCell = p.globalShortfall > 0
      ? `<span style="color:var(--red);font-weight:700">${p.globalShortfall.toLocaleString()}</span>`
      : `<span style="color:var(--green);font-size:11px">✓ covered</span>`;
    return `<tr style="${rowStyle}" ${rowHoverClass}>
      <td>${esc(p.artist)}</td>
      <td>${esc(p.title)}</td>
      <td>${catalogLink(p.catalog)}</td>
      <td>${esc(p.format)}</td>
      <td class="num">${numCell(p.totalStock)}</td>
      <td class="num">${inboundCell}</td>
      <td class="num">${poCell}</td>
      <td class="num" style="font-style:italic;color:var(--text-muted)">${numCell(p.totalWithInbound)}</td>
      <td class="num">${p.monthly.toFixed(1)}</td>
      <td class="num" style="font-weight:600;color:var(--accent)">${p.need12mo}</td>
      <td class="num">${shortfallCell}</td>
      <td class="num" style="font-weight:600">${isFinite(p.monthsLeft) ? p.monthsLeft.toFixed(1) : '∞'}</td>
      <td>${dl}</td>
      <td>${urgPill}</td>
      <td><button class="btn-ghost" style="font-size:11px;color:var(--text-dim)" onclick="hideMfgItem('${p.upc}')">Hide</button></td>
    </tr>`;
  }).join('') + (hiddenCount > 0 ? `<tr><td colspan="14" style="text-align:center;padding:10px;color:var(--text-muted);font-size:11px;background:var(--surface2)">${hiddenCount} item${hiddenCount>1?'s':''} hidden. <a href="#" onclick="event.preventDefault();State.hiddenMfgItems.clear();localStorage.removeItem('fp_hidden_mfg');renderManufacturing()" style="color:var(--accent)">Show all</a></td></tr>` : '');
}

window.hideMfgItem = function(upc) {
  State.hiddenMfgItems.add(upc);
  localStorage.setItem('fp_hidden_mfg', JSON.stringify([...State.hiddenMfgItems]));
  renderManufacturing();
  toast('Item hidden. Use "Show all" to restore.', '');
};

// ── ALERTS VIEW ───────────────────────────────────────────────
const WAREHOUSES = [
  { key:'fp', label:'Fat Possum WH',  avail:'fp_available', vel:'fp_12ms',   velDiv:12, repFrom: 'us' },
  { key:'us', label:'Orchard US',     avail:'us_avail',     vel:'us_12ms',   velDiv:12, repFrom: 'fp' },
  { key:'ca', label:'Orchard Canada', avail:'ca_avail',     vel:'ca_12ms',   velDiv:12, repFrom: 'us' },
  { key:'uk', label:'Orchard UK',     avail:'uk_avail',     vel:'uk_last_yr',velDiv:12, repFrom: 'us' },
  { key:'eu', label:'Orchard EU',     avail:'eu_avail',     vel:'eu_this_yr',velDiv:12, repFrom: 'uk' },
];

function renderAlerts(preserveExpanded=false) {
  const container = document.getElementById('alerts-container');
  const labelFilter = (document.getElementById('alert-filter-label')?.value || '').toLowerCase().trim();
  let totalAlerts = 0;
  let html = '';
  if (!preserveExpanded) _expandedAlertWh = null; // reset so first warehouse auto-expands

  for (const wh of WAREHOUSES) {
    // Sum confirmed/shipped movement quantities inbound to this warehouse per UPC
    const confirmedInbound = {};
    for (const m of State.movements) {
      if ((m.status === 'confirmed' || m.status === 'shipped') && m.to === wh.key) {
        confirmedInbound[m.upc] = (confirmedInbound[m.upc] || 0) + (m.qty || 0);
      }
    }

    let alerts = State.merged.map(p => {
      // Skip if alert is cleared and avail hasn't increased
      const clearKey = p.upc + '|' + wh.key;
      const cleared = State.clearedAlerts[clearKey];
      if (cleared) {
        const avail = (p[wh.avail]||0) + (confirmedInbound[p.upc]||0);
        if (avail <= cleared.availAtClear) return null; // still cleared
        else delete State.clearedAlerts[clearKey]; // auto-restore
      }
      const avail   = (p[wh.avail] || 0) + (confirmedInbound[p.upc] || 0);
      const annual  = p[wh.vel] || 0;
      const monthly = annual / wh.velDiv;
      if (monthly <= 0 || avail < 0) return null;
      const weeksLeft = (avail / monthly) * 4.33;
      if (weeksLeft >= CONFIG.REORDER_WEEKS) return null;
      const suggestQty = Math.max(0, Math.ceil(monthly * 12 - avail));
      // Cap transfer at what the source warehouse actually has available
      const sourceAvail = wh.key === 'fp' ? (p.us_avail||0)  // FP replenishes from Orchard US
                        : wh.key === 'us' ? (p.fp_available||0)
                        : wh.key === 'ca' ? (p.us_avail||0)
                        : wh.key === 'uk' ? (p.us_avail||0)
                        : wh.key === 'eu' ? (p.uk_avail||0) + (p.us_avail||0)
                        : suggestQty;
      const transferQty = Math.min(suggestQty, sourceAvail);
      const shortfall   = Math.max(0, suggestQty - sourceAvail);
      const leavesAtSource = isFinite(sourceAvail) ? Math.max(0, sourceAvail - transferQty) : null;
      // Calculate global supply need (sum of all Orchard shortfalls) for non-FP warehouses
      let globalNeed = 0;
      if (wh.key !== 'fp') {
        const ONWHS = [
          { avail: p.us_avail||0, vel12: p.us_12ms||0 },
          { avail: p.ca_avail||0, vel12: p.ca_12ms||0 },
          { avail: p.uk_avail||0, vel12: p.uk_last_yr||0 },
          { avail: p.eu_avail||0, vel12: p.eu_this_yr||0 },
        ];
        for (const owh of ONWHS) {
          const mo = owh.vel12/12; if (mo<=0) continue;
          const wks = (owh.avail/mo)*4.33; if (wks>=CONFIG.REORDER_WEEKS) continue;
          globalNeed += Math.max(0, Math.ceil(mo*12-owh.avail));
        }
      }
      const effectiveQty = Math.max(transferQty, globalNeed);
      return { ...p, avail, monthly, weeksLeft, suggestQty, transferQty, shortfall, sourceAvail, leavesAtSource, globalNeed, effectiveQty };
    }).filter(Boolean);

    // Apply label filter
    if (labelFilter) alerts = alerts.filter(p => (p.label||'').toLowerCase().includes(labelFilter));

    if (alerts.length === 0) continue;

    // Sort
    const s = State.alertSort[wh.key];
    alerts.sort((a, b) => {
      let av = a[s.col], bv = b[s.col];
      if (typeof av === 'string') av = av.toLowerCase();
      if (typeof bv === 'string') bv = bv.toLowerCase();
      if (av < bv) return s.dir === 'asc' ? -1 : 1;
      if (av > bv) return s.dir === 'asc' ? 1 : -1;
      return 0;
    });

    totalAlerts += alerts.length;

    const repFrom    = wh.repFrom;
    const repLabel   = repFrom ? WH_LABELS[repFrom] : '—';

    const sortTh = (col, label, num=false) => {
      const active = s.col === col;
      const arrow  = active ? (s.dir==='asc'?' ↑':' ↓') : '';
      return `<th class="${num?'num':''} sortable${active?(s.dir==='asc'?' sort-asc':' sort-desc'):''}"
        onclick="sortAlerts('${wh.key}','${col}')">${label}${arrow}</th>`;
    };

    // Auto-expand first warehouse section
    if (_expandedAlertWh === null) _expandedAlertWh = wh.key;
    const isExpanded = _expandedAlertWh === wh.key;
    html += `<div class="alert-section" id="alert-section-${wh.key}">
      <h3 onclick="toggleAlertSection('${wh.key}')" style="cursor:pointer;display:flex;align-items:center;justify-content:space-between;">
        <span>
          <span class="alert-arrow" style="font-size:10px;margin-right:6px;color:var(--text-dim)">${isExpanded ? '▾' : '▸'}</span>
          ${wh.label} — ${alerts.length} item${alerts.length>1?'s':''} below ${CONFIG.REORDER_WEEKS} weeks
        </span>
        <span style="font-weight:400;" onclick="event.stopPropagation()">
          <a href="#" onclick="event.preventDefault();selectAllAlerts('${wh.key}')" style="color:var(--accent);font-size:10px">Select all</a>
          &nbsp;·&nbsp;
          <a href="#" onclick="event.preventDefault();deselectAllAlerts('${wh.key}')" style="color:var(--text-muted);font-size:10px">Deselect all</a>
          &nbsp;·&nbsp;
          <a href="#" onclick="event.preventDefault();clearSelectedAlerts('${wh.key}')" style="color:var(--accent);font-size:10px;font-weight:600;">Clear alert</a>
        </span>
      </h3>
      <div class="alert-table-wrap" style="display:${isExpanded ? 'block' : 'none'}"><div class="table-wrap"><table id="alert-table-${wh.key}" style="table-layout:fixed;min-width:1100px;">
        <colgroup>
          <col style="width:32px">
          <col style="width:160px">
          <col style="width:220px">
          <col style="width:100px">
          <col style="width:120px">
          <col style="width:80px">
          <col style="width:70px">
          <col style="width:70px">
          <col style="width:80px">
          <col style="width:90px">
          <col style="width:90px">
          <col style="width:110px">
        </colgroup>
        <thead><tr>
          <th style="position:sticky;left:0;z-index:11;background:var(--surface2);width:32px;min-width:32px;text-align:center;"><input type="checkbox" title="Select all" onchange="toggleAllAlerts('${wh.key}',this.checked)" /></th>
          <th style="position:sticky;left:32px;z-index:11;background:var(--surface2);width:160px;min-width:160px;cursor:pointer;" onclick="sortAlerts('${wh.key}','artist')">Artist${s.col==='artist'?(s.dir==='asc'?' ↑':' ↓'):''}</th>
          <th style="position:sticky;left:192px;z-index:11;background:var(--surface2);width:220px;min-width:220px;cursor:pointer;" onclick="sortAlerts('${wh.key}','title')">Title${s.col==='title'?(s.dir==='asc'?' ↑':' ↓'):''}</th>
          <th style="position:sticky;left:412px;z-index:11;background:var(--surface2);width:100px;min-width:100px;box-shadow:3px 0 6px rgba(0,0,0,0.07);cursor:pointer;" onclick="sortAlerts('${wh.key}','catalog')">Catalog #${s.col==='catalog'?(s.dir==='asc'?' ↑':' ↓'):''}</th>
          ${sortTh('label','Label')}
          ${sortTh('format','Format')}
          ${sortTh('avail','Avail',true)}
          ${sortTh('monthly','Mo. Velocity',true)}
          <th>Status</th>
          ${sortTh('suggestQty','12M Need',true)}
          ${sortTh('transferQty','Can Transfer',true)}
          <th>Replenish From</th>
          ${wh.key !== 'fp' ? '<th class="num">Global Supply Need</th><th>For Who</th>' : ''}
        </tr></thead>
        <tbody>
          ${alerts.map(p => {
            const weeks = p.weeksLeft.toFixed(1);
            const cls = p.weeksLeft < 2 ? 'pill-critical' : p.weeksLeft < 4 ? 'pill-urgent' : 'pill-low';
            const bg = 'background:var(--surface)';
            // Replenish from cell
            const leavesNote = p.leavesAtSource !== null
              ? '<div style="font-size:9px;color:' + (p.leavesAtSource===0 ? 'var(--red)' : 'var(--text-muted)') + ';font-weight:400;">leaves ' + p.leavesAtSource + ' at source</div>'
              : '';
            const repCell = p.sourceAvail > 0
              ? '<td style="color:var(--text-muted);font-size:11px">' + repLabel + leavesNote + '</td>'
              : '<td style="font-size:11px"><a href="#" onclick="event.preventDefault();switchView(\'manufacturing\')" style="color:var(--accent);font-weight:600;">Order more?</a></td>';
            return `<tr>
              <td style="position:sticky;left:0px;z-index:3;${bg};width:32px;text-align:center;"><input type="checkbox" class="alert-check" data-wh="${wh.key}" data-upc="${esc(p.upc)}" data-qty="${p.effectiveQty}" data-from="${repFrom}" data-to="${wh.key}" /></td>
              <td style="position:sticky;left:32px;z-index:3;${bg};width:160px;min-width:160px;max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.artist)}</td>
              <td style="position:sticky;left:192px;z-index:3;${bg};width:220px;min-width:220px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(p.title)}</td>
              <td style="position:sticky;left:412px;z-index:3;${bg};width:100px;min-width:100px;box-shadow:3px 0 5px rgba(0,0,0,0.07);white-space:nowrap;">${catalogLink(p.catalog)}</td>
              <td style="color:var(--text-muted);font-size:11px">${esc(p.label)}</td>
              <td>${esc(p.format)}</td>
              <td class="num">${numCell(p.avail)}</td>
              <td class="num">${p.monthly.toFixed(1)}</td>
              <td><span class="pill ${cls}">${weeks} wks</span>

                ${(()=>{
                  const _po = State.packiyoPOs[p.packiyo_sku] || State.packiyoPOs[p.catalog];
                  const _mov = State.movements.find(m => m.upc === p.upc && (m.status==='confirmed'||m.status==='shipped'));
                  let _f = '';
                  if (_po?.qty > 0) _f += '<div style="font-size:9px;color:var(--green);font-weight:600;margin-top:2px;">&#128230; '+_po.qty.toLocaleString()+' inbound (PO)</div>';
                  if (_mov) _f += '<div style="font-size:9px;color:#3b7de8;font-weight:600;margin-top:2px;">&#10003; transfer '+_mov.status+'</div>';
                  return _f;
                })()}
              </td>
              <td class="num" style="font-weight:600;color:var(--accent)">${p.suggestQty > 0 ? p.suggestQty.toLocaleString() : '<span class="num-zero">—</span>'}</td>
              <td class="num suggest-qty">${p.transferQty > 0 ? p.transferQty : '<span class="num-zero">—</span>'}</td>
              ${repCell}
              ${(()=>{
                if (wh.key === 'fp') return '';
                const OWH = [
                  { key:'us', avail: p.us_avail||0, vel12: p.us_12ms||0 },
                  { key:'ca', avail: p.ca_avail||0, vel12: p.ca_12ms||0 },
                  { key:'uk', avail: p.uk_avail||0, vel12: p.uk_last_yr||0 },
                  { key:'eu', avail: p.eu_avail||0, vel12: p.eu_this_yr||0 },
                ];
                const W2 = { us:'US', ca:'CA', uk:'UK', eu:'EU' };
                let totalNeed = 0; const needingWhs = [];
                for (const owh of OWH) {
                  const mo = owh.vel12/12; if (mo<=0) continue;
                  const wks = (owh.avail/mo)*4.33; if (wks>=CONFIG.REORDER_WEEKS) continue;
                  const nd = Math.max(0,Math.ceil(mo*12-owh.avail)); totalNeed+=nd; needingWhs.push(W2[owh.key]);
                }
                if (!totalNeed) return '<td></td><td></td>';
                const canCover = (p.fp_available||0) >= totalNeed;
                const nc = canCover ? '<td class="num" style="font-weight:700;color:var(--accent)">'+totalNeed.toLocaleString()+'</td>' : '<td class="num" style="font-size:10px;color:var(--text-muted)">FP insufficient</td>';
                // 2x2 grid box for For Who
                const WH_ALL = ['US','CA','UK','EU'];
                const grid = WH_ALL.map(w => {
                  const active = needingWhs.includes(w);
                  return '<span style="display:inline-block;padding:1px 5px;margin:1px;border-radius:2px;font-size:9px;font-weight:700;'
                    + (active ? 'background:var(--accent);color:white;' : 'background:var(--surface2);color:var(--text-dim);')
                    + '">' + w + '</span>';
                });
                const fc = '<td style="white-space:normal;">'
                  + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:1px;width:52px;">'
                  + grid.join('')
                  + '</div></td>';
                return nc+fc;
              })()}
            </tr>`;
          }).join('')}
        </tbody>
      </table></div></div>
    </div>`;
  }

  if (html === '') {
    container.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:60px">All warehouses are above the ${CONFIG.REORDER_WEEKS}-week threshold. No alerts.</div>`;
  } else {
    container.innerHTML = html;
  }

  const badge = document.getElementById('alert-badge');
  badge.textContent = totalAlerts;
  totalAlerts > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
}

window.clearSelectedAlerts = async function(whKey) {
  const checked = document.querySelectorAll('.alert-check[data-wh="'+whKey+'"]:checked');
  if (!checked.length) { toast('No items selected.', 'error'); return; }
  const wh = WAREHOUSES.find(w => w.key === whKey);
  checked.forEach(cb => {
    const upc = cb.dataset.upc;
    const p = State.merged.find(x => x.upc === upc);
    if (!p || !wh) return;
    const avail = (p[wh.avail]||0);
    State.clearedAlerts[upc + '|' + whKey] = { clearedAt: new Date().toISOString(), availAtClear: avail };
  });
  await saveGistData();
  renderAlerts();
  updateNotifications();
  toast(checked.length + ' alert' + (checked.length>1?'s':'') + ' cleared. Will restore if stock increases.', 'success');
};

// Track expanded alert section
let _expandedAlertWh = null; // will be set to first warehouse with alerts on render

window.toggleAlertSection = function(whKey) {
  _expandedAlertWh = _expandedAlertWh === whKey ? null : whKey;
  // Show/hide table-wrap for each section
  document.querySelectorAll('.alert-section').forEach(sec => {
    const key = sec.id.replace('alert-section-','');
    const wrap = sec.querySelector('.alert-table-wrap');
    const arrow = sec.querySelector('.alert-arrow');
    if (wrap) wrap.style.display = key === _expandedAlertWh ? 'block' : 'none';
    if (arrow) arrow.textContent = key === _expandedAlertWh ? '▾' : '▸';
  });
};

window.sortAlerts = function(whKey, col) {
  const s = State.alertSort[whKey];
  if (s.col === col) s.dir = s.dir === 'asc' ? 'desc' : 'asc';
  else { s.col = col; s.dir = 'asc'; }
  renderAlerts(true);
};

window.jumpToAlertWarehouse = function(whKey) {
  if (!whKey) return;
  const el = document.getElementById(`alert-section-${whKey}`);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('alert-jump-wh').value = '';
};

window.toggleAllAlerts = function(whKey, checked) {
  document.querySelectorAll(`.alert-check[data-wh="${whKey}"]`).forEach(cb => cb.checked = checked);
};
window.selectAllAlerts = function(whKey) {
  document.querySelectorAll(`.alert-check[data-wh="${whKey}"]`).forEach(cb => cb.checked = true);
};
window.deselectAllAlerts = function(whKey) {
  document.querySelectorAll(`.alert-check[data-wh="${whKey}"]`).forEach(cb => cb.checked = false);
};

window.applyAlertSelections = function() {
  const checked = document.querySelectorAll('.alert-check:checked');
  if (checked.length === 0) { toast('No items selected.', 'error'); return; }

  let added = 0;
  checked.forEach(cb => {
    const upc   = cb.dataset.upc;
    const from  = cb.dataset.from;
    const to    = cb.dataset.to;
    let qty = parseInt(cb.dataset.qty, 10);
    if (isNaN(qty) || qty < 0) return;
    if (qty === 0) qty = 1; // no stock at source, add as placeholder so user can see it
    const prod = State.merged.find(p => p.upc === upc);
    if (!prod) return;
    // Avoid duplicates already in queue
    const exists = State.movements.find(m => m.upc === upc && m.from === from && m.to === to);
    if (exists) return;
    // Calculate leaves-at-source note
    const sourceAvailMap = { fp: prod.fp_available||0, us: prod.us_avail||0, ca: prod.ca_avail||0, uk: prod.uk_avail||0, eu: prod.eu_avail||0 };
    const sourceAvail = sourceAvailMap[from] || 0;
    const leavesAt = Math.max(0, sourceAvail - qty);
    const WH_SHORT = { fp:'FP WH', us:'Orchard US', ca:'Orchard CA', uk:'Orchard UK', eu:'Orchard EU' };
    const leaveNote = `Leaves ${leavesAt} at ${WH_SHORT[from]||from}`;
    // Find or create a draft shipment for this route
    const routeKey = `${from}→${to}`;
    const draftShipment = State.movements.find(m => m.from === from && m.to === to && m.status === 'draft');
    const shipmentId = draftShipment ? draftShipment.shipmentId : `${routeKey}-${Date.now()}`;
    State.movements.push({
      from, to, shipmentId,
      artist:  prod.artist,
      title:   prod.title,
      catalog: prod.orchard_catalog || prod.catalog,
      upc:     prod.upc,
      format:  prod.format,
      label:   prod.label,
      qty,
      notes:   leaveNote,
      status:  'draft',
      poNumber: '',
      confirmedAt: null,
      processedAt: null,
      timestamp: new Date().toISOString(),
    });
    added++;
  });

  renderMovementsTable();
  saveGistData();
  if (added === 0) {
    toast('Already in queue — switching to Movements.', '');
  } else {
    toast(`${added} movement${added>1?'s':''} added to queue.`, 'success');
  }
  switchView('movements');
  setTimeout(renderMovementsTable, 50);
};

// ── MOVEMENTS ──────────────────────────────────────────────────
const VALID_ROUTES = new Set(['fp→us','us→ca','us→uk','us→eu','uk→eu']);
const WH_LABELS = { fp:'Fat Possum WH', us:'Orchard US', ca:'Orchard Canada', uk:'Orchard UK', eu:'Orchard EU' };

function validateRoute() {
  const from = document.getElementById('mov-from').value;
  const to   = document.getElementById('mov-to').value;
  const warn = document.getElementById('mov-route-warning');
  const route = `${from}→${to}`;
  if (from === to) { warn.textContent = 'Origin and destination cannot be the same.'; warn.classList.remove('hidden'); }
  else if (!VALID_ROUTES.has(route)) { warn.textContent = `⚠ Non-standard route: ${WH_LABELS[from]} → ${WH_LABELS[to]}.`; warn.classList.remove('hidden'); }
  else { warn.classList.add('hidden'); }
}

function updateMovementDropdown() {
  const q  = document.getElementById('mov-product-search').value.toLowerCase().trim();
  const dd = document.getElementById('mov-product-dropdown');
  if (q.length < 2) { dd.classList.add('hidden'); return; }
  const matches = State.merged.filter(p => `${p.artist} ${p.title} ${p.catalog} ${p.upc}`.toLowerCase().includes(q)).slice(0, 15);
  if (matches.length === 0) { dd.classList.add('hidden'); return; }
  dd.innerHTML = matches.map(p =>
    `<div class="product-dropdown-item" data-upc="${esc(p.upc)}">
      <strong>${esc(p.artist)} — ${esc(p.title)}</strong>
      <div class="dd-sub">${esc(p.catalog)} · ${esc(p.upc)} · ${esc(p.format)}</div>
    </div>`
  ).join('');
  dd.classList.remove('hidden');
  dd.querySelectorAll('.product-dropdown-item').forEach(item => {
    item.addEventListener('click', () => {
      const prod = State.merged.find(p => p.upc === item.dataset.upc);
      if (!prod) return;
      document.getElementById('mov-product-search').value = `${prod.artist} — ${prod.title}`;
      document.getElementById('mov-product-upc').value = prod.upc;
      dd.classList.add('hidden');
      const sel = document.getElementById('mov-selected-product');
      sel.innerHTML = `<strong>${esc(prod.artist)} — ${esc(prod.title)}</strong>
        <span>${esc(prod.catalog)} · ${esc(prod.upc)} · ${esc(prod.format)} · FP: ${prod.fp_available} · US: ${prod.us_avail} · CA: ${prod.ca_avail} · UK: ${prod.uk_avail} · EU: ${prod.eu_avail}</span>`;
      sel.classList.remove('hidden');
    });
  });
}
document.addEventListener('click', e => {
  if (!e.target.closest('#mov-product-search') && !e.target.closest('#mov-product-dropdown'))
    document.getElementById('mov-product-dropdown')?.classList.add('hidden');
});

function addMovement() {
  const from  = document.getElementById('mov-from').value;
  const to    = document.getElementById('mov-to').value;
  const upc   = document.getElementById('mov-product-upc').value;
  const qty   = parseInt(document.getElementById('mov-qty').value, 10);
  const notes = document.getElementById('mov-notes').value;
  if (!upc) { toast('Please select a product.', 'error'); return; }
  if (!qty || qty < 1) { toast('Quantity must be at least 1.', 'error'); return; }
  if (from === to) { toast('Origin and destination cannot be the same.', 'error'); return; }
  const prod = State.merged.find(p => p.upc === upc);
  if (!prod) { toast('Product not found.', 'error'); return; }
  const _draftShipment = State.movements.find(m => m.from === from && m.to === to && m.status === 'draft');
  const _shipmentId = _draftShipment ? _draftShipment.shipmentId : `${from}→${to}-${Date.now()}`;
  // Calculate leaves-at-source note for manually added movements
  const _sourceMap = { fp: prod.fp_onhand||0, us: prod.us_avail||0, ca: prod.ca_avail||0, uk: prod.uk_avail||0, eu: prod.eu_avail||0 };
  const _leavesAt = Math.max(0, (_sourceMap[from]||0) - qty);
  const _whShort = { fp:'FP WH', us:'Orchard US', ca:'Orchard CA', uk:'Orchard UK', eu:'Orchard EU' };
  const _leaveNote = 'Leaves ' + _leavesAt + ' at ' + (_whShort[from]||from);
  State.movements.push({ from, to, shipmentId: _shipmentId, artist:prod.artist, title:prod.title, catalog: prod.orchard_catalog || prod.catalog, upc:prod.upc, format:prod.format, label:prod.label, qty, notes: _leaveNote, status:'draft', poNumber:'', confirmedAt:null, processedAt:null, timestamp: new Date().toISOString() });
  document.getElementById('mov-product-search').value = '';
  document.getElementById('mov-product-upc').value = '';
  document.getElementById('mov-selected-product').classList.add('hidden');
  document.getElementById('mov-qty').value = 1;
  document.getElementById('mov-notes').value = '';
  renderMovementsTable();
  saveGistData();
  toast('Movement added to queue.', 'success');
}

function renderMovementsTable() {
  const container = document.getElementById('movements-tbody');
  document.getElementById('mov-queue-count').textContent = `${State.movements.length} item${State.movements.length!==1?'s':''}`;
  if (State.movements.length === 0) {
    container.innerHTML = `<tr><td colspan="8" class="empty-cell">No movements queued yet.</td></tr>`;
    return;
  }
  // Migrate old movements without status
  State.movements.forEach(m => { if (!m.status) m.status = 'draft'; });

  // Group by shipmentId (each confirmed shipment is separate; drafts group by route)
  const ROUTE_ORDER = ['fp→us','us→ca','us→uk','us→eu','uk→eu'];
  const groups = {};
  State.movements.forEach((m, i) => {
    // Migrate old movements without shipmentId
    if (!m.shipmentId) m.shipmentId = `${m.from}→${m.to}-legacy`;
    const key = m.shipmentId;
    if (!groups[key]) groups[key] = { from: m.from, to: m.to, key, routeKey: `${m.from}→${m.to}`, items: [] };
    groups[key].items.push({ ...m, _idx: i });
  });

  // Sort groups: first by route order, then drafts before confirmed
  const sortedGroups = Object.values(groups).sort((a,b) => {
    const routeDiff = (ROUTE_ORDER.indexOf(a.routeKey) - ROUTE_ORDER.indexOf(b.routeKey));
    if (routeDiff !== 0) return routeDiff;
    const aStatus = a.items[0]?.status || 'draft';
    const bStatus = b.items[0]?.status || 'draft';
    const order = { draft:0, confirmed:1, shipped:2, processed:3 };
    return (order[aStatus]||0) - (order[bStatus]||0);
  });

  const STATUS_PILL = {
    draft:     '<span class="pill" style="background:#eee;color:#555;font-size:10px">Draft</span>',
    confirmed: '<span class="pill pill-plan" style="font-size:10px">Confirmed</span>',
    shipped:   '<span class="pill pill-soon" style="font-size:10px">Shipped</span>',
    processed: '<span class="pill pill-ok" style="font-size:10px">Processed</span>',
  };

  // Clear the static header - we render group headers inline
  let html = '';
  for (const group of sortedGroups) {
    const isFPtoUS = group.key === 'fp→us';
    // Group status = worst status of any item (draft < confirmed < shipped/processed)
    const statuses = [...new Set(group.items.map(m => m.status))];
    const groupStatus = statuses.includes('draft') ? 'draft'
      : statuses.includes('confirmed') ? 'confirmed'
      : statuses.includes('shipped') ? 'shipped' : 'processed';
    const poNumber = group.items[0].poNumber || '';
    const pill = STATUS_PILL[groupStatus] || STATUS_PILL.draft;
    const totalQty = group.items.reduce((s,m) => s + (m.qty||0), 0);

    // Group header
    const sid = encodeURIComponent(group.key);
    const confirmBtn = groupStatus === 'draft'
      ? `<button class="btn-primary btn-sm grp-confirm" data-sid="${sid}">Confirm ${isFPtoUS ? '& Add PO#' : 'Shipment'}</button>`
      : groupStatus === 'confirmed' && !isFPtoUS
        ? `<button class="btn-secondary btn-sm grp-process" data-sid="${sid}">Mark Processed</button>`
        : groupStatus === 'shipped'
          ? `<span style="font-size:10px;color:var(--text-muted)">Auto-clears in 7d</span>`
          : groupStatus === 'processed'
            ? `<span style="font-size:10px;color:var(--text-muted)">Clears in 30d</span>`
            : '';

    const exportSid = encodeURIComponent(group.key);
    html += `<tr style="background:var(--surface2);border-top:2px solid var(--border2);">
      <td colspan="6" style="padding:8px 12px;font-weight:600;font-size:12px;">
        ${WH_LABELS[group.from]} <span style="color:var(--text-dim);margin:0 6px">→</span> ${WH_LABELS[group.to]}
        <span style="font-weight:400;color:var(--text-muted);font-size:11px;margin-left:8px">${group.items.length} item${group.items.length!==1?'s':''} · ${totalQty.toLocaleString()} units</span>
        ${poNumber ? `<span style="font-size:10px;color:var(--accent);margin-left:8px;font-weight:600">${esc(poNumber)}</span>` : ''}
      </td>
      <td colspan="2" style="padding:8px 12px;text-align:right;white-space:nowrap;">
        <button class="btn-secondary btn-sm grp-export" data-sid="${exportSid}" style="margin-right:6px;">Export</button>
        <span style="margin-right:8px;">${pill}</span>
        ${confirmBtn}
      </td>
    </tr>`;

    // Line items
    group.items.forEach(m => {
      html += `<tr>
        <td style="padding-left:24px;">${esc(m.artist)}</td>
        <td>${esc(m.title)}</td>
        <td style="color:var(--text-muted);font-size:11px">${esc(m.catalog)}</td>
        <td>${esc(m.format)}</td>
        <td class="num" style="white-space:nowrap">
          <input type="number" min="1" value="${m.qty}" data-idx="${m._idx}"
            style="width:60px;text-align:right;font-family:'DM Mono',monospace;font-size:12px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border2);color:var(--text);"
            onchange="updateMovementQty(${m._idx}, this.value)"
            oninput="updateMovementQty(${m._idx}, this.value)" />
          <button class="mov-recalc" data-idx="${m._idx}" title="Recalculate leaves" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:13px;padding:2px 3px;">↻</button>
        </td>
        <td><input type="text" class="mov-notes" data-idx="${m._idx}" value="${esc(m.notes||'')}"
          style="width:200px;font-size:11px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border2);color:var(--text);"
          onchange="updateMovementNotes(${m._idx}, this.value)" placeholder="Notes…" /></td>
        <td style="font-size:10px;color:var(--text-muted);white-space:nowrap;">${m.confirmedAt ? new Date(m.confirmedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'}) : '—'}</td>
        <td style="width:32px;text-align:center;">${(m.status==='draft'||m.status==='confirmed') ? '<button class="btn-danger btn-sm" onclick="removeMovement('+m._idx+')" style="padding:2px 6px;">×</button>' : ''}</td>
      </tr>`;
    });
  }
  container.innerHTML = html;
}
// ── MOVEMENT STATUS ──────────────────────────────────────────
// Event delegation for movement buttons
document.addEventListener('click', e => {
  if (e.target.classList.contains('dash-inbound-more')) {
    e.preventDefault();
    switchView('manufacturing');
    setTimeout(() => switchMfgTab('queue'), 100);
  }
  if (e.target.classList.contains('doom-kill')) {
    doomsdayKill(e.target.dataset.upc, e.target.dataset.artist, e.target.dataset.title);
  }
  if (e.target.classList.contains('grp-export')) {
    exportGroup(decodeURIComponent(e.target.dataset.sid));
  }
  if (e.target.classList.contains('dash-cat-link')) {
    e.preventDefault();
    jumpToTitle(e.target.dataset.cat);
  }
  if (e.target.classList.contains('dash-po-link')) {
    e.preventDefault();
    switchView('movements');
  }
  if (e.target.classList.contains('mov-recalc')) {
    const idx = parseInt(e.target.dataset.idx);
    const qtyInput = e.target.previousElementSibling;
    if (qtyInput) recalcMovementNote(idx, +qtyInput.value);
  }
});

// Event delegation for group confirm/process buttons
document.addEventListener('click', e => {
  if (e.target.classList.contains('grp-confirm')) {
    confirmGroup(decodeURIComponent(e.target.dataset.sid));
  }
  if (e.target.classList.contains('grp-process')) {
    processGroup(decodeURIComponent(e.target.dataset.sid));
  }
});

window.exportGroup = function(shipmentId) {
  const items = State.movements.filter(m => m.shipmentId === shipmentId);
  if (!items.length) return;
  const from = items[0].from;
  const to = items[0].to;
  const poNum = items[0].poNumber || '';
  const fname = 'fp_movement_' + (WH_LABELS[from]||from).replace(/\s/g,'_') + '_to_' + (WH_LABELS[to]||to).replace(/\s/g,'_') + '_' + dateStr() + '.csv';
  downloadCSV(fname,
    ['From Warehouse','To Warehouse','Artist','Title','Label','Catalog #','UPC','Format','Quantity','PO Number'],
    items.map(m => [WH_LABELS[m.from], WH_LABELS[m.to], m.artist, m.title, m.label, m.catalog, m.upc, m.format, m.qty, poNum])
  );
  toast('Exported ' + items.length + ' items.', 'success');
};

window.confirmGroup = function(shipmentId) {
  const groupItems = State.movements.filter(m => m.shipmentId === shipmentId);
  if (!groupItems.length) return;
  const from = groupItems[0].from;
  const to = groupItems[0].to;
  const isFPtoUS = from === 'fp' && to === 'us';
  let poNumber = '';
  if (isFPtoUS) {
    poNumber = prompt('Enter the Orchard PO# for this shipment (e.g. "PO# 7200026997"):');
    if (!poNumber) return;
    poNumber = poNumber.trim();
  }
  groupItems.forEach(m => {
    m.status = 'confirmed';
    m.confirmedAt = new Date().toISOString();
    if (poNumber) m.poNumber = poNumber;
  });
  saveGistData();
  renderMovementsTable();
  toast(isFPtoUS ? `Group confirmed with ${poNumber}. Watching Packiyo for shipment.` : 'Group confirmed. Click "Mark Processed" when stock arrives.', 'success');
};

window.processGroup = function(shipmentId) {
  State.movements.filter(m => m.shipmentId === shipmentId).forEach(m => {
    m.status = 'processed';
    m.processedAt = new Date().toISOString();
  });
  saveGistData();
  renderMovementsTable();
  toast('Group marked as processed. Will auto-remove in 30 days.', 'success');
};

window.confirmMovement = window.confirmGroup; // backwards compat
window.processMovement = window.processGroup;

// Check if any FP→US movements with PO# have shipped in Packiyo
function checkMovementStatuses() {
  let changed = false;
  const now = new Date();
  State.movements = State.movements.filter(m => {
    // Auto-remove processed Orchard→Orchard after 30 days
    if (m.status === 'processed' && m.processedAt) {
      const days = (now - new Date(m.processedAt)) / (24*3600*1000);
      if (days > 30) { changed = true; return false; }
    }
    // Auto-remove shipped FP→US after 7 days
    if (m.status === 'shipped' && m.shippedAt) {
      const days = (now - new Date(m.shippedAt)) / (24*3600*1000);
      if (days > 7) { changed = true; return false; }
    }
    return true;
  });

  // Check Packiyo orders for PO# matches
  if (State.fp_poOrders) {
    for (const m of State.movements) {
      if (m.status === 'confirmed' && m.poNumber && m.from === 'fp' && m.to === 'us') {
        const match = State.fp_poOrders.find(o =>
          (o.number || '').trim().toLowerCase() === m.poNumber.trim().toLowerCase()
        );
        if (match && (match.status_text === 'Fulfilled' || match.status_text === 'fulfilled')) {
          m.status = 'shipped';
          m.shippedAt = match.fulfilled_at || new Date().toISOString();
          changed = true;
          toast(`PO ${m.poNumber} shipped! Movement will clear in 7 days.`, 'success');
        }
      }
    }
  }
  if (changed) { saveGistData(); renderMovementsTable(); }
}

// Store PO orders for status checking
function storeFPPoOrders(orders) {
  State.fp_poOrders = orders
    .filter(o => (o.attributes?.number || '').startsWith('PO#'))
    .map(o => ({
      number: o.attributes.number,
      status_text: o.attributes.status_text,
      fulfilled_at: o.attributes.fulfilled_at,
    }));
}

// Get confirmed inbound quantities per warehouse from movements
function getConfirmedInbound() {
  const inbound = { fp:0, us:0, ca:0, uk:0, eu:0 };
  for (const m of State.movements) {
    if (m.status === 'confirmed' || m.status === 'shipped') {
      inbound[m.to] = (inbound[m.to] || 0) + (m.qty || 0);
    }
  }
  return inbound;
}

window.removeMovement = function(i) { State.movements.splice(i,1); renderMovementsTable(); saveGistData(); };


window.recalcMovementNote = function(i, newQty) {
  const m = State.movements[i];
  if (!m) return;
  const n = newQty !== undefined ? newQty : m.qty;
  const prod = State.merged.find(p => p.upc === m.upc);
  if (!prod) return;
  // For FP WH use fp_onhand (physical stock) not fp_available (already reduced by allocations)
  const srcMap = { fp:prod.fp_onhand||0, us:prod.us_avail||0, ca:prod.ca_avail||0, uk:prod.uk_avail||0, eu:prod.eu_avail||0 };
  const leaves = Math.max(0, (srcMap[m.from]||0) - n);
  const short = { fp:'FP WH', us:'Orchard US', ca:'Orchard CA', uk:'Orchard UK', eu:'Orchard EU' };
  m.notes = 'Leaves ' + leaves + ' at ' + (short[m.from]||m.from);
  const el = document.querySelector('input.mov-notes[data-idx="'+i+'"]');
  if (el) el.value = m.notes;
  saveGistDebounced();
};

window.updateMovementQty = function(i, val) {
  const n = parseInt(val, 10);
  if (!isNaN(n) && n > 0) {
    State.movements[i].qty = n;
    window.recalcMovementNote(i, n);
  }
};

window.updateMovementNotes = function(i, val) {
  State.movements[i].notes = val;
  saveGistData();
};

// ── EXPORTS ───────────────────────────────────────────────────
function exportMovements() {
  if (State.movements.length === 0) { toast('No movements to export.', 'error'); return; }
  downloadCSV('fp_movement_request_'+dateStr()+'.csv',
    ['From Warehouse','To Warehouse','Artist','Title','Label','Catalog #','UPC','Format','Quantity'],
    State.movements.map(m => [WH_LABELS[m.from],WH_LABELS[m.to],m.artist,m.title,m.label,m.catalog,m.upc,m.format,m.qty])
  );
  toast('Movement request exported.', 'success');
}
function exportInventory() {
  downloadCSV('fp_global_inventory_'+dateStr()+'.csv',
    ['Artist','Title','Label','Catalog #','UPC','Format','Total Stock','FP Avail','FP Inbound','US Avail','US MTD','US 3MS','US 12MS','CA Avail','CA MTD','CA 3MS','CA 12MS','UK Avail','UK Open Ord','UK Last Mo','UK This Yr','UK Last Yr','EU Avail','EU MTD','EU Last Mo','EU This Yr'],
    State.merged.map(p => [p.artist,p.title,p.label,p.catalog,p.upc,p.format,
      (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0),
      p.fp_available,p.fp_inbound,p.us_avail,p.us_mtd,p.us_3ms,p.us_12ms,
      p.ca_avail,p.ca_mtd,p.ca_3ms,p.ca_12ms,p.uk_avail,p.uk_open,p.uk_last_mo,p.uk_this_yr,p.uk_last_yr,
      p.eu_avail,p.eu_mtd,p.eu_last_mo,p.eu_this_yr])
  );
  toast('Inventory exported.', 'success');
}
function exportManufacturing() {
  const today = new Date();
  const items = State.merged.map(p => {
    const totalStock = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
    const totalWithInbound = totalStock + (p.fp_inbound||0);
    const monthly = ((p.us_12ms||0)+(p.ca_12ms||0)+(p.uk_last_yr||0)+(p.eu_this_yr||0)) / 12;
    if (monthly <= 0) return null;
    const monthsLeft = totalWithInbound / monthly;
    if (monthsLeft > CONFIG.MFG_TRIGGER_MONTHS + 3) return null;
    const leadTime = isVinyl(p.format||'') ? CONFIG.LEAD_TIME.lp : CONFIG.LEAD_TIME.cd;
    const poDeadlineDate = new Date(today.getTime() + (monthsLeft - leadTime) * 30 * 24 * 3600 * 1000);
    return { ...p, totalStock, totalWithInbound, monthly, monthsLeft, poDeadlineDate };
  }).filter(Boolean);
  downloadCSV('fp_manufacturing_'+dateStr()+'.csv',
    ['Artist','Title','Catalog #','Format','Total Stock','FP Inbound','Open PO Qty','Total w/ All Inbound','Mo. Velocity','12mo Need','Mfg Shortfall','Months Left','PO Deadline'],
    items.map(p => [p.artist,p.title,p.catalog,p.format,p.totalStock,p.fp_inbound,p.poQty,p.totalWithInbound,p.monthly.toFixed(1),p.need12mo,p.globalShortfall,isFinite(p.monthsLeft)?p.monthsLeft.toFixed(1):'∞',p.poDeadlineDate?formatDate(p.poDeadlineDate):'—'])
  );
  toast('Manufacturing report exported.', 'success');
}
function exportAlerts() {
  const rows = [];
  for (const wh of WAREHOUSES) {
    for (const p of State.merged) {
      const avail = p[wh.avail]||0;
      const monthly = (p[wh.vel]||0) / wh.velDiv;
      if (monthly <= 0) continue;
      const weeksLeft = (avail / monthly) * 4.33;
      if (weeksLeft < CONFIG.REORDER_WEEKS) {
        const suggestQty = Math.max(0, Math.ceil(monthly * 12 - avail));
        const sourceAvail2 = wh.key==='fp' ? Infinity : wh.key==='us' ? (p.fp_available||0) : wh.key==='ca' ? (p.us_avail||0) : wh.key==='uk' ? (p.us_avail||0) : (p.uk_avail||0)+(p.us_avail||0);
        const transferQty2 = Math.min(suggestQty, sourceAvail2);
        const shortfall2   = Math.max(0, suggestQty - sourceAvail2);
        rows.push([wh.label,p.artist,p.title,p.label,p.catalog,p.upc,p.format,avail,monthly.toFixed(1),weeksLeft.toFixed(1),suggestQty,transferQty2,shortfall2]);
      }
    }
  }
  downloadCSV('fp_reorder_alerts_'+dateStr()+'.csv',
    ['Warehouse','Artist','Title','Label','Catalog #','UPC','Format','Available','Mo. Velocity','Weeks Left','12mo Need','Can Transfer','Mfg Shortfall'],
    rows
  );
  toast('Alerts exported.', 'success');
}
function downloadCSV(filename, headers, rows) {
  const csv = [headers,...rows].map(r => r.map(cell => {
    const s = String(cell??'');
    return s.includes(',')||s.includes('"')||s.includes('\n') ? `"${s.replace(/"/g,'""')}"` : s;
  }).join(',')).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv;charset=utf-8;'}));
  a.download = filename; a.click();
}

// ── DASHBOARD ────────────────────────────────────────────────
function buildMovementsSummaryHTML() {
  if (!State.movements.length) return '<p style="color:var(--text-muted);font-size:12px;margin:0">No movements in queue.</p>';
  const groups = {};
  State.movements.forEach(m => {
    const sid = m.shipmentId || (m.from+'-'+m.to+'-legacy');
    if (!groups[sid]) groups[sid] = { from:m.from, to:m.to, items:[], status:m.status||'draft', poNumber:m.poNumber||'', shipmentId:sid };
    groups[sid].items.push(m);
  });
  const STATUS_COLOR = { draft:'var(--text-muted)', confirmed:'#3b7de8', shipped:'var(--green)', processed:'var(--green)' };
  const STATUS_LABEL = { draft:'Draft', confirmed:'Confirmed', shipped:'Shipped', processed:'Processed' };
  const rows = Object.values(groups).map(g => {
    const totalQty = g.items.reduce((s,m) => s+(m.qty||0), 0);
    const color = STATUS_COLOR[g.status] || 'var(--text-muted)';
    const rowBg = g.status === 'shipped' ? 'background:rgba(39,174,96,0.08);' : '';
    // Top catalog by qty
    const topItem = g.items.reduce((a,b) => (b.qty||0) > (a.qty||0) ? b : a, g.items[0]);
    const topCat = topItem?.catalog || '—';
    const extraCount = g.items.length - 1;
    const catCell = `<a href='#' class='dash-cat-link' data-cat='${esc(topCat)}' style='font-size:11px;color:var(--accent);text-decoration:none;border-bottom:1px dotted var(--accent);'>${esc(topCat)}</a>`
      + (extraCount > 0 ? `<span style='color:var(--text-dim);font-size:9px'> +${extraCount}</span>` : '');
    // PO# links to movements page
    const poCell = g.poNumber
      ? `<a href='#' class='dash-po-link' style='font-size:10px;color:var(--accent);font-weight:600;text-decoration:none;'>${esc(g.poNumber)}</a>`
      : '<span style="color:var(--text-muted);font-size:10px">—</span>';
    // Status with date
    const dateRef = g.items[0];
    const dateStr = g.status === 'shipped' && dateRef?.shippedAt
      ? ' (' + new Date(dateRef.shippedAt).toLocaleDateString('en-US',{month:'numeric',day:'numeric'}) + ')'
      : g.status === 'confirmed' && dateRef?.confirmedAt
      ? ' (' + new Date(dateRef.confirmedAt).toLocaleDateString('en-US',{month:'numeric',day:'numeric'}) + ')'
      : g.status === 'processed' && dateRef?.processedAt
      ? ' (' + new Date(dateRef.processedAt).toLocaleDateString('en-US',{month:'numeric',day:'numeric'}) + ')'
      : '';
    return '<tr style="' + rowBg + '">'
      + '<td style="font-size:11px">' + (WH_LABELS[g.from]||g.from) + ' → ' + (WH_LABELS[g.to]||g.to) + '</td>'
      + '<td style="font-family:monospace">' + catCell + '</td>'
      + '<td class="num">' + totalQty.toLocaleString() + '</td>'
      + '<td style="color:' + color + ';font-weight:600;font-size:11px">' + (STATUS_LABEL[g.status]||g.status) + dateStr + '</td>'
      + '<td>' + poCell + '</td>'
      + '</tr>';
  }).join('');
  return '<table class="dash-table"><thead><tr><th>Route</th><th>Catalog #</th><th class="num">Units</th><th>Status</th><th>PO#</th></tr></thead><tbody>' + rows + '</tbody></table>';
}

function countUp(el, target, duration=800) {
  if (!el) return;
  const start = performance.now();
  const step = ts => {
    const progress = Math.min((ts - start) / duration, 1);
    const ease = 1 - Math.pow(1 - progress, 3); // ease-out cubic
    el.textContent = Math.round(ease * target).toLocaleString();
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function buildInboundHTML() {
  // Build SKU→expected_at lookup from open POs
  const skuExpected = {};
  for (const po of (State.packiyoPOList||[])) {
    const exp = po.attributes?.expected_at;
    if (!exp) continue;
    for (const line of (po._lines||[])) {
      if (line.sku && !skuExpected[line.sku]) skuExpected[line.sku] = exp;
    }
  }
  const now = new Date();
  const inbound = State.merged
    .filter(p => (p.fp_inbound||0) > 0)
    .map(p => {
      const exp = skuExpected[p.packiyo_sku] || skuExpected[p.catalog];
      return { p, exp: exp ? new Date(exp) : null };
    })
    .sort((a,b) => {
      if (!a.exp && !b.exp) return 0;
      if (!a.exp) return 1;
      if (!b.exp) return -1;
      return a.exp - b.exp;
    })
    .slice(0, 5);
  if (!inbound.length) return '<div style="font-size:12px;color:var(--text-muted)">No inbound stock.</div>';
  return '<table style="width:100%;font-size:11px;border-collapse:collapse;">'
    + inbound.map(({ p, exp }) => {
      const expStr = exp ? formatDate(exp) : '—';
      const expColor = !exp ? 'var(--text-muted)' : exp < now ? 'var(--red)' : 'var(--green)';
      return '<tr>'
        + '<td style="padding:3px 0;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;">' + esc(p.artist) + ' — ' + esc(p.title) + '</td>'
        + '<td style="padding:3px 0 3px 6px;text-align:right;font-family:monospace;font-weight:600;color:var(--text);white-space:nowrap;">+' + (p.fp_inbound||0).toLocaleString() + '</td>'
        + '<td style="padding:3px 0 3px 6px;text-align:right;white-space:nowrap;">' + catalogLink(p.catalog) + '</td>'
        + '<td style="padding:3px 0 3px 6px;text-align:right;font-size:10px;color:' + expColor + ';white-space:nowrap;">' + expStr + '</td>'
        + '</tr>';
    }).join('')
    + '</table>'
    + '<div style="text-align:right;margin-top:8px;">'
    + '<a href="#" class="dash-inbound-more" style="font-size:10px;color:var(--accent);text-decoration:none;font-weight:600;">See more →</a>'
    + '</div>';
}

function renderDashboard() {
  const el = document.getElementById('dashboard-body');
  if (!el) return;
  // Never wipe dashboard if no data — keep existing content
  if (!State.merged.length) return;

  const totalProducts = State.merged.length;
  const totalStock    = State.merged.reduce((s,p) => s+(p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0), 0);
  const fpStock       = State.merged.reduce((s,p) => s+(p.fp_available||0), 0);

  // Alerts count — same logic as renderAlerts so numbers match
  const WAREHOUSES_D = [
    { key:'fp', avail:'fp_available', vel:'fp_12ms',   velDiv:12 },
    { key:'us', avail:'us_avail',     vel:'us_12ms',   velDiv:12 },
    { key:'ca', avail:'ca_avail',     vel:'ca_12ms',   velDiv:12 },
    { key:'uk', avail:'uk_avail',     vel:'uk_last_yr',velDiv:12 },
    { key:'eu', avail:'eu_avail',     vel:'eu_this_yr',velDiv:12 },
  ];
  let alertCount = 0, criticalCount = 0;
  WAREHOUSES_D.forEach(wh => {
    // Apply confirmed inbound same as renderAlerts
    const confirmedInbound = {};
    for (const m of State.movements) {
      if ((m.status === 'confirmed' || m.status === 'shipped') && m.to === wh.key) {
        confirmedInbound[m.upc] = (confirmedInbound[m.upc] || 0) + (m.qty || 0);
      }
    }
    State.merged.forEach(p => {
      const avail = (p[wh.avail]||0) + (confirmedInbound[p.upc]||0);
      const monthly = (p[wh.vel]||0)/wh.velDiv;
      if (monthly <= 0 || avail < 0) return;
      const weeks = (avail/monthly)*4.33;
      if (weeks >= CONFIG.REORDER_WEEKS) return;
      // Skip cleared alerts
      const clearKey = p.upc + '|' + wh.key;
      const cleared = State.clearedAlerts[clearKey];
      if (cleared && avail <= cleared.availAtClear) return;
      alertCount++;
      if (weeks < 4) criticalCount++;
    });
  });

  // Mfg items
  const today = new Date();
  let mfgUrgent = 0, mfgSoon = 0, mfgWithPO = 0;
  State.merged.forEach(p => {
    if (State.hiddenMfgItems.has(p.upc)) return; // respect hidden items
    const total = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
    const poQty = (State.packiyoPOs[p.packiyo_sku]||State.packiyoPOs[p.catalog])?.qty||0;
    const monthly = ((p.us_12ms||0)+(p.ca_12ms||0)+(p.uk_last_yr||0)+(p.eu_this_yr||0))/12;
    if (monthly <= 0 && !poQty) return;
    const totalWithAll = total+(p.fp_inbound||0)+poQty;
    const monthsLeft = monthly > 0 ? totalWithAll/monthly : Infinity;
    if (!isFinite(monthsLeft) && !poQty) return;
    if (monthsLeft > 12) return; // match predictions 12-month cap
    const isLPItem = isVinyl(p.format||'');
    const leadTime = isLPItem ? CONFIG.LEAD_TIME.lp : CONFIG.LEAD_TIME.cd;
    if (!isFinite(monthsLeft) || monthsLeft > CONFIG.MFG_TRIGGER_MONTHS+3) { if (poQty) mfgWithPO++; return; }
    const days = isFinite(monthsLeft) ? Math.round(((today.getTime()+(monthsLeft-leadTime)*30*24*3600*1000)-today.getTime())/(24*3600*1000)) : Infinity;
    if (poQty) mfgWithPO++;
    if (days < 30) mfgUrgent++;
    else if (days < 90) mfgSoon++;
  });

  // Upload history
  const history = JSON.parse(localStorage.getItem('fp_orchard_uploads') || '[]');
  const ts = localStorage.getItem('fp_orchard_ts');

  el.innerHTML = `
    <div class="dash-grid">
      <div class="dash-card" onclick="switchView('inventory')" style="cursor:pointer">
        <div class="dash-label">Total Products</div>
        <div class="dash-num">${totalProducts.toLocaleString()}</div>
        <div class="dash-sub">across all warehouses</div>
      </div>
      <div class="dash-card" onclick="switchView('inventory')" style="cursor:pointer">
        <div class="dash-label">Global Stock</div>
        <div class="dash-num">${totalStock.toLocaleString()}</div>
        <div class="dash-sub">FP WH: ${fpStock.toLocaleString()} units</div>
      </div>
      <div class="dash-card ${criticalCount > 0 ? 'dash-card-red' : alertCount > 0 ? 'dash-card-yellow' : 'dash-card-green'}" onclick="switchView('alerts')" style="cursor:pointer">
        <div class="dash-label">Reorder Alerts</div>
        <div class="dash-num">${alertCount}</div>
        <div class="dash-sub">${criticalCount > 0 ? criticalCount+' critical' : 'across all warehouses'}</div>
      </div>
      <div class="dash-card ${mfgUrgent > 0 ? 'dash-card-red' : mfgSoon > 0 ? 'dash-card-yellow' : ''}" onclick="switchView('manufacturing')" style="cursor:pointer">
        <div class="dash-label">Manufacturing Flags</div>
        <div class="dash-num">${mfgUrgent + mfgSoon}</div>
        <div class="dash-sub">${mfgUrgent > 0 ? mfgUrgent+' urgent · ' : ''}${mfgWithPO} with open PO</div>
      </div>
      <div class="dash-card dash-card-green">
        <div class="dash-label">Resolved (30d)</div>
        <div class="dash-num" id="resolved-count">0</div>
        <div class="dash-sub">movements actioned</div>
      </div>
      <div class="dash-card" style="grid-column:span 2;">
        <div class="dash-label" style="margin-bottom:8px;">Inbound to Fat Possum Warehouse</div>
        ${buildInboundHTML()}
      </div>
      <div class="dash-card" id="doomsday-card" style="padding:12px 14px;min-width:0;">
        <div style="font-size:9px;font-weight:700;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;">STOCKOUT CLOCK</div>
        <div id="doomsday-display"></div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 2fr;gap:16px;margin-top:0">
      <div class="dash-section" style="margin:0">
        <h3>Warehouse Snapshot</h3>
        <table class="dash-table">
          <thead><tr><th>Warehouse</th><th class="num">Available</th><th class="num">Alerts</th></tr></thead>
          <tbody>${[
            { label:'Fat Possum WH',  avail:State.merged.reduce((s,p)=>s+(p.fp_available||0),0), alerts:State.merged.filter(p=>{const m=(p.fp_12ms||0)/12;if(!m||((p.fp_available||0)/m)*4.33>=CONFIG.REORDER_WEEKS)return false;const c=State.clearedAlerts[p.upc+'|fp'];return!(c&&(p.fp_available||0)<=c.availAtClear);}).length },
            { label:'Orchard US',     avail:State.merged.reduce((s,p)=>s+(p.us_avail||0),0),     alerts:State.merged.filter(p=>{const m=(p.us_12ms||0)/12;if(!m||((p.us_avail||0)/m)*4.33>=CONFIG.REORDER_WEEKS)return false;const c=State.clearedAlerts[p.upc+'|us'];return!(c&&(p.us_avail||0)<=c.availAtClear);}).length },
            { label:'Orchard Canada', avail:State.merged.reduce((s,p)=>s+(p.ca_avail||0),0),     alerts:State.merged.filter(p=>{const m=(p.ca_12ms||0)/12;if(!m||((p.ca_avail||0)/m)*4.33>=CONFIG.REORDER_WEEKS)return false;const c=State.clearedAlerts[p.upc+'|ca'];return!(c&&(p.ca_avail||0)<=c.availAtClear);}).length },
            { label:'Orchard UK',     avail:State.merged.reduce((s,p)=>s+(p.uk_avail||0),0),     alerts:State.merged.filter(p=>{const m=(p.uk_last_yr||0)/12;if(!m||((p.uk_avail||0)/m)*4.33>=CONFIG.REORDER_WEEKS)return false;const c=State.clearedAlerts[p.upc+'|uk'];return!(c&&(p.uk_avail||0)<=c.availAtClear);}).length },
            { label:'Orchard EU',     avail:State.merged.reduce((s,p)=>s+(p.eu_avail||0),0),     alerts:State.merged.filter(p=>{const m=(p.eu_this_yr||0)/12;if(!m||((p.eu_avail||0)/m)*4.33>=CONFIG.REORDER_WEEKS)return false;const c=State.clearedAlerts[p.upc+'|eu'];return!(c&&(p.eu_avail||0)<=c.availAtClear);}).length },
          ].map(w=>'<tr><td>'+w.label+'</td><td class="num">'+w.avail.toLocaleString()+'</td><td class="num">'+(w.alerts>0?'<span style="color:var(--red);font-weight:600">'+w.alerts+'</span>':'<span style="color:var(--green)">✓</span>')+'</td></tr>').join('')}</tbody>
        </table>
      </div>
      <div class="dash-section" style="margin:0">
        <h3>Active Movements</h3>
        ${buildMovementsSummaryHTML()}
      </div>
    </div>

    <div class="dash-section" style="margin-top:0">
      <h3>Column Layout</h3>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <button class="btn-primary btn-sm" onclick="saveColumnLayout()">Save Current Layout</button>
        <button class="btn-secondary btn-sm" onclick="resetColumnLayout()">Reset to Default</button>
        <span style="font-size:11px;color:var(--text-muted)">Artist · Title · Catalog # always frozen · ${Object.keys(State.colWidths).length} columns resized</span>
      </div>
    </div>
  `;
  const _resolved = State.movements.filter(m => m.status==='confirmed'||m.status==='shipped'||m.status==='processed').length;
  setTimeout(() => countUp(document.getElementById('resolved-count'), _resolved), 150);
  setTimeout(() => renderDoomsdayClock(), 80);
}

// ── RECORD OF THE DAY ───────────────────────────────────────

// ── DOOMSDAY CLOCK ──────────────────────────────────────────
let _doomsdayPool = null;
let _doomsdayIdx = 0;

function buildDoomsdayPool() {
  const WHS = [
    { key:'fp', avail:'fp_available', vel:'fp_12ms',    label:'FP WH' },
    { key:'us', avail:'us_avail',     vel:'us_12ms',    label:'Orchard US' },
    { key:'uk', avail:'uk_avail',     vel:'uk_last_yr', label:'Orchard UK' },
  ];
  // Build exclusion sets — titles with open POs or confirmed/shipped movements are addressed
  const addressedUpcs = new Set();
  for (const m of State.movements) {
    if (m.status === 'confirmed' || m.status === 'shipped') addressedUpcs.add(m.upc);
  }
  for (const [sku, po] of Object.entries(State.packiyoPOs)) {
    if (po.qty > 0) {
      // Find the product UPC for this SKU
      const prod = State.merged.find(p => p.packiyo_sku === sku || p.catalog === sku);
      if (prod) addressedUpcs.add(prod.upc);
    }
  }

  const seen = new Set();
  const items = [];
  for (const p of State.merged) {
    if (addressedUpcs.has(p.upc)) continue;
    let worstWeeks = Infinity, worstLabel = '';
    for (const wh of WHS) {
      const monthly = (p[wh.vel]||0)/12;
      if (monthly <= 0) continue;
      const weeks = ((p[wh.avail]||0)/monthly)*4.33;
      if (weeks < worstWeeks) { worstWeeks = weeks; worstLabel = wh.label; }
    }
    if (worstWeeks < CONFIG.REORDER_WEEKS && !seen.has(p.upc)) {
      seen.add(p.upc);
      items.push({ p, weeks: worstWeeks, whLabel: worstLabel });
    }
  }
  // Shuffle
  for (let i = items.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1));
    [items[i],items[j]] = [items[j],items[i]];
  }
  return items;
}

function renderDoomsdayClock() {
  const el = document.getElementById('doomsday-display');
  if (!el || !State.merged.length) return;
  if (!_doomsdayPool) {
    _doomsdayPool = buildDoomsdayPool();
    _doomsdayIdx = 0;
  } else if (_doomsdayIdx >= _doomsdayPool.length) {
    _doomsdayPool = buildDoomsdayPool();
    _doomsdayIdx = 0;
  }
  if (!_doomsdayPool.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--green)">All titles healthy ✓</div>';
    return;
  }
  const { p, weeks, whLabel } = _doomsdayPool[_doomsdayIdx % _doomsdayPool.length];
  const color = weeks < 2 ? '#c0392b' : weeks < 4 ? '#E8650A' : weeks < 8 ? '#c45f00' : 'var(--text-muted)';
  el.innerHTML =
    '<div style="font-family:monospace;font-size:28px;font-weight:700;color:' + color + ';letter-spacing:2px;margin-bottom:4px;">'
    + (weeks < 0.1 ? 'OUT' : weeks.toFixed(1) + '<span style="font-size:14px;font-weight:400"> wks</span>')
    + '</div>'
    + '<div style="font-size:12px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px;">' + esc(p.artist) + '</div>'
    + '<div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:2px;">' + esc(p.title) + '</div>'
    + '<div style="font-size:10px;color:' + color + ';margin-bottom:10px;">' + esc(p.catalog) + ' · ' + whLabel + '</div>'
    + '<div style="display:flex;gap:6px;">'
    + '<button onclick="doomsdayKeepIt()" style="flex:1;background:var(--surface2);border:1px solid var(--border);border-radius:3px;padding:4px 6px;font-size:10px;font-weight:600;cursor:pointer;color:var(--text);">Keep It</button>'
    + '<button onclick="doomsdayMakeMore()" style="flex:1;background:var(--accent);border:none;border-radius:3px;padding:4px 6px;font-size:10px;font-weight:600;cursor:pointer;color:white;">Make More</button>'
    + '<button class="doom-kill" data-upc="' + p.upc + '" data-artist="' + esc(p.artist) + '" data-title="' + esc(p.title) + '" style="flex:1;background:#c0392b;border:none;border-radius:3px;padding:4px 6px;font-size:10px;font-weight:600;cursor:pointer;color:white;">Kill</button>'
    + '</div>';
}

window.doomsdayKeepIt = function() {
  _doomsdayIdx++;
};
window.doomsdayMakeMore = function() {
  switchView('manufacturing');
};
window.doomsdayKill = function(upc, artist, title) {
  suppressTitle(upc, artist, title);
  _doomsdayPool = _doomsdayPool.filter(item => item.p.upc !== upc);
};

// ── MANUFACTURING QUEUE (Packiyo PO-driven) ──────────────────
window.switchMfgTab = function(tab) {
  document.querySelectorAll('.mfg-tab').forEach(t => { t.classList.add('hidden'); t.classList.remove('active'); });
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById(`mfg-tab-${tab}`)?.classList.remove('hidden');
  document.getElementById(`mfg-tab-${tab}`)?.classList.add('active');
  document.querySelector(`.tab-btn[data-tab="${tab}"]`)?.classList.add('active');
  if (tab === 'queue') renderMfgQueue();
};

window.addSelectedToMfgQueue = function() {
  switchMfgTab('queue');
};

function updateMfgQueueBadge() {
  const badge = document.getElementById('mfg-queue-badge');
  if (!badge) return;
  const count = State.packiyoPOList.length;
  badge.textContent = count;
  count > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
  const sum = document.getElementById('mfg-queue-summary');
  if (sum) {
    const totalQty = State.packiyoPOList.reduce((s, po) => {
      const lines = po._lines || [];
      return s + lines.reduce((ls, l) => ls + safeNum(l.qty), 0);
    }, 0);
    sum.textContent = `${count} open PO${count!==1?'s':''} · ${totalQty.toLocaleString()} units pending`;
  }
}

window.updatePOAnnotation = function(poNumber, field, value) {
  if (!State.poAnnotations[poNumber]) State.poAnnotations[poNumber] = {};
  State.poAnnotations[poNumber][field] = value;
  localStorage.setItem('fp_po_annotations', JSON.stringify(State.poAnnotations));
};

function renderMfgQueue() {
  const tbody = document.getElementById('mfg-queue-tbody');
  if (!tbody) return;
  updateMfgQueueBadge();

  if (!State.packiyoPOList.length) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-cell">No open purchase orders in Packiyo. Click Refresh Packiyo to reload.</td></tr>`;
    return;
  }

  const today = new Date();
  // Flatten POs into rows — one row per PO line item
  const rows = [];
  for (const po of State.packiyoPOList) {
    const attrs = po.attributes || {};
    const poNumber = attrs.number || po.id;
    const expectedDate = attrs.expected_at ? new Date(attrs.expected_at) : null;
    const notes_ann = State.poAnnotations[poNumber]?.notes || '';
    const amount_ann = State.poAnnotations[poNumber]?.amount || '';

    // Get line items from included data stored during PO load
    const lines = po._lines || [];
    if (!lines.length) {
      // PO with no line items resolved yet — show PO header only
      rows.push({ poNumber, expectedDate, notes_ann, amount_ann, today,
        sku: '—', artist: '', title: '', catalog: '—', format: '', qty: 0, qtyPending: 0 });
    } else {
      for (const line of lines) {
        rows.push({ poNumber, expectedDate, notes_ann, amount_ann, today,
          sku: line.sku, artist: line.artist, title: line.title,
          catalog: line.catalog, format: line.format,
          qty: line.qty, qtyPending: line.qtyPending });
      }
    }
  }

  tbody.innerHTML = rows.map(r => {
    const status = !r.expectedDate
      ? '<span class="pill" style="background:var(--surface2);color:var(--text-muted)">No date</span>'
      : r.expectedDate < r.today
        ? '<span class="pill pill-critical">Overdue</span>'
        : (r.expectedDate - r.today) < 14*24*3600*1000
          ? '<span class="pill pill-soon">Due soon</span>'
          : '<span class="pill pill-plan">On track</span>';
    const expStr = r.expectedDate ? formatDate(r.expectedDate) : '—';
    return `<tr>
      <td><code style="font-size:11px">${esc(r.poNumber)}</code></td>
      <td>${esc(r.artist)}</td>
      <td>${esc(r.title)}</td>
      <td><code>${esc(r.catalog)}</code></td>
      <td>${esc(r.format)}</td>
      <td class="num" style="font-weight:600">${r.qtyPending > 0 ? r.qtyPending.toLocaleString() : numCell(r.qty)}</td>
      <td>${expStr}</td>
      <td>${status}</td>
      <td><input type="number" value="${r.amount_ann}" step="0.01" placeholder="0.00"
        style="width:90px;text-align:right;font-size:11px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border2);color:var(--text);"
        onchange="updatePOAnnotation('${esc(r.poNumber)}','amount',this.value)" /></td>
      <td><input type="text" value="${esc(r.notes_ann)}" placeholder="Notes…"
        style="width:140px;font-size:11px;padding:3px 6px;background:var(--surface2);border:1px solid var(--border2);color:var(--text);"
        onchange="updatePOAnnotation('${esc(r.poNumber)}','notes',this.value)" /></td>
    </tr>`;
  }).join('');
}

window.exportMfgQueue = function() {
  if (!State.packiyoPOList.length) { toast('No open POs to export.', 'error'); return; }
  const rows = [];
  for (const po of State.packiyoPOList) {
    const attrs = po.attributes || {};
    const poNumber = attrs.number || po.id;
    const expectedDate = attrs.expected_at ? formatDate(new Date(attrs.expected_at)) : '';
    const ann = State.poAnnotations[poNumber] || {};
    const lines = po._lines || [{ sku:'—', artist:'', title:'', catalog:'', format:'', qty:0, qtyPending:0 }];
    for (const line of lines) {
      rows.push([poNumber, line.artist, line.title, line.catalog, line.format,
        line.qty, line.qtyPending, expectedDate, ann.amount||'', ann.notes||'']);
    }
  }
  downloadCSV('fp_open_pos_'+dateStr()+'.csv',
    ['PO Number','Artist','Title','Catalog #','Format','Qty Ordered','Qty Pending','Expected Ship','Quoted Amount','Notes'],
    rows
  );
  toast('Open POs exported.', 'success');
};

// ── UPLOAD HISTORY SIDEBAR ───────────────────────────────────
window.toggleUploadHistory = function() { toggleSidebarSection('history'); };

window.toggleSidebarSection = function(id) {
  const panel = document.getElementById(id + '-panel');
  const arrow = document.getElementById(id + '-arrow');
  if (!panel) return;
  const open = panel.style.display === 'none' || panel.style.display === '';
  panel.style.display = open ? 'flex' : 'none';
  if (id === 'actions') panel.style.flexDirection = 'column';
  if (arrow) arrow.textContent = open ? '▾' : '▸';
  if (id === 'history' && open) renderUploadHistory();
};

function renderUploadHistory() {
  const el = document.getElementById('upload-history-list');
  if (!el) return;
  const history = JSON.parse(localStorage.getItem('fp_orchard_uploads') || '[]');
  const ts = localStorage.getItem('fp_orchard_ts');
  if (!history.length && !ts) { el.innerHTML = 'No uploads yet.'; return; }
  el.innerHTML = history.map(h => `
    <div style="display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px solid var(--border);">
      <span>${new Date(h.date).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</span>
      <span style="font-family:'DM Mono',monospace">${h.count.toLocaleString()}</span>
    </div>`).join('');
}

window.updateFPSales = async function() {
  const btn = document.getElementById('update-sales-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Updating…'; }
  toast('Fetching FP sales history — this may take a minute…', '');
  try {
    await loadFPVelocity();
    toast('FP sales updated and saved to cloud.', 'success');
  } catch(e) {
    toast('FP sales update failed: ' + e.message, 'error');
  }
  if (btn) { btn.disabled = false; btn.textContent = 'Update FP Sales'; }
};

// ── NEEDS ATTENTION BANNER ───────────────────────────────────
function buildNeedsAttentionBanner() {
  const el = document.getElementById('needs-attention-banner');
  if (!el) return;
  if (!State.merged.length) return;

  // Find candidates: velocity >= 10/mo, under 4 weeks at any warehouse, not in movements or mfg queue
  const WAREHOUSES_NA = [
    { key:'fp', avail:'fp_available', vel:'fp_12ms',    label:'Fat Possum WH' },
    { key:'us', avail:'us_avail',     vel:'us_12ms',    label:'Orchard US' },
    { key:'uk', avail:'uk_avail',     vel:'uk_last_yr', label:'Orchard UK' },
  ];

  // Track addressed alerts per upc|wh combo
  const addressedKeys = new Set();
  for (const m of State.movements) {
    if (m.status === 'confirmed' || m.status === 'shipped') {
      addressedKeys.add(m.upc + '|' + m.to);
    }
  }
  // Also exclude titles with open Packiyo POs (these are inbound to FP)
  for (const [sku, po] of Object.entries(State.packiyoPOs)) {
    if ((po.qty||0) > 0) {
      const prod = State.merged.find(p => p.packiyo_sku === sku || p.catalog === sku);
      if (prod) addressedKeys.add(prod.upc + '|fp');
    }
  }

  const candidates = [];
  for (const p of State.merged) {
    for (const wh of WAREHOUSES_NA) {
      const avail = p[wh.avail] || 0;
      const annual = p[wh.vel] || 0;
      const monthly = annual / 12;
      if (monthly < 10) continue;
      const weeks = (avail / monthly) * 4.33;
      if (weeks < 4) {
        const key = p.upc + '|' + wh.key;
        // Skip if addressed by movement or PO
        if (addressedKeys.has(key)) break;
        // Skip if manually cleared
        const cleared = State.clearedAlerts[key];
        if (cleared && avail <= cleared.availAtClear) break;
        candidates.push({ p, wh, avail, monthly, weeks });
        break;
      }
    }
  }

  if (!candidates.length) {
    el.style.display = 'none';
    return;
  }

  // Pick a random candidate each visit
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const { p, wh, avail, monthly, weeks } = pick;
  const status = avail === 0 ? 'OUT OF STOCK' : weeks < 2 ? 'CRITICAL' : 'LOW';
  const need = Math.ceil(monthly * 12 - avail);

  el.style.display = 'flex';
  el.style.alignItems = 'center';
  el.style.position = 'relative';
  el.style.overflow = 'hidden';
  el.innerHTML = `
    <div id="na-possum-wrap" style="position:absolute;bottom:0;left:0;pointer-events:none;transform:translateX(-180px);">
      <svg width="180" height="56" viewBox="0 0 180 56" overflow="visible">
        <g transform="translate(80,38)">
          <ellipse cx="0" cy="2" rx="26" ry="15" fill="rgba(200,200,200,0.85)"/>
          <ellipse cx="2" cy="8" rx="15" ry="8" fill="rgba(235,235,235,0.9)"/>
          <circle cx="25" cy="-5" r="12" fill="rgba(200,200,200,0.9)"/>
          <ellipse cx="28" cy="-3" rx="9" ry="10" fill="rgba(232,232,232,0.95)"/>
          <path d="M32,-6 Q44,-4 52,-2 Q44,0 32,2 Z" fill="#e8c0c0"/>
          <ellipse cx="52" cy="-2" rx="2.5" ry="1.8" fill="#d66"/>
          <circle cx="36" cy="-10" r="3" fill="#111"/>
          <circle cx="37" cy="-11" r="1" fill="white"/>
          <ellipse cx="18" cy="-16" rx="5" ry="6" fill="rgba(200,200,200,0.9)"/>
          <ellipse cx="18" cy="-16" rx="3" ry="4" fill="#e89696"/>
          <path d="M-22,5 Q-42,1 -48,-6 Q-52,-14 -44,-18" fill="none" stroke="#e8a0a0" stroke-width="3.5" stroke-linecap="round"/>
          <line id="l1" x1="14" y1="12" x2="17" y2="22" stroke="#aaa" stroke-width="3" stroke-linecap="round"/>
          <line id="l2" x1="5" y1="12" x2="2" y2="22" stroke="#aaa" stroke-width="3" stroke-linecap="round"/>
          <line id="l3" x1="-8" y1="12" x2="-6" y2="22" stroke="#aaa" stroke-width="3" stroke-linecap="round"/>
          <line id="l4" x1="-17" y1="12" x2="-20" y2="22" stroke="#aaa" stroke-width="3" stroke-linecap="round"/>
        </g>
      </svg>
    </div>
    <div style="flex:1;min-width:0;position:relative;z-index:2;padding:12px 20px;">
      <div style="font-size:10px;font-weight:700;letter-spacing:1px;opacity:0.8;margin-bottom:2px;">NEEDS ATTENTION</div>
      <div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
        ${esc(p.artist)} — ${esc(p.title)}
      </div>
      <div style="font-size:11px;opacity:0.85;margin-top:2px;">
        ${status} at ${wh.label} · ${weeks.toFixed(1)} wks left · ${monthly.toFixed(0)}/mo velocity · ${need.toLocaleString()} units needed
      </div>
    </div>
    <div style="flex:0 0 auto;display:flex;gap:8px;align-items:center;margin-right:20px;position:relative;z-index:3;">
      <button onclick="needsAttentionAction('${p.upc}','${wh.key}')" style="background:white;color:#E8650A;border:none;padding:6px 14px;border-radius:3px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap;">View Alert</button>
      <button onclick="needsAttentionDismiss()" style="background:rgba(255,255,255,0.2);color:white;border:none;padding:6px 10px;border-radius:3px;font-size:11px;cursor:pointer;">Dismiss</button>
    </div>
  `;
  // Animate possum with JS (avoids CSS animation issues)
  function runPossum() {
    const wrap = document.getElementById('na-possum-wrap');
    if (!wrap) return;
    const bannerW = el.offsetWidth + 200;
    let x = -160;
    let legAngle = 0;
    const speed = 4;
    const interval = setInterval(() => {
      x += speed;
      legAngle = (legAngle + 15) % 360;
      const s = Math.sin(legAngle * Math.PI / 180);
      wrap.style.transform = 'translateX(' + x + 'px)';
      const svg = wrap.querySelector('svg');
      if (svg) {
        const l1 = svg.getElementById('l1'); if(l1) { l1.setAttribute('x2', 17 + s*6); l1.setAttribute('y2', 22); }
        const l2 = svg.getElementById('l2'); if(l2) { l2.setAttribute('x2', 2 - s*6); l2.setAttribute('y2', 22); }
        const l3 = svg.getElementById('l3'); if(l3) { l3.setAttribute('x2', -6 + s*6); l3.setAttribute('y2', 22); }
        const l4 = svg.getElementById('l4'); if(l4) { l4.setAttribute('x2', -20 - s*6); l4.setAttribute('y2', 22); }
      }
      if (x > bannerW) {
        clearInterval(interval);
        wrap.style.transform = 'translateX(-160px)';
        setTimeout(runPossum, 60000);
      }
    }, 16);
  }
  setTimeout(runPossum, 500);
}

window.needsAttentionDismiss = function() {
  const el = document.getElementById('needs-attention-banner');
  if (el) el.style.display = 'none';
};

window.needsAttentionAction = function(upc, whKey) {
  switchView('alerts');
  let attempts = 0;
  const trySelect = () => {
    const section = document.getElementById('alert-section-' + whKey);
    const cb = document.querySelector('.alert-check[data-upc="'+upc+'"][data-wh="'+whKey+'"]');
    if (section) section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (cb) {
      cb.checked = true;
      const row = cb.closest('tr');
      if (row) {
        row.style.background = 'rgba(255,255,255,0.15)';
        setTimeout(() => { row.style.background = ''; }, 3000);
      }
    } else if (attempts++ < 5) {
      setTimeout(trySelect, 300);
    }
  };
  setTimeout(trySelect, 150);
};

// ── TITLE SEARCH & REORDER CALCULATOR ───────────────────────
window.openTitleSearch = function() {
  const modal = document.getElementById('title-search-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('title-search-input')?.focus(), 50);
  renderTitleSearchResults('');
};

window.closeTitleSearch = function() {
  const modal = document.getElementById('title-search-modal');
  if (modal) modal.style.display = 'none';
};

document.addEventListener('click', e => {
  const modal = document.getElementById('title-search-modal');
  if (modal && e.target === modal) closeTitleSearch();
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') closeTitleSearch();
});

function renderTitleSearchResults(query) {
  const el = document.getElementById('title-search-results');
  if (!el) return;
  if (!query || query.length < 2) {
    el.innerHTML = '<p style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">Type to search titles…</p>';
    return;
  }
  const q = query.toLowerCase();
  const matches = State.merged.filter(p =>
    `${p.artist} ${p.title} ${p.catalog} ${p.upc}`.toLowerCase().includes(q)
  ).slice(0, 8);
  if (!matches.length) {
    el.innerHTML = '<p style="padding:20px;color:var(--text-muted);font-size:13px;text-align:center">No results found.</p>';
    return;
  }
  el.innerHTML = matches.map(p => buildTitleCard(p)).join('');
}

function buildTitleCard(p) {
  const poData = State.packiyoPOs[p.packiyo_sku] || State.packiyoPOs[p.catalog];
  const poQty = poData?.qty || 0;
  const confirmedMov = State.movements.filter(m => m.upc === p.upc && (m.status === 'confirmed' || m.status === 'shipped'));
  const warehouses = [
    { label:'Fat Possum WH', avail: p.fp_available||0, vel12: p.fp_12ms||0 },
    { label:'Orchard US',    avail: p.us_avail||0,     vel12: p.us_12ms||0 },
    { label:'Orchard CA',    avail: p.ca_avail||0,     vel12: p.ca_12ms||0 },
    { label:'Orchard UK',    avail: p.uk_avail||0,     vel12: p.uk_last_yr||0 },
    { label:'Orchard EU',    avail: p.eu_avail||0,     vel12: p.eu_this_yr||0 },
  ];
  const whRows = warehouses.map(wh => {
    const monthly = wh.vel12 / 12;
    const weeks = monthly > 0 ? ((wh.avail / monthly) * 4.33).toFixed(1) : '—';
    const weeksNum = parseFloat(weeks);
    const color = !monthly ? 'var(--text-dim)' : weeksNum < 4 ? 'var(--red)' : weeksNum < 8 ? '#c45f00' : 'var(--green)';
    return `<tr>
      <td style="padding:4px 8px;font-size:11px;color:var(--text-muted)">${wh.label}</td>
      <td style="padding:4px 8px;font-size:11px;font-family:'DM Mono',monospace;text-align:right">${wh.avail.toLocaleString()}</td>
      <td style="padding:4px 8px;font-size:11px;font-family:'DM Mono',monospace;text-align:right;color:var(--text-muted)">${monthly > 0 ? monthly.toFixed(1) : '—'}</td>
      <td style="padding:4px 8px;font-size:11px;font-family:'DM Mono',monospace;text-align:right;color:${color};font-weight:${weeksNum < 8 ? '600' : '400'}">${weeks}</td>
    </tr>`;
  }).join('');
  const globalAnnual = (p.us_12ms||0)+(p.ca_12ms||0)+(p.uk_last_yr||0)+(p.eu_this_yr||0)+(p.fp_12ms||0);
  const globalMonthly = globalAnnual / 12;
  const totalStock = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0)+(p.fp_inbound||0)+poQty;
  const isLP = isVinyl(p.format||'');
  const leadTime = isLP ? CONFIG.LEAD_TIME.lp : CONFIG.LEAD_TIME.cd;
  const monthsLeft = globalMonthly > 0 ? totalStock / globalMonthly : null;
  let reorderHTML = '';
  if (globalMonthly > 0) {
    const suggested = Math.max(0, Math.ceil(globalMonthly * 12 - totalStock));
    const poDeadlineDays = monthsLeft !== null ? Math.round((monthsLeft - leadTime) * 30) : null;
    const deadlineStr = poDeadlineDays !== null
      ? poDeadlineDays < 0 ? '<span style="color:var(--red);font-weight:600">PAST DUE</span>'
      : poDeadlineDays < 30 ? `<span style="color:var(--red);font-weight:600">in ${poDeadlineDays}d</span>`
      : `in ${poDeadlineDays}d` : '—';
    reorderHTML = `
      <div style="margin:12px 16px;padding:12px;background:var(--surface2);border-radius:4px;border-left:3px solid var(--accent);">
        <div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:8px;">Reorder Calculator</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
          <div><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px;">GLOBAL VELOCITY</div><div style="font-size:16px;font-weight:600;font-family:'DM Mono',monospace;">${globalMonthly.toFixed(1)}<span style="font-size:11px;font-weight:400">/mo</span></div></div>
          <div><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px;">MONTHS OF STOCK</div><div style="font-size:16px;font-weight:600;font-family:'DM Mono',monospace;">${monthsLeft !== null ? monthsLeft.toFixed(1) : '∞'}</div></div>
          <div><div style="font-size:9px;color:var(--text-muted);margin-bottom:2px;">PO DEADLINE</div><div style="font-size:14px;font-weight:600;">${deadlineStr}</div></div>
        </div>
        <div style="margin-top:10px;padding-top:10px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
          <div><span style="font-size:11px;color:var(--text-muted)">Suggested reorder qty </span><span style="font-size:15px;font-weight:700;font-family:'DM Mono',monospace;color:var(--accent)">${suggested.toLocaleString()}</span><span style="font-size:10px;color:var(--text-muted);margin-left:4px;">units</span></div>
          <span style="font-size:10px;color:var(--text-muted)">${isLP ? 'LP · 4mo lead' : 'CD · 1.5mo lead'}</span>
        </div>
        ${poQty > 0 ? `<div style="margin-top:6px;font-size:11px;color:var(--green);font-weight:600;">📦 ${poQty.toLocaleString()} units on order (PO)</div>` : ''}
        ${confirmedMov.length > 0 ? `<div style="margin-top:4px;font-size:11px;color:#3b7de8;font-weight:600;">✓ ${confirmedMov.length} transfer confirmed</div>` : ''}
      </div>`;
  }
  return `<div style="border-bottom:1px solid var(--border);padding:16px;">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
      <div>
        <div style="font-size:14px;font-weight:600;color:var(--text)">${esc(p.artist)} — ${esc(p.title)}</div>
        <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${esc(p.catalog)} · ${esc(p.format)} · ${esc(p.label)}</div>
      </div>
      <div style="font-size:10px;color:var(--text-muted);font-family:'DM Mono',monospace;">${esc(p.upc)}</div>
    </div>
    <table style="width:100%;border-collapse:collapse;">
      <thead><tr>
        <th style="padding:4px 8px;font-size:9px;text-align:left;color:var(--text-dim);font-weight:600;text-transform:uppercase">Warehouse</th>
        <th style="padding:4px 8px;font-size:9px;text-align:right;color:var(--text-dim);font-weight:600;text-transform:uppercase">Available</th>
        <th style="padding:4px 8px;font-size:9px;text-align:right;color:var(--text-dim);font-weight:600;text-transform:uppercase">Mo. Vel</th>
        <th style="padding:4px 8px;font-size:9px;text-align:right;color:var(--text-dim);font-weight:600;text-transform:uppercase">Wks Left</th>
      </tr></thead>
      <tbody>${whRows}</tbody>
    </table>
    ${reorderHTML}
  </div>`;
}

document.addEventListener('DOMContentLoaded', () => {
  const inp = document.getElementById('title-search-input');
  if (inp) inp.addEventListener('input', debounce(() => renderTitleSearchResults(inp.value), 200));
});

// ── NOTIFICATIONS ────────────────────────────────────────────
function updateNotifications() {
  if (!State.merged.length) return;
  const now = Date.now();
  const sevenDays = 7 * 24 * 3600 * 1000;
  // Load from localStorage so seen state persists across refreshes
  if (!State.seenAlerts || !Object.keys(State.seenAlerts).length) {
    try { State.seenAlerts = JSON.parse(localStorage.getItem('fp_seen_alerts') || '{}'); } catch(e) {}
  }
  if (!State.seenMfg || !Object.keys(State.seenMfg).length) {
    try { State.seenMfg = JSON.parse(localStorage.getItem('fp_seen_mfg') || '{}'); } catch(e) {}
  }
  if (!State._notificationsInitialized) {
    try { State._notificationsInitialized = !!localStorage.getItem('fp_notif_init'); } catch(e) {}
  }
  const seenAlerts = State.seenAlerts;
  const seenMfg = State.seenMfg;
  const WAREHOUSES_N = [
    { key:'fp', avail:'fp_available', vel:'fp_12ms' },
    { key:'us', avail:'us_avail',     vel:'us_12ms' },
    { key:'ca', avail:'ca_avail',     vel:'ca_12ms' },
    { key:'uk', avail:'uk_avail',     vel:'uk_last_yr' },
    { key:'eu', avail:'eu_avail',     vel:'eu_this_yr' },
  ];
  const newAlerts = [];
  for (const p of State.merged) {
    for (const wh of WAREHOUSES_N) {
      const avail = p[wh.avail] || 0;
      const monthly = (p[wh.vel]||0) / 12;
      if (monthly <= 0) continue;
      const weeks = (avail / monthly) * 4.33;
      if (weeks >= CONFIG.REORDER_WEEKS) continue;
      const key = p.upc + '|' + wh.key;
      const actioned = State.movements.some(m => m.upc === p.upc && m.to === wh.key && (m.status === 'confirmed' || m.status === 'shipped'));
      if (actioned) { delete seenAlerts[key]; continue; }
      if (!seenAlerts[key]) seenAlerts[key] = now;
      const age = now - seenAlerts[key];
      if (age < sevenDays) newAlerts.push({ p, wh, weeks, monthly, age });
    }
  }
  const newMfg = [];
  for (const p of State.merged) {
    const poQty = (State.packiyoPOs[p.packiyo_sku] || State.packiyoPOs[p.catalog])?.qty || 0;
    if (poQty > 0) { delete seenMfg[p.upc]; continue; }
    const monthly = ((p.us_12ms||0)+(p.ca_12ms||0)+(p.uk_last_yr||0)+(p.eu_this_yr||0))/12;
    if (monthly <= 0) continue;
    const total = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0)+(p.fp_inbound||0);
    const months = total / monthly;
    if (months > 12) continue;
    if (!seenMfg[p.upc]) seenMfg[p.upc] = now;
    const age = now - seenMfg[p.upc];
    if (age < sevenDays) newMfg.push({ p, months, monthly, age });
  }
  const isFirstRun = !State._notificationsInitialized;
  if (isFirstRun) {
    State._notificationsInitialized = true;
    State._newAlerts = [];
    State._newMfg = [];
    State.seenAlerts = seenAlerts;
    State.seenMfg = seenMfg;
    try {
      localStorage.setItem('fp_seen_alerts', JSON.stringify(seenAlerts));
      localStorage.setItem('fp_seen_mfg', JSON.stringify(seenMfg));
      localStorage.setItem('fp_notif_init', '1');
    } catch(e) {}
    document.getElementById('notif-alerts-badge')?.classList.add('hidden');
    document.getElementById('notif-mfg-badge')?.classList.add('hidden');
    document.getElementById('vinyl-icon')?.classList.remove('vinyl-spinning');
    return;
  }
  State.seenAlerts = seenAlerts;
  State.seenMfg = seenMfg;
  try {
    localStorage.setItem('fp_seen_alerts', JSON.stringify(seenAlerts));
    localStorage.setItem('fp_seen_mfg', JSON.stringify(seenMfg));
    localStorage.setItem('fp_notif_init', '1');
  } catch(e) {}
  const alertBadge = document.getElementById('notif-alerts-badge');
  const mfgBadge = document.getElementById('notif-mfg-badge');
  const bell = document.getElementById('bell-icon');
  const vinyl = document.getElementById('vinyl-icon');
  if (alertBadge) {
    alertBadge.textContent = newAlerts.length;
    if (newAlerts.length > 0) { alertBadge.classList.remove('hidden'); bell?.classList.add('bell-ringing'); setTimeout(() => bell?.classList.remove('bell-ringing'), 1000); }
    else alertBadge.classList.add('hidden');
  }
  if (mfgBadge) {
    mfgBadge.textContent = newMfg.length;
    if (newMfg.length > 0) { mfgBadge.classList.remove('hidden'); vinyl?.classList.add('vinyl-spinning'); }
    else { mfgBadge.classList.add('hidden'); vinyl?.classList.remove('vinyl-spinning'); }
  }
  State._newAlerts = newAlerts;
  State._newMfg = newMfg;
}

window.showAlertNotifications = function() {
  const popup = document.getElementById('notif-popup');
  const title = document.getElementById('notif-popup-title');
  const body = document.getElementById('notif-popup-body');
  if (!popup) return;
  const WH = { fp:'Fat Possum WH', us:'Orchard US', ca:'Orchard Canada', uk:'Orchard UK', eu:'Orchard EU' };
  title.textContent = `New Reorder Alerts (${(State._newAlerts||[]).length})`;
  const alerts = State._newAlerts || [];
  if (!alerts.length) { body.innerHTML = '<p style="padding:16px;color:var(--text-muted);font-size:12px">No new alerts.</p>'; }
  else {
    body.innerHTML = alerts.map(({p, wh, weeks, monthly}) => `
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div>
          <div style="font-size:12px;font-weight:600;color:var(--text)">${esc(p.artist)} — ${esc(p.title)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${WH[wh.key]} · ${weeks.toFixed(1)} wks left · ${monthly.toFixed(0)}/mo</div>
        </div>
        <button onclick="document.getElementById('notif-popup').classList.add('hidden');needsAttentionAction('${p.upc}','${wh.key}')" style="background:var(--accent);color:#fff;border:none;padding:4px 10px;border-radius:3px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">Action</button>
      </div>`).join('');
  }
  popup.classList.toggle('hidden');
};

window.showMfgNotifications = function() {
  const popup = document.getElementById('notif-popup');
  const title = document.getElementById('notif-popup-title');
  const body = document.getElementById('notif-popup-body');
  if (!popup) return;
  title.textContent = `New Manufacturing Alerts (${(State._newMfg||[]).length})`;
  const items = State._newMfg || [];
  if (!items.length) { body.innerHTML = '<p style="padding:16px;color:var(--text-muted);font-size:12px">No new manufacturing alerts.</p>'; }
  else {
    body.innerHTML = items.map(({p, months, monthly}) => `
      <div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:12px;">
        <div>
          <div style="font-size:12px;font-weight:600;color:var(--text)">${esc(p.artist)} — ${esc(p.title)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:2px;">${months.toFixed(1)} months left · ${monthly.toFixed(0)}/mo · ${esc(p.format)}</div>
        </div>
        <button onclick="document.getElementById('notif-popup').classList.add('hidden');switchView('manufacturing')" style="background:var(--accent);color:#fff;border:none;padding:4px 10px;border-radius:3px;font-size:11px;font-weight:600;cursor:pointer;white-space:nowrap;">View</button>
      </div>`).join('');
  }
  popup.classList.toggle('hidden');
};

document.addEventListener('click', e => {
  const popup = document.getElementById('notif-popup');
  if (popup && !popup.classList.contains('hidden') &&
      !popup.contains(e.target) &&
      !document.getElementById('notif-alerts-btn')?.contains(e.target) &&
      !document.getElementById('notif-mfg-btn')?.contains(e.target)) {
    popup.classList.add('hidden');
  }
});

// ── JUMP TO TITLE ────────────────────────────────────────────
// ── STOCK ALLOCATION PLANNER ─────────────────────────────────
let _allocUpc = null;
let _allocInputs = {};

window.openAllocModal = function(upc) {
  const p = State.merged.find(x => x.upc === upc);
  if (!p) return;
  _allocUpc = upc;
  _allocInputs = {};

  const modal = document.getElementById('alloc-modal');
  document.getElementById('alloc-title').textContent = (p.artist||'') + ' — ' + (p.title||'');
  document.getElementById('alloc-subtitle').textContent = (p.catalog||'') + ' · ' + (p.format||'');

  // Warehouse definitions with stock and velocity
  const WHS = [
    { key:'fp', label:'Fat Possum WH',  avail: p.fp_available||0, vel12: p.fp_12ms||0,    source: null },
    { key:'us', label:'Orchard US',     avail: p.us_avail||0,     vel12: p.us_12ms||0,    source: 'fp' },
    { key:'uk', label:'Orchard UK',     avail: p.uk_avail||0,     vel12: p.uk_last_yr||0, source: 'us' },
    { key:'eu', label:'Orchard EU',     avail: p.eu_avail||0,     vel12: p.eu_this_yr||0, source: 'us' },
  ];

  // Calculate needs for each warehouse
  const needs = {};
  WHS.forEach(wh => {
    const monthly = wh.vel12 / 12;
    const weeksLeft = monthly > 0 ? (wh.avail / monthly) * 4.33 : Infinity;
    const need12mo = monthly > 0 ? Math.max(0, Math.ceil(monthly * 12 - wh.avail)) : 0;
    needs[wh.key] = { monthly, weeksLeft, need12mo, ...wh };
  });

  // Running balances — start with current stock
  const balances = { fp: p.fp_available||0, us: p.us_avail||0, uk: p.uk_avail||0, eu: p.eu_avail||0 };

  const body = document.getElementById('alloc-body');

  // Sort by urgency (lowest weeks first, skip FP — it sources from manufacturing)
  const alertWhs = WHS.filter(wh => wh.key !== 'fp' && needs[wh.key].need12mo > 0)
    .sort((a,b) => needs[a.key].weeksLeft - needs[b.key].weeksLeft);

  let html = '';

  // FP stock summary header
  const fpMonthly = (p.fp_12ms||0)/12;
  const fpWeeks = fpMonthly > 0 ? ((p.fp_available||0)/fpMonthly*4.33).toFixed(1) : '∞';
  const fpColor = parseFloat(fpWeeks) < 4 ? 'var(--red)' : parseFloat(fpWeeks) < 8 ? 'var(--orange)' : 'var(--green)';
  html += '<div style="background:var(--surface2);border-radius:6px;padding:12px 14px;margin-bottom:16px;display:flex;gap:24px;align-items:center;">'
    + '<div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:3px;">FP WH Stock</div>'
    + '<div style="font-size:22px;font-weight:700;font-family:monospace;color:var(--text)">' + (p.fp_available||0).toLocaleString() + '</div></div>'
    + '<div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:3px;">FP Weeks Left</div>'
    + '<div style="font-size:22px;font-weight:700;font-family:monospace;color:' + fpColor + '">' + fpWeeks + '</div></div>'
    + '<div><div style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:3px;">FP Inbound</div>'
    + '<div style="font-size:22px;font-weight:700;font-family:monospace;color:var(--text-muted)">' + (p.fp_inbound||0).toLocaleString() + '</div></div>'
    + '<div style="flex:1;text-align:right;font-size:10px;color:var(--text-muted)">Orchard US: ' + (p.us_avail||0).toLocaleString() + ' · UK: ' + (p.uk_avail||0).toLocaleString() + ' · EU: ' + (p.eu_avail||0).toLocaleString() + '</div>'
    + '</div>';

  if (!alertWhs.length) {
    html += '<div style="text-align:center;padding:24px;color:var(--text-muted);font-size:12px;">No active alerts for this title across warehouses.</div>';
    body.innerHTML = html;
    modal.style.display = 'flex';
    return;
  }

  html += '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:10px;">Allocate Stock — drag or type quantities</div>';

  // One row per alerting warehouse, sorted by urgency
  alertWhs.forEach(wh => {
    const n = needs[wh.key];
    const sourceKey = wh.source;
    const sourceLabel = WH_LABELS[sourceKey] || sourceKey;
    const sourceAvail = sourceKey ? (balances[sourceKey]||0) : 0;
    const suggested = Math.min(n.need12mo, sourceAvail);
    const weeksColor = n.weeksLeft < 4 ? 'var(--red)' : n.weeksLeft < 8 ? 'var(--orange)' : 'var(--text-muted)';
    const inputId = 'alloc-qty-' + wh.key;

    html += '<div style="border:1px solid var(--border);border-radius:6px;padding:14px;margin-bottom:10px;" id="alloc-row-' + wh.key + '">'
      + '<div style="display:flex;align-items:flex-start;gap:12px;">'
      // Left: warehouse info
      + '<div style="flex:1;">'
      + '<div style="font-size:12px;font-weight:700;color:var(--text);margin-bottom:4px;">' + wh.label + '</div>'
      + '<div style="display:flex;gap:16px;font-size:11px;">'
      + '<span>Current: <b>' + wh.avail.toLocaleString() + '</b></span>'
      + '<span style="color:' + weeksColor + '">Weeks left: <b>' + (isFinite(n.weeksLeft) ? n.weeksLeft.toFixed(1) : '∞') + '</b></span>'
      + '<span>Mo. velocity: <b>' + n.monthly.toFixed(1) + '</b></span>'
      + '<span>12M need: <b style="color:var(--accent)">' + n.need12mo.toLocaleString() + '</b></span>'
      + '</div>'
      + '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Source: ' + sourceLabel + ' (' + sourceAvail.toLocaleString() + ' available)</div>'
      + '</div>'
      // Right: qty input
      + '<div style="flex-shrink:0;text-align:center;">'
      + '<div style="font-size:9px;color:var(--text-muted);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.5px;">Send</div>'
      + '<input type="number" id="' + inputId + '" min="0" max="' + sourceAvail + '" value="' + suggested + '"'
      + ' style="width:80px;text-align:center;font-size:18px;font-weight:700;font-family:monospace;padding:6px;background:var(--surface2);border:2px solid var(--accent);border-radius:4px;color:var(--text);"'
      + ' oninput="updateAllocBalance()"'
      + ' data-wh="' + wh.key + '" data-source="' + (sourceKey||'') + '" />'
      + '<div style="font-size:9px;color:var(--text-muted);margin-top:3px;" id="alloc-leaves-' + wh.key + '">leaves ' + (sourceAvail - suggested).toLocaleString() + ' at source</div>'
      + '</div>'
      + '</div>'
      + '</div>';
  });

  // Running balance summary
  html += '<div id="alloc-balance-summary" style="background:var(--surface2);border-radius:4px;padding:10px 14px;font-size:11px;color:var(--text-muted);margin-top:4px;"></div>';

  body.innerHTML = html;
  modal.style.display = 'flex';
  updateAllocBalance();
};

window.updateAllocBalance = function() {
  const p = State.merged.find(x => x.upc === _allocUpc);
  if (!p) return;
  const balances = { fp: p.fp_available||0, us: p.us_avail||0, uk: p.uk_avail||0, eu: p.eu_avail||0 };

  // Process each input and update running balances
  document.querySelectorAll('[id^="alloc-qty-"]').forEach(input => {
    const whKey = input.dataset.wh;
    const sourceKey = input.dataset.source;
    const qty = parseInt(input.value)||0;
    _allocInputs[whKey] = qty;

    // Deduct from source
    if (sourceKey) balances[sourceKey] = Math.max(0, (balances[sourceKey]||0) - qty);

    // Update leaves note
    const leavesEl = document.getElementById('alloc-leaves-' + whKey);
    if (leavesEl && sourceKey) {
      const sourceAfter = balances[sourceKey] !== undefined ? balances[sourceKey] : 0;
      const color = sourceAfter < 0 ? 'var(--red)' : sourceAfter === 0 ? 'var(--orange)' : 'var(--text-muted)';
      leavesEl.style.color = color;
      leavesEl.textContent = 'leaves ' + Math.max(0, sourceAfter).toLocaleString() + ' at source';
      // Highlight if over-allocating
      input.style.borderColor = qty > (parseInt(input.max)||0) ? 'var(--red)' : 'var(--accent)';
    }
  });

  // Summary bar
  const summary = document.getElementById('alloc-balance-summary');
  if (summary) {
    summary.innerHTML = 'After allocation — '
      + 'FP: <b>' + balances.fp.toLocaleString() + '</b> · '
      + 'US: <b>' + balances.us.toLocaleString() + '</b> · '
      + 'UK: <b>' + balances.uk.toLocaleString() + '</b> · '
      + 'EU: <b>' + balances.eu.toLocaleString() + '</b>';
  }
};

window.commitAllocation = function() {
  const p = State.merged.find(x => x.upc === _allocUpc);
  if (!p) return;

  // Source map for each destination
  const sourceMap = { us: 'fp', uk: 'us', eu: 'us' };
  let added = 0;

  for (const [whKey, qty] of Object.entries(_allocInputs)) {
    if (!qty || qty <= 0) continue;
    const from = sourceMap[whKey];
    if (!from) continue;
    // Find or create draft shipment for this route
    const existing = State.movements.find(m => m.from === from && m.to === whKey && m.status === 'draft');
    const shipmentId = existing ? existing.shipmentId : from + '→' + whKey + '-' + Date.now();
    const srcMap = { fp: p.fp_available||0, us: p.us_avail||0, uk: p.uk_avail||0, eu: p.eu_avail||0 };
    const leaves = Math.max(0, (srcMap[from]||0) - qty);
    const WH_SHORT = { fp:'FP WH', us:'Orchard US', uk:'Orchard UK', eu:'Orchard EU' };
    State.movements.push({
      from, to: whKey, shipmentId,
      artist: p.artist, title: p.title,
      catalog: p.orchard_catalog || p.catalog,
      upc: p.upc, format: p.format, label: p.label,
      qty, notes: 'Leaves ' + leaves + ' at ' + (WH_SHORT[from]||from),
      status: 'draft', poNumber: '',
      confirmedAt: null, processedAt: null,
      timestamp: new Date().toISOString(),
    });
    added++;
  }

  if (added) {
    saveGistData();
    renderMovementsTable();
    toast(added + ' movement' + (added>1?'s':'') + ' added to queue.', 'success');
    closeAllocModal();
    switchView('movements');
  } else {
    toast('No quantities entered.', 'error');
  }
};

window.closeAllocModal = function() {
  document.getElementById('alloc-modal').style.display = 'none';
  _allocUpc = null;
  _allocInputs = {};
};

// Close on backdrop click
document.addEventListener('click', e => {
  if (e.target.id === 'alloc-modal') closeAllocModal();
});

window.jumpToTitle = function(catalog) {
  const searchInput = document.getElementById('search-input');
  if (searchInput) searchInput.value = catalog;
  switchView('inventory');
  renderInventory();
  setTimeout(() => {
    const rows = document.querySelectorAll('#inventory-tbody tr');
    for (const row of rows) {
      if (row.textContent.includes(catalog)) {
        row.style.outline = '2px solid var(--accent)';
        row.scrollIntoView({ behavior:'smooth', block:'center' });
        setTimeout(() => row.style.outline = '', 2000);
        break;
      }
    }
  }, 150);
};

// ── VIEW SWITCHING ────────────────────────────────────────────
function switchView(viewName, pushHistory=true) {
  document.querySelectorAll('.view').forEach(v => { v.classList.add('hidden'); v.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById(`view-${viewName}`)?.classList.remove('hidden');
  document.getElementById(`view-${viewName}`)?.classList.add('active');
  document.querySelector(`[data-view="${viewName}"]`)?.classList.add('active');
  if (pushHistory && history.state?.view !== viewName) {
    history.pushState({ view: viewName }, '', '#' + viewName);
  }
  const banner = document.getElementById('needs-attention-banner');
  if (banner) banner.style.display = viewName === 'dashboard' ? '' : 'none';
  if (viewName === 'dashboard') {
    if (State.merged.length) {
      renderDashboard();
      buildNeedsAttentionBanner();
      updateNotifications();
        } else {
      setTimeout(() => { if (State.merged.length) { renderDashboard(); buildNeedsAttentionBanner(); } }, 500);
    }
    const dv = document.getElementById('view-dashboard');
    if (dv) {
      dv.style.transform = 'translateZ(0)';
      requestAnimationFrame(() => {
        dv.style.transform = '';
        dv.style.opacity = '0.99';
        requestAnimationFrame(() => { dv.style.opacity = ''; });
      });
    }
  }
  document.getElementById('search-input')?.setAttribute('placeholder', 'Search titles… (press / anywhere)');
  if (viewName === 'suppressed') renderSuppressedLog();
}

// ── HELPERS ───────────────────────────────────────────────────
function updateGistStatus(sizeKB) {
  const dot = document.getElementById('gist-dot');
  const txt = document.getElementById('gist-status-text');
  const bar = document.getElementById('gist-bar');
  const LIMIT_KB = 1024;
  const pct = Math.min(100, (sizeKB / LIMIT_KB) * 100);
  const color = pct > 90 ? 'var(--red)' : pct > 70 ? 'var(--orange)' : 'var(--green)';
  const state = pct > 90 ? 'error' : pct > 70 ? 'loading' : 'ok';
  if (dot) dot.className = 'status-dot ' + state;
  if (txt) txt.textContent = sizeKB.toFixed(0) + 'KB / 1MB';
  if (bar) { bar.style.width = pct + '%'; bar.style.background = color; }
}

function setStatus(which, state, label) {
  const dot = document.getElementById(`${which}-dot`);
  const txt = document.getElementById(`${which}-status-text`);
  if (dot) dot.className = 'status-dot ' + state;
  if (txt) txt.textContent = label;
}
function normalizeLabel(label) {
  if (!label) return '';
  const l = label.toLowerCase();
  if (l.includes('fat possum')) return 'Fat Possum';
  if (l.includes('grand jury')) return 'Grand Jury';
  if (l.includes('epitaph')) return 'Epitaph';
  return label;
}

function esc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function catalogLink(catalog) {
  const ec = esc(catalog);
  return `<a href="#" onclick="event.preventDefault();jumpToTitle('${ec}')" style="color:inherit;text-decoration:none;border-bottom:1px dotted var(--text-dim);" title="View in inventory">${ec}</a>`;
}
function safeNum(v) {
  const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, ''));
  if (isNaN(n) || !isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 9999999) return 0;
  return n;
}
function numCell(n) { return (!n||n===0)?`<span class="num-zero">0</span>`:String(n); }
function isVinyl(s) { const l=(s||'').toLowerCase(); return l.includes('vinyl')||l.includes(' lp')||l.includes('12"')||l.includes('10"')||l.includes('7"'); }
function formatDate(d) { return d.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}); }
function dateStr() { return new Date().toISOString().slice(0,10).replace(/-/g,''); }
function debounce(fn,ms) { let t; return (...args)=>{ clearTimeout(t); t=setTimeout(()=>fn(...args),ms); }; }
function toast(msg,type='') {
  const el=document.getElementById('toast');
  el.textContent=msg; el.className='toast'+(type?` toast-${type}`:'');
  el.classList.remove('hidden'); clearTimeout(el._t);
  el._t=setTimeout(()=>el.classList.add('hidden'),3500);
}
