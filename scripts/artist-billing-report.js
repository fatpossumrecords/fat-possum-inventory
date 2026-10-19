#!/usr/bin/env node
/* ============================================================
   FAT POSSUM -- BILL TO ARTIST REPORT
   scripts/artist-billing-report.js
   Runs on the 1st of each month via GitHub Actions.
   Emails last month's shipments for invoices marked "Bill to
   Artist" in the app. Ship date + tracking come from Packiyo;
   the actual label cost comes from EasyPost, matched by
   reference or tracking number. A materials fee is folded into
   each shipment's price.
   ============================================================ */

const fetch = require('node-fetch');

const PACKIYO_BASE     = 'https://fatpossum.app.packiyo.com/api/v1';
const EASYPOST_BASE    = 'https://api.easypost.com/v2';
const PACKIYO_TOKEN    = process.env.PACKIYO_TOKEN;
const EASYPOST_API_KEY = process.env.EASYPOST_API_KEY;
const GIST_ID          = process.env.GIST_ID;
const GIST_TOKEN       = process.env.GIST_TOKEN;
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const REPORT_TO        = process.env.ARTIST_REPORT_TO || process.env.REPORT_TO || '';
const MONTH_OVERRIDE   = process.env.MONTH_OVERRIDE || '';
const DRY_RUN          = process.env.DRY_RUN === 'true';

const INV_GIST_FILE  = 'fp_invoices.json';
const INV_PREFIX     = 'FPINV-';
const MATERIALS_FEE  = 1.50; // folded into each shipment's price, never itemized
const SCAN_PAD_DAYS  = 5;    // labels can be bought a few days before Packiyo marks the ship

// ── HELPERS ─────────────────────────────────────────────────────

function fetchWithTimeout(url, opts, ms) {
  ms = ms || 20000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const headers = Object.assign({ 'Accept-Encoding': 'identity' }, (opts && opts.headers) || {});
  return fetch(url, Object.assign({}, opts, { headers, signal: ctrl.signal }))
    .finally(() => clearTimeout(timer));
}

