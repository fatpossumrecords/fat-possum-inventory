/* ============================================================
   FAT POSSUM — CYCLE COUNT MODULE
   cycle_count_module.js
   ============================================================ */

// ── STATE ────────────────────────────────────────────────────

const CCState = {
  session:    null,   // active count session
  history:    [],     // loaded from Gist
  historyLoaded: false,
  historyFile: null,  // which Gist file history was read from (see CC_GIST_FILE_V2)
  users:     [],     // for email dropdown
};

// Session shape:
// {
//   id, startedAt, countedBy (email), zone, subZone,
//   items: [{ locName, sku, name, artist, catalog, upc, expected, actual, attempts, status }],
//   currentIdx, complete, submittedAt, discrepancies: []
// }

// History lives in CC_GIST_FILE until GitHub refuses to update it. Gist
// files can get stuck on HTTP 409 "Gist cannot be updated" after enough
// revisions (fp_config.json hit this, see CONFIG.GIST_CONFIG_FILE), and
// cycle counts save every 5 products. When a save still 409s after
// retries, the history moves to CC_GIST_FILE_V2. From then on every reader
// (this module and scripts/ship-notify.js) uses V2 whenever it exists.
const CC_GIST_FILE    = 'fp_cycle_counts.json';
const CC_GIST_FILE_V2 = 'fp_cycle_counts_v2.json';

// Zone definitions — what sub-sections each zone has
function ccGetSubZones(zone) {
  if (zone === 'NOW') return []; // manual only, not suggested
  if (zone.startsWith('P1')) {
    // P1 columns in order
    const cols = ['A','B','C','D','E','F','G','H','I','J','K','L','M','N','O','P','Q','R','S','T','U','V','W','X','Y','Z','AA','AB','AC','AD'];
    return cols.map(c => ({ id: 'P1-' + c, label: 'P1 — Column ' + c }));
  }
  if (zone === 'P2') return [{ id: 'P2', label: 'P2 — All' }];
  if (zone === 'P3') return [{ id: 'P3', label: 'P3 — All' }];
  if (zone === 'P4') return [{ id: 'P4', label: 'P4 — All' }];
  if (zone === 'P5') return [{ id: 'P5', label: 'P5 — All' }];
  // MW zones — by slot
  if (zone.startsWith('MW-')) {
    const aisleDef = WT_MW_AISLES.find(a => 'MW-' + a.aisle === zone);
    if (!aisleDef) return [];
    const slots = [];
    for (const half of aisleDef.halves) {
      for (const letter of half.letters.split(',').map(l => l.trim())) {
        // Each level is a slot
        for (let lvl = 1; lvl <= 6; lvl++) {
          const id = zone + '-' + letter + lvl;
          slots.push({ id, label: id });
        }
      }
    }
    return slots;
  }
  return [];
}

const CC_ZONES = [
  { id: 'P1',    label: 'P1 — LPs',                type: 'p' },
  { id: 'P2',    label: 'P2 — CDs',                type: 'p' },
  { id: 'P3',    label: 'P3 — Apparel',            type: 'p' },
  { id: 'P4',    label: 'P4 — Books',              type: 'p' },
  { id: 'P5',    label: 'P5 — 7" Records',         type: 'p' },
  { id: 'MW-01', label: 'MW-01 — Bulk Aisle 1',    type: 'mw' },
  { id: 'MW-02', label: 'MW-02 — Bulk Aisle 2',    type: 'mw' },
  { id: 'MW-03', label: 'MW-03 — Bulk Aisle 3',    type: 'mw' },
  { id: 'MW-04', label: 'MW-04 — Bulk Aisle 4',    type: 'mw' },
  { id: 'MW-05', label: 'MW-05 — Bulk Aisle 5',    type: 'mw' },
  { id: 'MW-06', label: 'MW-06 — Bulk Aisle 6',    type: 'mw' },
  { id: 'NOW',   label: 'NOW — North Warehouse',   type: 'now', manualOnly: true },
];

// ── INIT ─────────────────────────────────────────────────────

window.ccInit = async function() {
  const area = document.getElementById('cc-content-area');
  if (!area) return;
  // Resume active session if exists
  if (CCState.session && !CCState.session.complete) {
    ccRenderCountScreen();
    return;
  }
  ccRenderHome();
  // Always re-fetch history from Gist so all users see up-to-date counts
  await ccLoadHistory();
  // Update suggestion card with fresh history
  const sugCard = document.getElementById('cc-suggest-card');
  if (sugCard) {
    const suggested = ccSuggestSubZone();
    const lbl = sugCard.querySelector('.cc-suggest-label');
    const btn = sugCard.querySelector('.cc-suggest-btn');
    if (lbl) lbl.textContent = suggested ? suggested.label : '—';
    if (btn && suggested) btn.onclick = function() { ccStartSession(suggested.id); };
  }
  // Auto-load location data if not already loaded — needed for bin selector
  if (!LocState.loaded && !LocState.loading) {
    locInit(true);
  }
};

// ── GIST ─────────────────────────────────────────────────────

// Read whichever history file is active: V2 once it exists, else the
// original. Returns the file's text, or null if neither exists yet.
async function ccFetchHistoryText() {
  const v2 = await fetchGistFile(CC_GIST_FILE_V2);
  if (v2) { CCState.historyFile = CC_GIST_FILE_V2; return v2; }
  CCState.historyFile = CC_GIST_FILE;
  return await fetchGistFile(CC_GIST_FILE);
}

async function ccPatchHistoryFile(filename, historyArr) {
  return await fetchWithGistConflictRetry(gistUrl(CONFIG.GIST_ID), {
    method: 'PATCH',
    headers: Object.assign({ 'Content-Type': 'application/json' }, authHeader()),
    body: JSON.stringify({ files: { [filename]: { content: JSON.stringify(historyArr) } } }),
  });
}

async function ccLoadHistory() {
  try {
    const content = await ccFetchHistoryText();
    CCState.history = content ? JSON.parse(content) : [];
    CCState.historyLoaded = true;
    ccUpdateHistoryPanel();
  } catch(e) {
    console.warn('Cycle count history load failed:', e.message);
    CCState.history = [];
    ccUpdateHistoryPanel();
    return;
  }
  // Upload anything a previous visit on this device couldn't save.
  if (Object.keys(ccGetUnsynced()).length) ccSyncPending({ quiet: true });
}

// ── LOCAL QUEUE ──────────────────────────────────────────────
// Every save goes to this device's localStorage first, then uploads to the
// Gist. A session stays queued until an upload that includes it succeeds,
// so a failed save is retried automatically (every minute, when the device
// comes back online, and on the next app load) instead of being lost.
const CC_UNSYNCED_KEY = 'fp_cc_unsynced';
const CC_SYNC_INTERVAL_MS = 60 * 1000;

function ccGetUnsynced() {
  try { return JSON.parse(localStorage.getItem(CC_UNSYNCED_KEY) || '{}') || {}; }
  catch(e) { return {}; }
}
function ccSetUnsynced(obj) {
  try {
    if (Object.keys(obj).length) localStorage.setItem(CC_UNSYNCED_KEY, JSON.stringify(obj));
    else localStorage.removeItem(CC_UNSYNCED_KEY);
  } catch(e) { console.warn('Could not write cycle count queue to localStorage:', e.message); }
}
function ccQueueLocal(session) {
  const q = ccGetUnsynced();
  q[session.id] = JSON.parse(JSON.stringify(session));
  ccSetUnsynced(q);
}

let _ccSyncPromise = null;
let _ccSyncAgain = false;
// Uploads every queued session in one Gist write. Returns true when the
// queue is empty afterwards. Concurrent calls share one upload, plus one
// follow-up pass if something was queued while it was running.
function ccSyncPending(opts) {
  if (_ccSyncPromise) { _ccSyncAgain = true; return _ccSyncPromise; }
  _ccSyncPromise = (async () => {
    let ok;
    do {
      _ccSyncAgain = false;
      ok = await _ccSyncPendingOnce(opts || {});
    } while (ok && _ccSyncAgain);
    return ok;
  })().finally(() => { _ccSyncPromise = null; ccUpdateHistoryPanel(); ccUpdateNetBanner(); });
  return _ccSyncPromise;
}

