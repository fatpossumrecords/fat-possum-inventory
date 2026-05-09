/* ============================================================
   FAT POSSUM — GLOBAL INVENTORY SYSTEM
   app.js — Main application logic
   ============================================================ */

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  GOOGLE_CLIENT_ID: '955463970238-o8p7ujrhusedtkavkskjhjlh87gr1844.apps.googleusercontent.com',
  ALLOWED_DOMAIN:   'fatpossum.com', // set to null to allow any Google account
  PACKIYO_BASE:     'https://fatpossum.app.packiyo.com/api/v1',
  PACKIYO_TOKEN:    '314|AJSEnucp8nigZM7YEkgEvWfNgH4JdTuraKYBkLp2',
  REORDER_WEEKS:    8,
  MFG_TRIGGER_MONTHS: 5,
  // LP lead time = 4 months, CD = 1.5 months (midpoint)
  LEAD_TIME: { lp: 4, cd: 1.5 },
};

// ── STATE ────────────────────────────────────────────────────
const State = {
  user: null,
  packiyoProducts: [],   // raw from Packiyo
  orchardData: [],        // parsed from CSV, deduplicated
  merged: [],             // final merged product list
  movements: [],          // movement queue
  packiyoLoaded: false,
  orchardLoaded: false,
  sortCol: 'artist',
  sortDir: 'asc',
  mfgSortCol: 'months_left',
  mfgSortDir: 'asc',
};

// ── BOOT ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Show login screen
  document.getElementById('login-screen').classList.remove('hidden');

  // Restore session
  const saved = sessionStorage.getItem('fp_user');
  if (saved) {
    State.user = JSON.parse(saved);
    bootApp();
  }

  // CSV upload
  document.getElementById('upload-csv-btn').addEventListener('click', () => {
    document.getElementById('csv-file-input').click();
  });
  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) loadOrchardCSV(e.target.files[0]);
  });

  document.getElementById('refresh-packiyo-btn').addEventListener('click', loadPackiyo);
  document.getElementById('logout-btn').addEventListener('click', logout);

  // Navigation
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(item.dataset.view);
    });
  });

  // Inventory controls
  document.getElementById('search-input').addEventListener('input', renderInventory);
  document.getElementById('filter-config').addEventListener('change', renderInventory);
  document.getElementById('filter-warehouse').addEventListener('change', renderInventory);
  document.getElementById('export-inventory-btn').addEventListener('click', exportInventory);

  // Table sorting
  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      const table = th.closest('table').id;
      if (table === 'inventory-table') {
        if (State.sortCol === col) State.sortDir = State.sortDir === 'asc' ? 'desc' : 'asc';
        else { State.sortCol = col; State.sortDir = 'asc'; }
        updateSortHeaders('inventory-table', State.sortCol, State.sortDir);
        renderInventory();
      } else if (table === 'mfg-table') {
        if (State.mfgSortCol === col) State.mfgSortDir = State.mfgSortDir === 'asc' ? 'desc' : 'asc';
        else { State.mfgSortCol = col; State.mfgSortDir = 'asc'; }
        updateSortHeaders('mfg-table', State.mfgSortCol, State.mfgSortDir);
        renderManufacturing();
      }
    });
  });

  // Movements
  document.getElementById('add-movement-btn').addEventListener('click', addMovement);
  document.getElementById('export-movements-btn').addEventListener('click', exportMovements);
  document.getElementById('clear-movements-btn').addEventListener('click', () => {
    State.movements = [];
    renderMovementsTable();
    toast('Movement queue cleared.');
  });
  document.getElementById('mov-product-search').addEventListener('input', debounce(updateMovementDropdown, 200));
  document.getElementById('mov-from').addEventListener('change', validateRoute);
  document.getElementById('mov-to').addEventListener('change', validateRoute);

  // Manufacturing filter
  document.getElementById('mfg-filter').addEventListener('change', renderManufacturing);
  document.getElementById('export-mfg-btn').addEventListener('click', exportManufacturing);
  document.getElementById('export-alerts-btn').addEventListener('click', exportAlerts);
});

// ── GOOGLE AUTH ──────────────────────────────────────────────
window.handleGoogleLogin = function(response) {
  const payload = parseJwt(response.credential);
  // allow any google account (adjust ALLOWED_DOMAIN to restrict)
  if (CONFIG.ALLOWED_DOMAIN && !payload.email.endsWith('@' + CONFIG.ALLOWED_DOMAIN)) {
    document.getElementById('login-error').classList.remove('hidden');
    return;
  }
  State.user = { name: payload.name, email: payload.email, picture: payload.picture };
  sessionStorage.setItem('fp_user', JSON.stringify(State.user));
  bootApp();
};

