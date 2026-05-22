/* ============================================================
   FAT POSSUM -- REPORTS MODULE
   reports_module.js
   Pulls B2B sales from Packiyo channel 7 + app invoices
   Exports to CSV in label reporting format
   ============================================================ */

const RPT_CHANNEL_ID   = '7';
const RPT_CHANNEL_NAME = 'Shopify: Fat Possum B2B';
const RPT_LS_KEY       = 'fp_rpt_settings';

const RptState = {
  view:        'config',  // config | preview
  dateFrom:    '',
  dateTo:      '',
  orders:      [],        // raw Packiyo orders fetched
  rows:        [],        // merged + enriched report rows
  invSelected: {},        // { invoiceId: true/false } opt-in map
  loading:     false,
  progress:    '',
};

function rptEsc(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function rptFmt(n) { return '$' + parseFloat(n||0).toFixed(2); }

function rptGetPackiyoToken() {
  try { if (typeof CONFIG !== 'undefined') return CONFIG.PACKIYO_TOKEN; } catch(e) {}
  try { return JSON.parse(localStorage.getItem('fp_config_cache')||'{}').PACKIYO_TOKEN; } catch(e) {}
  return null;
}

async function rptPackiyoFetch(path) {
  const token = rptGetPackiyoToken();
  const base  = 'https://fatpossum.app.packiyo.com/api/v1';
  const res = await fetch(base + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'Content-Type':  'application/vnd.api+json',
      'Accept':        'application/vnd.api+json',
    }
  });
  if (!res.ok) { const t = await res.text(); throw new Error('Packiyo ' + res.status + ': ' + t.slice(0,100)); }
  return res.json();
}

// ── NAV ───────────────────────────────────────────────────────
window.switchToReports = function() {
  if (window.switchView) switchView('reports');
  RptState.view = 'config';
  rptRender();
};

function rptRender() {
  const body = document.getElementById('rpt-body');
  if (!body) return;
  if (RptState.view === 'config')  rptRenderConfig(body);
  else if (RptState.view === 'preview') rptRenderPreview(body);
}