async function _ccSyncPendingOnce({ quiet }) {
  const queued = ccGetUnsynced();
  const ids = Object.keys(queued);
  if (!ids.length) return true;

  // Never write without the current server copy — saving a stale or empty
  // local list could erase other people's counts. Stay queued instead.
  let remoteHistory;
  try {
    const remoteTxt = await ccFetchHistoryText();
    remoteHistory = remoteTxt ? JSON.parse(remoteTxt) : [];
  } catch(e) {
    console.warn('Cycle count sync: could not read latest history, will retry:', e.message);
    if (!quiet && window.toast) toast('⚠ Count saved on this device — upload will retry automatically.', 'error');
    return false;
  }

  const pending = ids.map(id => queued[id])
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  let merged = remoteHistory.filter(h => !queued[h.id]);
  merged = ccCompactHistory(pending.concat(merged), queued);

  const saved = await ccSaveHistory(merged, { quiet });
  if (!saved) return false;

  CCState.history = merged;
  // Drop only what was uploaded unchanged; a session edited mid-upload
  // stays queued for the next pass.
  const now = ccGetUnsynced();
  for (const id of ids) {
    if (now[id] && JSON.stringify(now[id]) === JSON.stringify(queued[id])) delete now[id];
  }
  ccSetUnsynced(now);
  return Object.keys(now).length === 0;
}

// Keeps the history useful as a long-running log without the file growing
// without bound. It used to be a flat "newest 100 sessions" cap, which with
// several sessions a day (including abandoned starts) dropped completed
// counts within weeks — losing them from the admin log and making zones
// look never-counted to ccSuggestSubZone.
//   - Unfinished sessions older than 2 days are dropped (abandoned starts),
//     unless still queued on this device.
//   - Completed sessions keep full product lists for the newest 40; older
//     ones keep a summary + discrepancies + skipped list only.
//   - Hard cap of 600 sessions.
const CC_KEEP_FULL = 40;
const CC_MAX_SESSIONS = 600;
const CC_STALE_UNFINISHED_MS = 2 * 24 * 60 * 60 * 1000;

function ccSummarize(h) {
  if (h.summary) return h.summary;
  const items = h.items || [];
  return {
    total:     items.length,
    passed:    items.filter(i => i.status === 'pass').length,
    skipped:   items.filter(i => i.status === 'skipped').length,
    recounted: items.filter(i => i.status === 'pass' && (i.attempts || 0) > 1).length,
  };
}
function ccSkippedList(h) {
  if (h.skippedItems) return h.skippedItems;
  return (h.items || []).filter(i => i.status === 'skipped')
    .map(i => ({ locName: i.locName, name: i.name, artist: i.artist, catalog: i.catalog, expected: i.expected }));
}

function ccCompactHistory(arr, keep) {
  const now = Date.now();
  let fullKept = 0;
  const out = [];
  const sorted = arr.slice().sort((a, b) =>
    String(b && (b.submittedAt || b.startedAt)).localeCompare(String(a && (a.submittedAt || a.startedAt))));
  for (const h of sorted) {
    if (!h || !h.id) continue;
    if (!h.complete) {
      const age = now - new Date(h.startedAt || 0).getTime();
      if (age > CC_STALE_UNFINISHED_MS && !(keep && keep[h.id])) continue;
      out.push(h);
      continue;
    }
    if (fullKept < CC_KEEP_FULL || !(h.items && h.items.length)) {
      if (h.items && h.items.length) fullKept++;
      out.push(h);
      continue;
    }
    const slim = Object.assign({}, h, { summary: ccSummarize(h), skippedItems: ccSkippedList(h), items: [] });
    out.push(slim);
  }
  return out.slice(0, CC_MAX_SESSIONS);
}

setInterval(() => {
  if (Object.keys(ccGetUnsynced()).length && State.idToken) ccSyncPending({ quiet: true });
}, CC_SYNC_INTERVAL_MS);
window.addEventListener('online', () => {
  if (Object.keys(ccGetUnsynced()).length) ccSyncPending({ quiet: true });
});

async function ccSaveHistory(historyArr, { quiet } = {}) {
  try {
    const file = CCState.historyFile || CC_GIST_FILE;
    let res = await ccPatchHistoryFile(file, historyArr);
    if (res.status === 409 && file === CC_GIST_FILE) {
      // Still refused after retries: treat the original file as stuck and
      // move the full history to V2. The old file is left as an archive.
      console.warn('Cycle count file still 409 after retries — moving history to', CC_GIST_FILE_V2);
      res = await ccPatchHistoryFile(CC_GIST_FILE_V2, historyArr);
      if (res.ok) CCState.historyFile = CC_GIST_FILE_V2;
    }
    if (!res.ok) {
      const err = await res.text();
      console.error('Cycle count Gist save failed:', res.status, err.slice(0,200));
      if (!quiet && window.toast) toast('⚠ Upload failed (' + res.status + ') — count saved on this device, will retry automatically.', 'error');
      return false;
    }
    console.log('Cycle count saved to Gist OK, entries:', historyArr.length);
    return true;
  } catch(e) {
    console.error('Cycle count Gist save error:', e.message);
    if (!quiet && window.toast) toast('⚠ Upload failed — count saved on this device, will retry automatically.', 'error');
    return false;
  }
}

// Save the session so it can be resumed and reviewed. It's queued on this
// device first, then upserted (by id) into the latest server copy of the
// history along with anything else still queued, so two people counting
// at once can't erase each other's sessions and a failed upload is retried.
async function ccSaveSession() {
  if (!CCState.session) return false;
  ccSaveActiveLocal();
  ccQueueLocal(CCState.session);
  const p = ccSyncPending();
  ccUpdateNetBanner();
  return await p;
}

// ── IN-PROGRESS COUNT ON THIS DEVICE ─────────────────────────
// The count being worked on is written to localStorage after every product
// (no network needed), so a reload, a closed tab, or Safari discarding the
// page while wifi is down doesn't lose it. On next open the home screen
// offers to resume it. Uploading still happens every 5 products via the
// queue above; this copy is only for picking up where you left off.
const CC_ACTIVE_KEY = 'fp_cc_active';

function ccSaveActiveLocal() {
  const s = CCState.session;
  try {
    if (s && !s.complete) localStorage.setItem(CC_ACTIVE_KEY, JSON.stringify(s));
    else localStorage.removeItem(CC_ACTIVE_KEY);
  } catch(e) { console.warn('Could not save in-progress count on this device:', e.message); }
}
function ccGetActiveLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(CC_ACTIVE_KEY) || 'null');
    return s && !s.complete && Array.isArray(s.items) ? s : null;
  } catch(e) { return null; }
}
function ccClearActiveLocal() {
  try { localStorage.removeItem(CC_ACTIVE_KEY); } catch(e) {}
}

window.ccResumeLocal = function() {
  const s = ccGetActiveLocal();
  if (!s) { ccRenderHome(); return; }
  CCState.session = s;
  if (s.currentIdx >= s.items.length) ccRenderComplete();
  else ccRenderCountScreen();
};
window.ccDiscardLocal = function() {
  if (!confirm('Discard the unfinished count saved on this device? Its progress will be lost.')) return;
  ccClearActiveLocal();
  ccRenderHome();
};

