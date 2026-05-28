#!/usr/bin/env node
/* ============================================================
   FAT POSSUM -- SHIPMENT NOTIFICATION SCRIPT
   scripts/ship-notify.js
   Runs every 30 min via GitHub Actions.
   Polls Packiyo for shipped FP-WH-INV orders, sends packing
   slip PDF + tracking info to ship-to email via Resend.
   Tracks sent notifications in fp_ship_notify.json (Gist).
   ============================================================ */

const fetch  = require('node-fetch');
const PDFDoc = require('pdfkit');

const PACKIYO_BASE   = 'https://fatpossum.app.packiyo.com/api/v1';
const PACKIYO_TOKEN  = process.env.PACKIYO_TOKEN;
const GIST_ID        = process.env.GIST_ID;
const GIST_TOKEN     = process.env.GIST_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const DRY_RUN        = process.env.DRY_RUN === 'true';

const INV_GIST_FILE    = 'fp_invoices.json';
const NOTIFY_GIST_FILE = 'fp_ship_notify.json';
const ORDER_CHANNEL    = 'FP-WH-INV';

// ── HELPERS ─────────────────────────────────────────────────────

async function packiyoFetch(path) {
  const url = PACKIYO_BASE + path;
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${PACKIYO_TOKEN}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
    });
    if (res.status === 429) {
      console.log(`  Rate limited, retrying in ${delay}ms…`);
      await new Promise(r => setTimeout(r, delay));
      delay *= 2;
      continue;
    }
    if (!res.ok) throw new Error(`Packiyo ${res.status}: ${path}`);
    return res.json();
  }
  throw new Error(`Packiyo rate limit exceeded: ${path}`);
}

async function gistGet(filename) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    headers: { Authorization: `Bearer ${GIST_TOKEN}`, Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(`Gist GET failed: ${res.status}`);
  const data = await res.json();
  const content = data.files?.[filename]?.content;
  if (!content) return null;
  return JSON.parse(content);
}