function parseJwt(token) {
  const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(base64));
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
  if (State.user) ur.textContent = State.user.email;
  loadPackiyo();
  // Try to restore orchard data from sessionStorage
  const saved = sessionStorage.getItem('fp_orchard');
  if (saved) {
    try {
      State.orchardData = JSON.parse(saved);
      State.orchardLoaded = true;
      setStatus('orchard', 'ok', `${State.orchardData.length} items`);
      mergeData();
    } catch(e) { /* ignore */ }
  }
}

// ── PACKIYO API ───────────────────────────────────────────────
async function packiyoFetch(endpoint, params = {}) {
  const url = new URL(CONFIG.PACKIYO_BASE + endpoint);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url.toString(), {
    headers: {
      'Authorization': `Bearer ${CONFIG.PACKIYO_TOKEN}`,
      'Accept': '*/*',
    }
  });
  if (!res.ok) throw new Error(`Packiyo ${res.status}: ${res.statusText}`);
  return res.json();
}

async function loadPackiyo() {
  setStatus('packiyo', 'loading', 'Loading…');
  try {
    // Load all products paginated
    let page = 1, allProducts = [];
    while (true) {
      const data = await packiyoFetch('/products', { per_page: 100, page });
      const items = data.data || data.products || data || [];
      if (!Array.isArray(items) || items.length === 0) break;
      allProducts = allProducts.concat(items);
      if (!data.meta || page >= (data.meta.last_page || 1)) break;
      page++;
    }
    State.packiyoProducts = allProducts;
    State.packiyoLoaded = true;
    setStatus('packiyo', 'ok', `${allProducts.length} items`);
    mergeData();
  } catch (err) {
    setStatus('packiyo', 'error', 'Error');
    toast('Packiyo load failed: ' + err.message, 'error');
    console.error('Packiyo error:', err);
    // Still try to render with whatever we have
    mergeData();
  }
}

// ── ORCHARD CSV ───────────────────────────────────────────────
function loadOrchardCSV(file) {
  setStatus('orchard', 'loading', 'Parsing…');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const text = e.target.result;
      const parsed = parseCSV(text);
      State.orchardData = deduplicateOrchard(parsed);
      State.orchardLoaded = true;
      sessionStorage.setItem('fp_orchard', JSON.stringify(State.orchardData));
      setStatus('orchard', 'ok', `${State.orchardData.length} items`);
      mergeData();
      toast(`Orchard CSV loaded: ${State.orchardData.length} products`, 'success');
    } catch (err) {
      setStatus('orchard', 'error', 'Parse error');
      toast('CSV parse error: ' + err.message, 'error');
    }
  };
  reader.readAsText(file);
}

function parseCSV(text) {
  const lines = text.split('\n');
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1)
    .filter(l => l.trim())
    .map(line => {
      const vals = parseCSVLine(line);
      const row = {};
      headers.forEach((h, i) => { row[h.trim()] = (vals[i] || '').trim(); });
      return row;
    });
}

function parseCSVLine(line) {
  const result = [];
  let cur = '', inQuote = false;
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
  // Group by Display UPC, merge non-empty cells preferring rows with data
  const byUPC = new Map();
  for (const row of rows) {
    const upc = normalizeUPC(row['Display UPC'] || '');
    if (!upc) continue;
    if (!byUPC.has(upc)) {
      byUPC.set(upc, { ...row });
    } else {
      // Merge: for each field, prefer non-empty/non-zero value
      const existing = byUPC.get(upc);
      for (const [k, v] of Object.entries(row)) {
        const cur = existing[k];
        if ((!cur || cur === '0' || cur === '' || cur === '#N/A') && v && v !== '0' && v !== '#N/A') {
          existing[k] = v;
        }
      }
    }
  }
  return Array.from(byUPC.values());
}

function normalizeUPC(upc) {
  return String(upc).replace(/\D/g, '').replace(/^0+/, '') || '';
}

