#!/usr/bin/env node
/* ============================================================
   FAT POSSUM -- MONTHLY SALES REPORT SCRIPT
   scripts/generate-report.js
   Runs via GitHub Actions on the 1st of each month
   Pulls Packiyo B2B orders + opted-in app invoices
   Generates CSV and emails via Resend
   ============================================================ */

const fetch = require('node-fetch');

const PACKIYO_BASE   = 'https://fatpossum.app.packiyo.com/api/v1';
const PACKIYO_TOKEN  = process.env.PACKIYO_TOKEN;
const GIST_ID        = process.env.GIST_ID;
const GIST_TOKEN     = process.env.GIST_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const REPORT_TO      = process.env.REPORT_TO; // comma-separated emails
const MONTH_OVERRIDE = process.env.MONTH_OVERRIDE || '';

const B2B_CHANNEL_ID = '7';
const INV_GIST_FILE  = 'fp_invoices.json';
const CAT_GIST_FILE  = 'fp_data.json';

// ── DATE RANGE ─────────────────────────────────────────────────
function getDateRange() {
  let year, month;
  if (MONTH_OVERRIDE && /^\d{4}-\d{2}$/.test(MONTH_OVERRIDE)) {
    [year, month] = MONTH_OVERRIDE.split('-').map(Number);
  } else {
    // Default: last month
    const now = new Date();
    const last = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    year  = last.getFullYear();
    month = last.getMonth() + 1;
  }
  const pad  = n => String(n).padStart(2, '0');
  const from = `${year}-${pad(month)}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const to   = `${year}-${pad(month)}-${lastDay}`;
  return { from, to, year, month };
}

// ── PACKIYO FETCH ───────────────────────────────────────────────
async function packiyoFetch(path) {
  const res = await fetch(PACKIYO_BASE + path, {
    headers: {
      'Authorization': `Bearer ${PACKIYO_TOKEN}`,
      'Content-Type':  'application/vnd.api+json',
      'Accept':        'application/vnd.api+json',
    }
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Packiyo ${res.status}: ${t.slice(0, 200)}`);
  }
  return res.json();
}

async function packiyoFetchAll(path, pageSize = 100) {
  const allData = [], allIncluded = [];
  let page = 1;
  while (true) {
    const sep  = path.includes('?') ? '&' : '?';
    const data = await packiyoFetch(`${path}${sep}page[number]=${page}&page[size]=${pageSize}`);
    allData.push(...(data.data || []));
    allIncluded.push(...(data.included || []));
    const meta    = data.meta?.page || data.meta || {};
    const lastPage = parseInt(meta.lastPage || meta.last_page || meta.total_pages || 1) || 1;
    console.log(`  Page ${page}/${lastPage} (${allData.length} orders so far)`);
    if (page >= lastPage) break;
    page++;
  }
  return { allData, allIncluded };
}

// ── GIST FETCH ──────────────────────────────────────────────────
async function gistFetch(filename) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { 'Authorization': `token ${GIST_TOKEN}` }
  });
  if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);
  const gist = await res.json();
  const file = gist.files && gist.files[filename];
  if (!file || !file.content) throw new Error(`File ${filename} not found in Gist`);
  return JSON.parse(file.content);
}