// ── CONFIG VIEW ───────────────────────────────────────────────
function rptRenderConfig(body) {
  // Load saved date range
  let savedFrom = '', savedTo = '';
  try { const s = JSON.parse(localStorage.getItem(RPT_LS_KEY)||'{}'); savedFrom = s.dateFrom||''; savedTo = s.dateTo||''; } catch(e) {}
  if (!RptState.dateFrom && savedFrom) RptState.dateFrom = savedFrom;
  if (!RptState.dateTo   && savedTo)   RptState.dateTo   = savedTo;

  // Default to current month if empty
  if (!RptState.dateFrom) {
    const now = new Date();
    RptState.dateFrom = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0,10);
    RptState.dateTo   = new Date(now.getFullYear(), now.getMonth()+1, 0).toISOString().slice(0,10);
  }

  // App invoices available to opt-in
  const invoices = (typeof InvState !== 'undefined' ? InvState.invoices : []) || [];
  const rptInvoices = invoices.filter(function(inv) {
    return inv.status !== 'draft' && inv.sentAt;
  });

  // Load opt-in defaults from settings (saved customer list)
  let defaultOptIn = [];
  try { defaultOptIn = JSON.parse(localStorage.getItem('fp_rpt_optin_customers')||'[]'); } catch(e) {}

  // Initialize invSelected if empty
  if (!Object.keys(RptState.invSelected).length) {
    rptInvoices.forEach(function(inv) {
      const company = (inv.billTo && (inv.billTo.company || inv.billTo.name) || '').toLowerCase();
      RptState.invSelected[inv.id] = defaultOptIn.some(function(c) { return c.toLowerCase() === company; });
    });
  }

  const invRows = rptInvoices.length
    ? rptInvoices.map(function(inv) {
        const total = (inv.items||[]).reduce(function(s,i) { return s+(i.qty||0)*(i.price||0); }, 0);
        const checked = !!RptState.invSelected[inv.id];
        const d = inv.sentAt || inv.createdAt;
        return '<tr style="border-bottom:1px solid var(--border);">'
          + '<td style="padding:8px 12px;text-align:center;"><input type="checkbox" ' + (checked?'checked':'') + ' onchange="rptToggleInv(\'' + inv.id + '\',this.checked)" /></td>'
          + '<td style="padding:8px 12px;font-family:monospace;font-size:12px;color:var(--accent);">' + rptEsc((typeof INV_PREFIX !== 'undefined' ? INV_PREFIX : 'FPINV-') + inv.number) + '</td>'
          + '<td style="padding:8px 12px;font-size:12px;">' + rptEsc(inv.billTo.company || inv.billTo.name || '') + '</td>'
          + '<td style="padding:8px 12px;font-size:12px;color:var(--text-muted);">' + new Date(d).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) + '</td>'
          + '<td style="padding:8px 12px;font-family:monospace;font-size:12px;">' + rptFmt(total) + '</td>'
          + '<td style="padding:8px 12px;font-size:11px;color:var(--text-muted);">' + (inv.items||[]).length + ' items</td>'
          + '</tr>';
      }).join('')
    : '<tr><td colspan="6" style="padding:16px;text-align:center;color:var(--text-muted);font-size:12px;">No completed app invoices found.</td></tr>';

  body.innerHTML = '<div style="padding:24px;max-width:960px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
    + '<div><h2 style="margin:0;font-size:20px;">Sales Report</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">Packiyo B2B channel + app invoices → CSV export</div></div>'
    + '</div>'

    // Date range
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:14px;">Date Range</div>'
    + '<div style="display:flex;gap:16px;align-items:flex-end;flex-wrap:wrap;">'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">From</label>'
    + '<input type="date" id="rpt-date-from" value="' + RptState.dateFrom + '" style="padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" /></div>'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">To</label>'
    + '<input type="date" id="rpt-date-to" value="' + RptState.dateTo + '" style="padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);" /></div>'
    + '<div style="display:flex;gap:6px;flex-wrap:wrap;">'
    + rptQuickBtn('This Month',     rptThisMonth)
    + rptQuickBtn('Last Month',     rptLastMonth)
    + rptQuickBtn('This Quarter',   rptThisQuarter)
    + rptQuickBtn('This Year',      rptThisYear)
    + '</div></div></div>'

    // App invoices summary
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:20px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;">App Invoices</div>'
    + '<a href="#" onclick="switchToInvoices();return false;" style="font-size:11px;color:var(--accent);">Manage in Invoices &#8594;</a>'
    + '</div>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:12px;">Invoices marked Include in Sales Reports (green checkbox) will be automatically included. Set default customers in Settings.</div>'
    + '<div style="background:var(--surface2);border-radius:6px;padding:12px 16px;display:flex;gap:24px;">'
    + '<div><span style="font-size:22px;font-weight:700;font-family:monospace;color:var(--green);">' + rptInvoices.filter(function(i){return i.includeInReports;}).length + '</span> <span style="font-size:11px;color:var(--text-muted);">included</span></div>'
    + '<div><span style="font-size:22px;font-weight:700;font-family:monospace;color:var(--text-muted);">' + rptInvoices.filter(function(i){return !i.includeInReports;}).length + '</span> <span style="font-size:11px;color:var(--text-muted);">excluded</span></div>'
    + '<div><span style="font-size:22px;font-weight:700;font-family:monospace;">' + rptInvoices.length + '</span> <span style="font-size:11px;color:var(--text-muted);">total</span></div>'
    + '</div></div>'

    // Run button
    + '<div style="display:flex;justify-content:flex-end;">'
    + '<button onclick="rptRun()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:10px 28px;font-size:14px;font-weight:700;cursor:pointer;">Generate Report &#8594;</button>'
    + '</div>'

    // Loading state
    + '<div id="rpt-loading" style="display:none;margin-top:20px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:8px;text-align:center;">'
    + '<div style="font-size:13px;color:var(--text-muted);" id="rpt-progress-msg">Fetching orders from Packiyo...</div>'
    + '<div style="margin-top:12px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;">'
    + '<div id="rpt-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;border-radius:2px;"></div>'
    + '</div></div>'

    + '</div>';
}