// ── MERGE DATA ────────────────────────────────────────────────
function mergeData() {
  const products = new Map(); // keyed by normalized UPC

  // First: process Packiyo products
  for (const p of State.packiyoProducts) {
    const upc = normalizeUPC(p.upc || p.barcode || '');
    if (!upc) continue;
    const isLP = isVinyl(p.name || p.title || '');
    products.set(upc, {
      upc,
      catalog:    p.sku || p.catalog_number || '',
      title:      p.name || p.title || p.description || '',
      artist:     '',       // filled from orchard
      format:     p.name ? guessFormat(p.name) : '',
      fromPackiyo: true,
      fp_available: safeNum(p.quantity_available ?? p.available_quantity ?? p.stock ?? 0),
      fp_onhand:    safeNum(p.quantity_on_hand ?? p.on_hand_quantity ?? 0),
      // Orchard fields filled below
      us_avail: 0, us_mtd: 0, us_3ms: 0, us_12ms: 0,
      ca_avail: 0, ca_mtd: 0, ca_3ms: 0, ca_12ms: 0,
      uk_avail: 0, uk_open: 0, uk_last_mo: 0, uk_this_yr: 0, uk_last_yr: 0,
      eu_avail: 0, eu_mtd: 0, eu_last_mo: 0, eu_this_yr: 0,
    });
  }

  // Second: process Orchard rows
  for (const row of State.orchardData) {
    const upc = normalizeUPC(row['Display UPC'] || '');
    if (!upc) continue;
    const orchardFields = {
      orchard_catalog: row['Product Code'] || '',
      orchard_title:   row['Release Name'] || '',
      artist:          row['Artist Name'] || '',
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
      // Merge orchard into packiyo entry
      const p = products.get(upc);
      Object.assign(p, orchardFields);
      // Use orchard catalog/title only if packiyo didn't provide them
      if (!p.catalog) p.catalog = orchardFields.orchard_catalog;
      if (!p.title)   p.title   = orchardFields.orchard_title;
    } else {
      // Orchard-only product
      products.set(upc, {
        upc,
        catalog:     orchardFields.orchard_catalog,
        title:       orchardFields.orchard_title,
        artist:      orchardFields.artist,
        format:      orchardFields.format,
        fromPackiyo: false,
        fp_available: 0, fp_onhand: 0,
        ...orchardFields,
      });
    }
  }

  State.merged = Array.from(products.values()).filter(p => p.title || p.catalog);

  renderInventory();
  renderManufacturing();
  renderAlerts();
  updateAlertBadge();
}

