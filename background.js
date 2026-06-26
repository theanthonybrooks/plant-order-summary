const ORDER_HOST = "www.nieuwkoop-europe.com"
const DEFAULT_TITLE = "Toggle Nieuwkoop order summary"

const DEBUG = false
const log = (...args) => {
  if (DEBUG) console.log("[NK background]", ...args)
}

const hintOpenOrder = (tabId) => {
  if (tabId == null) return
  log("hintOpenOrder -> badge on tab", tabId)
  chrome.action.setBadgeBackgroundColor({ color: "#c0392b", tabId })
  chrome.action.setBadgeText({ text: "!", tabId })
  chrome.action.setTitle({
    title: "Open an order first to see its summary",
    tabId,
  })
}

const clearHint = (tabId) => {
  if (tabId == null) return
  log("clearHint -> badge off tab", tabId)
  chrome.action.setBadgeText({ text: "", tabId })
  chrome.action.setTitle({ title: DEFAULT_TITLE, tabId })
}

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return
  log("icon clicked on tab", tab.id, tab.url)

  clearHint(tab.id)
  chrome.tabs.sendMessage(tab.id, { type: "nk-toggle" }, (resp) => {
    const err = chrome.runtime.lastError
    log("nk-toggle response:", resp, "lastError:", err && err.message)
    if (!err) return
    const noReceiver =
      /Receiving end does not exist|Could not establish connection/i.test(
        err.message || ""
      )
    if (!noReceiver) {
      log("content script present but silent — not hinting")
      return
    }
    let onSite = false
    try {
      onSite = new URL(tab.url || "").hostname === ORDER_HOST
    } catch {
      onSite = false
    }
    log("no receiver; onSite =", onSite)
    if (onSite) hintOpenOrder(tab.id)
  })
})

chrome.runtime.onMessage.addListener((msg, sender) => {
  log("onMessage:", msg && msg.type, "from tab", sender.tab && sender.tab.id)
  if (msg && msg.type === "nk-no-order" && sender.tab)
    hintOpenOrder(sender.tab.id)
})
