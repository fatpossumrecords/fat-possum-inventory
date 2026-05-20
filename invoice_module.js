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
  { code: 'usps_media',     name: 'USPS Media Mail' },
  { code: 'ups_ground',     name: 'UPS Ground' },
  { code: 'ups_2day',       name: 'UPS 2-Day' },
  { code: 'ups_overnight',  name: 'UPS Overnight' },
  { code: 'fedex_ltl',      name: 'FedEx LTL' },
];

// ── STATE ─────────────────────────────────────────────────────
const InvState = {
  invoices:      [],   // all invoices
  customers:     [],   // address book
  priceCatalog:  {},   // { sku: price }
  nextNum:       INV_START_NUM,
  draft:         null, // invoice being edited
  view:          'log', // log | edit | detail | print
};

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
function invPackiyoFetch(path, opts) {
  const token = invGetPackiyoToken();
  const base  = 'https://fatpossum.app.packiyo.com/api/v1';
  return fetch(base + path, Object.assign({
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
    }
  }, opts)).then(function(r) {
    if (!r.ok) return r.text().then(function(t) { throw new Error('Packiyo ' + r.status + ': ' + t.slice(0,100)); });
    return r.json();
  });
}

// ── GIST LOAD / SAVE ──────────────────────────────────────────
async function invLoad() {
  // Restore from localStorage immediately
  try {
    const cached = JSON.parse(localStorage.getItem(INV_LS_KEY) || 'null');
    if (cached) {
      InvState.invoices    = cached.invoices    || [];
      InvState.customers   = cached.customers   || [];
      InvState.priceCatalog = cached.priceCatalog || {};
      InvState.nextNum     = cached.nextNum      || INV_START_NUM;
    }
  } catch(e) {}

  // Then fetch from Gist
  const creds = invGetCreds();
  if (!creds) return;
  try {
    const res  = await fetch('https://api.github.com/gists/' + creds.gistId, {
      headers: { 'Authorization': 'token ' + creds.token }, cache: 'no-store'
    });
    if (!res.ok) return;
    const gist = await res.json();
    const file = gist.files && gist.files[INV_GIST_FILE];
    if (file && file.content) {
      const data = JSON.parse(file.content);
      InvState.invoices    = data.invoices    || [];
      InvState.customers   = data.customers   || [];
      InvState.priceCatalog = data.priceCatalog || {};
      InvState.nextNum     = data.nextNum      || INV_START_NUM;
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
    invoices:     InvState.invoices,
    customers:    InvState.customers,
    priceCatalog: InvState.priceCatalog,
    nextNum:      InvState.nextNum,
    savedAt:      new Date().toISOString(),
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

window.switchToInvoices = function() {
  if (window.switchView) switchView('invoices');
  invRender();
};

// ── INVOICE LOG ───────────────────────────────────────────────
function invRenderLog(body) {
  const invoices = InvState.invoices.slice().sort(function(a,b) { return b.number - a.number; });

  const statusBadge = function(s) {
    const colors = { draft:'background:#666;', sent:'background:var(--accent);', paid:'background:var(--green);color:#000;', shipped:'background:#7c3aed;' };
    return '<span style="' + (colors[s]||'background:#888;') + 'color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;">' + invEsc(s) + '</span>';
  };

  const rows = invoices.length ? invoices.map(function(inv) {
    const total = invCalcTotal(inv);
    return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="invOpenDetail(\'' + inv.id + '\')">'
      + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;color:var(--accent);font-size:13px;">' + invEsc(INV_PREFIX + inv.number) + '</td>'
      + '<td style="padding:10px 16px;font-size:13px;">' + invEsc(inv.billTo.company || inv.billTo.name || '') + '</td>'
      + '<td style="padding:10px 16px;font-size:12px;color:var(--text-muted);">' + invDate(inv.createdAt) + '</td>'
      + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;font-size:13px;">' + invFmt(total) + '</td>'
      + '<td style="padding:10px 16px;">' + statusBadge(inv.status) + '</td>'
      + '<td style="padding:10px 16px;font-size:11px;color:var(--text-muted);">' + invEsc(inv.packiyoOrderId || '—') + '</td>'
      + '</tr>';
  }).join('') : '<tr><td colspan="6" style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px;">No invoices yet. Create your first invoice.</td></tr>';

  body.innerHTML = '<div style="padding:24px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">'
    + '<div>'
    + '<h2 style="margin:0;font-size:20px;">Invoices</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + invoices.length + ' invoice' + (invoices.length !== 1 ? 's' : '') + ' · Next: ' + INV_PREFIX + InvState.nextNum + '</div>'
    + '</div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button onclick="invShowPriceImport()" class="btn-secondary btn-sm">&#8593; Import Prices</button>'
    + '<button onclick="invNewInvoice()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">+ New Invoice</button>'
    + '</div>'
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
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>'
    + '</div>'
    + '</div>';
}

// ── NEW INVOICE ───────────────────────────────────────────────
window.invNewInvoice = function() {
  InvState.draft = {
    id:        'draft-' + Date.now(),
    number:    InvState.nextNum,
    status:    'draft',
    createdAt: new Date().toISOString(),
    billTo:    { name:'', company:'', address:'', address2:'', city:'', state:'', zip:'', country:'US', email:'', phone:'' },
    shipTo:    { name:'', company:'', address:'', address2:'', city:'', state:'', zip:'', country:'US', email:'', phone:'' },
    shipSame:  true,
    items:     [],
    shipping:  { method: '', methodName: '', cost: 0 },
    notes:     '',
    terms:     'Net 30',
    packiyoOrderId: null,
    paidAt:    null,
    shippedAt: null,
  };
  InvState.view = 'edit';
  invRender();
};

// ── EDIT / NEW INVOICE FORM ───────────────────────────────────
function invRenderEdit(body) {
  const inv = InvState.draft;
  if (!inv) { InvState.view = 'log'; return invRender(); }

  const addrFields = function(prefix, addr) {
    return '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">'
      + invField(prefix+'-name',    'Contact Name',  addr.name,    'text')
      + invField(prefix+'-company', 'Company',       addr.company, 'text')
      + '</div>'
      + invField(prefix+'-address',  'Address',      addr.address,  'text')
      + invField(prefix+'-address2', 'Address 2',    addr.address2, 'text')
      + '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;">'
      + invField(prefix+'-city',  'City',  addr.city,  'text')
      + invField(prefix+'-state', 'State', addr.state, 'text')
      + invField(prefix+'-zip',   'ZIP',   addr.zip,   'text')
      + '</div>'
      + invField(prefix+'-email', 'Email', addr.email, 'email')
      + invField(prefix+'-phone', 'Phone', addr.phone, 'tel');
  };

  const shipMethodOpts = SHIPPING_METHODS.map(function(m) {
    return '<option value="' + m.code + '"' + (inv.shipping.method === m.code ? ' selected' : '') + '>' + invEsc(m.name) + '</option>';
  }).join('');

  body.innerHTML = '<div style="padding:24px;max-width:960px;">'
    // Header
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
    + '<div><h2 style="margin:0;">New Invoice</h2><div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + INV_PREFIX + inv.number + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button onclick="invCancelEdit()" class="btn-secondary btn-sm">Cancel</button>'
    + '<button onclick="invSaveDraft()" class="btn-secondary btn-sm">Save Draft</button>'
    + '<button onclick="invReview()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">Review Invoice &#8594;</button>'
    + '</div></div>'

    // Customer search
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Customer</div>'
    + '<div style="position:relative;margin-bottom:12px;">'
    + '<input id="inv-customer-search" type="text" placeholder="Search address book or enter new customer name..." '
    + 'style="width:100%;padding:10px 14px;font-size:13px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);" '
    + 'oninput="invSearchCustomers(this.value)" autocomplete="off" />'
    + '<div id="inv-customer-results" style="display:none;position:absolute;top:100%;left:0;right:0;background:var(--surface);border:1px solid var(--border2);border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,0.15);z-index:100;max-height:200px;overflow-y:auto;"></div>'
    + '</div>'

    // Billing / Shipping
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">'
    + '<div>'
    + '<div style="font-size:11px;font-weight:700;color:var(--text-muted);margin-bottom:8px;">BILL TO</div>'
    + addrFields('bill', inv.billTo)
    + '</div>'
    + '<div>'
    + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">'
    + '<div style="font-size:11px;font-weight:700;color:var(--text-muted);">SHIP TO</div>'
    + '<label style="font-size:11px;color:var(--text-muted);cursor:pointer;display:flex;align-items:center;gap:4px;">'
    + '<input type="checkbox" id="inv-ship-same" ' + (inv.shipSame ? 'checked' : '') + ' onchange="invToggleShipSame(this.checked)" /> Same as billing</label>'
    + '</div>'
    + '<div id="inv-shipto-fields" style="' + (inv.shipSame ? 'opacity:0.4;pointer-events:none;' : '') + '">'
    + addrFields('ship', inv.shipTo)
    + '</div>'
    + '</div>'
    + '</div>'
    + '</div>'

    // Line items
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;">Line Items</div>'
    + '</div>'
    + '<div style="position:relative;margin-bottom:12px;">'
    + '<input id="inv-item-search" type="text" placeholder="Search by artist, title, SKU or UPC to add a line item..." '
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
    + '<div style="margin-bottom:10px;">'
    + '<label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Method</label>'
    + '<select id="inv-ship-method" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">'
    + '<option value="">Select shipping method...</option>'
    + shipMethodOpts
    + '</select></div>'
    + '<div>'
    + '<label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Shipping Cost ($)</label>'
    + '<input type="number" id="inv-ship-cost" min="0" step="0.01" value="' + (inv.shipping.cost || '') + '" placeholder="0.00" '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" />'
    + '</div></div>'
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Notes & Terms</div>'
    + '<div style="margin-bottom:10px;">'
    + '<label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Payment Terms</label>'
    + '<input type="text" id="inv-terms" value="' + invEsc(inv.terms) + '" placeholder="Net 30" '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" /></div>'
    + '<div>'
    + '<label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Notes</label>'
    + '<textarea id="inv-notes" rows="3" placeholder="Internal notes or customer-facing message..." '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);resize:vertical;">' + invEsc(inv.notes) + '</textarea>'
    + '</div></div>'
    + '</div>'

    // Totals
    + '<div style="display:flex;justify-content:flex-end;">'
    + '<div id="inv-totals-box" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;min-width:280px;">'
    + invRenderTotals(inv)
    + '</div>'
    + '</div>'
    + '</div>';
}

function invField(id, label, val, type) {
  return '<div style="margin-bottom:8px;">'
    + '<label style="font-size:10px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:3px;">' + label + '</label>'
    + '<input type="' + type + '" id="' + id + '" value="' + invEsc(val || '') + '" '
    + 'style="width:100%;padding:7px 10px;font-size:12px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);box-sizing:border-box;" /></div>';
}

function invRenderItemsTable(items) {
  if (!items.length) return '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">No items added yet. Search above to add products.</div>';

  const rows = items.map(function(item, idx) {
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:8px 10px;font-size:11px;color:var(--text-muted);">' + invEsc(item.artist) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-weight:600;">' + invEsc(item.title) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;">' + invEsc(item.catalog) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;color:var(--text-muted);">' + invEsc(item.upc) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;color:var(--text-muted);">' + invEsc(item.format || '') + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;color:var(--text-muted);">' + (item.onHand !== undefined ? item.onHand : '—') + '</td>'
      + '<td style="padding:8px 10px;">'
      + '<input type="number" min="1" value="' + (item.qty || 1) + '" '
      + 'style="width:60px;padding:4px 6px;font-size:12px;border:1px solid var(--border2);border-radius:3px;background:var(--surface);color:var(--text);text-align:center;" '
      + 'onchange="invUpdateItem(' + idx + ',\'qty\',parseInt(this.value)||1)" /></td>'
      + '<td style="padding:8px 10px;">'
      + '<input type="number" min="0" step="0.01" value="' + parseFloat(item.price || 0).toFixed(2) + '" '
      + 'style="width:80px;padding:4px 6px;font-size:12px;border:1px solid var(--border2);border-radius:3px;background:var(--surface);color:var(--text);text-align:right;" '
      + 'onchange="invUpdateItem(' + idx + ',\'price\',parseFloat(this.value)||0)" /></td>'
      + '<td style="padding:8px 10px;font-family:monospace;font-weight:600;font-size:12px;text-align:right;">' + invFmt((item.qty||1) * (item.price||0)) + '</td>'
      + '<td style="padding:8px 10px;text-align:center;">'
      + '<button onclick="invRemoveItem(' + idx + ')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;line-height:1;">&#x2715;</button>'
      + '</td>'
      + '</tr>';
  }).join('');

  return '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Artist</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Title</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Cat #</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">UPC</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Format</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">On Hand</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Qty</th>'
    + '<th style="padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Unit Price</th>'
    + '<th style="padding:7px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Line Total</th>'
    + '<th style="padding:7px 10px;"></th>'
    + '</tr></thead>'
    + '<tbody>' + rows + '</tbody>'
    + '</table>';
}

function invRenderTotals(inv) {
  const subtotal = (inv.items || []).reduce(function(s, i) { return s + (i.qty||1)*(i.price||0); }, 0);
  const shipping = parseFloat(inv.shipping.cost || 0);
  const total    = subtotal + shipping;
  return '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Order Total</div>'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;"><span>Subtotal</span><span style="font-family:monospace;">' + invFmt(subtotal) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:12px;font-size:13px;"><span>Shipping</span><span style="font-family:monospace;">' + invFmt(shipping) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding-top:10px;border-top:2px solid var(--border);font-size:16px;font-weight:800;"><span>Total</span><span style="font-family:monospace;color:var(--accent);">' + invFmt(total) + '</span></div>';
}

function invCalcTotal(inv) {
  const subtotal = (inv.items || []).reduce(function(s, i) { return s + (i.qty||1)*(i.price||0); }, 0);
  return subtotal + parseFloat(inv.shipping.cost || 0);
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

  results.innerHTML = matches.map(function(p) {
    const price = InvState.priceCatalog[p.catalog] || InvState.priceCatalog[p.upc] || '';
    const onHand = p.fp_available !== undefined ? p.fp_available : '—';
    return '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;" '
      + 'onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'" '
      + 'onclick="invAddItem(' + JSON.stringify(JSON.stringify(p)) + ')">'
      + '<div>'
      + '<div style="font-size:12px;font-weight:600;">' + invEsc(p.artist || '') + ' — ' + invEsc(p.title || '') + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted);margin-top:2px;">' + invEsc(p.catalog||'') + ' · ' + invEsc(p.upc||'') + ' · On hand: ' + onHand + '</div>'
      + '</div>'
      + '<div style="font-size:12px;font-family:monospace;color:var(--accent);margin-left:12px;">' + (price ? invFmt(price) : '<span style="color:var(--text-dim)">no price</span>') + '</div>'
      + '</div>';
  }).join('');
  results.style.display = 'block';
};

window.invAddItem = function(pJson) {
  const p = JSON.parse(pJson);
  const price = parseFloat(InvState.priceCatalog[p.catalog] || InvState.priceCatalog[p.upc] || 0);
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
  document.getElementById('inv-item-search').value = '';
  document.getElementById('inv-item-results').style.display = 'none';
  document.getElementById('inv-items-table').innerHTML = invRenderItemsTable(InvState.draft.items);
  document.getElementById('inv-totals-box').innerHTML  = invRenderTotals(InvState.draft);
};

window.invUpdateItem = function(idx, field, val) {
  if (!InvState.draft || !InvState.draft.items[idx]) return;
  InvState.draft.items[idx][field] = val;
  document.getElementById('inv-totals-box').innerHTML = invRenderTotals(InvState.draft);
};

window.invRemoveItem = function(idx) {
  if (!InvState.draft) return;
  InvState.draft.items.splice(idx, 1);
  document.getElementById('inv-items-table').innerHTML = invRenderItemsTable(InvState.draft.items);
  document.getElementById('inv-totals-box').innerHTML  = invRenderTotals(InvState.draft);
};

// ── CUSTOMER SEARCH ───────────────────────────────────────────
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

  results.innerHTML = matches.map(function(c, i) {
    return '<div style="padding:10px 14px;cursor:pointer;border-bottom:1px solid var(--border);" '
      + 'onmouseover="this.style.background=\'var(--surface2)\'" onmouseout="this.style.background=\'\'" '
      + 'onclick="invSelectCustomer(' + i + ')">'
      + '<div style="font-size:13px;font-weight:600;">' + invEsc(c.company || c.name) + '</div>'
      + '<div style="font-size:11px;color:var(--text-muted);">' + invEsc(c.name) + ' · ' + invEsc(c.email||'') + '</div>'
      + '</div>';
  }).join('');
  results.style.display = 'block';
};