// ── CONNECTION BANNER ────────────────────────────────────────
// Small pill at the bottom of the cycle count screen: offline, or counts
// waiting to upload. Hidden when everything's uploaded or on other views.
function ccUpdateNetBanner() {
  let el = document.getElementById('cc-net-banner');
  const area = document.getElementById('cc-content-area');
  const visible = area && area.offsetParent !== null;
  const waiting = Object.keys(ccGetUnsynced()).length;
  let text = '';
  if (!navigator.onLine) text = '📴 Offline — keep counting, it\'s saving on this device';
  else if (waiting) text = '⏳ ' + waiting + ' count' + (waiting > 1 ? 's' : '') + ' saved on this device, uploading…';
  if (!visible || !text) { if (el) el.style.display = 'none'; return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'cc-net-banner';
    el.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:1000;' +
      'background:#fef3c7;border:1px solid #f59e0b;color:#92400e;border-radius:20px;padding:8px 16px;' +
      'font-size:13px;font-weight:600;box-shadow:0 2px 8px rgba(0,0,0,0.15);max-width:calc(100% - 32px);text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = text;
  el.style.display = 'block';
}
window.addEventListener('offline', ccUpdateNetBanner);
window.addEventListener('online', ccUpdateNetBanner);
setInterval(ccUpdateNetBanner, 15 * 1000);

// ── SUGGEST ──────────────────────────────────────────────────

function ccSuggestSubZone() {
  // Find sub-zone counted least recently across all zones (excluding NOW)
  const eligible = CC_ZONES.filter(z => !z.manualOnly).flatMap(z => ccGetSubZones(z.id));
  if (!eligible.length) return null;
  const completedCounts = CCState.history.filter(h => h.complete);
  // Build last-counted map
  const lastCounted = {};
  for (const count of completedCounts) {
    if (!lastCounted[count.subZone] || count.submittedAt > lastCounted[count.subZone]) {
      lastCounted[count.subZone] = count.submittedAt;
    }
  }
  // Sort by oldest first (never counted = oldest)
  eligible.sort((a, b) => {
    const ta = lastCounted[a.id] || '1970-01-01';
    const tb = lastCounted[b.id] || '1970-01-01';
    return ta < tb ? -1 : ta > tb ? 1 : 0;
  });
  return eligible[0];
}

// ── FETCH LOCATIONS FROM PACKIYO ─────────────────────────────

async function ccFetchSubZoneItems(subZoneId) {
  // Pull fresh location data from Packiyo
  const result = await whFetchAll('/products?include=location_products.location', 100, () => {});
  const locNameById = {};
  for (const inc of result.allIncluded) {
    if (inc.type === 'locations') locNameById[inc.id] = inc.attributes?.name || inc.id;
  }
  const lpById = {};
  for (const inc of result.allIncluded) {
    if (inc.type === 'location-products') {
      lpById[inc.id] = {
        qty:        parseInt(inc.attributes?.quantity_on_hand ?? 0),
        locationId: inc.relationships?.location?.data?.id || null,
      };
    }
  }
  // Catalog lookup
  const catBySku = {};
  if (typeof State !== 'undefined' && State.merged) {
    State.merged.forEach(p => { if (p.packiyo_sku || p.catalog) catBySku[(p.packiyo_sku||p.catalog).toLowerCase()] = p; });
  }

  const items = [];
  for (const item of result.allData) {
    const a   = item.attributes || {};
    const sku = a.sku || '';
    if (!sku) continue;
    const cat = catBySku[sku.toLowerCase()] || null;
    for (const ref of (item.relationships?.location_products?.data || [])) {
      const lp = lpById[ref.id];
      if (!lp || !lp.locationId) continue;
      const locName = locNameById[lp.locationId] || lp.locationId;
      if (!ccLocBelongsToSubZone(locName, subZoneId)) continue;
      if (lp.qty > 0) {
        items.push({
          locName,
          sku,
          name:    a.name || '',
          artist:  cat?.artist || '',
          catalog: cat?.catalog || sku,
          upc:     (a.barcode || '').replace(/\D/g,'').padStart(12,'0'),
          expected: lp.qty,
          actual:   null,
          attempts: 0,
          status:   'pending', // pending | pass | discrepancy | skipped
        });
      }
    }
  }
  // Sort by location then product name
  items.sort((a, b) => {
    if (a.locName < b.locName) return -1;
    if (a.locName > b.locName) return 1;
    return a.name.localeCompare(b.name);
  });
  return items;
}

function ccLocBelongsToSubZone(locName, subZoneId) {
  // Exact bin match
  if (locName === subZoneId) return true;
  if (subZoneId === 'P2') return locName.startsWith('P2-');
  if (subZoneId === 'P3') return locName.startsWith('P3-');
  if (subZoneId === 'P4') return locName.startsWith('P4-');
  if (subZoneId === 'P5') return locName.startsWith('P5-');
  if (subZoneId === 'NOW') return whIsNowLoc(locName);
  // P1-A means all locations starting with P1-A-
  if (subZoneId.startsWith('P1-')) {
    const col = subZoneId.slice(3);
    return locName.startsWith('P1-' + col + '-');
  }
  // MW-01-A1 means exact slot prefix
  if (/^MW-\d{2}-[A-Z]\d+$/.test(subZoneId)) return locName.startsWith(subZoneId);
  // MW-01 fallback
  if (/^MW-\d{2}$/.test(subZoneId)) return locName.startsWith(subZoneId + '-');
  return false;
}

// ── HOME SCREEN ──────────────────────────────────────────────

function ccRenderHome() {
  const area = document.getElementById('cc-content-area');
  if (!area) return;

  const suggested = ccSuggestSubZone();
  const suggestedLabel = suggested ? suggested.label : '—';

  // Build zone selector options
  const zoneOpts = CC_ZONES.map(z =>
    '<option value="' + z.id + '">' + z.label + (z.manualOnly ? ' (manual only)' : '') + '</option>'
  ).join('');

  area.innerHTML =
    '<div style="max-width:600px;margin:0 auto;padding:32px 24px;">' +

    // Suggest card
    '<div id="cc-suggest-card" style="background:var(--accent);color:#fff;border-radius:10px;padding:24px;margin-bottom:24px;">' +
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;opacity:0.8;margin-bottom:8px;">Suggested Next Count</div>' +
    '<div class="cc-suggest-label" style="font-size:22px;font-weight:700;margin-bottom:16px;">' + ccEsc(suggestedLabel) + '</div>' +
    (suggested
      ? '<button class="cc-suggest-btn" onclick="ccStartSession(\'' + ccEsc(suggested.id) + '\')" style="background:#fff;color:var(--accent);border:none;border-radius:6px;padding:12px 28px;font-size:15px;font-weight:700;cursor:pointer;">▶ Start Count</button>'
      : '<div style="font-size:13px;opacity:0.8;">No suggestions available</div>') +
    '</div>' +

    // Manual zone select
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:20px;margin-bottom:24px;">' +
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:12px;">Count a Specific Area</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:flex-end;">' +
    '<div style="flex:1;min-width:160px;">' +
    '<label style="display:block;font-size:10px;font-weight:600;color:var(--text-muted);margin-bottom:4px;">Section</label>' +
    '<select id="cc-zone-select" onchange="ccUpdateBinSelect()" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">' +
    '<option value="">— Select —</option>' + zoneOpts +
    '</select></div>' +
    '<div style="flex:1;min-width:160px;">' +
    '<label style="display:block;font-size:10px;font-weight:600;color:var(--text-muted);margin-bottom:4px;">Bin <span style="font-weight:400;opacity:0.6;">(optional — leave blank for whole section)</span></label>' +
    '<select id="cc-bin-select" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:4px;background:var(--surface);color:var(--text);">' +
    '<option value="">— Entire section —</option>' +
    '</select></div>' +
    '</div>' +
    '<div style="margin-top:10px;text-align:right;">' +
    '<button onclick="ccStartManual()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:9px 24px;font-size:13px;font-weight:700;cursor:pointer;">▶ Start Count</button>' +
    '</div></div>' +

    // History
    '<div id="cc-history-panel">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);">Recent Counts</div>' +
    (ccIsAdmin()
      ? '<button onclick="ccRenderLog()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;">📋 Count Log</button>'
      : '') +
    '</div>' +
    '<div id="cc-history-list" style="font-size:12px;color:var(--text-muted);">Loading history…</div>' +
    '</div>' +
    '</div>';

  ccUpdateHistoryPanel();
  ccRenderResumeCard();
  ccUpdateNetBanner();
}

// Offer to pick up an unfinished count saved on this device.
function ccRenderResumeCard() {
  const s = ccGetActiveLocal();
  const area = document.getElementById('cc-content-area');
  const wrap = area && area.firstElementChild;
  if (!s || !wrap || CCState.session) return;
  const done = s.items.filter(i => i.status !== 'pending').length;
  const when = new Date(s.startedAt).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});
  const card = document.createElement('div');
  card.style.cssText = 'background:#fef3c7;border:2px solid #f59e0b;border-radius:10px;padding:20px;margin-bottom:24px;color:#92400e;';
  card.innerHTML =
    '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px;">Unfinished count on this device</div>' +
    '<div style="font-size:18px;font-weight:700;margin-bottom:4px;">' + ccEsc(s.subZone) + ' — ' + done + ' of ' + s.items.length + ' products done</div>' +
    '<div style="font-size:12px;margin-bottom:14px;">Started ' + ccEsc(when) + ' · ' + ccEsc(s.countedBy) + '</div>' +
    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
    '<button onclick="ccResumeLocal()" style="background:#b45309;color:#fff;border:none;border-radius:6px;padding:12px 24px;font-size:15px;font-weight:700;cursor:pointer;">▶ Resume Count</button>' +
    '<button onclick="ccDiscardLocal()" style="background:none;color:#92400e;border:1px solid #f59e0b;border-radius:6px;padding:12px 18px;font-size:13px;cursor:pointer;">Discard</button>' +
    '</div>';
  wrap.insertBefore(card, wrap.firstChild);
}

