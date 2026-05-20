/* ============================================================
   FAT POSSUM -- INVOICE MODULE
   invoice_module.js
   Creates B2B invoices, pushes to Packiyo, tracks payment
   ============================================================ */

// ── CONSTANTS ─────────────────────────────────────────────────
const INV_GIST_FILE   = 'fp_invoices.json';
const INV_LS_KEY      = 'fp_invoices_cache';
const INV_START_NUM   = 1000;
const INV_PREFIX      = 'FPINV-';
const SHIPPING_METHODS = [
  { code: 'MediaMail',      name: 'USPS Media Mail'   },
  { code: 'GroundAdvantage',name: 'USPS Ground Advantage' },
  { code: 'First',          name: 'USPS First Class'  },
  { code: 'Priority',       name: 'USPS Priority'     },
  { code: 'Express',        name: 'USPS Express'      },
  { code: 'UPSGround',      name: 'UPS Ground'        },
  { code: 'UPS2Day',        name: 'UPS 2-Day'         },
  { code: 'UPSOvernight',   name: 'UPS Overnight'     },
  { code: 'FedExLTL',       name: 'FedEx LTL'         },
];

// ── STATE ─────────────────────────────────────────────────────
const InvState = {
  invoices:     [],
  customers:    [],
  priceCatalog: {},
  nextNum:      INV_START_NUM,
  draft:        null,
  view:         'log',
  logFilter:    'all', // all | pending | past
};

// Store search results for index-based add (avoids JSON-in-onclick)
window._invSearchResults = [];

// ── HELPERS ───────────────────────────────────────────────────
function invEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function invFmt(n) {
  return '$' + parseFloat(n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}
function invDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
}
function invGetCreds() {
  try { if (typeof CONFIG !== 'undefined') return { gistId: CONFIG.GIST_ID, token: CONFIG.GIST_TOKEN }; } catch(e) {}
  try {
    const c = JSON.parse(localStorage.getItem('fp_config_cache') || '{}');
    if (c.GIST_ID) return { gistId: c.GIST_ID, token: c.GIST_TOKEN };
  } catch(e) {}
  return null;
}
function invGetPackiyoToken() {
  try { if (typeof CONFIG !== 'undefined') return CONFIG.PACKIYO_TOKEN; } catch(e) {}
  try { return JSON.parse(localStorage.getItem('fp_config_cache') || '{}').PACKIYO_TOKEN; } catch(e) {}
  return null;
}
async function invPackiyoFetch(path, opts) {
  const token = invGetPackiyoToken();
  const base  = 'https://fatpossum.app.packiyo.com/api/v1';
  const res = await fetch(base + path, Object.assign({
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
    }
  }, opts));
  if (!res.ok) {
    const t = await res.text();
    throw new Error('Packiyo ' + res.status + ': ' + t.slice(0, 200));
  }
  return res.json();
}

// ── GIST LOAD / SAVE ──────────────────────────────────────────
async function invLoad() {
  try {
    const cached = JSON.parse(localStorage.getItem(INV_LS_KEY) || 'null');
    if (cached) {
      InvState.invoices     = cached.invoices     || [];
      InvState.customers    = cached.customers    || [];
      InvState.priceCatalog = cached.priceCatalog || {};
      InvState.nextNum      = cached.nextNum      || INV_START_NUM;
    }
  } catch(e) {}

  const creds = invGetCreds();
  if (!creds) return;
  try {
    const res = await fetch('https://api.github.com/gists/' + creds.gistId, {
      headers: { 'Authorization': 'token ' + creds.token }, cache: 'no-store'
    });
    if (!res.ok) return;
    const gist = await res.json();
    const file = gist.files && gist.files[INV_GIST_FILE];
    if (file && file.content) {
      const data = JSON.parse(file.content);
      InvState.invoices     = data.invoices     || [];
      InvState.customers    = data.customers    || [];
      InvState.priceCatalog = data.priceCatalog || {};
      InvState.nextNum      = data.nextNum      || INV_START_NUM;
      invSaveLocal();
      const view = document.getElementById('view-invoices');
      if (view && !view.classList.contains('hidden')) invRender();
    }
  } catch(e) { console.warn('Invoice load error:', e.message); }
}

async function invSave() {
  invSaveLocal();
  const creds = invGetCreds();
  if (!creds) return;
  const payload = {
    invoices: InvState.invoices, customers: InvState.customers,
    priceCatalog: InvState.priceCatalog, nextNum: InvState.nextNum,
    savedAt: new Date().toISOString(),
  };
  try {
    await fetch('https://api.github.com/gists/' + creds.gistId, {
      method: 'PATCH',
      headers: { 'Authorization': 'token ' + creds.token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: { [INV_GIST_FILE]: { content: JSON.stringify(payload) } } }),
    });
  } catch(e) { console.warn('Invoice save error:', e.message); }
}

function invSaveLocal() {
  try {
    localStorage.setItem(INV_LS_KEY, JSON.stringify({
      invoices: InvState.invoices, customers: InvState.customers,
      priceCatalog: InvState.priceCatalog, nextNum: InvState.nextNum,
    }));
  } catch(e) {}
}

// ── RENDER ROUTER ─────────────────────────────────────────────
function invRender() {
  const body = document.getElementById('inv-body');
  if (!body) return;
  if (InvState.view === 'log')    return invRenderLog(body);
  if (InvState.view === 'edit')   return invRenderEdit(body);
  if (InvState.view === 'detail') return invRenderDetail(body);
}

window.switchToInvoices = function(mode) {
  if (window.switchView) switchView('invoices');
  if (mode === 'new') {
    InvState.view = 'log';
    InvState.logFilter = 'new';
    invRender();
    // Auto-open new invoice form after render
    setTimeout(invNewInvoice, 50);
  } else if (mode === 'pending') {
    InvState.view = 'log';
    InvState.logFilter = 'pending';
    invRender();
  } else if (mode === 'past') {
    InvState.view = 'log';
    InvState.logFilter = 'past';
    invRender();
  } else {
    InvState.view = 'log';
    InvState.logFilter = 'all';
    invRender();
  }
};

// ── INVOICE LOG ───────────────────────────────────────────────
function invIsPast(inv) {
  // Past = paid OR shipped (whichever comes last)
  return !!(inv.paidAt || inv.shippedAt || inv.status === 'shipped');
}

function invIsPending(inv) {
  // Pending = sent to Packiyo but not yet past (awaiting payment or shipment)
  return inv.status === 'sent' && !invIsPast(inv);
}