async function getJson(url, headers, label) {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetchWithTimeout(url, { headers });
    if (res.status === 429 || res.status >= 500) {
      console.log(`  ${label} ${res.status}, retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) throw new Error(`${label} ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }
  throw new Error(`${label} retries exhausted`);
}

const packiyoFetch = path => getJson(PACKIYO_BASE + path, {
  Authorization: `Bearer ${PACKIYO_TOKEN}`,
  Accept: 'application/vnd.api+json',
}, 'Packiyo');

const easypostFetch = path => getJson(EASYPOST_BASE + path, {
  Authorization: 'Basic ' + Buffer.from(EASYPOST_API_KEY + ':').toString('base64'),
}, 'EasyPost');

// Same truncation-safe read as ship-notify.js: fall back to raw_url when the
// combined gist response truncates this file.
async function fetchGistFile(filename) {
  const res = await fetchWithTimeout(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Gist GET failed: ${res.status}`);
  const data = await res.json();
  const file = data.files?.[filename];
  if (!file) return null;
  let content = file.content;
  if (file.truncated || content == null) {
    const rawRes = await fetchWithTimeout(file.raw_url, { headers: { Authorization: `Bearer ${GIST_TOKEN}` } });
    if (!rawRes.ok) throw new Error(`Gist raw GET failed: ${rawRes.status}`);
    content = await rawRes.text();
  }
  return content ? JSON.parse(content) : null;
}

// Every purchased EasyPost shipment created in [from, to]. EasyPost can't
// filter by reference, so pull the window once and match locally.
async function fetchEasypostShipments(from, to) {
  const all = [];
  let beforeId = '';
  for (let page = 1; page <= 200; page++) {
    const qs = `page_size=100&purchased=true&start_datetime=${from.toISOString()}&end_datetime=${to.toISOString()}` + (beforeId ? `&before_id=${beforeId}` : '');
    const data = await easypostFetch(`/shipments?${qs}`);
    const batch = data.shipments || [];
    all.push(...batch);
    if (!data.has_more || !batch.length) break;
    beforeId = batch[batch.length - 1].id;
  }
  return all;
}

// What the label actually cost: every fee EasyPost charged and didn't refund
// (postage, label fee, insurance). Falls back to the purchased rate.
function easypostCost(sh) {
  const fees = (sh.fees || []).filter(f => f.charged && !f.refunded);
  if (fees.length) return fees.reduce((s, f) => s + parseFloat(f.amount || 0), 0);
  return sh.selected_rate ? parseFloat(sh.selected_rate.rate || 0) : null;
}

// Previous calendar month in Central time, or MONTH_OVERRIDE (YYYY-MM)
function getPeriod() {
  let year, month;
  if (/^\d{4}-\d{2}$/.test(MONTH_OVERRIDE)) {
    [year, month] = MONTH_OVERRIDE.split('-').map(Number);
  } else {
    const central = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    year = central.getFullYear();
    month = central.getMonth(); // 0-based current = 1-based previous
    if (month === 0) { month = 12; year--; }
  }
  const key = `${year}-${String(month).padStart(2, '0')}`;
  const label = new Date(year, month - 1, 1).toLocaleString('en-US', { month: 'long', year: 'numeric' });
  return { key, label, year, month };
}

function centralMonthKey(iso) {
  const d = new Date(new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

const norm = s => String(s || '').trim().toLowerCase();
const money = n => '$' + Number(n || 0).toFixed(2);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const csvCell = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };

// ── MAIN ─────────────────────────────────────────────────────────

async function main() {
  const period = getPeriod();
  console.log(`\n=== FP Bill to Artist Report ${DRY_RUN ? '[DRY RUN] ' : ''}=== ${period.label}`);
  if (!EASYPOST_API_KEY) throw new Error('EASYPOST_API_KEY secret is not set');

  const invData = await fetchGistFile(INV_GIST_FILE);
  const flagged = (invData?.invoices || []).filter(inv => inv.billToArtist && inv.packiyoOrderId && inv.status !== 'draft');
  console.log(`  ${flagged.length} Bill to Artist invoices on file`);

  // 1. Ship date + tracking from Packiyo; keep only last month's
  const shipped = [];
  for (const inv of flagged) {
    const invNum = INV_PREFIX + inv.number;
    let shippedAt = inv.shippedAt || null;
    let trackings = inv.trackingNumber ? [inv.trackingNumber] : [];
    try {
      const res = await packiyoFetch(`/orders/${inv.packiyoOrderId}?include=shipments,shipments.shipment_trackings`);
      const shipments = (res.included || []).filter(i => i.type === 'shipments' && !/voided/i.test(i.attributes?.status_text || ''));
      const tr = (res.included || []).filter(i => i.type === 'shipment-trackings').map(t => t.attributes?.tracking_number).filter(Boolean);
      if (shipments.length) shippedAt = shipments[0].attributes?.created_at || shippedAt;
      if (tr.length) trackings = tr;
    } catch (e) {
      console.warn(`  ${invNum}: Packiyo lookup failed (${e.message}) — using saved app data`);
    }
    if (shippedAt && centralMonthKey(shippedAt) === period.key) shipped.push({ inv, invNum, shippedAt, trackings });
  }
  console.log(`  ${shipped.length} shipped in ${period.label}`);

  // 2. EasyPost shipments for the month (padded), indexed by reference + tracking
  const scanFrom = new Date(Date.UTC(period.year, period.month - 1, 1) - SCAN_PAD_DAYS * 86400000);
  const scanTo   = new Date(Date.UTC(period.year, period.month, 1) + SCAN_PAD_DAYS * 86400000);
  const epShipments = shipped.length ? await fetchEasypostShipments(scanFrom, scanTo) : [];
  console.log(`  ${epShipments.length} EasyPost shipments scanned (${scanFrom.toISOString().slice(0, 10)} → ${scanTo.toISOString().slice(0, 10)})`);
  const byRef = {}, byTracking = {};
  epShipments.forEach(sh => {
    if (sh.refund_status === 'refunded' || sh.refund_status === 'submitted') return; // voided label
    if (sh.reference) (byRef[norm(sh.reference)] ||= []).push(sh);
    if (sh.tracking_code) byTracking[norm(sh.tracking_code)] = sh;
  });

  // 3. Build rows
  const rows = [];
  const missing = [];
  for (const { inv, invNum, shippedAt, trackings } of shipped) {
    const refs = [inv.packiyoOrderNum, invNum, inv.poNumber, inv.packiyoOrderId].filter(Boolean).map(norm);
    const matched = new Map();
    refs.forEach(r => (byRef[r] || []).forEach(sh => matched.set(sh.id, sh)));
    trackings.forEach(t => { const sh = byTracking[norm(t)]; if (sh) matched.set(sh.id, sh); });

    const labels = [...matched.values()];
    const cost = labels.length ? Math.round(labels.reduce((s, sh) => s + (easypostCost(sh) || 0), 0) * 100) / 100 : null;
    const price = cost == null ? null : Math.round((cost + MATERIALS_FEE) * 100) / 100;
    const tracking = (labels.map(sh => sh.tracking_code).filter(Boolean).join(', ')) || trackings.join(', ');
    if (price == null) missing.push(invNum);
    console.log(`  ${invNum}: shipped ${shippedAt.slice(0, 10)} · ${labels.length} EasyPost label(s) · ${price == null ? 'NO MATCH' : money(price)}`);
    if (price == null && DRY_RUN) console.log(`    looked for reference ${refs.join(' / ')} or tracking ${trackings.join(', ') || '(none)'}`);

    // Split the shipment price across line items by qty so per-artist
    // totals add up when one box holds more than one artist.
    const shipTo = inv.shipSame ? inv.billTo : inv.shipTo;
    const items = (inv.items || []).filter(i => (i.qty || 0) > 0);
    const totalQty = items.reduce((s, i) => s + (i.qty || 0), 0) || 1;
    let allocated = 0;
    items.forEach((item, idx) => {
      let share = null;
      if (price != null) {
        share = idx === items.length - 1
          ? Math.round((price - allocated) * 100) / 100
          : Math.round(price * (item.qty / totalQty) * 100) / 100;
        allocated += share;
      }
      rows.push({
        artist: item.artist || '', title: item.title || '',
        catalog: item.catalog || item.sku || '', upc: item.upc || '', format: item.format || '',
        qty: item.qty || 0, price: share,
        recipient: shipTo?.company || shipTo?.name || '',
        tracking, invNum, shippedAt: shippedAt.slice(0, 10),
      });
    });
  }

  if (DRY_RUN && missing.length && epShipments.length) {
    console.log('\n  Sample EasyPost references in this window (to see what Packiyo sends):');
    epShipments.slice(0, 15).forEach(sh => console.log(`    ${sh.created_at?.slice(0, 10)}  ref=${sh.reference || '(none)'}  tracking=${sh.tracking_code || ''}`));
  }

  rows.sort((a, b) => a.artist.localeCompare(b.artist) || a.shippedAt.localeCompare(b.shippedAt));
  const total = rows.reduce((s, r) => s + (r.price || 0), 0);
  const byArtist = {};
  rows.forEach(r => { const a = r.artist || '(no artist)'; byArtist[a] = (byArtist[a] || 0) + (r.price || 0); });
  const shipmentCount = new Set(rows.map(r => r.invNum)).size;
  console.log(`\n  ${shipmentCount} shipments, ${rows.length} lines, total ${money(total)}`);

  // ── Build email ──
  const HEAD = ['Artist', 'Title', 'Catalog #', 'UPC', 'Format', 'Qty', 'Price of Shipment', 'Shipped To', 'Tracking #', 'Invoice #'];
  const csv = [HEAD.join(','), ...rows.map(r => [
    r.artist, r.title, r.catalog, r.upc ? `="${r.upc}"` : '', r.format, r.qty,
    r.price == null ? 'MISSING' : r.price.toFixed(2), r.recipient, r.tracking, r.invNum,
  ].map(csvCell).join(','))].join('\n');

  const th = 'padding:6px 10px;border:1px solid #ddd;text-align:left;background:#f3f3f3;';
  const td = 'padding:5px 10px;border:1px solid #eee;';
  const tableRows = rows.map(r => `<tr>
    <td style="${td}">${esc(r.artist)}</td><td style="${td}">${esc(r.title)}</td>
    <td style="${td}font-family:monospace;">${esc(r.catalog)}</td><td style="${td}font-family:monospace;">${esc(r.upc)}</td><td style="${td}">${esc(r.format)}</td>
    <td style="${td}text-align:center;">${r.qty}</td>
    <td style="${td}text-align:right;font-family:monospace;${r.price == null ? 'color:#c00;font-weight:700;' : ''}">${r.price == null ? 'MISSING' : money(r.price)}</td>
    <td style="${td}">${esc(r.recipient)}</td><td style="${td}font-family:monospace;">${esc(r.tracking)}</td><td style="${td}font-family:monospace;">${esc(r.invNum)}</td></tr>`).join('');
  const artistRows = Object.entries(byArtist).sort((a, b) => a[0].localeCompare(b[0]))
    .map(([a, t]) => `<tr><td style="${td}">${esc(a)}</td><td style="${td}text-align:right;font-family:monospace;">${money(t)}</td></tr>`).join('');

  const html = `<h2 style="font-family:sans-serif;">Fat Possum — Bill to Artist, ${esc(period.label)}</h2>
<p style="font-family:sans-serif;color:#555;"><strong>${shipmentCount}</strong> shipments · Total <strong>${money(total)}</strong></p>
${missing.length ? `<p style="font-family:sans-serif;color:#c00;"><strong>No EasyPost cost found for:</strong> ${missing.map(esc).join(', ')} — look these up in EasyPost before billing.</p>` : ''}
${rows.length ? `<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin-bottom:20px;">
<tr><th style="${th}">Artist</th><th style="${th}text-align:right;">Total</th></tr>${artistRows}</table>
<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;">
<tr>${HEAD.map(h => `<th style="${th}">${h}</th>`).join('')}</tr>${tableRows}</table>`
  : '<p style="font-family:sans-serif;">No Bill to Artist shipments this month.</p>'}
<p style="font-family:sans-serif;color:#888;font-size:12px;">CSV attached.</p>`;

  const recipients = REPORT_TO.split(',').map(s => s.trim()).filter(Boolean);
  if (DRY_RUN || !recipients.length) {
    console.log(DRY_RUN ? '\n[DRY RUN] Not emailing.' : '\nNo ARTIST_REPORT_TO / REPORT_TO set — not emailing.');
    console.log(csv);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Fat Possum Reports <reports@fatpossum.com>',
      to: recipients,
      subject: `Fat Possum Bill to Artist — ${period.label} (${money(total)})`,
      html,
      attachments: [{ filename: `fp-bill-to-artist-${period.key}.csv`, content: Buffer.from(csv).toString('base64') }],
    }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  console.log(`✅ Emailed ${recipients.join(', ')} — ID ${(await res.json()).id}`);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
