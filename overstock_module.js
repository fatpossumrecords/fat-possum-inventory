/* ============================================================
   FAT POSSUM -- ORCHARD OVERSTOCK MODULE
   overstock_module.js

   Per title, per Orchard warehouse (US / CA / UK / EU):
     - Eligible once the title is at least N months past release (default 12).
     - Keep    = N months of that warehouse's sales (default 12).
     - Overstock = stock (available + inbound) above Keep.
     - Excess goes to another Orchard warehouse that's short on the same
       title, using the standard routes; anything left is flagged
       "sell off / destroy".
     - A SKU that sold <= threshold units in 12 months (default 2) is a
       delete candidate: all of its stock is excess, and deleting it saves
       the per-SKU fee.

   UK and EU only report calendar This Year / Last Year, so their 12-month
   sales are estimated as This Year + the not-yet-elapsed share of Last Year.
   ============================================================ */

const OVS_LS_KEY = 'fp_ovs_settings';
const OVS_WH = [
  { key:'us', label:'Orchard US',     short:'US', avail:'us_avail', inbound:'us_inbound', deleted:'orchard_deleted_oa' },
  { key:'ca', label:'Orchard Canada', short:'CA', avail:'ca_avail', inbound:'ca_inbound', deleted:'orchard_deleted_oa' },
  { key:'uk', label:'Orchard UK',     short:'UK', avail:'uk_avail', inbound:'uk_inbound', deleted:'orchard_deleted_uk' },
  { key:'eu', label:'Orchard EU',     short:'EU', avail:'eu_avail', inbound:'eu_inbound', deleted:null },
];
// Standard Orchard→Orchard routes (same as Stock Movements' VALID_ROUTES)
const OVS_ROUTES = { us:['ca','uk','eu'], uk:['eu'], ca:[], eu:[] };

const OVS_DEFAULTS = {
  keepMonths: 12,
  minAgeMonths: 12,
  deleteMax: 2,
  countInbound: true,
  skuFee: 0.30,
  feePeriod: 'month',   // month | year
};

const OvsState = {
  rows: [],
  filterWh: '',
  filterAction: '',
  filterLabel: '',
  search: '',
  sort: 'overstock',
};

function ovsSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(OVS_LS_KEY) || '{}') || {}; } catch(e) {}
  return Object.assign({}, OVS_DEFAULTS, s);
}
function ovsSaveSettings(s) {
  try { localStorage.setItem(OVS_LS_KEY, JSON.stringify(s)); } catch(e) {}
}