function invRenderLog(body) {
  const filter = InvState.logFilter || 'all';
  const all = InvState.invoices.slice().sort(function(a, b) { return b.number - a.number; });

  const filtered = all.filter(function(inv) {
    if (filter === 'pending') return invIsPending(inv) || inv.status === 'draft';
    if (filter === 'past')    return invIsPast(inv);
    return true;
  });

  function tabBtn(label, f) {
    const active = filter === f;
    const count  = all.filter(function(inv) {
      if (f === 'pending') return invIsPending(inv) || inv.status === 'draft';
      if (f === 'past')    return invIsPast(inv);
      return true;
    }).length;
    return '<button onclick="InvState.logFilter=\'' + f + '\';invRender()" style="padding:6px 14px;font-size:12px;font-weight:' + (active?'700':'500') + ';border:none;border-radius:4px;cursor:pointer;background:' + (active?'var(--accent)':'var(--surface2)') + ';color:' + (active?'#fff':'var(--text-muted)') + ';">'
      + label + (count ? ' <span style="background:rgba(255,255,255,0.25);border-radius:8px;padding:1px 6px;font-size:10px;">' + count + '</span>' : '') + '</button>';
  }

  function statusBadge(s) {
    const map = { draft:'#666', sent:'var(--accent)', paid:'var(--green)', shipped:'#7c3aed' };
    return '<span style="background:' + (map[s]||'#888') + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;">' + invEsc(s) + '</span>';
  }

  const rows = filtered.length
    ? filtered.map(function(inv) {
        const total = invCalcTotal(inv);
        return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="invOpenDetail(\'' + inv.id + '\')">'
          + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;color:var(--accent);font-size:13px;">' + invEsc(INV_PREFIX + inv.number) + '</td>'
          + '<td style="padding:10px 16px;font-size:13px;">' + invEsc(inv.billTo.company || inv.billTo.name || '') + '</td>'
          + '<td style="padding:10px 16px;font-size:12px;color:var(--text-muted);">' + invDate(inv.createdAt) + '</td>'
          + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;font-size:13px;">' + invFmt(total) + '</td>'
          + '<td style="padding:10px 16px;">' + statusBadge(inv.status) + '</td>'
          + '<td style="padding:10px 16px;font-size:11px;color:var(--text-muted);">' + invEsc(inv.packiyoOrderNum || inv.packiyoOrderId || '—') + '</td>'
          + '<td style="padding:8px 12px;"><button class="inv-del-btn" data-inv-id="' + inv.id + '" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;" title="Delete">&#128465;</button></td>'
          + '</tr>';
      }).join('')
    : '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px;">' + (filter==='past'?'No completed invoices yet.':filter==='pending'?'No pending invoices.':'No invoices yet.') + '</td></tr>';

  body.innerHTML = '<div style="padding:24px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
    + '<div><h2 style="margin:0;font-size:20px;">Invoices</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">'
    + 'Next: ' + INV_PREFIX + InvState.nextNum
    + ' &nbsp;·&nbsp; ' + Object.keys(InvState.priceCatalog).length + ' prices loaded'
    + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button onclick="invShowPriceImport()" class="btn-secondary btn-sm">&#8593; Import Prices</button>'
    + '<button onclick="invNewInvoice()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">+ New Invoice</button>'
    + '</div></div>'
    + '<div style="display:flex;gap:6px;margin-bottom:16px;">'
    + tabBtn('All', 'all') + tabBtn('Pending', 'pending') + tabBtn('Past', 'past')
    + '</div>'
    + '<div style="background:var(--surface);border-radius:8px;border:1px solid var(--border);overflow:hidden;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Invoice #</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Customer</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Date</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Total</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Status</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Packiyo Order</th>'
    + '<th style="padding:10px 16px;width:40px;"></th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

// ── NEW INVOICE ───────────────────────────────────────────────
window.invNewInvoice = function() {
  InvState.draft = {
    id: 'draft-' + Date.now(),
    number: InvState.nextNum,
    status: 'draft',
    createdAt: new Date().toISOString(),
    billTo: { name:'', company:'', address:'', address2:'', city:'', state:'', zip:'', country:'US', email:'', phone:'' },
    shipTo: { name:'', company:'', address:'', address2:'', city:'', state:'', zip:'', country:'US', email:'', phone:'' },
    shipSame: true,
    items: [],
    shipping: { method:'', methodName:'', cost:0 },
    poNumber: '',
    paymentHold: false,
    notes: '',
    terms: 'Net 30',
    packiyoOrderId: null,
    packiyoOrderNum: null,
    paidAt: null,
    sentAt: null,
  };
  InvState.view = 'edit';
  invRender();
};

// ── EDIT FORM ─────────────────────────────────────────────────
function invField(id, label, val, type) {
  return '<div style="margin-bottom:8px;">'
    + '<label style="font-size:10px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:3px;">' + label + '</label>'
    + '<input type="' + type + '" id="' + id + '" value="' + invEsc(val || '') + '" '
    + 'style="width:100%;padding:7px 10px;font-size:12px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);box-sizing:border-box;" /></div>';
}

function invAddrFields(prefix, addr) {
  return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
    + invField(prefix+'-name',    'Contact Name', addr.name,    'text')
    + invField(prefix+'-company', 'Company',      addr.company, 'text')
    + '</div>'
    + invField(prefix+'-address',  'Address',     addr.address,  'text')
    + invField(prefix+'-address2', 'Address 2',   addr.address2, 'text')
    + '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;">'
    + invField(prefix+'-city',  'City',  addr.city,  'text')
    + invField(prefix+'-state', 'State', addr.state, 'text')
    + invField(prefix+'-zip',   'ZIP',   addr.zip,   'text')
    + '</div>'
    + invField(prefix+'-email', 'Email', addr.email, 'email')
    + invField(prefix+'-phone', 'Phone', addr.phone, 'tel');
}

function invRenderEdit(body) {
  const inv = InvState.draft;
  if (!inv) { InvState.view = 'log'; return invRender(); }

  const shipOpts = SHIPPING_METHODS.map(function(m) {
    return '<option value="' + m.code + '"' + (inv.shipping.method === m.code ? ' selected' : '') + '>' + invEsc(m.name) + '</option>';
  }).join('');

  body.innerHTML = '<div style="padding:24px;max-width:960px;">'
    // Header
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
    + '<div><h2 style="margin:0;">New Invoice</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + INV_PREFIX + inv.number + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button onclick="invCancelEdit()" class="btn-secondary btn-sm">Cancel</button>'
    + '<button onclick="invSaveDraft()" class="btn-secondary btn-sm">Save Draft</button>'
    + '<button onclick="invReview()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">Review Invoice &#8594;</button>'
    + '</div></div>'

    // Customer search
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Customer</div>'
    + '<div style="position:relative;margin-bottom:16px;">'
    + '<input id="inv-customer-search" type="text" placeholder="Search address book or type customer name..." '
    + 'style="width:100%;padding:10px 14px;font-size:13px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);" '
    + 'oninput="invSearchCustomers(this.value)" autocomplete="off" />'
    + '<div id="inv-customer-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border2);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:100;max-height:200px;overflow-y:auto;"></div>'
    + '</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">'
    + '<div><div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:8px;">BILL TO</div>'
    + invAddrFields('bill', inv.billTo) + '</div>'
    + '<div><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--text-muted);">SHIP TO</div>'
    + '<label style="font-size:11px;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;gap:4px;">'
    + '<input type="checkbox" id="inv-ship-same" ' + (inv.shipSame ? 'checked' : '') + ' onchange="invToggleShipSame(this.checked)" /> Same as billing</label>'
    + '</div>'
    + '<div id="inv-shipto-fields" style="' + (inv.shipSame ? 'opacity:0.4;pointer-events:none;' : '') + '">'
    + invAddrFields('ship', inv.shipTo) + '</div></div>'
    + '</div></div>'

    // Line items
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;">Line Items</div>'
    + '<button onclick="invToggleBulkImport()" class="btn-secondary btn-sm" style="font-size:11px;">&#9776; Bulk Paste</button>'
    + '</div>'
    + '<div id="inv-bulk-area" style="display:none;margin-bottom:12px;background:var(--surface2);border:1px solid var(--border2);border-radius:6px;padding:12px;">'
    + '<div style="font-size:11px;color:var(--text-muted);margin-bottom:6px;">Paste from spreadsheet: <strong>UPC &nbsp;·&nbsp; Title &nbsp;·&nbsp; Artist &nbsp;·&nbsp; Qty</strong> (one row per line, tab or comma separated)</div>'
    + '<textarea id="inv-bulk-text" rows="5" placeholder="767981186115&#9;Frisco Mabel Joy&#9;Mickey Newbury&#9;5&#10;..." style="width:100%;padding:8px;font-size:12px;font-family:monospace;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);resize:vertical;box-sizing:border-box;"></textarea>'
    + '<div style="display:flex;justify-content:flex-end;margin-top:8px;gap:8px;">'
    + '<button onclick="invBulkImport()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:6px 16px;font-size:12px;font-weight:700;cursor:pointer;">Import Lines</button>'
    + '</div></div>'
    + '<div style="position:relative;margin-bottom:12px;">'
    + '<input id="inv-item-search" type="text" placeholder="Search by artist, title, SKU or UPC..." '
    + 'style="width:100%;padding:10px 14px;font-size:13px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);" '
    + 'oninput="invSearchItems(this.value)" autocomplete="off" />'
    + '<div id="inv-item-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border2);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:100;max-height:250px;overflow-y:auto;"></div>'
    + '</div>'
    + '<div id="inv-items-table">' + invRenderItemsTable(inv.items) + '</div>'
    + '</div>'

    // Shipping + Notes
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">'
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Shipping</div>'
    + '<div style="margin-bottom:10px;"><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Method</label>'
    + '<select id="inv-ship-method" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">'
    + '<option value="">Select shipping method...</option>' + shipOpts + '</select></div>'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Shipping Cost ($)</label>'
    + '<input type="number" id="inv-ship-cost" min="0" step="0.01" value="' + (inv.shipping.cost || '') + '" placeholder="0.00" '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" '
    + 'onchange="invUpdateShippingCost(parseFloat(this.value)||0)" /></div></div>'
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Notes & Terms</div>'
    + '<div style="margin-bottom:10px;"><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">PO Number</label>'
    + '<input type="text" id="inv-po-number" value="' + invEsc(inv.poNumber||'') + '" placeholder="Customer PO#..." '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" /></div>'
    + '<div style="margin-bottom:10px;"><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Payment Terms</label>'
    + '<input type="text" id="inv-terms" value="' + invEsc(inv.terms) + '" placeholder="Net 30" '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" /></div>'
    + '<div style="margin-bottom:10px;"><label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:8px 10px;background:' + (inv.paymentHold?'rgba(240,74,74,0.08)':'var(--surface2)') + ';border:1px solid ' + (inv.paymentHold?'var(--red)':'var(--border2)') + ';border-radius:4px;">'
    + '<input type="checkbox" id="inv-payment-hold" ' + (inv.paymentHold?'checked':'') + ' onchange="invTogglePaymentHold(this.checked)" style="width:14px;height:14px;cursor:pointer;" />'
    + '<span><strong style="color:' + (inv.paymentHold?'var(--red)':'var(--text)') + ';">Payment Hold</strong> <span style="font-size:11px;color:var(--text-muted);">Order enters Packiyo on hold — not pickable until payment received</span></span>'
    + '</label></div>'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Notes</label>'
    + '<textarea id="inv-notes" rows="3" placeholder="Notes or message..." '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);resize:vertical;">'
    + invEsc(inv.notes) + '</textarea></div></div>'
    + '</div>'

    // Totals
    + '<div style="display:flex;justify-content:flex-end;">'
    + '<div id="inv-totals-box" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;min-width:280px;">'
    + invRenderTotals(inv) + '</div></div></div>';
}