window.invSelectCustomer = function(idx) {
  const c = InvState.customers[idx];
  if (!c || !InvState.draft) return;
  InvState.draft.billTo = Object.assign({}, c);
  if (InvState.draft.shipSame) InvState.draft.shipTo = Object.assign({}, c);
  document.getElementById('inv-customer-results').style.display = 'none';
  // Re-render the form with populated fields
  const body = document.getElementById('inv-body');
  invRenderEdit(body);
};

window.invToggleShipSame = function(checked) {
  if (!InvState.draft) return;
  InvState.draft.shipSame = checked;
  const shipFields = document.getElementById('inv-shipto-fields');
  if (shipFields) {
    shipFields.style.opacity = checked ? '0.4' : '1';
    shipFields.style.pointerEvents = checked ? 'none' : 'auto';
  }
};

// ── COLLECT FORM DATA ─────────────────────────────────────────
function invCollectForm() {
  const inv = InvState.draft;
  if (!inv) return;

  const g = function(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; };

  inv.billTo = {
    name: g('bill-name'), company: g('bill-company'),
    address: g('bill-address'), address2: g('bill-address2'),
    city: g('bill-city'), state: g('bill-state'), zip: g('bill-zip'),
    country: 'US', email: g('bill-email'), phone: g('bill-phone'),
  };
  if (!inv.shipSame) {
    inv.shipTo = {
      name: g('ship-name'), company: g('ship-company'),
      address: g('ship-address'), address2: g('ship-address2'),
      city: g('ship-city'), state: g('ship-state'), zip: g('ship-zip'),
      country: 'US', email: g('ship-email'), phone: g('ship-phone'),
    };
  } else {
    inv.shipTo = Object.assign({}, inv.billTo);
  }

  const method = g('inv-ship-method');
  const methodName = method ? (SHIPPING_METHODS.find(function(m) { return m.code === method; }) || {}).name || '' : '';
  inv.shipping = { method: method, methodName: methodName, cost: parseFloat(g('inv-ship-cost')) || 0 };
  inv.notes = g('inv-notes');
  inv.terms = g('inv-terms');

  // Save customer to address book if new
  const company = inv.billTo.company || inv.billTo.name;
  if (company && !InvState.customers.some(function(c) { return (c.company||c.name) === company; })) {
    InvState.customers.push(Object.assign({}, inv.billTo));
  }
}