function rptQuickBtn(label, fn) {
  return '<button onclick="(' + fn.toString() + ')()" class="btn-secondary btn-sm" style="font-size:11px;">' + label + '</button>';
}

function rptThisMonth() {
  const n = new Date();
  document.getElementById('rpt-date-from').value = new Date(n.getFullYear(), n.getMonth(), 1).toISOString().slice(0,10);
  document.getElementById('rpt-date-to').value   = new Date(n.getFullYear(), n.getMonth()+1, 0).toISOString().slice(0,10);
}
function rptLastMonth() {
  const n = new Date();
  document.getElementById('rpt-date-from').value = new Date(n.getFullYear(), n.getMonth()-1, 1).toISOString().slice(0,10);
  document.getElementById('rpt-date-to').value   = new Date(n.getFullYear(), n.getMonth(), 0).toISOString().slice(0,10);
}
function rptThisQuarter() {
  const n = new Date(); const q = Math.floor(n.getMonth()/3);
  document.getElementById('rpt-date-from').value = new Date(n.getFullYear(), q*3, 1).toISOString().slice(0,10);
  document.getElementById('rpt-date-to').value   = new Date(n.getFullYear(), q*3+3, 0).toISOString().slice(0,10);
}
function rptThisYear() {
  const y = new Date().getFullYear();
  document.getElementById('rpt-date-from').value = y + '-01-01';
  document.getElementById('rpt-date-to').value   = y + '-12-31';
}

window.rptToggleInv = function(id, checked) { RptState.invSelected[id] = checked; };
window.rptSelectAllInv = function(val) {
  const invoices = (typeof InvState !== 'undefined' ? InvState.invoices : []) || [];
  invoices.forEach(function(inv) { if (inv.status !== 'draft') RptState.invSelected[inv.id] = val; });
  rptRender();
};