// ── ITEMS TABLE ───────────────────────────────────────────────
function invRenderItemsTable(items) {
  if (!items.length) {
    return '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">No items yet. Search above to add products.</div>';
  }
  const th = 'padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);';
  const rows = items.map(function(item, idx) {
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:8px 10px;font-size:11px;color:var(--text-muted);">' + invEsc(item.artist) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-weight:600;">' + invEsc(item.title) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;">' + invEsc(item.catalog) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;color:var(--text-muted);">' + invEsc(item.upc) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;">' + invEsc(item.format || '') + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;color:var(--text-muted);text-align:center;">' + (item.onHand !== undefined ? item.onHand : '—') + '</td>'
      + '<td style="padding:8px 10px;">'
      + '<input type="number" min="1" value="' + (item.qty || 1) + '" '
      + 'style="width:60px;padding:4px 6px;font-size:12px;border:1px solid var(--border2);border-radius:3px;background:var(--surface);color:var(--text);text-align:center;" '
      + 'onchange="invUpdateItem(' + idx + ',\'qty\',parseInt(this.value)||1)" /></td>'
      + '<td style="padding:8px 10px;">'
      + '<input type="number" min="0" step="0.01" value="' + parseFloat(item.price || 0).toFixed(2) + '" '
      + 'style="width:80px;padding:4px 6px;font-size:12px;border:1px solid var(--border2);border-radius:3px;background:var(--surface);color:var(--text);text-align:right;" '
      + 'onchange="invUpdateItem(' + idx + ',\'price\',parseFloat(this.value)||0)" /></td>'
      + '<td id="inv-line-total-' + idx + '" style="padding:8px 10px;font-family:monospace;font-weight:600;font-size:12px;text-align:right;">' + invFmt((item.qty||1)*(item.price||0)) + '</td>'
      + '<td style="padding:8px 10px;text-align:center;">'
      + '<button onclick="invRemoveItem(' + idx + ')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;">&#x2715;</button></td>'
      + '</tr>';
  }).join('');
  return '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="' + th + '">Artist</th>'
    + '<th style="' + th + '">Title</th>'
    + '<th style="' + th + '">Cat #</th>'
    + '<th style="' + th + '">UPC</th>'
    + '<th style="' + th + '">Format</th>'
    + '<th style="' + th + 'text-align:center;">On Hand</th>'
    + '<th style="' + th + '">Qty</th>'
    + '<th style="' + th + '">Unit Price</th>'
    + '<th style="' + th + 'text-align:right;">Line Total</th>'
    + '<th style="' + th + '"></th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function invRenderTotals(inv) {
  const subtotal = (inv.items || []).reduce(function(s, i) { return s + (i.qty||1)*(i.price||0); }, 0);
  const shipping = parseFloat(inv.shipping.cost || 0);
  const total    = subtotal + shipping;
  return '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Order Total</div>'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;"><span>Subtotal</span><span style="font-family:monospace;">' + invFmt(subtotal) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:13px;"><span>Shipping</span><span style="font-family:monospace;">' + invFmt(shipping) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding-top:10px;border-top:2px solid var(--border);font-size:16px;font-weight:800;">'
    + '<span>Total</span><span style="font-family:monospace;color:var(--accent);">' + invFmt(total) + '</span></div>';
}

