// Runs in the page's MAIN world (document_start) so it can wrap the site's own
// networking before the app uses it. The basket loads its cart via a POST to
// backend.nieuwkoop-europe.com/carts/… that re-fires whenever the cart changes;
// rather than replay that unknown request, we capture the site's own responses
// and forward them to the content script via postMessage.
;(() => {
  "use strict"

  // Enable verbose logging with `localStorage.nkDebug = "1"` then reload.
  const DEBUG = (() => {
    try {
      return localStorage.getItem("nkDebug") === "1"
    } catch {
      return false
    }
  })()
  const log = (...a) => {
    if (DEBUG) console.log("[NK inject]", ...a)
  }
  log("loaded (MAIN world) on", location.href)

  const isCartUrl = (url) => {
    try {
      return /\/carts\//.test(String(url || ""))
    } catch {
      return false
    }
  }

  // Keep the most recent cart so a late-loading content script can ask for a
  // replay (inject runs at document_start, content.js at document_idle).
  let lastCart = null

  const forward = (payload, via) => {
    if (!payload || !Array.isArray(payload.lineItems)) {
      log("forward skipped — payload has no lineItems array", via)
      return
    }
    lastCart = payload
    log("forwarding cart —", payload.lineItems.length, "line items", "via", via)
    try {
      window.postMessage({ __nkCart: true, payload }, location.origin)
    } catch (e) {
      log("postMessage failed:", e && e.message)
    }
  }

  // The content script posts this on load to recover a cart captured before it
  // was listening.
  window.addEventListener("message", (event) => {
    if (event.source !== window) return
    if (event.data && event.data.__nkCartRequest === true) {
      log("replay requested; have cart:", !!lastCart)
      if (lastCart) forward(lastCart, "replay")
    }
  })

  // --- fetch ---------------------------------------------------------------
  // The app (Angular fetch backend) aborts cart requests right after reading
  // them, which kills any clone we try to read ourselves later ("The user
  // aborted a request"). To avoid that race we buffer the cart body *before*
  // handing it back — while the app is still awaiting the fetch — then return a
  // fresh in-memory Response carrying the same data. We read the original body
  // (no clone / no tee), so there's nothing for the later abort to break, and
  // the app can read its copy by any method (json/text/getReader).
  const origFetch = window.fetch
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      let url
      try {
        url = args[0] && args[0].url ? args[0].url : args[0]
        if (DEBUG) log("fetch", url)
      } catch {
        /* ignore */
      }
      const p = origFetch.apply(this, args)
      if (!isCartUrl(url)) return p
      log("→ cart fetch detected", url)
      return p.then(async (res) => {
        if (!res || !res.ok) {
          log("cart fetch not ok — status", res && res.status)
          return res
        }
        try {
          const text = await res.text() // consume the original (no clone)
          try {
            forward(JSON.parse(text), "fetch")
          } catch (e) {
            log("cart JSON parse failed:", e && e.message)
          }
          const headers = new Headers(res.headers)
          headers.delete("content-encoding")
          headers.delete("content-length")
          return new Response(text, {
            status: res.status,
            statusText: res.statusText,
            headers,
          })
        } catch (e) {
          // If our read is aborted/fails, fall back so the app still works
          // (we just won't have captured this cart).
          log("cart body read failed, passing original through:", e && e.message)
          return res
        }
      })
    }
    log("fetch wrapped")
  } else {
    log("window.fetch not a function — not wrapped")
  }

  // --- XMLHttpRequest (axios uses this) ------------------------------------
  const XHR = window.XMLHttpRequest
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open
    const origSend = XHR.prototype.send
    XHR.prototype.open = function (method, url, ...rest) {
      this.__nkUrl = url
      if (DEBUG) log("xhr", method, url)
      return origOpen.call(this, method, url, ...rest)
    }
    XHR.prototype.send = function (...args) {
      if (isCartUrl(this.__nkUrl)) {
        log("→ cart xhr detected", this.__nkUrl)
        this.addEventListener("load", () => {
          log("cart xhr loaded, status", this.status)
          try {
            if (this.status >= 200 && this.status < 300)
              forward(JSON.parse(this.responseText), "xhr")
          } catch (e) {
            log("xhr json parse failed:", e && e.message)
          }
        })
      }
      return origSend.apply(this, args)
    }
    log("XMLHttpRequest wrapped")
  } else {
    log("XMLHttpRequest unavailable — not wrapped")
  }
})()
