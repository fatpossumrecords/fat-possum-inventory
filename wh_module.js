/* ============================================================
   FAT POSSUM — WH ACTION MODULE
   wh_module.js — Replenishment & Warehouse Walkthrough
   Uses packiyoFetch() from app.js — no separate API config needed
   ============================================================ */

const WHState = {
  allRows:      [],
  filtered:     [],
  sortKey:      'suggest',
  sortDir:      -1,
  activeFilter: 'all',
  currentPage:  1,
  pageSize:     50,
  walkOrderMode:false,
  wtShowEmpty:  true,
  running:      false,
};

const WH_SETTINGS_KEY = 'fp_wh_replen_settings';
const WH_CONCURRENCY  = 6;

// ── NAV TOGGLE ───────────────────────────────────────────────
window.toggleWHNav = function(e) {
  e.preventDefault();
  const sub   = document.getElementById('wh-nav-sub');
  const arrow = document.getElementById('wh-nav-arrow');
  if (!sub) return;
  const open = sub.style.display === 'none' || sub.style.display === '';
  sub.style.display = open ? 'block' : 'none';
  if (arrow) arrow.textContent = open ? '▾' : '▸';
  if (open) switchView('replenishment');
};

// ── SETTINGS ─────────────────────────────────────────────────
window.whSaveSettings = function() {
  const ids = ['wh-lookback','wh-days-supply','wh-outlier','wh-max-units','wh-min-units'];
  const obj = {};
  for (const id of ids) { const el = document.getElementById(id); if (el) obj[id] = el.value; }
  try { localStorage.setItem(WH_SETTINGS_KEY, JSON.stringify(obj)); } catch(e) {}
};

window.whLoadSettings = function() {
  try {
    const raw = localStorage.getItem(WH_SETTINGS_KEY);
    if (!raw) return;
    const obj = JSON.parse(raw);
    for (const [id, val] of Object.entries(obj)) { const el = document.getElementById(id); if (el) el.value = val; }
  } catch(e) {}
};

function whCfg() {
  return {
    lookback:   parseInt(document.getElementById('wh-lookback')?.value)    || 30,
    daysSupply: parseInt(document.getElementById('wh-days-supply')?.value) || 7,
    outlier:    parseInt(document.getElementById('wh-outlier')?.value)     || 25,
    maxUnits:   parseInt(document.getElementById('wh-max-units')?.value)   || 50,
    minUnits:   parseInt(document.getElementById('wh-min-units')?.value)   || 2,
  };
}

// ── TAB SWITCHER ─────────────────────────────────────────────
window.switchWHTab = function(tab) {
  document.getElementById('wh-tab-replenishment')?.classList.toggle('hidden', tab !== 'replenishment');
  document.getElementById('wh-tab-walkthrough')?.classList.toggle('hidden',   tab !== 'walkthrough');
  document.getElementById('wh-tabbtn-replen')?.classList.toggle('active', tab === 'replenishment');
  document.getElementById('wh-tabbtn-walk')?.classList.toggle('active',   tab === 'walkthrough');
  if (tab === 'walkthrough') wtRender();
};

// ── FETCH HELPERS ─────────────────────────────────────────────
async function whFetchPage(endpoint, page, size) {
  const sep  = endpoint.includes('?') ? '&' : '?';
  const data = await packiyoFetch(endpoint + sep + 'page[number]=' + page + '&page[size]=' + size);
  const meta = data.meta?.page || data.meta || {};
  const lastPage = parseInt(meta.lastPage || meta.last_page || meta.total_pages || 0) || null;
  return { data: data.data || [], included: data.included || [], lastPage };
}

async function whFetchAll(endpoint, size, onProgress) {
  if (onProgress) onProgress(1, '?');
  const first = await whFetchPage(endpoint, 1, size);
  const allData = [...first.data], allIncluded = [...first.included];
  const last = first.lastPage || (first.data.length < size ? 1 : null);
  if (!last || last <= 1) return { allData, allIncluded };
  if (onProgress) onProgress(1, last);
  const remaining = [];
  for (let p = 2; p <= last; p++) remaining.push(p);
  for (let i = 0; i < remaining.length; i += WH_CONCURRENCY) {
    const results = await Promise.all(remaining.slice(i, i + WH_CONCURRENCY).map(p => whFetchPage(endpoint, p, size)));
    for (const r of results) { allData.push(...r.data); allIncluded.push(...r.included); }
    if (onProgress) onProgress(Math.min(i + WH_CONCURRENCY + 1, last), last);
  }
  return { allData, allIncluded };
}

// ── UI HELPERS ────────────────────────────────────────────────
function whSetStatus(msg) {
  const el = document.getElementById('wh-status-step');
  if (el) el.textContent = msg;
  const det = document.getElementById('wh-dash-gen-detail');
  if (det) det.textContent = msg;
}
function whSetProgress(pct, label) {
  const bar = document.getElementById('wh-progress-bar');
  const lbl = document.getElementById('wh-progress-label');
  if (bar) bar.style.width = pct + '%';
  if (lbl) lbl.textContent = label;
}
function whShowStatus(v)  { const el = document.getElementById('wh-status-area');  if (el) el.style.display = v ? 'block' : 'none'; }
function whShowResults(v) {
  const el = document.getElementById('wh-results');
  const em = document.getElementById('wh-empty-state');
  if (el) el.style.display = v ? 'flex' : 'none';
  if (em) em.style.display = v ? 'none' : 'flex';
}
function whShowError(msg) {
  const el = document.getElementById('wh-error-area');
  const me = document.getElementById('wh-error-msg');
  if (el) el.style.display = 'block';
  if (me) me.textContent = msg;
}
function whHideError() { const el = document.getElementById('wh-error-area'); if (el) el.style.display = 'none'; }