window.ccUpdateBinSelect = function() {
  const zoneId = document.getElementById('cc-zone-select')?.value;
  const binSel = document.getElementById('cc-bin-select');
  if (!binSel) return;
  binSel.innerHTML = '<option value="">— Entire section —</option>';
  if (!zoneId) return;

  if (!LocState.loaded) {
    binSel.innerHTML = '<option value="">— Loading location data… —</option>';
    // Retry once locations finish loading
    const check = setInterval(function() {
      if (LocState.loaded) {
        clearInterval(check);
        window.ccUpdateBinSelect();
      }
    }, 500);
    return;
  }
  const bins = Object.keys(LocState.locMap)
    .filter(loc => ccLocBelongsToZone(loc, zoneId))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  // Build last-counted map from history for the label
  const binLastCounted = {};
  for (const h of (CCState.history || [])) {
    if (!h.complete) continue;
    const ts = h.submittedAt || '';
    const by = h.countedBy || '';
    if (!binLastCounted[h.subZone] || ts > binLastCounted[h.subZone].ts) {
      binLastCounted[h.subZone] = { ts, by };
    }
  }
  bins.forEach(bin => {
    // Only show last-counted if THIS exact bin was explicitly counted
    const lc = binLastCounted[bin];
    let suffix = '';
    if (lc && lc.ts) {
      const d = new Date(lc.ts).toLocaleDateString('en-US', { month:'numeric', day:'numeric', year:'2-digit' });
      const name = lc.by.includes('@') ? lc.by.split('@')[0] : lc.by;
      suffix = ' — last counted ' + d + ' by ' + name;
    }
    binSel.innerHTML += '<option value="' + ccEsc(bin) + '">' + ccEsc(bin) + suffix + '</option>';
  });
};

// Check if a location belongs to a top-level zone
function ccLocBelongsToZone(locName, zoneId) {
  if (zoneId === 'NOW') return whIsNowLoc(locName);
  if (zoneId.startsWith('MW-')) return locName.startsWith(zoneId + '-');
  if (zoneId === 'P1') return locName.startsWith('P1-');
  if (zoneId === 'P2') return locName.startsWith('P2-');
  if (zoneId === 'P3') return locName.startsWith('P3-');
  if (zoneId === 'P4') return locName.startsWith('P4-');
  if (zoneId === 'P5') return locName.startsWith('P5-');
  return false;
}

window.ccStartManual = function() {
  const zoneId = document.getElementById('cc-zone-select')?.value;
  const binId  = document.getElementById('cc-bin-select')?.value;
  if (!zoneId) { alert('Please select a section.'); return; }
  ccStartSession(binId || zoneId);
};

// ── START SESSION ─────────────────────────────────────────────

window.ccStartSession = async function(subZoneId) {
  const area = document.getElementById('cc-content-area');
  if (!area) return;
  const unfinished = ccGetActiveLocal();
  if (unfinished && !confirm('There\'s an unfinished count for ' + unfinished.subZone + ' on this device. Start a new count and discard it?')) return;
  area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:13px;">Loading location data from Packiyo…</div>';

  try {
    const items = await ccFetchSubZoneItems(subZoneId);
    if (!items.length) {
      area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:13px;">No inventory found in ' + ccEsc(subZoneId) + '.<br><br><button onclick="ccRenderHome()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:13px;cursor:pointer;">← Back</button></div>';
      return;
    }
    CCState.session = {
      id:          'cc-' + Date.now(),
      startedAt:   new Date().toISOString(),
      countedBy:   (typeof State !== 'undefined' && State.user?.email) || 'unknown',
      zone:        subZoneId.split('-').slice(0,2).join('-'),
      subZone:     subZoneId,
      items,
      currentIdx:  0,
      complete:    false,
      submittedAt: null,
      discrepancies: [],
    };
    await ccSaveSession();
    ccRenderCountScreen();
  } catch(e) {
    area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--red);font-size:13px;">Error loading data: ' + ccEsc(e.message) + '<br><br><button onclick="ccRenderHome()" style="background:var(--accent);color:#fff;border:none;border-radius:6px;padding:10px 20px;font-size:13px;cursor:pointer;">← Back</button></div>';
  }
};

// ── COUNT SCREEN ─────────────────────────────────────────────

function ccRenderCountScreen() {
  const area = document.getElementById('cc-content-area');
  if (!area || !CCState.session) return;
  const s    = CCState.session;
  const idx  = s.currentIdx;
  const item = s.items[idx];

  if (!item) { ccRenderComplete(); return; }

  const total    = s.items.length;
  const done     = s.items.filter(i => i.status !== 'pending').length;
  const progress = Math.round((done / total) * 100);
  const locGroup = ccItemsInSameLoc(s.items, idx);
  const isNewLoc = idx === 0 || s.items[idx-1].locName !== item.locName;
  const slotDoneMsg = ccGetSlotCompleteMsg(s, idx);

  // If shell already exists, update in place to keep keyboard alive on iOS
  const existingInput = document.getElementById('cc-actual-input');
  if (existingInput) {
    // Update only the parts that change
    const prog = document.getElementById('cc-progress-bar');
    const progText = document.getElementById('cc-progress-text');
    const slotMsg = document.getElementById('cc-slot-msg');
    const locHeader = document.getElementById('cc-loc-header');
    const productTitle = document.getElementById('cc-product-title');
    const productMeta = document.getElementById('cc-product-meta');
    const expectedQty = document.getElementById('cc-expected-qty');
    const recountWarn = document.getElementById('cc-recount-warn');

    if (prog) prog.style.width = progress + '%';
    if (progText) progText.textContent = done + ' of ' + total + ' products';
    if (slotMsg) { slotMsg.textContent = slotDoneMsg || ''; slotMsg.style.display = slotDoneMsg ? 'block' : 'none'; }
    if (locHeader) { locHeader.textContent = isNewLoc ? ('📍 ' + item.locName + ' (' + locGroup + ' product' + (locGroup!==1?'s':'') + ' in this bin)') : ''; locHeader.style.display = isNewLoc ? 'block' : 'none'; }
    if (productTitle) productTitle.textContent = item.artist ? item.artist + ' — ' + item.name : item.name;
    if (productMeta) productMeta.innerHTML = '<span style="font-family:monospace;font-size:12px;color:var(--text-muted);">' + ccEsc(item.catalog) + '</span>'
      + (item.upc ? ' &nbsp;·&nbsp; <span style="font-family:monospace;font-size:12px;color:var(--text-dim);">' + item.upc + '</span>' : '')
      + ' &nbsp;·&nbsp; <span style="font-size:12px;color:var(--text-muted);">📍 ' + ccEsc(item.locName) + '</span>';
    if (expectedQty) expectedQty.textContent = item.expected;
    if (recountWarn) { recountWarn.style.display = item.attempts === 1 ? 'block' : 'none'; }
    // Clear input value for next item
    existingInput.value = '';
    existingInput.focus();
    return;
  }

  // First render — build the full shell
  area.innerHTML =
    '<div style="max-width:540px;margin:0 auto;padding:24px;">' +
    '<div style="margin-bottom:20px;">' +
    '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:6px;">' +
    '<span>' + ccEsc(s.subZone) + '</span><span id="cc-progress-text">' + done + ' of ' + total + ' products</span>' +
    '</div>' +
    '<div style="background:var(--border);border-radius:4px;height:6px;">' +
    '<div id="cc-progress-bar" style="background:var(--accent);width:' + progress + '%;height:6px;border-radius:4px;transition:width 0.3s;"></div>' +
    '</div></div>' +
    '<div id="cc-slot-msg" style="display:' + (slotDoneMsg?'block':'none') + ';background:#fef3c7;border:1px solid #f59e0b;border-radius:8px;padding:14px 16px;margin-bottom:16px;font-size:13px;font-weight:600;color:#92400e;">' + ccEsc(slotDoneMsg||'') + '</div>' +
    '<div id="cc-loc-header" style="display:' + (isNewLoc?'block':'none') + ';font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:var(--text-muted);margin-bottom:8px;">' + (isNewLoc ? '📍 ' + ccEsc(item.locName) + ' (' + locGroup + ' product' + (locGroup!==1?'s':'') + ' in this bin)' : '') + '</div>' +
    '<div style="background:var(--surface);border:2px solid var(--accent);border-radius:12px;padding:24px;margin-bottom:20px;min-height:260px;display:flex;flex-direction:column;justify-content:space-between;">' +
    '<div id="cc-product-title" style="font-size:18px;font-weight:700;color:var(--text);margin-bottom:6px;line-height:1.3;min-height:2.6em;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + ccEsc(item.artist ? item.artist + ' — ' + item.name : item.name) + '</div>' +
    '<div id="cc-product-meta" style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px;">' +
    '<span style="font-family:monospace;font-size:12px;color:var(--text-muted);">' + ccEsc(item.catalog) + '</span>' +
    (item.upc ? '<span style="font-family:monospace;font-size:12px;color:var(--text-dim);">' + item.upc + '</span>' : '') +
    '<span style="font-size:12px;color:var(--text-muted);">📍 ' + ccEsc(item.locName) + '</span>' +
    '</div>' +
    '<div style="display:flex;align-items:center;gap:16px;margin-bottom:16px;">' +
    '<div style="flex:1;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;">Expected Qty</div>' +
    '<div id="cc-expected-qty" style="font-size:36px;font-weight:900;font-family:monospace;color:var(--text);">' + item.expected + '</div></div>' +
    '<div style="flex:1;"><div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:6px;">Actual Qty</div>' +
    '<input id="cc-actual-input" type="tel" inputmode="numeric" pattern="[0-9]*" placeholder="0"' +
    ' style="width:100%;font-size:36px;font-weight:900;font-family:monospace;padding:8px 12px;border:2px solid var(--border2);border-radius:6px;background:var(--surface2);color:var(--text);text-align:center;"' +
    ' onkeydown="if(event.key===\'Enter\') ccSubmitCount()" oninput="this.value=this.value.replace(/[^0-9]/g,\'\')" autofocus />' +
    '</div></div>' +
    '<div id="cc-recount-warn" style="display:' + (item.attempts===1?'block':'none') + ';background:#fee2e2;border:1px solid var(--red);border-radius:6px;padding:10px 14px;font-size:13px;font-weight:600;color:var(--red);margin-bottom:12px;">⚠ Qty doesn\'t match. Please recount and enter again.</div>' +
    '<div style="display:flex;gap:8px;">' +
    '<button onclick="ccSubmitCount()" style="flex:1;background:var(--accent);color:#fff;border:none;border-radius:8px;padding:14px;font-size:16px;font-weight:700;cursor:pointer;">✓ Confirm Count</button>' +
    '<button onclick="ccSkipItem()" style="background:var(--surface2);color:var(--text-muted);border:1px solid var(--border2);border-radius:8px;padding:14px 18px;font-size:14px;cursor:pointer;" title="Skip this product">⟶</button>' +
    '</div></div>' +
    '<div style="text-align:center;margin-top:12px;">' +
    '<button onclick="ccAbandonSession()" style="background:none;border:none;color:var(--text-dim);font-size:11px;cursor:pointer;text-decoration:underline;">Abandon session</button>' +
    '</div></div>';

  setTimeout(() => document.getElementById('cc-actual-input')?.focus(), 100);
}