// ── RUN REPORT ────────────────────────────────────────────────
window.rptRun = async function() {
  // Collect form values
  RptState.dateFrom = document.getElementById('rpt-date-from')?.value || '';
  RptState.dateTo   = document.getElementById('rpt-date-to')?.value   || '';
  if (!RptState.dateFrom || !RptState.dateTo) { if (window.toast) toast('Please select a date range.', 'error'); return; }

  // Save settings
  try { localStorage.setItem(RPT_LS_KEY, JSON.stringify({ dateFrom: RptState.dateFrom, dateTo: RptState.dateTo })); } catch(e) {}

  // Show loading
  const loadEl = document.getElementById('rpt-loading');
  const barEl  = document.getElementById('rpt-progress-bar');
  const msgEl  = document.getElementById('rpt-progress-msg');
  if (loadEl) loadEl.style.display = 'block';

  function setProgress(pct, msg) {
    if (barEl) barEl.style.width = pct + '%';
    if (msgEl) msgEl.textContent = msg;
  }

  try {
    setProgress(5, 'Fetching B2B orders from Packiyo...');

    // Fetch all B2B orders in date range
    // Filter by order_channel_id and date range
    const allOrders = [];
    const allItems  = [];
    const allContacts = {};
    let page = 1, lastPage = null;

    while (true) {
      const url = '/orders?include=order_items,shipping_contact_information,order_channel'
        + '&filter[fulfilled]=true'
        + '&filter[fulfilled_at_min]=' + RptState.dateFrom
        + '&filter[fulfilled_at_max]=' + RptState.dateTo
        + '&page[number]=' + page + '&page[size]=100';

      const data = await rptPackiyoFetch(url);

      // Collect included items, contacts and channels
      (data.included || []).forEach(function(inc) {
        if (inc.type === 'order-items') allItems.push(inc);
        if (inc.type === 'contact-informations') allContacts[inc.id] = inc.attributes;
      });

      // Only keep B2B channel orders (channel ID 7), filter client-side
      const b2bOrders = (data.data || []).filter(function(o) {
        const chId = o.relationships && o.relationships.order_channel && o.relationships.order_channel.data && o.relationships.order_channel.data.id;
        return chId === RPT_CHANNEL_ID;
      });
      allOrders.push(...b2bOrders);

      const meta = data.meta?.page || data.meta || {};
      lastPage = parseInt(meta.lastPage || meta.last_page || meta.total_pages || 1) || 1;
      setProgress(5 + Math.round((page/lastPage)*60), 'Fetching orders: page ' + page + ' of ' + lastPage);
      if (page >= lastPage) break;
      page++;
    }

    setProgress(70, 'Enriching with catalog data...');

    // Build item map by order ID
    const itemsByOrderId = {};
    allItems.forEach(function(item) { });
    // Tag items with order
    allOrders.forEach(function(order) {
      const refs = (order.relationships?.order_items?.data || []).map(function(r) { return r.id; });
      const contactRef = order.relationships?.shipping_contact_information?.data?.id;
      order._contact = contactRef ? allContacts[contactRef] : null;
      order._items   = allItems.filter(function(i) { return refs.includes(i.id); });
    });

    // Build catalog lookup by SKU
    const catalogBySku = {};
    const catalog = (typeof State !== 'undefined' && State.merged) ? State.merged : [];
    catalog.forEach(function(p) {
      if (p.catalog) catalogBySku[p.catalog.toLowerCase()] = p;
      if (p.upc)     catalogBySku[p.upc] = p;
    });

    setProgress(80, 'Building report rows...');

    // Build rows from Packiyo orders
    RptState.rows = [];
    allOrders.forEach(function(order) {
      const fulfilledAt = order.attributes.fulfilled_at || order.attributes.ordered_at || '';
      const d = new Date(fulfilledAt);
      const year     = d.getFullYear();
      const month    = d.toLocaleString('en-US', { month: 'long' });
      const monthNum = d.getMonth() + 1;
      const contact = order._contact || {};
      const customerDisplay = contact.company_name || contact.name || '';
      const countryCode = contact.country || '';

      (order._items || []).forEach(function(item) {
        const a = item.attributes;
        const sku = a.sku || '';
        const netUnits = parseInt(a.quantity_shipped || 0);
        if (netUnits <= 0) return;
        const netRevenue = netUnits * parseFloat(a.price || 0);

        // Enrich from catalog
        const cat = catalogBySku[sku.toLowerCase()] || catalogBySku[sku] || null;
        const artist  = cat ? (cat.artist  || '') : '';
        const title   = cat ? (cat.title   || '') : (a.name || sku);
        const upc     = cat ? (cat.upc     || '') : '';
        const catNum  = cat ? (cat.catalog || sku) : sku;
        const format  = cat ? (cat.format  || '') : '';

        RptState.rows.push({
          source:          'packiyo',
          customerDisplay: customerDisplay,
          company:         contact.company_name || '',
          countryCode:     countryCode,
          year:            year,
          month:           month,
          monthNum:        monthNum,
          format:          format,
          artist:          artist,
          title:           title,
          upc:             upc,
          catalog:         catNum,
          netUnits:        netUnits,
          netRevenue:      netRevenue,
          orderNum:        order.attributes.number || '',
        });
      });
    });

    // Add opted-in app invoices
    setProgress(90, 'Adding app invoices...');
    const invoices = (typeof InvState !== 'undefined' ? InvState.invoices : []) || [];
    invoices.forEach(function(inv) {
      if (!inv.includeInReports) return;
      const d = new Date(inv.sentAt || inv.createdAt);
      const year     = d.getFullYear();
      const month    = d.toLocaleString('en-US', { month: 'long' });
      const monthNum = d.getMonth() + 1;
      const customerDisplay = inv.billTo.company || inv.billTo.name || '';

      (inv.items || []).forEach(function(item) {
        const netUnits   = item.qty || 0;
        const netRevenue = netUnits * parseFloat(item.price || 0);
        if (netUnits <= 0) return;
        RptState.rows.push({
          source:          'invoice',
          customerDisplay: customerDisplay,
          company:         inv.billTo.company || '',
          countryCode:     inv.billTo.country || 'US',
          year:            year,
          month:           month,
          monthNum:        monthNum,
          format:          item.format || '',
          artist:          item.artist || '',
          title:           item.title  || '',
          upc:             item.upc    || '',
          catalog:         item.catalog|| '',
          netUnits:        netUnits,
          netRevenue:      netRevenue,
          orderNum:        (typeof INV_PREFIX !== 'undefined' ? INV_PREFIX : 'FPINV-') + inv.number,
        });
      });
    });

    setProgress(100, 'Done! ' + RptState.rows.length + ' rows generated.');
    setTimeout(function() {
      if (loadEl) loadEl.style.display = 'none';
      RptState.view = 'preview';
      rptRender();
    }, 400);

  } catch(e) {
    if (loadEl) loadEl.style.display = 'none';
    if (window.toast) toast('Report error: ' + e.message, 'error');
    console.error('Report error:', e);
  }
};

