/* ============================================================
   FAT POSSUM     WH ACTION MODULE
   wh_module.js     Replenishment & Warehouse Walkthrough
   Uses packiyoFetch() from app.js     no separate API config needed
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

// ------ NAV TOGGLE ---------------------------------------------------------------------------------------------------------------------------------------------
window.toggleInvoiceNav = function(e) {
  e.preventDefault();
  const sub   = document.getElementById('inv-main-sub');
  const arrow = document.getElementById('inv-main-arrow');
  if (!sub) return;
  const open = sub.style.display === 'block';
  sub.style.display = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▸' : '▾';
};

window.toggleInventoryNav = function(e) {
  e.preventDefault();
  const sub   = document.getElementById('inv-nav-sub');
  const arrow = document.getElementById('inv-nav-arrow');
  if (!sub) return;
  const open = sub.style.display === 'block';
  sub.style.display = open ? 'none' : 'block';
  if (arrow) arrow.textContent = open ? '▸' : '▾';
};

window.toggleWHNav = function(e) {
  e.preventDefault();
  const sub   = document.getElementById('wh-nav-sub');
  const arrow = document.getElementById('wh-nav-arrow');
  if (!sub) return;
  const open = sub.style.display === 'none' || sub.style.display === '';
  sub.style.display = open ? 'block' : 'none';
  if (arrow) arrow.textContent = open ? '   ' : '   ';
  if (open) switchView('replenishment');
};

// ------ SETTINGS ---------------------------------------------------------------------------------------------------------------------------------------------------
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
    outlier:    parseInt(document.getElementById('wh-outlier')?.value)     || 20,
    maxUnits:   parseInt(document.getElementById('wh-max-units')?.value)   || 50,
    minUnits:   parseInt(document.getElementById('wh-min-units')?.value)   || 5,
  };
}

// ------ TAB SWITCHER ---------------------------------------------------------------------------------------------------------------------------------------
window.switchWHTab = function(tab) {
  // Defer so switchView('replenishment') finishes rendering before tab switch
  setTimeout(() => {
    document.getElementById('wh-tab-replenishment')?.classList.toggle('hidden', tab !== 'replenishment');
    document.getElementById('wh-tab-walkthrough')?.classList.toggle('hidden',   tab !== 'walkthrough');
    document.getElementById('wh-tabbtn-replen')?.classList.toggle('active', tab === 'replenishment');
    document.getElementById('wh-tabbtn-walk')?.classList.toggle('active',   tab === 'walkthrough');
    // Apply replen defaults from settings each time the tab opens
    if (tab === 'replenishment' && window._FPUserSettings && window._FPUserSettings.replen) {
      if (window.applyReplenDefaults) applyReplenDefaults(window._FPUserSettings.replen);
    }
    if (tab === 'walkthrough') wtRender();
  }, 0);
};

// ------ FETCH HELPERS ---------------------------------------------------------------------------------------------------------------------------------------
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

// ------ UI HELPERS ------------------------------------------------------------------------------------------------------------------------------------------------
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

// ------ MAIN REPORT ---------------------------------------------------------------------------------------------------------------------------------------------
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
    whSetStatus('Fetching locations, orders & open orders in parallel   ');
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - c.lookback);
    const dateStr = cutoff.toISOString().split('T')[0];
    const orderEndpoint = '/orders?include=order_items&filter[fulfilled]=true&filter[fulfilled_at_min]=' + dateStr;

    const [locResult, orderResult, openResult] = await Promise.all([
      whFetchAll('/locations?include=location_type', 100, (p,t) => whSetStatus('Locations: page ' + p + ' of ' + t)),
      whFetchAll(orderEndpoint,                      100, (p,t) => whSetStatus('Orders: page '    + p + ' of ' + t)),
      whFetchAll('/orders?include=order_items&filter[fulfilled]=false', 100, (p,t) => whSetStatus('Open orders: page ' + p + ' of ' + t)),
    ]);

    whSetProgress(40, locResult.allData.length + ' locations    ' + orderResult.allData.length + ' fulfilled orders    ' + openResult.allData.length + ' open orders');

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

    whSetProgress(55, 'Building velocity map   ');
    const velocityMap = whBuildVelocityMap(rawOrderItems, c);

    whSetStatus('Fetching products with locations   ');
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

    whSetStatus('Building report   ');
    WHState.allRows = whBuildRows(prodResult.allData, pickQtyBySku, velocityMap, liveCustomerAllocBySku, livePOAllocBySku, c);
    window._whDebug = { pickQtyBySku, allRows: WHState.allRows };

    whSetProgress(100, WHState.allRows.length + ' SKUs    ' + WHState.allRows.filter(r => r.suggest > 0).length + ' need replenishment');
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

// ------ VELOCITY MAP ------------------------------------------------------------------------------------------------------------------------------------------
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

// ------ BUILD ROWS ------------------------------------------------------------------------------------------------------------------------------------------------
function whBuildRows(products, pickQtyBySku, velocityMap, liveCustomerAllocBySku, livePOAllocBySku, c) {
  return products.map(item => {
    const a = item.attributes || item;
    const name = a.name || 'Unknown', sku = a.sku || '', upc = a.barcode || '';
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
    return { name, sku, upc, onHand, allocated, customerAllocated, poAllocated,
      pickQty, freePickQty, bulkQty, bulkLocs, pickLocs: replenishBins, pickLocsFallback,
      velocity, orderCount, suggest: netSuggest, priority };
  }).filter(r => r.onHand > 0 && (r.bulkQty > 0 || r.priority === 'ok'));
}

// ------ RENDER ALL ------------------------------------------------------------------------------------------------------------------------------------------------
function whRenderAll(keepPage) {
  if (!keepPage) WHState.currentPage = 1;
  whShowStatus(false);
  whApplyFilters();
  whRenderStats();
  whShowResults(true);
  const gi = document.getElementById('wh-gen-info');
  if (gi) gi.textContent = 'Generated ' + new Date().toLocaleString() + '    ' + WHState.allRows.length + ' SKUs analysed';
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

// ------ TABLE RENDER ------------------------------------------------------------------------------------------------------------------------------------------
function whRenderBulkLocs(locs, suggest) {
  if (!locs || !locs.length) return '<span style="color:var(--text-dim);font-size:10px;">   </span>';
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
  if (!pickLocs || !pickLocs.length) return '<span style="color:var(--text-dim);font-size:10px;">   </span>';
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
      : '<span style="color:var(--text-dim)">   </span>';
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
  if (WHState.currentPage > 1) html += '<button class="btn-secondary btn-sm" onclick="whGoPage(' + (WHState.currentPage-1) + ')">   </button> ';
  for (let i = 1; i <= total; i++) {
    if (i === 1 || i === total || Math.abs(i - WHState.currentPage) <= 2) {
      const active = i === WHState.currentPage ? 'background:var(--accent);color:#fff;border-color:var(--accent);' : '';
      html += '<button class="btn-secondary btn-sm" style="' + active + '" onclick="whGoPage(' + i + ')">' + i + '</button> ';
    } else if (Math.abs(i - WHState.currentPage) === 3) html += '<span style="color:var(--text-dim)">    </span>';
  }
  if (WHState.currentPage < total) html += '<button class="btn-secondary btn-sm" onclick="whGoPage(' + (WHState.currentPage+1) + ')">   </button>';
  pg.innerHTML = html;
}

window.whGoPage = function(n) { WHState.currentPage = n; whRenderTable(); whRenderPagination(); };

// ------ CONTROLS ---------------------------------------------------------------------------------------------------------------------------------------------------
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
    if (btn) { btn.style.background='var(--accent)';btn.style.color='#fff';btn.textContent='    Walk Order ON'; }
    WHState.activeFilter = 'replenish-and-urgent';
  } else {
    if (btn) { btn.style.background='';btn.style.color='';btn.textContent='    Walk Order'; }
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

// ------ WAREHOUSE WALKTHROUGH ---------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// WAREHOUSE WALKTHROUGH --- rewritten
// Multi-item bins, MW sections, search/dim, click detail panel
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

// P-section definitions (pick bins)
const WT_P_SECTIONS = [
  {id:'P1',label:'P1',sub:'Vinyl & CD     Pick Aisle',type:'standard'},
  {id:'P2',label:'P2',sub:'Vinyl & CD     Pick Aisle',type:'standard'},
  {id:'P3',label:'P3',sub:'Apparel',                type:'p3'},
  {id:'P4',label:'P4',sub:'Books',                  type:'p4'},
  {id:'P5',label:'P5',sub:'7" Records',             type:'standard'},
];

// MW aisle definitions --- two halves per aisle
// format: MW-{aisle}-{letter}{level}  e.g. MW-01-A1
const WT_MW_AISLES = [
  {aisle:'01', halves:[{letters:'A,B,C,D',label:'MW-01 A   D'},{letters:'E,F,G,H',label:'MW-01 E   H'}]},
  {aisle:'02', halves:[{letters:'A,B,C,D',label:'MW-02 A   D'},{letters:'E,F,G,H',label:'MW-02 E   H'}]},
  {aisle:'03', halves:[{letters:'A,B,C,D',label:'MW-03 A   D'},{letters:'E,F,G,H',label:'MW-03 E   H'}]},
  {aisle:'04', halves:[{letters:'A,B,C,D,E',label:'MW-04 A   E'},{letters:'F,G,H,I,J',label:'MW-04 F   J'}]},
  {aisle:'05', halves:[{letters:'A,B,C,D',label:'MW-05 A   D'},{letters:'E,F,G,H,I,J',label:'MW-05 E   J'}]},
  {aisle:'06', halves:[{letters:'A,B,C,D',label:'MW-06 A   D'},{letters:'E',label:'MW-06 E'}]},
];

// ------ LOC MAP (multi-item) ------------------------------------------------------------------------------------------------------------------
// locMap[locName] = array of { sku, name, upc, row, state, isFallback }
function wtBuildLocMap() {
  const locMap = {};

  function addEntry(loc, entry) {
    if (!locMap[loc]) locMap[loc] = [];
    // Avoid duplicate SKUs in same bin
    if (!locMap[loc].find(e => e.sku === entry.sku)) locMap[loc].push(entry);
  }

  for (const row of WHState.allRows) {
    const activeLocs   = row.pickLocsFallback ? [] : row.pickLocs;
    const fallbackLocs = row.pickLocsFallback ? row.pickLocs : [];
    for (const loc of activeLocs)   addEntry(loc, {sku:row.sku,name:row.name,upc:row.upc||'',row,state:row.priority,isFallback:false});
    // Only show vacated/fallback bins if this product has no active pick bin
    if (row.pickLocsFallback) {
      for (const loc of fallbackLocs) addEntry(loc, {sku:row.sku,name:row.name,upc:row.upc||'',row,state:'vacated',isFallback:true});
    }
  }

  // Also add MW bulk locations from pickQtyBySku debug data
  if (window._whDebug?.pickQtyBySku) {
    for (const [sku, data] of Object.entries(window._whDebug.pickQtyBySku)) {
      const row = WHState.allRows.find(r => r.sku === sku);
      // Pick locations: empty (vacated) ones
      // Only show vacated bins if this SKU has NO active pick bin with stock.
      // If the product is already in P1-B-01, showing P1-A-01 as vacated is noise.
      const hasActivePick = (data.pickLocs||[]).length > 0;
      if (!hasActivePick) {
        for (const loc of (data.emptyPickLocs||[])) {
          addEntry(loc, {sku,name:row?.name||'',upc:row?.upc||'',row:row||null,state:'vacated',isFallback:true});
        }
      }
      // Pick locations: active ones not already added
      for (const loc of (data.pickLocs||[])) {
        if (!locMap[loc] || !locMap[loc].find(e=>e.sku===sku)) {
          addEntry(loc, {sku,name:row?.name||'',upc:row?.upc||'',row:row||null,state:row?.priority||'ok',isFallback:false});
        }
      }
      // Bulk (MW) locations --- show all products in each MW bin
      for (const bulkLoc of (data.bulkLocs||[])) {
        addEntry(bulkLoc.name, {
          sku, name:row?.name||'', upc:row?.upc||'',
          row: row||null,
          state: row ? (row.priority==='urgent'||row.priority==='replenish' ? row.priority : 'ok') : 'ok',
          isFallback: false,
          bulkQty: bulkLoc.qty,
          isBulk: true,
        });
      }
    }
  }

  return locMap;
}

// ------ PARSERS ---------------------------------------------------------------------------------------------------------------------------------------------------------
function wtParseBin(name) {
  // P3 sub: P3-A-01-B
  let m = name.match(/^(P\d+)-([A-Z]+)-(\d+)-([A-D])$/i);
  if (m) return {type:'P',section:m[1].toUpperCase(),col:m[2].toUpperCase(),level:parseInt(m[3]),sub:m[4].toUpperCase()};
  // P4: P4-01
  m = name.match(/^(P4)-(\d+)$/i);
  if (m) return {type:'P',section:'P4',col:'',level:parseInt(m[2]),sub:null};
  // P standard: P1-A-01
  m = name.match(/^(P\d+)-([A-Z]+)-(\d+)$/i);
  if (m) return {type:'P',section:m[1].toUpperCase(),col:m[2].toUpperCase(),level:parseInt(m[3]),sub:null};
  // MW sub-slot: MW-06-E3-B  (aisle-letter+level-sub)
  m = name.match(/^MW-(\d+)-([A-Z]+)(\d+)-([A-Z])$/i);
  if (m) return {type:'MW',aisle:m[1],col:m[2].toUpperCase(),level:parseInt(m[3]),sub:m[4].toUpperCase(),section:'MW-'+m[1]};
  // MW standard: MW-01-A1
  m = name.match(/^MW-(\d+)-([A-Z]+)(\d+)$/i);
  if (m) return {type:'MW',aisle:m[1],col:m[2].toUpperCase(),level:parseInt(m[3]),sub:null,section:'MW-'+m[1]};
  return null;
}

function wtColKey(col) {
  if (!col) return 0;
  return col.length===1 ? col.charCodeAt(0)-64 : 26+(col.charCodeAt(0)-64)*26+(col.charCodeAt(1)-64);
}

// ------ SEARCH STATE ------------------------------------------------------------------------------------------------------------------------------------------
let _wtSearchTerm = '';

window.wtSearch = function(val) {
  _wtSearchTerm = val.trim().toLowerCase().replace(/\D/g,'') || val.trim().toLowerCase();
  wtApplySearch();
};

function wtApplySearch() {
  const term = _wtSearchTerm;
  const bins = document.querySelectorAll('.wt-bin-el');
  if (!term) {
    bins.forEach(b => { b.style.opacity=''; b.style.filter=''; });
    return;
  }
  bins.forEach(b => {
    const skus  = (b.dataset.skus  || '').toLowerCase();
    const names = (b.dataset.names || '').toLowerCase();
    const upcs  = (b.dataset.upcs  || '').replace(/\D/g,'');
    const match = skus.includes(term) || names.includes(term) || upcs.includes(term)
      || upcs.replace(/^0+/,'').includes(term.replace(/^0+/,''));
    b.style.opacity = match ? '1' : '0.1';
    b.style.filter  = match ? '' : 'grayscale(1)';
  });
}

// ------ CLICK DETAIL PANEL ------------------------------------------------------------------------------------------------------------------------
window.wtShowPanel = function(locName, locMap) {
  const items = locMap[locName] || [];
  const panel = document.getElementById('wt-detail-panel');
  if (!panel) return;

  const isMW = locName.startsWith('MW-');

  // Worst state across all items
  const worstState = items.some(i=>i.state==='urgent') ? 'urgent'
    : items.some(i=>i.state==='replenish') ? 'replenish'
    : items.some(i=>i.state==='vacated') ? 'vacated' : 'ok';
  const sc = worstState==='urgent'?'var(--red)':worstState==='replenish'?'var(--yellow)':'var(--green)';

  const rows = items.map(item => {
    const row = item.row;
    if (!row) return '<div style="padding:10px 16px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-muted);">'+(item.sku||'Unknown')+(item.isFallback?' <span style="color:var(--yellow);font-size:10px">(last used)</span>':'')+'</div>';
    const stateColor = item.state==='urgent'?'var(--red)':item.state==='replenish'?'var(--yellow)':item.state==='vacated'?'var(--text-dim)':'var(--green)';
    const badge = item.state==='urgent'?'<span class="pill pill-out" style="font-size:9px;">Urgent</span>'
      :item.state==='replenish'?'<span class="pill pill-low" style="font-size:9px;">Replenish</span>'
      :item.state==='vacated'?'<span class="pill" style="font-size:9px;background:var(--surface2);color:var(--text-dim);">Vacated</span>'
      :'<span class="pill pill-ok" style="font-size:9px;">OK</span>';

    const qty = item.isBulk ? item.bulkQty : row.pickQty;
    const qtyLabel = item.isBulk ? 'Bulk qty' : 'Pick qty';
    const bulkInfo = !item.isBulk && row.bulkLocs && row.bulkLocs.length
      ? '<div style="font-size:10px;color:var(--text-muted);margin-top:4px;">Bulk: '+(row.bulkLocs.slice(0,2).map(l=>l.name+'('+l.qty+')').join(', '))+'</div>' : '';

    return '<div style="padding:12px 16px;border-bottom:1px solid var(--border);">'
      +'<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">'
      +'<div style="flex:1;">'
      +'<div style="font-size:13px;font-weight:700;color:var(--text);line-height:1.3;margin-bottom:2px;">'+whEsc(row.name)+'</div>'
      +'<div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text-muted);">'+whEsc(row.sku)+(row.upc?' &nbsp;  &nbsp; '+whEsc(row.upc):'')+'</div>'
      +'</div>'
      +badge
      +'</div>'
      +'<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:8px;">'
      +'<div style="background:var(--surface2);border-radius:4px;padding:6px 8px;"><div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">'+qtyLabel+'</div><div style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:700;color:'+stateColor+';">'+qty+'</div></div>'
      +(!item.isBulk?'<div style="background:var(--surface2);border-radius:4px;padding:6px 8px;"><div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Free pick</div><div style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:700;color:'+stateColor+';">'+row.freePickQty+'</div></div>':'')
      +'<div style="background:var(--surface2);border-radius:4px;padding:6px 8px;"><div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Velocity</div><div style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:700;">'+row.velocity.toFixed(2)+'<span style="font-size:10px;font-weight:400">/day</span></div></div>'
      +(row.suggest>0?'<div style="background:rgba(184,50,40,0.08);border-radius:4px;padding:6px 8px;border:1px solid rgba(184,50,40,0.2);"><div style="font-size:9px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">Move qty</div><div style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:700;color:var(--red);">'+row.suggest+'</div></div>':'')
      +'</div>'
      +bulkInfo
      +'</div>';
  }).join('');

  panel.innerHTML = '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:2px solid var(--border);background:var(--surface2);flex-shrink:0;">'
    +'<div>'
    +'<div style="font-family:\'DM Mono\',monospace;font-size:18px;font-weight:700;color:'+sc+';">'+whEsc(locName)+'</div>'
    +'<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">'+items.length+' SKU'+(items.length!==1?'s':'')+' in this '+(isMW?'bulk location':'pick bin')+'</div>'
    +'</div>'
    +'<button onclick="wtClosePanel()" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--text-muted);padding:4px;">&#x2715;</button>'
    +'</div>'
    +'<div style="overflow-y:auto;flex:1;">'+rows+'</div>';

  panel.style.display = 'flex';
};

window.wtClosePanel = function() {
  const panel = document.getElementById('wt-detail-panel');
  if (panel) panel.style.display = 'none';
};

// ------ MAIN RENDER ---------------------------------------------------------------------------------------------------------------------------------------------
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
  window._wtLocMap = locMap; // store for click handlers

  // Split into P and MW bins
  const pSectionBins = {}, mwBins = {};
  for (const [locName, items] of Object.entries(locMap)) {
    const parsed = wtParseBin(locName);
    if (!parsed) continue;
    if (parsed.type === 'P') {
      if (!pSectionBins[parsed.section]) pSectionBins[parsed.section] = [];
      pSectionBins[parsed.section].push({locName, parsed, items});
    } else if (parsed.type === 'MW') {
      const key = 'MW-' + parsed.aisle;
      if (!mwBins[key]) mwBins[key] = [];
      mwBins[key].push({locName, parsed, items});
    }
  }

  const container = document.getElementById('wt-sections');
  if (!container) return;
  container.innerHTML = '';

  // ------ P sections ------
  const pHeader = document.createElement('div');
  pHeader.style.cssText = 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--text-muted);margin:0 0 16px;padding-bottom:8px;border-bottom:2px solid var(--border);';
  pHeader.textContent = 'Pick Bins';
  container.appendChild(pHeader);

  for (const def of WT_P_SECTIONS) {
    const bins = pSectionBins[def.id] || [];
    container.appendChild(wtRenderPSection(def, bins, locMap));
  }

  // ------ MW sections ------
  const mwHeader = document.createElement('div');
  mwHeader.style.cssText = 'font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:var(--text-muted);margin:32px 0 16px;padding-bottom:8px;border-bottom:2px solid var(--border);';
  mwHeader.textContent = 'MW Bulk Locations';
  container.appendChild(mwHeader);

  for (const aisleData of WT_MW_AISLES) {
    const aisleBins = mwBins['MW-' + aisleData.aisle] || [];
    container.appendChild(wtRenderMWAisle(aisleData, aisleBins, locMap));
  }

  // Apply any active search
  wtApplySearch();
}

// ------ P SECTION RENDER ---------------------------------------------------------------------------------------------------------------------------
function wtRenderPSection(def, binEntries, locMap) {
  const el = document.createElement('div');
  el.style.marginBottom = '28px';

  const allItems = binEntries.flatMap(b => b.items);
  const urgent   = binEntries.filter(b => b.items.some(i=>i.state==='urgent')).length;
  const replen   = binEntries.filter(b => b.items.some(i=>i.state==='replenish')).length;
  const vacated  = binEntries.filter(b => b.items.some(i=>i.state==='vacated')).length;
  let stats = '';
  if (urgent) stats += '<span style="color:var(--red)">    '+urgent+' urgent</span> ';
  if (replen) stats += '<span style="color:var(--yellow)">    '+replen+' replenish</span> ';
  if (vacated) stats += '<span style="color:rgba(184,50,40,0.4)">    '+vacated+' vacated</span>';

  el.innerHTML = '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px;">'
    +def.label+'<span style="font-size:10px;font-weight:400;text-transform:none;letter-spacing:0;color:var(--text-dim)">'+def.sub+'</span>'
    +'<div style="margin-left:auto;font-size:10px;font-weight:400;display:flex;gap:10px;">'+stats+'</div></div>'
    +'<div id="wt-shelf-'+def.id+'" style="display:flex;gap:4px;align-items:flex-start;overflow-x:auto;padding-bottom:8px;"></div>';

  const shelf = el.querySelector('#wt-shelf-'+def.id);
  if (def.type==='p4')        wtRenderP4Shelf(shelf, binEntries, locMap);
  else if (def.type==='p3')   wtRenderP3Shelf(shelf, binEntries, locMap);
  else                        wtRenderStandardShelf(shelf, binEntries, def.id, locMap);
  return el;
}

function wtRenderStandardShelf(shelf, binEntries, sid, locMap) {
  const cols = [...new Set(binEntries.map(b=>b.parsed.col))].sort((a,b)=>wtColKey(a)-wtColKey(b));
  const maxLvl = Math.max(...binEntries.map(b=>b.parsed.level), 6);
  const lu = {}; for (const b of binEntries) lu[b.parsed.col+'-'+b.parsed.level] = b;
  for (const col of cols) {
    const up = document.createElement('div');
    const isLastCol = col === cols[cols.length-1];
    up.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex-shrink:0;padding-right:8px;margin-right:4px;'+(isLastCol?'':'border-right:2px solid #333;');
    up.innerHTML = '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:#555;font-weight:700;text-align:center;margin-bottom:4px;letter-spacing:1px;">'+col+'</div>';
    for (let l=1; l<=maxLvl; l++) {
      const b = lu[col+'-'+l];
      up.appendChild(wtMakeBinEl(b ? b.locName : sid+'-'+col+'-'+String(l).padStart(2,'0'), b ? b.items : null, false, locMap));
    }
    shelf.appendChild(up);
  }
}

function wtRenderP3Shelf(shelf, binEntries, locMap) {
  const cols = [...new Set(binEntries.map(b=>b.parsed.col))].sort((a,b)=>wtColKey(a)-wtColKey(b));
  const maxLvl = Math.max(...binEntries.map(b=>b.parsed.level), 7);
  const lu={}; for (const b of binEntries) lu[b.parsed.col+'-'+b.parsed.level+'-'+(b.parsed.sub||'A')] = b;
  for (const col of cols) {
    const up = document.createElement('div');
    const isLastColP3 = col === cols[cols.length-1];
    up.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex-shrink:0;padding-right:8px;margin-right:4px;'+(isLastColP3?'':'border-right:2px solid #333;');
    up.innerHTML = '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:#555;font-weight:700;text-align:center;margin-bottom:4px;letter-spacing:1px;">'+col+'</div>';
    for (let l=1; l<=maxLvl; l++) {
      const row = document.createElement('div'); row.style.cssText='display:flex;gap:2px;';
      for (const s of ['A','B','C','D']) {
        const b = lu[col+'-'+l+'-'+s];
        if (!b && !WHState.wtShowEmpty) continue;
        row.appendChild(wtMakeBinEl(b?b.locName:'P3-'+col+'-'+String(l).padStart(2,'0')+'-'+s, b?b.items:null, true, locMap));
      }
      if (row.children.length) up.appendChild(row);
    }
    shelf.appendChild(up);
  }
}

function wtRenderP4Shelf(shelf, binEntries, locMap) {
  const up = document.createElement('div');
  up.style.cssText='display:flex;flex-direction:column;gap:2px;flex-shrink:0;';
  up.innerHTML='<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:var(--text-dim);text-align:center;margin-bottom:3px;">P4</div>';
  const maxLvl = Math.max(...binEntries.map(b=>b.parsed.level),6);
  const lu={}; for (const b of binEntries) lu[b.parsed.level]=b;
  for (let l=1;l<=maxLvl;l++) {
    const b=lu[l];
    up.appendChild(wtMakeBinEl(b?b.locName:'P4-'+String(l).padStart(2,'0'), b?b.items:null, false, locMap));
  }
  shelf.appendChild(up);
}

// ------ MW AISLE RENDER ---------------------------------------------------------------------------------------------------------------------------------
function wtRenderMWAisle(aisleData, binEntries, locMap) {
  const el = document.createElement('div');
  el.style.marginBottom = '28px';

  const urgent = binEntries.filter(b=>b.items.some(i=>i.state==='urgent'||i.state==='replenish')).length;

  el.innerHTML = '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:1px solid var(--border);margin-bottom:10px;">'
    +'Aisle MW-'+aisleData.aisle
    +(urgent?'<span style="margin-left:auto;font-size:10px;color:var(--yellow);">    '+urgent+' need attention</span>':'')
    +'</div>'
    +'<div id="mw-aisle-'+aisleData.aisle+'" style="display:flex;gap:24px;flex-wrap:wrap;"></div>';

  const aisleEl = el.querySelector('#mw-aisle-'+aisleData.aisle);

  for (const half of aisleData.halves) {
    const letters = half.letters.split(',').map(s=>s.trim());
    const halfEl  = document.createElement('div');
    halfEl.style.cssText = 'flex-shrink:0;';
    halfEl.innerHTML = '<div style="font-size:10px;font-weight:600;color:var(--text-muted);margin-bottom:6px;font-family:\'DM Mono\',monospace;">'+half.label+'</div>';
    const shelfEl = document.createElement('div');
    shelfEl.style.cssText = 'display:flex;gap:4px;align-items:flex-start;';

    const lu={}; for (const b of binEntries) { const key = b.parsed.sub ? b.parsed.col+'-'+b.parsed.level+'-'+b.parsed.sub : b.parsed.col+'-'+b.parsed.level; lu[key]=b; }
    const maxLvl = binEntries.length ? Math.max(...binEntries.map(b=>b.parsed.level),1) : 6;

    for (const letter of letters) {
      const up = document.createElement('div');
      const isLastLetter = letter === letters[letters.length-1];
      up.style.cssText = 'display:flex;flex-direction:column;gap:3px;flex-shrink:0;padding-right:8px;margin-right:4px;'+(isLastLetter?'':'border-right:2px solid #333;');
      up.innerHTML = '<div style="font-family:\'DM Mono\',monospace;font-size:9px;color:#555;font-weight:700;text-align:center;margin-bottom:4px;letter-spacing:1px;">'+letter+'</div>';
      for (let l=1; l<=maxLvl; l++) {
        // Check if this level has sub-slots (e.g. MW-06-E3-A, MW-06-E3-B)
        const subKeys = ['A','B','C','D'].filter(s => lu[letter+'-'+l+'-'+s]);
        if (subKeys.length > 0) {
          // Render sub-slots as a small row
          const subRow = document.createElement('div');
          subRow.style.cssText = 'display:flex;gap:2px;';
          for (const s of ['A','B','C','D']) {
            const b = lu[letter+'-'+l+'-'+s];
            if (!b && !WHState.wtShowEmpty) continue;
            const locName = 'MW-'+aisleData.aisle+'-'+letter+l+'-'+s;
            subRow.appendChild(wtMakeBinEl(locName, b?b.items:null, true, locMap, false));
          }
          if (subRow.children.length) up.appendChild(subRow);
        } else {
          const b = lu[letter+'-'+l];
          const locName = 'MW-'+aisleData.aisle+'-'+letter+l;
          up.appendChild(wtMakeBinEl(locName, b?b.items:null, false, locMap, true));
        }
      }
      shelfEl.appendChild(up);
    }
    halfEl.appendChild(shelfEl);
    aisleEl.appendChild(halfEl);
  }
  return el;
}

// ------ BIN ELEMENT ---------------------------------------------------------------------------------------------------------------------------------------------
function wtMakeBinEl(locName, items, isSub, locMap, isMW) {
  const el = document.createElement('div');
  el.className = 'wt-bin-el';

  const hasItems = items && items.length > 0;
  const worstState = !hasItems ? 'empty'
    : items.some(i=>i.state==='urgent')    ? 'urgent'
    : items.some(i=>i.state==='replenish') ? 'replenish'
    : items.some(i=>i.state==='vacated')   ? 'vacated'
    : 'ok';

  // Store search data as dataset attributes
  if (hasItems) {
    el.dataset.skus  = items.map(i=>i.sku).join(' ');
    el.dataset.names = items.map(i=>i.name).join(' ');
    el.dataset.upcs  = items.map(i=>i.upc||'').join(' ');
  }
  el.dataset.loc = locName;

  const S = {
    urgent:   'background:#f04a4a;border:2px solid #c0392b;color:#fff;',
    replenish:'background:#f0b84a;border:2px solid #d4971f;color:#111;',
    ok:       'background:#d4f5e4;border:2px solid #1e7e4a;color:#0a4a28;',
    vacated:  'background:#f8f0ee;border:2px dashed #c0392b;color:#c0392b;',
    empty:    'background:#f0ede7;border:1px solid #c8c4ba;color:#b8b3aa;cursor:default;',
  };

  // MW bins slightly wider to fit location text
  const w = isSub ? '28px' : isMW ? '64px' : '56px';
  const minH = isMW ? '44px' : '38px';
  const textColor = (worstState==='urgent')?'color:#fff;'
    :(worstState==='replenish')?'color:#5a3a00;'
    :(worstState==='ok')?'color:#0a4a28;'
    :(worstState==='vacated')?'color:#8b2a1e;'
    :'color:#888;';

  el.style.cssText = 'width:'+w+';min-height:'+minH+';border-radius:3px;display:flex;align-items:center;justify-content:center;'
    +'font-family:\'DM Mono\',monospace;font-size:8px;font-weight:700;flex-shrink:0;text-align:center;'
    +'padding:2px;transition:transform 0.1s,box-shadow 0.1s;position:relative;overflow:visible;'
    +(S[worstState]||S.empty)+textColor;

  if (!WHState.wtShowEmpty && worstState==='empty') { el.style.display='none'; return el; }

  // Multi-item indicator dot
  if (hasItems && items.length > 1) {
    const dot = document.createElement('div');
    dot.style.cssText = 'position:absolute;top:2px;right:2px;width:8px;height:8px;border-radius:50%;'
      +'background:var(--accent);font-size:6px;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;line-height:1;';
    dot.textContent = items.length;
    el.appendChild(dot);
  }

  if (hasItems) {
    el.style.cursor = 'pointer';
    // Hover: show quick popover
    el.addEventListener('mouseenter', e => {
      el.style.transform='scale(1.12)'; el.style.zIndex='20'; el.style.boxShadow='0 4px 12px rgba(0,0,0,0.15)';
      wtShowMultiPop(e, locName, items);
    });
    el.addEventListener('mouseleave', () => {
      el.style.transform=''; el.style.zIndex=''; el.style.boxShadow='';
      wtHidePop();
    });
    el.addEventListener('mousemove', wtMovePop);
    // Click: open detail panel
    el.addEventListener('click', () => {
      wtHidePop();
      wtShowPanel(locName, window._wtLocMap || {});
    });
  }

  return el;
}

// ------ MULTI-ITEM HOVER POPOVER ------------------------------------------------------------------------------------------------------
function wtShowMultiPop(e, locName, items) {
  const pop = document.getElementById('wt-pop');
  if (!pop) return;

  const isMW = locName.startsWith('MW-');
  let html = '<div style="font-family:\'DM Mono\',monospace;font-size:10px;color:var(--text-muted);margin-bottom:8px;font-weight:700;">'
    + whEsc(locName) + (isMW?' <span style="font-size:9px;opacity:0.6">(bulk)</span>':'') + '</div>';

  const shown = items.slice(0, 4); // show up to 4 in hover
  for (const item of shown) {
    if (!item.row) continue;
    const sc = item.state==='urgent'?'var(--red)':item.state==='replenish'?'var(--yellow)':item.state==='vacated'?'var(--text-dim)':'var(--green)';
    const qty = item.isBulk ? item.bulkQty : item.row.pickQty;
    html += '<div style="padding:5px 0;border-bottom:1px solid var(--border);margin-bottom:5px;">'
      +'<div style="font-size:11px;font-weight:600;color:var(--text);margin-bottom:2px;">'+whEsc(item.row.name)+'</div>'
      +'<div style="display:flex;justify-content:space-between;font-family:\'DM Mono\',monospace;font-size:10px;">'
      +'<span style="color:var(--text-muted)">'+whEsc(item.row.sku)+'</span>'
      +'<span style="color:'+sc+';font-weight:700;">'+qty+' units</span>'
      +'</div>'
      +(item.row.suggest>0&&!item.isBulk?'<div style="font-size:9px;color:var(--accent);margin-top:2px;">Move '+item.row.suggest+' to pick bin</div>':'')
      +'</div>';
  }
  if (items.length > 4) html += '<div style="font-size:9px;color:var(--text-muted);text-align:center;margin-top:4px;">+' + (items.length-4) + ' more     click to see all</div>';
  else if (items.length > 0) html += '<div style="font-size:9px;color:var(--text-dim);text-align:center;margin-top:4px;">Click for details</div>';

  pop.innerHTML = html;
  pop.style.display = 'block';
  wtMovePop(e);
}

function wtMovePop(e) {
  const pop = document.getElementById('wt-pop');
  if (!pop||pop.style.display==='none') return;
  const pw=pop.offsetWidth||260, ph=pop.offsetHeight||200;
  let x=e.clientX+14, y=e.clientY+14;
  if (x+pw>window.innerWidth-10)  x=e.clientX-pw-14;
  if (y+ph>window.innerHeight-10) y=e.clientY-ph-14;
  pop.style.left=x+'px'; pop.style.top=y+'px';
}

function wtHidePop() { const pop=document.getElementById('wt-pop'); if(pop) pop.style.display='none'; }

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

// --------- DASHBOARD CARD ------------------------------------------------------------------------------------------------------------------------------
// Injects Walk Replenish card into the dashboard grid.
// Uses CSS order to position it:
//   Desktop: after first 4 cards (start of row 2 in 4-col grid)
//   Mobile: first card (order:-1)
// Does NOT touch or reorder existing cards --- avoids fragility.
(function() {

  const DASH_ORDER_KEY = 'fp_dash_card_order';

  function saveDashOrder(grid) {
    const order = [...grid.querySelectorAll('.dash-card[data-card-id]')]
      .map(c => c.dataset.cardId);
    try { localStorage.setItem(DASH_ORDER_KEY, JSON.stringify(order)); } catch(e) {}
  }

  function loadDashOrder() {
    try { return JSON.parse(localStorage.getItem(DASH_ORDER_KEY) || 'null'); } catch(e) { return null; }
  }

  function makeDraggable(card, grid) {
    // Don't make doomsday card draggable - it has interactive buttons
    if (card.id === 'doomsday-card') return;

    card.setAttribute('draggable', 'true');
    card.style.cursor = 'grab';

    card.addEventListener('dragstart', function(e) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', card.dataset.cardId);
      card.style.opacity = '0.5';
      window._fpDragCard = card;
    });
    card.addEventListener('dragend', function() {
      card.style.opacity = '';
      window._fpDragCard = null;
      grid.querySelectorAll('.dash-card').forEach(c => c.style.outline = '');
    });
    card.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (window._fpDragCard && window._fpDragCard !== card) {
        card.style.outline = '2px dashed var(--accent)';
      }
    });
    card.addEventListener('dragleave', function() {
      card.style.outline = '';
    });
    card.addEventListener('drop', function(e) {
      e.preventDefault();
      card.style.outline = '';
      const dragged = window._fpDragCard;
      if (!dragged || dragged === card) return;
      // Insert dragged before or after drop target based on position
      const rect = card.getBoundingClientRect();
      const midX = rect.left + rect.width / 2;
      if (e.clientX < midX) {
        grid.insertBefore(dragged, card);
      } else {
        grid.insertBefore(dragged, card.nextSibling);
      }
      saveDashOrder(grid);
    });
  }

  function applyDashOrder(grid, statCards) {
    const saved = loadDashOrder();
    if (!saved || saved.length < 2) return;
    // Reorder stat cards to match saved order
    saved.forEach(id => {
      const card = statCards.find(c => c.dataset.cardId === id);
      if (card) grid.appendChild(card);
    });
    // Any cards not in saved order go at end
    statCards.forEach(c => {
      if (!saved.includes(c.dataset.cardId)) grid.appendChild(c);
    });
  }

  function buildWHCard() {
    const urgent  = WHState.allRows.filter(r => r.priority === 'urgent').length;
    const replen  = WHState.allRows.filter(r => r.priority === 'replenish').length;
    const total   = urgent + replen;
    const hasData = WHState.allRows.length > 0;
    const card = document.createElement('div');
    card.id = 'wh-dash-card';
    card.dataset.cardId = 'walk-replenish';
    card.className = 'dash-card wh-replenish-card';
    card.style.cursor = 'pointer';
    card.style.order = '4';
    card.innerHTML =
      '<div class="dash-label">Walk Replenish</div>'
      + '<div class="dash-num" style="font-size:28px;color:var(--accent);">' + (hasData ? total : '   ') + '</div>'
      + '<div class="dash-sub">' + (hasData
          ? (urgent > 0 ? urgent + ' urgent    ' : '') + replen + ' need stock'
          : 'Click to generate') + '</div>'
      + '<div style="margin-top:12px;">'
      + '<button onclick="event.stopPropagation();startReplenishRun()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:12px;font-weight:700;cursor:pointer;width:100%;">'
      + '&#9654; ' + (hasData ? 'Start Replenish Run' : 'Generate &amp; Start')
      + '</button></div>';
    card.addEventListener('click', () => startReplenishRun());
    return card;
  }

  function injectDashCard() {
    const body = document.getElementById('dashboard-body');
    if (!body) return;
    const grid = body.querySelector('.dash-grid');
    if (!grid) return;

    document.getElementById('wh-dash-card')?.remove();

    const allChildren = [...grid.children];
    const statCards = allChildren.filter(c => c.classList.contains('dash-card')).slice(0, 7);
    const rest = allChildren.filter(c => !statCards.includes(c));

    if (statCards.length < 4) return;

    const [cTotal, cGlobal, cAlerts, cResolved, cMfg, cRuns, cClock] = statCards;

    const wh = buildWHCard();
    wh.classList.remove('dash-card-red','dash-card-yellow');
    if (cMfg) cMfg.classList.remove('dash-card-red','dash-card-yellow');

    // Build Pre-Orders card
    const cPreOrders = (function() {
      const campaigns = (typeof POState !== 'undefined' ? POState.campaigns : []) || [];
      const active = campaigns.filter(c => c.status === 'active');
      const totalOrders = active.reduce((sum, c) => {
        const orders = (typeof POState !== 'undefined' ? POState.orders[c.id] : null) || [];
        return sum + orders.length;
      }, 0);
      const card = document.createElement('div');
      card.dataset.cardId = 'pre-orders';
      card.className = 'dash-card';
      card.style.cursor = 'pointer';
      card.innerHTML =
        '<div class="dash-label">Open Pre-Orders</div>'
        + '<div class="dash-num" style="font-size:28px;color:var(--accent);">' + totalOrders + '</div>'
        + '<div class="dash-sub">' + active.length + ' active campaign' + (active.length !== 1 ? 's' : '') + '</div>';
      card.addEventListener('click', () => { if (window.switchToPreOrders) switchToPreOrders(); });
      return card;
    })();

    // Assign stable IDs for drag ordering
    if (cTotal)    cTotal.dataset.cardId    = 'total-products';
    if (cGlobal)   cGlobal.dataset.cardId   = 'global-stock';
    if (cAlerts)   cAlerts.dataset.cardId   = 'reorder-alerts';
    if (cResolved) cResolved.dataset.cardId = 'resolved';
    if (cMfg)      cMfg.dataset.cardId      = 'mfg-predictions';
    if (cRuns)     cRuns.dataset.cardId     = 'production-runs';
    if (cClock)    cClock.dataset.cardId    = 'stockout-clock';

    [...statCards, wh].forEach(c => {
      if (c) { c.style.order = ''; c.style.gridColumn = ''; }
    });

    grid.innerHTML = '';

    // Default order
    const defaultOrder = [cTotal, cGlobal, cAlerts, cResolved, wh, cRuns, cMfg, cClock, cPreOrders].filter(Boolean);
    defaultOrder.forEach(c => grid.appendChild(c));

    // Apply saved order if exists
    applyDashOrder(grid, defaultOrder);

    // Make all stat cards draggable
    defaultOrder.forEach(c => makeDraggable(c, grid));

    // Rest full-width
    rest.forEach(c => {
      c.style.gridColumn = '1 / -1';
      grid.appendChild(c);
    });

    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = 'repeat(4, 1fr)';
    grid.style.gap = '16px';
    grid.style.flexWrap = '';

    // Apply card visibility from settings — runs after every grid rebuild
    // so hidden cards stay hidden even when app.js re-renders the dashboard
    if (window._fpApplyCardVisibility) window._fpApplyCardVisibility();

    document.getElementById('mob-stat-strip')?.remove();
    if (window.innerWidth <= 768) {
      const alertCount = cAlerts ? (cAlerts.querySelector('.dash-num')?.textContent||'0') : '0';
      const mfgCount   = cMfg   ? (cMfg.querySelector('.dash-num')?.textContent||'0')   : '0';
      const clockEl    = cClock  ? cClock.querySelector('[style*="font-size:28"]') : null;
      const clockVal   = clockEl ? clockEl.textContent.trim() : '   ';
      const alertColor = parseInt(alertCount) > 0 ? 'color:var(--red)' : 'color:var(--green)';
      const strip = document.createElement('div');
      strip.id = 'mob-stat-strip';
      strip.className = 'mob-stat-strip';
      strip.innerHTML =
        '<div class="mob-stat"><div class="mob-stat-val" style="'+alertColor+'">'+alertCount+'</div><div class="mob-stat-lbl">Alerts</div></div>'
        +'<div class="mob-stat"><div class="mob-stat-val">'+mfgCount+'</div><div class="mob-stat-lbl">Mfg</div></div>'
        +'<div class="mob-stat"><div class="mob-stat-val" style="font-size:14px;">'+clockVal+'</div><div class="mob-stat-lbl">Stockout</div></div>';
      const whCard = document.getElementById('wh-dash-card');
      if (whCard && whCard.nextSibling) grid.insertBefore(strip, whCard.nextSibling);
      else grid.appendChild(strip);
    }
  }

  function watchDashboard() {
    const body = document.getElementById('dashboard-body');
    if (!body) { setTimeout(watchDashboard, 500); return; }
    new MutationObserver(() => {
      const view = document.getElementById('view-dashboard');
      if (view && (view.classList.contains('active') || !view.classList.contains('hidden'))) {
        clearTimeout(window._whDashTimer);
        window._whDashTimer = setTimeout(injectDashCard, 80);
      }
    }).observe(body, { childList: true, subtree: false });
  }

  document.addEventListener('DOMContentLoaded', watchDashboard);

  // Override doomsdayKeepIt with a clean implementation

  document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() {
      window.doomsdayKeepIt = function() {
        if (typeof _doomsdayPool === 'undefined' || !_doomsdayPool) return;
        _doomsdayIdx = (_doomsdayIdx || 0) + 1;
        if (_doomsdayIdx >= _doomsdayPool.length) {
          _doomsdayPool = buildDoomsdayPool();
          _doomsdayIdx = 0;
        }
        renderDoomsdayClock();
      };
    }, 1000);
  });
})();

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// PICKER MODE
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

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

  // Flatten --- each row gets its primary bulk loc
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
  if (arrow) arrow.textContent = '   ';

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

  if (PickerState.index >= PickerState.queue.length) {
    pickerRenderComplete();
    return;
  }

  const total   = PickerState.queue.length;
  const current = PickerState.index + 1;
  const item    = PickerState.queue[PickerState.index];
  const pct     = Math.round(((current - 1) / total) * 100);
  const destStr = item.destBins && item.destBins.length
    ? item.destBins.join('      ')
    : '    no bin assigned    ';
  const suggestedQty = item.qty;

  overlay.innerHTML =
    '<div id="picker-card" style="width:100%;max-width:680px;background:var(--surface);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,0.18);display:flex;flex-direction:column;overflow:hidden;position:relative;">'

    // Flash overlay (for success/error animation)
    + '<div id="picker-flash" style="position:absolute;inset:0;border-radius:12px;opacity:0;pointer-events:none;z-index:10;transition:opacity 0.15s;"></div>'

    // Header
    + '<div style="background:var(--accent);color:#fff;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;">'
    + '<div style="font-size:13px;font-weight:700;letter-spacing:1px;text-transform:uppercase;opacity:0.9;">FP Warehouse Replenish</div>'
    + '<div style="display:flex;align-items:center;gap:16px;">'
    + '<span style="font-size:14px;font-weight:700;">' + current + ' <span style="opacity:0.6;font-weight:400;">of</span> ' + total + '</span>'
    + '<button onclick="pickerEndSession()" style="background:rgba(255,255,255,0.15);border:1px solid rgba(255,255,255,0.4);color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;touch-action:manipulation;">&#9654;&#9654; Finish</button>'    + '<button onclick="pickerClose()" style="background:rgba(255,255,255,0.2);border:none;color:#fff;border-radius:6px;padding:6px 12px;font-size:12px;font-weight:700;cursor:pointer;touch-action:manipulation;">&#x2715; Exit</button>'
    + '</div></div>'

    // Progress bar
    + '<div style="height:6px;background:rgba(0,0,0,0.08);"><div style="height:100%;width:' + pct + '%;background:var(--accent);opacity:0.4;transition:width 0.3s;border-radius:0 3px 3px 0;"></div></div>'

    // Body
    + '<div style="padding:28px 32px 20px;flex:1;">'

    // Pull From location --- smaller, informational
    + '<div style="display:flex;align-items:center;gap:12px;margin-bottom:20px;padding:12px 16px;background:var(--surface2);border-radius:8px;border-left:4px solid var(--accent);">'
    + '<div>'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:2px;">Go To Location</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:26px;font-weight:700;color:var(--accent);letter-spacing:2px;line-height:1;">' + whEsc(item.bulkLoc) + '</div>'
    + '</div>'
    + '<div style="margin-left:auto;text-align:right;">'
    + '<div style="font-size:10px;color:var(--text-muted);">In location</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:18px;font-weight:600;color:var(--text-muted);">' + item.bulkQty.toLocaleString() + '</div>'
    + '</div></div>'

    // Product name + SKU --- LARGE, this is what the picker confirms
    + '<div style="margin-bottom:20px;">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:6px;">Grab This Product</div>'
    + '<div style="font-size:22px;font-weight:700;color:var(--text);line-height:1.3;margin-bottom:4px;">' + whEsc(item.row.name) + '</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:14px;color:var(--text-muted);">' + whEsc(item.row.sku) + ' &nbsp;  &nbsp; UPC: ' + whEsc(item.row.upc || '   ') + '</div>'
    + '</div>'

    // Qty + Place Into row
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px;">'

    // Qty input with up/down arrows
    + '<div style="padding:16px 20px;background:var(--surface2);border-radius:8px;border:2px solid var(--border);">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:10px;">Qty to Pick <span style="font-weight:400;opacity:0.6;">(min ' + suggestedQty + ')</span></div>'
    + '<div style="display:flex;align-items:center;gap:12px;">'
    + '<button onclick="pickerQtyAdj(-1)" style="width:44px;height:44px;border-radius:8px;border:2px solid var(--border2);background:var(--surface);font-size:24px;font-weight:700;cursor:pointer;color:var(--text);display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;touch-action:manipulation;">&#8722;</button>'
    + '<input type="number" id="picker-qty-input" value="' + suggestedQty + '" min="' + suggestedQty + '"'
    + ' style="flex:1;font-family:\'DM Mono\',monospace;font-size:48px;font-weight:700;color:var(--text);background:transparent;border:none;outline:none;padding:0;line-height:1;text-align:center;width:0;"'
    + ' oninput="pickerQtyChange(this)" onkeydown="if(event.key===\'Enter\'){event.preventDefault();document.getElementById(\'picker-scan-input\')?.focus();}" />'
    + '<button onclick="pickerQtyAdj(1)" style="width:44px;height:44px;border-radius:8px;border:2px solid var(--border2);background:var(--surface);font-size:24px;font-weight:700;cursor:pointer;color:var(--text);display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;touch-action:manipulation;">&#43;</button>'
    + '</div>'
    + '</div>'

    // Place into
    + '<div style="padding:16px 20px;background:var(--green-bg);border-radius:8px;border:2px solid rgba(30,126,74,0.3);">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--green);margin-bottom:8px;">Place Into Pick Bin</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:20px;font-weight:700;color:var(--green);line-height:1.3;">' + whEsc(destStr) + '</div>'
    + '</div>'
    + '</div>'

    // Scan UPC input
    + '<div>'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:8px;">Scan Product Barcode (UPC) to Confirm</div>'
    + '<div style="display:flex;gap:10px;align-items:stretch;">'
      + '<input type="text" id="picker-scan-input" placeholder="Scan or type UPC   "'
    + ' autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"'
    + ' style="flex:1;font-family:\'DM Mono\',monospace;font-size:20px;padding:14px 16px;border:2px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);outline:none;"'
    + ' onkeydown="pickerHandleKey(event)" oninput="pickerClearError()" />'
    + '<button onclick="pickerConfirm()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:14px 20px;font-size:18px;font-weight:700;cursor:pointer;flex-shrink:0;touch-action:manipulation;">&#10003;</button>'
    + '</div>'
    + '<div id="picker-scan-error" style="color:var(--red);font-size:13px;font-weight:600;margin-top:8px;min-height:20px;font-family:\'DM Mono\',monospace;"></div>'
    + '</div>'

    + '</div>' // end body

    // Footer
    + '<div style="padding:14px 32px;border-top:1px solid var(--border);display:flex;gap:10px;justify-content:space-between;align-items:center;background:var(--surface2);">'
    + '<div style="font-size:11px;color:var(--text-dim);font-family:\'DM Mono\',monospace;">' + PickerState.completed.length + ' done &nbsp;  &nbsp; ' + (PickerState.queue.length - current) + ' remaining</div>'
    + (current > 1 ? '<button onclick="pickerBack()" style="background:none;border:1px solid var(--border2);color:var(--text-muted);border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;">&#8592; Back</button>' : '<div></div>')
    + '</div>'

    + '</div>'; // end picker-card

  // Auto-focus scan input
  setTimeout(() => {
    const inp = document.getElementById('picker-scan-input');
    if (inp) inp.focus();
  }, 80);
}

window.pickerQtyChange = function(input) {
  const min = parseInt(input.min) || 1;
  const val = parseInt(input.value) || 0;
  input.style.color = val < min ? 'var(--red)' : 'var(--text)';
  const item = PickerState.queue[PickerState.index];
  if (item) item._overrideQty = val;
};

window.pickerQtyAdj = function(delta) {
  const input = document.getElementById('picker-qty-input');
  if (!input) return;
  const min = parseInt(input.min) || 1;
  const current = parseInt(input.value) || min;
  const next = Math.max(min, current + delta);
  input.value = next;
  input.style.color = 'var(--text)';
  const item = PickerState.queue[PickerState.index];
  if (item) item._overrideQty = next;
  // Refocus scan input after tap so scanner still works
  setTimeout(() => document.getElementById('picker-scan-input')?.focus(), 50);
};

window.pickerHandleKey = function(e) {
  if (e.key === 'Enter') {
    e.preventDefault();
    pickerConfirm();
  }
};

window.pickerClearError = function() {
  const el = document.getElementById('picker-scan-error');
  if (el) el.textContent = '';
  const inp = document.getElementById('picker-scan-input');
  if (inp) inp.style.borderColor = 'var(--border2)';
};

// Audio feedback
function pickerPlaySuccess() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.08);
    gain.gain.setValueAtTime(0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.35);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + 0.35);
  } catch(e) {}
}

function pickerPlayError() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain); gain.connect(ctx.destination);
      osc.frequency.setValueAtTime(220, ctx.currentTime + offset);
      osc.frequency.setValueAtTime(160, ctx.currentTime + offset + 0.12);
      gain.gain.setValueAtTime(0.35, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.28);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.28);
    });
  } catch(e) {}
}

function pickerFlash(color, cb) {
  const flash = document.getElementById('picker-flash');
  if (!flash) { if (cb) cb(); return; }
  flash.style.background = color;
  flash.style.opacity = '0.55';
  setTimeout(() => {
    flash.style.opacity = '0';
    setTimeout(() => { if (cb) cb(); }, 150);
  }, 320);
}

window.pickerConfirm = function() {
  const scanInp = document.getElementById('picker-scan-input');
  const qtyInp  = document.getElementById('picker-qty-input');
  const scanRaw = scanInp ? scanInp.value.trim() : '';
  const item    = PickerState.queue[PickerState.index];

  // Qty validation
  const pickedQty = parseInt(qtyInp?.value) || item.qty;
  const minQty    = item.qty;
  if (pickedQty < minQty) {
    const errEl = document.getElementById('picker-scan-error');
    if (errEl) errEl.textContent = '\u26A0 Qty cannot be less than ' + minQty + '. Adjust if you picked more.';
    if (qtyInp) { qtyInp.style.color = 'var(--red)'; qtyInp.focus(); qtyInp.select(); }
    pickerPlayError();
    return;
  }

  // Must scan --- no empty confirm
  if (!scanRaw) {
    const errEl = document.getElementById('picker-scan-error');
    if (errEl) errEl.textContent = 'Scan or enter the product UPC barcode to confirm.';
    if (scanInp) { scanInp.style.borderColor = 'var(--red)'; scanInp.focus(); }
    pickerPlayError();
    pickerFlash('rgba(240,74,74,0.6)');
    return;
  }

  // Match UPC only --- no SKU fallback (we want barcode scanning, not SKU)
  const rawBarcode  = (item.row.upc || '').replace(/\D/g, '');  // stored barcode, digits only
  const scannedDig  = (scanInp ? scanInp.value.trim() : '').replace(/\D/g, ''); // what was entered/scanned

  // Compare digits-only --- handles leading zero mismatches (045778... vs 45778...)
  const upcMatch = rawBarcode.length > 0 && scannedDig.length > 0
    && (scannedDig === rawBarcode || scannedDig.replace(/^0+/,'') === rawBarcode.replace(/^0+/,''));

  if (!upcMatch) {
    const errEl = document.getElementById('picker-scan-error');
    if (errEl) errEl.innerHTML =
      '<strong>Wrong barcode.</strong>&nbsp; '
      + 'Expected: <code>' + (rawBarcode || '(no UPC on file)') + '</code> &nbsp;|&nbsp; '
      + 'Got: <code>' + whEsc(scanInp?.value.trim() || '') + '</code>';
    if (scanInp) { scanInp.style.borderColor = 'var(--red)'; scanInp.value = ''; scanInp.focus(); }
    pickerPlayError();
    pickerFlash('rgba(240,74,74,0.6)');
    return;
  }

  // SUCCESS     show confirmation prompt before advancing
  pickerPlaySuccess();
  pickerFlash('rgba(74,240,160,0.5)');
  pickerShowConfirm(pickedQty, item);
};

window.pickerEndSession = function() {
  if (!PickerState.completed.length) {
    if (!confirm('No items picked yet. Exit without a summary?')) return;
    pickerClose();
    return;
  }
  if (!confirm('End session early? You\'ve picked ' + PickerState.completed.length + ' of ' + PickerState.queue.length + ' items. A summary will be shown.')) return;
  pickerRenderComplete();
};

window.pickerBack = function() {
  if (PickerState.index === 0) return;
  PickerState.index--;
  PickerState.completed.pop();
  pickerRender();
};

//        CONFIRMATION STEP                                                                                                                            
// Shown after successful UPC scan     green card overlaid on the
// picker card. Picker can adjust qty one more time then confirm.
function pickerShowConfirm(pickedQty, item) {
  const overlay = document.getElementById('picker-overlay');
  if (!overlay) return;

  const destStr = item.destBins && item.destBins.length ? item.destBins.join('      ') : '   ';
  const extra   = pickedQty > item.qty ? '+' + (pickedQty - item.qty) + ' extra' : '';

  overlay.innerHTML =
    '<div style="width:100%;max-width:680px;background:var(--surface);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,0.18);display:flex;flex-direction:column;overflow:hidden;position:relative;">'

    // Green confirm header
    + '<div style="background:var(--green);color:#fff;padding:20px 28px;text-align:center;">'
    + '<div style="font-size:28px;margin-bottom:4px;">&#10003;</div>'
    + '<div style="font-size:16px;font-weight:700;">Barcode Confirmed</div>'
    + '<div style="font-size:12px;opacity:0.85;margin-top:2px;">' + whEsc(item.row.name) + '</div>'
    + '</div>'

    // Confirm qty block
    + '<div style="padding:28px 32px;display:flex;flex-direction:column;gap:20px;">'

    // Qty confirm     with arrows again
    + '<div style="text-align:center;">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:12px;">Confirm Pick Quantity</div>'
    + '<div style="display:flex;align-items:center;justify-content:center;gap:20px;">'
    + '<button onclick="pickerConfirmQtyAdj(-1)" style="width:56px;height:56px;border-radius:10px;border:2px solid var(--border2);background:var(--surface2);font-size:28px;font-weight:700;cursor:pointer;color:var(--text);line-height:1;">&#8722;</button>'
    + '<div style="text-align:center;min-width:100px;">'
    + '<input type="number" id="picker-confirm-qty" value="' + pickedQty + '" min="' + item.qty + '"'
    + ' style="font-family:\'DM Mono\',monospace;font-size:64px;font-weight:700;color:var(--text);background:transparent;border:none;outline:none;text-align:center;width:140px;line-height:1;"'
    + ' oninput="pickerConfirmQtyChange(this,' + item.qty + ')" />'
    + (extra ? '<div style="font-size:11px;color:var(--green);font-weight:600;margin-top:2px;">' + extra + '</div>' : '')
    + '<div style="font-size:10px;color:var(--text-muted);margin-top:2px;">suggested: ' + item.qty + '</div>'
    + '</div>'
    + '<button onclick="pickerConfirmQtyAdj(1)" style="width:56px;height:56px;border-radius:10px;border:2px solid var(--border2);background:var(--surface2);font-size:28px;font-weight:700;cursor:pointer;color:var(--text);line-height:1;">&#43;</button>'
    + '</div>'
    + '</div>'

    // Destination reminder
    + '<div style="padding:14px 20px;background:var(--green-bg);border-radius:8px;border:1px solid rgba(30,126,74,0.3);text-align:center;">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--green);margin-bottom:4px;">Place Into</div>'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:22px;font-weight:700;color:var(--green);">' + whEsc(destStr) + '</div>'
    + '</div>'

    + '</div>'

    // Buttons
    + '<div style="padding:16px 32px;border-top:1px solid var(--border);display:flex;gap:12px;background:var(--surface2);">'
    + '<button onclick="pickerConfirmGoBack()" style="flex:1;background:none;border:1px solid var(--border2);color:var(--text-muted);border-radius:8px;padding:14px;font-size:14px;font-weight:600;cursor:pointer;">&#8592; Back</button>'
    + '<button onclick="pickerCommit()" style="flex:2;background:var(--green);color:#fff;border:none;border-radius:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;letter-spacing:0.5px;">Confirm &amp; Next &#8594;</button>'
    + '</div>'

    + '</div>';

  // Focus confirm qty for keyboard entry
  setTimeout(() => document.getElementById('picker-confirm-qty')?.select(), 80);
}

window.pickerConfirmQtyChange = function(input, min) {
  const val = parseInt(input.value) || 0;
  input.style.color = val < min ? 'var(--red)' : 'var(--text)';
};

window.pickerConfirmQtyAdj = function(delta) {
  const input = document.getElementById('picker-confirm-qty');
  if (!input) return;
  const min = parseInt(input.min) || 1;
  const next = Math.max(min, (parseInt(input.value) || min) + delta);
  input.value = next;
  input.style.color = 'var(--text)';
  // Update extra label
  const item = PickerState.queue[PickerState.index];
  if (!item) return;
};

window.pickerConfirmGoBack = function() {
  // Return to the pick screen for this item without advancing
  pickerRender();
};

window.pickerCommit = function() {
  const qtyInput = document.getElementById('picker-confirm-qty');
  const item     = PickerState.queue[PickerState.index];
  if (!item) return;
  const finalQty = Math.max(item.qty, parseInt(qtyInput?.value) || item.qty);
  PickerState.completed.push({
    row:          item.row,
    bulkLoc:      item.bulkLoc,
    qty:          finalQty,
    suggestedQty: item.qty,
    destBins:     item.destBins,
    skipped:      false,
  });
  PickerState.index++;
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
    const dest = c.destBins && c.destBins.length ? c.destBins.join(', ') : '   ';
    const qtyExtra = (!c.skipped && c.suggestedQty && c.qty > c.suggestedQty)
      ? '<div style="font-size:9px;color:var(--green);margin-top:2px;">+' + (c.qty - c.suggestedQty) + ' extra</div>' : '';
    return '<tr style="' + (c.skipped ? 'opacity:0.45;' : '') + '">'
      + '<td style="font-family:\'DM Mono\',monospace;font-size:15px;font-weight:700;color:' + (c.skipped ? 'var(--text-muted)' : 'var(--accent)') + ';padding:12px 16px;border-bottom:1px solid var(--border);white-space:nowrap;">' + whEsc(c.bulkLoc) + '</td>'
      + '<td style="padding:12px 16px;border-bottom:1px solid var(--border);"><div style="font-weight:600;font-size:14px;">' + whEsc(c.row.name) + '</div><div style="font-family:\'DM Mono\',monospace;font-size:11px;color:var(--text-muted);">' + whEsc(c.row.sku) + '</div></td>'
      + '<td style="font-family:\'DM Mono\',monospace;font-size:22px;font-weight:700;text-align:center;padding:12px 16px;border-bottom:1px solid var(--border);color:' + (c.skipped ? 'var(--text-dim)' : 'var(--text)') + ';">' + (c.skipped ? '   ' : c.qty) + qtyExtra + '</td>'
      + '<td style="font-family:\'DM Mono\',monospace;font-size:16px;font-weight:800;color:var(--green);padding:12px 16px;border-bottom:1px solid var(--border);letter-spacing:1px;">' + whEsc(dest) + '</td>'
      + '<td style="padding:12px 16px;border-bottom:1px solid var(--border);text-align:center;">' + (c.skipped ? '<span style="color:var(--yellow);font-size:11px;font-weight:700;text-transform:uppercase;">Skipped</span>' : '<span style="color:var(--green);font-size:16px;">&#x2713;</span>') + '</td>'
      + '</tr>';
  }).join('');

  overlay.innerHTML = `
    <div style="width:100%;max-width:800px;background:var(--surface);border-radius:12px;box-shadow:0 24px 64px rgba(0,0,0,0.18);display:flex;flex-direction:column;max-height:92vh;overflow:hidden;">

      <!-- Success header -->
      <div style="background:var(--green);color:#fff;padding:24px 32px;text-align:center;">
        <div style="font-size:40px;margin-bottom:8px;">   </div>
        <div style="font-size:20px;font-weight:700;margin-bottom:4px;">Replenish Run Complete</div>
        <div style="font-size:13px;opacity:0.85;">${picked.length} locations replenished    ${totalUnits.toLocaleString()} units    ${skipped.length} skipped${elapsed !== null ? '    ' + elapsed + ' min' : ''}</div>
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
              <th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--green);border-bottom:2px solid var(--border);">&#8594; Place Into Pick Bin</th>
              <th style="padding:10px 16px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);border-bottom:2px solid var(--border);">Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>

      <!-- Footer -->
      <div style="padding:16px 32px;border-top:1px solid var(--border);display:flex;gap:12px;justify-content:flex-end;background:var(--surface2);">
        <button onclick="pickerPrintSummary()" style="background:var(--surface);border:1px solid var(--border2);color:var(--text);border-radius:6px;padding:10px 20px;font-size:13px;font-weight:600;cursor:pointer;">    Print Summary</button>
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
    const dest = c.destBins && c.destBins.length ? c.destBins.join(', ') : '   ';
    const extra = (!c.skipped && c.suggestedQty && c.qty > c.suggestedQty)
      ? '<br><span style="font-size:9px;color:#1e7e4a">+' + (c.qty - c.suggestedQty) + ' extra</span>' : '';
    return `<tr class="${c.skipped ? 'skipped' : ''}">
      <td class="mono loc">${c.bulkLoc}</td>
      <td><strong>${c.row.name}</strong><br><span class="mono small">${c.row.sku}</span></td>
      <td class="mono center qty">${c.skipped ? '   ' : c.qty}${extra}</td>
      <td class="mono dest">${dest}</td>
      <td class="center">${c.skipped ? 'SKIPPED' : '&#x2713;'}</td>
    </tr>`;
  }).join('');

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head><title>FP Replenish Summary     ${now}</title>
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
    <h1>Fat Possum Records     Replenish Summary</h1>
    <div class="meta">
      <span>     ${now}</span>
      <span>    ${picked.length} picked</span>
      <span>     ${totalUnits.toLocaleString()} units</span>
      ${skipped.length ? '<span>    ' + skipped.length + ' skipped</span>' : ''}
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
  <div class="footer">Fat Possum Records    Warehouse Replenish Sheet    ${now}</div>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
};

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// PRINT PICK LIST (pre-pick reference sheet)
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
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
    const destBins = r.pickLocs && r.pickLocs.length ? r.pickLocs.join(', ') : '   ';
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
  win.document.write(`<!DOCTYPE html><html><head><title>FP Pick List     ${now}</title>
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
      <h1>Fat Possum Records     Warehouse Pick List</h1>
      <div class="sub">${now}    Look-back: ${c.lookback}d    Days supply target: ${c.daysSupply}d    Walk order</div>
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
      <th>   </th>
      <th>Pull From</th>
      <th class="right">Move Qty</th>
      <th>Product</th>
      <th>Place Into (Pick Bin)</th>
      <th class="right">In Loc</th>
    </tr></thead>
    <tbody>${tableRows}</tbody>
  </table>
  <div class="footer">
    <span>Fat Possum Records    Warehouse Replenish Sheet    ${now}</span>
    <span>Picker: _______________________   Time started: ____________   Time complete: ____________</span>
  </div>
  </body></html>`);
  win.document.close();
  setTimeout(() => win.print(), 400);
};

function whEsc(s) { return String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// ── MOVEMENTS ENHANCER ──────────────────────────────────────────────────────
// Adds dates, collapse toggles, and "→ Invoice" button to movements table
(function() {
  const COLLAPSED_KEY = 'fp_mov_collapsed';

  function getCollapsed() {
    try { return JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '{}'); } catch(e) { return {}; }
  }
  function setCollapsed(key, val) {
    const c = getCollapsed(); c[key] = val;
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify(c)); } catch(e) {}
  }
  function fmtDate(iso) {
    if (!iso) return '';
    return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  }

  function enhanceMovements() {
    const tbody = document.getElementById('movements-tbody');
    if (!tbody) return;
    const collapsed = getCollapsed();
    const rows = [...tbody.querySelectorAll('tr')];
    let currentGroupKey = null;
    let currentGroupStatus = '';

    rows.forEach(function(row) {
      if (row.dataset.movEnhanced) return;
      row.dataset.movEnhanced = '1';
      const cells = [...row.querySelectorAll('td,th')];
      if (!cells.length) return;

      const firstCell = cells[0];
      const colspanVal = parseInt(firstCell.getAttribute('colspan') || '1');
      const isHeader = colspanVal >= 4;

      if (isHeader) {
        // Group header row
        currentGroupKey = row.dataset.shipmentId || (firstCell.textContent.trim().slice(0, 60));
        currentGroupStatus = row.dataset.status || '';

        // Add collapse toggle
        if (!row.querySelector('.mov-collapse-btn')) {
          const isCollapsed = collapsed[currentGroupKey] !== false; // default collapsed
          const btn = document.createElement('button');
          btn.className = 'mov-collapse-btn';
          btn.style.cssText = 'background:none;border:none;cursor:pointer;font-size:12px;padding:0 6px;color:var(--text-muted);vertical-align:middle;';
          btn.textContent = isCollapsed ? '▸' : '▾';
          const key = currentGroupKey;
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            const cur = getCollapsed()[key]; const nowCollapsed = cur === false ? true : false; // toggle from default-collapsed
            setCollapsed(key, nowCollapsed);
            btn.textContent = nowCollapsed ? '▸' : '▾';
            let sib = row.nextElementSibling;
            while (sib && !sib.querySelector('.mov-collapse-btn')) {
              sib.style.display = nowCollapsed ? 'none' : '';
              sib = sib.nextElementSibling;
            }
          });
          firstCell.insertBefore(btn, firstCell.firstChild);
        }

        // Apply saved collapsed state
        if (collapsed[currentGroupKey] !== false) { // default collapsed
          let sib = row.nextElementSibling;
          while (sib && !sib.querySelector('.mov-collapse-btn')) {
            sib.style.display = 'none';
            sib = sib.nextElementSibling;
          }
        }

        // Add date to header from first matching movement
        if (!row.querySelector('.mov-hdr-date') && typeof State !== 'undefined' && State.movements) {
          const grpKey = currentGroupKey;
          const mov = State.movements.find(function(m) {
            return grpKey.includes(m.shipmentId) || grpKey.includes(m.from + '\u2192' + m.to);
          });
          if (mov) {
            const ts = mov.confirmedAt || mov.shippedAt || mov.timestamp;
            const dateSpan = document.createElement('span');
            dateSpan.className = 'mov-hdr-date';
            dateSpan.style.cssText = 'font-size:10px;color:var(--text-muted);font-weight:400;margin-left:10px;';
            dateSpan.textContent = fmtDate(ts);
            firstCell.appendChild(dateSpan);
          }
        }

        // Add → Invoice button for confirmed/shipped groups
        if (!row.querySelector('.mov-invoice-btn')) {
          const key = currentGroupKey;
          const lastCell = cells[cells.length - 1];
          if (lastCell) {
            const btn = document.createElement('button');
            btn.className = 'mov-invoice-btn';
            btn.style.cssText = 'margin-left:8px;background:var(--accent);color:#fff;border:none;border-radius:3px;padding:3px 10px;font-size:10px;font-weight:700;cursor:pointer;';
            btn.textContent = '\u2192 Invoice';
            btn.title = 'Create invoice from this shipment';
            btn.addEventListener('click', function(e) {
              e.stopPropagation();
              movCreateInvoice(key);
            });
            lastCell.appendChild(btn);
          }
        }

      }
    });
  }

  function movCreateInvoice(groupKey) {
    if (typeof window.switchToInvoices !== 'function') { alert('Invoice module not loaded.'); return; }
    const movs = (typeof State !== 'undefined' && State.movements)
      ? State.movements.filter(function(m) {
          return groupKey.includes(m.shipmentId) || groupKey.includes((m.from||'') + '\u2192' + (m.to||''));
        })
      : [];
    if (!movs.length) { alert('Could not match movements for this group.'); return; }

    switchToInvoices('new');

    setTimeout(function() {
      if (!window.InvState || !InvState.draft) return;
      const inv = InvState.draft;
      inv.poNumber = movs[0].poNumber || '';
      inv.notes    = 'Stock movement: ' + (movs[0].from||'') + ' \u2192 ' + (movs[0].to||'');

      movs.forEach(function(m) {
        const catalog = (typeof State !== 'undefined' && State.merged)
          ? State.merged.find(function(p) { return p.catalog === m.catalog || p.upc === m.upc; })
          : null;
        const price = parseFloat((window.InvState && InvState.priceCatalog[m.catalog]) || (window.InvState && InvState.priceCatalog[m.upc]) || 0);
        inv.items.push({ sku:m.catalog||'', artist:m.artist||'', title:m.title||'', catalog:m.catalog||'', upc:m.upc||'', format:m.format||'', qty:m.qty||1, price:price, onHand:catalog ? catalog.fp_available : undefined });
      });

      if (typeof invRender === 'function') invRender();
      if (window.toast) toast(movs.length + ' items added to invoice draft.', 'success');
    }, 300);
  }

  function reverseMovementGroups() {
    const tbody = document.getElementById('movements-tbody');
    if (!tbody) return;
    // Collect rows into groups
    const rows = [...tbody.querySelectorAll('tr')];
    const groups = [];
    let current = [];
    rows.forEach(function(row) {
      const firstCell = row.querySelector('td,th');
      const colspanVal = firstCell ? parseInt(firstCell.getAttribute('colspan')||'1') : 1;
      if (colspanVal >= 3 && current.length) { groups.push(current); current = []; }
      current.push(row);
    });
    if (current.length) groups.push(current);
    // Reverse and re-append
    groups.reverse().forEach(function(grp) {
      grp.forEach(function(row) { tbody.appendChild(row); });
    });

  }

  document.addEventListener('DOMContentLoaded', function() {
    const check = setInterval(function() {
      const tbody = document.getElementById('movements-tbody');
      if (!tbody) return;
      clearInterval(check);
      enhanceMovements();
      var _movLock = false;
      new MutationObserver(function() {
        if (_movLock) return;
        _movLock = true;
        setTimeout(function() {
          enhanceMovements();
              setTimeout(function() { _movLock = false; }, 200);
        }, 80);
      }).observe(tbody, { childList: true, subtree: true });
    }, 500);
  });
})();
