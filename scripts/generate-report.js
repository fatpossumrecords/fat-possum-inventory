#!/usr/bin/env node
/* ============================================================
   FAT POSSUM -- SALES REPORT SCRIPT
   scripts/generate-report.js
   Runs daily via GitHub Actions, emails on configured schedule
   Appends rows to Google Sheets + logs run metadata
   ============================================================ */

const fetch = require('node-fetch');

const PACKIYO_BASE    = 'https://fatpossum.app.packiyo.com/api/v1';
const PACKIYO_TOKEN   = process.env.PACKIYO_TOKEN;
const GIST_ID         = process.env.GIST_ID;
const GIST_TOKEN      = process.env.GIST_TOKEN;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const REPORT_TO       = process.env.REPORT_TO;
const MONTH_OVERRIDE  = process.env.MONTH_OVERRIDE || '';
const FORCE_SEND      = process.env.FORCE_SEND === 'true';
const SHEETS_ID       = process.env.SHEETS_ID;
const SA_JSON         = process.env.GOOGLE_SERVICE_ACCOUNT;

const B2B_CHANNEL_ID  = '7';
const INV_GIST_FILE   = 'fp_invoices.json';
const CAT_GIST_FILE   = 'fp_data.json';
const SCHED_GIST_FILE = 'fp_report_schedule.json';
const LOG_GIST_FILE   = 'fp_reports_log.json';

// ── GOOGLE AUTH ─────────────────────────────────────────────────
async function getGoogleToken() {
  const sa = JSON.parse(SA_JSON);
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');

  const { createSign } = require('crypto');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const signature = sign.sign(sa.private_key, 'base64url');
  const jwt = `${header}.${payload}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`,
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Google auth failed: ${t.slice(0,200)}`); }
  const data = await res.json();
  return data.access_token;
}

// ── SHEETS HELPERS ──────────────────────────────────────────────
async function sheetsRequest(token, method, path, body) {
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SHEETS_ID}${path}`, {
    method,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Sheets ${res.status}: ${t.slice(0,200)}`); }
  return res.json();
}

async function ensureSheet(token, sheetName) {
  // Get existing sheets
  const meta = await sheetsRequest(token, 'GET', '');
  const exists = meta.sheets?.some(s => s.properties.title === sheetName);
  if (!exists) {
    await sheetsRequest(token, 'POST', ':batchUpdate', {
      requests: [{ addSheet: { properties: { title: sheetName } } }]
    });
    console.log(`  Created sheet: ${sheetName}`);
  }
}

async function appendRows(token, sheetName, rows) {
  await sheetsRequest(token, 'POST',
    `/values/${encodeURIComponent(sheetName)}!A1:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    { values: rows }
  );
}

async function clearAndWriteSheet(token, sheetName, rows) {
  // Clear existing content
  await sheetsRequest(token, 'POST', `/values/${encodeURIComponent(sheetName)}!A:Z:clear`, {});
  // Write fresh
  await sheetsRequest(token, 'PUT',
    `/values/${encodeURIComponent(sheetName)}!A1?valueInputOption=RAW`,
    { values: rows }
  );
}

// ── GIST HELPERS ────────────────────────────────────────────────
async function gistFetch(filename) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { 'Authorization': `token ${GIST_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);
  const gist = await res.json();
  const file = gist.files?.[filename];
  if (!file?.content) return null;
  return JSON.parse(file.content);
}

async function gistWrite(filename, data) {
  await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: { 'Authorization': `token ${GIST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(data, null, 2) } } }),
  });
}

