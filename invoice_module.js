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
  logSearch:    '',
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
      InvState.credits      = data.credits      || [];
      InvState.nextCrNum    = data.nextCrNum    || 1000;
      InvState._deletedIds  = data.deletedIds   || [];
      invSaveLocal();
      const view = document.getElementById('view-invoices');
      if (view && !view.classList.contains('hidden') && InvState.view !== 'edit') invRender();
    }
  } catch(e) { console.warn('Invoice load error:', e.message); }
}

async function invSave() {
  invSaveLocal();
  const creds = invGetCreds();
  if (!creds) return;
  try {
    // Fetch current Gist state and merge before writing
    // Prevents overwriting another user's concurrent changes
    let base = { invoices: [], customers: [], priceCatalog: {}, nextNum: INV_START_NUM };
    try {
      const current = await fetch('https://api.github.com/gists/' + creds.gistId, {
        headers: { 'Authorization': 'token ' + creds.token }, cache: 'no-store'
      });
      if (current.ok) {
        const gist = await current.json();
        const file = gist.files && gist.files[INV_GIST_FILE];
        if (file && file.content) base = JSON.parse(file.content);
      }
    } catch(e) {}

    // Merge: our invoices win for IDs we own, keep others' invoices we don't have
    const ourIds = new Set(InvState.invoices.map(function(i) { return i.id; }));
    const deletedIds = new Set(InvState._deletedIds || []);
    const theirInvoices = (base.invoices || []).filter(function(i) { return !ourIds.has(i.id) && !deletedIds.has(i.id); });
    const merged = theirInvoices.concat(InvState.invoices);

    // Take highest nextNum to avoid duplicate invoice numbers
    const nextNum = Math.max(InvState.nextNum, base.nextNum || INV_START_NUM);

    // Merge customers — union by company+name
    const allCustomers = InvState.customers.slice();
    (base.customers || []).forEach(function(c) {
      const key = (c.company || c.name || '').toLowerCase();
      if (!allCustomers.some(function(x) { return (x.company||x.name||'').toLowerCase() === key; })) {
        allCustomers.push(c);
      }
    });

    // Price catalog — ours wins
    const priceCatalog = Object.assign({}, base.priceCatalog || {}, InvState.priceCatalog);

    // Update local state with merged data
    InvState.invoices     = merged;
    InvState.nextNum      = nextNum;
    InvState.customers    = allCustomers;
    InvState.priceCatalog = priceCatalog;
    invSaveLocal();

    const payload = {
      invoices: merged, customers: allCustomers,
      priceCatalog: priceCatalog, nextNum: nextNum,
      credits: InvState.credits || [], nextCrNum: InvState.nextCrNum || 1000,
      deletedIds: Array.from(deletedIds),
      savedAt: new Date().toISOString(),
    };
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
      credits: InvState.credits || [], nextCrNum: InvState.nextCrNum || 1000,
      deletedIds: InvState._deletedIds || [],
    }));
  } catch(e) {}
}


// ── ADDRESS BOOK ───────────────────────────────────────────────
window.invDeleteCustomer = function(idx) {
  if (!confirm('Remove this address from the address book?')) return;
  InvState.customers.splice(idx, 1);
  invSaveLocal(); invSave();
  invRender();
};

window.invSaveCustomerEdit = function(idx) {
  const g = function(id) { const el = document.getElementById(id); return el ? el.value.trim() : ''; };
  InvState.customers[idx] = {
    name:     g('ab-name-'    + idx),
    company:  g('ab-company-' + idx),
    address:  g('ab-address-' + idx),
    address2: g('ab-address2-'+ idx),
    city:     g('ab-city-'    + idx),
    state:    g('ab-state-'   + idx),
    zip:      g('ab-zip-'     + idx),
    email:    g('ab-email-'   + idx),
    phone:    g('ab-phone-'   + idx),
  };
  invSaveLocal(); invSave();
  if (window.toast) toast('Address updated.', 'success');
  invRender();
};

window.invUseCustomer = function(idx) {
  const c = InvState.customers[idx];
  if (!c) return;
  invNewInvoice();
  setTimeout(function() {
    if (InvState.draft) {
      InvState.draft.billTo = Object.assign({}, c);
      if (InvState.draft.shipSame) InvState.draft.shipTo = Object.assign({}, c);
      invRenderEdit(document.getElementById('inv-body'));
    }
  }, 80);
};

function invRenderAddrBook(body) {
  const customers = InvState.customers.slice().sort(function(a, b) {
    return (a.company||a.name||'').localeCompare(b.company||b.name||'');
  });

  function abField(id, label, val, type) {
    type = type || 'text';
    return '<div style="display:flex;flex-direction:column;gap:3px;">'
      + '<label style="font-size:10px;color:var(--text-muted);text-transform:uppercase;letter-spacing:0.5px;">' + label + '</label>'
      + '<input id="' + id + '" type="' + type + '" value="' + invEsc(val||'') + '" '
      + 'style="background:var(--surface);border:1px solid var(--border2);border-radius:4px;padding:5px 8px;font-size:12px;color:var(--text);width:100%;">'
      + '</div>';
  }

  const rows = customers.length ? customers.map(function(c, i) {
    const realIdx = InvState.customers.indexOf(c);
    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:12px;">'
      + '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">'
      + '<div style="font-size:15px;font-weight:700;">' + invEsc(c.company || c.name || 'Unnamed') + '</div>'
      + '<div style="display:flex;gap:8px;">'
      + '<button onclick="invUseCustomer(' + realIdx + ')" style="background:var(--accent);color:#fff;border:none;border-radius:5px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer;">Use →</button>'
      + '<button onclick="invSaveCustomerEdit(' + realIdx + ')" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:5px;padding:5px 12px;font-size:12px;cursor:pointer;">Save</button>'
      + '<button onclick="invDeleteCustomer(' + realIdx + ')" style="background:none;color:var(--red,#e53935);border:1px solid var(--red,#e53935);border-radius:5px;padding:5px 10px;font-size:12px;cursor:pointer;">✕</button>'
      + '</div></div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px;">'
      + abField('ab-name-'+realIdx,    'Contact Name', c.name)
      + abField('ab-company-'+realIdx, 'Company',      c.company)
      + '</div>'
      + abField('ab-address-'+realIdx,  'Address',   c.address)
      + '<div style="margin-top:8px;">' + abField('ab-address2-'+realIdx, 'Address 2', c.address2) + '</div>'
      + '<div style="display:grid;grid-template-columns:2fr 1fr 1fr;gap:8px;margin-top:8px;">'
      + abField('ab-city-'+realIdx,  'City',  c.city)
      + abField('ab-state-'+realIdx, 'State', c.state)
      + abField('ab-zip-'+realIdx,   'ZIP',   c.zip)
      + '</div>'
      + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">'
      + abField('ab-email-'+realIdx, 'Email', c.email, 'email')
      + abField('ab-phone-'+realIdx, 'Phone', c.phone, 'tel')
      + '</div>'
      + '</div>';
  }).join('')
  : '<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:14px;">No saved addresses yet.<br>Addresses are saved automatically when you create invoices.</div>';

  body.innerHTML =
    '<div style="max-width:760px;margin:0 auto;padding:24px 16px;">'
    + '<div style="display:flex;align-items:center;gap:16px;margin-bottom:24px;">'
    + '<button onclick="InvState.view=\'log\';invRender()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;">← Invoices</button>'
    + '<div style="font-size:20px;font-weight:700;">Address Book</div>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-left:auto;">' + customers.length + ' saved address' + (customers.length !== 1 ? 'es' : '') + '</div>'
    + '</div>'
    + rows
    + '</div>';
}