// ── MAIN REPORT ───────────────────────────────────────────────
window.runReplenishment = async function() {
  if (WHState.running) return;
  WHState.running = true;
  const btn = document.getElementById('wh-run-btn');
  if (btn) btn.disabled = true;
  window.whSaveSettings();
  whSetProgress(0, '');
  whShowStatus(true);
  whHideError();
  whShowResults(false);
  const c = whCfg();

  try {
    whSetStatus('Fetching locations, orders & open orders in parallel…');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - c.lookback);
    const dateStr = cutoff.toISOString().split('T')[0];
    const orderEndpoint = '/orders?include=order_items&filter[fulfilled]=true&filter[fulfilled_at_min]=' + dateStr;

    const [locResult, orderResult, openResult] = await Promise.all([
      whFetchAll('/locations?include=location_type', 100, (p,t) => whSetStatus('Locations: page ' + p + ' of ' + t)),
      whFetchAll(orderEndpoint,                      100, (p,t) => whSetStatus('Orders: page '    + p + ' of ' + t)),
      whFetchAll('/orders?include=order_items&filter[fulfilled]=false', 100, (p,t) => whSetStatus('Open orders: page ' + p + ' of ' + t)),
    ]);

    whSetProgress(40, locResult.allData.length + ' locations · ' + orderResult.allData.length + ' fulfilled orders · ' + openResult.allData.length + ' open orders');

    // Location type maps
    const typePickable = {}, typeSellable = {};
    for (const inc of locResult.allIncluded) {
      if (inc.type === 'location-types') {
        const p = inc.attributes?.pickable, s = inc.attributes?.sellable;
        typePickable[inc.id] = (p === true || p === 1 || p === '1');
        typeSellable[inc.id] = (s === true || s === 1 || s === '1');
      }
    }
    const locationPickable = {}, locationSellable = {};
    for (const loc of locResult.allData) {
      const typeId = loc.relationships?.location_type?.data?.id;
      locationPickable[loc.id] = typeId ? (typePickable[typeId] ?? false) : false;
      locationSellable[loc.id] = typeId ? (typeSellable[typeId] ?? false) : false;
    }

    // Tag order items with their order id
    const rawOrderItems = orderResult.allIncluded.filter(i => i.type === 'order-items');
    for (const order of orderResult.allData) {
      const refIds = new Set((order.relationships?.order_items?.data || []).map(r => r.id));
      for (const inc of rawOrderItems) {
        if (!inc._tagged && (refIds.size === 0 || refIds.has(inc.id))) { inc._orderId = order.id; inc._tagged = true; }
      }
    }

    // Live allocation from open orders
    const openItems = openResult.allIncluded.filter(i => i.type === 'order-items');
    const openItemToOrder = {};
    for (const order of openResult.allData) {
      for (const ref of (order.relationships?.order_items?.data || [])) openItemToOrder[ref.id] = order;
    }
    const liveCustomerAllocBySku = {}, livePOAllocBySku = {};
    for (const item of openItems) {
      const order = openItemToOrder[item.id];
      if (!order) continue;
      if (/cancelled/i.test(order.attributes?.status_text || '')) continue;
      const orderNum = order.attributes?.number || order.attributes?.order_number || '';
      const a = item.attributes || {};
      const sku = a.sku || a.product_sku || a.variant_sku || a.item_sku || '';
      const qty = parseInt(a.quantity || a.quantity_ordered || a.qty || 0);
      if (!sku || qty <= 0) continue;
      if (/^PO#\s*/i.test(String(orderNum))) { livePOAllocBySku[sku] = (livePOAllocBySku[sku] || 0) + qty; }
      else { liveCustomerAllocBySku[sku] = (liveCustomerAllocBySku[sku] || 0) + qty; }
    }

    whSetProgress(55, 'Building velocity map…');
    const velocityMap = whBuildVelocityMap(rawOrderItems, c);

    whSetStatus('Fetching products with locations…');
    const prodResult = await whFetchAll('/products?include=location_products.location', 100, (p,t) => whSetStatus('Products: page ' + p + ' of ' + t));
    whSetProgress(85, prodResult.allData.length + ' products loaded');
    if (!prodResult.allData.length) throw new Error('No products returned from Packiyo.');

    const locNameById = {};
    for (const inc of prodResult.allIncluded) {
      if (inc.type === 'locations') locNameById[inc.id] = inc.attributes?.name || inc.id;
    }
    const lpById = {};
    for (const inc of prodResult.allIncluded) {
      if (inc.type === 'location-products') {
        lpById[inc.id] = { qty: parseInt(inc.attributes?.quantity_on_hand ?? 0), locationId: inc.relationships?.location?.data?.id || null };
      }
    }

    const pickQtyBySku = {};
    for (const item of prodResult.allData) {
      const sku = item.attributes?.sku || '';
      if (!sku) continue;
      let pickQty = 0, bulkQty = 0;
      const bulkLocs = [], pickLocs = [], emptyPickLocs = [];
      for (const ref of (item.relationships?.location_products?.data || [])) {
        const lp = lpById[ref.id];
        if (!lp) continue;
        const isPickable = lp.locationId && locationPickable[lp.locationId];
        const isSellable = lp.locationId && locationSellable[lp.locationId];
        const locName = lp.locationId ? (locNameById[lp.locationId] || lp.locationId) : '?';
        if (isPickable) {
          if (lp.qty > 0) { pickQty += lp.qty; pickLocs.push(locName); }
          else emptyPickLocs.push(locName);
        } else if (isSellable && lp.qty > 0) { bulkQty += lp.qty; bulkLocs.push({ name: locName, qty: lp.qty }); }
      }
      bulkLocs.sort((a,b) => { const aN = /^NOW(-|$)/i.test(a.name), bN = /^NOW(-|$)/i.test(b.name); if (aN !== bN) return aN ? 1 : -1; return a.qty - b.qty; });
      pickQtyBySku[sku] = { pickQty, bulkQty, bulkLocs, pickLocs, emptyPickLocs };
    }

    whSetStatus('Building report…');
    WHState.allRows = whBuildRows(prodResult.allData, pickQtyBySku, velocityMap, liveCustomerAllocBySku, livePOAllocBySku, c);
    window._whDebug = { pickQtyBySku, allRows: WHState.allRows };

    whSetProgress(100, WHState.allRows.length + ' SKUs · ' + WHState.allRows.filter(r => r.suggest > 0).length + ' need replenishment');
    whRenderAll(false);
  } catch(err) {
    whShowStatus(false);
    whShowError(err.message);
    console.error('WH Replenishment error:', err);
  } finally {
    WHState.running = false;
    if (btn) btn.disabled = false;
  }
};

// ── VELOCITY MAP ──────────────────────────────────────────────
function whBuildVelocityMap(orderItems, c) {
  const orderSkuQty = {};
  for (const item of orderItems) {
    const a = item.attributes || item;
    const sku = a.sku || a.product_sku || a.variant_sku || a.item_sku || '';
    const qty = parseInt(a.quantity || a.quantity_ordered || a.qty || 0);
    if (!sku || qty <= 0) continue;
    const oid = item._orderId || 'unknown';
    if (!orderSkuQty[oid]) orderSkuQty[oid] = {};
    orderSkuQty[oid][sku] = (orderSkuQty[oid][sku] || 0) + qty;
  }
  const map = {};
  for (const skuMap of Object.values(orderSkuQty)) {
    for (const [sku, qty] of Object.entries(skuMap)) {
      if (qty >= c.outlier) continue;
      if (!map[sku]) map[sku] = { totalUnits: 0, orderCount: 0 };
      map[sku].totalUnits += qty;
      map[sku].orderCount += 1;
    }
  }
  return map;
}

// ── BUILD ROWS ────────────────────────────────────────────────
function whBuildRows(products, pickQtyBySku, velocityMap, liveCustomerAllocBySku, livePOAllocBySku, c) {
  return products.map(item => {
    const a = item.attributes || item;
    const name = a.name || 'Unknown', sku = a.sku || '';
    const onHand = parseInt(a.quantity_on_hand ?? 0);
    const customerAllocated = liveCustomerAllocBySku[sku] || 0;
    const poAllocated       = livePOAllocBySku[sku]       || 0;
    const allocated         = customerAllocated + poAllocated;
    const locData = pickQtyBySku[sku] || { pickQty:0, bulkQty:0, bulkLocs:[], pickLocs:[], emptyPickLocs:[] };
    const { pickQty, bulkQty, bulkLocs=[], pickLocs=[], emptyPickLocs=[] } = locData;
    const freePickQty = Math.max(0, pickQty - customerAllocated);
    const vm = velocityMap[sku] || null;
    const velocity   = vm ? parseFloat((vm.totalUnits / c.lookback).toFixed(3)) : 0;
    const orderCount = vm ? vm.orderCount : 0;
    let velocityTarget = velocity > 0 ? Math.ceil(velocity * c.daysSupply) : 0;
    if (freePickQty === 0 && orderCount > 0) velocityTarget = Math.max(velocityTarget, c.minUnits);
    const postPickTarget = Math.min(velocityTarget + customerAllocated, c.maxUnits);
    let netSuggest = Math.max(0, postPickTarget - pickQty);
    if (netSuggest > 0 && netSuggest < c.minUnits) netSuggest = c.minUnits;
    const pickLocsFallback = pickLocs.length === 0 && emptyPickLocs.length > 0;
    const replenishBins    = pickLocs.length > 0 ? pickLocs : emptyPickLocs;
    let priority = 'ok';
    if (freePickQty === 0 && orderCount > 0) priority = 'urgent';
    else if (netSuggest > 0) priority = 'replenish';
    return { name, sku, onHand, allocated, customerAllocated, poAllocated,
      pickQty, freePickQty, bulkQty, bulkLocs, pickLocs: replenishBins, pickLocsFallback,
      velocity, orderCount, suggest: netSuggest, priority };
  }).filter(r => r.onHand > 0 && (r.bulkQty > 0 || r.priority === 'ok'));
}

// ── RENDER ALL ────────────────────────────────────────────────
function whRenderAll(keepPage) {
  if (!keepPage) WHState.currentPage = 1;
  whShowStatus(false);
  whApplyFilters();
  whRenderStats();
  whShowResults(true);
  const gi = document.getElementById('wh-gen-info');
  if (gi) gi.textContent = 'Generated ' + new Date().toLocaleString() + ' · ' + WHState.allRows.length + ' SKUs analysed';
}

function whRenderStats() {
  const urgent = WHState.allRows.filter(r => r.priority === 'urgent').length;
  const needs  = WHState.allRows.filter(r => r.priority === 'replenish').length;
  const ok     = WHState.allRows.filter(r => r.priority === 'ok').length;
  const total  = WHState.allRows.reduce((s,r) => s + r.suggest, 0);
  const el = document.getElementById('wh-stat-grid');
  if (!el) return;
  const stat = (label, val, color) =>
    '<div style="flex:1;padding:10px 20px;border-right:1px solid var(--border);display:flex;align-items:center;gap:12px;">'
    + '<span style="font-family:\'DM Mono\',monospace;font-size:22px;font-weight:600;color:' + color + '">' + val + '</span>'
    + '<span style="font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.8px;color:var(--text-muted);line-height:1.3;">' + label + '</span>'
    + '</div>';
  el.innerHTML =
    stat('Total SKUs',          WHState.allRows.length, 'var(--text)')
  + stat('Urgent',              urgent,  'var(--red)')
  + stat('Needs Replenishment', needs,   'var(--yellow)')
  + stat('Pick Stock OK',       ok,      'var(--green)')
  + stat('Units to Move',       total,   'var(--accent)');
}