// ── INVENTORY VIEW ─────────────────────────────────────────────
function renderInventory() {
  const search  = (document.getElementById('search-input').value || '').toLowerCase();
  const cfgFilter = document.getElementById('filter-config').value.toLowerCase();
  const whFilter  = document.getElementById('filter-warehouse').value;

  let rows = State.merged.filter(p => {
    if (search) {
      const hay = `${p.artist} ${p.title} ${p.catalog} ${p.upc}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (cfgFilter) {
      const fmt = (p.format || '').toLowerCase();
      if (cfgFilter === 'lp' && !fmt.includes('vinyl') && !fmt.includes('lp') && !fmt.includes('12"')) return false;
      if (cfgFilter === 'cd' && !fmt.toLowerCase().includes('cd')) return false;
    }
    if (whFilter) {
      const avail = {
        fp: p.fp_available, us: p.us_avail, ca: p.ca_avail,
        uk: p.uk_avail,     eu: p.eu_avail,
      };
      if ((avail[whFilter] ?? 0) <= 0) return false;
    }
    return true;
  });

  // Sort
  rows.sort((a, b) => {
    let av = a[State.sortCol] ?? '', bv = b[State.sortCol] ?? '';
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return State.sortDir === 'asc' ? -1 : 1;
    if (av > bv) return State.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('inventory-tbody');
  document.getElementById('inventory-count').textContent =
    `${rows.length.toLocaleString()} products${State.merged.length !== rows.length ? ` (of ${State.merged.length.toLocaleString()})` : ''}`;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="25" class="empty-cell">No products match current filters.</td></tr>`;
    return;
  }

  const totalStock = p => (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);

  tbody.innerHTML = rows.map(p => {
    const total = totalStock(p);
    const status = stockStatus(p);
    return `<tr>
      <td>${esc(p.artist)}</td>
      <td>${esc(p.title)}</td>
      <td><code>${esc(p.catalog)}</code></td>
      <td><code style="font-size:11px">${esc(p.upc)}</code></td>
      <td><span class="pill pill-plan" style="font-size:9px">${esc(p.format)}</span></td>
      <td class="num">${numCell(p.fp_available)}</td>
      <td class="num">${numCell(p.us_avail)}</td>
      <td class="num">${numCell(p.us_mtd)}</td>
      <td class="num">${numCell(p.us_3ms)}</td>
      <td class="num">${numCell(p.us_12ms)}</td>
      <td class="num">${numCell(p.ca_avail)}</td>
      <td class="num">${numCell(p.ca_mtd)}</td>
      <td class="num">${numCell(p.ca_3ms)}</td>
      <td class="num">${numCell(p.ca_12ms)}</td>
      <td class="num">${numCell(p.uk_avail)}</td>
      <td class="num">${numCell(p.uk_open)}</td>
      <td class="num">${numCell(p.uk_last_mo)}</td>
      <td class="num">${numCell(p.uk_this_yr)}</td>
      <td class="num">${numCell(p.uk_last_yr)}</td>
      <td class="num">${numCell(p.eu_avail)}</td>
      <td class="num">${numCell(p.eu_mtd)}</td>
      <td class="num">${numCell(p.eu_last_mo)}</td>
      <td class="num">${numCell(p.eu_this_yr)}</td>
      <td class="num" style="font-weight:600">${numCell(total)}</td>
      <td>${statusPill(status)}</td>
    </tr>`;
  }).join('');
}

function stockStatus(p) {
  const total = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
  if (total === 0) return 'out';
  // Check any per-warehouse low stock
  const checks = [
    { avail: p.us_avail, vel12: p.us_12ms },
    { avail: p.ca_avail, vel12: p.ca_12ms },
    { avail: p.uk_avail, vel12: p.uk_last_yr / 12 },
    { avail: p.eu_avail, vel12: p.eu_this_yr / 12 },
  ];
  let worst = 'ok';
  for (const { avail, vel12 } of checks) {
    if (avail <= 0) continue;
    const monthly = (vel12 || 0) / 12;
    if (monthly <= 0) continue;
    const weeksLeft = (avail / monthly) * 4.33;
    if (weeksLeft < 4) worst = 'critical';
    else if (weeksLeft < CONFIG.REORDER_WEEKS && worst !== 'critical') worst = 'low';
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
  const [label, cls] = map[status] || ['—', ''];
  return `<span class="pill ${cls}">${label}</span>`;
}

// ── MANUFACTURING VIEW ─────────────────────────────────────────
function renderManufacturing() {
  const filter = document.getElementById('mfg-filter').value;
  const today  = new Date();

  // Global velocity = sum of all warehouse 12MS / 12
  let items = State.merged.map(p => {
    const totalStock = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
    const annual = (p.us_12ms||0) + (p.ca_12ms||0) + ((p.uk_last_yr||0)) + ((p.eu_this_yr||0));
    const monthly = annual / 12;
    if (monthly <= 0) return null;
    const monthsLeft = totalStock / monthly;
    if (monthsLeft > CONFIG.MFG_TRIGGER_MONTHS + 3) return null; // not relevant

    const isLPItem = isVinyl(p.format || p.title || '');
    const leadTime = isLPItem ? CONFIG.LEAD_TIME.lp : CONFIG.LEAD_TIME.cd;
    const poDeadlineDate = new Date(today.getTime() + (monthsLeft - leadTime) * 30 * 24 * 3600 * 1000);
    const daysToDeadline = Math.round((poDeadlineDate - today) / (24 * 3600 * 1000));

    let urgency = 'plan';
    if (daysToDeadline < 0)  urgency = 'overdue';
    else if (daysToDeadline < 30)  urgency = 'urgent';
    else if (daysToDeadline < 90)  urgency = 'soon';

    return { ...p, totalStock, monthly, monthsLeft, poDeadlineDate, daysToDeadline, urgency, isLP: isLPItem };
  }).filter(Boolean);

  // Apply filter
  if (filter === 'urgent')  items = items.filter(i => i.urgency === 'urgent' || i.urgency === 'overdue');
  if (filter === 'lp')      items = items.filter(i => i.isLP);
  if (filter === 'cd')      items = items.filter(i => !i.isLP);

  // Sort
  items.sort((a, b) => {
    let av = a[State.mfgSortCol], bv = b[State.mfgSortCol];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    if (av < bv) return State.mfgSortDir === 'asc' ? -1 : 1;
    if (av > bv) return State.mfgSortDir === 'asc' ? 1 : -1;
    return 0;
  });

  const tbody = document.getElementById('mfg-tbody');
  if (items.length === 0) {
    tbody.innerHTML = `<tr><td colspan="11" class="empty-cell">No items require manufacturing attention right now.</td></tr>`;
    return;
  }

  tbody.innerHTML = items.map(p => {
    const urgPill = {
      overdue: `<span class="pill pill-critical">Overdue</span>`,
      urgent:  `<span class="pill pill-urgent">Urgent</span>`,
      soon:    `<span class="pill pill-soon">Soon</span>`,
      plan:    `<span class="pill pill-plan">Plan</span>`,
    }[p.urgency] || '';
    const dl = p.daysToDeadline < 0
      ? `<span style="color:var(--red)">PAST DUE (${Math.abs(p.daysToDeadline)}d ago)</span>`
      : formatDate(p.poDeadlineDate);
    return `<tr>
      <td>${esc(p.artist)}</td>
      <td>${esc(p.title)}</td>
      <td><code>${esc(p.catalog)}</code></td>
      <td><code style="font-size:11px">${esc(p.upc)}</code></td>
      <td>${esc(p.format)}</td>
      <td class="num">${numCell(p.totalStock)}</td>
      <td class="num">${p.monthly.toFixed(1)}</td>
      <td class="num" style="font-weight:600">${p.monthsLeft.toFixed(1)}</td>
      <td class="num">${dl}</td>
      <td>${urgPill}</td>
      <td><span class="pill pill-plan" style="font-size:9px">FP WH / Orchard US</span></td>
    </tr>`;
  }).join('');
}

// ── ALERTS VIEW ───────────────────────────────────────────────
function renderAlerts() {
  const WAREHOUSES = [
    { key: 'us', label: 'Orchard US',     avail: 'us_avail', vel: 'us_12ms',  velDiv: 12 },
    { key: 'ca', label: 'Orchard Canada', avail: 'ca_avail', vel: 'ca_12ms',  velDiv: 12 },
    { key: 'uk', label: 'Orchard UK',     avail: 'uk_avail', vel: 'uk_last_yr', velDiv: 12 },
    { key: 'eu', label: 'Orchard EU',     avail: 'eu_avail', vel: 'eu_this_yr', velDiv: 12 },
  ];

  const container = document.getElementById('alerts-container');
  let totalAlerts = 0;
  let html = '';

  for (const wh of WAREHOUSES) {
    const alerts = State.merged.map(p => {
      const avail = p[wh.avail] || 0;
      const annual = p[wh.vel] || 0;
      const monthly = annual / wh.velDiv;
      if (monthly <= 0 || avail < 0) return null;
      const weeksLeft = (avail / monthly) * 4.33;
      if (weeksLeft >= CONFIG.REORDER_WEEKS) return null;
      return { ...p, avail, monthly, weeksLeft };
    }).filter(Boolean).sort((a, b) => a.weeksLeft - b.weeksLeft);

    if (alerts.length === 0) continue;
    totalAlerts += alerts.length;

    html += `<div class="alert-section">
      <h3>${wh.label} — ${alerts.length} item${alerts.length > 1 ? 's' : ''} below ${CONFIG.REORDER_WEEKS} weeks</h3>
      <div class="table-wrap">
        <table>
          <thead><tr>
            <th>Artist</th><th>Title</th><th>Catalog #</th><th>Format</th>
            <th class="num">Avail</th><th class="num">Monthly Vel</th><th class="num">Weeks Left</th><th>Status</th>
            <th>Replenish From</th>
          </tr></thead>
          <tbody>
            ${alerts.map(p => {
              const weeks = p.weeksLeft.toFixed(1);
              const cls = p.weeksLeft < 2 ? 'pill-critical' : p.weeksLeft < 4 ? 'pill-urgent' : 'pill-low';
              const repFrom = wh.key === 'us' ? 'Fat Possum WH'
                            : wh.key === 'ca' ? 'Orchard US'
                            : wh.key === 'uk' ? 'Orchard US'
                            : wh.key === 'eu' ? 'Orchard UK / Orchard US'
                            : '—';
              return `<tr>
                <td>${esc(p.artist)}</td>
                <td>${esc(p.title)}</td>
                <td><code>${esc(p.catalog)}</code></td>
                <td>${esc(p.format)}</td>
                <td class="num">${numCell(p.avail)}</td>
                <td class="num">${p.monthly.toFixed(1)}</td>
                <td class="num" style="font-weight:600">${weeks}</td>
                <td><span class="pill ${cls}">${weeks} wks</span></td>
                <td style="color:var(--text-muted);font-size:11px">${repFrom}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
  }

  if (html === '') {
    container.innerHTML = `<div style="color:var(--text-muted);text-align:center;padding:60px">
      All warehouses are above the ${CONFIG.REORDER_WEEKS}-week threshold. No alerts.</div>`;
  } else {
    container.innerHTML = html;
  }

  document.getElementById('alert-badge').textContent = totalAlerts;
  if (totalAlerts > 0) document.getElementById('alert-badge').classList.remove('hidden');
  else document.getElementById('alert-badge').classList.add('hidden');
}

function updateAlertBadge() {
  // Recomputed in renderAlerts
}

// ── MOVEMENTS ──────────────────────────────────────────────────
const VALID_ROUTES = new Set([
  'fp→us', 'us→ca', 'us→uk', 'us→eu', 'uk→eu',
]);
const WH_LABELS = {
  fp: 'Fat Possum WH', us: 'Orchard US',
  ca: 'Orchard Canada', uk: 'Orchard UK', eu: 'Orchard EU',
};

function validateRoute() {
  const from = document.getElementById('mov-from').value;
  const to   = document.getElementById('mov-to').value;
  const warn = document.getElementById('mov-route-warning');
  const route = `${from}→${to}`;
  if (from === to) {
    warn.textContent = 'Origin and destination cannot be the same.';
    warn.classList.remove('hidden');
  } else if (!VALID_ROUTES.has(route)) {
    warn.textContent = `⚠ Non-standard route: ${WH_LABELS[from]} → ${WH_LABELS[to]}. Standard routes: FP WH→US, US→CA, US→UK, US→EU, UK→EU.`;
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }
}

function updateMovementDropdown() {
  const q = document.getElementById('mov-product-search').value.toLowerCase().trim();
  const dd = document.getElementById('mov-product-dropdown');
  if (q.length < 2) { dd.classList.add('hidden'); return; }
  const matches = State.merged.filter(p => {
    return `${p.artist} ${p.title} ${p.catalog} ${p.upc}`.toLowerCase().includes(q);
  }).slice(0, 15);
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
      const upc = item.dataset.upc;
      const prod = State.merged.find(p => p.upc === upc);
      if (!prod) return;
      document.getElementById('mov-product-search').value = `${prod.artist} — ${prod.title}`;
      document.getElementById('mov-product-upc').value = upc;
      dd.classList.add('hidden');
      const sel = document.getElementById('mov-selected-product');
      sel.innerHTML = `<strong>${esc(prod.artist)} — ${esc(prod.title)}</strong>
        <span>${esc(prod.catalog)} · ${esc(prod.upc)} · ${esc(prod.format)} · FP: ${prod.fp_available} · US: ${prod.us_avail} · CA: ${prod.ca_avail} · UK: ${prod.uk_avail} · EU: ${prod.eu_avail}</span>`;
      sel.classList.remove('hidden');
    });
  });
}

