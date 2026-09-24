const ACCOUNTS = new Map([
  ["HBCJ-STB-4D-UQN-8", "Account 01"],
  ["SRPM-6WZ-QH-BQ9-V", "Account 02"],
  ["H6QS-BYY-BJ-FUH-Z", "Account 03"],
  ["GQDM-8CX-A6-45G-C", "Account 04"],
  ["57X3-3UG-ZT-KM5-H", "Account 05"],
  ["E75Q-XTY-EY-ACF-B", "Account 06"],
  ["WRUK-LMF-EA-GQD-3", "Account 07"],
  ["ZZW4-F72-DQ-DEW-L", "Account 08"],
  ["S9RG-CHH-6E-U8A-Y", "Account 09"],
  ["NKXM-C6M-NK-VEQ-Y", "Account 10"],
  ["B23J-23F-UH-XTK-L", "Account 11"],
  ["BEJW-Z6T-R2-9XB-T", "Account 12"],
  ["WPCH-RCL-HQ-4HD-7", "Account 13"],
  ["WTM6-HHY-46-CPU-8", "Account 14"],
  ["QT8S-XMV-UF-HEY-W", "Account 15"],
  ["2KX5-F6Q-FD-RMT-N", "Account 16"],
  ["YZC9-4TU-US-G26-8", "Account 17"],
  ["UVNL-MGM-HT-6WM-8", "Account 18"],
  ["XWDY-E9L-HP-4B7-W", "Account 19"],
  ["YW6A-LAP-QQ-X9U-J", "Account 20"],
]);

const PAGE_META = {
  opportunities: ["Opportunities", "Verified market signals, ranked automatically."],
  portfolio: ["Portfolio", "One shared Alpaca paper account, synced from actual simulated fills."],
  research: ["Research details", "Verified inputs, explicit estimates, and unavailable fields."],
  orders: ["Orders and trade history", "Open, filled, canceled, and rejected paper orders."],
  settings: ["Settings", "Paper connection, controls, limits, and alerts."],
};

const state = {
  accountName: null,
  status: null,
  dashboard: null,
  opportunities: [],
  selectedOpportunity: null,
  currentPage: "opportunities",
  loading: false,
  livePrices: new Map(),
  lastOpportunityAlert: null,
};

const gate = document.querySelector("#gate");
const appShell = document.querySelector("#app-shell");
const accessForm = document.querySelector("#access-form");
const accessInput = document.querySelector("#access-code");
const codeMessage = document.querySelector("#code-message");
const visibilityButton = document.querySelector("#visibility-button");
const eyeOpen = visibilityButton.querySelector(".eye-open");
const eyeClosed = visibilityButton.querySelector(".eye-closed");
const sidebar = document.querySelector(".sidebar");
const sidebarScrim = document.querySelector("#sidebar-scrim");
const autoDialog = document.querySelector("#auto-dialog");

function formatCode(value) {
  const raw = value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 13);
  const groups = [4, 3, 2, 3, 1];
  const parts = [];
  let position = 0;
  for (const length of groups) {
    const part = raw.slice(position, position + length);
    if (!part) break;
    parts.push(part);
    position += length;
  }
  return parts.join("-");
}

function setCodeVisibility(visible) {
  accessInput.type = visible ? "text" : "password";
  visibilityButton.setAttribute("aria-label", visible ? "Hide code" : "Show code");
  visibilityButton.setAttribute("aria-pressed", String(visible));
  visibilityButton.title = visible ? "Hide code" : "Show code";
  eyeOpen.classList.toggle("hidden", visible);
  eyeClosed.classList.toggle("hidden", !visible);
}

function unlock(accountName) {
  state.accountName = accountName;
  sessionStorage.setItem("paperCompassAccount", accountName);
  document.querySelector("#signed-in-account").textContent = accountName;
  gate.classList.add("hidden");
  appShell.classList.remove("hidden");
  connectEvents();
  loadAll();
}

function lockDashboard() {
  sessionStorage.removeItem("paperCompassAccount");
  state.accountName = null;
  appShell.classList.add("hidden");
  gate.classList.remove("hidden");
  accessInput.value = "";
  setCodeVisibility(false);
  accessInput.focus();
}