// ── MAIN ────────────────────────────────────────────────────────
async function main() {
  const { from, to, year, month } = getDateRange();
  const pad = n => String(n).padStart(2, '0');
  const monthStr = pad(month);
  const yearStr  = String(year).slice(-2);

  console.log(`\n=== Fat Possum Monthly Sales Report ===`);
  console.log(`Period: ${from} → ${to}`);

  // 1. Fetch B2B orders from Packiyo
  console.log('\n[1/4] Fetching B2B orders from Packiyo...');
  const { allData: orders, allIncluded: included } = await packiyoFetchAll(
    `/orders?include=order_items,shipping_contact_information,order_channel&filter[fulfilled]=true&filter[fulfilled_at_min]=${from}&filter[fulfilled_at_max]=${to}`
  );
  console.log(`  Total orders fetched: ${orders.length}`);

  // Build lookup maps
  const contactById = {};
  const itemsArr    = [];
  included.forEach(inc => {
    if (inc.type === 'contact-informations') contactById[inc.id] = inc.attributes;
    if (inc.type === 'order-items')          itemsArr.push(inc);
  });

  // Filter to B2B channel only
  const b2bOrders = orders.filter(o => {
    const chId = o.relationships?.order_channel?.data?.id;
    return chId === B2B_CHANNEL_ID;
  });
  console.log(`  B2B orders: ${b2bOrders.length}`);

  // Tag items with order
  b2bOrders.forEach(order => {
    const refs = (order.relationships?.order_items?.data || []).map(r => r.id);
    const contactRef = order.relationships?.shipping_contact_information?.data?.id;
    order._contact = contactRef ? contactById[contactRef] : null;
    order._items   = itemsArr.filter(i => refs.includes(i.id));
  });

  // 2. Fetch catalog from Gist for enrichment
  console.log('\n[2/4] Fetching catalog from Gist...');
  let catalog = [];
  try {
    const catData = await gistFetch(CAT_GIST_FILE);
    catalog = catData.merged || catData.products || catData || [];
    console.log(`  Catalog size: ${catalog.length} products`);
  } catch(e) {
    console.warn(`  Warning: could not load catalog (${e.message}) - SKU enrichment will be limited`);
  }

  const catalogBySku = {};
  const catalogByUpc = {};
  catalog.forEach(p => {
    if (p.catalog) catalogBySku[p.catalog.toLowerCase()] = p;
    if (p.upc)     catalogByUpc[p.upc] = p;
  });

  // 3. Fetch invoices from Gist
  console.log('\n[3/4] Fetching invoices from Gist...');
  let invData = { invoices: [] };
  try {
    invData = await gistFetch(INV_GIST_FILE);
    console.log(`  Invoices: ${invData.invoices?.length || 0}`);
  } catch(e) {
    console.warn(`  Warning: could not load invoices (${e.message})`);
  }

  // 4. Build report rows
  console.log('\n[4/4] Building report rows...');
  const rows = [];

  // Packiyo B2B rows
  b2bOrders.forEach(order => {
    const fulfilledAt = order.attributes.fulfilled_at || order.attributes.ordered_at || '';
    const d = new Date(fulfilledAt);
    const rowYear     = String(d.getFullYear()).slice(-2);
    const rowMonth    = pad(d.getMonth() + 1);
    const contact     = order._contact || {};
    const customerDisplay = contact.company_name || contact.name || '';
    const company         = contact.company_name || '';
    const countryCode     = contact.country || '';

    (order._items || []).forEach(item => {
      const a        = item.attributes;
      const sku      = a.sku || '';
      const netUnits = parseInt(a.quantity_shipped || 0);
      if (netUnits <= 0) return;

      const cat     = catalogBySku[sku.toLowerCase()] || catalogBySku[sku] || catalogByUpc[a.barcode || ''] || null;
      const artist  = cat?.artist  || '';
      const title   = cat?.title   || a.name || sku;
      const upc     = cat?.upc     || '';
      const catNum  = cat?.catalog || sku;
      const format  = cat?.format  || '';
      const netRev  = (netUnits * parseFloat(a.price || 0)).toFixed(2);

      rows.push([customerDisplay, company, countryCode, rowYear, rowMonth, format, artist, title, upc, catNum, netUnits, netRev]);
    });
  });

  // App invoice rows (opted-in only)
  const invoices = invData.invoices || [];
  const optedIn  = invoices.filter(inv => inv.includeInReports && inv.status !== 'draft');
  console.log(`  Opted-in app invoices: ${optedIn.length}`);

  optedIn.forEach(inv => {
    const d         = new Date(inv.sentAt || inv.createdAt);
    const rowYear   = String(d.getFullYear()).slice(-2);
    const rowMonth  = pad(d.getMonth() + 1);
    const customer  = inv.billTo?.company || inv.billTo?.name || '';
    const company   = inv.billTo?.company || '';
    const country   = inv.billTo?.country || 'US';

    (inv.items || []).forEach(item => {
      const netUnits = item.qty || 0;
      if (netUnits <= 0) return;
      const netRev   = (netUnits * parseFloat(item.price || 0)).toFixed(2);
      rows.push([customer, company, country, rowYear, rowMonth, item.format || '', item.artist || '', item.title || '', item.upc || '', item.catalog || '', netUnits, netRev]);
    });
  });

  console.log(`  Total rows: ${rows.length}`);

  if (!rows.length) {
    console.log('\nNo rows to report — skipping email.');
    return;
  }

  // Build CSV
  const headers = ['Customer Name','Customer Company','Country Code','Sale Year','Sale Month','Product Type','Artist Name','Album Title','UPC','Catalog Number','Net Units','Net Revenue'];
  const csvLines = [headers.join(',')];
  rows.forEach(row => {
    csvLines.push(row.map((v, i) => {
      const s = String(v || '');
      // UPC column (index 8) — preserve as string with leading zeros
      if (i === 8 && s) return `="${s}"`;
      return /,|"|\n/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  });
  const csv = csvLines.join('\n');

  // Email via Resend
  const recipients = (REPORT_TO || '').split(',').map(e => e.trim()).filter(Boolean);
  if (!recipients.length) {
    console.log('\nNo recipients configured — saving CSV locally only.');
    const fs = require('fs');
    const filename = `fp-sales-report-${year}-${monthStr}.csv`;
    fs.writeFileSync(filename, csv);
    console.log(`CSV saved to ${filename}`);
    return;
  }

  console.log(`\nSending report to: ${recipients.join(', ')}`);
  const monthName = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long' });
  const filename  = `fp-sales-report-${year}-${monthStr}.csv`;
  const csvBase64 = Buffer.from(csv).toString('base64');

  const emailRes = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${RESEND_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      from:    'Fat Possum Reports <reports@fatpossum.com>',
      to:      recipients,
      subject: `Fat Possum Sales Report — ${monthName} ${year}`,
      html:    `
        <p>Hi,</p>
        <p>Please find attached the Fat Possum sales report for <strong>${monthName} ${year}</strong>.</p>
        <ul>
          <li><strong>${rows.length}</strong> line items</li>
          <li><strong>${b2bOrders.filter(o => (o._items||[]).some(i => parseInt(i.attributes.quantity_shipped||0) > 0)).length}</strong> B2B orders</li>
          <li><strong>${optedIn.length}</strong> app invoices included</li>
        </ul>
        <p>This report was generated automatically on ${new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}.</p>
        <p>Fat Possum Records</p>
      `,
      attachments: [{
        filename: filename,
        content:  csvBase64,
      }],
    }),
  });

  if (!emailRes.ok) {
    const t = await emailRes.text();
    throw new Error(`Resend error ${emailRes.status}: ${t.slice(0, 200)}`);
  }

  const emailData = await emailRes.json();
  console.log(`\n✅ Report emailed successfully! (ID: ${emailData.id})`);
  console.log(`   File: ${filename}`);
  console.log(`   Rows: ${rows.length}`);
}

main().catch(e => {
  console.error('\n❌ Report failed:', e.message);
  process.exit(1);
});