function ccItemsInSameLoc(items, idx) {
  const loc = items[idx].locName;
  return items.filter(i => i.locName === loc).length;
}

function ccGetSlotCompleteMsg(s, idx) {
  if (idx === 0) return null;
  const prev = s.items[idx - 1];
  const curr = s.items[idx];
  if (!prev || prev.status === 'pending') return null;
  // Check if previous item was last in its slot
  const prevSlot = ccGetSlot(prev.locName, s.subZone);
  const currSlot = ccGetSlot(curr.locName, s.subZone);
  if (prevSlot && currSlot && prevSlot !== currSlot) {
    return '✓ ' + prevSlot + ' complete. Now counting: ' + currSlot;
  }
  return null;
}

function ccGetSlot(locName, subZoneId) {
  // For MW: slot is e.g. MW-01-A1
  if (/^MW-\d{2}/.test(locName)) {
    const m = locName.match(/^(MW-\d{2}-[A-Z]\d+)/);
    return m ? m[1] : null;
  }
  // For P1: slot is the column e.g. P1-A
  if (locName.startsWith('P1-')) {
    const m = locName.match(/^(P1-[A-Z]+)/);
    return m ? m[1] : null;
  }
  return null;
}

// ── SUBMIT COUNT ─────────────────────────────────────────────

window.ccSubmitCount = function() {
  const s    = CCState.session;
  if (!s) return;
  const item = s.items[s.currentIdx];
  // A second Enter/tap right after the last product lands here with no
  // item left (it was throwing "Cannot set properties of undefined").
  if (!item) return;
  const val  = parseInt(document.getElementById('cc-actual-input')?.value);

  if (isNaN(val) || val < 0) {
    document.getElementById('cc-actual-input')?.focus();
    return;
  }

  item.actual   = val;
  item.attempts = (item.attempts || 0) + 1;

  if (val === item.expected) {
    item.status = 'pass';
    ccAdvance();
  } else if (item.attempts >= 2) {
    // Second fail — log discrepancy
    item.status = 'discrepancy';
    s.discrepancies.push({
      locName:  item.locName,
      sku:      item.sku,
      name:     item.name,
      artist:   item.artist,
      catalog:  item.catalog,
      upc:      item.upc,
      expected: item.expected,
      actual:   item.actual,
      variance: item.actual - item.expected,
    });
    ccAdvance();
  } else {
    // First fail — prompt recount, stay on same item
    ccSaveActiveLocal();
    ccRenderCountScreen();
  }
};

window.ccSkipItem = function() {
  const s = CCState.session;
  if (!s) return;
  s.items[s.currentIdx].status = 'skipped';
  ccAdvance();
};

async function ccAdvance() {
  const s = CCState.session;
  if (!s) return;
  s.currentIdx++;
  ccSaveActiveLocal(); // every product, on this device — no network needed
  // Auto-save progress every 5 items
  if (s.currentIdx % 5 === 0) ccSaveSession();

  if (s.currentIdx >= s.items.length) {
    ccRenderComplete();
    return;
  }

  // Check if we're about to cross into a new sub-section — prompt continue/finish
  const prev = s.items[s.currentIdx - 1];
  const curr = s.items[s.currentIdx];
  const prevSlot = ccGetSlot(prev?.locName, s.subZone);
  const currSlot = ccGetSlot(curr?.locName, s.subZone);

  if (prevSlot && currSlot && prevSlot !== currSlot) {
    ccRenderSectionPrompt(prevSlot, currSlot);
  } else {
    ccRenderCountScreen();
  }
}

// ── SECTION COMPLETE PROMPT ───────────────────────────────────

function ccRenderSectionPrompt(doneSlot, nextSlot) {
  const area = document.getElementById('cc-content-area');
  if (!area) return;
  const s = CCState.session;
  const done = s.items.filter(i => i.status !== 'pending').length;
  const total = s.items.length;

  area.innerHTML =
    '<div style="max-width:480px;margin:0 auto;padding:48px 24px;text-align:center;">' +
    '<div style="font-size:48px;margin-bottom:16px;">✅</div>' +
    '<div style="font-size:22px;font-weight:700;margin-bottom:8px;">' + ccEsc(doneSlot) + ' Complete</div>' +
    '<div style="font-size:14px;color:var(--text-muted);margin-bottom:32px;">' + done + ' of ' + total + ' products counted so far.</div>' +
    '<div style="display:flex;flex-direction:column;gap:12px;">' +
    '<button onclick="ccRenderCountScreen()" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:16px;font-size:16px;font-weight:700;cursor:pointer;">▶ Continue to ' + ccEsc(nextSlot) + '</button>' +
    '<button onclick="ccRenderComplete()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:8px;padding:16px;font-size:16px;cursor:pointer;">⏹ Finish Session</button>' +
    '</div></div>';
}

// ── COMPLETE SCREEN ───────────────────────────────────────────