// Close dropdown on outside click
document.addEventListener('click', (e) => {
  if (!e.target.closest('#mov-product-search') && !e.target.closest('#mov-product-dropdown')) {
    document.getElementById('mov-product-dropdown')?.classList.add('hidden');
  }
});

function addMovement() {
  const from = document.getElementById('mov-from').value;
  const to   = document.getElementById('mov-to').value;
  const upc  = document.getElementById('mov-product-upc').value;
  const qty  = parseInt(document.getElementById('mov-qty').value, 10);
  const notes = document.getElementById('mov-notes').value;

  if (!upc) { toast('Please select a product.', 'error'); return; }
  if (!qty || qty < 1) { toast('Quantity must be at least 1.', 'error'); return; }
  if (from === to) { toast('Origin and destination cannot be the same.', 'error'); return; }

  const prod = State.merged.find(p => p.upc === upc);
  if (!prod) { toast('Product not found.', 'error'); return; }

  // For Orchard→Orchard movements, use orchard catalog/title (not Packiyo)
  const useOrchard = from !== 'fp' || to !== 'fp';

  State.movements.push({
    from, to,
    artist:  prod.artist,
    title:   prod.title,
    catalog: prod.catalog,
    upc:     prod.upc,
    format:  prod.format,
    qty,
    notes,
    useOrchard,
    timestamp: new Date().toISOString(),
  });

  // Reset form
  document.getElementById('mov-product-search').value = '';
  document.getElementById('mov-product-upc').value = '';
  document.getElementById('mov-selected-product').classList.add('hidden');
  document.getElementById('mov-qty').value = 1;
  document.getElementById('mov-notes').value = '';

  renderMovementsTable();
  toast('Movement added to queue.', 'success');
}

