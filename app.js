/* ============================================================
   FAT POSSUM — GLOBAL INVENTORY SYSTEM
   app.js — Main application logic (Light Mode & Enhanced Alerts)
   ============================================================ */

// ── CONFIG ──────────────────────────────────────────────────
const CONFIG = {
  GOOGLE_CLIENT_ID: '955463970238-o8p7ujrhusedtkavkskjhjlh87gr1844.apps.googleusercontent.com',
  ALLOWED_DOMAIN:   'fatpossum.com',
  PACKIYO_BASE:     'https://fatpossum.app.packiyo.com/api/v1',
  PACKIYO_TOKEN:    '314|AJSEnucp8nigZM7YEkgEvWfNgH4JdTuraKYBkLp2',
  REORDER_WEEKS:    8,
  MFG_TRIGGER_MONTHS: 5,
  LEAD_TIME: { lp: 4, cd: 1.5 },
};

// ── STATE ────────────────────────────────────────────────────
const State = {
  user: null,
  packiyoProducts: [],
  orchardData: [],
  merged: [],
  movements: [],
  packiyoLoaded: false,
  orchardLoaded: false,
  sortCol: 'artist',
  sortDir: 'asc',
  mfgSortCol: 'months_left',
  mfgSortDir: 'asc',
  alertSortCol: 'weeksLeft',
  alertSortDir: 'asc',
  showSalesColumns: false, // UI Toggle State
};

// ── BOOT ─────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  document.getElementById('login-screen').classList.remove('hidden');

  const saved = sessionStorage.getItem('fp_user');
  if (saved) {
    State.user = JSON.parse(saved);
    bootApp();
  }

  // UI Event Listeners
  document.getElementById('upload-csv-btn').addEventListener('click', () => document.getElementById('csv-file-input').click());
  document.getElementById('csv-file-input').addEventListener('change', (e) => {
    if (e.target.files[0]) loadOrchardCSV(e.target.files[0]);
  });

  document.getElementById('refresh-packiyo-btn').addEventListener('click', loadPackiyo);
  document.getElementById('logout-btn').addEventListener('click', logout);

  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchView(item.dataset.view);
    });
  });

  // Inventory Controls
  document.getElementById('search-input').addEventListener('input', renderInventory);
  document.getElementById('filter-config').addEventListener('change', renderInventory);
  document.getElementById('filter-warehouse').addEventListener('change', renderInventory);
  document.getElementById('export-inventory-btn').addEventListener('click', exportInventory);

  // Global Table Sorting Logic
  document.addEventListener('click', (e) => {
    const th = e.target.closest('th.sortable');
    if (!th) return;
    
    const col = th.dataset.col;
    const table = th.closest('table').id;
    const parentAlert = th.closest('.alert-section');

    if (table === 'inventory-table') {
      if (State.sortCol === col) State.sortDir = State.sortDir === 'asc' ? 'desc' : 'asc';
      else { State.sortCol = col; State.sortDir = 'asc'; }
      updateSortHeaders('inventory-table', State.sortCol, State.sortDir);
      renderInventory();
    } else if (table === 'mfg-table') {
      if (State.mfgSortCol === col) State.mfgSortDir = State.mfgSortDir === 'asc' ? 'desc' : 'asc';
      else { State.mfgSortCol = col; State.mfgSortDir = 'asc'; }
      updateSortHeaders('mfg-table', State.mfgSortCol, State.mfgSortDir);
      renderManufacturing();
    } else if (parentAlert) {
      // Sort for Alerts
      if (State.alertSortCol === col) State.alertSortDir = State.alertSortDir === 'asc' ? 'desc' : 'asc';
      else { State.alertSortCol = col; State.alertSortDir = 'asc'; }
      renderAlerts();
    }
  });

  // Toggle Sales Columns Button (Injected into header via JS for simplicity)
  const headerActions = document.querySelector('#view-inventory .view-actions');
  const toggleBtn = document.createElement('button');
  toggleBtn.className = 'btn-secondary btn-sm';
  toggleBtn.id = 'toggle-sales-btn';
  toggleBtn.textContent = 'Show Sales Data';
  toggleBtn.addEventListener('click', () => {
    State.showSalesColumns = !State.showSalesColumns;
    toggleBtn.textContent = State.showSalesColumns ? 'Hide Sales Data' : 'Show Sales Data';
    renderInventory();
  });
  headerActions.insertBefore(toggleBtn, document.getElementById('export-inventory-btn'));

  // Movements
  document.getElementById('add-movement-btn').addEventListener('click', addMovement);
  document.getElementById('export-movements-btn').addEventListener('click', exportMovements);
  document.getElementById('clear-movements-btn').addEventListener('click', () => {
    State.movements = [];
    renderMovementsTable();
    toast('Queue cleared.');
  });
  document.getElementById('mov-product-search').addEventListener('input', debounce(updateMovementDropdown, 200));

  // Manufacturing/Alerts
  document.getElementById('mfg-filter').addEventListener('change', renderManufacturing);
  document.getElementById('export-mfg-btn').addEventListener('click', exportManufacturing);
  document.getElementById('export-