async function gistSet(filename, obj) {
  const res = await fetch(`https://api.github.com/gists/${GIST_ID}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${GIST_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(obj, null, 2) } } }),
  });
  if (!res.ok) throw new Error(`Gist PATCH failed: ${res.status}`);
}

// ── PDF PACKING SLIP ─────────────────────────────────────────────

function buildPackingSlipPDF(inv, tracking) {
  return new Promise((resolve, reject) => {
    const doc    = new PDFDoc({ margin: 50, size: 'LETTER' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end',  () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const W  = doc.page.width - 100; // usable width
    const G  = '#888888';
    const BK = '#111111';

    // ── Header ─────────────────────────────────────────────────
    doc.fontSize(20).fillColor(BK).font('Helvetica-Bold')
       .text('Fat Possum Records', 50, 50);
    doc.fontSize(9).fillColor(G).font('Helvetica')
       .text('PO Box 1235 · Oxford, MS 38655 · info@fatpossum.com', 50, 74);

    doc.fontSize(18).fillColor(BK).font('Helvetica-Bold')
       .text('Packing Slip', 50, 50, { align: 'right' });
    doc.fontSize(9).fillColor(G).font('Helvetica')
       .text(inv.invoiceNumber || inv.packiyoOrderNum || inv.id || '', 50, 74, { align: 'right' });

    // Divider
    doc.moveTo(50, 95).lineTo(50 + W, 95).strokeColor('#dddddd').lineWidth(1).stroke();

    // ── Addresses ──────────────────────────────────────────────
    const addrY = 110;
    const col2  = 300;

    function addrBlock(title, addr, x, y) {
      doc.fontSize(8).fillColor(G).font('Helvetica-Bold').text(title, x, y);
      doc.fontSize(9).fillColor(BK).font('Helvetica');
      let cy = y + 14;
      const lines = [
        addr.company || addr.name,
        addr.company ? addr.name : null,
        addr.address,
        addr.address2 || null,
        [addr.city, addr.state, addr.zip].filter(Boolean).join(', '),
        addr.country !== 'US' ? addr.country : null,
      ].filter(Boolean);
      lines.forEach(l => { doc.text(l, x, cy); cy += 13; });
      return cy;
    }

    const shipTo = inv.shipSame ? inv.billTo : inv.shipTo;
    addrBlock('SHIP TO', shipTo,   50,   addrY);
    addrBlock('BILL TO', inv.billTo, col2, addrY);

    // ── Order info ─────────────────────────────────────────────
    // Two rows: basic info top, tracking below spanning full width
    const infoY = 195;
    const basicFields = [
      ['Invoice #',   inv.invoiceNumber || inv.packiyoOrderNum || inv.id || '—'],
      ['Order Date',  inv.createdAt ? new Date(inv.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'],
      ['PO #',        inv.poNumber || '—'],
      ['Ship Date',   tracking.shippedAt ? new Date(tracking.shippedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}) : '—'],
      ['Carrier',     tracking.carrier || '—'],
    ];

    let ix = 50;
    basicFields.forEach(([label, val]) => {
      doc.fontSize(8).fillColor(G).font('Helvetica-Bold').text(label, ix, infoY);
      doc.fontSize(9).fillColor(BK).font('Helvetica').text(val, ix, infoY + 12);
      ix += 95;
    });

    // Tracking # on its own full-width row
    if (tracking.trackingNumber) {
      doc.fontSize(8).fillColor(G).font('Helvetica-Bold').text('Tracking #', 50, infoY + 30);
      doc.fontSize(9).fillColor(BK).font('Helvetica').text(tracking.trackingNumber, 50, infoY + 42, { width: W });
    }

    // ── Table ──────────────────────────────────────────────────
    const tableY = infoY + 62;
    const cols   = [
      { label: 'Artist / Title',    x: 50,  w: 170 },
      { label: 'Catalog #',         x: 225, w: 75  },
      { label: 'UPC',               x: 305, w: 90  },
      { label: 'Format',            x: 400, w: 65  },
      { label: 'Qty',               x: 470, w: 40  },
    ];

    // Header row
    doc.rect(50, tableY, W, 18).fill('#f3f3f3');
    cols.forEach(col => {
      doc.fontSize(8).fillColor(G).font('Helvetica-Bold')
         .text(col.label, col.x + 3, tableY + 5, { width: col.w - 6 });
    });

    // Item rows
    let rowY = tableY + 20;
    const items = inv.items || [];
    items.forEach((item, idx) => {
      if (idx % 2 === 1) doc.rect(50, rowY, W, 17).fill('#fafafa');
      const artistTitle = [item.artist, item.title].filter(Boolean).join(' — ') || item.description || '';
      const upc = (item.upc || '').replace(/\D/g,'').padStart(12,'0');
      const rowData = [
        { x: cols[0].x, w: cols[0].w, val: artistTitle },
        { x: cols[1].x, w: cols[1].w, val: item.catalog || item.sku || '' },
        { x: cols[2].x, w: cols[2].w, val: upc },
        { x: cols[3].x, w: cols[3].w, val: item.format || '' },
        { x: cols[4].x, w: cols[4].w, val: String(item.qty || item.quantity || 1) },
      ];
      rowData.forEach(cell => {
        doc.fontSize(8).fillColor(BK).font('Helvetica')
           .text(cell.val, cell.x + 3, rowY + 4, { width: cell.w - 6, lineBreak: false });
      });
      rowY += 17;
    });

    // Bottom rule
    doc.moveTo(50, rowY + 4).lineTo(50 + W, rowY + 4).strokeColor('#dddddd').lineWidth(1).stroke();

    // Total qty
    const totalQty = items.reduce((s, i) => s + parseInt(i.qty || i.quantity || 1), 0);
    doc.fontSize(8).fillColor(G).font('Helvetica-Bold')
       .text('Total Units:', cols[3].x + 3, rowY + 10);
    doc.fontSize(9).fillColor(BK).font('Helvetica-Bold')
       .text(String(totalQty), cols[4].x + 3, rowY + 10);

    // ── Footer ─────────────────────────────────────────────────
    const footY = doc.page.height - 60;
    doc.fontSize(8).fillColor(G).font('Helvetica')
       .text('Thank you for your order! Questions? Contact your Fat Possum sales rep.',
             50, footY, { align: 'center', width: W });

    doc.end();
  });
}

// ── EMAIL ────────────────────────────────────────────────────────

async function sendShipEmail(inv, tracking, pdfBuffer) {
  const shipTo   = inv.shipSame ? inv.billTo : inv.shipTo;
  const toEmail  = shipTo.email || inv.billTo?.email;
  if (!toEmail) throw new Error('No ship-to email on invoice ' + (inv.invoiceNumber || inv.id));

  const toName   = shipTo.company || shipTo.name || toEmail;
  const invNum   = inv.invoiceNumber || inv.packiyoOrderNum || inv.id;
  const trackTxt = tracking.trackingNumber
    ? `\n\nTracking: ${tracking.carrier ? tracking.carrier + ' — ' : ''}${tracking.trackingNumber}${tracking.trackingUrl ? '\n' + tracking.trackingUrl : ''}`
    : '';

  const itemsList = (inv.items || []).map(i =>
    `  • ${[i.artist, i.title].filter(Boolean).join(' — ')} | ${i.catalog||''} | Qty: ${i.qty||i.quantity||1}`
  ).join('\n');

  const subject = `Your Fat Possum order has shipped — ${invNum}`;
  const text    = `Hi ${toName},\n\nYour order ${invNum} has shipped!${trackTxt}\n\nItems in this shipment:\n${itemsList}\n\nA packing slip PDF is attached for your records.\n\nThank you,\nFat Possum Records`;
  const html    = `<p>Hi <strong>${toName}</strong>,</p>
<p>Your order <strong>${invNum}</strong> has shipped!</p>
${tracking.trackingNumber ? `<p><strong>Carrier:</strong> ${tracking.carrier||'—'}<br><strong>Tracking:</strong> ${tracking.trackingUrl ? `<a href="${tracking.trackingUrl}">${tracking.trackingNumber}</a>` : tracking.trackingNumber}</p>` : ''}
<p><strong>Items in this shipment:</strong></p>
<table style="border-collapse:collapse;font-size:13px;width:100%;max-width:540px;">
  <tr style="background:#f3f3f3;">
    <th style="padding:6px 10px;text-align:left;border:1px solid #ddd;">Artist / Title</th>
    <th style="padding:6px 10px;text-align:left;border:1px solid #ddd;">Catalog #</th>
    <th style="padding:6px 10px;text-align:left;border:1px solid #ddd;">Format</th>
    <th style="padding:6px 10px;text-align:center;border:1px solid #ddd;">Qty</th>
  </tr>
  ${(inv.items||[]).map((i,idx) => `<tr style="background:${idx%2?'#fafafa':'#fff'};">
    <td style="padding:5px 10px;border:1px solid #eee;">${[i.artist,i.title].filter(Boolean).join(' — ')||i.description||''}</td>
    <td style="padding:5px 10px;border:1px solid #eee;font-family:monospace;">${i.catalog||i.sku||''}</td>
    <td style="padding:5px 10px;border:1px solid #eee;">${i.format||''}</td>
    <td style="padding:5px 10px;border:1px solid #eee;text-align:center;">${i.qty||i.quantity||1}</td>
  </tr>`).join('')}
</table>
<p style="color:#888;font-size:12px;">A packing slip PDF is attached for your records.</p>
<p>Thank you,<br>Fat Possum Records</p>`;

  const payload = {
    from:    'Fat Possum Records <shipping@fatpossum.com>',
    to:      [`${toName} <${toEmail}>`],
    subject,
    text,
    html,
    attachments: [{
      filename:    `packing-slip-${invNum}.pdf`,
      content:     pdfBuffer.toString('base64'),
      content_type: 'application/pdf',
    }],
  };

  if (DRY_RUN) {
    console.log(`  [DRY RUN] Would email ${toEmail} for ${invNum}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method:  'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Resend failed ${res.status}: ${t.slice(0,200)}`);
  }
  const data = await res.json();
  console.log(`  Sent to ${toEmail} — Resend ID: ${data.id}`);
}