// ── SAVE DRAFT ────────────────────────────────────────────────
window.invSaveDraft = function() {
  invCollectForm();
  const inv = InvState.draft;
  if (!inv) return;
  const existing = InvState.invoices.findIndex(function(i) { return i.id === inv.id; });
  if (existing >= 0) InvState.invoices[existing] = inv;
  else InvState.invoices.push(inv);
  invSave();
  if (window.toast) toast('Draft saved.', '');
};

// ── CANCEL EDIT ───────────────────────────────────────────────
window.invCancelEdit = function() {
  InvState.draft = null;
  InvState.view  = 'log';
  invRender();
};

// ── REVIEW → DETAIL VIEW ──────────────────────────────────────
window.invReview = function() {
  invCollectForm();
  InvState.view = 'detail';
  invRender();
};

window.invOpenDetail = function(id) {
  const inv = InvState.invoices.find(function(i) { return i.id === id; });
  if (!inv) return;
  InvState.draft = JSON.parse(JSON.stringify(inv));
  InvState.view  = 'detail';
  invRender();
};

// ── DETAIL / PRINT VIEW ───────────────────────────────────────
function invRenderDetail(body) {
  const inv = InvState.draft;
  if (!inv) { InvState.view = 'log'; return invRender(); }

  const total    = invCalcTotal(inv);
  const subtotal = (inv.items||[]).reduce(function(s,i) { return s+(i.qty||1)*(i.price||0); }, 0);
  const shipping = parseFloat(inv.shipping.cost || 0);
  const isDraft  = inv.status === 'draft';

  const addrBlock = function(addr, label) {
    return '<div>'
      + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:6px;">' + label + '</div>'
      + '<div style="font-size:13px;line-height:1.6;">'
      + (addr.company ? '<strong>' + invEsc(addr.company) + '</strong><br>' : '')
      + invEsc(addr.name) + '<br>'
      + invEsc(addr.address) + (addr.address2 ? '<br>' + invEsc(addr.address2) : '') + '<br>'
      + invEsc(addr.city) + ', ' + invEsc(addr.state) + ' ' + invEsc(addr.zip) + '<br>'
      + (addr.email ? invEsc(addr.email) + '<br>' : '')
      + (addr.phone ? invEsc(addr.phone) : '')
      + '</div></div>';
  };

  const lineRows = (inv.items||[]).map(function(item) {
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:10px 12px;font-size:12px;">' + invEsc(item.artist) + '</td>'
      + '<td style="padding:10px 12px;font-size:12px;font-weight:600;">' + invEsc(item.title) + '</td>'
      + '<td style="padding:10px 12px;font-size:11px;font-family:monospace;">' + invEsc(item.catalog) + '</td>'
      + '<td style="padding:10px 12px;font-size:11px;font-family:monospace;color:var(--text-muted);">' + invEsc(item.upc) + '</td>'
      + '<td style="padding:10px 12px;font-size:11px;text-align:center;">' + invEsc(item.format||'') + '</td>'
      + '<td style="padding:10px 12px;font-size:12px;text-align:center;">' + (item.qty||1) + '</td>'
      + '<td style="padding:10px 12px;font-size:12px;font-family:monospace;text-align:right;">' + invFmt(item.price||0) + '</td>'
      + '<td style="padding:10px 12px;font-size:12px;font-family:monospace;font-weight:700;text-align:right;">' + invFmt((item.qty||1)*(item.price||0)) + '</td>'
      + '</tr>';
  }).join('');

  body.innerHTML = '<div id="inv-detail-wrap" style="padding:24px;max-width:900px;">'

    // Action bar (no-print)
    + '<div class="no-print" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">'
    + '<button onclick="invBackToLog()" class="btn-secondary btn-sm">&#8592; Back</button>'
    + '<div style="display:flex;gap:8px;">'
    + (isDraft ? '<button onclick="invEditDraft()" class="btn-secondary btn-sm">&#9998; Edit</button>' : '')
    + '<button onclick="window.print()" class="btn-secondary btn-sm">&#128438; Print / PDF</button>'
    + (isDraft ? '<button onclick="invPushToPackiyo()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#9654; Send &amp; Push to Packiyo</button>' : '')
    + (inv.status === 'sent' && !inv.paidAt ? '<button onclick="invMarkPaid()" style="background:var(--green);color:#000;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#10004; Mark as Paid</button>' : '')
    + '</div></div>'

    // Invoice document
    + '<div id="inv-print-area" style="background:white;color:#111;border:1px solid var(--border);border-radius:8px;padding:40px;font-family:sans-serif;">'

    // Invoice header
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:32px;">'
    + '<div>'
    + '<div style="font-size:28px;font-weight:800;color:#b83228;letter-spacing:-0.5px;">FAT POSSUM RECORDS</div>'
    + '<div style="font-size:12px;color:#666;margin-top:4px;">PO Box 1923 · Oxford, MS 38655</div>'
    + '<div style="font-size:12px;color:#666;">orders@fatpossum.com · 662-234-2828</div>'
    + '</div>'
    + '<div style="text-align:right;">'
    + '<div style="font-size:22px;font-weight:800;color:#111;">INVOICE</div>'
    + '<div style="font-size:16px;font-family:monospace;font-weight:700;color:#b83228;margin-top:4px;">' + invEsc(INV_PREFIX + inv.number) + '</div>'
    + '<div style="font-size:12px;color:#666;margin-top:4px;">Date: ' + invDate(inv.createdAt) + '</div>'
    + '<div style="font-size:12px;color:#666;">Terms: ' + invEsc(inv.terms || 'Net 30') + '</div>'
    + (inv.status !== 'draft' ? '<div style="margin-top:8px;background:' + (inv.paidAt?'#16a34a':'#b83228') + ';color:white;padding:4px 12px;border-radius:4px;font-size:11px;font-weight:700;display:inline-block;">' + (inv.paidAt ? 'PAID ' + invDate(inv.paidAt) : inv.status.toUpperCase()) + '</div>' : '')
    + '</div></div>'

    // Bill to / Ship to
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:32px;margin-bottom:32px;padding:20px;background:#f8f8f8;border-radius:6px;">'
    + addrBlock(inv.billTo, 'Bill To')
    + addrBlock(inv.shipSame ? inv.billTo : inv.shipTo, 'Ship To')
    + '</div>'

    // Shipping method
    + (inv.shipping.methodName ? '<div style="margin-bottom:16px;font-size:12px;color:#666;"><strong>Shipping Method:</strong> ' + invEsc(inv.shipping.methodName) + '</div>' : '')

    // Line items table
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:24px;">'
    + '<thead><tr style="background:#111;color:white;">'
    + '<th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Artist</th>'
    + '<th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Title</th>'
    + '<th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Cat #</th>'
    + '<th style="padding:10px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">UPC</th>'
    + '<th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Format</th>'
    + '<th style="padding:10px 12px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Qty</th>'
    + '<th style="padding:10px 12px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Unit Price</th>'
    + '<th style="padding:10px 12px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Total</th>'
    + '</tr></thead>'
    + '<tbody>' + lineRows + '</tbody>'
    + '</table>'

    // Totals
    + '<div style="display:flex;justify-content:flex-end;margin-bottom:24px;">'
    + '<div style="min-width:240px;">'
    + '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #eee;"><span>Subtotal</span><span style="font-family:monospace;">' + invFmt(subtotal) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:6px 0;font-size:13px;border-bottom:1px solid #eee;"><span>Shipping' + (inv.shipping.methodName ? ' (' + invEsc(inv.shipping.methodName) + ')' : '') + '</span><span style="font-family:monospace;">' + invFmt(shipping) + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:10px 0;font-size:16px;font-weight:800;"><span>Total</span><span style="font-family:monospace;color:#b83228;">' + invFmt(total) + '</span></div>'
    + '</div></div>'

    // Notes
    + (inv.notes ? '<div style="padding:16px;background:#f8f8f8;border-radius:6px;font-size:12px;color:#555;"><strong>Notes:</strong> ' + invEsc(inv.notes) + '</div>' : '')

    + '</div>' // end print area
    + '</div>'; // end wrap
}