// ── PREVIEW VIEW ──────────────────────────────────────────────
function rptRenderPreview(body) {
  const rows = RptState.rows;
  const packiyoCount = rows.filter(function(r) { return r.source === 'packiyo'; }).length;
  const invoiceCount = rows.filter(function(r) { return r.source === 'invoice'; }).length;
  const totalUnits   = rows.reduce(function(s,r) { return s + r.netUnits; }, 0);
  const totalRevenue = rows.reduce(function(s,r) { return s + r.netRevenue; }, 0);

  const tableRows = rows.slice(0, 200).map(function(r) {
    return '<tr style="border-bottom:1px solid var(--border);">'
      + '<td style="padding:6px 10px;font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + rptEsc(r.customerDisplay) + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;">' + rptEsc(r.countryCode) + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;">' + r.year + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;">' + r.month + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;">' + rptEsc(r.format) + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + rptEsc(r.artist) + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;max-width:140px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + rptEsc(r.title) + '</td>'
      + '<td style="padding:6px 10px;font-size:10px;font-family:monospace;color:var(--text-muted);">' + rptEsc(r.upc) + '</td>'
      + '<td style="padding:6px 10px;font-size:10px;font-family:monospace;color:var(--text-muted);">' + rptEsc(r.catalog) + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;text-align:right;font-weight:700;">' + r.netUnits + '</td>'
      + '<td style="padding:6px 10px;font-size:11px;text-align:right;font-family:monospace;">' + rptFmt(r.netRevenue) + '</td>'
      + '</tr>';
  }).join('');

  const th = 'padding:7px 10px;text-align:left;font-size:9px;font-weight:700;text-transform:uppercase;color:var(--text-muted);white-space:nowrap;';

  body.innerHTML = '<div style="padding:24px;">'
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">'
    + '<div>'
    + '<h2 style="margin:0;font-size:20px;">Report Preview</h2>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">'
    + RptState.dateFrom + ' → ' + RptState.dateTo
    + ' &nbsp;·&nbsp; ' + rows.length + ' rows'
    + ' &nbsp;·&nbsp; ' + packiyoCount + ' B2B &nbsp;·&nbsp; ' + invoiceCount + ' invoices'
    + '</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<button onclick="RptState.view=\'config\';rptRender()" class="btn-secondary btn-sm">&#8592; Back</button>'
    + '<button onclick="rptExportCSV()" style="background:var(--green);color:#000;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">&#8595; Export CSV</button>'
    + '</div></div>'

    // Summary cards
    + '<div style="display:flex;gap:12px;margin-bottom:16px;">'
    + rptSummaryCard('Total Rows', rows.length, 'var(--text)')
    + rptSummaryCard('Net Units', totalUnits.toLocaleString(), 'var(--accent)')
    + rptSummaryCard('Net Revenue', rptFmt(totalRevenue), 'var(--green)')
    + rptSummaryCard('B2B Orders', packiyoCount, 'var(--text-muted)')
    + rptSummaryCard('App Invoices', invoiceCount, 'var(--text-muted)')
    + '</div>'

    + (rows.length > 200 ? '<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">Showing first 200 rows. All ' + rows.length + ' rows will be included in CSV export.</div>' : '')

    + '<div style="background:var(--surface);border-radius:8px;border:1px solid var(--border);overflow:auto;">'
    + '<table style="width:100%;border-collapse:collapse;font-size:11px;min-width:900px;">'
    + '<thead><tr style="background:var(--surface2);">'
    + '<th style="' + th + '">Customer</th>'
    + '<th style="' + th + '">Country</th>'
    + '<th style="' + th + '">Year</th>'
    + '<th style="' + th + '">Month</th>'
    + '<th style="' + th + '">Format</th>'
    + '<th style="' + th + '">Artist</th>'
    + '<th style="' + th + '">Title</th>'
    + '<th style="' + th + '">UPC</th>'
    + '<th style="' + th + '">Cat #</th>'
    + '<th style="' + th + 'text-align:right;">Net Units</th>'
    + '<th style="' + th + 'text-align:right;">Net Revenue</th>'
    + '</tr></thead><tbody>' + tableRows + '</tbody></table></div></div>';
}

