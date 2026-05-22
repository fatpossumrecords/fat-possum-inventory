#!/usr/bin/env node
/* ============================================================
   FAT POSSUM -- SALES REPORT SCRIPT
   scripts/generate-report.js
   Runs daily via GitHub Actions, emails on configured schedule
   ============================================================ */

const fetch = require('node-fetch');

const PACKIYO_BASE   = 'https://fatpossum.app.packiyo.com/api/v1';
const PACKIYO_TOKEN  = process.env.PACKIYO_TOKEN;
const GIST_ID        = process.env.GIST_ID;
const GIST_TOKEN     = process.env.GIST_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REPORT_TO      = process.env.REPORT_TO;
const MONTH_OVERRIDE = process.env.MONTH_OVERRIDE || '';
const FORCE_SEND     = process.env.FORCE_SEND === 'true';

const B2B_CHANNEL_ID   = '7';
const INV_GIST_FILE    = 'fp_invoices.json';
const CAT_GIST_FILE    = 'fp_data.json';
const SCHED_GIST_FILE  = 'fp_report_schedule.json';

// ── GIST FETCH ──────────────────────────────────────────────────
async function gistFetch(filename) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { 'Authorization': `token ${GIST_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);
  const gist = await res.json();
  const file = gist.files && gist.files[filename];
  if (!file || !file.content) return null;
  return JSON.parse(file.content);
}

// ── SCHEDULE CHECK ──────────────────────────────────────────────
async function shouldRun() {
  if (FORCE_SEND) { console.log('Force send enabled — skipping schedule check'); return true; }
  if (MONTH_OVERRIDE) { console.log('Month override set — running'); return true; }

  let schedule = null;
  try { schedule = await gistFetch(SCHED_GIST_FILE); } catch(e) {}

  if (!schedule || !schedule.day) {
    console.log('No schedule configured — defaulting to 1st of month');
    schedule = { day: 1, hour: 8, period: 'last_month' };
  }

  const now       = new Date();
  const todayDay  = now.getUTCDate();
  // Convert UTC hour to Central (UTC-5 CST / UTC-6 CDT)
  // Use UTC-6 as safe default (CDT)
  const centralHour = (now.getUTCHours() + 18) % 24; // UTC-6
  const scheduledDay  = parseInt(schedule.day)  || 1;
  const scheduledHour = parseInt(schedule.hour) || 8;

  console.log(`Today: day ${todayDay}, hour ~${centralHour} Central`);
  console.log(`Scheduled: day ${scheduledDay}, hour ${scheduledHour} Central`);

  if (todayDay !== scheduledDay) {
    console.log(`Not scheduled day (${scheduledDay}) — skipping`);
    return false;
  }
  return true;
}

// ── DATE RANGE ─────────────────────────────────────────────────
async function getDateRange() {
  let period = 'last_month';
  try {
    const schedule = await gistFetch(SCHED_GIST_FILE);
    if (schedule?.period) period = schedule.period;
  } catch(e) {}

  if (MONTH_OVERRIDE && /^\d{4}-\d{2}$/.test(MONTH_OVERRIDE)) {
    const [year, month] = MONTH_OVERRIDE.split('-').map(Number);
    const pad = n => String(n).padStart(2, '0');
    return { from: `${year}-${pad(month)}-01`, to: `${year}-${pad(month)}-${new Date(year, month, 0).getDate()}`, year, month };
  }

  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  let from, to, year, month;

  if (period === 'week_to_date') {
    const startOfWeek = new Date(now); startOfWeek.setDate(now.getDate() - now.getDay());
    from = startOfWeek.toISOString().slice(0,10); to = now.toISOString().slice(0,10);
  } else if (period === 'last_week') {
    const startOfLastWeek = new Date(now); startOfLastWeek.setDate(now.getDate() - now.getDay() - 7);
    const endOfLastWeek   = new Date(startOfLastWeek); endOfLastWeek.setDate(startOfLastWeek.getDate() + 6);
    from = startOfLastWeek.toISOString().slice(0,10); to = endOfLastWeek.toISOString().slice(0,10);
  } else if (period === 'last_two_weeks') {
    const twoWeeksAgo = new Date(now); twoWeeksAgo.setDate(now.getDate() - 14);
    from = twoWeeksAgo.toISOString().slice(0,10); to = now.toISOString().slice(0,10);
  } else if (period === 'this_month') {
    from = `${now.getFullYear()}-${pad(now.getMonth()+1)}-01`; to = now.toISOString().slice(0,10);
  } else if (period === 'two_months_ago') {
    const tma = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    year = tma.getFullYear(); month = tma.getMonth() + 1;
    from = `${year}-${pad(month)}-01`; to = `${year}-${pad(month)}-${new Date(year, month, 0).getDate()}`;
  } else if (period === 'this_quarter') {
    const q = Math.floor(now.getMonth() / 3);
    from = `${now.getFullYear()}-${pad(q*3+1)}-01`; to = now.toISOString().slice(0,10);
  } else if (period === 'last_quarter') {
    const q = Math.floor(now.getMonth() / 3);
    const qStart = q === 0 ? new Date(now.getFullYear()-1, 9, 1) : new Date(now.getFullYear(), (q-1)*3, 1);
    const qEnd   = new Date(qStart.getFullYear(), qStart.getMonth()+3, 0);
    from = qStart.toISOString().slice(0,10); to = qEnd.toISOString().slice(0,10);
  } else if (period === 'year_to_date') {
    from = `${now.getFullYear()}-01-01`; to = now.toISOString().slice(0,10);
  } else if (period === 'last_year') {
    const ly = now.getFullYear() - 1;
    from = `${ly}-01-01`; to = `${ly}-12-31`;
  } else {
    // Default: last month
    const last = new Date(now.getFullYear(), now.getMonth()-1, 1);
    year = last.getFullYear(); month = last.getMonth()+1;
    from = `${year}-${pad(month)}-01`; to = `${year}-${pad(month)}-${new Date(year, month, 0).getDate()}`;
  }

  if (!year) year = new Date(from).getFullYear();
  if (!month) month = new Date(from).getMonth() + 1;
  return { from, to, year, month };
}

// ── PACKIYO FETCH ───────────────────────────────────────────────
async function packiyoFetch(path) {
  const res = await fetch(PACKIYO_BASE + path, {
    headers: { 'Authorization': `Bearer ${PACKIYO_TOKEN}`, 'Content-Type': 'application/vnd.api+json', 'Accept': 'application/vnd.api+json' }
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
    allData.push(...(data.data || []));
    allIncluded.push(...(data.included || []));
    const meta = data.meta?.page || data.meta || {};
    const lastPage = parseInt(meta.lastPage || meta.last_page || meta.total_pages || 1) || 1;
    console.log(`  Page ${page}/${lastPage}`);
    if (page >= lastPage) break;
    page++;
  }
  return { allData, allIncluded };
}

// ── MAIN ────────────────────────────────────────────────────────
async function main() {
  console.log('\n=== Fat Possum Sales Report ===');

  const run = await shouldRun();
  if (!run) { console.log('Nothing to do today.'); return; }

  const { from, to, year, month } = await getDateRange();
  const pad = n => String(n).padStart(2, '0');
  console.log(`Period: ${from} → ${to}`);

  // Fetch B2B orders
  console.log('\n[1/4] Fetching B2B orders from Packiyo...');
  const { allData: orders, allIncluded: included } = await packiyoFetchAll(
    `/orders?include=order_items,shipping_contact_information,order_channel&filter[fulfilled]=true&filter[fulfilled_at_min]=${from}&filter[fulfilled_at_max]=${to}`
  );

  const contactById = {}, itemsArr = [];
  included.forEach(inc => {
    if (inc.type === 'contact-informations') contactById[inc.id] = inc.attributes;
    if (inc.type === 'order-items')          itemsArr.push(inc);
  });

  const b2bOrders = orders.filter(o => o.relationships?.order_channel?.data?.id === B2B_CHANNEL_ID);
  console.log(`  B2B orders: ${b2bOrders.length} of ${orders.length} total`);

  b2bOrders.forEach(order => {
    const refs = (order.relationships?.order_items?.data || []).map(r => r.id);
    const contactRef = order.relationships?.shipping_contact_information?.data?.id;
    order._contact = contactRef ? contactById[contactRef] : null;
    order._items   = itemsArr.filter(i => refs.includes(i.id));
  });

  // Fetch catalog
  console.log('\n[2/4] Fetching catalog...');
  let catalog = [];
  try {
    const catData = await gistFetch(CAT_GIST_FILE);
    catalog = catData?.merged || catData?.products || [];
    console.log(`  ${catalog.length} products`);
  } catch(e) { console.warn(`  Warning: ${e.message}`); }

  const catalogBySku = {}, catalogByUpc = {};
  catalog.forEach(p => {
    if (p.catalog) catalogBySku[p.catalog.toLowerCase()] = p;
    if (p.upc)     catalogByUpc[p.upc] = p;
  });

  // Fetch invoices
  console.log('\n[3/4] Fetching invoices...');
  let invData = { invoices: [] };
  try {
    invData = await gistFetch(INV_GIST_FILE);
    console.log(`  ${invData?.invoices?.length || 0} invoices`);
  } catch(e) { console.warn(`  Warning: ${e.message}`); }

  // Build rows
  console.log('\n[4/4] Building report rows...');
  const rows = [];

  b2bOrders.forEach(order => {
    const d = new Date(order.attributes.fulfilled_at || order.attributes.ordered_at || '');
    const rowYear = String(d.getFullYear()).slice(-2);
    const rowMonth = pad(d.getMonth() + 1);
    const contact = order._contact || {};
    const customerDisplay = contact.company_name || contact.name || '';

    (order._items || []).forEach(item => {
      const a = item.attributes;
      const sku = a.sku || '';
      const netUnits = parseInt(a.quantity_shipped || 0);
      if (netUnits <= 0) return;
      const cat = catalogBySku[sku.toLowerCase()] || catalogBySku[sku] || null;
      rows.push([
        customerDisplay, contact.company_name || '', contact.country || '',
        rowYear, rowMonth,
        cat?.format || '', cat?.artist || '', cat?.title || a.name || sku,
        cat?.upc || '', cat?.catalog || sku,
        netUnits, (netUnits * parseFloat(a.price || 0)).toFixed(2)
      ]);
    });
  });

  const optedIn = (invData.invoices || []).filter(inv => inv.includeInReports && inv.status !== 'draft');
  console.log(`  Opted-in invoices: ${optedIn.length}`);
  optedIn.forEach(inv => {
    const d = new Date(inv.sentAt || inv.createdAt);
    const rowYear = String(d.getFullYear()).slice(-2);
    const rowMonth = pad(d.getMonth() + 1);
    const customer = inv.billTo?.company || inv.billTo?.name || '';
    (inv.items || []).forEach(item => {
      const netUnits = item.qty || 0;
      if (netUnits <= 0) return;
      rows.push([customer, inv.billTo?.company || '', inv.billTo?.country || 'US', rowYear, rowMonth, item.format || '', item.artist || '', item.title || '', item.upc || '', item.catalog || '', netUnits, (netUnits * parseFloat(item.price || 0)).toFixed(2)]);
    });
  });

  console.log(`  Total rows: ${rows.length}`);
  if (!rows.length) { console.log('No data — skipping email.'); return; }

  // Build CSV
  const headers = ['Customer Name','Customer Company','Country Code','Sale Year','Sale Month','Product Type','Artist Name','Album Title','UPC','Catalog Number','Net Units','Net Revenue'];
  const csv = [headers.join(','), ...rows.map(row => row.map((v, i) => {
    const s = String(v || '');
    if (i === 8 && s) return `="${s}"`;
    return /,|"|\n/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(','))].join('\n');

  // Get recipients — from schedule config or env var
  let recipients = (REPORT_TO || '').split(',').map(e => e.trim()).filter(Boolean);
  try {
    const schedule = await gistFetch(SCHED_GIST_FILE);
    if (schedule?.emails) {
      const scheduleRecipients = schedule.emails.split(',').map(e => e.trim()).filter(Boolean);
      if (scheduleRecipients.length) recipients = scheduleRecipients;
    }
  } catch(e) {}

  if (!recipients.length) {
    console.log('No recipients — saving CSV locally.');
    require('fs').writeFileSync(`fp-sales-report-${year}-${pad(month)}.csv`, csv);
    return;
  }

  // Send email
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  const filename  = `fp-sales-report-${year}-${pad(month)}.csv`;
  console.log(`\nEmailing to: ${recipients.join(', ')}`);

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from:    'Fat Possum Reports <reports@fatpossum.com>',
      to:      recipients,
      subject: `Fat Possum Sales Report — ${monthName} ${year}`,
      html:    `<p>Please find attached the Fat Possum sales report for <strong>${monthName} ${year}</strong>.</p><ul><li><strong>${rows.length}</strong> line items</li><li><strong>${b2bOrders.length}</strong> B2B orders</li><li><strong>${optedIn.length}</strong> app invoices included</li></ul><p>Fat Possum Records</p>`,
      attachments: [{ filename, content: Buffer.from(csv).toString('base64') }],
    }),
  });

  if (!emailRes.ok) { const t = await emailRes.text(); throw new Error(`Resend ${emailRes.status}: ${t.slice(0,200)}`); }
  const emailData = await emailRes.json();
  console.log(`\n✅ Report sent! (ID: ${emailData.id})`);
  console.log(`   ${rows.length} rows, ${filename}`);
}

main().catch(e => { console.error('\n❌ Failed:', e.message); process.exit(1); });