function invCalcTotal(inv) {
  const sub = (inv.items||[]).reduce(function(s,i) { return s+(i.qty||1)*(i.price||0); }, 0);
  return sub + parseFloat(inv.shipping.cost || 0);
}

// ── ITEM SEARCH ───────────────────────────────────────────────
window.invSearchItems = function(q) {
  const results = document.getElementById('inv-item-results');
  if (!results) return;
  if (!q || q.length < 2) { results.style.display = 'none'; return; }

  const term = q.toLowerCase();
  const catalog = (typeof State !== 'undefined' && State.merged) ? State.merged : [];
  const matches = catalog.filter(function(p) {
    return (p.artist||'').toLowerCase().includes(term)
      || (p.title||'').toLowerCase().includes(term)
      || (p.catalog||'').toLowerCase().includes(term)
      || (p.upc||'').includes(term);
  }).slice(0, 12);

  if (!matches.length) { results.style.display = 'none'; return; }

  // Store in global for index-based add (avoids JSON-in-onclick issues)
  window._invSearchResults = matches;

  results.innerHTML = matches.map(function(p, idx) {
    const price  = InvState.priceCatalog[p.catalog] || InvState.priceCatalog[p.upc] || '';
    const onHand = p.fp_available !== undefined ? p.fp_available : '—';
    const priceStr = price ? invFmt(price) : '<span style="color:var(--text-dim)">no price</span>';
    return '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;"'
      + ' onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'"'
      + ' onclick="invAddItemByIdx(' + idx + ')">'
      + '<div>'
      + '<div style="font-size:12px;font-weight:600;">' + invEsc(p.artist||'') + ' — ' + invEsc(p.title||'') + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">' + invEsc(p.catalog||'') + ' &nbsp;·&nbsp; ' + invEsc(p.upc||'') + ' &nbsp;·&nbsp; On hand: ' + onHand + '</div>'
      + '</div>'
      + '<div style="font-size:12px;font-family:monospace;color:var(--accent);margin-left:12px;flex-shrink:0;">' + priceStr + '</div>'
      + '</div>';
  }).join('');
  results.style.display = 'block';
};

// Add item by index from stored search results
window.invAddItemByIdx = function(idx) {
  const p = (window._invSearchResults || [])[idx];
  if (!p || !InvState.draft) return;
  const price  = parseFloat(InvState.priceCatalog[p.catalog] || InvState.priceCatalog[p.upc] || 0);
  const onHand = p.fp_available !== undefined ? p.fp_available : undefined;
  InvState.draft.items.push({
    sku:     p.catalog || p.packiyo_sku || '',
    artist:  p.artist  || '',
    title:   p.title   || '',
    catalog: p.catalog || '',
    upc:     p.upc     || '',
    format:  p.format  || '',
    qty:     1,
    price:   price,
    onHand:  onHand,
  });
  const searchEl = document.getElementById('inv-item-search');
  if (searchEl) searchEl.value = '';
  const resultsEl = document.getElementById('inv-item-results');
  if (resultsEl) resultsEl.style.display = 'none';
  window._invSearchResults = [];
  const tableEl = document.getElementById('inv-items-table');
  if (tableEl) tableEl.innerHTML = invRenderItemsTable(InvState.draft.items);
  const totalsEl = document.getElementById('inv-totals-box');
  if (totalsEl) totalsEl.innerHTML = invRenderTotals(InvState.draft);
};

window.invUpdateShippingCost = function(val) {
  if (!InvState.draft) return;
  InvState.draft.shipping.cost = val;
  const totalsEl = document.getElementById('inv-totals-box');
  if (totalsEl) totalsEl.innerHTML = invRenderTotals(InvState.draft);
};

window.invUpdateItem = function(idx, field, val) {
  if (!InvState.draft || !InvState.draft.items[idx]) return;
  InvState.draft.items[idx][field] = val;
  // Update line total cell in place
  const lineEl = document.getElementById('inv-line-total-' + idx);
  if (lineEl) {
    const item = InvState.draft.items[idx];
    lineEl.textContent = invFmt((item.qty||1) * (item.price||0));
  }
  const totalsEl = document.getElementById('inv-totals-box');
  if (totalsEl) totalsEl.innerHTML = invRenderTotals(InvState.draft);
};

window.invRemoveItem = function(idx) {
  if (!InvState.draft) return;
  InvState.draft.items.splice(idx, 1);
  const tableEl = document.getElementById('inv-items-table');
  if (tableEl) tableEl.innerHTML = invRenderItemsTable(InvState.draft.items);
  const totalsEl = document.getElementById('inv-totals-box');
  if (totalsEl) totalsEl.innerHTML = invRenderTotals(InvState.draft);
};

// ── CUSTOMER SEARCH ───────────────────────────────────────────
window._invCustomerResults = [];

window.invSearchCustomers = function(q) {
  const results = document.getElementById('inv-customer-results');
  if (!results) return;
  if (!q || q.length < 1) { results.style.display = 'none'; return; }
  const term = q.toLowerCase();
  const matches = InvState.customers.filter(function(c) {
    return (c.name||'').toLowerCase().includes(term)
      || (c.company||'').toLowerCase().includes(term)
      || (c.email||'').toLowerCase().includes(term);
  }).slice(0, 8);

  if (!matches.length) { results.style.display = 'none'; return; }
  window._invCustomerResults = matches;
  results.innerHTML = matches.map(function(c, i) {
    return '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);"'
      + ' onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'"'
      + ' onclick="invSelectCustomer(' + i + ')">'
      + '<div style="font-size:13px;font-weight:600;">' + invEsc(c.company || c.name) + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted);">' + invEsc(c.name) + ' &nbsp;·&nbsp; ' + invEsc(c.email||'') + '</div>'
      + '</div>';
  }).join('');
  results.style.display = 'block';
};

window.invSelectCustomer = function(idx) {
  const c = (window._invCustomerResults || [])[idx];
  if (!c || !InvState.draft) return;
  InvState.draft.billTo = Object.assign({}, c);
  if (InvState.draft.shipSame) InvState.draft.shipTo = Object.assign({}, c);
  document.getElementById('inv-customer-results').style.display = 'none';
  invRenderEdit(document.getElementById('inv-body'));
};