// ── SCHEDULE CHECK ──────────────────────────────────────────────
async function shouldRun() {
  if (FORCE_SEND) { console.log('Force send enabled'); return true; }
  if (MONTH_OVERRIDE) { console.log('Month override set'); return true; }
  let schedule = null;
  try {
    schedule = await gistFetch(SCHED_GIST_FILE);
  } catch(e) {
    console.warn(`  Schedule fetch failed: ${e.message}`);
  }
  if (!schedule?.day) { console.log('No schedule — defaulting to 1st at 8 AM'); schedule = { day: 1, hour: 8 }; }

  // Convert current UTC time to Central time (CDT = UTC-5, CST = UTC-6)
  const now = new Date();
  const centralOffset = isCDT(now) ? -5 : -6;
  const centralHour = (now.getUTCHours() + 24 + centralOffset) % 24;
  const centralDate = new Date(now.getTime() + centralOffset * 3600000);
  const centralDay  = centralDate.getUTCDate();

  const scheduledDay  = parseInt(schedule.day)  || 1;
  const scheduledHour = parseInt(schedule.hour) ?? 8;

  console.log(`Central time: day=${centralDay} hour=${centralHour} | Scheduled: day=${scheduledDay} hour=${scheduledHour} | DST: ${isCDT(now)?'CDT':'CST'}`);

  if (centralDay !== scheduledDay) {
    console.log('Not scheduled day — skipping');
    return false;
  }

  // Cron runs can be delayed by GitHub's scheduler (queue backlog, especially
  // around common trigger times like 1st-of-month). Instead of requiring an
  // exact hour match (which causes a delayed run to skip the whole day), we
  // fire on the FIRST run at or after the scheduled hour, and use a
  // "already sent this period" flag in the Gist to prevent duplicate sends
  // from later runs the same day.
  if (centralHour < scheduledHour) {
    console.log(`Before scheduled hour (now ${centralHour}, want ${scheduledHour}) — skipping`);
    return false;
  }

  const periodKey = `${centralDate.getUTCFullYear()}-${String(centralDate.getUTCMonth()+1).padStart(2,'0')}`;
  let log = null;
  try {
    log = await gistFetch(LOG_GIST_FILE);
  } catch(e) {
    console.warn(`  Log fetch failed: ${e.message}`);
  }
  const alreadySent = (log?.runs || []).some(r => r.status === 'sent' && r.source === 'scheduled' && r.sentPeriodKey === periodKey);
  if (alreadySent) {
    console.log(`Already sent scheduled report for ${periodKey} — skipping`);
    return false;
  }

  return true;
}

// Returns true if the given UTC date falls within US CDT (second Sunday of March
// through first Sunday of November).
function isCDT(utcDate) {
  const y = utcDate.getUTCFullYear();
  // Second Sunday of March at 2 AM local (7 AM UTC during EST)
  const marchStart = nthSundayUTC(y, 2, 2); // March = month 2 (0-indexed)
  // First Sunday of November at 2 AM local (7 AM UTC during EDT)
  const novEnd     = nthSundayUTC(y, 10, 1); // November = month 10
  return utcDate >= marchStart && utcDate < novEnd;
}

function nthSundayUTC(year, month0, n) {
  // Find the nth Sunday of month0 (0-indexed) at 07:00 UTC
  const d = new Date(Date.UTC(year, month0, 1, 7, 0, 0));
  const dow = d.getUTCDay(); // 0=Sun
  const daysToSun = dow === 0 ? 0 : 7 - dow;
  d.setUTCDate(1 + daysToSun + (n - 1) * 7);
  return d;
}