function whApplyFilters() {
  const q = (document.getElementById('wh-search-box')?.value || '').toLowerCase();
  const f = WHState.activeFilter;
  WHState.filtered = WHState.allRows.filter(r => {
    const ms = !q || r.name.toLowerCase().includes(q) || r.sku.toLowerCase().includes(q);
    const mf = f === 'all' ? true
      : f === 'urgent'              ? r.priority === 'urgent'
      : f === 'replenish'           ? r.priority === 'replenish'
      : f === 'ok'                  ? r.priority === 'ok'
      : f === 'replenish-and-urgent'? (r.priority === 'urgent' || r.priority === 'replenish')
      : true;
    return ms && mf;
  });
  if (WHState.walkOrderMode) {
    WHState.filtered.sort((a,b) => {
      const ka = whWalkSortKey(a), kb = whWalkSortKey(b);
      for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
      return 0;
    });
  } else { whSortRows(); }
  whRenderTable();
  whRenderPagination();
}

function whSortRows() {
  WHState.filtered.sort((a,b) => {
    let av = a[WHState.sortKey], bv = b[WHState.sortKey];
    if (typeof av === 'string') av = av.toLowerCase();
    if (typeof bv === 'string') bv = bv.toLowerCase();
    return av < bv ? -WHState.sortDir : av > bv ? WHState.sortDir : 0;
  });
}

function whLocSortKey(name) {
  const m = (name||'').match(/([A-Za-z]+)-(\d+)-([A-Za-z]+)(\d+)/);
  if (!m) return ['ZZZ',999,'ZZ',99];
  return [m[1].toUpperCase(), parseInt(m[2]), m[3].toUpperCase(), parseInt(m[4])];
}
function whIsNowLoc(name) { return /^NOW(-|$)/i.test(name||''); }
function whWalkSortKey(row) {
  if (!row.bulkLocs || !row.bulkLocs.length) return ['ZZZ',999,'ZZ',99];
  const sorted = [...row.bulkLocs].sort((a,b) => {
    const aN = whIsNowLoc(a.name), bN = whIsNowLoc(b.name);
    if (aN !== bN) return aN ? 1 : -1;
    const ka = whLocSortKey(a.name), kb = whLocSortKey(b.name);
    for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
    return 0;
  });
  return whLocSortKey(sorted[0].name);
}

// ── TABLE RENDER ──────────────────────────────────────────────
function whRenderBulkLocs(locs, suggest) {
  if (!locs || !locs.length) return '<span style="color:var(--text-dim);font-size:10px;">—</span>';
  const sorted = [...locs].sort((a,b) => {
    const aN=whIsNowLoc(a.name), bN=whIsNowLoc(b.name);
    if (aN !== bN) return aN ? 1 : -1;
    const ka=whLocSortKey(a.name), kb=whLocSortKey(b.name);
    for (let i=0;i<ka.length;i++){if(ka[i]<kb[i])return -1;if(ka[i]>kb[i])return 1;} return 0;
  });
  const first = sorted[0];
  const firstOk = suggest <= 0 || first.qty >= suggest;
  return [first, (!firstOk ? sorted[1] : null)].filter(Boolean).map((l,i) => {
    const now = whIsNowLoc(l.name);
    const ok  = suggest <= 0 || l.qty >= suggest;
    const color = now ? 'var(--yellow)' : ok ? 'var(--accent)' : 'var(--text)';
    const bg    = now ? 'var(--yellow-bg)' : ok ? '#fcecea' : 'var(--surface2)';
    return (i > 0 ? '<br>' : '') + '<span style="display:inline-flex;align-items:center;font-family:\'DM Mono\',monospace;font-size:10px;background:' + bg + ';color:' + color + ';border-radius:2px;padding:1px 6px;margin:1px 2px 1px 0;white-space:nowrap;">' + whEsc(l.name) + '<span style="opacity:0.5;margin-left:4px;font-size:9px">' + l.qty + '</span>' + (now?'<span style="font-size:8px;opacity:0.5;margin-left:3px">(aux)</span>':'') + '</span>';
  }).join('');
}

function whRenderPickBins(pickLocs, isFallback) {
  if (!pickLocs || !pickLocs.length) return '<span style="color:var(--text-dim);font-size:10px;">—</span>';
  const color = isFallback ? 'var(--yellow)' : 'var(--green)';
  const bg    = isFallback ? 'var(--yellow-bg)' : 'var(--green-bg)';
  return pickLocs.map(name => '<span style="display:inline-flex;align-items:center;font-family:\'DM Mono\',monospace;font-size:10px;background:' + bg + ';color:' + color + ';border-radius:2px;padding:1px 6px;margin:1px 2px 1px 0;white-space:nowrap;">' + whEsc(name) + (isFallback ? '<span style="font-size:8px;opacity:0.5;margin-left:3px">(last used)</span>' : '') + '</span>').join('');
}

function whRenderTable() {
  const start = (WHState.currentPage - 1) * WHState.pageSize;
  const page  = WHState.filtered.slice(start, start + WHState.pageSize);
  const tbody = document.getElementById('wh-table-body');
  if (!tbody) return;
  if (!page.length) { tbody.innerHTML = '<tr><td colspan="12" class="empty-cell">No items match the current filter.</td></tr>'; return; }
  tbody.innerHTML = page.map(r => {
    const badge = r.priority === 'urgent' ? '<span class="pill pill-out">Urgent</span>'
      : r.priority === 'replenish' ? '<span class="pill pill-low">Repl.</span>'
      : '<span class="pill pill-ok">OK</span>';
    const suggest = r.suggest > 0
      ? '<span style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:700;color:var(--accent)">' + r.suggest + '</span>'
      : '<span style="color:var(--text-dim)">—</span>';
    const freeStyle = (r.freePickQty === 0 && r.orderCount > 0) ? 'color:var(--red);font-weight:700;' : '';
    return '<tr>'
      + '<td style="font-weight:600;font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;">' + whEsc(r.name) + '</td>'
      + '<td style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text-muted);">' + whEsc(r.sku) + '</td>'
      + '<td class="num">' + r.allocated + '</td>'
      + '<td class="num">' + r.pickQty + '</td>'
      + '<td class="num" style="' + freeStyle + '">' + r.freePickQty + '</td>'
      + '<td class="num" style="color:var(--text-muted)">' + r.bulkQty.toLocaleString() + '</td>'
      + '<td style="max-width:200px;">' + whRenderBulkLocs(r.bulkLocs, r.suggest) + '</td>'
      + '<td style="max-width:200px;">' + whRenderPickBins(r.pickLocs, r.pickLocsFallback) + '</td>'
      + '<td class="num" style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text-muted);">' + r.velocity.toFixed(2) + '</td>'
      + '<td class="num">' + r.orderCount + '</td>'
      + '<td class="num">' + suggest + '</td>'
      + '<td>' + badge + '</td>'
      + '</tr>';
  }).join('');
}

function whRenderPagination() {
  const total = Math.ceil(WHState.filtered.length / WHState.pageSize);
  const pg = document.getElementById('wh-pagination');
  if (!pg) return;
  if (total <= 1) { pg.innerHTML = ''; return; }
  let html = '<span style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text-muted);">' + WHState.filtered.length + ' items</span> ';
  if (WHState.currentPage > 1) html += '<button class="btn-secondary btn-sm" onclick="whGoPage(' + (WHState.currentPage-1) + ')">‹</button> ';
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - WHState.currentPage) <= 2) {
      const active = i === WHState.currentPage ? 'background:var(--accent);color:#fff;border-color:var(--accent);' : '';
      html += '<button class="btn-secondary btn-sm" style="' + active + '" onclick="whGoPage(' + i + ')">' + i + '</button> ';
    } else if (Math.abs(i - WHState.currentPage) === 3) html += '<span style="color:var(--text-dim)">… </span>';
  }
  if (WHState.currentPage < total) html += '<button class="btn-secondary btn-sm" onclick="whGoPage(' + (WHState.currentPage+1) + ')">›</button>';
  pg.innerHTML = html;
}

window.whGoPage = function(n) { WHState.currentPage = n; whRenderTable(); whRenderPagination(); };

// ── CONTROLS ─────────────────────────────────────────────────
window.whSortBy = function(key) {
  if (WHState.sortKey === key) WHState.sortDir *= -1;
  else { WHState.sortKey = key; WHState.sortDir = -1; }
  document.querySelectorAll('#wh-table-head th').forEach(th => th.classList.remove('sort-asc','sort-desc'));
  const th = document.querySelector('#wh-table-head th[data-col="' + key + '"]');
  if (th) th.classList.add(WHState.sortDir === -1 ? 'sort-desc' : 'sort-asc');
  whApplyFilters();
};

