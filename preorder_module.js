/* ============================================================
   FAT POSSUM -- PRE-ORDER CAMPAIGN MANAGER  v20260519133858
   preorder_module.js
   Tracks operator-held pre-order campaigns and releases them
   via PATCH /orders/{id} operator_hold: 0
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────
console.log('preorder_module.js loaded — build 141956');
const POState = {
  campaigns:       [],
  orders:          {},
  loading:         {},
  releasing:       {},
  expandedOrders:  {},
  tagFilters:      {},  // { campaignId: 'tagName' }
  searchTerms:     {},  // { campaignId: 'searchText' }
};

// ── NAV TOGGLE ───────────────────────────────────────────────
window.togglePreOrderNav = function(e) {
  e.preventDefault();
  switchToPreOrders();
};

// ── PERSISTENCE (plugs into app.js Gist system) ─────────────
// Called by applyConfigData when Gist loads
window.applyPreOrderData = function(parsed) {
  if (parsed && parsed.preOrderCampaigns) {
    POState.campaigns = parsed.preOrderCampaigns;
    console.log('Pre-order campaigns loaded:', POState.campaigns.length);
  }
};

// Returns data to merge into Gist save payload
window.getPreOrderSaveData = function() {
  return { preOrderCampaigns: POState.campaigns };
};

const PO_LS_KEY   = 'fp_preorder_campaigns';
const PO_GIST_FILE = 'fp_preorders.json';

async function savePreOrderData() {
  // 1. Always save to localStorage immediately
  try { localStorage.setItem(PO_LS_KEY, JSON.stringify(POState.campaigns)); } catch(e) {}

  // 2. Save to a dedicated Gist file (separate from fp_config.json)
  try {
    const body = JSON.stringify({
      files: { [PO_GIST_FILE]: { content: JSON.stringify({ preOrderCampaigns: POState.campaigns }) } }
    });
    let _gistId, _token;
    try { _gistId = CONFIG.GIST_ID; _token = CONFIG.GIST_TOKEN; } catch(e) {}
    if (!_gistId) { try { const c=JSON.parse(localStorage.getItem('fp_config_cache')||'{}'); _gistId=c.GIST_ID; _token=c.GIST_TOKEN; } catch(e) {} }
    const res = await fetch('https://api.github.com/gists/' + _gistId, {
      method: 'PATCH',
      headers: { 'Authorization': 'token ' + _token, 'Content-Type': 'application/json' },
      body,
    });
    if (!res.ok) console.warn('Pre-order Gist save failed:', res.status);
    else console.log('Pre-order campaigns saved to Gist');
  } catch(e) {
    console.warn('Pre-order Gist save error:', e.message);
  }

  updatePOBadge();
}

async function loadPreOrderData(creds) {
  try {
    let gistId, token;
    if (creds) {
      gistId = creds.gistId; token = creds.token;
    } else {
      try { gistId = CONFIG.GIST_ID; token = CONFIG.GIST_TOKEN; } catch(e) {}
    }
    if (!gistId || !token) { console.warn('Pre-order load: no credentials'); return; }
    const res = await fetch('https://api.github.com/gists/' + gistId, {
      headers: { 'Authorization': 'token ' + token },
      cache: 'no-store',
    });
    if (res.ok) {
      const gist = await res.json();
      const fileContent = gist.files && gist.files[PO_GIST_FILE] && gist.files[PO_GIST_FILE].content;
      if (fileContent) {
        const data = JSON.parse(fileContent);
        if (data.preOrderCampaigns && data.preOrderCampaigns.length) {
          POState.campaigns = data.preOrderCampaigns;
          try { localStorage.setItem(PO_LS_KEY, JSON.stringify(POState.campaigns)); } catch(e) {}
          updatePOBadge();
          console.log('Pre-order campaigns from Gist:', POState.campaigns.length);
          const view = document.getElementById('view-preorders');
          if (view && !view.classList.contains('hidden')) renderPreOrders();
        }
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
  if (window.FPSettings?.poAutoRefresh) {
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
      // Badge update happens after DOM ready
      document.addEventListener('DOMContentLoaded', () => updatePOBadge());
    }
  } catch(e) {}
})();

// Load on boot — retry until CONFIG is ready (set by app.js)
document.addEventListener('DOMContentLoaded', function() {
  let attempts = 0;
  function getCredentials() {
    // Try direct CONFIG access first (works if in same scope)
    try {
      if (typeof CONFIG !== 'undefined' && CONFIG.GIST_ID && CONFIG.GIST_TOKEN) {
        return { gistId: CONFIG.GIST_ID, token: CONFIG.GIST_TOKEN };
      }
    } catch(e) {}
    // Fall back to reading from localStorage config cache
    try {
      const cached = localStorage.getItem('fp_config_cache');
      if (cached) {
        const obj = JSON.parse(cached);
        if (obj.GIST_ID && obj.GIST_TOKEN) return { gistId: obj.GIST_ID, token: obj.GIST_TOKEN };
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
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const c of POState.campaigns) {
    if (c.status !== 'active') continue;
    const rel = new Date(c.releaseDate);
    rel.setHours(0, 0, 0, 0);
    if (rel <= today) {
      // Show banner — don't auto-release, require manual confirm
      const el = document.getElementById('po-release-due-banner');
      if (el) {
        el.style.display = 'flex';
        el.innerHTML = '<span style="flex:1;font-weight:600;">&#128276; Release date reached for <strong>' + poEsc(c.name) + '</strong></span>'
          + '<button onclick="poConfirmRelease(\'' + c.id + '\')" style="background:#fff;color:var(--accent);border:none;border-radius:4px;padding:6px 16px;font-weight:700;cursor:pointer;font-size:12px;margin-left:12px;">Release Now</button>'
          + '<button onclick="document.getElementById(\'po-release-due-banner\').style.display=\'none\'" style="background:none;border:none;color:rgba(255,255,255,0.7);font-size:18px;cursor:pointer;margin-left:8px;">&#x2715;</button>';
      }
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
        poFilterInPlace(c.id);
      });
    }

    // Attach tag pill listeners
    const orders = POState.orders[c.id] || [];
    const ALLOWED_TAGS = ['B2B', 'D2C', 'International'];
    const presentTags = ALLOWED_TAGS.filter(t =>
      orders.some(o => (o.tags||[]).some(ot => ot.toLowerCase() === t.toLowerCase()))
    );
    presentTags.forEach(function(tag) {
      const pill = document.getElementById('po-tag-' + c.id + '-' + tag.replace(/\s+/g, '-'));
      if (!pill) return;
      pill.addEventListener('click', function() {
        if (!POState.tagFilters) POState.tagFilters = {};
        POState.tagFilters[c.id] = (POState.tagFilters[c.id] === tag) ? '' : tag;
        poFilterInPlace(c.id);
      });
    });
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
    var rel = document.createElement('button');
    rel.style.cssText = 'background:var(--accent);color:#fff;border:none;border-radius:3px;padding:6px 16px;font-size:11px;font-weight:700;cursor:pointer;';
    rel.innerHTML = '&#9654; Release All Holds';
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
  const releasing = POState.releasing[c.id];
  const totalOrders = orders.length;
  const totalUnits  = orders.reduce((s, o) => s + o.qty, 0);

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

  // Order rows (show first 8, then expand)
    // Only show these specific tags as filter options
  const ALLOWED_TAGS = ['B2B', 'D2C', 'International'];
  const allTags = ALLOWED_TAGS.filter(t =>
    (orders || []).some(o => (o.tags || []).some(ot => ot.toLowerCase() === t.toLowerCase()))
  );
  const activeTag    = (POState.tagFilters    || {})[c.id] || '';
  const searchTerm   = (POState.searchTerms   || {})[c.id] || '';
  if (!POState.expandedOrders) POState.expandedOrders = {};

  // Apply search + tag filter
  const filteredOrders = orders.filter(o => {
    if (activeTag && !(o.tags || []).some(t => t.toLowerCase() === activeTag.toLowerCase())) return false;
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      if (!o.orderNumber.toLowerCase().includes(term)) return false;
    }
    return true;
  });

  const showAll = !!POState.expandedOrders[c.id];
  const shown   = showAll ? filteredOrders : filteredOrders.slice(0, 10);

  let orderRowsHtml = '';
  if (loading) {
    orderRowsHtml = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">Loading orders…</div>';
  } else if (!orders.length && isActive) {
    orderRowsHtml = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px;">No held orders found. Refresh orders first.</div>';
  } else if (orders.length) {
    const th = 'padding:7px 10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);';

    // Search + tag filter bar
    const tagPills = allTags.map(t =>
      '<span id="po-tag-' + c.id + '-' + poEsc(t.replace(/\s+/g,'-')) + '" style="display:inline-block;padding:3px 10px;border-radius:12px;font-size:10px;font-weight:600;cursor:pointer;margin-right:4px;margin-bottom:4px;'
      + (activeTag === t ? 'background:var(--accent);color:#fff;' : 'background:var(--surface2);color:var(--text-muted);border:1px solid var(--border2);') + '">'
      + poEsc(t) + '</span>'
    ).join('');

    const filterBar = '<div style="padding:10px 16px;border-bottom:1px solid var(--border);display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--surface2);">'
      + '<input id="po-search-' + c.id + '" type="text" placeholder="Search order #…" value="' + poEsc(searchTerm) + '"'
      + ' style="padding:5px 10px;font-size:12px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);font-family:monospace;width:160px;" />'
      + (allTags.length ? '<div style="display:flex;flex-wrap:wrap;gap:0;">' + tagPills + '</div>' : '')
      + '<span id="po-filter-count-' + c.id + '" style="font-size:11px;color:var(--text-muted);">' + (activeTag || searchTerm ? filteredOrders.length + ' of ' + orders.length + ' orders' : '') + '</span>'
      + '</div>';

    orderRowsHtml = filterBar
      + '<table id="po-table-' + c.id + '" style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="background:var(--surface2);">'
      + '<th style="'+th+'text-align:left;">Order #</th>'
      + '<th style="'+th+'text-align:left;">Date</th>'
      + '<th style="'+th+'text-align:left;">Tags</th>'
      + '<th style="'+th+'text-align:right;">Units</th>'
      + '<th style="'+th+'text-align:center;">Hold</th>'
      + '</tr></thead><tbody>'
      + (shown.length ? shown.map(o => '<tr style="border-bottom:1px solid var(--border);">'
          + '<td style="padding:8px 10px;font-family:\'DM Mono\',monospace;font-weight:600;color:var(--accent);">' + poEsc(o.orderNumber) + '</td>'
          + '<td style="padding:8px 10px;color:var(--text-muted);white-space:nowrap;">' + new Date(o.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</td>'
          + '<td style="padding:8px 10px;">' + (o.tags||[]).filter(t => ['B2B','D2C','International'].some(a => a.toLowerCase()===t.toLowerCase())).map(t => '<span style="background:var(--surface2);padding:1px 6px;border-radius:10px;font-size:10px;margin-right:3px;border:1px solid var(--border2);">' + poEsc(t) + '</span>').join('') + '</td>'
          + '<td style="padding:8px 10px;text-align:right;font-family:\'DM Mono\',monospace;font-weight:600;">' + o.qty + '</td>'
          + '<td style="padding:8px 10px;text-align:center;">'
          + (o.operatorHold ? '<span style="color:var(--red);font-size:11px;font-weight:700;">&#9632; Op Hold</span>'
            : o.holdUntil ? '<span style="color:var(--yellow);font-size:11px;font-weight:700;">&#9632; Date Hold</span>'
            : '<span style="color:var(--text-dim);font-size:11px;">&#9633; Open</span>')
          + '</td>'
          + '</tr>').join('')
        : '<tr><td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No orders match this filter.</td></tr>')
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

// ── LOAD HELD ORDERS FOR A CAMPAIGN ──────────────────────────
window.loadCampaignOrders = async function(campaign) {
  const c = typeof campaign === 'string'
    ? POState.campaigns.find(x => x.id === campaign)
    : campaign;
  if (!c) return;
  if (POState.loading[c.id]) return;

  POState.loading[c.id] = true;

  // Show status bar
  function setStatus(msg, pct) {
    const bar = document.getElementById('po-status-bar');
    const txt = document.getElementById('po-status-text');
    const prg = document.getElementById('po-status-progress');
    if (!bar) return;
    bar.style.display = 'flex';
    if (txt) txt.textContent = msg;
    if (prg) prg.style.width = (pct || 0) + '%';
  }
  function hideStatus() {
    const bar = document.getElementById('po-status-bar');
    if (bar) bar.style.display = 'none';
  }

  setStatus('Connecting to Packiyo…', 5);

  try {
    // Fetch only operator-held orders — these are the pre-orders
    let page = 1, allOrders = [], allIncluded = [];
    let lastPage = null;
    do {
      setStatus('Fetching page ' + page + (lastPage ? ' of ' + lastPage : '') + '…', lastPage ? Math.round((page/lastPage)*80) : 10);
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

    setStatus('Scanning ' + allOrders.length + ' orders for matching SKUs…', 85);

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
        operatorHold: attrs.operator_hold || 0,
        holdUntil:    attrs.hold_until || null,
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

  } catch(e) {
    console.error('Pre-order load failed:', e);
    POState.orders[c.id] = [];
    toast('Failed to load orders: ' + e.message, 'error');
  } finally {
    POState.loading[c.id] = false;
    hideStatus();
    renderPreOrders();
  }
};

// ── RELEASE HOLDS ─────────────────────────────────────────────
window.poConfirmRelease = function(campaignId) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  const allOrders = POState.orders[campaignId] || [];
  const activeTag = (POState.tagFilters || {})[campaignId] || '';
  const orders = activeTag ? allOrders.filter(o => (o.tags||[]).includes(activeTag)) : allOrders;

  if (!orders.length) {
    if (!confirm('No held orders loaded yet. Refresh orders first?\n\nClick OK to refresh.')) return;
    loadCampaignOrders(c);
    return;
  }

  const tagNote = activeTag ? '\n\nFiltered to tag "' + activeTag + '" (' + orders.length + ' of ' + allOrders.length + ' orders).' : '';
  if (!confirm('Release ' + orders.length + ' held orders for "' + c.name + '"?' + tagNote + '\n\nThis will clear operator_hold and hold_until on each order. Make sure you have turned off the Co-Pilot hold rule first.\n\nClick OK to proceed.')) return;
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

  for (const o of orders) {
    try {
      const res = await fetch(CONFIG.PACKIYO_BASE + '/orders/' + o.orderId, {
        method: 'PATCH',
        headers: {
          'Authorization': 'Bearer ' + CONFIG.PACKIYO_TOKEN,
          'Content-Type': 'application/vnd.api+json',
          'Accept': 'application/vnd.api+json',
        },
        body: JSON.stringify({
          data: {
            id: String(o.orderId),
            type: 'orders',
            attributes: { operator_hold: 0, hold_until: null },
          }
        }),
      });
      if (res.ok) { released++; }
      else {
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

  POState.releasing[campaignId] = false;

  // Update campaign status
  const idx = POState.campaigns.findIndex(x => x.id === campaignId);
  if (idx >= 0) {
    POState.campaigns[idx].status = 'released';
    POState.campaigns[idx].releasedAt = new Date().toISOString();
    POState.campaigns[idx].releasedCount = released;
  }

  // Clear order cache so it refreshes
  delete POState.orders[campaignId];

  await savePreOrderData();

  const msg = released + ' orders released' + (failed ? ', ' + failed + ' failed (check console)' : '') + '.';
  toast(msg, failed ? 'error' : 'success');

  // Show in-app notification
  if (released > 0) {
    poShowReleaseNotification(c.name, released, failed);
  }

  renderPreOrders();
}

function poShowReleaseNotification(campaignName, released, failed) {
  const notifEl = document.getElementById('po-release-notification');
  if (!notifEl) return;
  notifEl.style.display = 'flex';
  notifEl.innerHTML = '<div style="flex:1;">'
    + '<div style="font-size:14px;font-weight:700;color:var(--green);margin-bottom:2px;">&#10003; Pre-Order Released: ' + poEsc(campaignName) + '</div>'
    + '<div style="font-size:12px;color:var(--text-muted);">' + released + ' orders released to pack queue' + (failed ? ' &nbsp;·&nbsp; <span style="color:var(--red);">' + failed + ' failed</span>' : '') + ' &nbsp;·&nbsp; ' + new Date().toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) + '</div>'
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

// ── UTILITY ───────────────────────────────────────────────────
// ── IN-PLACE FILTER — updates order table without full re-render ──
// Avoids losing focus on search input
function poFilterInPlace(campaignId) {
  const orders    = POState.orders[campaignId] || [];
  const activeTag = (POState.tagFilters  || {})[campaignId] || '';
  const searchTerm = (POState.searchTerms || {})[campaignId] || '';

  const filtered = orders.filter(o => {
    if (activeTag && !(o.tags||[]).some(t => t.toLowerCase() === activeTag.toLowerCase())) return false;
    if (searchTerm && !o.orderNumber.toLowerCase().includes(searchTerm.toLowerCase())) return false;
    return true;
  });

  // Show/hide rows by toggling display
  const tbody = document.querySelector('#po-table-' + campaignId + ' tbody');
  if (!tbody) return;
  const rows = [...tbody.querySelectorAll('tr[data-order-id]')];
  const showAll = !!(POState.expandedOrders || {})[campaignId];
  let shown = 0;
  rows.forEach(row => {
    const orderId = row.dataset.orderId;
    const order   = filtered.find(o => o.orderId === orderId);
    const withinLimit = showAll || shown < 10;
    if (order && withinLimit) { row.style.display = ''; shown++; }
    else row.style.display = 'none';
  });

  // Update no-results row
  let noResults = tbody.querySelector('.po-no-results');
  if (!filtered.length) {
    if (!noResults) {
      noResults = document.createElement('tr');
      noResults.className = 'po-no-results';
      noResults.innerHTML = '<td colspan="5" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No orders match this filter.</td>';
      tbody.appendChild(noResults);
    }
    noResults.style.display = '';
  } else if (noResults) {
    noResults.style.display = 'none';
  }

  // Update count label
  const countEl = document.getElementById('po-filter-count-' + campaignId);
  if (countEl) {
    countEl.textContent = (activeTag || searchTerm) ? filtered.length + ' of ' + orders.length + ' orders' : '';
  }

  // Update tag pill active states
  const ALLOWED_TAGS = ['B2B', 'D2C', 'International'];
  ALLOWED_TAGS.forEach(tag => {
    const pill = document.getElementById('po-tag-' + campaignId + '-' + tag.replace(/\s+/g,'-'));
    if (!pill) return;
    pill.style.background = (activeTag === tag) ? 'var(--accent)' : 'var(--surface2)';
    pill.style.color      = (activeTag === tag) ? '#fff' : 'var(--text-muted)';
  });
}

// ── EVENT DELEGATION for campaign buttons ────────────────────
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.po-btn');
  if (!btn) return;
  const action = btn.dataset.action;
  const cid    = btn.dataset.cid;
  if (!action || !cid) return;
  e.stopPropagation();
  if (action === 'refresh') loadCampaignOrders(cid);
  if (action === 'release') poConfirmRelease(cid);
  if (action === 'archive') poArchive(cid);
  if (action === 'edit')    poOpenModal(cid);
  if (action === 'delete')  poDelete(cid);
  if (action === 'expand')  { if (!POState.expandedOrders) POState.expandedOrders = {}; POState.expandedOrders[cid] = true;  renderPreOrders(); }
  if (action === 'collapse'){ if (!POState.expandedOrders) POState.expandedOrders = {}; POState.expandedOrders[cid] = false; renderPreOrders(); }
});

function poEsc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updatePOBadge() {
  const active = POState.campaigns.filter(c => c.status === 'active').length;
  const badge  = document.getElementById('po-badge');
  if (!badge) return;
  badge.textContent = active;
  active > 0 ? badge.classList.remove('hidden') : badge.classList.add('hidden');
}
