/* ============================================================
   FAT POSSUM -- PRE-ORDER CAMPAIGN MANAGER
   preorder_module.js
   Tracks operator-held pre-order campaigns and releases them
   via PATCH /orders/{id} operator_hold: 0
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────
const POState = {
  campaigns: [],   // [{ id, name, skus[], releaseDate, status, createdAt }]
  orders:    {},   // { campaignId: [{ orderId, orderNumber, createdAt, skus[], qty }] }
  loading:   {},   // { campaignId: bool }
  releasing: {},   // { campaignId: bool }
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

async function savePreOrderData() {
  // Merge into existing gist config and save
  // We piggyback on app.js saveGistData which reads getPreOrderSaveData()
  if (window.saveGistData) {
    await saveGistData();
  }
}

// ── VIEW ENTRY ────────────────────────────────────────────────
window.switchToPreOrders = function() {
  switchView('preorders');
  renderPreOrders();
  checkReleaseDates();
};

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
  let orderRowsHtml = '';
  if (loading) {
    orderRowsHtml = '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">Loading orders…</div>';
  } else if (!orders.length && isActive) {
    orderRowsHtml = '<div style="text-align:center;padding:12px;color:var(--text-muted);font-size:12px;">No held orders found for these SKUs. Make sure Co-Pilot operator hold is active.</div>';
  } else if (orders.length) {
    const shown = orders.slice(0, 10);
    orderRowsHtml = '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
      + '<thead><tr style="background:var(--surface2);">'
      + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Order #</th>'
      + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Date</th>'
      + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">SKUs</th>'
      + '<th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Units</th>'
      + '<th style="padding:7px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">Hold</th>'
      + '</tr></thead><tbody>'
      + shown.map(o => '<tr style="border-bottom:1px solid var(--border);">'
          + '<td style="padding:8px 10px;font-family:\'DM Mono\',monospace;font-weight:600;color:var(--accent);">' + poEsc(o.orderNumber) + '</td>'
          + '<td style="padding:8px 10px;color:var(--text-muted);">' + new Date(o.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric'}) + '</td>'
          + '<td style="padding:8px 10px;">' + o.skus.map(s => '<code style="background:var(--surface2);padding:1px 5px;border-radius:2px;font-size:10px;margin-right:3px;">' + poEsc(s) + '</code>').join('') + '</td>'
          + '<td style="padding:8px 10px;text-align:right;font-family:\'DM Mono\',monospace;font-weight:600;">' + o.qty + '</td>'
          + '<td style="padding:8px 10px;text-align:center;"><span style="color:var(--red);font-size:12px;">&#9632; Hold</span></td>'
          + '</tr>').join('')
      + '</tbody></table>'
      + (orders.length > 10 ? '<div style="text-align:center;padding:8px;font-size:11px;color:var(--text-muted);">+ ' + (orders.length - 10) + ' more orders not shown</div>' : '');
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
    + '<div style="padding:10px 20px;background:var(--surface2);display:flex;align-items:center;gap:8px;flex-wrap:wrap;">'
    + (isActive ? '<button onclick="loadCampaignOrders({id:\'' + c.id + '\',skus:' + JSON.stringify(c.skus) + '})" class="btn-secondary btn-sm">&#8635; Refresh Orders</button>' : '')
    + (isActive ? '<button onclick="poConfirmRelease(\'' + c.id + '\')" style="background:var(--accent);color:#fff;border:none;border-radius:3px;padding:6px 16px;font-size:11px;font-weight:700;cursor:pointer;' + (releasing ? 'opacity:0.6;' : '') + '">' + (releasing ? 'Releasing…' : '&#9654; Release All Holds') + '</button>' : '')
    + (isReleased ? '<button onclick="poArchive(\'' + c.id + '\')" class="btn-secondary btn-sm">Archive</button>' : '')
    + '<button onclick="poOpenModal(\'' + c.id + '\')" class="btn-secondary btn-sm">Edit</button>'
    + '<button onclick="poDelete(\'' + c.id + '\')" class="btn-secondary btn-sm" style="color:var(--red);margin-left:auto;">Delete</button>'
    + '</div>'

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

  // Guard: don't run if already loading this campaign
  if (POState.loading[c.id]) return;

  POState.loading[c.id] = true;
  // Update just the loading indicator without triggering another load
  const countEl = document.querySelector('[data-po-count="' + c.id + '"]');
  if (countEl) countEl.textContent = '…';

  try {
    // Fetch all unfulfilled orders — paginated
    let page = 1, allOrders = [], allIncluded = [];
    let lastPage = null;
    do {
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
    } while (page <= lastPage && page <= 20); // cap at 2000 orders

    // Build order_items lookup
    const itemsById = {};
    for (const inc of allIncluded) {
      if (inc.type === 'order-items') itemsById[inc.id] = inc;
    }

    const campaignSkus = new Set((c.skus || []).map(s => s.trim().toLowerCase()));

    const matched = [];
    for (const o of allOrders) {
      const attrs = o.attributes || {};
      // Must be operator held
      if (!attrs.operator_hold) continue;

      // Get order items
      const itemRefs = o.relationships?.order_items?.data || [];
      const items = itemRefs.map(r => itemsById[r.id]).filter(Boolean);
      const itemSkus = items
        .map(i => (i.attributes?.sku || '').trim().toLowerCase())
        .filter(Boolean);

      // Check if any campaign SKU matches any order line item
      const matchingSkus = itemSkus.filter(s => campaignSkus.has(s));
      if (!matchingSkus.length) continue;

      const qty = items
        .filter(i => campaignSkus.has((i.attributes?.sku||'').toLowerCase()))
        .reduce((s, i) => s + parseInt(i.attributes?.quantity || 0), 0);

      matched.push({
        orderId:     o.id,
        orderNumber: attrs.number || ('#' + o.id),
        createdAt:   attrs.ordered_at || attrs.created_at || '',
        skus:        [...new Set(matchingSkus.map(s => {
          // Return original-case SKU
          const orig = items.find(i => (i.attributes?.sku||'').toLowerCase() === s);
          return orig?.attributes?.sku || s;
        }))],
        qty,
      });
    }

    // Sort newest first
    matched.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    POState.orders[c.id] = matched;

  } catch(e) {
    console.error('Pre-order load failed:', e);
    POState.orders[c.id] = [];
    toast('Failed to load orders: ' + e.message, 'error');
  } finally {
    POState.loading[c.id] = false;
    renderPreOrders();
  }
};

// ── RELEASE HOLDS ─────────────────────────────────────────────
window.poConfirmRelease = function(campaignId) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  const orders = POState.orders[campaignId] || [];
  if (!orders.length) {
    if (!confirm('No held orders loaded yet. Refresh orders first, or proceed to attempt release anyway?\n\nClick OK to refresh orders first.')) return;
    loadCampaignOrders(c);
    return;
  }
  if (!confirm('Release ' + orders.length + ' held orders for "' + c.name + '"?\n\nThis will set operator_hold = 0 on each order, freeing them to move to your pack queue. Make sure you have also turned off the Co-Pilot hold rule first.\n\nClick OK to proceed.')) return;
  releaseHolds(campaignId);
};

async function releaseHolds(campaignId) {
  const c = POState.campaigns.find(x => x.id === campaignId);
  if (!c) return;
  const orders = POState.orders[campaignId] || [];
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
            attributes: { operator_hold: 0 },
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

// -- GIST INTEGRATION ---------------------------------------------------
// preorder_module.js loads AFTER app.js so applyConfigData is already defined.
// We patch it to also load pre-order campaigns.
// For save, we intercept the fetch call to the Gist PATCH to inject preOrderCampaigns.
(function() {
  // Patch applyConfigData to restore campaigns on Gist load
  const origApply = window.applyConfigData;
  if (origApply && !origApply._poPatched) {
    window.applyConfigData = function(parsed) {
      origApply(parsed);
      if (parsed && parsed.preOrderCampaigns) {
        POState.campaigns = parsed.preOrderCampaigns;
        updatePOBadge();
        console.log('Pre-order campaigns loaded:', POState.campaigns.length);
      }
    };
    window.applyConfigData._poPatched = true;
  }

  // Intercept GitHub Gist PATCH to inject preOrderCampaigns into fp_config.json
  const origFetch = window.fetch;
  window.fetch = function(url, options) {
    if (typeof url === 'string' && url.includes('api.github.com/gists') && options && options.method === 'PATCH') {
      try {
        const body = JSON.parse(options.body);
        const configFile = (body.files || {})['fp_config.json'];
        if (configFile && configFile.content) {
          const payload = JSON.parse(configFile.content);
          payload.preOrderCampaigns = POState.campaigns;
          configFile.content = JSON.stringify(payload);
          options = Object.assign({}, options, { body: JSON.stringify(body) });
        }
      } catch(e) {
        console.warn('PO Gist injection failed:', e.message);
      }
    }
    return origFetch.call(this, url, options);
  };
})();

// ── UTILITY ───────────────────────────────────────────────────
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