window.whSetFilter = function(f, el) {
  WHState.activeFilter = f;
  document.querySelectorAll('.wh-filter-btn').forEach(b => b.classList.remove('active'));
  if (el) el.classList.add('active');
  WHState.currentPage = 1;
  whApplyFilters();
};

window.whToggleWalkOrder = function() {
  WHState.walkOrderMode = !WHState.walkOrderMode;
  const btn = document.getElementById('wh-walk-btn');
  if (WHState.walkOrderMode) {
    if (btn) { btn.style.background='var(--accent)';btn.style.color='#fff';btn.textContent='✓ Walk Order ON'; }
    WHState.activeFilter = 'replenish-and-urgent';
  } else {
    if (btn) { btn.style.background='';btn.style.color='';btn.textContent='⟳ Walk Order'; }
    if (WHState.activeFilter === 'replenish-and-urgent') WHState.activeFilter = 'all';
  }
  WHState.currentPage = 1;
  whApplyFilters();
};

window.whExportCSV = function() {
  const c = whCfg();
  const header = ['Product Name','SKU','On Hand','Allocated','Pick Qty','Free Pick','Bulk Qty','Bulk Locs','Avg/Day','Orders','Move Qty','Priority'];
  const rows = WHState.allRows.map(r => [
    '"'+r.name.replace(/"/g,'""')+'"', r.sku, r.onHand, r.allocated, r.pickQty, r.freePickQty, r.bulkQty,
    '"'+(r.bulkLocs||[]).map(l=>l.name+'('+l.qty+')').join(' | ')+'"',
    r.velocity.toFixed(3), r.orderCount, r.suggest, r.priority
  ].join(','));
  const meta = '# FP WH Replenishment Report\n# Generated: '+new Date().toLocaleString()+'\n# Lookback: '+c.lookback+'d | Target: '+c.daysSupply+'d | Outlier: '+c.outlier+' | Cap: '+c.maxUnits+'\n\n';
  const blob = new Blob([meta+header.join(',')+'\n'+rows.join('\n')],{type:'text/csv'});
  const a = document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='fp-wh-replenishment-'+new Date().toISOString().slice(0,10)+'.csv'; a.click(); URL.revokeObjectURL(a.href);
};

// ── WAREHOUSE WALKTHROUGH ─────────────────────────────────────
const WT_SECTIONS = [
  {id:'P1',label:'P1',sub:'Vinyl & CD — Pick Aisle',type:'standard'},
  {id:'P2',label:'P2',sub:'Vinyl & CD — Pick Aisle',type:'standard'},
  {id:'P3',label:'P3',sub:'Apparel',                type:'p3'},
  {id:'P4',label:'P4',sub:'Books',                  type:'p4'},
  {id:'P5',label:'P5',sub:'7" Records',             type:'standard'},
];

function wtBuildLocMap() {
  const locMap = {};
  for (const row of WHState.allRows) {
    for (const loc of (row.pickLocsFallback ? [] : row.pickLocs)) locMap[loc] = {sku:row.sku,name:row.name,row,state:row.priority,isFallback:false};
    for (const loc of (row.pickLocsFallback ? row.pickLocs : [])) { if (!locMap[loc]) locMap[loc]={sku:row.sku,name:row.name,row,state:'vacated',isFallback:true}; }
  }
  if (window._whDebug?.pickQtyBySku) {
    for (const [sku,data] of Object.entries(window._whDebug.pickQtyBySku)) {
      for (const loc of (data.emptyPickLocs||[])) { if (!locMap[loc]) locMap[loc]={sku,name:'',row:null,state:'vacated',isFallback:true}; }
      for (const loc of (data.pickLocs||[]))      { if (!locMap[loc]) locMap[loc]={sku,name:'',row:null,state:'ok',isFallback:false}; }
    }
  }
  return locMap;
}

function wtParseBin(name) {
  let m = name.match(/^(P\d+)-([A-Z]+)-(\d+)-([A-D])$/i);
  if (m) return {section:m[1].toUpperCase(),col:m[2].toUpperCase(),level:parseInt(m[3]),sub:m[4].toUpperCase()};
  m = name.match(/^(P4)-(\d+)$/i);
  if (m) return {section:'P4',col:'',level:parseInt(m[2]),sub:null};
  m = name.match(/^(P\d+)-([A-Z]+)-(\d+)$/i);
  if (m) return {section:m[1].toUpperCase(),col:m[2].toUpperCase(),level:parseInt(m[3]),sub:null};
  return null;
}

function wtColKey(col) {
  if (!col) return 0;
  return col.length===1 ? col.charCodeAt(0)-64 : 26+(col.charCodeAt(0)-64)*26+(col.charCodeAt(1)-64);
}

function wtRender() {
  const empty   = document.getElementById('wt-empty');
  const content = document.getElementById('wt-content');
  if (!WHState.allRows.length) {
    if (empty)   empty.style.display = 'block';
    if (content) content.style.display = 'none';
    return;
  }
  if (empty)   empty.style.display = 'none';
  if (content) content.style.display = 'block';

  const locMap = wtBuildLocMap();
  const sectionBins = {};
  for (const [locName,data] of Object.entries(locMap)) {
    const parsed = wtParseBin(locName);
    if (!parsed) continue;
    if (!sectionBins[parsed.section]) sectionBins[parsed.section] = [];
    sectionBins[parsed.section].push({locName,parsed,...data});
  }
  const container = document.getElementById('wt-sections');
  if (!container) return;
  container.innerHTML = '';
  for (const def of WT_SECTIONS) container.appendChild(wtRenderSection(def, sectionBins[def.id]||[]));
}

function wtRenderSection(def, bins) {
  const el = document.createElement('div');
  el.style.marginBottom = '32px';
  const urgent=bins.filter(b=>b.state==='urgent').length;
  const replen=bins.filter(b=>b.state==='replenish').length;
  const vacat=bins.filter(b=>b.state==='vacated').length;
  let stats = '';
  if (urgent) stats += '<span style="color:var(--red)">● '+urgent+' urgent</span> ';
  if (replen) stats += '<span style="color:var(--yellow)">● '+replen+' replenish</span> ';
  if (vacat)  stats += '<span style="color:rgba(184,50,40,0.4)">● '+vacat+' vacated</span>';
  el.innerHTML = '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px;">'
    +def.label+'<span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">'+def.sub+'</span>'
    +'<div style="margin-left:auto;font-size:10px;font-weight:400;display:flex;gap:10px;">'+stats+'</div></div>'
    +'<div id="wt-shelf-'+def.id+'" style="display:flex;gap:4px;align-items:flex-start;overflow-x:auto;padding-bottom:8px;"></div>';
  const shelf = el.querySelector('#wt-shelf-'+def.id);
  if (def.type==='p4') wtRenderP4(shelf,bins);
  else if (def.type==='p3') wtRenderP3(shelf,bins);
  else wtRenderStandard(shelf,bins,def.id);
  return el;
}

function wtRenderStandard(shelf, bins, sid) {
  const cols = [...new Set(bins.map(b=>b.parsed.col))].sort((a,b)=>wtColKey(a)-wtColKey(b));
  const maxLvl = Math.max(...bins.map(b=>b.parsed.level),6);
  const lu = {}; for (const b of bins) lu[b.parsed.col+'-'+b.parsed.level]=b;
  for (const col of cols) {
    const up = document.createElement('div');
    up.style.cssText='display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
    up.innerHTML='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--text-dim);text-align:center;margin-bottom:3px;">'+col+'</div>';
    for (let l=1;l<=maxLvl;l++) up.appendChild(wtMakeBin(sid+'-'+col+'-'+String(l).padStart(2,'0'),lu[col+'-'+l],false));
    shelf.appendChild(up);
  }
}

function wtRenderP3(shelf, bins) {
  const cols = [...new Set(bins.map(b=>b.parsed.col))].sort((a,b)=>wtColKey(a)-wtColKey(b));
  const maxLvl = Math.max(...bins.map(b=>b.parsed.level),7);
  const lu={}; for (const b of bins) lu[b.parsed.col+'-'+b.parsed.level+'-'+(b.parsed.sub||'A')]=b;
  for (const col of cols) {
    const up = document.createElement('div');
    up.style.cssText='display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
    up.innerHTML='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--text-dim);text-align:center;margin-bottom:3px;">'+col+'</div>';
    for (let l=1;l<=maxLvl;l++) {
      const row=document.createElement('div'); row.style.cssText='display:flex;gap:2px;';
      for (const s of ['A','B','C','D']) {
        const b=lu[col+'-'+l+'-'+s];
        if (!b && !WHState.wtShowEmpty) continue;
        row.appendChild(wtMakeBin('P3-'+col+'-'+String(l).padStart(2,'0')+'-'+s,b,true));
      }
      if (row.children.length) up.appendChild(row);
    }
    shelf.appendChild(up);
  }
}

function wtRenderP4(shelf, bins) {
  const up=document.createElement('div');
  up.style.cssText='display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
  up.innerHTML='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--text-dim);text-align:center;margin-bottom:3px;">P4</div>';
  const maxLvl=Math.max(...bins.map(b=>b.parsed.level),6);
  const lu={}; for (const b of bins) lu[b.parsed.level]=b;
  for (let l=1;l<=maxLvl;l++) up.appendChild(wtMakeBin('P4-'+String(l).padStart(2,'0'),lu[l],false));
  shelf.appendChild(up);
}

function wtMakeBin(locName, binData, isSub) {
  const el=document.createElement('div');
  const state=binData?binData.state:'empty';
  const S={
    urgent:   'background:rgba(184,50,40,0.12);border:1px solid var(--red);color:var(--red);',
    replenish:'background:var(--yellow-bg);border:1px solid var(--yellow);color:var(--yellow);',
    ok:       'background:var(--green-bg);border:1px solid rgba(30,126,74,0.35);color:var(--green);',
    vacated:  'background:transparent;border:1px dashed rgba(184,50,40,0.3);color:rgba(184,50,40,0.35);',
    empty:    'background:var(--surface2);border:1px solid var(--border);color:var(--border2);cursor:default;',
  };
  const w=isSub?'20px':'44px';
  el.style.cssText='width:'+w+';min-height:34px;border-radius:3px;display:flex;align-items:center;justify-content:center;font-family:\'DM Mono\',monospace;font-size:8px;font-weight:600;flex-shrink:0;text-align:center;padding:2px;transition:transform 0.1s,box-shadow 0.1s;'+(S[state]||S.empty);
  if (!WHState.wtShowEmpty && state==='empty'){el.style.display='none';return el;}
  if (binData && binData.row && state!=='empty') {
    el.style.cursor='pointer';
    el.addEventListener('mouseenter', e=>{el.style.transform='scale(1.15)';el.style.zIndex='20';el.style.boxShadow='0 4px 12px rgba(0,0,0,0.15)';wtShowPop(e,locName,binData);});
    el.addEventListener('mouseleave', ()=>{el.style.transform='';el.style.zIndex='';el.style.boxShadow='';wtHidePop();});
    el.addEventListener('mousemove', wtMovePop);
  }
  return el;
}

function wtShowPop(e,locName,binData) {
  const pop=document.getElementById('wt-pop');
  const row=binData.row;
  if (!pop||!row) return;
  const sc=row.priority==='urgent'?'color:var(--red)':row.priority==='replenish'?'color:var(--yellow)':'color:var(--green)';
  const pullFrom=(row.bulkLocs||[]).slice(0,2).map(l=>l.name).join(', ')||'—';
  pop.innerHTML='<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--text-muted);margin-bottom:3px;">'+whEsc(locName)+(binData.isFallback?' <span style="color:var(--yellow)">(last used)</span>':'')+' </div>'
    +'<div style="font-size:12px;font-weight:700;margin-bottom:2px;line-height:1.3;">'+whEsc(row.name)+'</div>'
    +'<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text-muted);margin-bottom:8px;">'+whEsc(row.sku)+'</div>'
    +'<hr style="border:none;border-top:1px solid var(--border);margin:6px 0;">'
    +'<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span style="color:var(--text-muted)">Pick qty</span><span style="font-family:\'DM Mono\',monospace">'+row.pickQty+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span style="color:var(--text-muted)">Free pick</span><span style="font-family:\'DM Mono\',monospace;font-weight:700;'+sc+'">'+row.freePickQty+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span style="color:var(--text-muted)">Allocated</span><span style="font-family:\'DM Mono\',monospace">'+row.customerAllocated+'</span></div>'
    +'<div style="display:flex;justify-content:space-between;font-size:11px;"><span style="color:var(--text-muted)">Velocity</span><span style="font-family:\'DM Mono\',monospace">'+row.velocity.toFixed(2)+'/day</span></div>'
    +(row.suggest>0?'<hr style="border:none;border-top:1px solid var(--border);margin:6px 0;"><div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:3px;"><span style="color:var(--text-muted)">Move qty</span><span style="font-family:\'DM Mono\',monospace;font-weight:700;'+sc+'">'+row.suggest+'</span></div><div style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--accent);margin-top:2px;">↓ Pull from: '+whEsc(pullFrom)+'</div>':'');
  pop.style.display='block';
  wtMovePop(e);
}

function wtMovePop(e) {
  const pop=document.getElementById('wt-pop');
  if (!pop||pop.style.display==='none') return;
  const pw=pop.offsetWidth||260, ph=pop.offsetHeight||180;
  let x=e.clientX+14, y=e.clientY+14;
  if (x+pw>window.innerWidth-10)  x=e.clientX-pw-14;
  if (y+ph>window.innerHeight-10) y=e.clientY-ph-14;
  pop.style.left=x+'px'; pop.style.top=y+'px';
}

function wtHidePop() { const pop=document.getElementById('wt-pop'); if (pop) pop.style.display='none'; }

window.wtToggleEmpty = function() {
  WHState.wtShowEmpty = !WHState.wtShowEmpty;
  const btn=document.getElementById('wt-toggle-empty');
  if (btn) {
    btn.style.background = WHState.wtShowEmpty ? 'var(--accent)' : 'var(--surface2)';
    btn.style.color      = WHState.wtShowEmpty ? '#fff' : 'var(--text-muted)';
    btn.textContent      = WHState.wtShowEmpty ? 'Hide unused bins' : 'Show unused bins';
  }
  wtRender();
};

// ─── DASHBOARD CARD + GRID REORDER ───────────────────────────
// Injects Walk Replenish card and reorders the dashboard grid:
//   Desktop Row 1: Total Products · Global Stock · Reorder Alerts
//   Desktop Row 2: Walk Replenish · Mfg Predictions · Production Runs · Stockout Clock
//   Mobile: Walk Replenish first
(function() {

  function buildWHCard() {
    const urgent  = WHState.allRows.filter(r => r.priority === 'urgent').length;
    const replen  = WHState.allRows.filter(r => r.priority === 'replenish').length;
    const total   = urgent + replen;
    const hasData = WHState.allRows.length > 0;
    const card = document.createElement('div');
    card.id = 'wh-dash-card';
    card.className = 'dash-card' + (urgent > 0 ? ' dash-card-red' : replen > 0 ? ' dash-card-yellow' : '');
    card.style.cursor = 'pointer';
    card.innerHTML =
      '<div class="dash-label">Walk Replenish</div>'
      + '<div class="dash-num" style="font-size:28px;color:var(--accent);">' + (hasData ? total : '—') + '</div>'
      + '<div class="dash-sub">' + (hasData
          ? (urgent > 0 ? urgent + ' urgent · ' : '') + replen + ' need stock'
          : 'Click to generate') + '</div>'
      + '<div style="margin-top:12px;">'
      + '<button onclick="event.stopPropagation();startReplenishRun()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:12px;font-weight:700;cursor:pointer;width:100%;">'
      + '&#9654; ' + (hasData ? 'Start Replenish Run' : 'Generate &amp; Start')
      + '</button></div>';
    card.addEventListener('click', () => startReplenishRun());
    return card;
  }

  function reorderDashGrid() {
    const body = document.getElementById('dashboard-body');
    if (!body) return;
    const grid = body.querySelector('.dash-grid');
    if (!grid) return;

    // Remove stale WH card
    document.getElementById('wh-dash-card')?.remove();

    // Identify cards by label
    const allCards = [...grid.querySelectorAll('.dash-card')];
    function find(kw) {
      return allCards.find(c => {
        const lbl = c.querySelector('.dash-label');
        return lbl && lbl.textContent.toLowerCase().includes(kw.toLowerCase());
      });
    }

    const cTotal    = find('Total Products');
    const cGlobal   = find('Global Stock');
    const cAlerts   = find('Reorder Alerts');
    const cResolved = find('Resolved');
    const cMfg      = find('Mfg Predictions');
    const cRuns     = find('Production Runs');
    const cClock    = find('Stockout');
    // Inbound is a span-4 card — find it separately
    const cInbound  = [...body.querySelectorAll('.dash-card')].find(c => {
      const lbl = c.querySelector('.dash-label');
      return lbl && lbl.textContent.toLowerCase().includes('inbound');
    });

    // Hide Resolved — frees up the slot
    if (cResolved) cResolved.style.display = 'none';

    const cWH = buildWHCard();

    // Rebuild grid with two explicit row sub-grids
    // Remove existing row wrappers to avoid stacking
    ['dash-row-1','dash-row-2'].forEach(id => document.getElementById(id)?.remove());

    const r1 = document.createElement('div');
    r1.id = 'dash-row-1';
    r1.style.cssText = 'display:grid;grid-template-columns:repeat(3,1fr);gap:16px;grid-column:1/-1;';

    const r2 = document.createElement('div');
    r2.id = 'dash-row-2';
    r2.style.cssText = 'display:grid;grid-template-columns:repeat(4,1fr);gap:16px;grid-column:1/-1;';

    [cTotal, cGlobal, cAlerts].filter(Boolean).forEach(c => r1.appendChild(c));
    [cWH, cMfg, cRuns, cClock].filter(Boolean).forEach(c => r2.appendChild(c));

    // Clear grid content, insert rows then Inbound
    grid.innerHTML = '';
    grid.appendChild(r1);
    grid.appendChild(r2);
    if (cInbound) {
      cInbound.style.gridColumn = '1/-1';
      grid.appendChild(cInbound);
    }

    // Mobile: WH card first in its row (CSS order)
    cWH.classList.add('wh-replenish-card');
  }

  function watchDashboard() {
    const body = document.getElementById('dashboard-body');
    if (!body) { setTimeout(watchDashboard, 500); return; }
    new MutationObserver(() => {
      const view = document.getElementById('view-dashboard');
      if (view && (view.classList.contains('active') || !view.classList.contains('hidden'))) {
        clearTimeout(window._whDashTimer);
        window._whDashTimer = setTimeout(reorderDashGrid, 80);
      }
    }).observe(body, { childList: true, subtree: false });
  }

  document.addEventListener('DOMContentLoaded', watchDashboard);
})();

// ═══════════════════════════════════════════════════════════════
// PICKER MODE
// ═══════════════════════════════════════════════════════════════

const PickerState = {
  queue:       [],   // walk-order sorted rows with bulkLoc resolved
  index:       0,    // current pick
  completed:   [],   // { row, bulkLoc, qty, skipped }
  startedAt:   null,
};

// Build the pick queue from current filtered+walk-order rows
function pickerBuildQueue() {
  // Use replenish+urgent only, sorted by walk order
  const rows = WHState.allRows
    .filter(r => r.priority === 'urgent' || r.priority === 'replenish')
    .filter(r => r.suggest > 0 && r.bulkLocs && r.bulkLocs.length > 0);

  // Sort by first bulk location walk order
  rows.sort((a, b) => {
    const ka = whWalkSortKey(a), kb = whWalkSortKey(b);
    for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
    return 0;
  });

  // Flatten — each row gets its primary bulk loc
  return rows.map(r => {
    const sorted = [...r.bulkLocs].sort((a, b) => {
      const aN = whIsNowLoc(a.name), bN = whIsNowLoc(b.name);
      if (aN !== bN) return aN ? 1 : -1;
      const ka = whLocSortKey(a.name), kb = whLocSortKey(b.name);
      for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
      return 0;
    });
    return {
      row:      r,
      bulkLoc:  sorted[0].name,
      bulkQty:  sorted[0].qty,
      qty:      r.suggest,
      destBins: r.pickLocs,
    };
  });
}

window.startPickerMode = window.startReplenishRun = async function() {
  // If no data yet, run the report first then launch
  if (!WHState.allRows.length) {
    await whRunAndLaunch();
    return;
  }
  pickerLaunch();
};

async function whRunAndLaunch() {
  // Show the replenishment view with a status overlay
  switchView('replenishment');
  // Open WH nav if closed
  const sub = document.getElementById('wh-nav-sub');
  if (sub) sub.style.display = 'block';
  const arrow = document.getElementById('wh-nav-arrow');
  if (arrow) arrow.textContent = '▾';

  // Show generating banner
  const banner = document.getElementById('wh-dash-generating');
  if (banner) banner.style.display = 'flex';

  try {
    await runReplenishment();
  } catch(e) {
    if (banner) banner.style.display = 'none';
    return;
  }
  if (banner) banner.style.display = 'none';
  pickerLaunch();
}

function pickerLaunch() {
  PickerState.queue      = pickerBuildQueue();
  PickerState.index      = 0;
  PickerState.completed  = [];
  PickerState.startedAt  = new Date();
  if (!PickerState.queue.length) { alert('No items need replenishment right now.'); return; }
  pickerOpen();
}

function pickerOpen() {
  document.getElementById('picker-overlay').style.display = 'flex';
  document.body.style.overflow = 'hidden';
  pickerRender();
}

window.pickerClose = function() {
  document.getElementById('picker-overlay').style.display = 'none';
  document.body.style.overflow = '';
};

function pickerRender() {
  const overlay = document.getElementById('picker-overlay');
  if (!overlay) return;

  // Completion screen
  if (PickerState.index >= PickerState.queue.length) {
    pickerRenderComplete();
    return;
  }

  const total   = PickerState.queue.length;
  const current = PickerState.index + 1;
  const item    = PickerState.queue[PickerState.index];
  const pct     = Math.round(((current - 1) / total) * 100);
  const destStr = item.destBins && item.destBins.length
    ? item.destBins.join('  ·  ')
    : '— no bin assigned —';
  const isDark = document.body.classList.contains('dark-mode');

  overlay.innerHTML = `
    <div id="picker-card" style="
      width:100%;max-width:680px;
      background:var(--surface);
      border-radius:12px;
      box-shadow:0 24px 64px rgba(0,0,0,0.18);
      display:flex;flex-direction:column;
      overflow:hidden;
    ">

      <!-- Header bar -->
      <div style="background:var(--accent);color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;">
        <div style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:0.9;">FP Warehouse Replenish</div>
        <div style="display:flex;align-items:center;gap:16px;">
          <span style="font-size:14px;font-weight:700;">${current} <span style="opacity:0.6;font-weight:400;">of</span> ${total}</span>
          <button onclick="pickerClose()" style="background:rgba(255,255,255,0.2);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;letter-spacing:0.5px;">✕ Exit</button>
        </div>
      </div>

      <!-- Progress bar -->
      <div style="height:6px;background:rgba(0,0,0,0.08);">
        <div style="height:100%;width:${pct}%;background:var(--accent);opacity:0.4;transition:width 0.3s;"></div>
      </div>

      <!-- Main pick card -->
      <div style="padding:32px 32px 24px;flex:1;">

        <!-- PULL FROM -->
        <div style="margin-bottom:28px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:8px;">Pull From</div>
          <div style="display:flex;align-items:center;gap:20px;">
            <div style="font-family:'DM Mono',monospace;font-size:52px;font-weight:700;color:var(--accent);letter-spacing:2px;line-height:1;">${whEsc(item.bulkLoc)}</div>
            <div style="font-size:13px;color:var(--text-muted);line-height:1.5;">
              <div>${item.bulkQty.toLocaleString()} units in location</div>
            </div>
          </div>
        </div>

        <!-- QUANTITY -->
        <div style="display:flex;align-items:center;gap:32px;margin-bottom:28px;padding:20px 24px;background:var(--surface2);border-radius:8px;border:2px solid var(--border);">
          <div>
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:4px;">Pick Quantity</div>
            <div style="font-family:'DM Mono',monospace;font-size:64px;font-weight:700;color:var(--text);line-height:1;">${item.qty}</div>
          </div>
          <div style="flex:1;">
            <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:4px;">Product</div>
            <div style="font-size:16px;font-weight:600;color:var(--text);margin-bottom:4px;line-height:1.3;">${whEsc(item.row.name)}</div>
            <div style="font-family:'DM Mono',monospace;font-size:13px;color:var(--text-muted);">${whEsc(item.row.sku)}</div>
          </div>
        </div>

        <!-- PLACE INTO -->
        <div style="margin-bottom:28px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:8px;">Place Into Pick Bin</div>
          <div style="font-family:'DM Mono',monospace;font-size:28px;font-weight:700;color:var(--green);letter-spacing:1px;">${whEsc(destStr)}</div>
        </div>

        <!-- Scan input -->
        <div style="margin-bottom:20px;">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:8px;">Scan Location Barcode to Confirm</div>
          <div style="display:flex;gap:10px;align-items:center;">
            <input
              type="text"
              id="picker-scan-input"
              placeholder="Scan or type location barcode…"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="off"
              spellcheck="false"
              style="flex:1;font-family:'DM Mono',monospace;font-size:18px;padding:14px 16px;border:2px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);outline:none;"
              onkeydown="pickerHandleKey(event)"
              oninput="pickerClearError()"
            />
            <button onclick="pickerConfirm()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:14px 24px;font-size:15px;font-weight:700;cursor:pointer;white-space:nowrap;letter-spacing:0.5px;">Confirm ↵</button>
          </div>
          <div id="picker-scan-error" style="color:var(--red);font-size:13px;font-weight:600;margin-top:8px;min-height:20px;"></div>
        </div>

      </div>

      <!-- Footer actions -->
      <div style="padding:16px 32px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:space-between;align-items:center;background:var(--surface2);">
        <button onclick="pickerSkip()" style="background:none;border:1px solid var(--border2);color:var(--text-muted);border-radius:6px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">Skip This Item</button>
        <div style="font-size:11px;color:var(--text-dim);font-family:'DM Mono',monospace;">${PickerState.completed.length} picked · ${PickerState.queue.length - current} remaining</div>
        ${current > 1 ? '<button onclick="pickerBack()" style="background:none;border:1px solid var(--border2);color:var(--text-muted);border-radius:6px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">← Back</button>' : '<div></div>'}
      </div>
    </div>
  `;

  // Auto-focus the scan input
  setTimeout(() => {
    const inp = document.getElementById('picker-scan-input');
    if (inp) inp.focus();
  }, 80);
}

window.pickerHandleKey = function(e) {
  if (e.key === 'Enter') pickerConfirm();
};

window.pickerClearError = function() {
  const el = document.getElementById('picker-scan-error');
  if (el) el.textContent = '';
  const inp = document.getElementById('picker-scan-input');
  if (inp) inp.style.borderColor = 'var(--border2)';
};

window.pickerConfirm = function() {
  const inp = document.getElementById('picker-scan-input');
  const val = (inp ? inp.value.trim() : '').toUpperCase();
  const item = PickerState.queue[PickerState.index];
  const expected = item.bulkLoc.toUpperCase();

  // Validate scan — accept if empty (manual confirm) or matches location
  if (val && val !== expected) {
    // Show error — wrong location scanned
    const errEl = document.getElementById('picker-scan-error');
    if (errEl) errEl.textContent = '✕ Wrong location — expected ' + item.bulkLoc + ', got "' + val + '"';
    if (inp) { inp.style.borderColor = 'var(--red)'; inp.select(); }
    return;
  }

  PickerState.completed.push({ row: item.row, bulkLoc: item.bulkLoc, qty: item.qty, destBins: item.destBins, skipped: false });
  PickerState.index++;
  pickerRender();
};

window.pickerSkip = function() {
  const item = PickerState.queue[PickerState.index];
  PickerState.completed.push({ row: item.row, bulkLoc: item.bulkLoc, qty: item.qty, destBins: item.destBins, skipped: true });
  PickerState.index++;
  pickerRender();
};

window.pickerBack = function() {
  if (PickerState.index === 0) return;
  PickerState.index--;
  PickerState.completed.pop();
  pickerRender();
};

function pickerRenderComplete() {
  const overlay = document.getElementById('picker-overlay');
  if (!overlay) return;

  const picked  = PickerState.completed.filter(c => !c.skipped);
  const skipped = PickerState.completed.filter(c => c.skipped);
  const totalUnits = picked.reduce((s, c) => s + c.qty, 0);
  const elapsed = PickerState.startedAt
    ? Math.round((Date.now() - PickerState.startedAt.getTime()) / 60000)
    : null;

  const rows = PickerState.completed.map(c => {
    const dest = c.destBins && c.destBins.length ? c.destBins.join(', ') : '—';
    return `<tr style="${c.skipped ? 'opacity:0.45;' : ''}">
      <td style="font-family:'DM Mono',monospace;font-size:15px;font-weight:700;color:${c.skipped ? 'var(--text-muted)' : 'var(--accent)'};padding:12px 16px;border-bottom:1px solid var(--border);white-space:nowrap;">${whEsc(c.bulkLoc)}</td>
      <td style="padding:12px 16px;border-bottom:1px solid var(--border);">
        <div style="font-weight:600;font-size:14px;">${whEsc(c.row.name)}</div>
        <div style="font-family:'DM Mono',monospace;font-size:11px;color:var(--text-muted);">${whEsc(c.row.sku)}</div>
      </td>
      <td style="font-family:'DM Mono',monospace;font-size:22px;font-weight:700;text-align:center;padding:12px 16px;border-bottom:1px solid var(--border);color:${c.skipped ? 'var(--text-dim)' : 'var(--text)'};">${c.skipped ? '—' : c.qty}</td>
      <td style="font-family:'DM Mono',monospace;font-size:13px;color:var(--green);padding:12px 16px;border-bottom:1px solid var(--border);">${whEsc(dest)}</td>
      <td style="padding:12px 16px;border-bottom:1px solid var(--border);text-align:center;">${c.skipped ? '<span style="color:var(--yellow);font-size:11px;font-weight:700;text-transform:uppercase;">Skipped</span>' : '<span style="color:var(--green);font-size:16px;">✓</span>'}</td>
    </tr>`;
  }).join('');

  overlay.innerHTML = `
    <div style="width:100%;max-width:800px;background:var(--surface);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,0.18);display:flex;flex-direction:column;max-height:92vh;overflow:hidden;">

      <!-- Success header -->
      <div style="background:var(--green);color:#fff;padding:24px 32px;text-align:center;">
        <div style="font-size:40px;margin-bottom:8px;">✓</div>
        <div style="font-size:20px;font-weight:700;margin-bottom:4px;">Replenish Run Complete</div>
        <div style="font-size:13px;opacity:0.85;">${picked.length} locations replenished · ${totalUnits.toLocaleString()} units · ${skipped.length} skipped${elapsed !== null ? ' · ' + elapsed + ' min' : ''}</div>
      </div>

      <!-- Summary note -->
      <div style="padding:16px 32px;background:var(--surface2);border-bottom:1px solid var(--border);font-size:13px;color:var(--text-muted);">
        Proceed to transfer stock to pick bins below. Stock movements can be completed in Packiyo once items are placed.
      </div>

      <!-- Summary table -->
      <div style="overflow-y:auto;flex:1;">
        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:var(--surface2);">
              <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:2px solid var(--border);">Pull From</th>
              <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:2px solid var(--border);">Product</th>
              <th style="padding:10px 16px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:2px solid var(--border);">Qty</th>
              <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:2px solid var(--border);">Place Into</th>
              <th style="padding:10px 16px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:2px solid var(--border);">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <!-- Footer -->
      <div style="padding:16px 32px;border-top:1px solid var(--border);display:flex;gap:12px;justify-content:flex-end;background:var(--surface2);">
        <button onclick="pickerPrintSummary()" style="background:var(--surface);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">⎙ Print Summary</button>
        <button onclick="pickerClose()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:10px 24px;font-size:13px;font-weight:700;cursor:pointer;">Done</button>
      </div>
    </div>
  `;
}

window.pickerPrintSummary = function() {
  const picked  = PickerState.completed.filter(c => !c.skipped);
  const skipped = PickerState.completed.filter(c => c.skipped);
  const totalUnits = picked.reduce((s,c) => s + c.qty, 0);
  const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });

  const rows = PickerState.completed.map(c => {
    const dest = c.destBins && c.destBins.length ? c.destBins.join(', ') : '—';
    return `<tr class="${c.skipped ? 'skipped' : ''}">
      <td class="mono loc">${c.bulkLoc}</td>
      <td><strong>${c.row.name}</strong><br><span class="mono small">${c.row.sku}</span></td>
      <td class="mono center qty">${c.skipped ? '—' : c.qty}</td>
      <td class="mono dest">${dest}</td>
      <td class="center">${c.skipped ? 'SKIPPED' : '✓'}</td>
    </tr>`;
  }).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>FP Replenish Summary — ${now}</title>
  <style>
    @page { margin: 0.5in; size: portrait; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'DM Sans', Arial, sans-serif; font-size: 12px; color: #111; }
    .header { margin-bottom: 20px; border-bottom: 2px solid #111; padding-bottom: 12px; }
    .header h1 { font-size: 20px; font-weight: 700; margin-bottom: 4px; }
    .header .meta { font-size: 11px; color: #555; display: flex; gap: 24px; flex-wrap: wrap; margin-top: 6px; }
    .meta span { display: flex; align-items: center; gap: 4px; }
    table { width: 100%; border-collapse: collapse; }
    th { background: #f0f0f0; padding: 8px 10px; text-align: left; font-size: 9px; text-transform: uppercase; letter-spacing: 0.8px; font-weight: 700; color: #444; border-bottom: 1.5px solid #999; }
    th.center { text-align: center; }
    td { padding: 9px 10px; border-bottom: 1px solid #ddd; vertical-align: middle; }
    tr:nth-child(even) td { background: #f8f8f8; }
    td.mono { font-family: 'Courier New', monospace; }
    td.loc  { font-size: 15px; font-weight: 700; color: #b83228; white-space: nowrap; }
    td.dest { font-size: 12px; font-weight: 700; color: #1e7e4a; }
    td.qty  { font-size: 18px; font-weight: 700; text-align: center; }
    td.center { text-align: center; }
    td.small { font-size: 10px; }
    .small { font-size: 10px; color: #777; }
    tr.skipped td { opacity: 0.45; }
    tr.skipped td.loc { color: #888; }
    .totals { margin-top: 16px; padding: 12px 16px; background: #f5f5f5; border: 1px solid #ddd; display: flex; gap: 32px; }
    .totals .t { display: flex; flex-direction: column; }
    .totals .t-val { font-size: 22px; font-weight: 700; font-family: 'Courier New', monospace; }
    .totals .t-lbl { font-size: 9px; text-transform: uppercase; letter-spacing: 1px; color: #777; margin-top: 2px; }
    .footer { margin-top: 20px; font-size: 9px; color: #aaa; text-align: right; }
    @media print {
      .no-print { display: none !important; }
      a { text-decoration: none; color: inherit; }
    }
  </style>
  </head><body>
  <div class="header">
    <h1>Fat Possum Records — Replenish Summary</h1>
    <div class="meta">
      <span>📅 ${now}</span>
      <span>✓ ${picked.length} picked</span>
      <span>📦 ${totalUnits.toLocaleString()} units</span>
      ${skipped.length ? '<span>⚠ ' + skipped.length + ' skipped</span>' : ''}
    </div>
  </div>
  <table>
    <thead><tr>
      <th>Pull From</th>
      <th>Product</th>
      <th class="center">Qty</th>
      <th>Place Into (Pick Bin)</th>
      <th class="center">Status</th>
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="totals">
    <div class="t"><div class="t-val">${picked.length}</div><div class="t-lbl">Locations Picked</div></div>
    <div class="t"><div class="t-val">${totalUnits.toLocaleString()}</div><div class="t-lbl">Total Units Moved</div></div>
    ${skipped.length ? '<div class="t"><div class="t-val">' + skipped.length + '</div><div class="t-lbl">Skipped</div></div>' : ''}
  </div>
  <div class="footer">Fat Possum Records · Warehouse Replenish Sheet · ${now}</div>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
};

// ═══════════════════════════════════════════════════════════════
// PRINT PICK LIST (pre-pick reference sheet)
// ═══════════════════════════════════════════════════════════════
window.whPrintPickList = function() {
  const c = whCfg();
  const rows = WHState.allRows
    .filter(r => (r.priority === 'urgent' || r.priority === 'replenish') && r.suggest > 0 && r.bulkLocs && r.bulkLocs.length)
    .sort((a, b) => {
      const ka = whWalkSortKey(a), kb = whWalkSortKey(b);
      for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
      return 0;
    });

  if (!rows.length) { alert('No items need replenishment.'); return; }

  const now = new Date().toLocaleString('en-US', { month:'short', day:'numeric', year:'numeric', hour:'numeric', minute:'2-digit' });

  const tableRows = rows.map((r, i) => {
    const sorted = [...r.bulkLocs].sort((a, b) => {
      const aN = whIsNowLoc(a.name), bN = whIsNowLoc(b.name);
      if (aN !== bN) return aN ? 1 : -1;
      const ka = whLocSortKey(a.name), kb = whLocSortKey(b.name);
      for (let j = 0; j < ka.length; j++) { if (ka[j] < kb[j]) return -1; if (ka[j] > kb[j]) return 1; }
      return 0;
    });
    const bulkLoc  = sorted[0].name;
    const bulkQty  = sorted[0].qty;
    const destBins = r.pickLocs && r.pickLocs.length ? r.pickLocs.join(', ') : '—';
    const urgCls   = r.priority === 'urgent' ? 'urgent' : '';
    return `<tr class="${urgCls}">
      <td class="num seq">${i+1}</td>
      <td class="check"><span class="box"></span></td>
      <td class="loc mono">${bulkLoc}</td>
      <td class="qty mono">${r.suggest}</td>
      <td class="prod"><strong>${r.name}</strong><br><span class="sku">${r.sku}</span></td>
      <td class="dest mono">${destBins}</td>
      <td class="avail mono">${bulkQty}</td>
    </tr>`;
  }).join('');

  const urgent = rows.filter(r => r.priority === 'urgent').length;
  const totalUnits = rows.reduce((s,r) => s + r.suggest, 0);

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>FP Pick List — ${now}</title>
  <style>
    @page { margin: 0.4in 0.5in; size: landscape; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: Arial, sans-serif; font-size: 11px; color: #111; }
    .header { margin-bottom: 14px; display: flex; align-items: flex-start; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 10px; }
    .header h1 { font-size: 16px; font-weight: 700; }
    .header .sub { font-size: 10px; color: #666; margin-top: 3px; }
    .stats { display: flex; gap: 20px; align-items: flex-end; text-align: right; }
    .stat { display: flex; flex-direction: column; align-items: flex-end; }
    .stat-val { font-size: 20px; font-weight: 700; font-family: 'Courier New', monospace; line-height: 1; }
    .stat-lbl { font-size: 8px; text-transform: uppercase; letter-spacing: 0.8px; color: #888; }
    table { width: 100%; border-collapse: collapse; }
    col.col-seq  { width: 30px; }
    col.col-chk  { width: 24px; }
    col.col-loc  { width: 110px; }
    col.col-qty  { width: 50px; }
    col.col-prod { width: auto; }
    col.col-dest { width: 140px; }
    col.col-avail{ width: 60px; }
    th { background: #111; color: #fff; padding: 7px 8px; text-align: left; font-size: 8.5px; text-transform: uppercase; letter-spacing: 0.8px; }
    th.right { text-align: right; }
    td { padding: 7px 8px; border-bottom: 1px solid #ddd; vertical-align: middle; }
    tr:nth-child(even) td { background: #f6f6f6; }
    tr.urgent td { background: #fff5f5 !important; }
    tr.urgent td.loc { color: #b83228; }
    td.mono { font-family: 'Courier New', monospace; }
    td.loc  { font-size: 14px; font-weight: 700; white-space: nowrap; }
    td.qty  { font-size: 18px; font-weight: 700; text-align: center; color: #b83228; }
    td.dest { font-size: 11px; font-weight: 700; color: #1e7e4a; }
    td.avail{ font-size: 11px; text-align: right; color: #888; }
    td.num  { text-align: right; color: #bbb; font-size: 10px; }
    td.seq  { font-size: 10px; color: #ccc; text-align: center; }
    td.check { text-align: center; }
    .box { display: inline-block; width: 14px; height: 14px; border: 1.5px solid #999; border-radius: 2px; }
    .prod strong { font-size: 11px; }
    .sku { font-family: 'Courier New', monospace; font-size: 9px; color: #888; }
    .footer { margin-top: 12px; font-size: 8px; color: #bbb; display: flex; justify-content: space-between; }
    .legend { display: flex; gap: 16px; font-size: 9px; color: #888; margin-top: 8px; }
    .leg { display: flex; align-items: center; gap: 4px; }
    .leg-dot { width: 10px; height: 10px; border-radius: 2px; }
  </style>
  </head><body>
  <div class="header">
    <div>
      <h1>Fat Possum Records — Warehouse Pick List</h1>
      <div class="sub">${now} · Look-back: ${c.lookback}d · Days supply target: ${c.daysSupply}d · Walk order</div>
      <div class="legend">
        <div class="leg"><div class="leg-dot" style="background:#fff5f5;border:1px solid #b83228;"></div> Urgent (empty pick bin)</div>
        <div class="leg"><div class="leg-dot" style="background:#f6f6f6;border:1px solid #ddd;"></div> Needs replenishment</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat"><div class="stat-val">${rows.length}</div><div class="stat-lbl">Locations</div></div>
      <div class="stat"><div class="stat-val">${totalUnits.toLocaleString()}</div><div class="stat-lbl">Total Units</div></div>
      ${urgent ? '<div class="stat"><div class="stat-val" style="color:#b83228">' + urgent + '</div><div class="stat-lbl">Urgent</div></div>' : ''}
    </div>
  </div>
  <table>
    <colgroup>
      <col class="col-seq"><col class="col-chk"><col class="col-loc">
      <col class="col-qty"><col class="col-prod"><col class="col-dest"><col class="col-avail">
    </colgroup>
    <thead><tr>
      <th class="right">#</th>
      <th>✓</th>
      <th>Pull From</th>
      <th class="right">Move Qty</th>
      <th>Product</th>
      <th>Place Into (Pick Bin)</th>
      <th class="right">In Loc</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="footer">
    <span>Fat Possum Records · Warehouse Replenish Sheet · ${now}</span>
    <span>Picker: _______________________   Time started: ____________   Time complete: ____________</span>
  </div>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
};

function whEsc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