function rptSummaryCard(label, val, color) {
  return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:12px 16px;flex:1;">'
    + '<div style="font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:0.8px;margin-bottom:4px;">' + label + '</div>'
    + '<div style="font-size:20px;font-weight:700;font-family:monospace;color:' + color + ';">' + val + '</div>'
    + '</div>';
}

// ── CSV EXPORT ────────────────────────────────────────────────
window.rptExportCSV = function() {
  const rows = RptState.rows;
  if (!rows.length) { if (window.toast) toast('No data to export.', 'error'); return; }

  const headers = [
    'Customer Name',
    'Customer Company',
    'Country Code',
    'Sale Year',
    'Sale Month',
    'Product Type',
    'Artist Name',
    'Album Title',
    'UPC',
    'Catalog Number',
    'Net Units',
    'Net Revenue',
  ];

  const csvRows = rows.map(function(r) {
    const saleYear  = String(r.year).slice(-2); // 2-digit year
    const saleMonth = String(r.monthNum).padStart(2,'0'); // 2-digit month number
    const upcStr    = r.upc ? '="' + r.upc + '"' : ''; // force as string to preserve leading zeros
    return [
      r.customerDisplay,
      r.company,
      r.countryCode,
      saleYear,
      saleMonth,
      r.format,
      r.artist,
      r.title,
      upcStr,
      r.catalog,
      r.netUnits,
      r.netRevenue.toFixed(2),
    ].map(function(v) {
      const s = String(v || '').replace(/"/g, '""');
      return /,|"|\n/.test(s) ? '"' + s + '"' : s;
    }).join(',');
  });

  const csv = headers.join(',') + '\n' + csvRows.join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'fp-sales-report-' + RptState.dateFrom + '-to-' + RptState.dateTo + '.csv';
  a.click();
  URL.revokeObjectURL(a.href);
  if (window.toast) toast(rows.length + ' rows exported to CSV.', 'success');
};

// ── BOOT ──────────────────────────────────────────────────────
(function() {
  // Expose quick date setters as globals for onclick
  window.rptThisMonth    = rptThisMonth;
  window.rptLastMonth    = rptLastMonth;
  window.rptThisQuarter  = rptThisQuarter;
  window.rptThisYear     = rptThisYear;
})();
