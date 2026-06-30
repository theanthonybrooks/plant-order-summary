# Nieuwkoop Order Summary

A Chrome extension that adds a floating summary panel to:

1. **Nieuwkoop order pages**
2. **Nieuwkoop checkout basket pages**

To give you a quick overview of the plant, pot, soil, and accessory counts.
Plants, pots, and soil are split into **Prepotted** vs **Regular**, whereas
accessories only count the number. Additionally, you have optional sorting by
name/total, backorder alerts at checkout, CSV export, and print.

## Installing (sideloading) in Chrome

This extension isn't on the Chrome Web Store, so you load it as an "unpacked"
extension. This also works in any Chromium-based browser (Edge, Brave, Opera).

1. **Get the files.** Download this zip file using the green <> Code button.
   Once you have the zip file, extract it to a folder on your computer. Keep all
   the files together in that folder.
2. **Open the Extensions page.** Go to `chrome://extensions` (type it into the
   address bar and press Enter). On Edge it's `edge://extensions`.
3. **Turn on Developer mode.** Toggle the **Developer mode** switch in the
   top-right corner.
4. **Load it.** Click **Load unpacked**, then select this project folder (the
   one containing `manifest.json`). The "Nieuwkoop Order Summary" card should
   appear — it may take a moment to show up.
5. **Pin it (optional).** Click the puzzle-piece icon in the toolbar and pin
   "Nieuwkoop Order Summary" so its icon is always visible.

## Project structure

The extension files live at the project root (so "Load unpacked" points straight
at this folder):

```
manifest.json     extension manifest
background.js     service worker (toolbar icon + badge logic)
content.js        the panel: fetch, summarize, render, sort, export, print
panel.css         panel styles
icons/            toolbar icons
```

## Using it

1. Log in at [www.nieuwkoop-europe.com](https://www.nieuwkoop-europe.com) and
   open a specific **order** page.
2. Click the extension's toolbar icon to toggle the summary panel.
   - If you click it while on the site but **without an order open**, the icon
     shows a red `!` badge reminding you to open an order first.
3. In the panel you can:
   - **Sort** the tables by number (default) or by name, using the dropdown on
     the first section's title row.
   - **Export → Export CSV** to download the summary as a spreadsheet.
   - **Export → Print** to open a clean printable view.
     - Note: Print opens a popup window — allow popups for the site if your
       browser blocks it.
   - **Share** (the icon next to Export) to share/copy the link to this
     extension's GitHub page so others can install it.

## Updating

The extension checks GitHub for a newer version about once a day. When one is
available, a banner appears at the top of the panel with a link to the repo.

Updating itself is manual (an unpacked extension can't replace itself):

1. Download/pull the latest files into the same folder.
2. Go to `chrome://extensions` and click the **reload** (↻) icon on the
   extension's card.
3. Refresh any open Nieuwkoop tabs so the latest content script loads.

## Troubleshooting

- **Clicking the icon does nothing on an order page** — reload the tab. Content
  scripts only attach to pages opened/refreshed after the extension was loaded.
- **"Couldn't load order…"** — make sure you're logged in and viewing a valid
  order; the panel fetches order data using your logged-in session.
- **Print does nothing** — your browser likely blocked the popup. Allow popups
  for `www.nieuwkoop-europe.com` and try again.

## What it can access

The extension runs only on `www.nieuwkoop-europe.com` and reads order and cart
data from `backend.nieuwkoop-europe.com` using the session token the site
already stores in your browser. It doesn't send your data anywhere else. For
update checks it makes a plain read request to the project's public
`manifest.json` on GitHub to compare version numbers — no account or order data
is included.

It is **read-only**: it only reads order data to display, export, or print a
summary. It cannot and does not act on your behalf — it never creates, edits,
places, cancels, or otherwise changes anything in your account or on the site.