function renderMovementsTable() {
  const tbody = document.getElementById('movements-tbody');
  document.getElementById('mov-queue-count').textContent = `${State.movements.length} item${State.movements.length !== 1 ? 's' : ''}`;
  if (State.movements.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" class="empty-cell">No movements queued yet.</td></tr>`;
    return;
  }
  tbody.innerHTML = State.movements.map((m, i) => `<tr>
    <td>${WH_LABELS[m.from]}</td>
    <td>${WH_LABELS[m.to]}</td>
    <td>${esc(m.artist)}</td>
    <td>${esc(m.title)}</td>
    <td><code>${esc(m.catalog)}</code></td>
    <td><code style="font-size:11px">${esc(m.upc)}</code></td>
    <td>${esc(m.format)}</td>
    <td class="num">${m.qty}</td>
    <td style="color:var(--text-muted)">${esc(m.notes)}</td>
    <td><button class="btn-danger" onclick="removeMovement(${i})">×</button></td>
  </tr>`).join('');
}

window.removeMovement = function(i) {
  State.movements.splice(i, 1);
  renderMovementsTable();
};

// ── EXPORTS ────────────────────────────────────────────────────
function exportMovements() {
  if (State.movements.length === 0) { toast('No movements to export.', 'error'); return; }
  const headers = ['From Warehouse','To Warehouse','Artist','Title','Catalog #','UPC','Format','Quantity','Notes'];
  const rows = State.movements.map(m => [
    WH_LABELS[m.from], WH_LABELS[m.to],
    m.artist, m.title, m.catalog, m.upc, m.format, m.qty, m.notes
  ]);
  downloadCSV('fp_movement_request_' + dateStr() + '.csv', headers, rows);
  toast('Movement request exported.', 'success');
}