window.invBackToLog = function() {
  InvState.draft = null;
  InvState.view  = 'log';
  invRender();
};

window.invEditDraft = function() {
  InvState.view = 'edit';
  invRender();
};

// ── PUSH TO PACKIYO ───────────────────────────────────────────
window.invPushToPackiyo = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (!inv.items.length) { if (window.toast) toast('Add at least one line item.', 'error'); return; }
  if (!inv.billTo.name && !inv.billTo.company) { if (window.toast) toast('Add customer info first.', 'error'); return; }
  if (!confirm('Push ' + INV_PREFIX + inv.number + ' to Packiyo as a new order?\n\n' + inv.items.length + ' items · Total ' + invFmt(invCalcTotal(inv)))) return;
  invCreatePackiyoOrder(inv);
};

async function invCreatePackiyoOrder(inv) {
  if (window.toast) toast('Creating order in Packiyo...', '');
  try {
    const shipTo = inv.shipSame ? inv.billTo : inv.shipTo;
    const payload = {
      data: {
        type: 'orders',
        attributes: {
          external_id:          INV_PREFIX + inv.number,
          is_wholesale:         true,
          tags:                 'B2B, Invoice',
          internal_note:        inv.notes || '',
          shipping_method_name: inv.shipping.methodName || '',
          shipping_method_code: inv.shipping.method     || '',
          shipping:             inv.shipping.cost        || 0,
          ordered_at:           inv.createdAt,
          billing_address: {
            name:     inv.billTo.name,
            company:  inv.billTo.company,
            address1: inv.billTo.address,
            address2: inv.billTo.address2,
            city:     inv.billTo.city,
            state:    inv.billTo.state,
            zip:      inv.billTo.zip,
            country:  inv.billTo.country || 'US',
            email:    inv.billTo.email,
            phone:    inv.billTo.phone,
          },
          shipping_address: {
            name:     shipTo.name,
            company:  shipTo.company,
            address1: shipTo.address,
            address2: shipTo.address2,
            city:     shipTo.city,
            state:    shipTo.state,
            zip:      shipTo.zip,
            country:  shipTo.country || 'US',
            email:    shipTo.email,
            phone:    shipTo.phone,
          },
        },
        relationships: {
          order_items: {
            data: inv.items.map(function(item, i) { return { type: 'order-items', id: 'item-' + i }; })
          }
        }
      },
      included: inv.items.map(function(item, i) {
        return {
          type: 'order-items',
          id:   'item-' + i,
          attributes: {
            sku:      item.sku,
            name:     (item.artist ? item.artist + ' - ' : '') + item.title,
            price:    item.price || 0,
            quantity: item.qty   || 1,
          }
        };
      }),
    };

    const result = await invPackiyoFetch('/orders', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    const orderId = result.data && result.data.id;
    const orderNum = result.data && result.data.attributes && result.data.attributes.number;

    // Update invoice status
    inv.status         = 'sent';
    inv.packiyoOrderId = orderId || null;
    inv.packiyoOrderNum = orderNum || null;
    inv.sentAt         = new Date().toISOString();

    // Increment invoice counter
    InvState.nextNum++;

    const existing = InvState.invoices.findIndex(function(i) { return i.id === inv.id; });
    if (existing >= 0) InvState.invoices[existing] = inv;
    else { InvState.invoices.push(inv); }

    await invSave();
    if (window.toast) toast('Order created in Packiyo! ' + (orderNum ? '#' + orderNum : ''), 'success');
    invRender();

  } catch(e) {
    console.error('Packiyo order creation failed:', e);
    if (window.toast) toast('Packiyo error: ' + e.message, 'error');
  }
}

// ── MARK PAID ─────────────────────────────────────────────────
window.invMarkPaid = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (!confirm('Mark ' + INV_PREFIX + inv.number + ' as paid?')) return;
  inv.status = 'paid';
  inv.paidAt = new Date().toISOString();
  const existing = InvState.invoices.findIndex(function(i) { return i.id === inv.id; });
  if (existing >= 0) InvState.invoices[existing] = inv;
  invSave();
  invRender();
  if (window.toast) toast('Marked as paid.', 'success');
};