accessInput.addEventListener("input", () => {
  accessInput.value = formatCode(accessInput.value);
  codeMessage.textContent = "";
});

visibilityButton.addEventListener("click", () => {
  setCodeVisibility(accessInput.type === "password");
  accessInput.focus();
});

accessForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const code = formatCode(accessInput.value.trim());
  accessInput.value = code;
  if (code.length !== 17) {
    codeMessage.textContent = "Enter the complete 13-character account code.";
    return;
  }
  const account = ACCOUNTS.get(code);
  if (!account) {
    codeMessage.textContent = "That account code is not correct.";
    accessInput.select();
    return;
  }
  unlock(account);
});

document.querySelector("#sign-out-button").addEventListener("click", lockDashboard);

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "The request failed.");
  return payload;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function money(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(number);
}

function percent(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "Unavailable";
  return `${number >= 0 ? "+" : ""}${number.toFixed(digits)}%`;
}

function number(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return "Unavailable";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: digits,
  }).format(parsed);
}

function dateTime(value) {
  if (!value) return "Unavailable";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unavailable";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function toneFor(value) {
  const number = Number(value);
  if (number > 0) return "positive";
  if (number < 0) return "negative";
  return "neutral";
}

function showToast(message, type = "normal") {
  const toast = document.createElement("div");
  toast.className = `toast ${type === "error" ? "error" : ""}`;
  toast.textContent = message;
  document.querySelector("#toast-region").append(toast);
  window.setTimeout(() => toast.remove(), 5200);
}

function switchPage(page) {
  if (!PAGE_META[page]) return;
  state.currentPage = page;
  document.querySelectorAll("[data-page-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.pagePanel === page);
  });
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.classList.toggle("active", button.dataset.page === page);
  });
  document.querySelector("#page-heading").textContent = PAGE_META[page][0];
  document.querySelector("#page-subheading").textContent = PAGE_META[page][1];
  closeSidebar();
}

function openSidebar() {
  sidebar.classList.add("open");
  sidebarScrim.classList.remove("hidden");
}

function closeSidebar() {
  sidebar.classList.remove("open");
  sidebarScrim.classList.add("hidden");
}

document.querySelectorAll(".nav-button").forEach((button) => {
  button.addEventListener("click", () => switchPage(button.dataset.page));
});
document.querySelectorAll("[data-go-settings]").forEach((button) => {
  button.addEventListener("click", () => switchPage("settings"));
});
document.querySelector("#menu-button").addEventListener("click", openSidebar);
sidebarScrim.addEventListener("click", closeSidebar);

async function loadAll(force = false) {
  if (state.loading) return;
  state.loading = true;
  const syncButton = document.querySelector("#sync-button");
  syncButton.disabled = true;
  syncButton.textContent = "Syncing";
  try {
    state.status = await api("/api/status");
    renderStatus();
    renderSettings();
    if (state.status.connection.connected) {
      const [dashboard, opportunities] = await Promise.all([
        api("/api/dashboard"),
        api(`/api/opportunities${force ? "?refresh=1" : ""}`),
      ]);
      state.dashboard = dashboard;
      state.opportunities = opportunities.items || [];
      state.status.feed = opportunities.feed || state.status.feed;
      renderStatus();
      renderDashboard();
      renderOpportunities(opportunities);
      if (state.selectedOpportunity) {
        state.selectedOpportunity =
          state.opportunities.find(
            (item) => item.symbol === state.selectedOpportunity.symbol,
          ) || state.selectedOpportunity;
        renderResearch(state.selectedOpportunity);
      }
    } else {
      state.dashboard = null;
      state.opportunities = [];
      renderDashboard();
      renderOpportunities({ items: [], updatedAt: null, feed: state.status.feed });
    }
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    state.loading = false;
    syncButton.disabled = false;
    syncButton.textContent = "Sync now";
  }
}