window.invPrint = function() {
  const printArea = document.getElementById('inv-print-area');
  if (!printArea) return;

  const win = window.open('', '_blank', 'width=850,height=1100');
  win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Invoice</title>');
  win.document.write('<base href="' + window.location.href.replace(/\/[^\/]*$/, '/') + '">');
  win.document.write('<style>');
  win.document.write('* { box-sizing: border-box; margin: 0; padding: 0; }');
  win.document.write('body { font-family: Arial, sans-serif; font-size: 10px; color: #111; background: white; padding: 14mm; }');
  win.document.write('table { width: 100%; border-collapse: collapse; table-layout: fixed; font-size: 8.5px; margin-bottom: 14px; }');
  win.document.write('thead { display: table-header-group; }');
  win.document.write('tfoot { display: table-footer-group; }');
  win.document.write('th { background: #111; color: white; padding: 5px 5px; text-align: left; font-size: 8px; text-transform: uppercase; letter-spacing: 0.3px; overflow: hidden; white-space: nowrap; }');
  win.document.write('td { padding: 4px 5px; border-bottom: 1px solid #eee; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }');
  win.document.write('tr { page-break-inside: avoid; }');
  win.document.write('.totals-wrap { display: flex; justify-content: flex-end; margin: 14px 0; page-break-inside: avoid; }');
  win.document.write('.totals-table { width: 220px; border-collapse: collapse; font-size: 11px; }');
  win.document.write('.totals-table td { padding: 5px 8px; border-bottom: 1px solid #eee; white-space: normal; }');
  win.document.write('.totals-total { background: #111; color: white; font-weight: 900; font-size: 13px; }');
  win.document.write('.footer { margin-top: 14px; padding-top: 10px; border-top: 1px solid #ddd; font-size: 8.5px; color: #888; line-height: 1.7; page-break-inside: avoid; }');
  win.document.write('.footer strong { font-size: 10px; color: #555; display: block; margin-bottom: 3px; }');
  win.document.write('.notes { padding: 8px 10px; background: #f8f8f8; border-left: 3px solid #b83228; font-size: 10px; color: #555; margin-bottom: 12px; page-break-inside: avoid; }');
  win.document.write('@page { size: letter portrait; margin: 0; }');
  win.document.write('@media print { body { padding: 14mm; } }');
  win.document.write('</style></head><body>');
  win.document.write(printArea.innerHTML);
  win.document.write('</body></html>');
  win.document.close();

  win.onload = function() {
    win.focus();
    win.print();
  };
};
window.invTogglePaymentHold = function(checked) {
  InvState.draft.paymentHold = checked;
  // Update checkbox label color in place
  const label = document.querySelector('label:has(#inv-payment-hold)');
  if (label) {
    label.style.background = checked ? 'rgba(240,74,74,0.08)' : 'var(--surface2)';
    label.style.border = '1px solid ' + (checked ? 'var(--red)' : 'var(--border2)');
    const strong = label.querySelector('strong');
    if (strong) strong.style.color = checked ? 'var(--red)' : 'var(--text)';
  }
};

window.invToggleBulkImport = function() {
  const el = document.getElementById('inv-bulk-area');
  if (el) el.style.display = el.style.display === 'none' ? 'block' : 'none';
};