// ── NEXT ZONE HELPER ──────────────────────────────────────────
// Returns a "Continue Counting →" button HTML pointing at the next
// zone in CC_ZONES after the one that was just completed.
// If the completed subZone was a specific bin (e.g. "P1-A"), we find
// the parent zone first, then advance to the next zone.
function ccNextZoneButton(subZoneId) {
  // Determine if this was a specific bin (e.g. "P2-H-01") or a whole zone (e.g. "P2").
  // A bin has more segments than its parent zone id — find parent by prefix match.
  const parentZone = CC_ZONES.find(z =>
    subZoneId === z.id || subZoneId.startsWith(z.id + '-')
  );
  if (!parentZone) return ''; // unknown — skip

  const isBin = subZoneId !== parentZone.id; // true if e.g. "P2-H-01", false if "P2"

  if (isBin) {
    // Find the next bin alphanumerically within the same parent zone.
    // All known bins in this zone come from LocState (already loaded at this point).
    const allBinsInZone = Object.keys(LocState.locMap || {})
      .filter(loc => ccLocBelongsToZone(loc, parentZone.id))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
    const curBinIdx = allBinsInZone.indexOf(subZoneId);
    const nextBin = curBinIdx >= 0 ? allBinsInZone[curBinIdx + 1] : null;

    if (nextBin) {
      // Next bin in same zone
      return '<button onclick="ccStartSession(\'' + ccEsc(nextBin) + '\')" ' +
        'style="background:var(--accent);color:#fff;border:none;border-radius:6px;' +
        'padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;">' +
        'Continue → ' + ccEsc(nextBin) + '</button>';
    }
    // No more bins in this zone — offer the next whole zone
    const parentIdx = CC_ZONES.indexOf(parentZone);
    const nextZone = CC_ZONES[parentIdx + 1];
    if (!nextZone) return ''; // was last zone
    return '<button onclick="ccStartSession(\'' + ccEsc(nextZone.id) + '\')" ' +
      'style="background:var(--accent);color:#fff;border:none;border-radius:6px;' +
      'padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;">' +
      'Continue → ' + ccEsc(nextZone.label) + ' (next section)</button>';
  }

  // Whole-zone count — advance to the next zone in the list
  const parentIdx = CC_ZONES.indexOf(parentZone);
  const nextZone = CC_ZONES[parentIdx + 1];
  if (!nextZone) return '';
  return '<button onclick="ccStartSession(\'' + ccEsc(nextZone.id) + '\')" ' +
    'style="background:var(--accent);color:#fff;border:none;border-radius:6px;' +
    'padding:8px 16px;font-size:12px;font-weight:700;cursor:pointer;">' +
    'Continue → ' + ccEsc(nextZone.label) + '</button>';
}

async function ccRenderComplete() {
  const area = document.getElementById('cc-content-area');
  if (!area || !CCState.session) return;
  const s = CCState.session;

  // Mark session complete
  s.complete    = true;
  s.submittedAt = new Date().toISOString();
  await ccSaveSession();

  // Load user list for email dropdown
  let users = [];
  try {
    const content = await fetchGistFile('fp_users.json');
    const data    = content ? JSON.parse(content) : { users: [] };
    users = data.users || [];
    // Always include admin
    if (!users.find(u => u.email === ADMIN_EMAIL)) {
      users.unshift({ email: ADMIN_EMAIL, role: 'admin' });
    }
  } catch(e) {}

  const passed      = s.items.filter(i => i.status === 'pass').length;
  const discrepant  = s.items.filter(i => i.status === 'discrepancy').length;
  const skipped     = s.items.filter(i => i.status === 'skipped').length;
  const total       = s.items.length;

  const discRows = s.discrepancies.map(d =>
    '<tr style="border-bottom:1px solid var(--border);">' +
    '<td style="padding:8px;font-size:12px;">' + ccEsc(d.locName) + '</td>' +
    '<td style="padding:8px;font-size:12px;">' + ccEsc(d.artist ? d.artist + ' — ' + d.name : d.name) + '</td>' +
    '<td style="padding:8px;font-size:12px;font-family:monospace;">' + ccEsc(d.catalog) + '</td>' +
    '<td style="padding:8px;font-size:12px;font-family:monospace;text-align:center;">' + d.expected + '</td>' +
    '<td style="padding:8px;font-size:12px;font-family:monospace;text-align:center;">' + d.actual + '</td>' +
    '<td style="padding:8px;font-size:12px;font-family:monospace;text-align:center;color:' + (d.variance > 0 ? 'var(--green)' : 'var(--red)') + ';font-weight:700;">' + (d.variance > 0 ? '+' : '') + d.variance + '</td>' +
    '</tr>'
  ).join('');

  const emailOpts = users.map(u =>
    '<option value="' + ccEsc(u.email) + '">' + ccEsc(u.email) + '</option>'
  ).join('');

  area.innerHTML =
    '<div style="max-width:680px;margin:0 auto;padding:24px;">' +

    // Header
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:24px;">' +
    '<div><div style="font-size:20px;font-weight:700;">Count Complete — ' + ccEsc(s.subZone) + '</div>' +
    '<div style="font-size:12px;color:var(--text-muted);">' + new Date(s.submittedAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) + ' · ' + ccEsc(s.countedBy) + '</div></div>' +
    '<div style="display:flex;gap:8px;">' +'<button onclick="ccRenderHome()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:8px 16px;font-size:12px;cursor:pointer;">← New Count</button>' +ccNextZoneButton(s.subZone) +'</div>' +
    '</div>' +

    // Summary stats
    '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px;">' +
    ccStatCard(total, 'Total Products', 'var(--text)') +
    ccStatCard(passed, 'Matched', 'var(--green)') +
    ccStatCard(discrepant, 'Discrepancies', discrepant > 0 ? 'var(--red)' : 'var(--green)') +
    ccStatCard(skipped, 'Skipped', 'var(--text-muted)') +
    '</div>' +

    // Discrepancies table
    (discrepant > 0
      ? '<div style="margin-bottom:24px;">' +
        '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:10px;">Discrepancies — Adjust in Packiyo</div>' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="background:var(--surface2);">' +
        '<th style="padding:8px;text-align:left;color:var(--text-muted);font-weight:600;">Location</th>' +
        '<th style="padding:8px;text-align:left;color:var(--text-muted);font-weight:600;">Product</th>' +
        '<th style="padding:8px;text-align:left;color:var(--text-muted);font-weight:600;">Catalog #</th>' +
        '<th style="padding:8px;text-align:center;color:var(--text-muted);font-weight:600;">Expected</th>' +
        '<th style="padding:8px;text-align:center;color:var(--text-muted);font-weight:600;">Actual</th>' +
        '<th style="padding:8px;text-align:center;color:var(--text-muted);font-weight:600;">Variance</th>' +
        '</tr></thead><tbody>' + discRows + '</tbody></table></div>'
      : '<div style="background:#f0fdf4;border:1px solid var(--green);border-radius:8px;padding:16px;margin-bottom:24px;font-size:14px;font-weight:600;color:var(--green);text-align:center;">✓ No discrepancies found — all counts match!</div>') +

    // Email section
    '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;">' +
    '<div style="font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-bottom:10px;">Email Report</div>' +
    '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:12px;">' +
    users.map(u =>
      '<button onclick="ccToggleRecipient(this)" data-email="' + ccEsc(u.email) + '"' +
      ' style="padding:8px 16px;border-radius:20px;font-size:13px;font-weight:600;cursor:pointer;' +
      'background:var(--surface2);color:var(--text-muted);border:1.5px solid var(--border2);transition:all 0.15s;">' +
      ccEsc(u.email) + '</button>'
    ).join('') +
    '</div>' +
    '<button onclick="ccEmailReport()" style="background:var(--accent);color:#fff;border:none;border-radius:8px;padding:12px 24px;font-size:14px;font-weight:700;cursor:pointer;width:100%;">✉ Send Report</button>' +
    '<div id="cc-email-status" style="font-size:11px;color:var(--text-muted);margin-top:8px;text-align:center;"></div>' +
    '</div>' +
    '</div>';
}

function ccStatCard(val, label, color) {
  return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:16px;text-align:center;">' +
    '<div style="font-size:28px;font-weight:900;font-family:monospace;color:' + color + ';">' + val + '</div>' +
    '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin-top:4px;">' + label + '</div>' +
    '</div>';
}

// ── EMAIL REPORT ─────────────────────────────────────────────

window.ccToggleRecipient = function(btn) {
  const active = btn.dataset.active === 'true';
  btn.dataset.active = active ? 'false' : 'true';
  btn.style.background  = active ? 'var(--surface2)' : 'var(--accent)';
  btn.style.color       = active ? 'var(--text-muted)' : '#fff';
  btn.style.borderColor = active ? 'var(--border2)' : 'var(--accent)';
};