function renderStatus() {
  if (!state.status) return;
  const { connection, feed, settings, automaticController } = state.status;
  const banner = document.querySelector("#connection-banner");
  const mini = document.querySelector("#connection-mini");
  const connected = Boolean(connection.connected);

  banner.classList.toggle("connected", connected);
  banner.querySelector("strong").textContent = connected
    ? "Alpaca Paper connected."
    : "Alpaca not connected.";
  banner.querySelector("span").textContent = connected
    ? `Verified against ${connection.endpoint} at ${dateTime(connection.verifiedAt)}.`
    : connection.message || "Add paper credentials locally to load account data.";
  mini.innerHTML = `<span class="status-dot ${connected ? "connected" : "unavailable"}"></span><span>${connected ? "Paper account connected" : "Alpaca not connected"}</span>`;

  document.querySelector("#feed-label").textContent = connected
    ? `${String(feed.feed || "iex").toUpperCase()} - ${feed.coverage || "coverage unavailable"}${feed.stale ? " - stale" : ""}`
    : "Feed unavailable";

  const details = document.querySelector("#connection-details");
  details.innerHTML = `
    <div><span>Credentials</span><strong>${connected ? "Configured locally" : "Not configured or invalid"}</strong></div>
    <div><span>Account</span><strong>${connected ? `Paper ${escapeHtml(connection.accountStatus || "connected")}` : "Not connected"}</strong></div>
    <div><span>Market feed</span><strong>${escapeHtml(String(feed.feed || "iex").toUpperCase())} - ${escapeHtml(feed.coverage || "unavailable")}</strong></div>
    <div><span>Automatic controller</span><strong>${automaticController.lockOwned ? "Single worker lock active" : "Lock held by another backend"}</strong></div>
  `;

  document.querySelector("#paper-endpoint").textContent = state.status.endpoint;
  const running = settings.autoRunning && settings.mode === "auto";
  document.querySelector("#start-auto-button").disabled =
    !connected || !automaticController.lockOwned || running;
  document.querySelector("#pause-auto-button").disabled = !running;
  document.querySelector("#manual-mode-card").classList.toggle("active", !running);
  document.querySelector("#auto-mode-card").classList.toggle("active", running);

  const autoStatus = document.querySelector("#auto-status");
  autoStatus.innerHTML = running
    ? `<span class="status-dot running"></span><div><strong>Automatic paper trading running</strong><p>The backend may submit simulated orders within the saved limits.</p></div>`
    : `<span class="status-dot paused"></span><div><strong>Automatic trading paused</strong><p>No new automatic paper orders will be submitted.</p></div>`;
}

function renderSettings() {
  if (!state.status?.settings) return;
  const form = document.querySelector("#settings-form");
  for (const [name, value] of Object.entries(state.status.settings)) {
    if (form.elements[name]) form.elements[name].value = value;
  }
}

function renderOpportunities(payload) {
  const list = document.querySelector("#opportunity-list");
  const items = payload.items || [];
  document.querySelector("#research-updated").textContent = payload.updatedAt
    ? `Research updated ${dateTime(payload.updatedAt)}`
    : "No research scan yet";

  if (!items.length) {
    list.innerHTML = `
      <div class="empty-state">
        <h4>${state.status?.connection?.connected ? "No verified opportunities available" : "Connect Alpaca Paper Trading to begin discovery"}</h4>
        <p>${escapeHtml(payload.unavailableReason || "No demonstration recommendations are mixed with connected account data.")}</p>
      </div>`;
    return;
  }

  list.innerHTML = items
    .map((item) => {
      const change = item.dailyChangePct;
      return `
        <article class="opportunity-card">
          <div class="rank-number">${item.rank}</div>
          <div class="company-cell">
            <strong><span class="ticker">${escapeHtml(item.symbol)}</span>${escapeHtml(item.companyName)}</strong>
            <span>Score ${item.score}/100 - ${escapeHtml(item.exchange)}</span>
          </div>
          <div class="price-cell">
            <strong data-live-symbol="${escapeHtml(item.symbol)}">${money(item.price)}</strong>
            <span>${dateTime(item.priceTimestamp)}</span>
          </div>
          <div>
            <div class="gain-stack">
              <strong class="${toneFor(change)}">${percent(change)}</strong>
              <small>vs. previous close</small>
            </div>
            <div class="badges">
              <span class="badge ${item.riskRating.toLowerCase()}">${escapeHtml(item.riskRating)} risk</span>
              <span class="badge">${escapeHtml(item.researchConfidence)} confidence</span>
            </div>
          </div>
          <button class="secondary-button" type="button" data-research-symbol="${escapeHtml(item.symbol)}">View research</button>
        </article>`;
    })
    .join("");
}