window.invBulkImport = function() {
  const text = (document.getElementById('inv-bulk-text') || {}).value || '';
  if (!text.trim() || !InvState.draft) return;

  const catalog = (typeof State !== 'undefined' && State.merged) ? State.merged : [];
  const upcMap  = {};
  const skuMap  = {};
  catalog.forEach(function(p) {
    if (p.upc)     upcMap[p.upc.trim()]     = p;
    if (p.catalog) skuMap[p.catalog.trim().toLowerCase()] = p;
  });

  let added = 0, notFound = [];
  const lines = text.trim().split('\n');

  lines.forEach(function(line) {
    if (!line.trim()) return;
    // Support tab or comma separated
    const cols = line.includes('\t') ? line.split('\t') : line.split(',');
    const upc   = (cols[0] || '').trim().replace(/"/g,'');
    const title = (cols[1] || '').trim().replace(/"/g,'');
    const artist= (cols[2] || '').trim().replace(/"/g,'');
    const qty   = parseInt((cols[3] || '1').trim()) || 1;

    // Try to match by UPC first, then title+artist
    let product = upcMap[upc];
    if (!product && title) {
      product = catalog.find(function(p) {
        return (p.title||'').toLowerCase() === title.toLowerCase();
      });
    }

    if (product) {
      const price = parseFloat(InvState.priceCatalog[product.catalog] || InvState.priceCatalog[product.upc] || 0);
      InvState.draft.items.push({
        sku:     product.catalog || product.packiyo_sku || '',
        artist:  product.artist  || artist  || '',
        title:   product.title   || title   || '',
        catalog: product.catalog || '',
        upc:     product.upc     || upc     || '',
        format:  product.format  || '',
        qty:     qty,
        price:   price,
        onHand:  product.fp_available !== undefined ? product.fp_available : undefined,
      });
      added++;
    } else if (upc || title) {
      notFound.push(upc || title);
    }
  });

  // Clear textarea and hide
  const ta = document.getElementById('inv-bulk-text');
  if (ta) ta.value = '';
  document.getElementById('inv-bulk-area').style.display = 'none';

  // Re-render items table
  const tableEl = document.getElementById('inv-items-table');
  if (tableEl) tableEl.innerHTML = invRenderItemsTable(InvState.draft.items);
  const totalsEl = document.getElementById('inv-totals-box');
  if (totalsEl) totalsEl.innerHTML = invRenderTotals(InvState.draft);

  let msg = added + ' item' + (added !== 1 ? 's' : '') + ' added.';
  if (notFound.length) msg += ' Not found: ' + notFound.slice(0, 5).join(', ') + (notFound.length > 5 ? '...' : '');
  if (window.toast) toast(msg, notFound.length ? '' : 'success');
};

window.invToggleShipSame = function(checked) {
  if (!InvState.draft) return;
  InvState.draft.shipSame = checked;
  const el = document.getElementById('inv-shipto-fields');
  if (el) { el.style.opacity = checked ? '0.4' : '1'; el.style.pointerEvents = checked ? 'none' : 'auto'; }
};

// ── COLLECT FORM ──────────────────────────────────────────────
function invCollectForm() {
  const inv = InvState.draft;
  if (!inv) return;
  function g(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; }

  inv.billTo = { name:g('bill-name'), company:g('bill-company'), address:g('bill-address'), address2:g('bill-address2'), city:g('bill-city'), state:g('bill-state'), zip:g('bill-zip'), country:'US', email:g('bill-email'), phone:g('bill-phone') };
  if (!inv.shipSame) {
    inv.shipTo = { name:g('ship-name'), company:g('ship-company'), address:g('ship-address'), address2:g('ship-address2'), city:g('ship-city'), state:g('ship-state'), zip:g('ship-zip'), country:'US', email:g('ship-email'), phone:g('ship-phone') };
  } else {
    inv.shipTo = Object.assign({}, inv.billTo);
  }

  const method = g('inv-ship-method');
  const methodObj = method ? SHIPPING_METHODS.find(function(m) { return m.code === method; }) : null;
  inv.shipping = { method:method, methodName:methodObj ? methodObj.name : '', cost:parseFloat(g('inv-ship-cost'))||0 };
  inv.poNumber = g('inv-po-number');
  inv.paymentHold = !!(document.getElementById('inv-payment-hold') && document.getElementById('inv-payment-hold').checked);
  inv.notes = g('inv-notes');
  inv.terms = g('inv-terms') || 'Net 30';

  // Auto-save to address book
  const company = inv.billTo.company || inv.billTo.name;
  if (company && !InvState.customers.some(function(c) { return (c.company||c.name) === company; })) {
    InvState.customers.push(Object.assign({}, inv.billTo));
  }
}

window.invSaveDraft = function() {
  invCollectForm();
  const inv = InvState.draft;
  if (!inv) return;
  const i = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
  if (i >= 0) InvState.invoices[i] = inv; else InvState.invoices.push(inv);
  invSave();
  if (window.toast) toast('Draft saved.', '');
};

window.invCancelEdit = function() {
  InvState.draft = null;
  InvState.view  = 'log';
  invRender();
};

window.invReview = function() {
  invCollectForm();
  InvState.view = 'detail';
  invRender();
};

window.invOpenDetail = function(id) {
  const inv = InvState.invoices.find(function(x) { return x.id === id; });
  if (!inv) return;
  InvState.draft = JSON.parse(JSON.stringify(inv));
  InvState.view  = 'detail';
  invRender();
};

// ── DETAIL / PRINT VIEW ───────────────────────────────────────
function invRenderDetail(body) {
  const inv = InvState.draft;
  if (!inv) { InvState.view = 'log'; return invRender(); }

  const subtotal = (inv.items||[]).reduce(function(s,i) { return s+(i.qty||1)*(i.price||0); }, 0);
  const shipping = parseFloat(inv.shipping.cost || 0);
  const total    = subtotal + shipping;
  const isDraft  = inv.status === 'draft';

  function addrBlock(addr, label) {
    return '<div>'
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#888;letter-spacing:1px;margin-bottom:6px;">' + label + '</div>'
      + '<div style="font-size:13px;line-height:1.7;color:#222;">'
      + (addr.company ? '<strong>' + invEsc(addr.company) + '</strong><br>' : '')
      + invEsc(addr.name) + '<br>'
      + invEsc(addr.address) + (addr.address2 ? '<br>' + invEsc(addr.address2) : '') + '<br>'
      + invEsc(addr.city) + ', ' + invEsc(addr.state) + ' ' + invEsc(addr.zip) + '<br>'
      + (addr.email ? invEsc(addr.email) + '<br>' : '')
      + (addr.phone ? invEsc(addr.phone) : '')
      + '</div></div>';
  }

  const lineRows = (inv.items||[]).map(function(item) {
    return '<tr style="border-bottom:1px solid #eee;">'
      + '<td style="padding:5px 6px;font-size:9px;color:#444;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' + invEsc(item.artist) + '</td>'
      + '<td style="padding:5px 6px;font-size:9px;font-weight:600;color:#111;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;">' + invEsc(item.title) + '</td>'
      + '<td style="padding:5px 6px;font-size:9px;font-family:monospace;color:#555;">' + invEsc(item.catalog) + '</td>'
      + '<td style="padding:5px 6px;font-size:9px;font-family:monospace;color:#777;">' + invEsc(item.upc) + '</td>'
      + '<td style="padding:5px 4px;font-size:9px;text-align:center;color:#555;">' + invEsc(item.format||'') + '</td>'
      + '<td style="padding:5px 4px;font-size:9px;text-align:center;font-weight:700;">' + (item.qty||1) + '</td>'
      + '<td style="padding:5px 6px;font-size:9px;font-family:monospace;text-align:right;">' + invFmt(item.price||0) + '</td>'
      + '<td style="padding:5px 6px;font-size:9px;font-family:monospace;font-weight:700;text-align:right;">' + invFmt((item.qty||1)*(item.price||0)) + '</td>'
      + '</tr>';
  }).join('');

  body.innerHTML = '<div id="inv-detail-wrap" style="padding:24px;max-width:900px;">'
    // Action bar
    + '<div class="no-print" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">'
    + '<button onclick="invSaveDraft();invBackToLog()" class="btn-secondary btn-sm">&#8592; Save &amp; Back</button>'
    + '<div style="display:flex;gap:8px;">'
    + (isDraft ? '<button onclick="invEditDraft()" class="btn-secondary btn-sm">&#9998; Edit</button>' : '')
    + '<button onclick="invPrint()" class="btn-secondary btn-sm">&#128438; Print / PDF</button>'
    + (isDraft ? '<button onclick="invPushToPackiyo()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#9654; Send &amp; Push to Packiyo</button>' : '')
    + (inv.status === 'sent' && !inv.paidAt ? '<button onclick="invMarkPaid()" style="background:var(--green);color:#000;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#10004; Mark as Paid</button>' : '')
    + '<button onclick="invDelete()" style="background:none;border:1px solid var(--red);color:var(--red);border-radius:4px;padding:8px 14px;font-size:12px;font-weight:600;cursor:pointer;">&#128465; Delete</button>'
    + '</div></div>'

    // Print area
    + '<div id="inv-print-area" style="background:white;color:#111;border:1px solid var(--border);border-radius:8px;padding:24px 28px;font-family:Arial,sans-serif;font-size:12px;max-width:800px;">'

    // Header
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:16px;padding-bottom:12px;border-bottom:2px solid #b83228;">'
    + '<div>'
    + '<img src="FP-Logo_Submark-Black.jpg" alt="Fat Possum Records" style="width:70px;height:70px;object-fit:contain;display:block;margin-bottom:6px;" />'
    + '<div style="font-size:13px;font-weight:700;color:#111;letter-spacing:0.5px;">FAT POSSUM RECORDS</div>'
    + '<div style="font-size:10px;color:#666;margin-top:3px;">PO Box 1923 &nbsp;·&nbsp; Oxford, MS 38655</div>'
    + '<div style="font-size:10px;color:#666;">orders@fatpossum.com &nbsp;·&nbsp; 662-234-2828</div>'
    + '</div>'
    + '<div style="text-align:right;">'
    + '<div style="font-size:16px;font-weight:900;color:#111;text-transform:uppercase;letter-spacing:1px;">Invoice</div>'
    + '<div style="font-size:14px;font-family:monospace;font-weight:700;color:#b83228;margin-top:4px;">' + invEsc(INV_PREFIX + inv.number) + '</div>'
    + '<div style="font-size:12px;color:#666;margin-top:6px;">Date: <strong>' + invDate(inv.createdAt) + '</strong></div>'
    + '<div style="font-size:12px;color:#666;">Terms: <strong>' + invEsc(inv.terms||'Net 30') + '</strong></div>'
    + (inv.poNumber ? '<div style="font-size:12px;color:#666;">PO#: <strong>' + invEsc(inv.poNumber) + '</strong></div>' : '')
    + (inv.paidAt ? '<div style="margin-top:8px;background:#16a34a;color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:700;display:inline-block;">PAID ' + invDate(inv.paidAt) + '</div>' : '')
    + (inv.paymentHold && !inv.paidAt ? '<div style="margin-top:8px;background:#ef4444;color:white;padding:4px 12px;border-radius:4px;font-size:12px;font-weight:700;display:inline-block;">PAYMENT HOLD</div>' : '')
    + '</div></div>'

    // Addresses
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:16px;padding:12px 14px;background:#f8f8f8;border-radius:4px;">'
    + addrBlock(inv.billTo, 'Bill To')
    + addrBlock(inv.shipSame ? inv.billTo : inv.shipTo, 'Ship To')
    + '</div>'

    + (inv.shipping.methodName ? '<div style="margin-bottom:16px;font-size:12px;color:#555;"><strong>Shipping Method:</strong> ' + invEsc(inv.shipping.methodName) + '</div>' : '')

    // Line items
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:16px;table-layout:fixed;">'
    + '<colgroup>'
    + '<col style="width:18%;">'  // Artist
    + '<col style="width:22%;">'  // Title
    + '<col style="width:10%;">'  // Cat #
    + '<col style="width:13%;">'  // UPC
    + '<col style="width:8%;">'   // Format
    + '<col style="width:5%;">'   // Qty
    + '<col style="width:12%;">'  // Unit Price
    + '<col style="width:12%;">'  // Total
    + '</colgroup>'
    + '<thead style="display:table-header-group;"><tr style="background:#111;color:white;">'
    + '<th style="padding:6px 6px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;overflow:hidden;white-space:nowrap;">Artist</th>'
    + '<th style="padding:6px 6px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;overflow:hidden;white-space:nowrap;">Title</th>'
    + '<th style="padding:6px 6px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;overflow:hidden;white-space:nowrap;">Cat #</th>'
    + '<th style="padding:6px 6px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;overflow:hidden;white-space:nowrap;">UPC</th>'
    + '<th style="padding:6px 4px;text-align:center;font-size:9px;font-weight:700;text-transform:uppercase;">Fmt</th>'
    + '<th style="padding:6px 4px;text-align:center;font-size:9px;font-weight:700;text-transform:uppercase;">Qty</th>'
    + '<th style="padding:6px 6px;text-align:right;font-size:9px;font-weight:700;text-transform:uppercase;">Price</th>'
    + '<th style="padding:6px 6px;text-align:right;font-size:9px;font-weight:700;text-transform:uppercase;">Total</th>'
    + '</tr></thead><tbody>' + lineRows + '</tbody></table>'

    // Totals — full width table instead of flex-end div so it doesn't overflow
    + '<div class="inv-totals-block" style="display:flex;justify-content:flex-end;margin-bottom:16px;">'
    + '<table style="width:220px;border-collapse:collapse;font-size:11px;">'
    + '<tr style="border-bottom:1px solid #eee;"><td style="padding:5px 8px;color:#555;">Subtotal</td><td style="padding:5px 8px;text-align:right;font-family:monospace;">' + invFmt(subtotal) + '</td></tr>'
    + '<tr style="border-bottom:1px solid #eee;"><td style="padding:5px 8px;color:#555;">Shipping' + (inv.shipping.methodName ? '<br><span style="font-size:9px;color:#aaa;">' + invEsc(inv.shipping.methodName) + '</span>' : '') + '</td><td style="padding:5px 8px;text-align:right;font-family:monospace;">' + invFmt(shipping) + '</td></tr>'
    + '<tr style="background:#111;color:white;"><td style="padding:8px 8px;font-weight:900;font-size:13px;">Total</td><td style="padding:8px 8px;text-align:right;font-family:monospace;font-weight:900;font-size:13px;">' + invFmt(total) + '</td></tr>'
    + '</table></div>'

    + (inv.notes ? '<div style="padding:8px 10px;background:#f8f8f8;border-radius:4px;font-size:10px;color:#555;border-left:3px solid #b83228;margin-bottom:12px;"><strong>Notes:</strong> ' + invEsc(inv.notes) + '</div>' : '')
    + '<div class="inv-footer-block" style="margin-top:16px;padding-top:10px;border-top:1px solid #ddd;font-size:8.5px;color:#888;line-height:1.7;">'
    + '<strong style="font-size:10px;color:#555;display:block;margin-bottom:3px;">Payment / Wire Transfer Information</strong>'
    + 'Bank: Renasant Bank &nbsp;|&nbsp; 111 Jackson Avenue East, Oxford, MS 38655 &nbsp;|&nbsp; (877) 367-5371<br>'
    + 'Account Name: Fat Possum Records LLC &nbsp;|&nbsp; Account #: 3100304905 &nbsp;|&nbsp; ABA: 084201294<br>'
    + 'Checks: Fat Possum Records &nbsp;|&nbsp; Attn: Patrick Addison &nbsp;|&nbsp; 827 N Lamar Blvd, Oxford, MS 38655'
    + '</div>'
    + '</div></div>';
}

window.invBackToLog = function() { InvState.draft = null; InvState.view = 'log'; invRender(); };
window.invEditDraft = function() { InvState.view = 'edit'; invRender(); };

// ── PUSH TO PACKIYO ───────────────────────────────────────────
window.invPushToPackiyo = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (!inv.items.length) { if (window.toast) toast('Add at least one line item first.', 'error'); return; }
  if (!inv.billTo.name && !inv.billTo.company) { if (window.toast) toast('Add customer info first.', 'error'); return; }
  if (!confirm('Push ' + INV_PREFIX + inv.number + ' to Packiyo as a new order?\n\n' + inv.items.length + ' items · Total ' + invFmt(invCalcTotal(inv)))) return;
  invCreatePackiyoOrder(inv);
};

async function invCreatePackiyoOrder(inv) {
  if (window.toast) toast('Creating order in Packiyo...', '');
  try {
    const shipTo = inv.shipSame ? inv.billTo : inv.shipTo;

    // Build payload matching confirmed working structure
    const orderPayload = {
      data: {
        type: 'orders',
        attributes: {
          number:        inv.poNumber ? inv.poNumber : INV_PREFIX + inv.number,
          external_id:   INV_PREFIX + inv.number,
          ordered_at:    inv.createdAt,
          shipping:      inv.shipping.cost || 0,
          internal_note: inv.notes || '',
          packing_note:  inv.poNumber ? 'PO# ' + inv.poNumber : '',
          tags:          'B2B, Invoice',
          payment_hold:  inv.paymentHold ? 1 : 0,
          is_wholesale:  true,
          shipping_method_name: inv.shipping.method || inv.shipping.methodName || '',
          order_item_data: inv.items.map(function(item) {
            return {
              sku:         item.sku,
              quantity:    item.qty   || 1,
              price:       item.price || 0,
              external_id: item.catalog || item.sku,
            };
          }),
          shipping_contact_information_data: {
            name:         shipTo.name     || '',
            company_name: shipTo.company  || '',
            address:      shipTo.address  || '',
            address2:     shipTo.address2 || '',
            city:         shipTo.city     || '',
            state:        shipTo.state    || '',
            zip:          shipTo.zip      || '',
            country:      shipTo.country  || 'US',
            email:        shipTo.email    || '',
            phone:        shipTo.phone    || '',
          },
          billing_contact_information_data: {
            name:         inv.billTo.name     || '',
            company_name: inv.billTo.company  || '',
            address:      inv.billTo.address  || '',
            address2:     inv.billTo.address2 || '',
            city:         inv.billTo.city     || '',
            state:        inv.billTo.state    || '',
            zip:          inv.billTo.zip      || '',
            country:      inv.billTo.country  || 'US',
            email:        inv.billTo.email    || '',
            phone:        inv.billTo.phone    || '',
          },
        },
        relationships: {
          customer: { data: { type: 'customers', id: '12' } }
        },
      }
    };

    const orderResult = await invPackiyoFetch('/orders', { method:'POST', body: JSON.stringify(orderPayload) });
    const orderId  = orderResult.data && orderResult.data.id;
    const orderNum = orderResult.data && orderResult.data.attributes && orderResult.data.attributes.number;

    if (!orderId) throw new Error('No order ID returned from Packiyo');

    inv.status          = 'sent';
    inv.packiyoOrderId  = orderId;
    inv.packiyoOrderNum = orderNum || null;
    inv.sentAt          = new Date().toISOString();
    InvState.nextNum++;

    const idx = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
    if (idx >= 0) InvState.invoices[idx] = inv; else InvState.invoices.push(inv);

    await invSave();
    if (window.toast) toast('Order #' + (orderNum||orderId) + ' created in Packiyo with ' + inv.items.length + ' items!', 'success');
    invRender();

  } catch(e) {
    console.error('Packiyo order creation failed:', e);
    if (window.toast) toast('Packiyo error: ' + e.message, 'error');
  }
}

// ── MARK PAID ─────────────────────────────────────────────────
window.invDelete = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (!confirm('Delete ' + INV_PREFIX + inv.number + '? This cannot be undone.')) return;
  InvState.invoices = InvState.invoices.filter(function(x) { return x.id !== inv.id; });
  InvState.draft = null;
  InvState.view  = 'log';
  invSave();
  invRender();
  if (window.toast) toast('Invoice deleted.', '');
};

window.invDeleteById = function(id) {
  const inv = InvState.invoices.find(function(x) { return x.id === id; });
  if (!inv) return;
  if (!confirm('Delete ' + INV_PREFIX + inv.number + '? This cannot be undone.')) return;
  InvState.invoices = InvState.invoices.filter(function(x) { return x.id !== id; });
  invSave();
  invRender();
  if (window.toast) toast('Invoice deleted.', '');
};

window.invMarkPaid = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (!confirm('Mark ' + INV_PREFIX + inv.number + ' as paid?')) return;
  inv.status = 'paid';
  inv.paidAt = new Date().toISOString();
  const i = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
  if (i >= 0) InvState.invoices[i] = inv;
  invSave();
  invRender();
  if (window.toast) toast('Marked as paid.', 'success');
};

