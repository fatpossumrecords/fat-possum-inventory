# Fat Possum — Global Inventory System

A browser-based inventory management tool for Fat Possum Records, pulling live data from Packiyo and weekly CSV exports from The Orchard.

## Live App
👉 **https://fatpossumrecords.github.io/fat-possum-inventory**

## Features
- **Global Inventory** — Unified view across Fat Possum Warehouse (Packiyo) + Orchard US / CA / UK / EU
- **Reorder Alerts** — Per-warehouse alerts when stock drops below 8 weeks of velocity (based on 12MS)
- **Manufacturing Predictions** — Flags items needing a PO 5 months before global stockout; accounts for LP (4mo) vs CD (1.5mo) lead times
- **Stock Movements** — Queue and export transfer requests between warehouses
- **Google Login** — Secured via Google OAuth

## Weekly Workflow
1. Export The Orchard spreadsheet as CSV
2. Log in at the app URL
3. Click **Upload Orchard CSV** in the sidebar
4. Data is merged with live Packiyo data automatically

## Replenishment Logic
- **Fat Possum WH → Orchard US** (primary)
- **Orchard US → CA, UK, EU**
- **Orchard UK → EU** (alternate EU source)
- Manufacturing ships to Fat Possum WH (or dropship to Orchard US)

## Setup (GitHub Pages)

1. Create a new GitHub repo named `fat-possum-inventory` under the `fatpossumrecords` account
2. Upload all files from this folder
3. Go to **Settings → Pages → Source: Deploy from branch → main → / (root)**
4. In [Google Cloud Console](https://console.cloud.google.com):
   - Go to **APIs & Services → Credentials → OAuth Client ID**
   - Add `https://fatpossumrecords.github.io` to **Authorized JavaScript origins**
5. Visit `https://fatpossumrecords.github.io/fat-possum-inventory`

## Files
- `index.html` — App shell + Google Sign-In
- `styles.css` — UI styles
- `app.js` — All application logic

## Updating Packiyo Token
If the Packiyo API token changes, update line 10 of `app.js`:
```js
PACKIYO_TOKEN: 'your-new-token-here',
```