// ── DATE RANGE ──────────────────────────────────────────────────
async function getDateRange() {
  let period = 'last_month';
  try {
    const s = await gistFetch(SCHED_GIST_FILE);
    if (s?.period) period = s.period;
  } catch(e) {
    console.warn(`  Schedule fetch failed (date range): ${e.message}`);
  }
  if (MONTH_OVERRIDE && /^\d{4}-\d{2}$/.test(MONTH_OVERRIDE)) {
    const [year, month] = MONTH_OVERRIDE.split('-').map(Number);
    const pad    = n => String(n).padStart(2,'0');


  }
  const now = new Date();
  const pad = n => String(n).padStart(2,'0');
  let from, to, year, month, periodLabel;

  if (period === 'week_to_date') {
    const s = new Date(now); s.setDate(now.getDate() - now.getDay());
    from = s.toISOString().slice(0,10); to = now.toISOString().slice(0,10); periodLabel = 'Week to Date';
  } else if (period === 'last_week') {
    const s = new Date(now); s.setDate(now.getDate() - now.getDay() - 7);
    const e = new Date(s); e.setDate(s.getDate() + 6);
    from = s.toISOString().slice(0,10); to = e.toISOString().slice(0,10); periodLabel = 'Last Week';
  } else if (period === 'last_two_weeks') {
    const s = new Date(now); s.setDate(now.getDate() - 14);
    from = s.toISOString().slice(0,10); to = now.toISOString().slice(0,10); periodLabel = 'Last Two Weeks';
  } else if (period === 'this_month') {
    from = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`; to = now.toISOString().slice(0,10); periodLabel = 'This Month';
  } else if (period === 'two_months_ago') {
    const d = new Date(now.getFullYear(), now.getMonth()-2, 1);
    year = d.getFullYear(); month = d.getMonth()+1;
    from = `${year}-${pad(month)}-01`; to = `${year}-${pad(month)}-${new Date(year,month,0).getDate()}`; periodLabel = `${d.toLocaleString('en-US',{month:'long'})} ${year}`;
  } else if (period === 'this_quarter') {
    const q = Math.floor(now.getMonth()/3);
    from = `${now.getFullYear()}-${pad(q*3+1)}-01`; to = now.toISOString().slice(0,10); periodLabel = `Q${q+1} ${now.getFullYear()}`;
  } else if (period === 'last_quarter') {
    const q = Math.floor(now.getMonth()/3);
    const qs = q===0 ? new Date(now.getFullYear()-1,9,1) : new Date(now.getFullYear(),(q-1)*3,1);
    const qe = new Date(qs.getFullYear(), qs.getMonth()+3, 0);
    from = qs.toISOString().slice(0,10); to = qe.toISOString().slice(0,10); periodLabel = `Q${q===0?4:q} ${qs.getFullYear()}`;
  } else if (period === 'year_to_date') {
    from = `${now.getFullYear()}-01-01`; to = now.toISOString().slice(0,10); periodLabel = `YTD ${now.getFullYear()}`;
  } else if (period === 'last_year') {
    const ly = now.getFullYear()-1;
    from = `${ly}-01-01`; to = `${ly}-12-31`; periodLabel = String(ly);
  } else {
    const last = new Date(now.getFullYear(), now.getMonth()-1, 1);
    year = last.getFullYear(); month = last.getMonth()+1;
    from = `${year}-${pad(month)}-01`; to = `${year}-${pad(month)}-${new Date(year,month,0).getDate()}`;
    periodLabel = `${last.toLocaleString('en-US',{month:'long'})} ${year}`;
  }
  if (!year) year = new Date(from).getFullYear();
  if (!month) month = new Date(from).getMonth()+1;
  return { from, to, year, month, periodLabel };
}

// ── PACKIYO ─────────────────────────────────────────────────────
async function packiyoFetch(path) {
  const res = await fetch(PACKIYO_BASE + path, {
    headers: { 'Authorization':`Bearer ${PACKIYO_TOKEN}`, 'Content-Type':'application/vnd.api+json', 'Accept':'application/vnd.api+json' }
  });
  if (!res.ok) { const t = await res.text(); throw new Error(`Packiyo ${res.status}: ${t.slice(0,200)}`); }
  return res.json();
}

async function packiyoFetchAll(path) {
  const allData = [], allIncluded = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const data = await packiyoFetch(`${path}${sep}page[number]=${page}&page[size]=100`);
    allData.push(...(data.data||[]));
    allIncluded.push(...(data.included||[]));
    const meta = data.meta?.page || data.meta || {};
    const last = parseInt(meta.lastPage||meta.last_page||meta.total_pages||1)||1;
    console.log(`  Page ${page}/${last}`);
    if (page >= last) break;
    page++;
  }
  return { allData, allIncluded };
}

// ── MAIN ────────────────────────────────────────────────────────
// UPC padding helper
const padUPC = u => u ? String(u).replace(/\D/g,'').padStart(12,'0') : '';

async function main() {
  console.log('\n=== Fat Possum Sales Report ===');
  const runTime = new Date().toISOString();

  const run = await shouldRun();
  if (!run) { console.log('Nothing to do today.'); return; }

  const { from, to, year, month, periodLabel } = await getDateRange();
  const pad = n => String(n).padStart(2,'0');
  console.log(`Period: ${from} → ${to} (${periodLabel})`);

  const nowForKey = new Date();
  const centralOffsetForKey = isCDT(nowForKey) ? -5 : -6;
  const centralDateForKey = new Date(nowForKey.getTime() + centralOffsetForKey * 3600000);
  const sentPeriodKey = `${centralDateForKey.getUTCFullYear()}-${String(centralDateForKey.getUTCMonth()+1).padStart(2,'0')}`;

  // Log entry — will update as we go
  const logEntry = {
    id:          `rpt-${Date.now()}`,
    runAt:       runTime,
    period:      periodLabel,
    dateFrom:    from,
    dateTo:      to,
    source:      FORCE_SEND || MONTH_OVERRIDE ? 'manual' : 'scheduled',
    sentPeriodKey,
    status:      'running',
    rowCount:    0,
    b2bOrders:   0,
    invoices:    0,
    recipients:  [],
    error:       null,
  };

  try {
    // 1. Packiyo orders
    console.log('\n[1/5] Fetching B2B orders...');
    const { allData: orders, allIncluded: included } = await packiyoFetchAll(
      `/orders?include=order_items,shipping_contact_information,order_channel&filter[fulfilled]=true&filter[fulfilled_at_min]=${from}&filter[fulfilled_at_max]=${to}`
    );
    const contactById = {}, itemsArr = [];
    included.forEach(inc => {
      if (inc.type === 'contact-informations') contactById[inc.id] = inc.attributes;
      if (inc.type === 'order-items') itemsArr.push(inc);
    });
    const b2bOrders = orders.filter(o => o.relationships?.order_channel?.data?.id === B2B_CHANNEL_ID);
    console.log(`  B2B: ${b2bOrders.length} of ${orders.length}`);
    b2bOrders.forEach(order => {
      const refs = (order.relationships?.order_items?.data||[]).map(r=>r.id);
      const cRef = order.relationships?.shipping_contact_information?.data?.id;
      order._contact = cRef ? contactById[cRef] : null;
      order._items   = itemsArr.filter(i => refs.includes(i.id));
    });

    // 2. Build catalog from orchardData + Packiyo products
    console.log('\n[2/5] Building catalog...');
    const catBySku = {}, catByUpc = {};

    // Load orchardData (LUM, Secretly, etc — has artist/format)
    try {
      const d = await gistFetch(CAT_GIST_FILE);
      const raw = d?.orchardData || [];
      raw.forEach(p => {
        const item = { upc: p.u||'', catalog: p.pc||'', title: p.rn||'', artist: p.an||'', format: p.cf||'' };
        if (item.catalog) {
          catBySku[item.catalog.toLowerCase()] = item;
          // Also index without hyphens for FP catalog matching (FP16021 → FP1602-1)
          catBySku[item.catalog.replace(/-/g,'').toLowerCase()] = item;
        }
        if (item.upc) {
          catByUpc[item.upc] = item;
          // Also index without leading zeros since app.js strips them
          catByUpc[item.upc.replace(/^0+/,'')] = item;
        }
      });
      console.log(`  orchardData: ${raw.length}`);
    } catch(e) { console.warn('  orchardData error:', e.message); }

    // Fetch Packiyo products (FP catalog numbers with UPC + name)
    try {
      const { allData: pkProducts } = await packiyoFetchAll('/products');
      pkProducts.forEach(p => {
        const a = p.attributes || {};
        const sku = (a.sku||'').toLowerCase();
        const skuNoHyphen = sku.replace(/-/g,'');
        const upc = a.barcode || '';
        const name = a.name || '';
        // Check if orchardData already has this via unhyphenated key or UPC
        const orchardMatch = catBySku[skuNoHyphen] || catByUpc[upc] || catByUpc[upc.replace(/^0+/,'')] || null;
        const format = orchardMatch?.format || '';
        const artist = orchardMatch?.artist || '';
        const title  = orchardMatch?.title  || name;
        const entry  = { upc: upc||orchardMatch?.upc||'', catalog: a.sku||'', title, artist, format };
        // Add under hyphenated key (what Packiyo uses) — always add/overwrite with enriched data
        if (sku) catBySku[sku] = entry;
        if (upc && !catByUpc[upc]) catByUpc[upc] = entry;
        if (upc) catByUpc[upc.replace(/^0+/,'')] = entry;
        // Update UPC on orchardData unhyphenated entry if missing
        if (skuNoHyphen && catBySku[skuNoHyphen] && !catBySku[skuNoHyphen].upc && upc) catBySku[skuNoHyphen].upc = upc;
      });
      console.log(`  Packiyo products: ${pkProducts.length}`);
    } catch(e) { console.warn('  Packiyo products error:', e.message); }

    // Load artist data from fp_config.json (shopifyVendors + manualArtists keyed by UPC)
    let shopifyVendors = {}, manualArtists = {};
    try {
      const cfg = await gistFetch('fp_config.json');
      shopifyVendors = cfg?.shopifyVendors || {};
      manualArtists  = cfg?.manualArtists  || {};
      console.log(`  shopifyVendors: ${Object.keys(shopifyVendors).length}, manualArtists: ${Object.keys(manualArtists).length}`);
    } catch(e) { console.warn('  config load error:', e.message); }

    // Apply artist enrichment — same logic as app.js applyShopifyVendors()
    Object.values(catBySku).forEach(p => {
      if (p.artist) return;
      if (manualArtists[p.upc])  { p.artist = manualArtists[p.upc];  return; }
      if (shopifyVendors[p.upc]) { p.artist = shopifyVendors[p.upc]; return; }
      const bySku = shopifyVendors['sku:' + p.catalog];
      if (bySku) p.artist = bySku;
    });
    // Also apply to UPC map
    Object.values(catByUpc).forEach(p => {
      if (p.artist) return;
      if (manualArtists[p.upc])  { p.artist = manualArtists[p.upc];  return; }
      if (shopifyVendors[p.upc]) { p.artist = shopifyVendors[p.upc]; return; }
    });

    console.log(`  Lookup: ${Object.keys(catBySku).length} by SKU, ${Object.keys(catByUpc).length} by UPC`);

    // 3. Invoices
    console.log('\n[3/5] Fetching invoices...');
    let invData = { invoices: [] };
    try { invData = await gistFetch(INV_GIST_FILE); } catch(e) {}
    const optedIn = (invData.invoices||[]).filter(inv => inv.includeInReports && inv.status !== 'draft');
    console.log(`  ${optedIn.length} opted-in invoices`);

    // 4. Build rows
    console.log('\n[4/5] Building rows...');
    const HEADERS = ['Customer Name','Customer Company','Country Code','Sale Year','Sale Month','Product Type','Artist Name','Album Title','UPC','Catalog Number','Net Units','Net Revenue'];
    const dataRows = [];

    b2bOrders.forEach(order => {
      const d = new Date(order.attributes.fulfilled_at||order.attributes.ordered_at||'');
      const rowYear = String(d.getFullYear()).slice(-2);
      const rowMonth = pad(d.getMonth()+1);
      const contact = order._contact||{};
      const customer = contact.company_name||contact.name||'';
      (order._items||[]).forEach(item => {
        const a = item.attributes;
        const sku = a.sku||'';
        const netUnits = parseInt(a.quantity_shipped||0);
        if (netUnits <= 0) return;
        const upcStripped = (a.barcode||'').replace(/^0+/,'');
        const cat = catBySku[sku.toLowerCase()]
          || catBySku[sku.replace(/-/g,'').toLowerCase()]
          || catByUpc[a.barcode||'']
          || catByUpc[upcStripped]
          || null;
        if (!cat) console.log(`  NO MATCH: sku=${sku} barcode=${a.barcode}`);
        else if (!cat.format) console.log(`  NO FORMAT: sku=${sku} cat.catalog=${cat.catalog} cat.format=${cat.format}`);
        dataRows.push([
          customer, contact.company_name||'', contact.country||'',
          rowYear, rowMonth,
          cat?.format||'', cat?.artist||'', cat?.title||a.name||sku,
          padUPC(cat?.upc||a.barcode||''), cat?.catalog||sku,
          netUnits, (netUnits*parseFloat(a.price||0)).toFixed(2)
        ]);
      });
    });

    optedIn.forEach(inv => {
      const d = new Date(inv.sentAt||inv.createdAt);
      const rowYear = String(d.getFullYear()).slice(-2);
      const rowMonth = pad(d.getMonth()+1);
      const customer = inv.billTo?.company||inv.billTo?.name||'';
      (inv.items||[]).forEach(item => {
        const netUnits = item.qty||0;
        if (netUnits <= 0) return;
        dataRows.push([customer, inv.billTo?.company||'', inv.billTo?.country||'US', rowYear, rowMonth, item.format||'', item.artist||'', item.title||'', padUPC(item.upc||''), item.catalog||'', netUnits, (netUnits*parseFloat(item.price||0)).toFixed(2)]);
      });
    });
    console.log(`  Total rows: ${dataRows.length}`);

    // 5. Write to Google Sheets
    console.log('\n[5/5] Writing to Google Sheets...');
    const token = await getGoogleToken();

    // Data tab — named by period (e.g. "Apr 2026")
    const sheetName = periodLabel;
    await ensureSheet(token, sheetName);
    await clearAndWriteSheet(token, sheetName, [HEADERS, ...dataRows]);
    console.log(`  Written ${dataRows.length} rows to "${sheetName}" tab`);

    // Log tab
    await ensureSheet(token, 'Log');
    const logRow = [
      new Date(runTime).toLocaleString('en-US',{timeZone:'America/Chicago'}),
      periodLabel, from, to,
      FORCE_SEND||MONTH_OVERRIDE?'Manual':'Scheduled',
      'sent', dataRows.length, b2bOrders.length, optedIn.length, ''
    ];
    // Write log header if sheet is empty
    const logMeta = await sheetsRequest(token, 'GET', `/values/Log!A1:J1`);
    if (!logMeta.values?.length) {
      await appendRows(token, 'Log', [['Run At','Period','From','To','Source','Status','Rows','B2B Orders','Invoices','Error']]);
    }
    await appendRows(token, 'Log', [logRow]);
    console.log(`  Log entry written`);

    // Update log entry
    logEntry.status   = 'sent';
    logEntry.rowCount = dataRows.length;
    logEntry.b2bOrders = b2bOrders.length;
    logEntry.invoices = optedIn.length;

    // Get recipients
    let recipients = (REPORT_TO||'').split(',').map(e=>e.trim()).filter(Boolean);
    try {
      const s = await gistFetch(SCHED_GIST_FILE);
      if (s?.emails) { const sr = s.emails.split(',').map(e=>e.trim()).filter(Boolean); if (sr.length) recipients = sr; }
    } catch(e) {
      console.warn(`  Schedule fetch failed (recipients): ${e.message}`);
    }
    logEntry.recipients = recipients;

    // Email CSV if recipients configured
    if (recipients.length && RESEND_API_KEY) {
      const csv = [HEADERS.join(','), ...dataRows.map(row => row.map((v,i) => {
        const s = String(v||'');
        if (i===8 && s) return `="${s}"`;
        return /,|"|\n/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
      }).join(','))].join('\n');

      const monthName = new Date(year,month-1,1).toLocaleString('en-US',{month:'long'});
      const filename  = `fp-sales-report-${year}-${pad(month)}.csv`;
      console.log(`\nEmailing to: ${recipients.join(', ')}`);

      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization':`Bearer ${RESEND_API_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          from:    'Fat Possum Reports <reports@fatpossum.com>',
          to:      recipients,
          subject: `Fat Possum B2B Sales Report — ${from} to ${to}`,
          html:    `<p>Please find attached the Fat Possum sales report for <strong>${periodLabel}</strong>.</p><ul><li><strong>${dataRows.length}</strong> line items</li><li><strong>${b2bOrders.length}</strong> B2B orders</li><li><strong>${optedIn.length}</strong> app invoices</li></ul><p>Also available in Google Sheets: <a href="https://docs.google.com/spreadsheets/d/${SHEETS_ID}">FP B2B Sales Reports</a></p><p>Fat Possum Records</p>`,
          attachments: [{ filename, content: Buffer.from(csv).toString('base64') }],
        }),
      });
      if (!emailRes.ok) { const t = await emailRes.text(); throw new Error(`Resend ${emailRes.status}: ${t.slice(0,100)}`); }
      const ed = await emailRes.json();
      console.log(`✅ Emailed! ID: ${ed.id}`);
    }

    // Save log to Gist
    try {
      let log = await gistFetch(LOG_GIST_FILE) || { runs: [] };
      if (!log.runs) log.runs = [];
      log.runs.unshift(logEntry);
      if (log.runs.length > 100) log.runs = log.runs.slice(0, 100);
      await gistWrite(LOG_GIST_FILE, log);
    } catch(e) { console.warn('Log save failed:', e.message); }

    console.log(`\n✅ Done! ${dataRows.length} rows, period: ${periodLabel}`);

  } catch(e) {
    console.error('\n❌ Failed:', e.message);
    logEntry.status = 'failed';
    logEntry.error  = e.message;
    try {
      // Write failure to Sheets log
      const token = await getGoogleToken().catch(() => null);
      if (token) {
        await ensureSheet(token, 'Log');
        await appendRows(token, 'Log', [[
          new Date(runTime).toLocaleString('en-US',{timeZone:'America/Chicago'}),
          periodLabel||'', from||'', to||'', 'Scheduled', 'failed', 0, 0, 0, e.message
        ]]);
      }
      let log = await gistFetch(LOG_GIST_FILE).catch(() => ({ runs: [] })) || { runs: [] };
      if (!log.runs) log.runs = [];
      log.runs.unshift(logEntry);
      await gistWrite(LOG_GIST_FILE, log);
    } catch(le) { console.warn('Could not save failure log:', le.message); }
    process.exit(1);
  }
}

main();