// ── PRICE IMPORT ──────────────────────────────────────────────
window.invShowPriceImport = function() {
  const modal = document.getElementById('inv-price-modal');
  if (modal) modal.style.display = 'flex';
  const countEl = document.getElementById('inv-price-count');
  if (countEl) countEl.textContent = Object.keys(InvState.priceCatalog).length;
};

window.invClosePriceImport = function() {
  const modal = document.getElementById('inv-price-modal');
  if (modal) modal.style.display = 'none';
};

window.invHandlePriceCSV = function(input) {
  const file = input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const lines = e.target.result.split('\n');
    const header = lines[0].split(',').map(function(h) { return h.replace(/"/g,'').trim().toLowerCase(); });
    const skuIdx   = header.findIndex(function(h) { return h.includes('variant sku') || h === 'sku'; });
    const priceIdx = header.findIndex(function(h) { return h.includes('variant price') || h === 'price'; });

    if (skuIdx < 0 || priceIdx < 0) {
      if (window.toast) toast('CSV must have "Variant SKU" and "Variant Price" columns.', 'error');
      return;
    }

    let imported = 0, skipped = 0;
    lines.slice(1).forEach(function(line) {
      if (!line.trim()) return;
      // Handle CSV with quoted fields
      const cols = [];
      let cur = '', inQ = false;
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '"') { inQ = !inQ; }
        else if (line[i] === ',' && !inQ) { cols.push(cur.trim()); cur = ''; }
        else { cur += line[i]; }
      }
      cols.push(cur.trim());

      const sku   = (cols[skuIdx]   || '').replace(/^"|"$/g,'').trim();
      const price = parseFloat((cols[priceIdx] || '').replace(/^"|"$/g,'').trim());
      if (sku && !isNaN(price) && price > 0) { InvState.priceCatalog[sku] = price; imported++; }
      else { skipped++; }
    });

    invSave();
    invClosePriceImport();
    if (window.toast) toast(imported + ' prices imported, ' + skipped + ' skipped.', 'success');
    // Re-render log to show updated price count
    if (InvState.view === 'log') invRender();
  };
  reader.readAsText(file);
};

