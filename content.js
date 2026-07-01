//TODO: potential improvements:
// [] disable the finalize button when there's an undismissed assembly warning (or a backorder warning)
// [] assembly breakdowns
// [] plant breakdowns to show different sizes if they exist

;(() => {
  "use strict"

  const PANEL_ID = "nk-order-panel"
  const BACKEND =
    "https://backend.nieuwkoop-europe.com/overview/en/orders/by-id/"
  const TOKEN_KEY = "currentUser"
  let currentSummary = null
  let fetchedOrderNr = null
  let sortMode = "number"
  let backorderOpen = true // expanded by default so the warning is visible

  // Panel layout (float vs docked, position) persisted across reloads.
  //   { mode: "float" | "dock", side: "left" | "right", x, y }
  const LAYOUT_KEY = "nkPanelLayout"
  const loadLayout = () => {
    try {
      return JSON.parse(localStorage.getItem(LAYOUT_KEY)) || {}
    } catch {
      return {}
    }
  }
  const saveLayout = (patch) => {
    const next = { ...loadLayout(), ...patch }
    try {
      localStorage.setItem(LAYOUT_KEY, JSON.stringify(next))
    } catch {
      /* storage unavailable — layout just won't persist */
    }
    return next
  }
  const clearDockMargin = () => {
    const html = document.documentElement
    html.style.marginLeft = ""
    html.style.marginRight = ""
    // Restore the body width we override while docked (see applyLayout).
    document.body.style.width = ""
  }

  const REPO = "theanthonybrooks/plant-order-summary"
  const REPO_URL = `https://github.com/${REPO}`
  const MANIFEST_URL = `https://raw.githubusercontent.com/${REPO}/main/manifest.json`
  const CURRENT_VERSION = chrome.runtime.getManifest().version
  const DAY_MS = 24 * 60 * 60 * 1000
  let latestVersion = null

  // Enable verbose logging with `localStorage.nkDebug = "1"` then reload.
  const DEBUG = (() => {
    try {
      return localStorage.getItem("nkDebug") === "1"
    } catch {
      return false
    }
  })()
  const log = (...args) => {
    if (DEBUG) console.log("[NK content]", ...args)
  }
  log("loaded on", location.href)

  // ---------------------------------------------------------------------------
  // Classification
  // ---------------------------------------------------------------------------
  // Prefer the explicit ProductType field; fall back to the item-code prefix.
  const PRODUCT_TYPE_MAP = {
    Plants: "plant",
    Planters: "pot",
    Equipment: "accessory",
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
    const pt =
      (line && line.ProductType) ||
      (line && line.productType && line.productType.name)
    if (pt && PRODUCT_TYPE_MAP[pt]) return PRODUCT_TYPE_MAP[pt]
    const code = line
      ? String(line.Itemcode || (line.variant && line.variant.sku) || "")
      : ""
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
  const emptyBuckets = () => ({
    plant: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
    pot: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
    soil: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
    accessory: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
    other: { groups: {}, total: 0, assembled: 0, notAssembled: 0 },
  })

  const addToBucket = (bucket, name, qty, isAssembled, assemblyLabel) => {
    let g = bucket.groups[name]
    if (!g) {
      g = bucket.groups[name] = {
        name,
        total: 0,
        assembled: 0,
        notAssembled: 0,
        assemblies: {},
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
    if (assemblyLabel) g.assemblies[assemblyLabel] = (g.assemblies[assemblyLabel] || 0) + qty
  }

  // Turn a row's `label -> qty` map into a sorted [{ label, qty }] list
  // (natural sort so "Assembly 2" precedes "Assembly 10").
  const finalizeRows = (bucket) => {
    bucket.rows = Object.values(bucket.groups).map((g) => ({
      ...g,
      assemblies: Object.entries(g.assemblies)
        .map(([label, qty]) => ({ label, qty }))
        .sort((a, b) =>
          a.label.localeCompare(b.label, undefined, { numeric: true })
        ),
    }))
  }

  const summarize = (order) => {
    const lines = Array.isArray(order.SalesOrderLines)
      ? order.SalesOrderLines
      : []
    const buckets = emptyBuckets()

    for (const line of lines) {
      // AssemblyGroup looks like "AS:<GroupID>|Assembly 24 - Soil (Vulkastrat)".
      const label = line.AssemblyGroup
        ? String(line.AssemblyGroup).split("|")[1] || null
        : null
      addToBucket(
        buckets[classify(line)],
        normalizeName(line.Description),
        Number(line.Quantity) || 0,
        !!line.AssemblyGroup,
        label && label.trim()
      )
    }

    for (const b of Object.values(buckets)) finalizeRows(b)

    const orderNr = order.OrderNr || ""
    return {
      title: orderNr ? `Order ${orderNr}` : "Order summary",
      orderNr,
      reference: order.Reference || order.ExternalReference || "",
      lineCount: lines.length,
      buckets,
    }
  }

  // Resolve when a short line is expected to be coverable.
  //   tier 1: MRP custom field ("YYYY-MM-DD|projectedQty" snapshots) → exact date
  //            covering `need` (quantity-aware).
  //   tier 2: restockableInDays → approximate timing, quantity NOT confirmed.
  //   tier 3: nothing → unknown.
  // `key` is a stable string for grouping; `sort` orders date < days < unknown.
  const resolveRestock = (variant, need) => {
    const av = (variant && variant.availability) || {}
    const fields = (av.custom && av.custom.customFieldsRaw) || []
    const mrp = fields.find((f) => f && f.name === "MRP")
    const rows = (mrp && Array.isArray(mrp.value) ? mrp.value : [])
      .map((s) => {
        const [date, qty] = String(s).split("|")
        return { date, qty: Number(qty) || 0 }
      })
      .filter((r) => r.date)
      .sort((a, b) => a.date.localeCompare(b.date))
    for (const r of rows)
      if (r.qty >= need)
        return {
          type: "date",
          date: r.date,
          key: `d:${r.date}`,
          sort: [0, r.date],
        }

    const days = Number((av.noChannel && av.noChannel.restockableInDays) || 0)
    if (days > 0)
      return {
        type: "days",
        days,
        key: `n:${days}`,
        sort: [1, String(days).padStart(6, "0")],
      }

    return { type: "unknown", key: "u", sort: [2, ""] }
  }

  const collectBackorders = (items) => {
    const groups = {}
    for (const line of items) {
      const nc =
        line.variant &&
        line.variant.availability &&
        line.variant.availability.noChannel
      if (!nc) continue
      const qty = Number(line.quantity) || 0
      const avail = Number(nc.availableQuantity) || 0
      if (avail >= qty) continue
      const name = normalizeName(line.name)
      const restock = resolveRestock(line.variant, qty)
      const key = `${name}|${restock.key}`
      let g = groups[key]
      if (!g) g = groups[key] = { name, short: 0, restock }
      g.short += qty - avail
    }
    return Object.values(groups).sort((a, b) => {
      const [at, av] = a.restock.sort
      const [bt, bv] = b.restock.sort
      return at - bt || av.localeCompare(bv) || a.name.localeCompare(b.name)
    })
  }

  // Read the GroupID custom field a line item carries (which assembly it's in).
  const lineGroupId = (line) => {
    const fields = (line.custom && line.custom.customFieldsRaw) || []
    const f = fields.find((x) => x && x.name === "GroupID")
    return f ? f.value : null
  }

  // Map GroupID -> human label from the cart's `assemblyGroups` field
  // (entries look like "<GroupID> | <label> | a | b | c").
  const parseAssemblyLabels = (cartFields) => {
    const labels = {}
    const ag = (cartFields || []).find((f) => f && f.name === "assemblyGroups")
    if (ag && Array.isArray(ag.value))
      for (const entry of ag.value) {
        const parts = String(entry)
          .split("|")
          .map((s) => s.trim())
        if (parts[0]) labels[parts[0]] = parts[1] || "Assembly"
      }
    return labels
  }

  // Flag assemblies whose plant quantity exceeds their pot quantity — usually the
  // site glitch where multiple plants land in a single pot. Every assembly is
  // expected to hold at least one plant, pot, and substrate.
  const collectAssemblyWarnings = (items, cartFields) => {
    const labels = parseAssemblyLabels(cartFields)

    const groups = {}
    for (const line of items) {
      const gid = lineGroupId(line)
      if (!gid) continue
      const g = groups[gid] || (groups[gid] = { plantQty: 0, potQty: 0 })
      const qty = Number(line.quantity) || 0
      const kind = classify(line)
      if (kind === "plant") g.plantQty += qty
      else if (kind === "pot") g.potQty += qty
    }

    return Object.entries(groups)
      .filter(([, g]) => g.plantQty > g.potQty)
      .map(([gid, g]) => ({
        groupId: gid,
        label: labels[gid] || "Assembly",
        plantQty: g.plantQty,
        potQty: g.potQty,
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }

  const summarizeCart = (cart) => {
    const items = Array.isArray(cart.lineItems) ? cart.lineItems : []
    const cartFields = (cart.custom && cart.custom.customFieldsRaw) || []
    const labels = parseAssemblyLabels(cartFields)
    const buckets = emptyBuckets()

    for (const line of items) {
      const gid = lineGroupId(line)
      addToBucket(
        buckets[classify(line)],
        normalizeName(line.name),
        Number(line.quantity) || 0,
        !!gid,
        gid ? labels[gid] || null : null
      )
    }

    for (const b of Object.values(buckets)) finalizeRows(b)

    return {
      title: "Basket",
      orderNr: "",
      reference: "",
      isCart: true,
      lineCount:
        cart.totalQuantityLineItems != null
          ? cart.totalQuantityLineItems
          : items.length,
      buckets,
      backorders: collectBackorders(items),
      assemblyWarnings: collectAssemblyWarnings(items, cartFields),
    }
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------
  const SECTIONS = [
    { key: "plant", title: "Plants", nameLabel: "Species" },
    { key: "pot", title: "Pots", nameLabel: "Name" },
    { key: "soil", title: "Soil", nameLabel: "Name" },
    { key: "accessory", title: "Accessories", nameLabel: "Name", simple: true },
    { key: "other", title: "Other", nameLabel: "Name" },
  ]

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
    clearDockMargin()
    closeHostModal()
  }

  const buildSectionTable = (title, bucket, nameLabel, controlEl, simple) => {
    const wrap = el("div", "nk-section")
    const head = el("div", "nk-section-head")
    head.appendChild(el("h3", "nk-section-title", title))
    if (controlEl) head.appendChild(controlEl)
    wrap.appendChild(head)

    const headers = simple
      ? [nameLabel || "Name", "Total"]
      : [nameLabel || "Name", "Total", "Prepotted", "Regular"]
    const table = el("table", "nk-table")
    const thead = el("thead")
    const hr = el("tr")
    headers.forEach((h, i) => {
      hr.appendChild(el("th", i === 0 ? "nk-col-name" : "nk-col-num", h))
    })
    thead.appendChild(hr)
    table.appendChild(thead)

    const colCount = simple ? 2 : 4
    const rows = [...bucket.rows].sort(SORTERS[sortMode] || SORTERS.number)
    const tbody = el("tbody")
    for (const r of rows) {
      const hasAssembly = r.assemblies && r.assemblies.length > 0
      const tr = el("tr", "nk-row")

      const nameCell = el("td", "nk-col-name")
      if (hasAssembly) {
        tr.classList.add("nk-has-assembly")
        const caret = el("span", "nk-row-caret", "▸")
        nameCell.appendChild(caret)
        nameCell.appendChild(document.createTextNode(r.name))

        // Detail row listing each assembly this item belongs to, with per-assembly
        // quantity. Hidden until the row is toggled open.
        const detail = el("tr", "nk-row-detail")
        const cell = el("td")
        cell.colSpan = colCount
        const list = el("div", "nk-assembly-list")
        for (const a of r.assemblies) {
          const line = el("div")
          line.appendChild(document.createTextNode(a.label))
          line.appendChild(el("span", "nk-qty", `×${a.qty}`))
          list.appendChild(line)
        }
        cell.appendChild(list)
        detail.appendChild(cell)

        nameCell.addEventListener("click", () => {
          const open = tr.classList.toggle("nk-open")
          detail.classList.toggle("nk-open", open)
          caret.textContent = open ? "▾" : "▸"
        })

        tr.appendChild(nameCell)
        tr.appendChild(el("td", "nk-col-num", String(r.total)))
        if (!simple) {
          tr.appendChild(el("td", "nk-col-num", String(r.assembled)))
          tr.appendChild(el("td", "nk-col-num", String(r.notAssembled)))
        }
        tbody.appendChild(tr)
        tbody.appendChild(detail)
        continue
      }

      nameCell.textContent = r.name
      tr.appendChild(nameCell)
      tr.appendChild(el("td", "nk-col-num", String(r.total)))
      if (!simple) {
        tr.appendChild(el("td", "nk-col-num", String(r.assembled)))
        tr.appendChild(el("td", "nk-col-num", String(r.notAssembled)))
      }
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)

    const tfoot = el("tfoot")
    const fr = el("tr")
    fr.appendChild(el("td", "nk-col-name", "Total"))
    fr.appendChild(el("td", "nk-col-num", String(bucket.total)))
    if (!simple) {
      fr.appendChild(el("td", "nk-col-num", String(bucket.assembled)))
      fr.appendChild(el("td", "nk-col-num", String(bucket.notAssembled)))
    }
    tfoot.appendChild(fr)
    table.appendChild(tfoot)

    wrap.appendChild(table)
    return wrap
  }

  const fmtDate = (iso) => {
    const d = new Date(`${iso}T00:00:00`)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      year: "numeric",
    })
  }

  const restockLabel = (r) =>
    r.type === "date"
      ? fmtDate(r.date)
      : r.type === "days"
        ? `~${r.days} day${r.days === 1 ? "" : "s"}`
        : "Unknown"

  const buildAssemblyWarning = (list) => {
    const wrap = el("div", "nk-assembly")
    for (const w of list) {
      const item = el("div", "nk-assembly-item")
      const text = el("span", "nk-assembly-text")
      text.appendChild(el("strong", null, w.label))
      text.appendChild(
        document.createTextNode(
          ` has ${w.plantQty} plant${w.plantQty === 1 ? "" : "s"} but only ` +
            `${w.potQty} pot${w.potQty === 1 ? "" : "s"}.`
        )
      )
      const dismiss = el("button", "nk-assembly-dismiss", "×")
      dismiss.title = "Dismiss"
      dismiss.setAttribute("aria-label", "Dismiss warning")
      dismiss.addEventListener("click", () => {
        item.remove()
        if (!wrap.querySelector(".nk-assembly-item")) {
          const panel = document.getElementById(PANEL_ID)
          if (panel) panel.classList.remove("nk-warn-assembly")
        }
      })
      item.appendChild(el("span", "nk-assembly-icon", "⚠"))
      item.appendChild(text)
      item.appendChild(dismiss)
      wrap.appendChild(item)
    }
    return wrap
  }

  const buildBackorderSection = (list) => {
    const wrap = el("div", "nk-backorder")
    if (backorderOpen) wrap.classList.add("nk-open")

    const totalShort = list.reduce((n, g) => n + g.short, 0)
    const head = el("button", "nk-backorder-head")
    head.appendChild(
      el(
        "span",
        "nk-backorder-title",
        `⚠ Backordered: ${list.length} item${
          list.length === 1 ? "" : "s"
        } (${totalShort} unavailable)`
      )
    )
    const toggle = el("span", "nk-backorder-toggle", backorderOpen ? "-" : "+")
    head.appendChild(toggle)
    head.addEventListener("click", () => {
      backorderOpen = !backorderOpen
      wrap.classList.toggle("nk-open", backorderOpen)
      toggle.textContent = backorderOpen ? "-" : "+"
    })
    wrap.appendChild(head)

    const bodyEl = el("div", "nk-backorder-body")
    const table = el("table", "nk-table")
    const thead = el("thead")
    const hr = el("tr")
    ;["Item", "Short", "Restock"].forEach((h, i) => {
      hr.appendChild(el("th", i === 0 ? "nk-col-name" : "nk-col-num", h))
    })
    thead.appendChild(hr)
    table.appendChild(thead)

    const tbody = el("tbody")
    for (const g of list) {
      const tr = el("tr")
      tr.appendChild(el("td", "nk-col-name", g.name))
      tr.appendChild(el("td", "nk-col-num", String(g.short)))
      tr.appendChild(el("td", "nk-col-num", restockLabel(g.restock)))
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    bodyEl.appendChild(table)
    wrap.appendChild(bodyEl)
    return wrap
  }

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
        rows.push(
          s.simple
            ? [s.title, r.name, r.total, "", ""]
            : [s.title, r.name, r.total, r.assembled, r.notAssembled]
        )
      }
      rows.push(
        s.simple
          ? [`${s.title} total`, "", b.total, "", ""]
          : [`${s.title} total`, "", b.total, b.assembled, b.notAssembled]
      )
    }
    const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n")
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = el("a")
    a.href = url
    a.download = `${
      summary.orderNr ? `order-${summary.orderNr}` : "basket-summary"
    }.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

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

  const printSummary = (summary) => {
    const w = window.open("", "_blank", "width=820,height=900")
    if (!w) {
      alert("Pop-up blocked — allow pop-ups for this site to print.")
      return
    }
    const doc = w.document
    doc.title = summary.title
    const style = doc.createElement("style")
    style.textContent = PRINT_CSS
    doc.head.appendChild(style)

    const h1 = doc.createElement("h1")
    h1.textContent = `${summary.title}${
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
      doc.body.appendChild(
        doc.importNode(
          buildSectionTable(s.title, b, s.nameLabel, null, s.simple),
          true
        )
      )
    }

    w.focus()
    setTimeout(() => w.print(), 150)
  }

  // ---------------------------------------------------------------------------
  // Update check + sharing
  // ---------------------------------------------------------------------------
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
    svg.appendChild(
      svgEl("line", { x1: "8.59", y1: "13.51", x2: "15.42", y2: "17.49" })
    )
    svg.appendChild(
      svgEl("line", { x1: "15.41", y1: "6.51", x2: "8.59", y2: "10.49" })
    )
    return svg
  }

  const shareExtension = async (btn) => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: "Nieuwkoop Order Summary",
          url: REPO_URL,
        })
        return
      } catch (e) {
        if (e && e.name === "AbortError") return
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

  // Position/dock the panel to match the saved layout, and shift the host page
  // when docked so the summary sits beside the content instead of over it.
  const applyLayout = (panel) => {
    const layout = loadLayout()
    const mode = layout.mode === "dock" ? "dock" : "float"

    if (mode === "float") {
      panel.classList.remove("nk-docked", "nk-dock-left", "nk-dock-right")
      clearDockMargin()
      if (typeof layout.x === "number" && typeof layout.y === "number") {
        const maxX = Math.max(0, window.innerWidth - panel.offsetWidth)
        const maxY = Math.max(0, window.innerHeight - 40)
        panel.style.left = `${Math.min(Math.max(0, layout.x), maxX)}px`
        panel.style.top = `${Math.min(Math.max(0, layout.y), maxY)}px`
        panel.style.right = "auto"
      }
      return
    }

    const side = layout.side === "left" ? "left" : "right"
    panel.style.left = ""
    panel.style.top = ""
    panel.style.right = ""
    panel.classList.add("nk-docked")
    panel.classList.toggle("nk-dock-left", side === "left")
    panel.classList.toggle("nk-dock-right", side === "right")
    clearDockMargin()
    // While collapsed the docked bar is short — release the margin so the page
    // reclaims the space; the bar just overlays the edge until re-expanded.
    if (!panel.classList.contains("nk-collapsed")) {
      document.documentElement.style[
        side === "left" ? "marginLeft" : "marginRight"
      ] = `${panel.offsetWidth}px`
      // The host body is `width: 100vw`, which ignores the margin above; force
      // it to fill the (now narrower) content box so the page actually shifts.
      document.body.style.width = "100%"
    }
  }

  // Drag the header to move the panel (float mode only). Shares `state.didDrag`
  // with the click-to-expand handler so a drag doesn't also expand the panel.
  const enableDrag = (panel, header, state) => {
    header.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return
      if (e.target.closest(".nk-controls")) return
      if (panel.classList.contains("nk-docked")) return
      const rect = panel.getBoundingClientRect()
      const startX = e.clientX
      const startY = e.clientY
      state.didDrag = false

      const onMove = (ev) => {
        const dx = ev.clientX - startX
        const dy = ev.clientY - startY
        if (!state.didDrag && Math.abs(dx) + Math.abs(dy) < 4) return
        state.didDrag = true
        panel.classList.add("nk-dragging")
        const maxX = Math.max(0, window.innerWidth - panel.offsetWidth)
        const maxY = Math.max(0, window.innerHeight - panel.offsetHeight)
        const x = Math.min(Math.max(0, rect.left + dx), maxX)
        const y = Math.min(Math.max(0, rect.top + dy), maxY)
        panel.style.left = `${x}px`
        panel.style.top = `${y}px`
        panel.style.right = "auto"
      }
      const onUp = () => {
        document.removeEventListener("mousemove", onMove)
        document.removeEventListener("mouseup", onUp)
        panel.classList.remove("nk-dragging")
        if (state.didDrag) {
          const rect2 = panel.getBoundingClientRect()
          saveLayout({ mode: "float", x: rect2.left, y: rect2.top })
        }
        // Let the trailing click read didDrag, then reset it.
        setTimeout(() => {
          state.didDrag = false
        }, 0)
      }
      document.addEventListener("mousemove", onMove)
      document.addEventListener("mouseup", onUp)
    })
  }

  const render = (summary) => {
    const existing = document.getElementById(PANEL_ID)
    const collapsed = existing && existing.classList.contains("nk-collapsed")
    if (existing) existing.remove()

    const panel = el("div")
    panel.id = PANEL_ID
    if (collapsed) panel.classList.add("nk-collapsed")
    // Status classes tint the header while the panel is collapsed (red wins).
    if (summary.assemblyWarnings && summary.assemblyWarnings.length)
      panel.classList.add("nk-warn-assembly")
    if (summary.backorders && summary.backorders.length)
      panel.classList.add("nk-warn-backorder")
    if (summary.isCart) panel.dataset.nkCart = "1"

    const dragState = { didDrag: false }

    const header = el("div", "nk-header")
    const title = el("div", "nk-title")
    title.appendChild(el("span", "nk-order-nr", summary.title))
    if (summary.reference)
      title.appendChild(el("span", "nk-ref", summary.reference))
    header.appendChild(title)

    // Plant total stays visible in the header while the panel is collapsed.
    const collapsedTotal = el(
      "div",
      "nk-collapsed-total",
      `${summary.buckets.plant.total} plants`
    )
    header.appendChild(collapsedTotal)

    const controls = el("div", "nk-controls")

    // Export/print dropdown.
    const menuWrap = el("div", "nk-menu-wrap")
    const menuBtn = el("button", "nk-btn", "Export")
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

    // Layout dropdown (gear): float vs dock left/right, persisted.
    const gearWrap = el("div", "nk-menu-wrap")
    const gearBtn = el("button", "nk-btn nk-icon-btn", "⚙")
    gearBtn.title = "Panel position"
    gearBtn.setAttribute("aria-label", "Panel position")
    const gearMenu = el("div", "nk-menu")
    const closeGear = () => {
      gearMenu.classList.remove("nk-open")
      document.removeEventListener("click", onGearDocClick)
    }
    const onGearDocClick = (e) => {
      if (!gearWrap.contains(e.target)) closeGear()
    }
    const gearItems = []
    const addGearItem = (label, isActive, fn) => {
      const item = el("button", "nk-menu-item", label)
      if (isActive) item.classList.add("nk-active")
      item.addEventListener("click", () => {
        closeGear()
        fn()
        applyLayout(panel)
        markActiveGear()
      })
      gearItems.push(item)
      gearMenu.appendChild(item)
    }
    const markActiveGear = () => {
      const layout = loadLayout()
      const mode = layout.mode === "dock" ? "dock" : "float"
      const side = layout.side === "left" ? "left" : "right"
      const active = mode === "float" ? "Float" : `Dock ${side}`
      gearItems.forEach((it) =>
        it.classList.toggle("nk-active", it.textContent === active)
      )
    }
    const current = loadLayout()
    const curMode = current.mode === "dock" ? "dock" : "float"
    const curSide = current.side === "left" ? "left" : "right"
    addGearItem("Float", curMode === "float", () =>
      saveLayout({ mode: "float" })
    )
    addGearItem(
      "Dock left",
      curMode === "dock" && curSide === "left",
      () => saveLayout({ mode: "dock", side: "left" })
    )
    addGearItem(
      "Dock right",
      curMode === "dock" && curSide === "right",
      () => saveLayout({ mode: "dock", side: "right" })
    )
    gearBtn.addEventListener("click", (e) => {
      e.stopPropagation()
      if (gearMenu.classList.contains("nk-open")) {
        closeGear()
        return
      }
      gearMenu.classList.add("nk-open")
      document.addEventListener("click", onGearDocClick)
    })
    gearWrap.appendChild(gearBtn)
    gearWrap.appendChild(gearMenu)

    const collapseBtn = el("button", "nk-btn", collapsed ? "+" : "–")
    collapseBtn.title = "Collapse / expand"
    collapseBtn.addEventListener("click", () => {
      const isCol = panel.classList.toggle("nk-collapsed")
      collapseBtn.textContent = isCol ? "+" : "–"
      applyLayout(panel)
    })

    // Click anywhere on the bar (but not on a control) to expand when collapsed.
    // Collapsing stays exclusive to the collapse button above.
    header.addEventListener("click", (e) => {
      if (!panel.classList.contains("nk-collapsed")) return
      if (dragState.didDrag) return
      if (e.target.closest(".nk-controls")) return
      panel.classList.remove("nk-collapsed")
      collapseBtn.textContent = "–"
      applyLayout(panel)
    })
    enableDrag(panel, header, dragState)
    const closeBtn = el("button", "nk-btn", "×")
    closeBtn.title = summary.isCart
      ? "Close"
      : "Close (also closes the order details)"
    closeBtn.addEventListener(
      "click",
      summary.isCart ? closeCartPanel : closePanel
    )
    controls.appendChild(menuWrap)
    controls.appendChild(shareBtn)
    controls.appendChild(gearWrap)
    controls.appendChild(collapseBtn)
    controls.appendChild(closeBtn)
    header.appendChild(controls)
    panel.appendChild(header)

    const body = el("div", "nk-body")

    // Show the update banner above everything if a newer version is known.
    if (updateAvailable()) body.appendChild(buildUpdateBanner())

    // Assembly plant/pot ratio warnings sit at the top of the body.
    if (summary.assemblyWarnings && summary.assemblyWarnings.length)
      body.appendChild(buildAssemblyWarning(summary.assemblyWarnings))

    // Backorder warning sits above the plant summary.
    if (summary.backorders && summary.backorders.length)
      body.appendChild(buildBackorderSection(summary.backorders))

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
        buildSectionTable(
          s.title,
          b,
          s.nameLabel,
          isFirstSection ? sortSelect : null,
          s.simple
        )
      )
      isFirstSection = false
    }

    panel.appendChild(body)
    document.body.appendChild(panel)
    applyLayout(panel)
    hideHostBackdrop()
  }

  const renderMessage = (message, opts = {}) => {
    const existing = document.getElementById(PANEL_ID)
    if (existing) existing.remove()
    const panel = el("div")
    panel.id = PANEL_ID
    const header = el("div", "nk-header")
    const title = el("div", "nk-title")
    title.appendChild(el("span", "nk-order-nr", opts.title || "Order summary"))
    header.appendChild(title)
    const controls = el("div", "nk-controls")
    const closeBtn = el("button", "nk-btn", "×")
    closeBtn.title = opts.isCart
      ? "Close"
      : "Close (also closes the order details)"
    closeBtn.addEventListener(
      "click",
      opts.isCart ? closeCartPanel : closePanel
    )
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
          return (
            obj.token || obj.access_token || obj.jwt || obj.accessToken || null
          )
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
      log(
        "fetched order",
        currentSummary.orderNr,
        "—",
        currentSummary.lineCount,
        "lines"
      )
      if (document.getElementById(PANEL_ID)) render(currentSummary)
      return true
    } catch (e) {
      log("fetch failed:", e && e.message)
      return false
    }
  }

  // ---------------------------------------------------------------------------
  // Cart (basket page) — fed by inject.js capturing the site's own cart fetches
  // ---------------------------------------------------------------------------
  // Localized basket path slugs, matched on the final path segment.
  const BASKET_SLUGS = new Set([
    "basket", // en
    "einkaufswagen", // de
    "winkelmand", // nl
    "panier-d-achat", // fr
  ])

  let cartSummary = null
  let cartDismissed = false

  const isBasketPage = () => {
    const segs = location.pathname.split("/").filter(Boolean)
    const last = (segs[segs.length - 1] || "").toLowerCase()
    return BASKET_SLUGS.has(last)
  }

  const showCartPanel = () => {
    if (cartSummary) render(cartSummary)
    else renderMessage("Loading basket…", { title: "Basket", isCart: true })
  }

  // The cart panel is standalone — closing just removes it (no host modal).
  const closeCartPanel = () => {
    cartDismissed = true
    const p = document.getElementById(PANEL_ID)
    if (p) p.remove()
    clearDockMargin()
  }

  const toggleCartPanel = () => {
    if (document.getElementById(PANEL_ID)) {
      closeCartPanel()
      return
    }
    maybeCheckUpdate() // fire-and-forget; throttled to once a day
    cartDismissed = false
    showCartPanel()
  }

  // Receive cart payloads forwarded by the MAIN-world interceptor.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return
    const data = event.data
    if (!data || data.__nkCart !== true || !data.payload) return
    cartSummary = summarizeCart(data.payload)
    log(
      "cart captured —",
      cartSummary.lineCount,
      "line items; basket page:",
      isBasketPage(),
      "dismissed:",
      cartDismissed
    )
    // Auto-show / live-refresh on the basket page unless the user closed it.
    if (isBasketPage() && !cartDismissed) render(cartSummary)
  })
  // Recover a cart captured before this listener was attached.
  log("requesting cart replay from interceptor")
  window.postMessage({ __nkCartRequest: true }, location.origin)

  // The basket is an SPA route: show the panel on entry, drop it on exit.
  let lastHref = location.href
  const onUrlChange = () => {
    if (isBasketPage()) {
      cartDismissed = false
      if (cartSummary && !document.getElementById(PANEL_ID)) render(cartSummary)
    } else {
      const p = document.getElementById(PANEL_ID)
      if (p && p.dataset.nkCart) p.remove()
    }
  }
  window.addEventListener("popstate", onUrlChange)
  // pushState happens in the page's world, so poll rather than patch history.
  setInterval(() => {
    if (location.href === lastHref) return
    lastHref = location.href
    onUrlChange()
  }, 1000)

  // ---------------------------------------------------------------------------
  // Toggle (toolbar icon) + initial prefetch
  // ---------------------------------------------------------------------------
  const togglePanel = async () => {
    if (isBasketPage()) {
      log("toggle: basket page")
      toggleCartPanel()
      return
    }
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