function renderDashboard() {
  const dashboard = state.dashboard;
  if (!dashboard?.account) {
    document.querySelector("#account-metrics").innerHTML = `
      <article class="metric"><span>Portfolio value</span><strong>Unavailable</strong><small>Alpaca not connected</small></article>
      <article class="metric"><span>Day gain / loss</span><strong>Unavailable</strong><small>Percentage first</small></article>
      <article class="metric"><span>Buying power</span><strong>Unavailable</strong><small>Simulated funds</small></article>
      <article class="metric"><span>Market status</span><strong>Unavailable</strong><small>No clock sync</small></article>`;
    document.querySelector("#positions-body").innerHTML = `<tr><td colspan="6" class="table-empty">No connected positions.</td></tr>`;
    document.querySelector("#orders-body").innerHTML = `<tr><td colspan="7" class="table-empty">No connected order history.</td></tr>`;
    return;
  }

  const account = dashboard.account;
  const equity = Number(account.equity);
  const lastEquity = Number(account.last_equity);
  const dayDollar = equity - lastEquity;
  const dayPct = lastEquity ? (dayDollar / lastEquity) * 100 : null;
  document.querySelector("#account-metrics").innerHTML = `
    <article class="metric"><span>Portfolio value</span><strong>${money(equity)}</strong><small>Shared simulated equity</small></article>
    <article class="metric"><span>Day gain / loss</span><strong class="${toneFor(dayPct)}">${percent(dayPct)}</strong><small class="${toneFor(dayDollar)}">${money(dayDollar)} today</small></article>
    <article class="metric"><span>Buying power</span><strong>${money(account.buying_power)}</strong><small>Simulated funds</small></article>
    <article class="metric"><span>Market status</span><strong>${dashboard.clock?.is_open ? "Open" : "Closed"}</strong><small>${dashboard.clock?.next_open ? `Next open ${dateTime(dashboard.clock.next_open)}` : "Clock unavailable"}</small></article>`;

  renderPositions(dashboard.positions || []);
  renderOrders(dashboard.orders || []);
  document.querySelector("#portfolio-sync-time").textContent = `Synced ${dateTime(dashboard.syncedAt)}`;
  document.querySelector("#orders-sync-time").textContent = `Synced ${dateTime(dashboard.syncedAt)}`;
}

function renderPositions(positions) {
  const body = document.querySelector("#positions-body");
  if (!positions.length) {
    body.innerHTML = `<tr><td colspan="6" class="table-empty">No open positions in the shared paper account.</td></tr>`;
    return;
  }
  body.innerHTML = positions
    .map((position) => {
      const gainPct = Number(position.unrealized_plpc) * 100;
      const gainDollar = Number(position.unrealized_pl);
      return `<tr>
        <td><span class="table-primary">${escapeHtml(position.symbol)}</span><span class="table-secondary">${escapeHtml(position.side || "position")}</span></td>
        <td><span class="table-primary ${toneFor(gainPct)}">${percent(gainPct)}</span><span class="table-secondary ${toneFor(gainDollar)}">${money(gainDollar)}</span></td>
        <td>${number(position.qty, 6)}</td>
        <td>${money(position.avg_entry_price)}</td>
        <td>${money(position.current_price)}</td>
        <td><span class="table-primary ${escapeHtml(position.recommendation?.tone || "neutral")}">${escapeHtml(position.recommendation?.action || "Unavailable")}</span><span class="table-secondary">${escapeHtml(position.recommendation?.explanation || "No rule result")}</span></td>
      </tr>`;
    })
    .join("");
}

