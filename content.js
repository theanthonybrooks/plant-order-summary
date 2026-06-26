// Fetches the order JSON directly using the JWT the app stores in localStorage['currentUser']
;(() => {
  "use strict"

  const PANEL_ID = "nk-order-panel"
  const BACKEND = "https://backend.nieuwkoop-europe.com/overview/en/orders/by-id/"
  const TOKEN_KEY = "currentUser"
  let currentSummary = null
  let fetchedOrderNr = null
  let sortMode = "number" // "number" (Total desc) | "name" (A–Z)

  // Update check (compares against manifest.json in the GitHub repo).
  const REPO = "theanthonybrooks/plant-order-summary"
  const REPO_URL = `https://github.com/${REPO}`
  const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/manifest.json`
  const CURRENT_VERSION = chrome.runtime.getManifest().version
  const DAY_MS = 24 * 60 * 60 * 1000
  let latestVersion = null // newest version seen on GitHub (cached across the day)

  const DEBUG = false
  const log = (...args) => {
    if (DEBUG) console.log("[NK content]", ...args)
  }
  log("loaded on", location.href)

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------
  // Prefer the explicit ProductType field; fall back to the Itemcode prefix.
  const PRODUCT_TYPE_MAP = {
    Plants: "plant",
    Planters: "pot",
    Equipment: "pot",
    Assembly: "soil",
    "Substrates and top layers": "soil",
  }
  const PREFIX_MAP = {
    4: "plant",
    1: "plant",
    2: "plant",
    8: "plant",
    F: "plant",
    6: "pot",
    9: "soil",
  }

  const classify = (line) => {
    const pt = line && line.ProductType
    if (pt && PRODUCT_TYPE_MAP[pt]) return PRODUCT_TYPE_MAP[pt]
    const code = line && line.Itemcode ? String(line.Itemcode) : ""
    const first = code.charAt(0).toUpperCase()
    return PREFIX_MAP[first] || "other"
  }

  // note: drop a trailing size/dimension parenthetical so the same species groups together, e.g. "Strelitzia nicolai (160-190)" -> "Strelitzia nicolai".
  const normalizeName = (desc) => {
    const name = (desc || "(no description)")
      .trim()
      .replace(/\s*\(\s*\d[\d\s.,\-–x×\/]*\)\s*$/, "")
      .trim()
    return name || "(no description)"
  }

  // ---------------------------------------------------------------------------
  // Summarizer (pure)
  // ---------------------------------------------------------------------------
  const summarize = (order) => {
    const lines = Array.isArray(order.SalesOrderLines)
      ? order.SalesOrderLines
      : []
    const buckets = {
      plant: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
      pot: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
      soil: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
      other: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
    }

    for (const line of lines) {
      const bucket = buckets[classify(line)]
      const qty = Number(line.Quantity) || 0
      const isAssembled = !!line.AssemblyGroup
      const name = normalizeName(line.Description)

      let g = bucket.groups[name]
      if (!g) {
        g = bucket.groups[name] = {
          name,
          total: 0,
          assembled: 0,
          notAssembled: 0,
        }
      }
      g.total += qty
      bucket.total += qty
      if (isAssembled) {
        g.assembled += qty
        bucket.assembled += qty
      } else {
        g.notAssembled += qty
        bucket.notAssembled += qty
      }
    }

    for (const b of Object.values(buckets)) {
      b.rows = Object.values(b.groups)
    }

    return {
      orderNr: order.OrderNr || "",
      reference: order.Reference || order.ExternalReference || "",
      lineCount: lines.length,
      buckets,
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const SECTIONS = [
    { key: "plant", title: "Plants", nameLabel: "Species" },
    { key: "pot", title: "Pots", nameLabel: "Name" },
    { key: "soil", title: "Soil", nameLabel: "Name" },
    { key: "other", title: "Other", nameLabel: "Name" },
  ]

  // Row comparators selectable from the panel's sort dropdown.
  const SORTERS = {
    number: (a, b) => b.total - a.total,
    name: (a, b) => a.name.localeCompare(b.name),
  }

  const el = (tag, className, text) => {
    const n = document.createElement(tag)
    if (className) n.className = className
    if (text != null) n.textContent = text
    return n
  }

  const hideHostBackdrop = () => {
    document
      .querySelectorAll(".cdk-overlay-backdrop")
      .forEach((b) => (b.style.display = "none"))
  }

  const closeHostModal = () => {
    const cross = document.querySelector(".c-account-panel__cross")
    if (cross) cross.click()
  }

  const closePanel = () => {
    const p = document.getElementById(PANEL_ID)
    if (p) p.remove()
    closeHostModal()
  }

  const buildSectionTable = (title, bucket, nameLabel, controlEl) => {
    const wrap = el("div", "nk-section")
    const head = el("div", "nk-section-head")
    head.appendChild(el("h3", "nk-section-title", title))
    if (controlEl) head.appendChild(controlEl)
    wrap.appendChild(head)

    const table = el("table", "nk-table")
    const thead = el("thead")
    const hr = el("tr")
    ;[nameLabel || "Name", "Total", "Prepotted", "Regular"].forEach((h, i) => {
      hr.appendChild(el("th", i === 0 ? "nk-col-name" : "nk-col-num", h))
    })
    thead.appendChild(hr)
    table.appendChild(thead)

    const rows = [...bucket.rows].sort(SORTERS[sortMode] || SORTERS.number)
    const tbody = el("tbody")
    for (const r of rows) {
      const tr = el("tr")
      tr.appendChild(el("td", "nk-col-name", r.name))
      tr.appendChild(el("td", "nk-col-num", String(r.total)))
      tr.appendChild(el("td", "nk-col-num", String(r.assembled)))
      tr.appendChild(el("td", "nk-col-num", String(r.notAssembled)))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    const tfoot = el("tfoot")
    const fr = el("tr")
    fr.appendChild(el("td", "nk-col-name", "Total"))
    fr.appendChild(el("td", "nk-col-num", String(bucket.total)))
    fr.appendChild(el("td", "nk-col-num", String(bucket.assembled)))
    fr.appendChild(el("td", "nk-col-num", String(bucket.notAssembled)))
    tfoot.appendChild(fr)
    table.appendChild(tfoot)

    wrap.appendChild(table)
    return wrap
  }

  // Quote a CSV cell only when it contains a comma, quote, or newline.
  const csvCell = (value) => {
    const s = String(value ?? "")
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }

  // Export the summary as a CSV download, honoring the current sort order.
  const exportCsv = (summary) => {
    const rows = [["Section", "Name", "Total", "Prepotted", "Regular"]]
    for (const s of SECTIONS) {
      const b = summary.buckets[s.key]
      if (!b.total) continue
      const sorted = [...b.rows].sort(SORTERS[sortMode] || SORTERS.number)
      for (const r of sorted) {
        rows.push([s.title, r.name, r.total, r.assembled, r.notAssembled])
      }
      rows.push([`${s.title} total`, "", b.total, b.assembled, b.notAssembled])
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = el("a")
    a.href = url
    a.download = `order-${summary.orderNr || "summary"}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  // Standalone styles for the print window (self-contained — the host/panel CSS
  // isn't available there).
  const PRINT_CSS = `
    * { box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #1a1a1a; margin: 24px; }
    h1 { font-size: 18px; margin: 0 0 2px; }
    .meta { color: #5b6b60; font-size: 12px; margin: 0 0 16px; }
    .nk-section { margin-bottom: 18px; page-break-inside: avoid; }
    .nk-section-title { font-size: 13px; text-transform: uppercase; letter-spacing: 0.04em; color: #2f7d4f; margin: 0 0 4px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 4px 6px; border-bottom: 1px solid #eee; font-size: 12px; }
    th { text-align: right; text-transform: uppercase; font-size: 10px; color: #5b6b60; border-bottom: 1px solid #ccc; }
    .nk-col-name { text-align: left; }
    .nk-col-num { text-align: right; font-variant-numeric: tabular-nums; }
    tfoot td { font-weight: 700; border-top: 2px solid #ccc; border-bottom: none; }
  `

  // Open a clean printable window with the same tables and trigger the print dialog.
  const printSummary = (summary) => {
    const w = window.open("", "_blank", "width=820,height=900")
    if (!w) {
      alert("Pop-up blocked — allow pop-ups for this site to print.")
      return
    }
    const doc = w.document
    doc.title = `Order ${summary.orderNr}`
    const style = doc.createElement("style")
    style.textContent = PRINT_CSS
    doc.head.appendChild(style)

    const h1 = doc.createElement("h1")
    h1.textContent = `Order ${summary.orderNr}${
      summary.reference ? ` (${summary.reference})` : ""
    }`
    doc.body.appendChild(h1)
    const meta = doc.createElement("p")
    meta.className = "meta"
    meta.textContent = `${summary.lineCount} lines`
    doc.body.appendChild(meta)

    for (const s of SECTIONS) {
      const b = summary.buckets[s.key]
      if (!b.total) continue
      // buildSectionTable builds nodes in the host document; import them here.
      doc.body.appendChild(doc.importNode(buildSectionTable(s.title, b, s.nameLabel), true))
    }

    w.focus()
    setTimeout(() => w.print(), 150)
  }

  // ---------------------------------------------------------------------------
  // Update check + sharing
  // ---------------------------------------------------------------------------
  // Numeric semver-ish compare: returns >0 if a is newer than b.
  const cmpVersion = (a, b) => {
    const pa = String(a).split(".").map(Number)
    const pb = String(b).split(".").map(Number)
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const d = (pa[i] || 0) - (pb[i] || 0)
      if (d) return d
    }
    return 0
  }

  const updateAvailable = () =>
    !!latestVersion && cmpVersion(latestVersion, CURRENT_VERSION) > 0

  // Check GitHub for a newer version at most once a day; cache the result.
  const maybeCheckUpdate = async () => {
    try {
      const { nkLastCheck = 0, nkLatestVersion = null } =
        await chrome.storage.local.get(["nkLastCheck", "nkLatestVersion"])
      latestVersion = nkLatestVersion
      if (Date.now() - nkLastCheck > DAY_MS) {
        const r = await fetch(MANIFEST_URL, { cache: "no-store" })
        if (r.ok) {
          const remote = await r.json()
          latestVersion = remote.version || latestVersion
          await chrome.storage.local.set({
            nkLastCheck: Date.now(),
            nkLatestVersion: latestVersion,
          })
        }
      }
      log("update check: current", CURRENT_VERSION, "latest", latestVersion)
      // If the open panel doesn't show the banner yet, add it now.
      if (updateAvailable()) {
        const body = document.querySelector(`#${PANEL_ID} .nk-body`)
        if (body && !body.querySelector(".nk-update")) {
          body.insertBefore(buildUpdateBanner(), body.firstChild)
        }
      }
    } catch (e) {
      log("update check failed:", e && e.message)
    }
  }

  const buildUpdateBanner = () => {
    const bar = el("div", "nk-update")
    bar.appendChild(
      el("span", "nk-update-text", `Update available — v${latestVersion}`)
    )
    const link = el("a", "nk-update-link", "Get it on GitHub")
    link.href = REPO_URL
    link.target = "_blank"
    link.rel = "noopener noreferrer"
    bar.appendChild(link)
    return bar
  }

  // Build the Feather "share-2" icon as DOM nodes (avoids innerHTML so it works
  // even under the host page's Trusted Types CSP). Inherits color via currentColor.
  const SVG_NS = "http://www.w3.org/2000/svg"
  const svgEl = (tag, attrs) => {
    const n = document.createElementNS(SVG_NS, tag)
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v)
    return n
  }
  const buildShareIcon = () => {
    const svg = svgEl("svg", {
      width: "13",
      height: "13",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "2",
      "stroke-linecap": "round",
      "stroke-linejoin": "round",
      "aria-hidden": "true",
    })
    svg.appendChild(svgEl("circle", { cx: "18", cy: "5", r: "3" }))
    svg.appendChild(svgEl("circle", { cx: "6", cy: "12", r: "3" }))
    svg.appendChild(svgEl("circle", { cx: "18", cy: "19", r: "3" }))
    svg.appendChild(svgEl("line", { x1: "8.59", y1: "13.51", x2: "15.42", y2: "17.49" }))
    svg.appendChild(svgEl("line", { x1: "15.41", y1: "6.51", x2: "8.59", y2: "10.49" }))
    return svg
  }

  // Share the extension's GitHub link (native share sheet, else copy to clipboard).
  const shareExtension = async (btn) => {
    if (navigator.share) {
      try {
        await navigator.share({ title: "Nieuwkoop Order Summary", url: REPO_URL })
        return
      } catch (e) {
        if (e && e.name === "AbortError") return // user dismissed the share sheet
      }
    }
    try {
      await navigator.clipboard.writeText(REPO_URL)
      btn.classList.add("nk-copied")
      btn.title = "Link copied!"
      setTimeout(() => {
        btn.classList.remove("nk-copied")
        btn.title = "Share this extension"
      }, 1500)
    } catch {
      /* clipboard unavailable — nothing more we can do */
    }
  }

  const render = (summary) => {
    const existing = document.getElementById(PANEL_ID)
    const collapsed = existing && existing.classList.contains("nk-collapsed")
    if (existing) existing.remove()

    const panel = el("div")
    panel.id = PANEL_ID
    if (collapsed) panel.classList.add("nk-collapsed")

    const header = el("div", "nk-header")
    const title = el("div", "nk-title")
    title.appendChild(el("span", "nk-order-nr", `Order ${summary.orderNr}`))
    if (summary.reference)
      title.appendChild(el("span", "nk-ref", summary.reference))
    header.appendChild(title)

    const controls = el("div", "nk-controls")

    // Export/print dropdown.
    const menuWrap = el("div", "nk-menu-wrap")
    const menuBtn = el("button", "nk-btn", "Export ▾")
    menuBtn.title = "Export or print this summary"
    const menu = el("div", "nk-menu")
    const closeMenu = () => {
      menu.classList.remove("nk-open")
      document.removeEventListener("click", onDocClick)
    }
    const onDocClick = (e) => {
      if (!menuWrap.contains(e.target)) closeMenu()
    }
    const addItem = (label, fn) => {
      const item = el("button", "nk-menu-item", label)
      item.addEventListener("click", () => {
        closeMenu()
        fn()
      })
      menu.appendChild(item)
    }
    addItem("Export CSV", () => exportCsv(summary))
    addItem("Print", () => printSummary(summary))
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      if (menu.classList.contains("nk-open")) {
        closeMenu()
        return
      }
      menu.classList.add("nk-open")
      document.addEventListener("click", onDocClick)
    })
    menuWrap.appendChild(menuBtn)
    menuWrap.appendChild(menu)

    // Share-this-extension button (sits next to the Export dropdown).
    const shareBtn = el("button", "nk-btn nk-icon-btn")
    shareBtn.title = "Share this extension"
    shareBtn.setAttribute("aria-label", "Share this extension")
    shareBtn.appendChild(buildShareIcon())
    shareBtn.addEventListener("click", () => shareExtension(shareBtn))

    const collapseBtn = el("button", "nk-btn", collapsed ? "+" : "–")
    collapseBtn.title = "Collapse / expand"
    collapseBtn.addEventListener("click", () => {
      const isCol = panel.classList.toggle("nk-collapsed")
      collapseBtn.textContent = isCol ? "+" : "–"
    })
    const closeBtn = el("button", "nk-btn", "×")
    closeBtn.title = "Close (also closes the order details)"
    closeBtn.addEventListener("click", closePanel)
    controls.appendChild(menuWrap)
    controls.appendChild(shareBtn)
    controls.appendChild(collapseBtn)
    controls.appendChild(closeBtn)
    header.appendChild(controls)
    panel.appendChild(header)

    const body = el("div", "nk-body")

    // Show the update banner above everything if a newer version is known.
    if (updateAvailable()) body.appendChild(buildUpdateBanner())

    const strip = el("div", "nk-strip")
    const plants = summary.buckets.plant
    ;[
      ["Plants", plants.total],
      ["Prepotted", plants.assembled],
      ["Regular", plants.notAssembled],
    ].forEach(([label, value]) => {
      const cell = el("div", "nk-stat")
      cell.appendChild(el("div", "nk-stat-num", String(value)))
      cell.appendChild(el("div", "nk-stat-label", label))
      strip.appendChild(cell)
    })
    body.appendChild(strip)

    // A single sort dropdown, shown on the first populated section's title row.
    const sortSelect = el("select", "nk-sort")
    ;[
      ["number", "By number"],
      ["name", "By name"],
    ].forEach(([value, label]) => {
      const opt = el("option", null, label)
      opt.value = value
      sortSelect.appendChild(opt)
    })
    sortSelect.value = sortMode
    sortSelect.addEventListener("change", () => {
      sortMode = sortSelect.value
      render(summary)
    })

    let isFirstSection = true
    for (const s of SECTIONS) {
      const b = summary.buckets[s.key]
      if (!b.total) continue
      body.appendChild(
        buildSectionTable(s.title, b, s.nameLabel, isFirstSection ? sortSelect : null)
      )
      isFirstSection = false
    }

    panel.appendChild(body)
    document.body.appendChild(panel)
    hideHostBackdrop()
  }

  const renderMessage = (message) => {
    const existing = document.getElementById(PANEL_ID)
    if (existing) existing.remove()
    const panel = el("div")
    panel.id = PANEL_ID
    const header = el("div", "nk-header")
    const title = el("div", "nk-title")
    title.appendChild(el("span", "nk-order-nr", "Order summary"))
    header.appendChild(title)
    const controls = el("div", "nk-controls")
    const closeBtn = el("button", "nk-btn", "×")
    closeBtn.title = "Close (also closes the order details)"
    closeBtn.addEventListener("click", closePanel)
    controls.appendChild(closeBtn)
    header.appendChild(controls)
    panel.appendChild(header)
    const body = el("div", "nk-body")
    body.appendChild(el("div", "nk-empty", message))
    panel.appendChild(body)
    document.body.appendChild(panel)
    hideHostBackdrop()
  }

  // ---------------------------------------------------------------------------
  // Data fetching (direct, authenticated)
  // ---------------------------------------------------------------------------
  const getToken = () => {
    try {
      const raw = localStorage.getItem(TOKEN_KEY)
      if (!raw) return null
      if (raw.charAt(0) === "{") {
        try {
          const obj = JSON.parse(raw)
          return obj.token || obj.access_token || obj.jwt || obj.accessToken || null
        } catch {
          return null
        }
      }
      return raw
    } catch {
      return null
    }
  }

  const currentOrderNr = () => {
    const segs = location.pathname.split("/").filter(Boolean)
    const last = segs[segs.length - 1]
    return /^\d+$/.test(last || "") ? last : null
  }

  // Fetch + summarize order `orderNr`. Resolves true on success, false otherwise.
  const fetchOrder = async (orderNr) => {
    const token = getToken()
    if (!token) {
      log(`no JWT in localStorage['${TOKEN_KEY}'] — are you logged in?`)
      return false
    }
    const url = BACKEND + orderNr
    log("fetching", url)
    try {
      const r = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: token,
          Accept: "application/json, text/plain, */*",
        },
        credentials: "omit",
      })
      if (!r.ok) throw new Error(`HTTP ${r.status}`)
      const order = await r.json()
      if (!order || !Array.isArray(order.SalesOrderLines)) {
        log("fetched, but not an order object", order)
        return false
      }
      currentSummary = summarize(order)
      fetchedOrderNr = orderNr
      log("fetched order", currentSummary.orderNr, "—", currentSummary.lineCount, "lines")
      if (document.getElementById(PANEL_ID)) render(currentSummary)
      return true
    } catch (e) {
      log("fetch failed:", e && e.message)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Toggle (toolbar icon) + initial prefetch
  // ---------------------------------------------------------------------------
  const togglePanel = async () => {
    if (document.getElementById(PANEL_ID)) {
      log("toggle: closing panel + host modal")
      closePanel()
      return
    }
    maybeCheckUpdate() // fire-and-forget; throttled to once a day
    const orderNr = currentOrderNr()
    if (currentSummary && fetchedOrderNr === orderNr) {
      log("toggle: opening cached summary for order", orderNr)
      render(currentSummary)
      return
    }
    if (!orderNr) {
      chrome.runtime.sendMessage({ type: "nk-no-order" })
      return
    }
    log("toggle: fetching order", orderNr)
    renderMessage(`Loading order ${orderNr}…`)
    const ok = await fetchOrder(orderNr)
    if (!document.getElementById(PANEL_ID)) return
    if (ok) render(currentSummary)
    else
      renderMessage(
        `Couldn't load order ${orderNr}. Make sure you're logged in and viewing a valid order.`
      )
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.type === "nk-toggle") {
      togglePanel()
      sendResponse({ ok: true })
    }
  })

  // Prefetch on load so the first toggle is instant (panel stays closed).
  const orderNr = currentOrderNr()
  if (orderNr) fetchOrder(orderNr)
})()