// ── PRICE IMPORT ──────────────────────────────────────────────
window.invShowPriceImport = function() {
  const modal = document.getElementById('inv-price-modal');
  if (modal) modal.style.display = 'flex';
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
    const titleIdx = header.findIndex(function(h) { return h === 'title'; });

    if (skuIdx < 0 || priceIdx < 0) {
      if (window.toast) toast('CSV must have "Variant SKU" and "Variant Price" columns.', 'error');
      return;
    }

    let imported = 0, skipped = 0;
    lines.slice(1).forEach(function(line) {
      if (!line.trim()) return;
      const cols = line.match(/(".*?"|[^,]+|(?<=,)(?=,)|^(?=,)|(?<=,)$)/g) || line.split(',');
      const clean = function(s) { return (s||'').replace(/^"|"$/g,'').trim(); };
      const sku   = clean(cols[skuIdx]);
      const price = parseFloat(clean(cols[priceIdx]));
      if (sku && !isNaN(price) && price > 0) {
        InvState.priceCatalog[sku] = price;
        imported++;
      } else { skipped++; }
    });

    invSave();
    invClosePriceImport();
    if (window.toast) toast(imported + ' prices imported, ' + skipped + ' skipped.', 'success');
  };
  reader.readAsText(file);
};

// ── PRINT CSS ─────────────────────────────────────────────────
(function() {
  const style = document.createElement('style');
  style.textContent = '@media print { .no-print { display: none !important; } #sidebar, .sidebar, nav, .view-header { display: none !important; } #main-content { overflow: visible !important; } #inv-detail-wrap { padding: 0 !important; } }';
  document.head.appendChild(style);
})();

// ── BOOT ──────────────────────────────────────────────────────
(function() {
  // Load after CONFIG is available
  let attempts = 0;
  function tryLoad() {
    attempts++;
    const creds = invGetCreds();
    if (creds) {
      invLoad();
    } else if (attempts < 20) {
      setTimeout(tryLoad, 500);
    }
  }
  tryLoad();
})();
