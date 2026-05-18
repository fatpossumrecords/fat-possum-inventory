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
function whSetStatus(msg) { const el = document.getElementById('wh-status-step'); if (el) el.textContent = msg; }
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
  el.innerHTML = `
    <div class="dash-card"><div class="dash-label">Total SKUs</div><div class="dash-num" style="color:var(--accent)">${WHState.allRows.length}</div></div>
    <div class="dash-card dash-card-red"><div class="dash-label">Urgent (empty pick)</div><div class="dash-num">${urgent}</div></div>
    <div class="dash-card dash-card-yellow"><div class="dash-label">Needs Replenishment</div><div class="dash-num">${needs}</div></div>
    <div class="dash-card dash-card-green"><div class="dash-label">Pick Stock OK</div><div class="dash-num">${ok}</div></div>
    <div class="dash-card"><div class="dash-label">Total Units to Move</div><div class="dash-num" style="color:var(--accent)">${total}</div></div>
  `;
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

function whEsc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