function exportInventory() {
  const headers = ['Artist','Title','Catalog #','UPC','Format',
    'FP WH Available','FP WH On Hand',
    'US Available','US MTD','US 3MS','US 12MS',
    'CA Available','CA MTD','CA 3MS','CA 12MS',
    'UK Available','UK Open Orders','UK Last Month','UK This Year','UK Last Year',
    'EU Available','EU MTD','EU Last Month','EU This Year',
    'Total Stock'];
  const rows = State.merged.map(p => [
    p.artist, p.title, p.catalog, p.upc, p.format,
    p.fp_available, p.fp_onhand,
    p.us_avail, p.us_mtd, p.us_3ms, p.us_12ms,
    p.ca_avail, p.ca_mtd, p.ca_3ms, p.ca_12ms,
    p.uk_avail, p.uk_open, p.uk_last_mo, p.uk_this_yr, p.uk_last_yr,
    p.eu_avail, p.eu_mtd, p.eu_last_mo, p.eu_this_yr,
    (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0)
  ]);
  downloadCSV('fp_global_inventory_' + dateStr() + '.csv', headers, rows);
  toast('Inventory exported.', 'success');
}

function exportManufacturing() {
  const today = new Date();
  const items = State.merged.map(p => {
    const totalStock = (p.fp_available||0)+(p.us_avail||0)+(p.ca_avail||0)+(p.uk_avail||0)+(p.eu_avail||0);
    const annual = (p.us_12ms||0)+(p.ca_12ms||0)+(p.uk_last_yr||0)+(p.eu_this_yr||0);
    const monthly = annual / 12;
    if (monthly <= 0) return null;
    const monthsLeft = totalStock / monthly;
    if (monthsLeft > CONFIG.MFG_TRIGGER_MONTHS + 3) return null;
    const isLPItem = isVinyl(p.format || '');
    const leadTime = isLPItem ? CONFIG.LEAD_TIME.lp : CONFIG.LEAD_TIME.cd;
    const poDeadlineDate = new Date(today.getTime() + (monthsLeft - leadTime) * 30 * 24 * 3600 * 1000);
    const daysToDeadline = Math.round((poDeadlineDate - today) / (24 * 3600 * 1000));
    return { ...p, totalStock, monthly, monthsLeft, poDeadlineDate, daysToDeadline };
  }).filter(Boolean);
  const headers = ['Artist','Title','Catalog #','UPC','Format','Total Stock','Global Velocity/mo','Months Left','PO Deadline','Days to Deadline'];
  const rows = items.map(p => [
    p.artist, p.title, p.catalog, p.upc, p.format,
    p.totalStock, p.monthly.toFixed(1), p.monthsLeft.toFixed(1),
    formatDate(p.poDeadlineDate), p.daysToDeadline
  ]);
  downloadCSV('fp_manufacturing_' + dateStr() + '.csv', headers, rows);
  toast('Manufacturing report exported.', 'success');
}