window.ccEmailReport = async function() {
  const statusEl   = document.getElementById('cc-email-status');
  const recipients = [...document.querySelectorAll('[data-email][data-active="true"]')]
    .map(b => b.dataset.email);
  if (!recipients.length) {
    if (statusEl) statusEl.textContent = 'Please select at least one recipient.';
    return;
  }
  if (statusEl) statusEl.textContent = 'Saving…';
  const s = CCState.session;

  const discRows = s.discrepancies.map(d =>
    '<tr><td style="padding:6px 10px;border:1px solid #ddd;">' + ccEsc(d.locName) + '</td>' +
    '<td style="padding:6px 10px;border:1px solid #ddd;">' + ccEsc(d.artist ? d.artist + ' — ' + d.name : d.name) + '</td>' +
    '<td style="padding:6px 10px;border:1px solid #ddd;font-family:monospace;">' + ccEsc(d.catalog) + '</td>' +
    '<td style="padding:6px 10px;border:1px solid #ddd;text-align:center;">' + d.expected + '</td>' +
    '<td style="padding:6px 10px;border:1px solid #ddd;text-align:center;">' + d.actual + '</td>' +
    '<td style="padding:6px 10px;border:1px solid #ddd;text-align:center;font-weight:700;color:' + (d.variance > 0 ? 'green' : 'red') + ';">' + (d.variance > 0 ? '+' : '') + d.variance + '</td></tr>'
  ).join('');

  const passed     = s.items.filter(i => i.status === 'pass').length;
  const discrepant = s.discrepancies.length;
  const skipped    = s.items.filter(i => i.status === 'skipped').length;
  const dateStr    = new Date(s.submittedAt).toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});

  const html =
    '<h2 style="font-family:sans-serif;">Fat Possum — Cycle Count Report</h2>' +
    '<p style="font-family:sans-serif;color:#555;">Zone: <strong>' + ccEsc(s.subZone) + '</strong> &nbsp;·&nbsp; Date: ' + dateStr + ' &nbsp;·&nbsp; Counted by: ' + ccEsc(s.countedBy) + '</p>' +
    '<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;margin-bottom:20px;">' +
    '<tr><td style="padding:8px 16px;background:#f3f3f3;font-weight:700;">Total Products</td><td style="padding:8px 16px;">' + s.items.length + '</td></tr>' +
    '<tr><td style="padding:8px 16px;background:#f3f3f3;font-weight:700;">Matched</td><td style="padding:8px 16px;color:green;">' + passed + '</td></tr>' +
    '<tr><td style="padding:8px 16px;background:#f3f3f3;font-weight:700;">Discrepancies</td><td style="padding:8px 16px;color:' + (discrepant > 0 ? 'red' : 'green') + ';">' + discrepant + '</td></tr>' +
    '<tr><td style="padding:8px 16px;background:#f3f3f3;font-weight:700;">Skipped</td><td style="padding:8px 16px;">' + skipped + '</td></tr>' +
    '</table>' +
    (discrepant > 0
      ? '<h3 style="font-family:sans-serif;">Discrepancies — Adjust in Packiyo</h3>' +
        '<table style="border-collapse:collapse;font-family:sans-serif;font-size:13px;width:100%;">' +
        '<thead><tr style="background:#f3f3f3;"><th style="padding:8px 10px;border:1px solid #ddd;text-align:left;">Location</th><th style="padding:8px 10px;border:1px solid #ddd;text-align:left;">Product</th><th style="padding:8px 10px;border:1px solid #ddd;text-align:left;">Catalog #</th><th style="padding:8px 10px;border:1px solid #ddd;">Expected</th><th style="padding:8px 10px;border:1px solid #ddd;">Actual</th><th style="padding:8px 10px;border:1px solid #ddd;">Variance</th></tr></thead>' +
        '<tbody>' + discRows + '</tbody></table>'
      : '<p style="font-family:sans-serif;color:green;font-weight:700;">✓ No discrepancies — all counts matched.</p>');

  // Save pendingEmails to Gist — picked up by ship-notify cron
  CCState.session.pendingEmails = recipients;
  const saved = await ccSaveSession();

  if (statusEl) {
    if (saved) {
      statusEl.innerHTML = '<span style="color:var(--green);">✓ Queued — will be emailed within 30 min.</span>';
    } else {
      statusEl.innerHTML = '<span style="color:#b45309;">⏳ Saved on this device — the email will queue once the upload goes through (retries automatically).</span>';
    }
  }
};

// ── HISTORY PANEL ─────────────────────────────────────────────

function ccUpdateHistoryPanel() {
  const el = document.getElementById('cc-history-list');
  if (!el) return;
  // Include counts saved on this device that haven't uploaded yet, flagged
  // so it's clear they aren't in the shared history for others to see.
  const queued = ccGetUnsynced();
  const all = Object.values(queued).concat(CCState.history.filter(h => !queued[h.id]))
    .sort((a, b) => String(b.submittedAt || b.startedAt).localeCompare(String(a.submittedAt || a.startedAt)));
  const history = all.filter(h => h.complete).slice(0, 20);
  if (!history.length) { el.textContent = 'No completed counts yet.'; return; }
  el.innerHTML = history.map(h => {
    const d = new Date(h.submittedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});
    const disc = (h.discrepancies||[]).length;
    const unsynced = queued[h.id]
      ? ' <span title="Saved on this device only — uploading automatically" style="color:#b45309;font-weight:700;">⏳ not uploaded</span>'
      : '';
    return '<div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--border);">' +
      '<div><span style="font-weight:600;">' + ccEsc(h.subZone) + '</span> <span style="color:var(--text-dim);">· ' + d + ' · ' + ccEsc(h.countedBy) + '</span>' + unsynced + '</div>' +
      '<div>' + (disc > 0 ? '<span style="color:var(--red);font-weight:700;">' + disc + ' discrepancy' + (disc > 1 ? 'ies' : '') + '</span>' : '<span style="color:var(--green);">✓ Clean</span>') + '</div>' +
      '</div>';
  }).join('');
}

// ── ADMIN COUNT LOG ───────────────────────────────────────────
// Every session in the shared history: who, when, how long, which zone,
// and the result — with discrepancy and skipped-product detail per count.

function ccIsAdmin() {
  const email = (typeof State !== 'undefined' && State.user?.email || '').toLowerCase();
  return email === String(typeof ADMIN_EMAIL !== 'undefined' ? ADMIN_EMAIL : '').toLowerCase()
    || (typeof State !== 'undefined' && State.userRole === 'admin');
}

const CCLog = { who: '', days: '7', onlyDisc: false, unfinished: false, open: {} };

function ccLogSessions() {
  const queued = ccGetUnsynced();
  const all = Object.values(queued).concat(CCState.history.filter(h => !queued[h.id]));
  const cutoff = CCLog.days === 'all' ? 0 : Date.now() - parseInt(CCLog.days) * 86400000;
  return all.filter(h => {
    if (!h.complete && !CCLog.unfinished) return false;
    if (CCLog.who && h.countedBy !== CCLog.who) return false;
    if (CCLog.onlyDisc && !(h.discrepancies || []).length) return false;
    return new Date(h.submittedAt || h.startedAt).getTime() >= cutoff;
  }).sort((a, b) => String(b.submittedAt || b.startedAt).localeCompare(String(a.submittedAt || a.startedAt)));
}