function renderOrders(orders) {
  const body = document.querySelector("#orders-body");
  if (!orders.length) {
    body.innerHTML = `<tr><td colspan="7" class="table-empty">No paper orders returned by Alpaca.</td></tr>`;
    return;
  }
  body.innerHTML = orders
    .map((order) => {
      const automatic = String(order.client_order_id || "").startsWith("paperdash-");
      const amount = order.notional
        ? money(order.notional)
        : `${number(order.qty, 6)} shares`;
      return `<tr>
        <td>${dateTime(order.submitted_at)}</td>
        <td><span class="table-primary">${escapeHtml(order.symbol)}</span><span class="table-secondary">${escapeHtml(order.type || "order")}</span></td>
        <td>${escapeHtml(order.side || "Unavailable")}</td>
        <td>${amount}</td>
        <td>${order.filled_avg_price ? money(order.filled_avg_price) : "Not filled"}</td>
        <td><span class="badge">${escapeHtml(order.status || "Unavailable")}</span></td>
        <td>${automatic ? "Paper Auto" : "Paper Manual / external"}</td>
      </tr>`;
    })
    .join("");
}

function renderResearch(item) {
  const target = document.querySelector("#research-detail");
  if (!item) return;
  target.className = "research-layout";
  target.innerHTML = `
    <div class="research-main">
      <section class="research-header">
        <div class="research-title-row">
          <div>
            <p class="section-kicker">Rank #${item.rank} - score ${item.score}/100</p>
            <h3><span class="ticker">${escapeHtml(item.symbol)}</span>${escapeHtml(item.companyName)}</h3>
            <div class="badges"><span class="badge ${item.riskRating.toLowerCase()}">${escapeHtml(item.riskRating)} investment risk</span><span class="badge">${escapeHtml(item.researchConfidence)} research confidence</span></div>
          </div>
          <div class="research-price"><strong>${money(item.price)}</strong><span>${dateTime(item.priceTimestamp)}</span></div>
        </div>
      </section>
      <section class="research-section"><h4>Why it ranks here</h4><p>${escapeHtml(item.rankExplanation)}</p></section>
      <section class="research-section"><h4>Reasons to consider</h4><ul>${item.reasonsFor.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
      <section class="research-section"><h4>Reasons to avoid</h4><ul>${item.reasonsAgainst.map((reason) => `<li>${escapeHtml(reason)}</li>`).join("")}</ul></section>
      <section class="research-section"><h4>Event verification</h4><p><span class="badge elevated">${escapeHtml(item.eventVerification.status)}</span></p><p>${escapeHtml(item.eventVerification.explanation)}</p></section>
      <section class="research-section"><h4>Supporting sources</h4><div class="source-list">${item.sources.map((source) => `<div class="source-item"><a href="${escapeHtml(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.label)}</a><span>Verified ${dateTime(source.verifiedAt)}</span></div>`).join("")}</div></section>
    </div>
    <aside class="research-aside">
      <div class="research-facts">
        <div class="fact-row"><span>Day change</span><strong class="${toneFor(item.dailyChangePct)}">${percent(item.dailyChangePct)}</strong></div>
        <div class="fact-row"><span>Intraday change</span><strong class="${toneFor(item.intradayChangePct)}">${percent(item.intradayChangePct)}</strong></div>
        <div class="fact-row"><span>Quoted spread</span><strong>${percent(item.spreadPct)}</strong></div>
        <div class="fact-row"><span>Daily volume</span><strong>${number(item.volume, 0)}</strong></div>
        <div class="fact-row"><span>Suggested period</span><strong>${escapeHtml(item.holdingPeriod)}</strong></div>
        <div class="fact-row"><span>Last research update</span><strong>${dateTime(item.researchUpdatedAt)}</strong></div>
      </div>
      <section class="research-section"><h4>Risk explanation</h4><p>${escapeHtml(item.riskExplanation)}</p></section>
      <section class="research-section"><h4>Research confidence</h4><p>${escapeHtml(item.confidenceExplanation)}</p></section>
    </aside>`;
}

document.querySelector("#opportunity-list").addEventListener("click", (event) => {
  const button = event.target.closest("[data-research-symbol]");
  if (!button) return;
  state.selectedOpportunity = state.opportunities.find(
    (item) => item.symbol === button.dataset.researchSymbol,
  );
  renderResearch(state.selectedOpportunity);
  switchPage("research");
});

document.querySelector("#sync-button").addEventListener("click", () => loadAll(true));

document.querySelector("#verify-button").addEventListener("click", async () => {
  const button = document.querySelector("#verify-button");
  button.disabled = true;
  button.textContent = "Verifying";
  try {
    const result = await api("/api/connection/verify", { method: "POST" });
    showToast(
      result.connected
        ? `Verified paper endpoint. Account status: ${result.accountStatus}.`
        : result.message,
      result.connected ? "normal" : "error",
    );
    await loadAll(true);
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Verify paper connection";
  }
});

document.querySelector("#settings-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const payload = Object.fromEntries(
    [...new FormData(form).entries()].map(([key, value]) => [key, Number(value)]),
  );
  const message = document.querySelector("#settings-message");
  message.textContent = "Saving";
  try {
    const result = await api("/api/settings", {
      method: "PUT",
      body: JSON.stringify(payload),
    });
    state.status.settings = result.settings;
    renderStatus();
    renderSettings();
    message.textContent = "Paper limits saved.";
  } catch (error) {
    message.textContent = error.message;
  }
});

document.querySelector("#start-auto-button").addEventListener("click", () => {
  autoDialog.showModal();
});

document.querySelector("#confirm-auto-button").addEventListener("click", async (event) => {
  event.preventDefault();
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = "Starting";
  try {
    const result = await api("/api/auto/start", {
      method: "POST",
      body: JSON.stringify({ confirmPaper: true }),
    });
    state.status.settings = result.settings;
    renderStatus();
    autoDialog.close();
    showToast("Automatic paper trading started.");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    button.disabled = false;
    button.textContent = "Start paper automation";
  }
});

document.querySelector("#pause-auto-button").addEventListener("click", async () => {
  try {
    const result = await api("/api/auto/pause", { method: "POST" });
    state.status.settings = result.settings;
    renderStatus();
    showToast("Automatic trading paused. Existing paper orders are unchanged.");
  } catch (error) {
    showToast(error.message, "error");
  }
});

document.querySelector("#alerts-button").addEventListener("click", async () => {
  if (!("Notification" in window)) {
    showToast("Browser notifications are unavailable here.", "error");
    return;
  }
  const permission = await Notification.requestPermission();
  document.querySelector("#alerts-button").textContent =
    permission === "granted" ? "Browser alerts enabled" : "Enable browser alerts";
  showToast(
    permission === "granted"
      ? "Browser alerts enabled for recommendations and paper activity."
      : "Notification permission was not granted.",
    permission === "granted" ? "normal" : "error",
  );
});

function notify(title, body) {
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, tag: "paper-compass" });
  }
}

let eventSource = null;
function connectEvents() {
  if (eventSource) return;
  eventSource = new EventSource("/api/events");
  eventSource.addEventListener("price", (event) => {
    const update = JSON.parse(event.data);
    const price = update.price ??
      (update.bid && update.ask ? (update.bid + update.ask) / 2 : null);
    if (!price) return;
    state.livePrices.set(update.symbol, update);
    const element = document.querySelector(`[data-live-symbol="${CSS.escape(update.symbol)}"]`);
    if (element) element.textContent = money(price);
  });
  eventSource.addEventListener("feed", (event) => {
    if (!state.status) return;
    state.status.feed = JSON.parse(event.data);
    renderStatus();
  });
  eventSource.addEventListener("opportunities", (event) => {
    const update = JSON.parse(event.data);
    if (!update.top) return;
    const key = `${update.top.symbol}-${update.updatedAt}`;
    if (key === state.lastOpportunityAlert) return;
    state.lastOpportunityAlert = key;
    notify(
      "Paper opportunity updated",
      `${update.top.symbol} is ranked first with a rule-based score of ${update.top.score}/100.`,
    );
  });
  eventSource.addEventListener("auto", (event) => {
    const update = JSON.parse(event.data);
    showToast(update.message, update.status === "error" ? "error" : "normal");
    if (update.status === "order-submitted") {
      notify("Simulated Alpaca order submitted", update.message);
      loadAll(false);
    }
  });
}

const existingAccount = sessionStorage.getItem("paperCompassAccount");
if ([...ACCOUNTS.values()].includes(existingAccount)) unlock(existingAccount);