function exportAlerts() {
  const WAREHOUSES = [
    { key: 'us', label: 'Orchard US',     avail: 'us_avail', vel: 'us_12ms',   velDiv: 12 },
    { key: 'ca', label: 'Orchard Canada', avail: 'ca_avail', vel: 'ca_12ms',   velDiv: 12 },
    { key: 'uk', label: 'Orchard UK',     avail: 'uk_avail', vel: 'uk_last_yr', velDiv: 12 },
    { key: 'eu', label: 'Orchard EU',     avail: 'eu_avail', vel: 'eu_this_yr', velDiv: 12 },
  ];
  const headers = ['Warehouse','Artist','Title','Catalog #','UPC','Format','Available','Monthly Velocity','Weeks Left'];
  const rows = [];
  for (const wh of WAREHOUSES) {
    for (const p of State.merged) {
      const avail = p[wh.avail] || 0;
      const monthly = (p[wh.vel] || 0) / wh.velDiv;
      if (monthly <= 0) continue;
      const weeksLeft = (avail / monthly) * 4.33;
      if (weeksLeft < CONFIG.REORDER_WEEKS) {
        rows.push([wh.label, p.artist, p.title, p.catalog, p.upc, p.format, avail, monthly.toFixed(1), weeksLeft.toFixed(1)]);
      }
    }
  }
  downloadCSV('fp_reorder_alerts_' + dateStr() + '.csv', headers, rows);
  toast('Alerts exported.', 'success');
}

function downloadCSV(filename, headers, rows) {
  const csvContent = [headers, ...rows].map(r =>
    r.map(cell => {
      const s = String(cell ?? '');
      return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')
  ).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── VIEW SWITCHING ─────────────────────────────────────────────
function switchView(viewName) {
  document.querySelectorAll('.view').forEach(v => {
    v.classList.add('hidden'); v.classList.remove('active');
  });
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const view = document.getElementById(`view-${viewName}`);
  if (view) { view.classList.remove('hidden'); view.classList.add('active'); }
  const nav = document.querySelector(`[data-view="${viewName}"]`);
  if (nav) nav.classList.add('active');
}

// ── STATUS HELPERS ─────────────────────────────────────────────
function setStatus(which, state, label) {
  const dot  = document.getElementById(`${which}-dot`);
  const text = document.getElementById(`${which}-status-text`);
  if (dot)  { dot.className = 'status-dot ' + state; }
  if (text) text.textContent = label;
}

function updateSortHeaders(tableId, col, dir) {
  document.querySelectorAll(`#${tableId} th.sortable`).forEach(th => {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.col === col) th.classList.add(dir === 'asc' ? 'sort-asc' : 'sort-desc');
  });
}

// ── UTILS ───────────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function safeNum(v) {
  const n = parseFloat(String(v).replace(/[^0-9.-]/g,''));
  return isNaN(n) ? 0 : n;
}
function numCell(n) {
  if (n === 0 || n === null || n === undefined) return `<span class="num-zero">0</span>`;
  return String(n);
}
function isVinyl(s) {
  const l = (s || '').toLowerCase();
  return l.includes('vinyl') || l.includes('lp') || l.includes('12"') || l.includes("12'") || l.includes('10"') || l.includes('7"');
}
function guessFormat(name) {
  if (isVinyl(name)) return '12" Vinyl';
  if (name.toLowerCase().includes('cd')) return 'CD';
  return name;
}
function formatDate(d) {
  return d.toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}
function dateStr() {
  return new Date().toISOString().slice(0,10).replace(/-/g,'');
}
function debounce(fn, ms) {
  let t; return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ` toast-${type}` : '');
  el.classList.remove('hidden');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add('hidden'), 3500);
}