// ── RENDER ROUTER ─────────────────────────────────────────────
function invRender() {
  const body = document.getElementById('inv-body');
  if (!body) return;
  if (InvState.view === 'log')      return invRenderLog(body);
  if (InvState.view === 'edit')     return invRenderEdit(body);
  if (InvState.view === 'detail')   return invRenderDetail(body);
  if (InvState.view === 'addrbook') return invRenderAddrBook(body);
}

window.switchToInvoices = function(mode) {
  if (window.switchView) switchView('invoices');
  setTimeout(function() {
    const pending = InvState.invoices.filter(function(inv) {
      return (inv.status === 'pending_shipment' || inv.status === 'paid' || inv.status === 'shipped') && inv.packiyoOrderId && !inv.shippedAt;
    });
    pending.forEach(function(inv) { invSyncById(inv.id); });
  }, 1000);
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
  return inv.status === 'shipped' || inv.status === 'complete' || !!(inv.shippedAt && inv.paidAt);
}

function invIsPending(inv) {
  return inv.status === 'pending_payment' || inv.status === 'pending_shipment' || inv.status === 'paid' || inv.status === 'sent';
}

function invRenderLog(body) {
  const filter = InvState.logFilter || 'all';
  const all = InvState.invoices.slice().sort(function(a, b) { return b.number - a.number; });

  const search = (InvState.logSearch || '').toLowerCase().trim();
  const filtered = all.filter(function(inv) {
    // Tab filter
    if (filter === 'pending' && !(invIsPending(inv) || inv.status === 'draft')) return false;
    if (filter === 'past'    && !invIsPast(inv)) return false;
    // Search filter
    if (search) {
      const invNum  = (INV_PREFIX + inv.number).toLowerCase();
      const poNum   = (inv.poNumber || '').toLowerCase();
      const company = (inv.billTo.company || inv.billTo.name || '').toLowerCase();
      const pkNum   = (inv.packiyoOrderNum || '').toLowerCase();
      if (!invNum.includes(search) && !poNum.includes(search) && !company.includes(search) && !pkNum.includes(search)) return false;
    }
    return true;
  });

  function tabBtn(label, f) {
    const active = filter === f;
    const count  = all.filter(function(inv) {
      if (f === 'pending') return invIsPending(inv) || inv.status === 'draft';
      if (f === 'past')    return invIsPast(inv);
      return true;
    }).length; // tab counts ignore search so you can see totals
    return '<button onclick="InvState.logFilter=\'' + f + '\';invRender()" style="padding:6px 14px;font-size:12px;font-weight:' + (active?'700':'500') + ';border:none;border-radius:4px;cursor:pointer;background:' + (active?'var(--accent)':'var(--surface2)') + ';color:' + (active?'#fff':'var(--text-muted)') + ';">'
      + label + (count ? ' <span style="background:rgba(255,255,255,0.25);border-radius:8px;padding:1px 6px;font-size:10px;">' + count + '</span>' : '') + '</button>';
  }

  function statusBadge(s) {
    const map = {
      draft:            '#888',
      sent:             '#e67e22',
      pending_payment:  '#e67e22',
      pending_shipment: 'var(--accent)',
      paid:             '#2980b9',
      shipped:          '#7c3aed',
      complete:         'var(--green)',
    };
    const labels = {
      draft:            'Draft',
      sent:             'Pending Payment',
      pending_payment:  'Pending Payment',
      pending_shipment: 'Pending Shipment',
      paid:             'Paid',
      shipped:          'Shipped',
      complete:         'Complete',
    };
    return '<span style="background:' + (map[s]||'#888') + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">' + invEsc(labels[s] || s) + '</span>';
  }

  const rows = filtered.length
    ? filtered.map(function(inv) {
        const total = invCalcTotal(inv);
        const canMarkPaid = inv.status === 'pending_payment' || inv.status === 'sent';
        return '<tr data-inv-id="' + inv.id + '" style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="invOpenDetail(\'' + inv.id + '\')">'
          + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;color:var(--accent);font-size:13px;">' + invEsc(INV_PREFIX + inv.number) + '</td>'
          + '<td style="padding:10px 16px;font-size:13px;">' + invEsc(inv.billTo.company || inv.billTo.name || '') + '</td>'
          + '<td style="padding:10px 16px;font-size:12px;color:var(--text-muted);">' + invDate(inv.createdAt) + '</td>'
          + '<td style="padding:8px 16px;">'
          + (inv.createdBy ? (inv.createdBy.picture ? '<img src="' + invEsc(inv.createdBy.picture) + '" style="width:20px;height:20px;border-radius:50%;vertical-align:middle;margin-right:5px;" title="' + invEsc(inv.createdBy.name) + '">' : '') + '<span style="font-size:11px;color:var(--text-muted);">' + invEsc(inv.createdBy.name || inv.createdBy.email || '') + '</span>' : '<span style="font-size:11px;color:var(--text-dim);">—</span>')
          + '</td>'
          + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;font-size:13px;">' + invFmt(total) + '</td>'
          + '<td style="padding:10px 16px;">' + statusBadge(inv.status) + '</td>'
          + '<td style="padding:10px 16px;font-size:11px;color:var(--text-muted);">' + invEsc(inv.packiyoOrderNum || inv.packiyoOrderId || '—') + '</td>'
          + '<td style="padding:10px 16px;font-size:11px;font-family:monospace;color:var(--text-muted);">' + (inv.trackingNumber ? '<a href="' + invEsc(inv.trackingUrl||'#') + '" target="_blank" style="color:var(--accent);">' + invEsc(inv.trackingNumber) + '</a>' : '—') + '</td>'
          + '<td style="padding:6px 10px;" onclick="event.stopPropagation()">'
          + (canMarkPaid ? '<button onclick="event.stopPropagation();invMarkPaidById(\'' + inv.id + '\')" style="background:var(--green);color:#000;border:none;border-radius:4px;padding:4px 10px;font-size:11px;font-weight:700;cursor:pointer;">&#10004; Paid</button>' : '')
          + '</td>'
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
    + '<button onclick="invNewInvoice()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">+ New Invoice</button><button onclick="InvState.view=\'addrbook\';invRender()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:4px;padding:8px 14px;font-size:13px;cursor:pointer;margin-left:8px;">📋 Address Book</button>'
    + '</div></div>'
    + '<div style="display:flex;gap:6px;align-items:center;margin-bottom:16px;flex-wrap:wrap;">'
    + tabBtn('All', 'all') + tabBtn('Pending', 'pending') + tabBtn('Past', 'past')
    + '<div style="flex:1;min-width:200px;max-width:340px;margin-left:auto;position:relative;">'
    + '<input id="inv-log-search" type="text" value="' + invEsc(InvState.logSearch||'') + '" placeholder="Search order #, PO#, customer..." '
    + 'style="width:100%;padding:7px 32px 7px 12px;font-size:12px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" '
    + 'oninput="invLogSearch(this.value)" />'
    + (InvState.logSearch ? '<button onclick="invLogSearch(\'\')" style="position:absolute;right:8px;top:50%;transform:translateY(-50%);background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:14px;">&#x2715;</button>' : '')
    + '</div>'
    + '</div>'
    + '<div style="background:var(--surface);border-radius:8px;border:1px solid var(--border);overflow:hidden;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Invoice #</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Customer</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Date</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Created By</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Total</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Status</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Packiyo Order</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Tracking</th>'
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
    createdBy: (typeof State !== 'undefined' && State.user) ? { name: State.user.name, email: State.user.email, picture: State.user.picture } : null,
    billTo: { name:'', company:'', address:'', address2:'', city:'', state:'', zip:'', country:'US', email:'', phone:'' },
    shipTo: { name:'', company:'', address:'', address2:'', city:'', state:'', zip:'', country:'US', email:'', phone:'' },
    shipSame: true,
    items: [],
    shipping: { method:'', methodName:'', cost:0 },
    poNumber: '',
    paymentHold: false,
    includeInReports: false, // set true by default if customer is in reports opt-in list
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
    + '<div style="margin-bottom:10px;"><label style="display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer;padding:8px 10px;background:' + (inv.includeInReports?'rgba(30,126,74,0.08)':'var(--surface2)') + ';border:1px solid ' + (inv.includeInReports?'var(--green)':'var(--border2)') + ';border-radius:4px;">'    + '<input type="checkbox" id="inv-include-reports" ' + (inv.includeInReports?'checked':'') + ' onchange="invToggleIncludeReports(this.checked)" style="width:14px;height:14px;cursor:pointer;" />'    + '<span><strong style="color:' + (inv.includeInReports?'var(--green)':'var(--text)') + ';">Include in Sales Reports</strong> <span style="font-size:11px;color:var(--text-muted);">This invoice will be included in monthly sales report exports</span></span>'    + '</label></div>'    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Notes</label>'
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
    const zeroStock = item.onHand !== undefined && item.onHand === 0;
    const rowBg = zeroStock ? 'background:rgba(255,160,0,0.08);border-left:3px solid var(--orange,#ff9800);' : '';
    const onHandCell = zeroStock
      ? '<span style="color:var(--orange,#ff9800);font-weight:700;">0</span>&nbsp;<span style="font-size:9px;background:var(--orange,#ff9800);color:#fff;border-radius:3px;padding:1px 4px;font-weight:700;">NO STOCK</span>'
      : (item.onHand !== undefined ? item.onHand : '—');
    return '<tr style="border-bottom:1px solid var(--border);' + rowBg + '">'
      + '<td style="padding:8px 10px;font-size:11px;color:var(--text-muted);">' + invEsc(item.artist) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-weight:600;">' + invEsc(item.title) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;">' + invEsc(item.catalog) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;color:var(--text-muted);">' + invEsc(item.upc) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;">' + invEsc(item.format || '') + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;text-align:center;">' + onHandCell + '</td>'
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
  // Auto-set includeInReports based on default customer list
  try {
    const defaultCustomers = JSON.parse(localStorage.getItem('fp_rpt_optin_customers') || '[]');
    const company = (c.company || c.name || '').toLowerCase();
    InvState.draft.includeInReports = defaultCustomers.some(function(d) { return d.toLowerCase() === company; });
  } catch(e) {}
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
window.invToggleIncludeReports = function(checked) {
  if (!InvState.draft) return;
  InvState.draft.includeInReports = checked;
  const label = document.querySelector('label:has(#inv-include-reports)');
  if (label) {
    label.style.background = checked ? 'rgba(30,126,74,0.08)' : 'var(--surface2)';
    label.style.border = '1px solid ' + (checked ? 'var(--green)' : 'var(--border2)');
    const strong = label.querySelector('strong');
    if (strong) strong.style.color = checked ? 'var(--green)' : 'var(--text)';
  }
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
  inv.includeInReports = !!(document.getElementById('inv-include-reports') && document.getElementById('inv-include-reports').checked);

  // Auto-save/update address book — upsert by company/name
  const company = inv.billTo.company || inv.billTo.name;
  if (company) {
    const existingIdx = InvState.customers.findIndex(function(c) { return (c.company||c.name) === company; });
    if (existingIdx >= 0) {
      InvState.customers[existingIdx] = Object.assign({}, InvState.customers[existingIdx], inv.billTo);
    } else {
      InvState.customers.push(Object.assign({}, inv.billTo));
    }
  }
}

window.invSaveDraft = function() {
  invCollectForm();
  const inv = InvState.draft;
  if (!inv) return;
  const i = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
  if (i >= 0) InvState.invoices[i] = JSON.parse(JSON.stringify(inv));
  else InvState.invoices.push(JSON.parse(JSON.stringify(inv)));
  invSaveLocal(); // sync save immediately
  invSave();      // async Gist write in background
  if (window.toast) toast('Draft saved.', '');
};

window.invCancelEdit = function() {
  InvState.draft = null;
  InvState.view  = 'log';
  invRender();
};

window.invReview = function() {
  if (InvState.view === 'edit') invCollectForm();
  const inv = InvState.draft;
  const zeroItems = (inv && inv.items || []).filter(function(i) { return i.onHand !== undefined && i.onHand === 0; });
  if (zeroItems.length > 0) {
    const names = zeroItems.map(function(i) {
      return '<li style="margin:4px 0;">' + invEsc(i.catalog) + ' — ' + invEsc(i.artist) + ' <em>' + invEsc(i.title) + '</em></li>';
    }).join('');
    const modal = document.createElement('div');
    modal.id = 'inv-zero-stock-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;display:flex;align-items:center;justify-content:center;';
    modal.innerHTML = '<div style="background:var(--surface);border-radius:12px;padding:28px 32px;max-width:480px;width:90%;box-shadow:0 8px 32px rgba(0,0,0,0.3);">'
      + '<div style="font-size:22px;margin-bottom:8px;">⚠️ No Stock on Hand</div>'
      + '<div style="font-size:13px;color:var(--text-muted);margin-bottom:16px;">The following ' + zeroItems.length + ' item' + (zeroItems.length > 1 ? 's have' : ' has') + ' zero stock at FP warehouse:</div>'
      + '<ul style="font-size:12px;margin:0 0 20px 16px;padding:0;line-height:1.8;">' + names + '</ul>'
      + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:20px;">You can go back to edit the invoice, or continue to review with these items included.</div>'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;">'
      + '<button onclick="document.getElementById(\'inv-zero-stock-modal\').remove()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:8px 18px;font-size:13px;font-weight:600;cursor:pointer;">← Go Back</button>'
      + '<button onclick="document.getElementById(\'inv-zero-stock-modal\').remove();InvState.view=\'detail\';invRender();" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">Continue Anyway →</button>'
      + '</div></div>';
    document.body.appendChild(modal);
    return;
  }
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
    + '<button onclick="invSaveAndBack()" class="btn-secondary btn-sm">&#8592; Save &amp; Back</button>'
    + '<div style="display:flex;gap:8px;">'
    + (isDraft ? '<button onclick="invEditDraft()" class="btn-secondary btn-sm">&#9998; Edit</button>' : '')
    + '<button onclick="invPrint()" class="btn-secondary btn-sm">&#128438; Print / PDF</button>'
    + (isDraft ? '<button onclick="invPushToPackiyo()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#9654; Send &amp; Push to Packiyo</button>' : '')
    + ((inv.status === 'pending_payment' || inv.status === 'sent') ? '<button onclick="invMarkPaid()" style="background:var(--green);color:#000;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#10004; Mark as Paid</button>' : '')
    + ((inv.status === 'pending_shipment' || inv.status === 'paid' || inv.status === 'sent' || inv.status === 'shipped') && inv.packiyoOrderId ? '<button onclick="invSyncShipment()" class="btn-secondary btn-sm">&#8635; Sync from Packiyo</button>' : '')
    + ((inv.status === 'pending_payment' || inv.status === 'pending_shipment' || inv.status === 'sent') && !inv.packiyoOrderId ? '<button onclick="invRepushToPackiyo()" style="background:var(--yellow);color:#111;border:none;border-radius:4px;padding:8px 14px;font-size:12px;font-weight:700;cursor:pointer;">&#8635; Re-push to Packiyo</button>' : '')
    + (inv.trackingNumber ? '<span style="font-size:12px;font-family:monospace;background:var(--surface2);padding:6px 12px;border-radius:4px;">&#128230; ' + invEsc(inv.trackingNumber) + '</span>' : '')
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
    + (inv.createdBy ? '<div style="font-size:12px;color:#666;">Created by: <strong>' + invEsc(inv.createdBy.name || inv.createdBy.email || '') + '</strong></div>' : '')
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

window.invLogSearch = function(val) {
  InvState.logSearch = val;
  // Filter rows in place without re-rendering to preserve input focus
  const term = val.toLowerCase().trim();
  document.querySelectorAll('#inv-log-tbody tr[data-inv-id]').forEach(function(row) {
    if (!term) { row.style.display = ''; return; }
    const id = row.dataset.invId;
    const inv = InvState.invoices.find(function(x) { return x.id === id; });
    if (!inv) { row.style.display = 'none'; return; }
    const invNum  = (INV_PREFIX + inv.number).toLowerCase();
    const poNum   = (inv.poNumber || '').toLowerCase();
    const company = (inv.billTo.company || inv.billTo.name || '').toLowerCase();
    const pkNum   = (inv.packiyoOrderNum || '').toLowerCase();
    row.style.display = (invNum.includes(term) || poNum.includes(term) || company.includes(term) || pkNum.includes(term)) ? '' : 'none';
  });
  // Update clear button visibility
  const clearBtn = document.querySelector('#inv-log-search + button');
  // Just re-render if no rows exist yet (first search)
  const tbody = document.getElementById('inv-log-tbody');
  if (!tbody) invRender();
};

window.invSaveAndBack = function() {
  // Only collect if we're in edit view where form fields exist
  if (InvState.view === 'edit') invCollectForm();
  const inv = InvState.draft;
  if (!inv) { InvState.view = 'log'; invRender(); return; }
  const i = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
  if (i >= 0) InvState.invoices[i] = JSON.parse(JSON.stringify(inv));
  else InvState.invoices.push(JSON.parse(JSON.stringify(inv)));
  invSaveLocal();
  invSave();
  InvState.draft = null;
  InvState.view  = 'log';
  invRender();
  if (window.toast) toast('Draft saved.', '');
};

window.invBackToLog = function() { InvState.draft = null; InvState.view = 'log'; invRender(); };
window.invEditDraft = function() { InvState.view = 'edit'; invRender(); };

// ── PUSH TO PACKIYO ───────────────────────────────────────────
window.invPushToPackiyo = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (inv._pushing) { if (window.toast) toast('Already pushing to Packiyo...', ''); return; }
  if (!inv.items.length) { if (window.toast) toast('Add at least one line item first.', 'error'); return; }
  if (!inv.billTo.name && !inv.billTo.company) { if (window.toast) toast('Add customer info first.', 'error'); return; }
  if (!confirm('Push ' + INV_PREFIX + inv.number + ' to Packiyo as a new order?\n\n' + inv.items.length + ' items · Total ' + invFmt(invCalcTotal(inv)))) return;
  // Save draft first to ensure all data is persisted before push
  const i = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
  if (i >= 0) InvState.invoices[i] = JSON.parse(JSON.stringify(inv));
  else InvState.invoices.push(JSON.parse(JSON.stringify(inv)));
  invSaveLocal();
  inv._pushing = true;
  invCreatePackiyoOrder(inv).finally(function() { inv._pushing = false; });
};

async function invCreatePackiyoOrder(inv) {
  if (window.toast) toast('Creating order in Packiyo... please wait', '');
  try {
    const shipTo = inv.shipSame ? inv.billTo : inv.shipTo;

    // Build payload matching confirmed working structure
    const orderPayload = {
      data: {
        type: 'orders',
        attributes: {
          number:        inv.poNumber ? inv.poNumber : INV_PREFIX + inv.number,
          external_id:   INV_PREFIX + inv.number + '-' + Date.now().toString().slice(-6),
          order_channel_name: 'FP-WH-INV',
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

    inv.status          = inv.paymentHold ? 'pending_payment' : 'pending_shipment';
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
    // If number collision, retry without PO# as the order number
    if (e.message.includes('422') && e.message.includes('number') && inv.poNumber) {
      console.warn('PO# collision, retrying with FPINV number...');
      try {
        orderPayload.data.attributes.number = INV_PREFIX + inv.number;
        orderPayload.data.attributes.packing_note = 'PO# ' + inv.poNumber;
        const retryResult = await invPackiyoFetch('/orders', { method:'POST', body: JSON.stringify(orderPayload) });
        const orderId  = retryResult.data && retryResult.data.id;
        const orderNum = retryResult.data && retryResult.data.attributes && retryResult.data.attributes.number;
        if (!orderId) throw new Error('No order ID returned from Packiyo on retry');
        inv.status          = inv.paymentHold ? 'pending_payment' : 'pending_shipment';
        inv.packiyoOrderId  = orderId;
        inv.packiyoOrderNum = orderNum || null;
        inv.sentAt          = new Date().toISOString();
        InvState.nextNum++;
        const idx = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
        if (idx >= 0) InvState.invoices[idx] = inv; else InvState.invoices.push(inv);
        await invSave();
        if (window.toast) toast('Order #' + (orderNum||orderId) + ' created in Packiyo (used FPINV# as PO# already existed).', 'success');
        invRender();
        return;
      } catch(e2) {
        console.error('Retry also failed:', e2);
      }
    }
    console.error('Packiyo order creation failed:', e);
    if (window.toast) toast('Packiyo error: ' + e.message, 'error');
  }
}

// ── MARK PAID ─────────────────────────────────────────────────
window.invDelete = function() {
  const inv = InvState.draft;
  if (!inv) return;
  const hasPackiyo = !!(inv.packiyoOrderId);
  const msg = 'Delete ' + INV_PREFIX + inv.number + '? This cannot be undone.'
    + (hasPackiyo ? '\n\nThis will also cancel order ' + (inv.packiyoOrderNum || inv.packiyoOrderId) + ' in Packiyo.' : '');
  if (!confirm(msg)) return;
  InvState._deletedIds = InvState._deletedIds || [];
  InvState._deletedIds.push(inv.id);
  InvState.invoices = InvState.invoices.filter(function(x) { return x.id !== inv.id; });
  InvState.draft = null;
  InvState.view  = 'log';
  invSave();
  invRender();
  if (window.toast) toast('Invoice deleted.', '');
  if (hasPackiyo) invCancelPackiyoOrder(inv.packiyoOrderId, inv.packiyoOrderNum);
};

window.invDeleteById = function(id) {
  const inv = InvState.invoices.find(function(x) { return x.id === id; });
  if (!inv) return;
  const hasPackiyo = !!(inv.packiyoOrderId);
  const msg = 'Delete ' + INV_PREFIX + inv.number + '? This cannot be undone.'
    + (hasPackiyo ? '\n\nThis will also cancel order ' + (inv.packiyoOrderNum || inv.packiyoOrderId) + ' in Packiyo.' : '');
  if (!confirm(msg)) return;
  InvState._deletedIds = InvState._deletedIds || [];
  InvState._deletedIds.push(id);
  InvState.invoices = InvState.invoices.filter(function(x) { return x.id !== id; });
  invSave();
  invRender();
  if (window.toast) toast('Invoice deleted.', '');
  if (hasPackiyo) invCancelPackiyoOrder(inv.packiyoOrderId, inv.packiyoOrderNum);
};

async function invCancelPackiyoOrder(orderId, orderNum) {
  try {
    await invPackiyoFetch('/orders/' + orderId + '/cancel', { method: 'POST' });
    if (window.toast) toast('Order ' + (orderNum || orderId) + ' cancelled in Packiyo.', 'success');
  } catch(e) {
    console.warn('Packiyo cancel failed:', e.message);
    const is404 = e.message.includes('404');
    const is500 = e.message.includes('500');
    if (is404) {
      // Already gone — no need to warn
    } else if (is500) {
      if (window.toast) toast('Invoice deleted. Note: Packiyo order ' + (orderNum||orderId) + ' could not be auto-cancelled (may already be fulfilled — cancel manually in Packiyo if needed).', '');
    } else {
      if (window.toast) toast('Invoice deleted but Packiyo cancel failed: ' + e.message, '');
    }
  }
}

async function invSyncById(id) {
  const inv = InvState.invoices.find(function(x) { return x.id === id; });
  if (!inv || !inv.packiyoOrderId) return;
  try {
    const res = await invPackiyoFetch('/orders/' + inv.packiyoOrderId + '?include=shipments,shipments.shipment_trackings');
    const shipments = (res.included || []).filter(function(i) { return i.type === 'shipments' && i.attributes.status_text !== 'Voided'; });
    const trackings = (res.included || []).filter(function(i) { return i.type === 'shipment-trackings'; });
    if (shipments.length) {
      inv.shippedAt = shipments[0].attributes.created_at || new Date().toISOString();
      inv.status = inv.paidAt ? 'complete' : 'shipped';
      if (trackings.length) { inv.trackingNumber = trackings[0].attributes.tracking_number || ''; inv.trackingUrl = trackings[0].attributes.tracking_url || ''; }
      const idx = InvState.invoices.findIndex(function(x) { return x.id === id; });
      if (idx >= 0) InvState.invoices[idx] = inv;
      invSaveLocal();
      if (InvState.view === 'log') invRender();
      if (InvState.draft && InvState.draft.id === id && InvState.view === 'detail') { InvState.draft = JSON.parse(JSON.stringify(inv)); invRender(); }
    }
  } catch(e) {}
}

window.invRepushToPackiyo = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (inv._pushing) { if (window.toast) toast('Already pushing...', ''); return; }
  if (!confirm('Re-push ' + INV_PREFIX + inv.number + ' to Packiyo?\n\nThis will create a new order in Packiyo.')) return;
  inv._pushing = true;
  invCreatePackiyoOrder(inv).finally(function() { inv._pushing = false; });
};

window.invSyncShipment = async function() {
  const inv = InvState.draft;
  if (!inv || !inv.packiyoOrderId) return;
  if (window.toast) toast('Checking Packiyo for shipment...', '');
  try {
    const res = await invPackiyoFetch('/orders/' + inv.packiyoOrderId + '?include=shipments,shipments.shipment_trackings');
    const shipments = (res.included || []).filter(function(i) { return i.type === 'shipments' && i.attributes.status_text !== 'Voided'; });
    const trackings = (res.included || []).filter(function(i) { return i.type === 'shipment-trackings'; });

    if (shipments.length) {
      inv.shippedAt = shipments[0].attributes.created_at || new Date().toISOString();
      inv.status    = inv.paidAt ? 'complete' : 'shipped';
      if (trackings.length) {
        inv.trackingNumber = trackings[0].attributes.tracking_number || '';
        inv.trackingUrl    = trackings[0].attributes.tracking_url    || '';
      }
      const idx = InvState.invoices.findIndex(function(x) { return x.id === inv.id; });
      if (idx >= 0) InvState.invoices[idx] = inv;
      await invSave();
      invRender();
      if (window.toast) toast('Shipped! ' + (inv.trackingNumber ? 'Tracking: ' + inv.trackingNumber : 'No tracking number yet.'), 'success');
    } else {
      if (window.toast) toast('Not yet shipped in Packiyo.', '');
    }
  } catch(e) {
    if (window.toast) toast('Sync error: ' + e.message, 'error');
  }
};

window.invMarkPaidById = function(id) {
  const inv = InvState.invoices.find(function(x) { return x.id === id; });
  if (!inv || !confirm('Mark ' + INV_PREFIX + inv.number + ' as paid?')) return;
  inv.status = 'pending_shipment';
  if (!inv.paidAt) inv.paidAt = new Date().toISOString();
  inv.paidAt = new Date().toISOString();
  const idx = InvState.invoices.findIndex(function(x) { return x.id === id; });
  if (idx >= 0) InvState.invoices[idx] = inv;
  invSave();
  invRender();
  if (window.toast) toast('Marked as paid.', 'success');
};

window.invMarkPaid = function() {
  const inv = InvState.draft;
  if (!inv) return;
  if (!confirm('Mark ' + INV_PREFIX + inv.number + ' as paid?')) return;
  inv.status = 'pending_shipment';
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
    // Use a proper RFC-4180 CSV parser — Shopify exports have multi-line quoted
    // fields (Body HTML with line breaks) that break naive split('\n') parsing.
    function parseCSVFull(text) {
      const rows = [];
      let col = '', row = [], inQ = false, i = 0;
      // Normalise line endings
      text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      while (i < text.length) {
        const ch = text[i];
        if (inQ) {
          if (ch === '"' && text[i+1] === '"') { col += '"'; i += 2; continue; } // escaped quote
          if (ch === '"') { inQ = false; i++; continue; }
          col += ch;
        } else {
          if (ch === '"') { inQ = true; i++; continue; }
          if (ch === ',') { row.push(col); col = ''; i++; continue; }
          if (ch === '\n') { row.push(col); rows.push(row); row = []; col = ''; i++; continue; }
          col += ch;
        }
        i++;
      }
      if (col || row.length) { row.push(col); rows.push(row); }
      return rows;
    }

    const rows = parseCSVFull(e.target.result);
    if (rows.length < 2) { if (window.toast) toast('CSV appears empty.', 'error'); return; }

    const header = rows[0].map(function(h) { return h.trim().toLowerCase(); });
    const skuIdx   = header.findIndex(function(h) { return h.includes('variant sku') || h === 'sku'; });
    const priceIdx = header.findIndex(function(h) { return h.includes('variant price') || h === 'price'; });

    if (skuIdx < 0 || priceIdx < 0) {
      if (window.toast) toast('CSV must have "Variant SKU" and "Variant Price" columns.', 'error');
      return;
    }

    let imported = 0, skipped = 0;
    rows.slice(1).forEach(function(cols) {
      const sku   = (cols[skuIdx]   || '').trim();
      const price = parseFloat((cols[priceIdx] || '').trim());
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

// ── CREDIT MEMO / ADJUSTMENTS ─────────────────────────────────────────────
const CR_PREFIX  = 'FPCR-';
const CR_START   = 1000;

const CrState = {
  view:   'log', // log | edit | detail
  draft:  null,
  filter: 'all',
};

// Credit memos stored in InvState alongside invoices
// InvState.credits = []
// InvState.nextCrNum = CR_START

function crGetCredits() { return InvState.credits || []; }
function crGetNextNum() { return InvState.nextCrNum || CR_START; }

function crEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function crFmt(n) { return '$' + parseFloat(n||0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g,','); }
function crDate(iso) { if (!iso) return ''; return new Date(iso).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}); }

window.switchToAdjustments = function() {
  if (window.switchView) switchView('invoices');
  CrState.view = 'log';
  CrState.draft = null;
  crRender();
};

function crRender() {
  const body = document.getElementById('inv-body');
  if (!body) return;
  if (CrState.view === 'log')    crRenderLog(body);
  else if (CrState.view === 'edit')   crRenderEdit(body);
  else if (CrState.view === 'detail') crRenderDetail(body);
}

// ── LOG ───────────────────────────────────────────────────────────────────
function crRenderLog(body) {
  const credits = crGetCredits().slice().sort(function(a,b) { return b.number - a.number; });

  const rows = credits.length
    ? credits.map(function(cr) {
        const total = (cr.items||[]).reduce(function(s,i) { return s+(i.qty||0)*(i.price||0); }, 0);
        return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;" onclick="crOpenDetail(\'' + cr.id + '\')">'
          + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;color:var(--red);font-size:13px;">' + crEsc(CR_PREFIX + cr.number) + '</td>'
          + '<td style="padding:10px 16px;font-size:13px;">' + crEsc(cr.customer || '') + '</td>'
          + '<td style="padding:10px 16px;font-size:12px;color:var(--text-muted);">' + crDate(cr.claimDate || cr.createdAt) + '</td>'
          + '<td style="padding:10px 16px;font-size:12px;color:var(--text-muted);">' + crEsc(cr.refInvoice || '—') + '</td>'
          + '<td style="padding:10px 16px;font-family:monospace;font-weight:700;font-size:13px;color:var(--red);">' + crFmt(total) + '</td>'
          + '<td style="padding:10px 16px;font-size:11px;color:var(--text-muted);">' + crEsc((cr.createdBy && cr.createdBy.name) || '') + '</td>'
          + '<td style="padding:8px 12px;"><button class="cr-del-btn" data-cr-id="' + cr.id + '" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:14px;">&#128465;</button></td>'
          + '</tr>';
      }).join('')
    : '<tr><td colspan="7" style="padding:32px;text-align:center;color:var(--text-muted);font-size:13px;">No credit memos yet. Create your first adjustment.</td></tr>';

  body.innerHTML = '<div style="padding:24px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">'
    + '<div><h2 style="margin:0;font-size:20px;">Adjustments</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + credits.length + ' credit memo' + (credits.length!==1?'s':'') + ' &nbsp;·&nbsp; Next: ' + CR_PREFIX + crGetNextNum() + '</div></div>'
    + '<button onclick="crNewMemo()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">+ New Credit Memo</button>'
    + '</div>'
    + '<div style="background:var(--surface);border-radius:8px;border:1px solid var(--border);overflow:hidden;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:13px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Credit #</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Customer</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Claim Date</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Ref Invoice</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Total Credit</th>'
    + '<th style="padding:10px 16px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Created By</th>'
    + '<th style="padding:10px 16px;width:40px;"></th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table></div></div>';
}

// ── NEW MEMO ───────────────────────────────────────────────────────────────
window.crNewMemo = function() {
  if (!InvState.credits) InvState.credits = [];
  if (!InvState.nextCrNum) InvState.nextCrNum = CR_START;
  CrState.draft = {
    id:        'cr-' + Date.now(),
    number:    InvState.nextCrNum,
    createdAt: new Date().toISOString(),
    claimDate: new Date().toISOString().slice(0,10),
    customer:  '',
    billTo:    {},
    refInvoice:'',
    items:     [],
    notes:     '',
    createdBy: (typeof State !== 'undefined' && State.user) ? { name:State.user.name, email:State.user.email, picture:State.user.picture } : null,
  };
  CrState.view = 'edit';
  crRender();
};

// ── EDIT ──────────────────────────────────────────────────────────────────
function crRenderEdit(body) {
  const cr = CrState.draft;
  if (!cr) { CrState.view = 'log'; return crRender(); }

  // Build invoice reference dropdown
  const invoices = InvState.invoices || [];
  const invOpts = '<option value="">Select invoice to reference...</option>'
    + invoices.map(function(inv) {
        return '<option value="' + invEsc(INV_PREFIX + inv.number) + '"'
          + (cr.refInvoice === INV_PREFIX + inv.number ? ' selected' : '') + '>'
          + invEsc(INV_PREFIX + inv.number) + ' — ' + invEsc(inv.billTo.company || inv.billTo.name || '') + ' — ' + invDate(inv.createdAt)
          + '</option>';
      }).join('');

  body.innerHTML = '<div style="padding:24px;max-width:900px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
    + '<div><h2 style="margin:0;">New Credit Memo</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">' + CR_PREFIX + cr.number + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button onclick="crCancelEdit()" class="btn-secondary btn-sm">Cancel</button>'
    + '<button onclick="crReview()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">Review &amp; Save &#8594;</button>'
    + '</div></div>'

    // Reference invoice + claim date
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Reference</div>'
    + '<div style="display:grid;grid-template-columns:2fr 1fr;gap:16px;">'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Reference Invoice</label>'
    + '<select id="cr-ref-invoice" onchange="crLoadFromInvoice(this.value)" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">'
    + invOpts + '</select></div>'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Claim Date</label>'
    + '<input type="date" id="cr-claim-date" value="' + cr.claimDate + '" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" /></div>'
    + '</div></div>'

    // Customer info (auto-filled from invoice)
    + '<div id="cr-customer-block" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:8px;">Customer</div>'
    + '<div id="cr-customer-info" style="font-size:13px;color:var(--text-muted);">Select a reference invoice to auto-fill customer info.</div>'
    + '</div>'

    // Line items
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Line Items</div>'
    + '<div id="cr-items-table">' + crRenderItemsTable(cr.items) + '</div>'
    + '</div>'

    // Notes + totals
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">'
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:8px;">Notes</div>'
    + '<textarea id="cr-notes" rows="4" placeholder="Notes..." style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);resize:vertical;">' + crEsc(cr.notes) + '</textarea>'
    + '</div>'
    + '<div id="cr-totals-box" style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;">'
    + crRenderTotals(cr)
    + '</div></div>'

    + '<div style="display:flex;justify-content:flex-end;">'
    + '<button onclick="crReview()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:10px 24px;font-size:14px;font-weight:700;cursor:pointer;">Review &amp; Save &#8594;</button>'
    + '</div></div>';

  // If ref invoice already selected, populate
  if (cr.refInvoice) crLoadFromInvoice(cr.refInvoice, true);
}

window.crLoadFromInvoice = function(invNum, silent) {
  const cr = CrState.draft;
  if (!cr) return;
  if (!invNum) return;
  cr.refInvoice = invNum;

  const inv = (InvState.invoices||[]).find(function(i) { return INV_PREFIX + i.number === invNum; });
  if (!inv) return;

  // Copy customer info
  cr.customer = inv.billTo.company || inv.billTo.name || '';
  cr.billTo   = Object.assign({}, inv.billTo);

  // Show customer info
  const infoEl = document.getElementById('cr-customer-info');
  if (infoEl && inv.billTo) {
    infoEl.innerHTML = '<strong>' + crEsc(inv.billTo.company||inv.billTo.name||'') + '</strong>'
      + (inv.billTo.name && inv.billTo.company ? ' &nbsp;·&nbsp; ' + crEsc(inv.billTo.name) : '')
      + (inv.billTo.address ? '<br><span style="color:var(--text-muted);font-size:12px;">' + crEsc(inv.billTo.address) + ', ' + crEsc(inv.billTo.city) + ', ' + crEsc(inv.billTo.state) + ' ' + crEsc(inv.billTo.zip) + '</span>' : '')
      + (inv.billTo.email ? '<br><span style="font-size:12px;color:var(--text-muted);">' + crEsc(inv.billTo.email) + '</span>' : '');
  }

  // Pre-populate items from invoice (all items, qty editable)
  if (!silent || !cr.items.length) {
    cr.items = (inv.items||[]).map(function(item) {
      return { upc:item.upc||'', title:item.title||'', artist:item.artist||'', catalog:item.catalog||'', format:item.format||'', qty:item.qty||1, price:item.price||0 };
    });
    const tableEl = document.getElementById('cr-items-table');
    if (tableEl) tableEl.innerHTML = crRenderItemsTable(cr.items);
    const totalsEl = document.getElementById('cr-totals-box');
    if (totalsEl) totalsEl.innerHTML = crRenderTotals(cr);
  }
};

function crRenderItemsTable(items) {
  if (!items || !items.length) return '<div style="text-align:center;padding:16px;color:var(--text-muted);font-size:12px;">Select a reference invoice above to load items.</div>';
  const th = 'padding:7px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);';
  const rows = items.map(function(item, idx) {
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;color:var(--text-muted);">' + crEsc(item.upc) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-weight:600;">' + crEsc(item.artist ? item.artist + ' — ' + item.title : item.title) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;">' + crEsc(item.format||'') + '</td>'
      + '<td style="padding:8px 10px;">'
      + '<input type="number" min="0" value="' + (item.qty||0) + '" '
      + 'style="width:60px;padding:4px 6px;font-size:12px;border:1px solid var(--border2);border-radius:3px;background:var(--surface);color:var(--text);text-align:center;" '
      + 'onchange="crUpdateItem(' + idx + ',\'qty\',parseInt(this.value)||0)" /></td>'
      + '<td style="padding:8px 10px;font-size:12px;font-family:monospace;text-align:right;">' + crFmt(item.price||0) + '</td>'
      + '<td id="cr-line-total-' + idx + '" style="padding:8px 10px;font-family:monospace;font-weight:600;font-size:12px;text-align:right;">' + crFmt((item.qty||0)*(item.price||0)) + '</td>'
      + '<td style="padding:8px 10px;text-align:center;"><button onclick="crRemoveItem(' + idx + ')" style="background:none;border:none;color:var(--red);cursor:pointer;font-size:16px;">&#x2715;</button></td>'
      + '</tr>';
  }).join('');
  return '<table style="width:100%;border-collapse:collapse;font-size:12px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="' + th + '">UPC</th>'
    + '<th style="' + th + '">Title</th>'
    + '<th style="' + th + '">Format</th>'
    + '<th style="' + th + '">Qty</th>'
    + '<th style="' + th + 'text-align:right;">Unit Cost</th>'
    + '<th style="' + th + 'text-align:right;">Total Cost</th>'
    + '<th style="' + th + '"></th>'
    + '</tr></thead><tbody>' + rows + '</tbody></table>';
}

function crRenderTotals(cr) {
  const totalQty   = (cr.items||[]).reduce(function(s,i) { return s+(i.qty||0); }, 0);
  const totalCredit= (cr.items||[]).reduce(function(s,i) { return s+(i.qty||0)*(i.price||0); }, 0);
  return '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:12px;">Credit Summary</div>'
    + '<div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:13px;"><span>Total Qty</span><span style="font-family:monospace;font-weight:700;">' + totalQty + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding-top:10px;border-top:2px solid var(--border);font-size:16px;font-weight:800;">'
    + '<span>Total Credit</span><span style="font-family:monospace;color:var(--red);">' + crFmt(totalCredit) + '</span></div>';
}

window.crUpdateItem = function(idx, field, val) {
  const cr = CrState.draft;
  if (!cr || !cr.items[idx]) return;
  cr.items[idx][field] = val;
  const lineEl = document.getElementById('cr-line-total-' + idx);
  if (lineEl) lineEl.textContent = crFmt((cr.items[idx].qty||0) * (cr.items[idx].price||0));
  const totalsEl = document.getElementById('cr-totals-box');
  if (totalsEl) totalsEl.innerHTML = crRenderTotals(cr);
};

window.crRemoveItem = function(idx) {
  const cr = CrState.draft;
  if (!cr) return;
  cr.items.splice(idx, 1);
  const tableEl = document.getElementById('cr-items-table');
  if (tableEl) tableEl.innerHTML = crRenderItemsTable(cr.items);
  const totalsEl = document.getElementById('cr-totals-box');
  if (totalsEl) totalsEl.innerHTML = crRenderTotals(cr);
};

window.crCancelEdit = function() { CrState.draft = null; CrState.view = 'log'; crRender(); };

window.crReview = function() {
  const cr = CrState.draft;
  if (!cr) return;
  // Collect form values
  const claimEl = document.getElementById('cr-claim-date');
  if (claimEl) cr.claimDate = claimEl.value;
  const notesEl = document.getElementById('cr-notes');
  if (notesEl) cr.notes = notesEl.value.trim();
  CrState.view = 'detail';
  crRender();
};

window.crOpenDetail = function(id) {
  const cr = (InvState.credits||[]).find(function(c) { return c.id === id; });
  if (!cr) return;
  CrState.draft = JSON.parse(JSON.stringify(cr));
  CrState.view = 'detail';
  crRender();
};

// ── DETAIL / PRINT ────────────────────────────────────────────────────────
function crRenderDetail(body) {
  const cr = CrState.draft;
  if (!cr) { CrState.view = 'log'; return crRender(); }

  const totalQty    = (cr.items||[]).reduce(function(s,i) { return s+(i.qty||0); }, 0);
  const totalCredit = (cr.items||[]).reduce(function(s,i) { return s+(i.qty||0)*(i.price||0); }, 0);
  const isNew = !(InvState.credits||[]).find(function(c) { return c.id === cr.id; });

  const lineRows = (cr.items||[]).map(function(item) {
    return '<tr style="border-bottom:1px solid #eee;">'
      + '<td style="padding:8px 10px;font-size:11px;font-family:monospace;color:#777;">' + crEsc(item.upc) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-weight:600;color:#111;">' + crEsc(item.artist ? item.artist + ' — ' + item.title : item.title) + '</td>'
      + '<td style="padding:8px 10px;font-size:11px;text-align:center;color:#555;">' + crEsc(item.format||'') + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;text-align:center;font-weight:700;">' + (item.qty||0) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-family:monospace;text-align:right;">' + crFmt(item.price||0) + '</td>'
      + '<td style="padding:8px 10px;font-size:12px;font-family:monospace;font-weight:700;text-align:right;">' + crFmt((item.qty||0)*(item.price||0)) + '</td>'
      + '</tr>';
  }).join('');

  const addrBlock = cr.billTo && cr.billTo.name
    ? '<strong>' + crEsc(cr.billTo.company||cr.billTo.name) + '</strong><br>'
      + (cr.billTo.company ? crEsc(cr.billTo.name) + '<br>' : '')
      + crEsc(cr.billTo.address||'') + (cr.billTo.address2 ? '<br>' + crEsc(cr.billTo.address2) : '') + '<br>'
      + crEsc(cr.billTo.city||'') + ', ' + crEsc(cr.billTo.state||'') + ' ' + crEsc(cr.billTo.zip||'') + '<br>'
      + (cr.billTo.email ? crEsc(cr.billTo.email) : '')
    : crEsc(cr.customer||'');

  body.innerHTML = '<div id="cr-detail-wrap" style="padding:24px;max-width:900px;">'
    // Action bar
    + '<div class="no-print" style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">'
    + '<button onclick="crBackToLog()" class="btn-secondary btn-sm">&#8592; Back</button>'
    + '<div style="display:flex;gap:8px;">'
    + (isNew ? '<button onclick="crEditDraft()" class="btn-secondary btn-sm">&#9998; Edit</button>' : '')
    + '<button onclick="crPrint()" class="btn-secondary btn-sm">&#128438; Print / PDF</button>'
    + (isNew ? '<button onclick="crSaveMemo()" style="background:var(--green);color:#000;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#10004; Save Credit Memo</button>' : '')
    + '</div></div>'

    // Print area
    + '<div id="cr-print-area" style="background:white;color:#111;border:1px solid var(--border);border-radius:8px;padding:28px 32px;font-family:Arial,sans-serif;font-size:12px;">'

    // Header
    + '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:20px;padding-bottom:14px;border-bottom:2px solid #b83228;">'
    + '<div>'
    + '<img src="FP-Logo_Submark-Black.jpg" alt="Fat Possum Records" style="width:60px;height:60px;object-fit:contain;display:block;margin-bottom:6px;" />'
    + '<div style="font-size:16px;font-weight:900;color:#111;">FAT POSSUM RECORDS</div>'
    + '<div style="font-size:10px;color:#666;margin-top:3px;">PO Box 1923 &nbsp;·&nbsp; Oxford, MS 38655</div>'
    + '<div style="font-size:10px;color:#666;">orders@fatpossum.com &nbsp;·&nbsp; 662-234-2828</div>'
    + '</div>'
    + '<div style="text-align:right;">'
    + '<div style="font-size:18px;font-weight:900;color:#b83228;text-transform:uppercase;letter-spacing:1px;">Credit Memo</div>'
    + '<div style="font-size:14px;font-family:monospace;font-weight:700;color:#b83228;margin-top:4px;">' + crEsc(CR_PREFIX + cr.number) + '</div>'
    + '<div style="font-size:11px;color:#666;margin-top:6px;">Claim Date: <strong>' + crDate(cr.claimDate) + '</strong></div>'
    + '<div style="font-size:11px;color:#666;">Created: <strong>' + crDate(cr.createdAt) + '</strong></div>'
    + (cr.refInvoice ? '<div style="font-size:11px;color:#666;">Ref Invoice: <strong>' + crEsc(cr.refInvoice) + '</strong></div>' : '')
    + (cr.createdBy ? '<div style="font-size:11px;color:#666;">Created by: <strong>' + crEsc(cr.createdBy.name||'') + '</strong></div>' : '')
    + '</div></div>'

    // Customer
    + '<div style="margin-bottom:20px;padding:14px;background:#f8f8f8;border-radius:6px;">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:#888;margin-bottom:6px;">Customer</div>'
    + '<div style="font-size:12px;line-height:1.7;color:#222;">' + addrBlock + '</div>'
    + '</div>'

    // Table
    + '<table style="width:100%;border-collapse:collapse;margin-bottom:20px;">'
    + '<thead><tr style="background:#111;color:white;">'
    + '<th style="padding:8px 10px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;">UPC</th>'
    + '<th style="padding:8px 10px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;">Title</th>'
    + '<th style="padding:8px 10px;text-align:center;font-size:9px;font-weight:700;text-transform:uppercase;">Format</th>'
    + '<th style="padding:8px 10px;text-align:center;font-size:9px;font-weight:700;text-transform:uppercase;">Qty</th>'
    + '<th style="padding:8px 10px;text-align:right;font-size:9px;font-weight:700;text-transform:uppercase;">Unit Cost</th>'
    + '<th style="padding:8px 10px;text-align:right;font-size:9px;font-weight:700;text-transform:uppercase;">Total Cost</th>'
    + '</tr></thead><tbody>' + lineRows + '</tbody></table>'

    // Totals
    + '<div style="display:flex;justify-content:flex-end;margin-bottom:20px;">'
    + '<div style="min-width:240px;border:1px solid #eee;border-radius:6px;overflow:hidden;">'
    + '<div style="display:flex;justify-content:space-between;padding:8px 14px;font-size:13px;border-bottom:1px solid #eee;background:#fafafa;"><span style="color:#555;">Total Qty</span><span style="font-family:monospace;font-weight:700;">' + totalQty + '</span></div>'
    + '<div style="display:flex;justify-content:space-between;padding:10px 14px;font-size:16px;font-weight:900;background:#b83228;color:white;"><span>Total Credit</span><span style="font-family:monospace;">' + crFmt(totalCredit) + '</span></div>'
    + '</div></div>'

    + (cr.notes ? '<div style="padding:10px 14px;background:#f8f8f8;border-radius:4px;font-size:11px;color:#555;border-left:3px solid #b83228;margin-bottom:16px;"><strong>Notes:</strong> ' + crEsc(cr.notes) + '</div>' : '')

    // Banking footer
    + '<div style="margin-top:16px;padding-top:10px;border-top:1px solid #ddd;font-size:8.5px;color:#888;line-height:1.7;">'
    + '<strong style="font-size:10px;color:#555;display:block;margin-bottom:3px;">Payment / Wire Transfer Information</strong>'
    + 'Bank: Renasant Bank &nbsp;|&nbsp; 111 Jackson Avenue East, Oxford, MS 38655 &nbsp;|&nbsp; (877) 367-5371<br>'
    + 'Account Name: Fat Possum Records LLC &nbsp;|&nbsp; Account #: 3100304905 &nbsp;|&nbsp; ABA: 084201294<br>'
    + 'Checks: Fat Possum Records &nbsp;|&nbsp; Attn: Patrick Addison &nbsp;|&nbsp; 827 N Lamar Blvd, Oxford, MS 38655'
    + '</div>'
    + '</div></div>';
}

window.crSaveMemo = function() {
  const cr = CrState.draft;
  if (!cr) return;
  if (!InvState.credits) InvState.credits = [];
  if (!InvState.nextCrNum) InvState.nextCrNum = CR_START;

  const existing = InvState.credits.findIndex(function(c) { return c.id === cr.id; });
  if (existing >= 0) InvState.credits[existing] = cr;
  else { InvState.credits.push(cr); InvState.nextCrNum++; }

  invSave();
  CrState.view = 'log';
  crRender();
  if (window.toast) toast('Credit memo ' + CR_PREFIX + cr.number + ' saved.', 'success');
};

window.crBackToLog  = function() { CrState.draft = null; CrState.view = 'log'; crRender(); };
window.crEditDraft  = function() { CrState.view = 'edit'; crRender(); };

window.crPrint = function() {
  const printArea = document.getElementById('cr-print-area');
  if (!printArea) return;
  const win = window.open('', '_blank', 'width=850,height=1100');
  win.document.write('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Credit Memo</title>');
  win.document.write('<base href="' + window.location.href.replace(/\/[^\/]*$/, '/') + '">');
  win.document.write('<style>* { box-sizing:border-box; margin:0; padding:0; } body { font-family:Arial,sans-serif; font-size:11px; padding:14mm; } table { width:100%; border-collapse:collapse; } th,td { padding:5px 6px; } @page { size:letter portrait; margin:0; }</style>');
  win.document.write('</head><body>');
  win.document.write(printArea.innerHTML);
  win.document.write('</body></html>');
  win.document.close();
  win.onload = function() { win.focus(); win.print(); };
};

// Delete credit memo
document.addEventListener('click', function(e) {
  const btn = e.target.closest('.cr-del-btn');
  if (!btn) return;
  e.stopPropagation();
  const id = btn.dataset.crId;
  const cr = (InvState.credits||[]).find(function(c) { return c.id === id; });
  if (!cr || !confirm('Delete ' + CR_PREFIX + cr.number + '? This cannot be undone.')) return;
  InvState.credits = InvState.credits.filter(function(c) { return c.id !== id; });
  invSave();
  crRender();
  if (window.toast) toast('Credit memo deleted.', '');
});

// ── END CREDIT MEMO ───────────────────────────────────────────────────────