function ccFmtTime(iso) {
  return iso ? new Date(iso).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }) : '—';
}
function ccFmtDuration(a, b) {
  if (!a || !b) return '';
  const m = Math.round((new Date(b) - new Date(a)) / 60000);
  return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

window.ccRenderLog = async function() {
  const area = document.getElementById('cc-content-area');
  if (!area) return;
  if (!ccIsAdmin()) { ccRenderHome(); return; }
  area.innerHTML = '<div style="text-align:center;padding:60px;color:var(--text-muted);font-size:13px;">Loading count log…</div>';
  await ccLoadHistory();
  ccDrawLog();
};

window.ccLogSet = function(key, val) { CCLog[key] = val; ccDrawLog(); };
window.ccLogToggle = function(id) { CCLog.open[id] = !CCLog.open[id]; ccDrawLog(); };

function ccDrawLog() {
  const area = document.getElementById('cc-content-area');
  if (!area) return;
  const queued = ccGetUnsynced();
  const people = [...new Set(CCState.history.map(h => h.countedBy).filter(Boolean))].sort();
  const rows = ccLogSessions();

  const done = rows.filter(h => h.complete);
  const withDisc = done.filter(h => (h.discrepancies || []).length).length;
  const discLines = done.reduce((n, h) => n + (h.discrepancies || []).length, 0);
  const netUnits = done.reduce((n, h) => n + (h.discrepancies || []).reduce((m, d) => m + (d.variance || 0), 0), 0);

  const sel = 'padding:8px 10px;font-size:13px;border:1px solid var(--border2);border-radius:6px;background:var(--surface);color:var(--text);';
  const chk = (key, label) =>
    '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text);cursor:pointer;">' +
    '<input type="checkbox" ' + (CCLog[key] ? 'checked ' : '') + 'onchange="ccLogSet(\'' + key + '\', this.checked)"> ' + label + '</label>';

  const cards = rows.map(h => {
    const s = ccSummarize(h);
    const disc = h.discrepancies || [];
    const skipped = ccSkippedList(h);
    const open = !!CCLog.open[h.id];
    const result = !h.complete
      ? '<span style="color:var(--text-muted);font-weight:700;">Unfinished · ' + (h.items || []).filter(i => i.status !== 'pending').length + '/' + (h.items || []).length + '</span>'
      : disc.length
        ? '<span style="color:var(--red);font-weight:700;">' + disc.length + ' discrepanc' + (disc.length > 1 ? 'ies' : 'y') + '</span>'
        : '<span style="color:var(--green);font-weight:700;">✓ Clean</span>';
    const hasDetail = disc.length || skipped.length;

    const discTable = disc.length
      ? '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin:12px 0 6px;">Discrepancies</div>' +
        '<div style="overflow-x:auto;"><table style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead><tr style="background:var(--surface2);color:var(--text-muted);">' +
        '<th style="padding:6px;text-align:left;">Location</th><th style="padding:6px;text-align:left;">Product</th><th style="padding:6px;text-align:left;">Catalog #</th>' +
        '<th style="padding:6px;">Expected</th><th style="padding:6px;">Counted</th><th style="padding:6px;">Variance</th></tr></thead><tbody>' +
        disc.map(d =>
          '<tr style="border-bottom:1px solid var(--border);">' +
          '<td style="padding:6px;">' + ccEsc(d.locName) + '</td>' +
          '<td style="padding:6px;">' + ccEsc(d.artist ? d.artist + ' — ' + d.name : d.name) + '</td>' +
          '<td style="padding:6px;font-family:monospace;">' + ccEsc(d.catalog) + '</td>' +
          '<td style="padding:6px;text-align:center;font-family:monospace;">' + d.expected + '</td>' +
          '<td style="padding:6px;text-align:center;font-family:monospace;">' + d.actual + '</td>' +
          '<td style="padding:6px;text-align:center;font-family:monospace;font-weight:700;color:' + (d.variance > 0 ? 'var(--green)' : 'var(--red)') + ';">' + (d.variance > 0 ? '+' : '') + d.variance + '</td></tr>'
        ).join('') + '</tbody></table></div>'
      : '';
    const skipList = skipped.length
      ? '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:var(--text-muted);margin:12px 0 6px;">Skipped</div>' +
        skipped.map(i => '<div style="font-size:12px;padding:3px 0;">' + ccEsc(i.locName) + ' · ' + ccEsc(i.artist ? i.artist + ' — ' + i.name : i.name) +
          ' <span style="font-family:monospace;color:var(--text-dim);">' + ccEsc(i.catalog) + '</span> · expected ' + i.expected + '</div>').join('')
      : '';

    return '<div style="background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 16px;margin-bottom:10px;">' +
      '<div ' + (hasDetail ? 'onclick="ccLogToggle(\'' + ccEsc(h.id) + '\')" ' : '') + 'style="' + (hasDetail ? 'cursor:pointer;' : '') + 'display:flex;flex-wrap:wrap;gap:6px 16px;align-items:baseline;justify-content:space-between;">' +
      '<div><span style="font-weight:700;font-size:15px;">' + ccEsc(h.subZone) + '</span>' +
      ' <span style="color:var(--text-muted);font-size:12px;">· ' + ccEsc(h.countedBy) + '</span>' +
      (queued[h.id] ? ' <span style="color:#b45309;font-size:12px;font-weight:700;">⏳ not uploaded</span>' : '') + '</div>' +
      '<div style="font-size:13px;">' + result + (hasDetail ? ' <span style="color:var(--text-dim);">' + (open ? '▾' : '▸') + '</span>' : '') + '</div>' +
      '</div>' +
      '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">' +
      ccFmtTime(h.startedAt) + (h.submittedAt ? ' → ' + new Date(h.submittedAt).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) + ' (' + ccFmtDuration(h.startedAt, h.submittedAt) + ')' : '') +
      ' · ' + s.total + ' product' + (s.total === 1 ? '' : 's') + ' · ' + s.passed + ' matched' +
      (s.recounted ? ' (' + s.recounted + ' on recount)' : '') +
      (s.skipped ? ' · <span style="color:#b45309;">' + s.skipped + ' skipped</span>' : '') +
      '</div>' +
      (open ? discTable + skipList : '') +
      '</div>';
  }).join('');

  area.innerHTML =
    '<div style="max-width:760px;margin:0 auto;padding:24px 16px;">' +
    '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:16px;">' +
    '<div style="font-size:20px;font-weight:700;">Count Log</div>' +
    '<div style="display:flex;gap:8px;">' +
    '<button onclick="ccLogExportCsv()" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;">⬇ CSV</button>' +
    '<button onclick="ccRenderHome(); ccLoadHistory();" style="background:var(--surface2);color:var(--text);border:1px solid var(--border2);border-radius:6px;padding:8px 14px;font-size:12px;cursor:pointer;">← Back</button>' +
    '</div></div>' +

    '<div style="display:flex;flex-wrap:wrap;gap:10px 16px;align-items:center;margin-bottom:16px;">' +
    '<select onchange="ccLogSet(\'who\', this.value)" style="' + sel + '"><option value="">All employees</option>' +
    people.map(p => '<option value="' + ccEsc(p) + '"' + (CCLog.who === p ? ' selected' : '') + '>' + ccEsc(p) + '</option>').join('') + '</select>' +
    '<select onchange="ccLogSet(\'days\', this.value)" style="' + sel + '">' +
    [['1','Today + yesterday'],['7','Last 7 days'],['30','Last 30 days'],['all','All time']].map(([v,l]) =>
      '<option value="' + v + '"' + (CCLog.days === v ? ' selected' : '') + '>' + l + '</option>').join('') + '</select>' +
    chk('onlyDisc', 'Discrepancies only') + chk('unfinished', 'Show unfinished') +
    '</div>' +

    '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px;">' +
    ccStatCard(done.length, 'Counts', 'var(--text)') +
    ccStatCard(done.length - withDisc, 'Clean', 'var(--green)') +
    ccStatCard(withDisc, 'With Discrepancies', withDisc ? 'var(--red)' : 'var(--green)') +
    ccStatCard((netUnits > 0 ? '+' : '') + netUnits, 'Net Units (' + discLines + ' lines)', netUnits ? 'var(--red)' : 'var(--text)') +
    '</div>' +

    (cards || '<div style="text-align:center;padding:40px;color:var(--text-muted);font-size:13px;">No counts match these filters.</div>') +
    '</div>';
}

// One row per discrepancy (and one per clean count) so it opens cleanly in
// a spreadsheet.
window.ccLogExportCsv = function() {
  const q = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"';
  const lines = [['Started','Submitted','Minutes','Employee','Zone','Products','Matched','Recounted','Skipped','Result','Location','Product','Catalog','Expected','Counted','Variance'].map(q).join(',')];
  for (const h of ccLogSessions()) {
    const s = ccSummarize(h);
    const mins = h.submittedAt ? Math.round((new Date(h.submittedAt) - new Date(h.startedAt)) / 60000) : '';
    const base = [h.startedAt, h.submittedAt || '', mins, h.countedBy, h.subZone, s.total, s.passed, s.recounted, s.skipped];
    const disc = h.discrepancies || [];
    if (!h.complete) lines.push(base.concat(['Unfinished']).map(q).join(','));
    else if (!disc.length) lines.push(base.concat(['Clean']).map(q).join(','));
    else for (const d of disc) lines.push(base.concat(['Discrepancy', d.locName, d.artist ? d.artist + ' — ' + d.name : d.name, d.catalog, d.expected, d.actual, d.variance]).map(q).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cycle-count-log-' + new Date().toISOString().slice(0, 10) + '.csv';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

window.ccAbandonSession = function() {
  if (!confirm('Abandon this count session? Progress will be lost.')) return;
  CCState.session = null;
  ccClearActiveLocal();
  ccRenderHome();
};

function ccEsc(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
// END CYCLE COUNT MODULE
