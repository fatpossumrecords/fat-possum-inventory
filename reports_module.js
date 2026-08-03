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

async function rptPackiyoFetch(path, retries) {
  retries = retries || 3;
  const base = CONFIG.WORKER_BASE + '/packiyo';
  for (let attempt = 0; attempt < retries; attempt++) {
    const res = await fetch(base + path, {
      headers: Object.assign({
        'Content-Type':  'application/vnd.api+json',
        'Accept':        'application/vnd.api+json',
      }, authHeader())
    });
    if (res.status === 429) {
      const wait = (attempt + 1) * 2000;
      console.warn(`Report Packiyo fetch rate limited, retrying in ${wait}ms…`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) { const t = await res.text(); throw new Error('Packiyo ' + res.status + ': ' + t.slice(0,100)); }
    return res.json();
  }
  throw new Error('Packiyo rate limit exceeded after retries');
}

// ── NAV ───────────────────────────────────────────────────────
window.switchToReports = function() {
  if (window.switchView) switchView('reports');
  RptState.view = 'config';
  rptRender();
};

window.rptBackToConfig = function() { RptState.view = 'config'; rptRender(); };

window.rptShowLog = async function() {
  const body = document.getElementById('rpt-body');
  if (!body) return;
  body.innerHTML = '<div style="padding:24px;"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:20px;">'
    + '<div><h2 style="margin:0;">Report History</h2><div style="font-size:12px;color:var(--text-muted);margin-top:2px;">All generated reports — manual and scheduled</div></div>'
    + '<div style="display:flex;gap:8px;">'
    + '<a href="https://docs.google.com/spreadsheets/d/1lRTU74QE711rxlB3x10Dj0SaEyxbkesPSRaEJknaTw4" target="_blank" class="btn-secondary btn-sm">&#128196; Open in Sheets</a>'
    + '<button onclick="rptBackToConfig()" class="btn-secondary btn-sm">&#8592; Back</button>'
    + '</div></div>'
    + '<div id="rpt-log-content" style="text-align:center;padding:32px;color:var(--text-muted);">Loading log...</div>'
    + '</div>';

  // Load log from Gist
  try {
    const creds = typeof invGetCreds === 'function' ? invGetCreds() : null;
    if (!creds) { document.getElementById('rpt-log-content').textContent = 'Not available — Gist credentials not loaded.'; return; }
    const content = await fetchGistFile('fp_reports_log.json');
    const log  = content ? JSON.parse(content) : { runs: [] };
    const runs = log.runs || [];

    if (!runs.length) {
      document.getElementById('rpt-log-content').innerHTML = '<div style="padding:32px;text-align:center;color:var(--text-muted);">No report runs yet. Reports will appear here after the first scheduled or manual run.</div>';
      return;
    }

    const statusColor = { sent:'var(--green)', failed:'var(--red)', running:'var(--yellow)', generated:'var(--accent)' };
    const rows = runs.map(function(r) {
      const sc = statusColor[r.status] || 'var(--text-muted)';
      return '<tr style="border-bottom:1px solid var(--border);cursor:pointer;">'
        + '<td style="padding:10px 12px;font-size:12px;">' + rptEsc(r.runAt ? new Date(r.runAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : '') + '</td>'
        + '<td style="padding:10px 12px;font-size:13px;font-weight:600;">' + rptEsc(r.period||'') + '</td>'
        + '<td style="padding:10px 12px;font-size:11px;color:var(--text-muted);">' + rptEsc(r.dateFrom||'') + ' → ' + rptEsc(r.dateTo||'') + '</td>'
        + '<td style="padding:10px 12px;font-size:11px;">' + rptEsc(r.source||'') + '</td>'
        + '<td style="padding:10px 12px;"><span style="background:' + sc + ';color:#fff;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;">' + rptEsc(r.status||'') + '</span></td>'
        + '<td style="padding:10px 12px;font-size:12px;font-family:monospace;">' + (r.rowCount||0) + '</td>'
        + '<td style="padding:10px 12px;font-size:11px;color:var(--text-muted);">' + (r.b2bOrders||0) + ' B2B · ' + (r.invoices||0) + ' inv</td>'
        + '<td style="padding:10px 12px;font-size:11px;color:var(--red);">' + rptEsc(r.error||'') + '</td>'
        + '</tr>';
    }).join('');

    document.getElementById('rpt-log-content').innerHTML = '<div style="background:var(--surface);border-radius:8px;border:1px solid var(--border);overflow:auto;">'
      + '<table style="width:100%;border-collapse:collapse;font-size:12px;min-width:700px;">'
      + '<thead><tr style="background:var(--surface2);">'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Run At</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Period</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Date Range</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Source</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Status</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Rows</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Breakdown</th>'
      + '<th style="padding:8px 12px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;color:var(--text-muted);">Error</th>'
      + '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  } catch(e) {
    document.getElementById('rpt-log-content').textContent = 'Error loading log: ' + e.message;
  }
};

function rptRender() {
  const body = document.getElementById('rpt-body');
  if (!body) return;
  if (RptState.view === 'config')  rptRenderConfig(body);
  else if (RptState.view === 'preview') rptRenderPreview(body);
}

// ── CONFIG VIEW ───────────────────────────────────────────────
function rptDayOptions() {
  const saved = rptGetSchedule().day || 1;
  let html = '';
  for (let d = 1; d <= 28; d++) {
    const s = d % 100;
    const suffix = (s >= 11 && s <= 13) ? 'th' : (d % 10 === 1) ? 'st' : (d % 10 === 2) ? 'nd' : (d % 10 === 3) ? 'rd' : 'th';
    html += '<option value="' + d + '"' + (saved === d ? ' selected' : '') + '>' + d + suffix + '</option>';
  }
  return html;
}

function rptPeriodOptions() {
  const saved = rptGetSchedule().period || 'last_month';
  const opts = [
    ['week_to_date',   'Week To Date'],
    ['last_week',      'Last Week'],
    ['last_two_weeks', 'Last Two Weeks'],
    ['this_month',     'This Month'],
    ['last_month',     'Last Month'],
    ['two_months_ago', 'Two Months Ago'],
    ['this_quarter',   'This Quarter'],
    ['last_quarter',   'Last Quarter'],
    ['year_to_date',   'Year To Date'],
    ['last_year',      'Last Year'],
  ];
  return opts.map(function(o) {
    return '<option value="' + o[0] + '"' + (saved === o[0] ? ' selected' : '') + '>' + o[1] + '</option>';
  }).join('');
}

function rptGetSchedule() {
  try { return JSON.parse(localStorage.getItem('fp_rpt_schedule') || '{}'); } catch(e) { return {}; }
}

window.rptSaveSchedule = async function() {
  const day    = parseInt(document.getElementById('rpt-schedule-day')?.value || '1');
  const period = document.getElementById('rpt-schedule-period')?.value || 'last_month';
  const emails = document.getElementById('rpt-schedule-emails')?.value.trim() || '';
  const schedule = { day, period, emails, updatedAt: new Date().toISOString() };

  // Save to localStorage
  try { localStorage.setItem('fp_rpt_schedule', JSON.stringify(schedule)); } catch(e) {}

  // Save to Gist so GitHub Action can read it
  const statusEl = document.getElementById('rpt-schedule-status');
  if (statusEl) statusEl.textContent = 'Saving...';
  try {
    const creds = typeof invGetCreds === 'function' ? invGetCreds() : null;
    if (creds) {
      await fetch(gistUrl(creds.gistId), {
        method: 'PATCH',
        headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
        body: JSON.stringify({ files: { 'fp_report_schedule.json': { content: JSON.stringify(schedule, null, 2) } } }),
      });
      if (statusEl) statusEl.textContent = '✓ Schedule saved — runs on the ' + day + (day===1?'st':day===2?'nd':day===3?'rd':'th') + ' of each month';
    } else {
      if (statusEl) statusEl.textContent = '✓ Saved locally (Gist not available)';
    }
  } catch(e) {
    if (statusEl) statusEl.textContent = 'Error saving: ' + e.message;
  }
  if (window.toast) toast('Schedule saved.', 'success');
};

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
    + '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:24px;">'
    + '<button onclick="rptShowLog()" class="btn-secondary btn-sm">&#128203; Report History</button>'
    + '<button onclick="rptRun()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:10px 28px;font-size:14px;font-weight:700;cursor:pointer;">Generate Report &#8594;</button>'
    + '</div>'

    // Schedule config
    + '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px;margin-bottom:16px;">'
    + '<div style="font-size:11px;font-weight:700;text-transform:uppercase;color:var(--text-muted);letter-spacing:1px;margin-bottom:14px;">Automated Email Schedule</div>'
    + '<div style="font-size:12px;color:var(--text-muted);margin-bottom:16px;">The GitHub Action checks daily and emails the report on the day you configure below (once per month, first check of that day). Requires RESEND_API_KEY secret to be set in GitHub.</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px;">'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Day of Month</label>'
    + '<select id="rpt-schedule-day" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">'
    + rptDayOptions()
    + '</select></div>'
    + '<div><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Report Period</label>'
    + '<select id="rpt-schedule-period" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">'
    + rptPeriodOptions()
    + '</select></div>'
    + '</div>'
    + '<div style="margin-bottom:12px;"><label style="font-size:11px;font-weight:600;color:var(--text-muted);display:block;margin-bottom:4px;">Email Recipients (comma-separated)</label>'
    + '<input type="text" id="rpt-schedule-emails" placeholder="you@fatpossum.com, accounting@fatpossum.com" '
    + 'style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);box-sizing:border-box;" /></div>'
    + '<div style="display:flex;justify-content:space-between;align-items:center;">'
    + '<div id="rpt-schedule-status" style="font-size:12px;color:var(--text-muted);"></div>'
    + '<button onclick="rptSaveSchedule()" style="background:var(--accent);color:#fff;border:none;border-radius:4px;padding:8px 18px;font-size:13px;font-weight:700;cursor:pointer;">Save Schedule</button>'
    + '</div></div>'

    // Loading state
    + '<div id="rpt-loading" style="display:none;margin-top:20px;padding:20px;background:var(--surface);border:1px solid var(--border);border-radius:8px;text-align:center;">'
    + '<div style="font-size:13px;color:var(--text-muted);" id="rpt-progress-msg">Fetching orders from Packiyo...</div>'
    + '<div style="margin-top:12px;height:4px;background:var(--border);border-radius:2px;overflow:hidden;">'
    + '<div id="rpt-progress-bar" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s;border-radius:2px;"></div>'
    + '</div></div>'

    + '</div>';

  // Load saved schedule values — prefer Gist, fall back to localStorage
  setTimeout(async function() {
    let s = rptGetSchedule(); // localStorage first for instant display
    if (s.emails) { const el = document.getElementById('rpt-schedule-emails'); if (el) el.value = s.emails; }
    if (s.period) { const el = document.getElementById('rpt-schedule-period'); if (el) el.value = s.period; }

    // Then fetch from Gist to get latest
    try {
      const creds = typeof invGetCreds === 'function' ? invGetCreds() : null;
      if (creds) {
        const content = await fetchGistFile('fp_report_schedule.json');
        if (content) {
          const gs = JSON.parse(content);
          localStorage.setItem('fp_rpt_schedule', JSON.stringify(gs));
          if (gs.emails) { const el = document.getElementById('rpt-schedule-emails'); if (el) el.value = gs.emails; }
          if (gs.period) { const el = document.getElementById('rpt-schedule-period'); if (el) el.value = gs.period; }
          s = gs;
        }
      }
    } catch(e) { console.warn('Could not load schedule from Gist:', e.message); }

    const saved   = s.day || 1;
    const statusEl = document.getElementById('rpt-schedule-status');
    if (statusEl && s.day) {
      const s2 = saved % 100; const suffix = (s2 >= 11 && s2 <= 13) ? 'th' : (saved % 10 === 1) ? 'st' : (saved % 10 === 2) ? 'nd' : (saved % 10 === 3) ? 'rd' : 'th';
      statusEl.textContent = 'Currently: ' + saved + suffix + ' of each month';
    }
  }, 50);
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

    // Build item map by ID for O(1) lookup when tagging items onto orders
    const itemsById = {};
    allItems.forEach(function(item) { itemsById[item.id] = item; });
    // Tag items with order
    allOrders.forEach(function(order) {
      const refs = (order.relationships?.order_items?.data || []).map(function(r) { return r.id; });
      const contactRef = order.relationships?.shipping_contact_information?.data?.id;
      order._contact = contactRef ? allContacts[contactRef] : null;
      order._items   = refs.map(function(id) { return itemsById[id]; }).filter(Boolean);
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

  // Log the manual export to Gist
  try {
    const creds = typeof invGetCreds === 'function' ? invGetCreds() : null;
    if (creds) {
      const logEntry = {
        id: 'rpt-' + Date.now(),
        runAt: new Date().toISOString(),
        period: RptState.dateFrom + ' → ' + RptState.dateTo,
        dateFrom: RptState.dateFrom,
        dateTo: RptState.dateTo,
        source: 'manual',
        status: 'generated',
        rowCount: rows.length,
        b2bOrders: rows.filter(function(r){return r.source==='packiyo';}).length,
        invoices: rows.filter(function(r){return r.source==='invoice';}).length,
        recipients: [],
        error: null,
      };
      fetchGistFile('fp_reports_log.json').then(function(content) {
        const log = content ? JSON.parse(content) : { runs: [] };
        if (!log.runs) log.runs = [];
        log.runs.unshift(logEntry);
        if (log.runs.length > 100) log.runs = log.runs.slice(0,100);
        return fetch(gistUrl(creds.gistId), {
          method: 'PATCH',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
          body: JSON.stringify({ files: { 'fp_reports_log.json': { content: JSON.stringify(log) } } }),
        });
      }).catch(function(){});
    }
  } catch(e) {}
};

// ── BOOT ──────────────────────────────────────────────────────
(function() {
  // Expose quick date setters as globals for onclick
  window.rptThisMonth    = rptThisMonth;
  window.rptLastMonth    = rptLastMonth;
  window.rptThisQuarter  = rptThisQuarter;
  window.rptThisYear     = rptThisYear;
})();