// ── PRINT HELPERS ─────────────────────────────────────────────
(function() {
  const style = document.createElement('style');
  style.textContent = [
    '@media print {',
    '  .no-print { display:none !important; }',
    '  #sidebar { display:none !important; }',
    '  #top-bar, #needs-attention-banner { display:none !important; }',
    '  body, html { overflow:visible !important; height:auto !important; background:white !important; }',
    '  #main-content { overflow:visible !important; display:block !important; height:auto !important; min-height:0 !important; }',
    '  .view { display:none !important; }',
    '  #view-invoices { display:block !important; overflow:visible !important; height:auto !important; }',
    '  #inv-detail-wrap { padding:0 !important; max-width:none !important; width:100% !important; height:auto !important; }',
    '  #inv-print-area { border:none !important; border-radius:0 !important; padding:0 !important; box-shadow:none !important; font-size:10px !important; width:100% !important; box-sizing:border-box !important; overflow:visible !important; height:auto !important; }',
    '  #inv-print-area table { font-size:8.5px !important; table-layout:fixed !important; width:100% !important; border-collapse:collapse !important; }',
    '  #inv-print-area th, #inv-print-area td { padding:3px 4px !important; overflow:hidden !important; text-overflow:ellipsis !important; white-space:nowrap !important; }',
    '  #inv-print-area tbody tr { page-break-inside:avoid !important; }',
    '  .inv-totals-block, .inv-footer-block { page-break-inside:avoid !important; }',
    '  @page { size: letter portrait; margin: 12mm 14mm; }',
    '}'
  ].join(' ');
  document.head.appendChild(style);

  // Override inline height/overflow on inv-body before printing
  // (inline styles beat stylesheet !important in most browsers)
  var _invBodyStyle = null;
  var _mainStyle = null;
  var _viewStyle = null;

  window.addEventListener('beforeprint', function() {
    var invBody = document.getElementById('inv-body');
    if (invBody) {
      _invBodyStyle = invBody.getAttribute('style');
      invBody.style.height = 'auto';
      invBody.style.overflow = 'visible';
      invBody.style.maxHeight = 'none';
    }
    var main = document.getElementById('main-content');
    if (main) {
      _mainStyle = main.getAttribute('style');
      main.style.overflow = 'visible';
      main.style.height = 'auto';
    }
    var view = document.getElementById('view-invoices');
    if (view) {
      _viewStyle = view.getAttribute('style');
      view.style.overflow = 'visible';
      view.style.height = 'auto';
    }
  });

  window.addEventListener('afterprint', function() {
    var invBody = document.getElementById('inv-body');
    if (invBody && _invBodyStyle !== null) invBody.setAttribute('style', _invBodyStyle);
    var main = document.getElementById('main-content');
    if (main && _mainStyle !== null) main.setAttribute('style', _mainStyle);
    var view = document.getElementById('view-invoices');
    if (view && _viewStyle !== null) view.setAttribute('style', _viewStyle);
  });
})();

// Event delegation for log delete buttons
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.inv-del-btn');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const id = btn.dataset.invId;
  console.log('delete clicked, id:', id);
  if (id) invDeleteById(id);
});

// ── BOOT ──────────────────────────────────────────────────────
(function() {
  let attempts = 0;
  function tryLoad() {
    attempts++;
    const creds = invGetCreds();
    if (creds) { invLoad(); }
    else if (attempts < 20) { setTimeout(tryLoad, 500); }
  }
  tryLoad();
})();
