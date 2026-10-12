/* ============================================================
   FAT POSSUM -- PRE-ORDER CAMPAIGN MANAGER  v20261012
   preorder_module.js
   Tracks operator-held pre-order campaigns and releases them
   via PATCH /orders/{id} operator_hold: 0
   v20261012: qty filter, row checkboxes, "select next N units",
              release-selected waves, partial releases keep the
              remaining orders listed (no refresh needed).
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────
const POState = {
  campaigns:       [],
  orders:          {},
  loading:         {},
  releasing:       {},
  expandedOrders:  {},
  tagFilters:      {},  // { campaignId: ['tag1','tag2'] }
  holdFilters:     {},  // { campaignId: ['operator','date','allocation','address'] }
  searchTerms:     {},  // { campaignId: 'searchText' }
  qtyFilters:      {},  // { campaignId: { min: number|null, max: number|null } }
  selected:        {},  // { campaignId: { orderId: true } }
  nextUnits:       {},  // { campaignId: last "select next N units" value }
};

// ── NAV TOGGLE ───────────────────────────────────────────────
window.togglePreOrderNav = function(e) {
  e.preventDefault();
  switchToPreOrders();
};

// ── PERSISTENCE ──────────────────────────────────────────────
const PO_LS_KEY   = 'fp_preorder_campaigns';
const PO_GIST_FILE = 'fp_preorders.json';

async function savePreOrderData() {
  // 1. Save to localStorage immediately
  try {
    localStorage.setItem(PO_LS_KEY, JSON.stringify(POState.campaigns));
    localStorage.setItem(PO_LS_KEY + '_orders', JSON.stringify({
      orders: Object.fromEntries(Object.entries(POState.orders).map(([k,v]) => [k, Array.isArray(v) ? v : []])),
      refreshedAt: POState.ordersRefreshedAt || {}, ts: Date.now()
    }));
  } catch(e) {}

  // 2. Fetch current Gist, merge, then save — prevents overwriting concurrent changes
  let _gistId;
  try { _gistId = CONFIG.GIST_ID; } catch(e) {}
  if (!_gistId) { try { const c=JSON.parse(localStorage.getItem('fp_config_cache')||'{}'); _gistId=c.GIST_ID; } catch(e) {} }
  if (!_gistId) return;

  try {
    // Fetch current state
    let base = { preOrderCampaigns: [], ordersCache: {}, ordersRefreshedAt: {} };
    try {
      const content = await fetchGistFile(PO_GIST_FILE);
      if (content) base = JSON.parse(content);
    } catch(e) {}

    // Merge campaigns — our version wins for campaigns we own by ID
    const ourIds = new Set(POState.campaigns.map(function(c) { return c.id; }));
    const theirCampaigns = (base.preOrderCampaigns || []).filter(function(c) { return !ourIds.has(c.id); });
    const mergedCampaigns = theirCampaigns.concat(POState.campaigns);

    const payload = {
      preOrderCampaigns: mergedCampaigns,
      ordersCache: Object.fromEntries(
        Object.entries(POState.orders).map(([k,v]) => [k, Array.isArray(v) ? v : []])
      ),
      ordersRefreshedAt: POState.ordersRefreshedAt || {},
      ordersCacheTs: Date.now(),
    };

    const res = await fetch(gistUrl(_gistId), {
      method: 'PATCH',
      headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
      body: JSON.stringify({ files: { [PO_GIST_FILE]: { content: JSON.stringify(payload) } } }),
    });
    if (!res.ok) console.warn('Pre-order Gist save failed:', res.status);
  } catch(e) {
    console.warn('Pre-order Gist save error:', e.message);
  }

  updatePOBadge();
}

async function loadPreOrderData(creds) {
  try {
    let gistId;
    if (creds) {
      gistId = creds.gistId;
    } else {
      try { gistId = CONFIG.GIST_ID; } catch(e) {}
    }
    if (!gistId) { console.warn('Pre-order load: no credentials'); return; }
    const fileContent = await fetchGistFile(PO_GIST_FILE);
    if (fileContent) {
        const data = JSON.parse(fileContent);
        if (data.preOrderCampaigns && data.preOrderCampaigns.length) {
          POState.campaigns = data.preOrderCampaigns;
          // Restore cached orders so we don't need to re-scan on every load
          if (data.ordersCache) {
            POState.orders = data.ordersCache;
            if (data.ordersRefreshedAt) POState.ordersRefreshedAt = data.ordersRefreshedAt;
            const ts = data.ordersCacheTs ? new Date(data.ordersCacheTs).toLocaleString() : 'unknown';
            console.log('Pre-order orders restored from cache (last refreshed: ' + ts + ')');
          }
          try {
      localStorage.setItem(PO_LS_KEY, JSON.stringify(POState.campaigns));
      localStorage.setItem(PO_LS_KEY + '_orders', JSON.stringify({
          orders: Object.fromEntries(Object.entries(POState.orders).map(([k,v]) => [k, Array.isArray(v) ? v : []])),
          refreshedAt: POState.ordersRefreshedAt || {},
          ts: Date.now()
        }));
    } catch(e) {}
          updatePOBadge();
          console.log('Pre-order campaigns from Gist:', POState.campaigns.length);
          const view = document.getElementById('view-preorders');
          if (view && !view.classList.contains('hidden')) renderPreOrders();
        }
    }
  } catch(e) {
    console.warn('Pre-order Gist load failed:', e.message);
  }
}

// ── VIEW ENTRY ────────────────────────────────────────────────
window.switchToPreOrders = function() {
  switchView('preorders');
  renderPreOrders();
  checkReleaseDates();
  // Auto-refresh if enabled in settings
  if (window._FPUserSettings?.poAutoRefresh) {
    setTimeout(() => poRefreshAll(), 500);
  }
};

// ── IMMEDIATE INIT — restore from localStorage before anything renders ──
(function() {
  try {
    const cached = localStorage.getItem(PO_LS_KEY);
    if (cached) {
      POState.campaigns = JSON.parse(cached);
      console.log('Pre-order campaigns restored immediately:', POState.campaigns.length);
      document.addEventListener('DOMContentLoaded', () => updatePOBadge());
    }
    // Also restore orders cache from localStorage
    const ordersCache = localStorage.getItem(PO_LS_KEY + '_orders');
    if (ordersCache) {
      const parsed = JSON.parse(ordersCache);
      POState.orders = parsed.orders || {};
      POState.ordersRefreshedAt = parsed.refreshedAt || {};
      console.log('Pre-order orders cache restored from localStorage');
    }
  } catch(e) {}
})();

// Load on boot — retry until CONFIG is ready (set by app.js)
document.addEventListener('DOMContentLoaded', function() {
  let attempts = 0;
  function getCredentials() {
    // Try direct CONFIG access first (works if in same scope)
    try {
      if (typeof CONFIG !== 'undefined' && CONFIG.GIST_ID) {
        return { gistId: CONFIG.GIST_ID };
      }
    } catch(e) {}
    // Fall back to reading from localStorage config cache
    try {
      const cached = localStorage.getItem('fp_config_cache');
      if (cached) {
        const obj = JSON.parse(cached);
        if (obj.GIST_ID) return { gistId: obj.GIST_ID };
      }
    } catch(e) {}
    return null;
  }

  function tryLoad() {
    attempts++;
    const creds = getCredentials();
    if (creds) {
      loadPreOrderData(creds);
    } else if (attempts < 20) {
      setTimeout(tryLoad, 500);
    } else {
      console.warn('Pre-order: credentials never became available after 10s');
    }
  }
  setTimeout(tryLoad, 800); // first attempt after 800ms
});

// Manual refresh — loads all active campaigns sequentially
window.poRefreshAll = async function() {
  const active = POState.campaigns.filter(c => c.status === 'active');
  if (!active.length) { toast('No active campaigns to refresh.', ''); return; }
  for (const c of active) {
    await loadCampaignOrders(c);
    if (active.length > 1) await new Promise(r => setTimeout(r, 800));
  }
};

// Auto-check release dates every time we load the view or on boot
function checkReleaseDates() {
  const el = document.getElementById('po-release-due-banner');
  if (!el) return;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  POState.dismissedReleaseBanners = POState.dismissedReleaseBanners || {};
  const overdue = POState.campaigns.filter(function(c) {
    if (c.status !== 'active' || POState.dismissedReleaseBanners[c.id]) return false;
    const rel = new Date(c.releaseDate);
    rel.setHours(0, 0, 0, 0);
    return rel <= today;
  });
  if (!overdue.length) { el.style.display = 'none'; el.innerHTML = ''; return; }
  // Show one row per overdue campaign — don't auto-release, require manual confirm per campaign
  el.style.display = 'flex';
  el.style.flexDirection = 'column';
  el.style.gap = '6px';
  el.innerHTML = overdue.map(function(c) {
    return '<div style="display:flex;align-items:center;gap:12px;">'
      + '<span style="flex:1;font-weight:600;">&#128276; Release date reached for <strong>' + poEsc(c.name) + '</strong></span>'
      + '<button onclick="poConfirmRelease(\'' + c.id + '\')" style="background:#fff;color:var(--accent);border:none;border-radius:4px;padding:6px 16px;font-weight:700;cursor:pointer;font-size:12px;">Release Now</button>'
      + '<button onclick="poDismissReleaseBanner(\'' + c.id + '\')" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:18px;cursor:pointer;">&#x2715;</button>'
      + '</div>';
  }).join('');
}

window.poDismissReleaseBanner = function(id) {
  POState.dismissedReleaseBanners = POState.dismissedReleaseBanners || {};
  POState.dismissedReleaseBanners[id] = true;
  checkReleaseDates();
};

// ── SHARED FILTERING ─────────────────────────────────────────
// One place that decides which orders are "visible" — used by the table,
// the selection bar, "select next N units", and both release buttons.
const PO_ALLOWED_TAGS = ['B2B', 'D2C', 'International'];

const PO_HOLD_TYPES = [
  { key: 'operator',   label: 'Operator Hold',   test: function(o){ return !!o.operatorHold; } },
  { key: 'date',       label: 'Date Hold',        test: function(o){ return !!o.holdUntil; } },
  { key: 'allocation', label: 'Allocation Hold',  test: function(o){ return !!o.allocationHold; } },
  { key: 'address',    label: 'Address Hold',     test: function(o){ return !!o.addressHold; } },
];

function poHoldTest(key) {
  const h = PO_HOLD_TYPES.find(function(x){ return x.key === key; });
  return h ? h.test : function(){ return false; };
}

function poGetFilterState(campaignId) {
  const activeTags  = (POState.tagFilters  || {})[campaignId] || [];
  const activeHolds = (POState.holdFilters || {})[campaignId] || [];
  const searchTerm  = (POState.searchTerms || {})[campaignId] || '';
  const qf          = (POState.qtyFilters  || {})[campaignId] || {};
  const qtyMin      = (typeof qf.min === 'number') ? qf.min : null;
  const qtyMax      = (typeof qf.max === 'number') ? qf.max : null;
  const hasQty      = qtyMin !== null || qtyMax !== null;
  const hasFilters  = !!(activeTags.length || activeHolds.length || searchTerm || hasQty);
  return { activeTags, activeHolds, searchTerm, qtyMin, qtyMax, hasQty, hasFilters };
}

function poGetFilteredOrders(campaignId) {
  const orders = POState.orders[campaignId] || [];
  const f = poGetFilterState(campaignId);
  const term = f.searchTerm.toLowerCase();
  return orders.filter(function(o) {
    if (f.activeTags.length && !f.activeTags.every(at => (o.tags||[]).some(t => t.toLowerCase()===at.toLowerCase()))) return false;
    if (f.activeHolds.length && !f.activeHolds.some(function(hk){ return poHoldTest(hk)(o); })) return false;
    if (term && !(o.orderNumber || '').toLowerCase().includes(term)) return false;
    if (f.qtyMin !== null && o.qty < f.qtyMin) return false;
    if (f.qtyMax !== null && o.qty > f.qtyMax) return false;
    return true;
  });
}

// Selected orders = selected AND currently visible under the filters
function poGetSelectedOrders(campaignId) {
  const sel = (POState.selected || {})[campaignId] || {};
  return poGetFilteredOrders(campaignId).filter(function(o){ return !!sel[o.orderId]; });
}

function poSumUnits(orders) {
  return orders.reduce(function(s, o){ return s + (o.qty || 0); }, 0);
}

// Drop any selected orders that are no longer visible — what you see is what you release
function poPruneSelection(campaignId) {
  const sel = (POState.selected || {})[campaignId];
  if (!sel) return;
  const visible = new Set(poGetFilteredOrders(campaignId).map(function(o){ return o.orderId; }));
  Object.keys(sel).forEach(function(id){ if (!visible.has(id)) delete sel[id]; });
}

// Called whenever a filter changes
function poOnFilterChange(campaignId) {
  const f = poGetFilterState(campaignId);
  if (!POState.expandedOrders) POState.expandedOrders = {};
  if (f.activeTags.length || f.activeHolds.length || f.hasQty) POState.expandedOrders[campaignId] = true;
  poPruneSelection(campaignId);
  poRenderKeepFocus();
}

// Re-render without losing focus/caret in the search or qty inputs
function poRenderKeepFocus() {
  const ae = document.activeElement;
  const focusId = ae && ae.id ? ae.id : null;
  let selStart = null, selEnd = null;
  try { if (ae && ae.type === 'text') { selStart = ae.selectionStart; selEnd = ae.selectionEnd; } } catch(e) {}
  renderPreOrders();
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el) {
      el.focus();
      try { if (selStart !== null) el.setSelectionRange(selStart, selEnd); } catch(e) {}
    }
  }
}

// ── MAIN RENDER ───────────────────────────────────────────────
function renderPreOrders() {
  const body = document.getElementById('po-body');
  if (!body) return;

  const active   = POState.campaigns.filter(c => c.status === 'active');
  const released = POState.campaigns.filter(c => c.status === 'released');
  const archived = POState.campaigns.filter(c => c.status === 'archived');

  if (!POState.campaigns.length) {
    body.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);">'
      + '<div style="font-size:40px;margin-bottom:16px;">&#127911;</div>'
      + '<div style="font-size:16px;font-weight:600;margin-bottom:8px;">No pre-order campaigns yet</div>'
      + '<div style="font-size:13px;margin-bottom:24px;">Create a campaign to track held pre-orders and release them on a fixed date.</div>'
      + '<button onclick="poOpenModal()" class="btn-primary">+ New Campaign</button>'
      + '</div>';
    return;
  }

  let html = '';

  if (active.length) {
    html += '<div style="margin-bottom:32px;">';
    html += poSectionHeader('Active Campaigns', active.length);
    active.forEach(c => { html += poCampaignCard(c); });
    html += '</div>';
  }

  if (released.length) {
    html += '<div style="margin-bottom:32px;">';
    html += poSectionHeader('Released', released.length);
    released.forEach(c => { html += poCampaignCard(c); });
    html += '</div>';
  }

  if (archived.length) {
    html += '<details style="margin-bottom:16px;">'
      + '<summary style="cursor:pointer;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);padding:8px 0;">Archived (' + archived.length + ')</summary>'
      + '<div style="margin-top:12px;">';
    archived.forEach(c => { html += poCampaignCard(c); });
    html += '</div></details>';
  }

  body.innerHTML = html;

  // Attach real DOM buttons with event listeners to each campaign card
  for (const c of POState.campaigns) {
    const isActive   = c.status === 'active';
    const isReleased = c.status === 'released';
    poAttachButtons(c.id, isActive, isReleased);

    // Attach search input listener
    const searchInput = document.getElementById('po-search-' + c.id);
    if (searchInput) {
      searchInput.addEventListener('input', function() {
        if (!POState.searchTerms) POState.searchTerms = {};
        POState.searchTerms[c.id] = this.value;
        poOnFilterChange(c.id);
      });
    }

    // Attach qty min/max listeners
    ['min', 'max'].forEach(function(which) {
      const input = document.getElementById('po-qty' + which + '-' + c.id);
      if (!input) return;
      input.addEventListener('input', function() {
        if (!POState.qtyFilters) POState.qtyFilters = {};
        if (!POState.qtyFilters[c.id]) POState.qtyFilters[c.id] = { min: null, max: null };
        const raw = this.value.trim();
        const parsed = raw === '' ? null : parseInt(raw, 10);
        POState.qtyFilters[c.id][which] = (parsed === null || isNaN(parsed)) ? null : parsed;
        poOnFilterChange(c.id);
      });
    });

    // Attach tag pill listeners
    const orders = POState.orders[c.id] || [];
    const presentTags = PO_ALLOWED_TAGS.filter(t =>
      orders.some(o => (o.tags||[]).some(ot => ot.toLowerCase() === t.toLowerCase()))
    );
    presentTags.forEach(function(tag) {
      const pill = document.getElementById('po-tag-' + c.id + '-' + tag.replace(/\s+/g, '-'));
      if (!pill) return;
      pill.addEventListener('click', function() {
        if (!POState.tagFilters) POState.tagFilters = {};
        if (!POState.tagFilters[c.id]) POState.tagFilters[c.id] = [];
        const tagIdx = POState.tagFilters[c.id].indexOf(tag);
        if (tagIdx > -1) POState.tagFilters[c.id].splice(tagIdx, 1);
        else POState.tagFilters[c.id].push(tag);
        poOnFilterChange(c.id);
      });
    });

    // Hold type pill click handlers
    PO_HOLD_TYPES.forEach(function(h) {
      const hk = h.key;
      const pill = document.getElementById('po-hold-' + c.id + '-' + hk);
      if (!pill) return;
      pill.addEventListener('click', function() {
        if (!POState.holdFilters) POState.holdFilters = {};
        if (!POState.holdFilters[c.id]) POState.holdFilters[c.id] = [];
        const idx = POState.holdFilters[c.id].indexOf(hk);
        if (idx > -1) POState.holdFilters[c.id].splice(idx, 1);
        else POState.holdFilters[c.id].push(hk);
        poOnFilterChange(c.id);
      });
    });

    // Sync checkbox / selection bar state
    poUpdateSelectionUI(c.id);
  }
}

function poCardButtons(id, isActive, isReleased) {
  // Return a placeholder div — real buttons with listeners attached after render
  return '<div id="po-btns-' + id + '" class="po-btn-placeholder"></div>';
}

function poAttachButtons(id, isActive, isReleased) {
  var placeholder = document.getElementById('po-btns-' + id);
  if (!placeholder) return;
  var d = document.createElement('div');
  d.style.cssText = 'padding:10px 20px;background:var(--surface2);display:flex;align-items:center;gap:8px;flex-wrap:wrap;';
  if (isActive) {
    var r = document.createElement('button');
    r.className = 'btn-secondary btn-sm';
    r.textContent = '↻ Refresh Orders';
    r.addEventListener('click', function() { loadCampaignOrders(id); });
    d.appendChild(r);
    var isReleasing = !!(POState.releasing && POState.releasing[id]);
    var f = poGetFilterState(id);
    var filteredCount = poGetFilteredOrders(id).length;
    var rel = document.createElement('button');
    rel.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:6px 16px;font-size:11px;font-weight:700;cursor:pointer;';
    rel.innerHTML = isReleasing ? 'Releasing…'
      : f.hasFilters ? '&#9654; Release All Filtered (' + filteredCount + ')'
      : '&#9654; Release All Holds';
    if (isReleasing) { rel.disabled = true; rel.style.opacity = '0.6'; rel.style.cursor = 'default'; }
    rel.addEventListener('click', function() { poConfirmRelease(id); });
    d.appendChild(rel);
  }
  if (isReleased) {
    var a = document.createElement('button');
    a.className = 'btn-secondary btn-sm';
    a.textContent = 'Archive';
    a.addEventListener('click', function() { poArchive(id); });
    d.appendChild(a);
  }
  var e = document.createElement('button');
  e.className = 'btn-secondary btn-sm';
  e.textContent = 'Edit';
  e.addEventListener('click', function() { poOpenModal(id); });
  d.appendChild(e);
  var del = document.createElement('button');
  del.className = 'btn-secondary btn-sm';
  del.style.cssText = 'color:var(--red);margin-left:auto;';
  del.textContent = 'Delete';
  del.addEventListener('click', function() { poDelete(id); });
  d.appendChild(del);
  placeholder.replaceWith(d);
}


function poSectionHeader(label, count) {
  return '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);display:flex;align-items:center;gap:10px;padding-bottom:8px;border-bottom:2px solid var(--border);margin-bottom:16px;">'
    + label + ' <span style="background:var(--accent);color:#fff;border-radius:10px;padding:1px 8px;font-size:10px;">' + count + '</span>'
    + '</div>';
}

function poCampaignCard(c) {
  const today     = new Date(); today.setHours(0,0,0,0);
  const relDate   = new Date(c.releaseDate); relDate.setHours(0,0,0,0);
  const daysLeft  = Math.ceil((relDate - today) / 86400000);
  const isPast    = daysLeft < 0;
  const isToday   = daysLeft === 0;
  const isActive  = c.status === 'active';
  const isReleased = c.status === 'released';

  const orders    = POState.orders[c.id] || [];
  const loading   = POState.loading[c.id];
  const totalOrders = orders.length;
  const totalUnits  = poSumUnits(orders);

  // Countdown color
  const countdownColor = isPast ? 'var(--red)' : isToday ? 'var(--red)' : daysLeft <= 3 ? 'var(--yellow)' : 'var(--green)';
  const countdownText  = isPast ? Math.abs(daysLeft) + 'd overdue' : isToday ? 'Today' : daysLeft + 'd';

  let statusBadge = '';
  if (isActive && isPast)   statusBadge = '<span class="pill pill-out" style="font-size:10px;">OVERDUE</span>';
  else if (isActive && isToday) statusBadge = '<span class="pill pill-urgent" style="font-size:10px;">RELEASE TODAY</span>';
  else if (isActive)        statusBadge = '<span class="pill pill-ok" style="font-size:10px;">Active</span>';
  else if (isReleased)      statusBadge = '<span class="pill pill-plan" style="font-size:10px;">Released</span>';
  else                      statusBadge = '<span class="pill" style="font-size:10px;background:var(--surface2);color:var(--text-muted);">Archived</span>';

  const skuList = (c.skus || []).map(s => '<code style="background:var(--surface2);padding:2px 6px;border-radius:3px;font-size:11px;margin-right:4px;">' + poEsc(s) + '</code>').join('');

  // Only show these specific tags as filter options
  const allTags = PO_ALLOWED_TAGS.filter(t =>
    (orders || []).some(o => (o.tags || []).some(ot => ot.toLowerCase() === t.toLowerCase()))
  );
  const f = poGetFilterState(c.id);
  if (!POState.expandedOrders) POState.expandedOrders = {};

  // Only show hold types that actually appear in the data
  const activeHoldTypes = PO_HOLD_TYPES.filter(function(h){ return (orders||[]).some(h.test); });

  // Apply search + tag + hold + qty filter
  const filteredOrders = poGetFilteredOrders(c.id);
  const filteredUnits  = poSumUnits(filteredOrders);

  const showAll = !!POState.expandedOrders[c.id];
  const shown   = showAll ? filteredOrders : filteredOrders.slice(0, 10);

  let orderRowsHtml = '';
  if (loading) {
    orderRowsHtml = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">Loading orders…</div>';
  } else if (!orders.length && isActive) {
    orderRowsHtml = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px;">No held orders found. Refresh orders first.</div>';
  } else if (orders.length) {
    const th = 'padding:7px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);';
    const numInput = 'padding:5px 6px;font-size:12px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);font-family:monospace;width:60px;';

    // Search + tag filter bar
    const tagPills = allTags.map(t =>
      '<span id="po-tag-' + c.id + '-' + poEsc(t.replace(/\s+/g,'-')) + '" style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:600;cursor:pointer;margin-right:4px;margin-bottom:4px;'
      + (f.activeTags.includes(t) ? 'background:var(--accent);color:#fff;' : 'background:var(--surface2);color:var(--text-muted);border:1px solid var(--border2);') + '">'
      + poEsc(t) + '</span>'
    ).join('');

    const holdPills = activeHoldTypes.map(function(h) {
      const isOn = f.activeHolds.includes(h.key);
      return '<span id="po-hold-' + c.id + '-' + h.key + '" style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:600;cursor:pointer;margin-right:4px;margin-bottom:4px;'
        + (isOn ? 'background:var(--red);color:#fff;' : 'background:var(--surface2);color:var(--text-muted);border:1px solid var(--border2);') + '">'
        + poEsc(h.label) + '</span>';
    }).join('');

    const qtyFilterHtml = '<div style="display:flex;align-items:center;gap:4px;border-left:1px solid var(--border2);padding-left:10px;">'
      + '<span style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Units</span>'
      + '<input id="po-qtymin-' + c.id + '" type="number" min="0" placeholder="min" value="' + (f.qtyMin !== null ? f.qtyMin : '') + '" style="' + numInput + '" />'
      + '<span style="color:var(--text-muted);font-size:11px;">–</span>'
      + '<input id="po-qtymax-' + c.id + '" type="number" min="0" placeholder="max" value="' + (f.qtyMax !== null ? f.qtyMax : '') + '" style="' + numInput + '" />'
      + '</div>';

    // Last refreshed timestamp
    const refreshedAt = (POState.ordersRefreshedAt || {})[c.id];
    const refreshedStr = refreshedAt
      ? 'Last refreshed ' + timeAgo(refreshedAt)
      : 'Not yet refreshed this session';

    const filterBar = '<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--surface2);">'
      + '<input id="po-search-' + c.id + '" type="text" placeholder="Search order #…" value="' + poEsc(f.searchTerm) + '"'
      + ' style="padding:5px 10px;font-size:12px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);font-family:monospace;width:160px;" />'
      + (allTags.length ? '<div style="display:flex;flex-wrap:wrap;gap:0;border-right:1px solid var(--border2);padding-right:10px;margin-right:2px;">' + tagPills + '</div>' : '')
      + (activeHoldTypes.length ? '<div style="display:flex;flex-wrap:wrap;gap:0;">' + holdPills + '</div>' : '')
      + qtyFilterHtml
      + '<span id="po-filter-count-' + c.id + '" style="font-size:11px;color:var(--text-muted);">' + (f.hasFilters ? filteredOrders.length + ' of ' + orders.length + ' orders · ' + filteredUnits + ' units' : '') + '</span>'
      + (f.hasFilters ? '' : '<span style="font-size:10px;color:var(--text-dim);margin-left:auto;">' + refreshedStr + '</span>')
      + '</div>';

    // Selection bar — select next N units / release selected (active campaigns only)
    const nextVal = (POState.nextUnits || {})[c.id] || '';
    const selBar = isActive
      ? '<div id="po-selbar-' + c.id + '" style="padding:8px 16px;border-bottom:1px solid var(--border);display:flex;gap:8px;align-items:center;flex-wrap:wrap;background:var(--surface);">'
        + '<span style="font-size:11px;color:var(--text-muted);">Select next</span>'
        + '<input id="po-nextn-' + c.id + '" type="number" min="1" placeholder="units" value="' + poEsc(nextVal) + '" style="' + numInput + 'width:70px;" />'
        + '<span style="font-size:11px;color:var(--text-muted);">units</span>'
        + '<button class="btn-secondary btn-sm po-btn" data-action="select-next" data-cid="' + c.id + '">Select</button>'
        + '<span style="font-size:10px;color:var(--text-dim);">(oldest first, within current filter)</span>'
        + '<span id="po-selcount-' + c.id + '" style="margin-left:auto;font-size:12px;font-weight:600;color:var(--text);font-family:\'DM Mono\',monospace;"></span>'
        + '<button id="po-selclear-' + c.id + '" class="btn-secondary btn-sm po-btn" data-action="clear-selection" data-cid="' + c.id + '">Clear</button>'
        + '<button id="po-selrelease-' + c.id + '" class="po-btn" data-action="release-selected" data-cid="' + c.id + '"'
        + ' style="background:var(--accent);color:#fff;border:none;border-radius:3px;padding:6px 16px;font-size:11px;font-weight:700;cursor:pointer;">&#9654; Release Selected</button>'
        + '</div>'
      : '';

    const selHeader = isActive
      ? '<th style="' + th + 'text-align:center;width:32px;"><input type="checkbox" class="po-sel-all" data-cid="' + c.id + '" title="Select all ' + filteredOrders.length + ' filtered orders" style="cursor:pointer;width:15px;height:15px;" /></th>'
      : '';
    const colCount = isActive ? 6 : 5;

    orderRowsHtml = filterBar
      + selBar
      + '<table id="po-table-' + c.id + '" style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="background:var(--surface2);">'
      + selHeader
      + '<th style="'+th+'text-align:left;">Order #</th>'
      + '<th style="'+th+'text-align:left;">Date</th>'
      + '<th style="'+th+'text-align:left;">Tags</th>'
      + '<th style="'+th+'text-align:right;">Units</th>'
      + '<th style="'+th+'text-align:center;">Hold</th>'
      + '</tr></thead><tbody>'
      + (shown.length ? shown.map(o => '<tr data-order-id="' + o.orderId + '" style="border-bottom:1px solid var(--border);">'
          + (isActive ? '<td style="padding:8px 10px;text-align:center;"><input type="checkbox" class="po-sel" data-cid="' + c.id + '" data-oid="' + poEsc(o.orderId) + '" style="cursor:pointer;width:15px;height:15px;" /></td>' : '')
          + '<td style="padding:8px 10px;font-family:\'DM Mono\',monospace;font-weight:600;color:var(--accent);">' + poEsc(o.orderNumber) + '</td>'
          + '<td style="padding:8px 10px;color:var(--text-muted);white-space:nowrap;">' + new Date(o.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</td>'
          + '<td style="padding:8px 10px;">' + (o.tags||[]).filter(t => PO_ALLOWED_TAGS.some(a => a.toLowerCase()===t.toLowerCase())).map(t => '<span style="background:var(--surface2);padding:1px 6px;border-radius:10px;font-size:10px;margin-right:3px;border:1px solid var(--border2);">' + poEsc(t) + '</span>').join('') + '</td>'
          + '<td style="padding:8px 10px;text-align:right;font-family:\'DM Mono\',monospace;font-weight:600;">' + o.qty + '</td>'
          + '<td style="padding:8px 10px;text-align:center;">'
          + (o.operatorHold ? '<span style="color:var(--red);font-size:11px;font-weight:700;">&#9632; Op Hold</span>'
            : o.holdUntil ? '<span style="color:var(--yellow);font-size:11px;font-weight:700;">&#9632; Date Hold</span>'
            : '<span style="color:var(--text-dim);font-size:11px;">&#9633; Open</span>')
          + '</td>'
          + '</tr>').join('')
        : '<tr><td colspan="' + colCount + '" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No orders match this filter.</td></tr>')
      + '</tbody></table>'
      + (filteredOrders.length > 10
        ? '<div style="text-align:center;padding:10px;border-top:1px solid var(--border);">'
          + '<button class="btn-secondary btn-sm po-btn" data-action="' + (showAll ? 'collapse' : 'expand') + '" data-cid="' + c.id + '">'
          + (showAll ? '&#9650; Show less' : '&#9660; Show all ' + filteredOrders.length + ' orders') + '</button>'
          + '</div>'
        : '');
  }
  return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;margin-bottom:16px;overflow:hidden;'
    + (isActive && (isPast || isToday) ? 'border-left:4px solid var(--red);' : isActive ? 'border-left:4px solid var(--green);' : '')
    + '">'

    // Card header
    + '<div style="padding:16px 20px;display:flex;align-items:flex-start;gap:16px;border-bottom:1px solid var(--border);">'

    // Countdown clock
    + '<div style="flex-shrink:0;text-align:center;min-width:64px;padding:10px 12px;background:var(--surface2);border-radius:6px;">'
    + '<div style="font-family:\'DM Mono\',monospace;font-size:26px;font-weight:700;color:' + countdownColor + ';line-height:1;">' + (isReleased ? '&#10003;' : countdownText) + '</div>'
    + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);margin-top:3px;">' + (isReleased ? 'Done' : isPast || isToday ? 'release' : 'to release') + '</div>'
    + '</div>'

    // Campaign info
    + '<div style="flex:1;min-width:0;">'
    + '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap;">'
    + '<span style="font-size:15px;font-weight:700;color:var(--text);">' + poEsc(c.name) + '</span>'
    + statusBadge
    + '</div>'
    + '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">'
    + '&#128197; Release: <strong>' + new Date(c.releaseDate).toLocaleDateString('en-US',{weekday:'short',month:'long',day:'numeric',year:'numeric'}) + '</strong>'
    + (c.releasedCount ? ' &nbsp;·&nbsp; ' + c.releasedCount + ' orders released so far' : '')
    + '</div>'
    + '<div>' + skuList + '</div>'
    + '</div>'

    // Stats
    + (isActive || isReleased ? '<div style="flex-shrink:0;display:flex;gap:16px;align-items:center;">'
      + '<div style="text-align:center;">'
      + '<div style="font-family:\'DM Mono\',monospace;font-size:28px;font-weight:700;color:var(--accent);">' + (loading ? '…' : totalOrders) + '</div>'
      + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Orders</div>'
      + '</div>'
      + '<div style="text-align:center;">'
      + '<div style="font-family:\'DM Mono\',monospace;font-size:28px;font-weight:700;color:var(--text);">' + (loading ? '…' : totalUnits) + '</div>'
      + '<div style="font-size:9px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Units</div>'
      + '</div>'
      + '</div>' : '')

    + '</div>'

    // Action buttons
    + poCardButtons(c.id, isActive, isReleased)

    // Order list
    + (orderRowsHtml ? '<div style="border-top:1px solid var(--border);">' + orderRowsHtml + '</div>' : '')

    + '</div>';
}

// ── SELECTION ─────────────────────────────────────────────────
// Updates checkboxes, header checkbox and the selection bar in place (no re-render)
function poUpdateSelectionUI(campaignId) {
  const sel        = (POState.selected || {})[campaignId] || {};
  const filtered   = poGetFilteredOrders(campaignId);
  const selOrders  = filtered.filter(function(o){ return !!sel[o.orderId]; });
  const selUnits   = poSumUnits(selOrders);
  const isReleasing = !!(POState.releasing && POState.releasing[campaignId]);

  // Row checkboxes + highlight
  document.querySelectorAll('#po-table-' + campaignId + ' .po-sel').forEach(function(cb) {
    const on = !!sel[cb.dataset.oid];
    cb.checked = on;
    cb.disabled = isReleasing;
    const row = cb.closest('tr');
    if (row) row.style.background = on ? 'var(--surface2)' : '';
  });

  // Header checkbox
  const all = document.querySelector('#po-table-' + campaignId + ' .po-sel-all');
  if (all) {
    all.checked = filtered.length > 0 && selOrders.length === filtered.length;
    all.indeterminate = selOrders.length > 0 && selOrders.length < filtered.length;
    all.disabled = isReleasing;
  }

  // Selection count
  const countEl = document.getElementById('po-selcount-' + campaignId);
  if (countEl) {
    countEl.textContent = selOrders.length
      ? selOrders.length + ' order' + (selOrders.length === 1 ? '' : 's') + ' · ' + selUnits + ' unit' + (selUnits === 1 ? '' : 's') + ' selected'
      : 'Nothing selected';
    countEl.style.color = selOrders.length ? 'var(--text)' : 'var(--text-muted)';
  }

  // Release Selected button
  const relBtn = document.getElementById('po-selrelease-' + campaignId);
  if (relBtn) {
    const enabled = selOrders.length > 0 && !isReleasing;
    relBtn.disabled = !enabled;
    relBtn.style.opacity = enabled ? '1' : '0.45';
    relBtn.style.cursor = enabled ? 'pointer' : 'default';
    relBtn.innerHTML = isReleasing ? 'Releasing…' : '&#9654; Release Selected' + (selOrders.length ? ' (' + selUnits + ' units)' : '');
  }
  const clearBtn = document.getElementById('po-selclear-' + campaignId);
  if (clearBtn) clearBtn.disabled = !selOrders.length || isReleasing;
}

function poToggleOrder(campaignId, orderId, on) {
  if (!POState.selected) POState.selected = {};
  if (!POState.selected[campaignId]) POState.selected[campaignId] = {};
  if (on) POState.selected[campaignId][orderId] = true;
  else delete POState.selected[campaignId][orderId];
  poUpdateSelectionUI(campaignId);
}

function poToggleAll(campaignId, on) {
  if (!POState.selected) POState.selected = {};
  const sel = {};
  if (on) poGetFilteredOrders(campaignId).forEach(function(o){ sel[o.orderId] = true; });
  POState.selected[campaignId] = sel;
  poUpdateSelectionUI(campaignId);
}

// Oldest-first within the current filter; stops before going over the cap
// (strict first-ordered, first-shipped — never skips an older order to fill the gap)
function poSelectNextUnits(campaignId) {
  const input = document.getElementById('po-nextn-' + campaignId);
  const cap = parseInt(input ? input.value : '', 10);
  if (!cap || cap < 1) { toast('Enter how many units to select.', 'error'); return; }
  if (!POState.nextUnits) POState.nextUnits = {};
  POState.nextUnits[campaignId] = cap;

  const filtered = poGetFilteredOrders(campaignId);
  if (!filtered.length) { toast('No orders match the current filter.', 'error'); return; }

  const sel = {};
  let selectedUnits = 0;
  let selectedCount = 0;
  for (const o of filtered) {
    const nextTotal = selectedUnits + o.qty;
    if (nextTotal > cap) break;
    sel[o.orderId] = true;
    selectedUnits = nextTotal;
    selectedCount++;
  }

  if (!selectedCount) {
    toast('The oldest matching order (' + filtered[0].orderNumber + ') has ' + filtered[0].qty + ' units — more than ' + cap + '. Raise the number or select it by hand.', 'error');
    return;
  }

  if (!POState.selected) POState.selected = {};
  POState.selected[campaignId] = sel;
  if (!POState.expandedOrders) POState.expandedOrders = {};
  POState.expandedOrders[campaignId] = true;
  renderPreOrders();
  toast('Selected ' + selectedCount + ' orders · ' + selectedUnits + ' units.', 'success');
}

// Checkbox change events (delegated — survives re-renders)
document.addEventListener('change', function(e) {
  const t = e.target;
  if (!t || !t.classList) return;
  if (t.classList.contains('po-sel'))     { poToggleOrder(t.dataset.cid, t.dataset.oid, t.checked); return; }
  if (t.classList.contains('po-sel-all')) { poToggleAll(t.dataset.cid, t.checked); return; }
});

// Enter in the "select next" box = click Select
document.addEventListener('keydown', function(e) {
  const t = e.target;
  if (e.key !== 'Enter' || !t || !t.id || t.id.indexOf('po-nextn-') !== 0) return;
  e.preventDefault();
  poSelectNextUnits(t.id.replace('po-nextn-', ''));
});

// ── STATUS BAR ───────────────────────────────────────────────
function poSetStatus(msg, pct) {
  const bar = document.getElementById('po-status-bar');
  const txt = document.getElementById('po-status-text');
  const prg = document.getElementById('po-status-progress');
  if (!bar) return;
  bar.style.display = 'flex';
  if (txt) txt.textContent = msg;
  if (prg) prg.style.width = (pct || 0) + '%';
}
function poHideStatus() {
  const bar = document.getElementById('po-status-bar');
  if (bar) bar.style.display = 'none';
}

// ── LOAD HELD ORDERS FOR A CAMPAIGN ──────────────────────────
window.loadCampaignOrders = async function(campaign) {
  const c = typeof campaign === 'string'
    ? POState.campaigns.find(x => x.id === campaign)
    : campaign;
  if (!c) return;
  if (POState.loading[c.id]) return;

  POState.loading[c.id] = true;

  poSetStatus('Connecting to Packiyo…', 5);

  try {
    // Fetch only operator-held orders — these are the pre-orders
    let page = 1, allOrders = [], allIncluded = [];
    let lastPage = null;
    do {
      poSetStatus('Fetching page ' + page + (lastPage ? ' of ' + lastPage : '') + '…', lastPage ? Math.round((page/lastPage)*80) : 10);
      const data = await packiyoFetch('/orders', {
        'page[number]': page,
        'page[size]': 100,
        'filter[fulfilled]': 'false',
        'include': 'order_items',
      });
      allOrders = allOrders.concat(data.data || []);
      allIncluded = allIncluded.concat(data.included || []);
      lastPage = data.meta?.page?.lastPage || 1;
      page++;
      if (page <= lastPage) await new Promise(r => setTimeout(r, 200));
    } while (page <= lastPage && page <= 50);

    poSetStatus('Scanning ' + allOrders.length + ' orders for matching SKUs…', 85);

    // Build order_items lookup
    const itemsById = {};
    for (const inc of allIncluded) {
      if (inc.type === 'order-items') itemsById[inc.id] = inc;
    }

    const campaignSkus = new Set((c.skus || []).map(s => s.trim().toLowerCase()));

    const matched = [];
    for (const o of allOrders) {
      const attrs = o.attributes || {};

      // Skip fulfilled or cancelled orders
      if (attrs.cancelled_at) continue;
      if (attrs.status_text && /^fulfilled$/i.test(attrs.status_text.trim())) continue;

      // Include orders that are held via hold_until OR operator_hold
      const isHeld = attrs.operator_hold || attrs.hold_until;
      if (!isHeld) continue;

      // Get order items via relationship references
      const itemRefs = o.relationships?.order_items?.data || [];
      const items = itemRefs.map(r => itemsById[r.id]).filter(Boolean);
      const itemSkus = items
        .map(i => (i.attributes?.sku || '').trim().toLowerCase())
        .filter(Boolean);

      // Check if any campaign SKU matches
      const matchingSkus = itemSkus.filter(s => campaignSkus.has(s));
      if (!matchingSkus.length) continue;

      const qty = items
        .filter(i => campaignSkus.has((i.attributes?.sku||'').toLowerCase()))
        .reduce((s, i) => s + parseInt(i.attributes?.quantity || 0), 0);

      matched.push({
        orderId:      o.id,
        orderNumber:  attrs.number || ('#' + o.id),
        createdAt:    attrs.ordered_at || attrs.created_at || '',
        operatorHold:    attrs.operator_hold || 0,
        holdUntil:       attrs.hold_until || null,
        allocationHold:  attrs.allocation_hold || 0,
        addressHold:     attrs.address_hold || 0,
        statusText:   attrs.status_text || '',
        tags:         (attrs.tags || '').split(',').map(t => t.trim()).filter(Boolean),
        skus:         [...new Set(matchingSkus.map(s => {
          const orig = items.find(i => (i.attributes?.sku||'').toLowerCase() === s);
          return orig?.attributes?.sku || s;
        }))],
        qty,
      });
    }

    // Sort oldest first — shows longest-waiting orders at top
    matched.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    POState.orders[c.id] = matched;
    if (!POState.ordersRefreshedAt) POState.ordersRefreshedAt = {};
    POState.ordersRefreshedAt[c.id] = Date.now();

    // Drop any selections for orders that are no longer held
    poPruneSelection(c.id);

    // Save to Gist and localStorage so orders persist across sessions
    savePreOrderData();

  } catch(e) {
    console.error('Pre-order load failed:', e);
    POState.orders[c.id] = [];
    toast('Failed to load orders: ' + e.message, 'error');
  } finally {
    POState.loading[c.id] = false;
    poHideStatus();
    renderPreOrders();
  }
};

// ── RELEASE HOLDS ─────────────────────────────────────────────
function poFilterNote(campaignId, allCount, count) {
  const f = poGetFilterState(campaignId);
  let note = '';
  if (f.activeTags.length)  note += '\nTag filter: ' + f.activeTags.join(', ');
  if (f.activeHolds.length) note += '\nHold filter: ' + f.activeHolds.map(function(hk){ return hk.charAt(0).toUpperCase()+hk.slice(1)+' Hold'; }).join(', ');
  if (f.hasQty)             note += '\nUnits filter: ' + (f.qtyMin !== null ? f.qtyMin : 'any') + ' – ' + (f.qtyMax !== null ? f.qtyMax : 'any');
  if (f.searchTerm)         note += '\nSearch: ' + f.searchTerm;
  if (f.hasFilters)         note += '\n(' + count + ' of ' + allCount + ' orders)';
  return note ? '\n' + note : '';
}

window.poConfirmRelease = function(campaignId) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  if (POState.releasing[campaignId]) { toast('Already releasing this campaign — please wait for it to finish.', 'error'); return; }
  const allOrders = POState.orders[campaignId] || [];

  if (!allOrders.length) {
    if (!confirm('No held orders loaded yet. Click Refresh Orders first, then try releasing.\n\nClick OK to refresh now.')) return;
    loadCampaignOrders(c);
    return;
  }

  const orders = poGetFilteredOrders(campaignId);
  if (!orders.length) { toast('No orders match the current filter.', 'error'); return; }
  const units = poSumUnits(orders);

  if (!confirm('Release ' + orders.length + ' held orders (' + units + ' units) for "' + c.name + '"?' + poFilterNote(campaignId, allOrders.length, orders.length) + '\n\nThis will clear operator_hold and hold_until. Make sure Co-Pilot hold rule is turned off first.\n\nClick OK to proceed.')) return;
  releaseHolds(campaignId, orders);
};

window.poConfirmReleaseSelected = function(campaignId) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  if (POState.releasing[campaignId]) { toast('Already releasing this campaign — please wait for it to finish.', 'error'); return; }
  const orders = poGetSelectedOrders(campaignId);
  if (!orders.length) { toast('No orders selected.', 'error'); return; }
  const units = poSumUnits(orders);
  const remainingOrders = (POState.orders[campaignId] || []).length - orders.length;
  const remainingUnits  = poSumUnits(POState.orders[campaignId] || []) - units;

  if (!confirm('Release ' + orders.length + ' selected orders (' + units + ' units) for "' + c.name + '"?'
    + '\n\nOldest: ' + orders[0].orderNumber + '  ·  Newest: ' + orders[orders.length - 1].orderNumber
    + '\nStill held after this wave: ' + remainingOrders + ' orders (' + remainingUnits + ' units)'
    + '\n\nThis will clear operator_hold and hold_until. Make sure Co-Pilot hold rule is turned off first.\n\nClick OK to proceed.')) return;
  releaseHolds(campaignId, orders);
};

async function releaseHolds(campaignId, orders) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  if (!orders) orders = POState.orders[campaignId] || [];
  if (!orders.length) { toast('No held orders to release.', 'error'); return; }

  POState.releasing[campaignId] = true;
  renderPreOrders();

  let released = 0, failed = 0;
  let releasedUnits = 0;
  const releasedIds = new Set();
  const total = orders.length;

  for (let i = 0; i < total; i++) {
    const o = orders[i];
    poSetStatus('Releasing ' + (i + 1) + ' of ' + total + ' — ' + o.orderNumber, Math.round(((i + 1) / total) * 100));
    try {
      const res = await fetch(CONFIG.WORKER_BASE + '/packiyo/orders/' + o.orderId, {
        method: 'PATCH',
        headers: Object.assign({
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/vnd.api+json',
        }, authHeader()),
        body: JSON.stringify({
          data: {
            id: String(o.orderId),
            type: 'orders',
            attributes: { operator_hold: 0, hold_until: null },
          }
        }),
      });
      if (res.ok) {
        released++;
        releasedUnits += o.qty || 0;
        releasedIds.add(o.orderId);
      } else {
        const err = await res.text().catch(() => '');
        console.warn('Release failed for order', o.orderNumber, res.status, err);
        failed++;
      }
      // Small delay to avoid rate limiting
      await new Promise(r => setTimeout(r, 120));
    } catch(e) {
      console.error('Release error for order', o.orderNumber, e);
      failed++;
    }
  }

  poHideStatus();
  POState.releasing[campaignId] = false;

  // Remove released orders from the list; failed ones stay so they can be retried
  const remaining = (POState.orders[campaignId] || []).filter(function(o){ return !releasedIds.has(o.orderId); });
  POState.orders[campaignId] = remaining;

  // Clear released orders from the selection
  const sel = (POState.selected || {})[campaignId];
  if (sel) releasedIds.forEach(function(id){ delete sel[id]; });

  // Only mark the campaign released once nothing is left held
  const idx = POState.campaigns.findIndex(x => x.id === campaignId);
  if (idx >= 0) {
    if (!remaining.length) {
      POState.campaigns[idx].status = 'released';
      POState.campaigns[idx].releasedAt = new Date().toISOString();
    }
    POState.campaigns[idx].releasedCount = (POState.campaigns[idx].releasedCount || 0) + released;
    POState.campaigns[idx].lastReleasedAt = new Date().toISOString();
  }

  await savePreOrderData();

  const msg = released + ' orders (' + releasedUnits + ' units) released'
    + (failed ? ', ' + failed + ' failed (still listed — check console)' : '')
    + (remaining.length ? '. ' + remaining.length + ' orders still held.' : '.');
  toast(msg, failed ? 'error' : 'success');

  // Show in-app notification
  if (released > 0) {
    poShowReleaseNotification(c.name, released, failed, releasedUnits, remaining.length);
  }

  renderPreOrders();
}

function poShowReleaseNotification(campaignName, released, failed, units, remainingCount) {
  const notifEl = document.getElementById('po-release-notification');
  if (!notifEl) return;
  notifEl.style.display = 'flex';
  notifEl.innerHTML = '<div style="flex:1;">'
    + '<div style="font-size:14px;font-weight:700;color:var(--green);margin-bottom:2px;">&#10003; Pre-Order Released: ' + poEsc(campaignName) + '</div>'
    + '<div style="font-size:12px;color:var(--text-muted);">' + released + ' orders' + (units ? ' (' + units + ' units)' : '') + ' released to pack queue'
    + (failed ? ' &nbsp;·&nbsp; <span style="color:var(--red);">' + failed + ' failed</span>' : '')
    + (remainingCount ? ' &nbsp;·&nbsp; ' + remainingCount + ' still held' : '')
    + ' &nbsp;·&nbsp; ' + new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) + '</div>'
    + '</div>'
    + '<button onclick="document.getElementById(\'po-release-notification\').style.display=\'none\'" style="background:none;border:none;font-size:18px;cursor:pointer;color:var(--text-muted);">&#x2715;</button>';
  // Auto-hide after 60s
  setTimeout(() => { if (notifEl) notifEl.style.display = 'none'; }, 60000);
}

// ── MODAL — NEW / EDIT CAMPAIGN ───────────────────────────────
let _poEditId = null;

window.poOpenModal = function(campaignId) {
  _poEditId = campaignId || null;
  const c = campaignId ? POState.campaigns.find(x => x.id === campaignId) : null;

  const modal = document.getElementById('po-modal');
  const title = document.getElementById('po-modal-title');
  if (!modal) return;

  title.textContent = c ? 'Edit Campaign' : 'New Pre-Order Campaign';

  document.getElementById('po-form-name').value        = c?.name || '';
  document.getElementById('po-form-date').value        = c?.releaseDate || '';
  document.getElementById('po-form-skus').value        = (c?.skus || []).join('\n');
  document.getElementById('po-form-notes').value       = c?.notes || '';

  // Populate SKU autocomplete options from State.merged
  const skuList = document.getElementById('po-sku-datalist');
  if (skuList && window.State?.merged) {
    skuList.innerHTML = State.merged.map(p =>
      '<option value="' + poEsc(p.packiyo_sku || p.catalog) + '">' + poEsc(p.artist + ' - ' + p.title) + '</option>'
    ).join('');
  }

  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('po-form-name')?.focus(), 50);
};

window.poCloseModal = function() {
  const modal = document.getElementById('po-modal');
  if (modal) modal.style.display = 'none';
  _poEditId = null;
};

window.poSaveModal = function() {
  const name  = document.getElementById('po-form-name')?.value.trim();
  const date  = document.getElementById('po-form-date')?.value;
  const skuRaw = document.getElementById('po-form-skus')?.value || '';
  const notes = document.getElementById('po-form-notes')?.value.trim() || '';

  if (!name)  { alert('Campaign name is required.'); return; }
  if (!date)  { alert('Release date is required.'); return; }

  const skus = skuRaw.split(/[\n,]+/).map(s => s.trim()).filter(Boolean);
  if (!skus.length) { alert('At least one SKU is required.'); return; }

  if (_poEditId) {
    const idx = POState.campaigns.findIndex(x => x.id === _poEditId);
    if (idx >= 0) {
      POState.campaigns[idx] = { ...POState.campaigns[idx], name, releaseDate: date, skus, notes };
      // Clear cached orders so they refresh
      delete POState.orders[_poEditId];
      if (POState.selected) delete POState.selected[_poEditId];
    }
  } else {
    POState.campaigns.push({
      id:          'po-' + Date.now(),
      name,
      releaseDate: date,
      skus,
      notes,
      status:      'active',
      createdAt:   new Date().toISOString(),
    });
  }

  savePreOrderData();
  poCloseModal();
  renderPreOrders();
  toast(_poEditId ? 'Campaign updated.' : 'Campaign created.', 'success');
};

window.poDelete = function(campaignId) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  if (!confirm('Delete campaign "' + c.name + '"? This cannot be undone.')) return;
  POState.campaigns = POState.campaigns.filter(x => x.id !== campaignId);
  delete POState.orders[campaignId];
  if (POState.selected) delete POState.selected[campaignId];
  savePreOrderData();
  renderPreOrders();
  toast('Campaign deleted.', '');
};

window.poArchive = function(campaignId) {
  const idx = POState.campaigns.findIndex(x => x.id === campaignId);
  if (idx < 0) return;
  POState.campaigns[idx].status = 'archived';
  savePreOrderData();
  renderPreOrders();
  toast('Campaign archived.', '');
};

// Close modal on backdrop click
document.addEventListener('click', e => {
  if (e.target.id === 'po-modal') poCloseModal();
});

// Gist integration handled via loadPreOrderData() and savePreOrderData()

// ── EVENT DELEGATION for campaign buttons ────────────────────
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.po-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const cid    = btn.dataset.cid;
  if (!action || !cid) return;
  e.stopPropagation();
  if (btn.disabled) return;
  if (action === 'expand')  { if (!POState.expandedOrders) POState.expandedOrders = {}; POState.expandedOrders[cid] = true;  renderPreOrders(); }
  if (action === 'collapse'){ if (!POState.expandedOrders) POState.expandedOrders = {}; POState.expandedOrders[cid] = false; renderPreOrders(); }
  if (action === 'select-next')      poSelectNextUnits(cid);
  if (action === 'clear-selection')  poToggleAll(cid, false);
  if (action === 'release-selected') poConfirmReleaseSelected(cid);
});

// ── UTILITY ───────────────────────────────────────────────────
function poEsc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function timeAgo(ts) {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1)  return 'just now';
  if (mins < 60) return mins + 'm ago';
  const hrs = Math.floor(mins / 60);
  if (hrs < 24)  return hrs + 'h ago';
  return Math.floor(hrs / 24) + 'd ago';
}

function updatePOBadge() {
  const active = POState.campaigns.filter(c => c.status === 'active').length;
  const badge  = document.getElementById('po-badge');
  if (!badge) return;
  badge.textContent = active;
  active > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
}