function ovsNum(n) { return Math.round(n || 0).toLocaleString(); }
function ovsGBP(n) { return '£' + (n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }

// Fraction of the current calendar year that has elapsed (0..1)
function ovsYearElapsed(now) {
  const start = Date.UTC(now.getUTCFullYear(), 0, 1);
  const end   = Date.UTC(now.getUTCFullYear() + 1, 0, 1);
  return (now.getTime() - start) / (end - start);
}

function ovsMonthsSince(isoDate, now) {
  if (!isoDate) return null;
  const [y, m, d] = isoDate.split('-').map(Number);
  let months = (now.getUTCFullYear() - y) * 12 + (now.getUTCMonth() + 1 - m);
  if (now.getUTCDate() < d) months -= 1;
  return months;
}

// Orchard numbers can be negative (returns) or junk (a UPC pasted into a
// quantity cell shows up as ~1e20). Treat both as 0.
function ovsQty(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 && n < 1e6 ? n : 0;
}

// 12-month sales for one warehouse. Returns { units, estimated }.
function ovsSales12(p, wh, yearElapsed) {
  if (wh === 'us') return { units: ovsQty(p.us_12ms), estimated: false };
  if (wh === 'ca') return { units: ovsQty(p.ca_12ms), estimated: false };
  const thisYr = ovsQty(wh === 'uk' ? p.uk_this_yr : p.eu_this_yr);
  const lastYr = ovsQty(wh === 'uk' ? p.uk_last_yr : p.eu_last_yr);
  return { units: thisYr + lastYr * (1 - yearElapsed), estimated: true };
}

// ── CORE CALCULATION ─────────────────────────────────────────
function ovsCompute(products, s, now) {
  now = now || new Date();
  const yearElapsed = ovsYearElapsed(now);
  const rows = [];

  for (const p of products) {
    const age = ovsMonthsSince(p.release_date, now);
    const eligible = age !== null && age >= s.minAgeMonths;

    // Per-warehouse position for this title
    const pos = {};
    for (const wh of OVS_WH) {
      const deleted = wh.deleted ? !!p[wh.deleted] : false;
      const avail   = ovsQty(p[wh.avail]);
      const inbound = s.countInbound ? ovsQty(p[wh.inbound]) : 0;
      const stock   = avail + inbound;
      const sales   = ovsSales12(p, wh.key, yearElapsed);
      const sales12 = Math.round(sales.units);
      const keepTarget = Math.ceil(sales.units * s.keepMonths / 12);
      const deleteCand = eligible && !deleted && stock > 0 && sales12 <= s.deleteMax;
      const keep       = deleteCand ? 0 : keepTarget;
      const overstock  = (eligible && !deleted) ? Math.max(0, stock - keep) : 0;
      // A warehouse "needs" stock if it sells the title and is under its keep level
      const need = (!deleted && !deleteCand && sales12 > s.deleteMax) ? Math.max(0, keepTarget - stock) : 0;
      pos[wh.key] = { wh, deleted, avail, inbound, stock, sales12, estimated: sales.estimated, keep, overstock, deleteCand, need };
    }

    // Send each warehouse's excess to Orchard warehouses that need it (standard routes only)
    const needLeft = {};
    for (const k in pos) needLeft[k] = pos[k].need;
    for (const wh of OVS_WH) {
      const x = pos[wh.key];
      if (!x.overstock) continue;
      let left = x.overstock;
      x.moves = [];
      for (const to of OVS_ROUTES[wh.key]) {
        if (left <= 0) break;
        const qty = Math.min(left, needLeft[to]);
        if (qty > 0) {
          x.moves.push({ to, qty });
          needLeft[to] -= qty;
          left -= qty;
        }
      }
      x.sellOff = left;
    }

    for (const wh of OVS_WH) {
      const x = pos[wh.key];
      if (!x.overstock && !x.deleteCand) continue;
      const moved = (x.moves || []).reduce((a, m) => a + m.qty, 0);
      rows.push({
        upc: p.upc,
        artist: p.artist || '',
        title: p.title || p.orchard_title || '',
        catalog: p.orchard_catalog || p.catalog || '',
        format: p.format || '',
        label: p.label || '',
        release_date: p.release_date || '',
        wh: wh.key,
        whLabel: wh.label,
        avail: x.avail,
        inbound: x.inbound,
        stock: x.stock,
        sales12: x.sales12,
        estimated: x.estimated,
        keep: x.keep,
        overstock: x.overstock,
        moves: x.moves || [],
        moveQty: moved,
        sellOff: x.sellOff || 0,
        deleteCand: x.deleteCand,
      });
    }
  }
  return rows;
}

function ovsActionText(r) {
  const parts = [];
  for (const m of r.moves) parts.push(`Move ${ovsNum(m.qty)} → ${OVS_WH.find(w => w.key === m.to).label}`);
  if (r.sellOff) parts.push(`Sell off / destroy ${ovsNum(r.sellOff)}`);
  if (r.deleteCand) parts.push('Delete SKU');
  return parts.join(' · ');
}

function ovsMatchesFilters(r) {
  if (OvsState.filterWh && r.wh !== OvsState.filterWh) return false;
  if (OvsState.filterAction === 'move'   && !r.moveQty) return false;
  if (OvsState.filterAction === 'sell'   && !r.sellOff) return false;
  if (OvsState.filterAction === 'delete' && !r.deleteCand) return false;
  if (OvsState.filterLabel && (r.label || '').toLowerCase() !== OvsState.filterLabel) return false;
  if (OvsState.search) {
    const hay = `${r.artist} ${r.title} ${r.catalog} ${r.upc} ${r.label}`.toLowerCase();
    if (!hay.includes(OvsState.search)) return false;
  }
  return true;
}

// ── RENDER ───────────────────────────────────────────────────
window.renderOverstock = function() {
  const body = document.getElementById('ovs-body');
  if (!body) return;
  const s = ovsSettings();
  const merged = (typeof State !== 'undefined' && State.merged) ? State.merged : [];

  if (!merged.length) {
    body.innerHTML = '<div style="padding:32px;color:var(--text-muted);">Loading inventory…</div>';
    return;
  }

  const withDates = merged.filter(p => p.release_date).length;
  OvsState.rows = ovsCompute(merged, s);
  const rows = OvsState.rows;
  const monthlyFee = s.feePeriod === 'year' ? s.skuFee / 12 : s.skuFee;

  // Totals per warehouse
  const tot = {};
  for (const wh of OVS_WH.concat([{ key:'all', label:'All Orchard' }])) {
    tot[wh.key] = { label: wh.label, overstock:0, titles:0, move:0, sell:0, del:0 };
  }
  for (const r of rows) {
    for (const k of [r.wh, 'all']) {
      const t = tot[k];
      t.overstock += r.overstock;
      if (r.overstock) t.titles++;
      t.move += r.moveQty;
      t.sell += r.sellOff;
      if (r.deleteCand) t.del++;
    }
  }

  const labels = [...new Set(rows.map(r => r.label).filter(Boolean))].sort();
  const shown = rows.filter(ovsMatchesFilters);
  const sorters = {
    overstock: (a, b) => b.overstock - a.overstock,
    sell:      (a, b) => b.sellOff - a.sellOff || b.overstock - a.overstock,
    artist:    (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
    release:   (a, b) => (a.release_date || '').localeCompare(b.release_date || ''),
  };
  shown.sort(sorters[OvsState.sort] || sorters.overstock);

  const orchardTs = localStorage.getItem('fp_orchard_ts');
  const tsText = orchardTs ? new Date(orchardTs).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' }) : 'unknown';

  const inputStyle = 'width:56px;padding:5px 6px;font-size:12px;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--text);';
  const lbl = 'display:flex;flex-direction:column;gap:3px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-muted);';

  let html = '<div style="padding:20px 24px;">';
  html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px;">'
    + '<div><h2 style="margin:0;font-size:18px;">Orchard Overstock</h2>'
    + `<div style="font-size:12px;color:var(--text-muted);margin-top:3px;">Stock above ${s.keepMonths} months of sales, on titles at least ${s.minAgeMonths} months past release · Orchard data from ${esc(tsText)}</div></div>`
    + '<div style="display:flex;gap:6px;">'
    + '<button class="btn-primary btn-sm" onclick="ovsQueueSelected()">Queue selected moves</button>'
    + '<button class="btn-secondary btn-sm" onclick="ovsExportCSV()">Export CSV</button>'
    + '</div></div>';

  if (!withDates) {
    html += '<div style="background:var(--orange-bg,#fdeede);border:1px solid var(--orange);color:var(--text);padding:10px 14px;border-radius:4px;font-size:12px;margin-bottom:14px;">'
      + '<strong>No release dates loaded yet.</strong> Click <strong>Sync Sheet</strong> in the sidebar once to pull release dates, inbound stock and the deleted flags from the Orchard sheet. Until then nothing counts as overstock.</div>';
  } else if (withDates < merged.length * 0.5) {
    html += `<div style="font-size:11px;color:var(--text-muted);margin-bottom:10px;">${ovsNum(merged.length - withDates)} titles have no release date and are left out.</div>`;
  }

  // Settings
  html += '<div style="display:flex;gap:14px;align-items:flex-end;flex-wrap:wrap;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:10px 14px;margin-bottom:14px;">'
    + `<label style="${lbl}">Keep (months)<input type="number" min="0" max="60" value="${s.keepMonths}" style="${inputStyle}" onchange="ovsSet('keepMonths', this.value)"></label>`
    + `<label style="${lbl}">Min age (months)<input type="number" min="0" max="120" value="${s.minAgeMonths}" style="${inputStyle}" onchange="ovsSet('minAgeMonths', this.value)"></label>`
    + `<label style="${lbl}">Delete if sold ≤<input type="number" min="0" max="100" value="${s.deleteMax}" style="${inputStyle}" onchange="ovsSet('deleteMax', this.value)"></label>`
    + `<label style="${lbl}">SKU fee (£)<input type="number" min="0" step="0.01" value="${s.skuFee}" style="${inputStyle}" onchange="ovsSet('skuFee', this.value)"></label>`
    + `<label style="${lbl}">Fee per<select class="select-sm" onchange="ovsSet('feePeriod', this.value)"><option value="month"${s.feePeriod==='month'?' selected':''}>Month</option><option value="year"${s.feePeriod==='year'?' selected':''}>Year</option></select></label>`
    + `<label style="display:flex;gap:6px;align-items:center;font-size:12px;color:var(--text);padding-bottom:6px;"><input type="checkbox"${s.countInbound?' checked':''} onchange="ovsSet('countInbound', this.checked)"> Count inbound stock</label>`
    + '<button class="btn-ghost btn-sm" style="margin-left:auto;" onclick="ovsResetSettings()">Reset</button>'
    + '</div>';

  // Summary cards
  html += '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;margin-bottom:16px;">';
  for (const k of ['all', 'us', 'ca', 'uk', 'eu']) {
    const t = tot[k];
    const saving = t.del * monthlyFee * 12;
    const isAll = k === 'all';
    html += `<div style="background:var(--surface);border:1px solid ${isAll ? 'var(--text)' : 'var(--border)'};border-radius:6px;padding:12px 14px;cursor:${isAll?'default':'pointer'};" ${isAll ? '' : `onclick="ovsSetFilter('filterWh','${k}')"`}>`
      + `<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-muted);">${esc(t.label)}</div>`
      + `<div style="font-size:22px;font-weight:700;font-family:'DM Mono',monospace;margin:4px 0 2px;">${ovsNum(t.overstock)}</div>`
      + `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px;">overstock units · ${ovsNum(t.titles)} titles</div>`
      + `<div style="font-size:11px;line-height:1.7;">`
      + `<div style="display:flex;justify-content:space-between;"><span>Move to other Orchard WH</span><strong>${ovsNum(t.move)}</strong></div>`
      + `<div style="display:flex;justify-content:space-between;"><span>Sell off / destroy</span><strong style="color:var(--red);">${ovsNum(t.sell)}</strong></div>`
      + `<div style="display:flex;justify-content:space-between;"><span>SKUs to delete</span><strong>${ovsNum(t.del)}</strong></div>`
      + `<div style="display:flex;justify-content:space-between;color:var(--green);"><span>Fee saved / yr</span><strong>${ovsGBP(saving)}</strong></div>`
      + '</div></div>';
  }
  html += '</div>';

  // Filters
  html += '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:8px;">'
    + `<input type="search" placeholder="Search artist, title, cat #, UPC…" value="${esc(OvsState.search)}" oninput="ovsSetFilter('search', this.value)" style="flex:1;min-width:200px;padding:6px 10px;font-size:12px;border:1px solid var(--border);border-radius:3px;background:var(--surface);color:var(--text);">`
    + `<select class="select-sm" onchange="ovsSetFilter('filterWh', this.value)"><option value="">All warehouses</option>${OVS_WH.map(w => `<option value="${w.key}"${OvsState.filterWh===w.key?' selected':''}>${w.label}</option>`).join('')}</select>`
    + `<select class="select-sm" onchange="ovsSetFilter('filterAction', this.value)">`
    + `<option value="">All actions</option><option value="move"${OvsState.filterAction==='move'?' selected':''}>Move</option><option value="sell"${OvsState.filterAction==='sell'?' selected':''}>Sell off / destroy</option><option value="delete"${OvsState.filterAction==='delete'?' selected':''}>Delete SKU</option></select>`
    + `<select class="select-sm" onchange="ovsSetFilter('filterLabel', this.value)"><option value="">All labels</option>${labels.map(l => `<option value="${esc(l.toLowerCase())}"${OvsState.filterLabel===l.toLowerCase()?' selected':''}>${esc(l)}</option>`).join('')}</select>`
    + `<select class="select-sm" onchange="ovsSetFilter('sort', this.value)">`
    + `<option value="overstock"${OvsState.sort==='overstock'?' selected':''}>Sort: most overstock</option><option value="sell"${OvsState.sort==='sell'?' selected':''}>Sort: most to sell off</option><option value="artist"${OvsState.sort==='artist'?' selected':''}>Sort: artist</option><option value="release"${OvsState.sort==='release'?' selected':''}>Sort: oldest release</option></select>`
    + `<span style="font-size:11px;color:var(--text-muted);margin-left:4px;">${ovsNum(shown.length)} of ${ovsNum(rows.length)} lines</span>`
    + '</div>';

  // Table
  const LIMIT = 500;
  const th = (t, num) => `<th${num ? ' class="num"' : ''} style="position:sticky;top:0;background:var(--surface2);white-space:nowrap;">${t}</th>`;
  html += '<div style="background:var(--surface);border:1px solid var(--border);border-radius:6px;overflow:auto;max-height:calc(100vh - 360px);">'
    + '<table class="dash-table" style="min-width:1100px;"><thead><tr>'
    + `<th style="position:sticky;top:0;background:var(--surface2);width:24px;"><input type="checkbox" title="Select all moves shown" onchange="ovsToggleAll(this.checked)"></th>`
    + th('Artist') + th('Title') + th('Cat #') + th('Format') + th('Warehouse') + th('Released')
    + th('Stock', true) + th('12M sales', true) + th('Keep', true) + th('Overstock', true) + th('Action')
    + '</tr></thead><tbody>';
  if (!shown.length) {
    html += '<tr><td colspan="12" style="padding:24px;text-align:center;color:var(--text-muted);">No overstock matches these filters.</td></tr>';
  }
  for (const r of shown.slice(0, LIMIT)) {
    const key = r.upc + '|' + r.wh;
    const stockTitle = r.inbound ? `${r.avail} available + ${r.inbound} inbound` : `${r.avail} available`;
    html += '<tr>'
      + `<td>${r.moveQty ? `<input type="checkbox" class="ovs-check" data-key="${esc(key)}">` : ''}</td>`
      + `<td>${esc(r.artist)}</td>`
      + `<td>${esc(r.title)}</td>`
      + `<td><code style="font-size:11px;">${esc(r.catalog)}</code></td>`
      + `<td style="font-size:11px;">${esc(r.format)}</td>`
      + `<td style="font-size:11px;">${esc(r.whLabel)}</td>`
      + `<td style="font-size:11px;white-space:nowrap;">${esc(r.release_date)}</td>`
      + `<td class="num" title="${esc(stockTitle)}">${ovsNum(r.stock)}</td>`
      + `<td class="num"${r.estimated ? ' title="Estimated from This Year + Last Year ships"' : ''}>${ovsNum(r.sales12)}${r.estimated ? '<span style="font-size:9px;color:var(--text-muted);"> est</span>' : ''}</td>`
      + `<td class="num">${ovsNum(r.keep)}</td>`
      + `<td class="num" style="font-weight:700;">${ovsNum(r.overstock)}</td>`
      + `<td style="font-size:11px;">${esc(ovsActionText(r))}</td>`
      + '</tr>';
  }
  html += '</tbody></table></div>';
  if (shown.length > LIMIT) {
    html += `<div style="font-size:11px;color:var(--text-muted);margin-top:6px;">Showing the first ${LIMIT} of ${ovsNum(shown.length)} lines. Narrow the filters or export CSV for everything.</div>`;
  }
  html += '<div style="font-size:11px;color:var(--text-muted);margin-top:10px;line-height:1.6;">'
    + 'est = estimated: UK and EU only report calendar-year ships, so 12-month sales = This Year + the remaining share of Last Year. '
    + 'Moves only use standard routes (US → CA/UK/EU, UK → EU). Delete candidates only include SKUs that still hold stock at that warehouse.'
    + '</div>';
  html += '</div>';

  body.innerHTML = html;
};

// ── HANDLERS ─────────────────────────────────────────────────
window.ovsSet = function(key, value) {
  const s = ovsSettings();
  if (key === 'countInbound') s[key] = !!value;
  else if (key === 'feePeriod') s[key] = value === 'year' ? 'year' : 'month';
  else {
    const n = parseFloat(value);
    s[key] = isNaN(n) || n < 0 ? OVS_DEFAULTS[key] : n;
  }
  ovsSaveSettings(s);
  renderOverstock();
};

window.ovsResetSettings = function() {
  ovsSaveSettings({});
  renderOverstock();
};

let _ovsSearchTimer = null;
window.ovsSetFilter = function(key, value) {
  if (key === 'search') {
    OvsState.search = String(value || '').toLowerCase().trim();
    clearTimeout(_ovsSearchTimer);
    _ovsSearchTimer = setTimeout(() => {
      renderOverstock();
      const inp = document.querySelector('#ovs-body input[type="search"]');
      if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    }, 250);
    return;
  }
  OvsState[key] = OvsState[key] === value && key === 'filterWh' ? '' : value;
  renderOverstock();
};

window.ovsToggleAll = function(checked) {
  document.querySelectorAll('#ovs-body .ovs-check').forEach(cb => { cb.checked = checked; });
};

window.ovsQueueSelected = function() {
  const checked = [...document.querySelectorAll('#ovs-body .ovs-check:checked')];
  if (!checked.length) { toast('Tick the lines whose moves you want to queue.', 'error'); return; }
  const byKey = new Map(OvsState.rows.map(r => [r.upc + '|' + r.wh, r]));
  let added = 0, skipped = 0;
  for (const cb of checked) {
    const r = byKey.get(cb.dataset.key);
    if (!r) continue;
    const prod = State.merged.find(p => p.upc === r.upc);
    if (!prod) continue;
    let leaves = r.avail;
    for (const m of r.moves) {
      const from = r.wh, to = m.to;
      if (State.movements.find(x => x.upc === r.upc && x.from === from && x.to === to && x.status === 'draft')) { skipped++; continue; }
      leaves = Math.max(0, leaves - m.qty);
      const draft = State.movements.find(x => x.from === from && x.to === to && x.status === 'draft');
      const shipmentId = draft ? draft.shipmentId : `${from}→${to}-${Date.now()}`;
      State.movements.push({
        from, to, shipmentId,
        artist:  prod.artist,
        title:   prod.title,
        catalog: prod.orchard_catalog || prod.catalog,
        upc:     prod.upc,
        format:  prod.format,
        label:   prod.label,
        qty:     m.qty,
        notes:   `Overstock · leaves ${leaves} at ${OVS_WH.find(w => w.key === from).label}`,
        status:  'draft',
        poNumber: '',
        confirmedAt: null,
        processedAt: null,
        timestamp: new Date().toISOString(),
      });
      added++;
    }
  }
  if (!added) {
    toast(skipped ? 'Those moves are already in the queue.' : 'Nothing to queue.', '');
    return;
  }
  if (typeof renderMovementsTable === 'function') renderMovementsTable();
  if (typeof saveGistData === 'function') saveGistData();
  toast(`${added} move${added > 1 ? 's' : ''} added to Stock Movements${skipped ? ` (${skipped} already queued)` : ''}.`, 'success');
};

window.ovsExportCSV = function() {
  const rows = OvsState.rows.filter(ovsMatchesFilters);
  if (!rows.length) { toast('Nothing to export.', 'error'); return; }
  const s = ovsSettings();
  const monthlyFee = s.feePeriod === 'year' ? s.skuFee / 12 : s.skuFee;
  const cols = ['Artist','Title','Catalog #','UPC','Format','Label','Warehouse','Release Date','Available','Inbound','Stock','12M Sales','12M Sales Estimated','Keep','Overstock','Move Qty','Move To','Sell Off / Destroy','Delete SKU','Fee Saved / Yr (GBP)'];
  const q = v => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push([
      r.artist, r.title, r.catalog, r.upc, r.format, r.label, r.whLabel, r.release_date,
      r.avail, r.inbound, r.stock, r.sales12, r.estimated ? 'Yes' : '', r.keep, r.overstock,
      r.moveQty || '', r.moves.map(m => `${OVS_WH.find(w => w.key === m.to).short} ${m.qty}`).join('; '),
      r.sellOff || '', r.deleteCand ? 'Yes' : '', r.deleteCand ? (monthlyFee * 12).toFixed(2) : '',
    ].map(q).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `orchard-overstock-${new Date().toISOString().slice(0,10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

// Exposed for testing in Node
if (typeof module !== 'undefined') module.exports = { ovsCompute, ovsSales12, ovsMonthsSince, ovsYearElapsed, OVS_DEFAULTS };