// ── MAIN ─────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== FP Ship Notify ${DRY_RUN ? '[DRY RUN] ' : ''}=== ${new Date().toISOString()}`);

  // Load invoices from Gist
  console.log('Loading invoices from Gist…');
  const invData = await gistGet(INV_GIST_FILE);
  const invoices = (invData?.invoices || invData || []).filter(inv =>
    inv.packiyoOrderId &&
    ['pending_shipment','paid','sent'].includes(inv.status)
  );
  console.log(`  ${invoices.length} invoices eligible for shipment check`);

  if (!invoices.length) { console.log('Nothing to check.'); return; }

  // Load notification log
  let notifyLog = await gistGet(NOTIFY_GIST_FILE) || { notified: {} };
  if (!notifyLog.notified) notifyLog.notified = {};

  let sent = 0, skipped = 0, errors = 0;

  for (const inv of invoices) {
    const invNum = inv.invoiceNumber || inv.packiyoOrderNum || inv.id;
    if (notifyLog.notified[invNum]) { skipped++; continue; }

    try {
      // Poll Packiyo for shipment status
      console.log(`\nChecking ${invNum} (Packiyo order ${inv.packiyoOrderId})…`);
      const res = await packiyoFetch(
        `/orders/${inv.packiyoOrderId}?include=shipments,shipments.shipment_trackings`
      );

      const shipments = (res.included || []).filter(i =>
        i.type === 'shipments' && !/voided/i.test(i.attributes?.status_text || '')
      );

      if (!shipments.length) {
        console.log(`  Not yet shipped — skipping`);
        skipped++;
        continue;
      }

      // Get tracking info
      const trackings  = (res.included || []).filter(i => i.type === 'shipment-trackings');
      const firstTrack = trackings[0]?.attributes || {};
      const shipAttr   = shipments[0].attributes || {};
      console.log(`  Shipment attrs:`, JSON.stringify(shipAttr).slice(0,200));
      console.log(`  Tracking attrs:`, JSON.stringify(firstTrack).slice(0,200));

      const tracking = {
        shippedAt:      shipAttr.created_at || shipAttr.shipped_at || new Date().toISOString(),
        carrier:        firstTrack.carrier_name || firstTrack.carrier || firstTrack.shipping_carrier
                        || shipAttr.carrier_name || shipAttr.carrier || shipAttr.shipping_method_name || '',
        trackingNumber: firstTrack.tracking_number || firstTrack.tracking_code || '',
        trackingUrl:    firstTrack.tracking_url || '',
      };

      console.log(`  Shipped! Carrier: ${tracking.carrier || '—'} | Tracking: ${tracking.trackingNumber || '—'}`);

      // Check ship-to email
      const shipTo  = inv.shipSame ? inv.billTo : inv.shipTo;
      const toEmail = shipTo?.email || inv.billTo?.email;
      if (!toEmail) {
        console.log(`  No email address on invoice — skipping notification`);
        notifyLog.notified[invNum] = { skippedAt: new Date().toISOString(), reason: 'no_email', ...tracking };
        skipped++;
        continue;
      }

      // Build PDF and send
      console.log(`  Building packing slip PDF…`);
      const pdfBuf = await buildPackingSlipPDF(inv, tracking);

      console.log(`  Sending email to ${toEmail}…`);
      await sendShipEmail(inv, tracking, pdfBuf);

      // Log as notified
      notifyLog.notified[invNum] = {
        sentAt:         new Date().toISOString(),
        to:             toEmail,
        carrier:        tracking.carrier,
        trackingNumber: tracking.trackingNumber,
      };
      sent++;

      // Throttle between emails
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      console.error(`  ERROR on ${invNum}:`, e.message);
      errors++;
    }
  }

  // Save notification log back to Gist
  if (!DRY_RUN && (sent > 0 || Object.keys(notifyLog.notified).length > 0)) {
    console.log('\nSaving notification log to Gist…');
    await gistSet(NOTIFY_GIST_FILE, notifyLog);
  }

  console.log(`\n=== Done: ${sent} sent, ${skipped} skipped, ${errors} errors ===\n`);
  if (errors > 0) process.exit(1);
}

main().catch(e => { console.error('Fatal:', e); process.exit(1); });
