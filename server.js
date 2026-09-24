import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildOpportunity,
  positionRecommendation,
  rankOpportunities,
} from "./research.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(ROOT, "data");
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const SETTINGS_PATH = path.join(DATA_DIR, "settings.json");
const WORKER_LOCK_PATH = path.join(RUNTIME_DIR, "auto-worker.lock");
const PAPER_BASE_URL = "https://paper-api.alpaca.markets";
const DATA_BASE_URL = "https://data.alpaca.markets";
const HOST = "127.0.0.1";

loadEnv(path.join(ROOT, ".env"));

const configuredPort = Number(process.env.PORT || 4317);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0
  ? configuredPort
  : 4317;
const API_KEY = process.env.ALPACA_API_KEY?.trim() || "";
const SECRET_KEY = process.env.ALPACA_SECRET_KEY?.trim() || "";
const DATA_FEED = ["iex", "sip", "delayed_sip"].includes(
  process.env.ALPACA_DATA_FEED,
)
  ? process.env.ALPACA_DATA_FEED
  : "iex";
const credentialsConfigured = Boolean(API_KEY && SECRET_KEY);

const DEFAULT_SETTINGS = {
  mode: "manual",
  autoRunning: false,
  maxOrderNotional: 1000,
  maxPositionPercent: 2,
  maxOpenPositions: 5,
  minimumRankScore: 65,
  stopLossPercent: -8,
  takeProfitPercent: 15,
  scanIntervalMinutes: 5,
};

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(RUNTIME_DIR, { recursive: true });

let settings = loadSettings();
settings.autoRunning = false;
settings.mode = "manual";
saveSettings();

let ownsWorkerLock = acquireWorkerLock();
let autoCycleRunning = false;
let autoTimer = null;
let assetsCache = { expiresAt: 0, bySymbol: new Map() };
let opportunitiesCache = { expiresAt: 0, items: [], updatedAt: null };
let connectionCache = { expiresAt: 0, result: null };
const eventClients = new Set();

class AlpacaError extends Error {
  constructor(message, status = 500, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function loadEnv(envPath) {
  if (!fs.existsSync(envPath)) return;
  const text = fs.readFileSync(envPath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_PATH, "utf8"));
    return sanitizeSettings({ ...DEFAULT_SETTINGS, ...saved });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings() {
  const tempPath = `${SETTINGS_PATH}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, SETTINGS_PATH);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed)
    ? Math.min(max, Math.max(min, parsed))
    : fallback;
}

function sanitizeSettings(input) {
  return {
    mode: input.mode === "auto" ? "auto" : "manual",
    autoRunning: Boolean(input.autoRunning),
    maxOrderNotional: clampNumber(input.maxOrderNotional, 10, 100000, 1000),
    maxPositionPercent: clampNumber(input.maxPositionPercent, 0.1, 25, 2),
    maxOpenPositions: Math.round(
      clampNumber(input.maxOpenPositions, 1, 50, 5),
    ),
    minimumRankScore: Math.round(
      clampNumber(input.minimumRankScore, 1, 100, 65),
    ),
    stopLossPercent: clampNumber(input.stopLossPercent, -50, -0.1, -8),
    takeProfitPercent: clampNumber(
      input.takeProfitPercent,
      0.1,
      200,
      15,
    ),
    scanIntervalMinutes: Math.round(
      clampNumber(input.scanIntervalMinutes, 1, 60, 5),
    ),
  };
}

function acquireWorkerLock() {
  const attempt = () => {
    try {
      const handle = fs.openSync(WORKER_LOCK_PATH, "wx");
      fs.writeFileSync(handle, `${process.pid}\n`, "utf8");
      fs.closeSync(handle);
      return true;
    } catch (error) {
      if (error.code !== "EEXIST") return false;
      try {
        const existingPid = Number(
          fs.readFileSync(WORKER_LOCK_PATH, "utf8").trim(),
        );
        if (existingPid && existingPid !== process.pid) {
          process.kill(existingPid, 0);
          return false;
        }
      } catch (lockError) {
        if (lockError.code !== "ESRCH" && lockError.code !== "EPERM") {
          return false;
        }
      }
      fs.unlinkSync(WORKER_LOCK_PATH);
      return attempt();
    }
  };
  return attempt();
}

function releaseWorkerLock() {
  if (!ownsWorkerLock) return;
  try {
    const lockPid = Number(fs.readFileSync(WORKER_LOCK_PATH, "utf8").trim());
    if (lockPid === process.pid) fs.unlinkSync(WORKER_LOCK_PATH);
  } catch {
    // The lock may already be gone during shutdown.
  }
  ownsWorkerLock = false;
}

function authHeaders() {
  return {
    "APCA-API-KEY-ID": API_KEY,
    "APCA-API-SECRET-KEY": SECRET_KEY,
    Accept: "application/json",
  };
}

async function alpacaRequest(
  requestPath,
  { method = "GET", body, data = false, allowNotFound = false } = {},
) {
  if (!credentialsConfigured) {
    throw new AlpacaError("Alpaca not connected.", 503);
  }
  const base = data ? DATA_BASE_URL : PAPER_BASE_URL;
  if (!requestPath.startsWith("/")) {
    throw new AlpacaError("Invalid Alpaca request path.", 500);
  }

  const response = await fetch(`${base}${requestPath}`, {
    method,
    headers: {
      ...authHeaders(),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });

  if (allowNotFound && response.status === 404) return null;

  const text = await response.text();
  let payload = null;
  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { message: "Alpaca returned a non-JSON response." };
    }
  }

  if (!response.ok) {
    throw new AlpacaError(
      payload?.message || `Alpaca request failed with ${response.status}.`,
      response.status,
      { endpoint: `${base}${requestPath}`, code: payload?.code || null },
    );
  }

  return payload;
}

async function verifyPaperConnection(force = false) {
  if (!credentialsConfigured) {
    return {
      connected: false,
      paperEndpointVerified: true,
      endpoint: PAPER_BASE_URL,
      message: "Alpaca not connected.",
    };
  }

  if (!force && connectionCache.result && connectionCache.expiresAt > Date.now()) {
    return connectionCache.result;
  }

  try {
    const account = await alpacaRequest("/v2/account");
    const result = {
      connected: true,
      paperEndpointVerified: true,
      endpoint: PAPER_BASE_URL,
      accountStatus: account.status || "Unknown",
      accountNumberEnding: account.account_number
        ? account.account_number.slice(-4)
        : null,
      verifiedAt: new Date().toISOString(),
      message: "Connected to Alpaca Paper Trading.",
    };
    connectionCache = { result, expiresAt: Date.now() + 30000 };
    return result;
  } catch (error) {
    const result = {
      connected: false,
      paperEndpointVerified: true,
      endpoint: PAPER_BASE_URL,
      verifiedAt: new Date().toISOString(),
      message: error.message,
    };
    connectionCache = { result, expiresAt: Date.now() + 10000 };
    return result;
  }
}

async function getAssets() {
  if (assetsCache.expiresAt > Date.now() && assetsCache.bySymbol.size) {
    return assetsCache.bySymbol;
  }
  const assets = await alpacaRequest(
    "/v2/assets?status=active&asset_class=us_equity",
  );
  const bySymbol = new Map(
    assets
      .filter((asset) => asset.tradable && asset.class === "us_equity")
      .map((asset) => [asset.symbol, asset]),
  );
  assetsCache = { bySymbol, expiresAt: Date.now() + 6 * 60 * 60 * 1000 };
  return bySymbol;
}

async function discoverOpportunities(force = false) {
  if (!force && opportunitiesCache.expiresAt > Date.now()) {
    return opportunitiesCache;
  }
  const connection = await verifyPaperConnection();
  if (!connection.connected) {
    return { items: [], updatedAt: null, unavailableReason: connection.message };
  }

  const updatedAt = new Date().toISOString();
  const [assets, activeResponse] = await Promise.all([
    getAssets(),
    alpacaRequest(
      "/v1beta1/screener/stocks/most-actives?top=30&by=volume",
      { data: true },
    ),
  ]);
  const active =
    activeResponse.most_actives || activeResponse.mostActives || [];
  const symbols = active
    .map((item) => item.symbol)
    .filter((symbol) => assets.has(symbol));

  if (!symbols.length) {
    throw new AlpacaError(
      "Alpaca returned no active tradable stocks for this scan.",
      503,
    );
  }

  const snapshotsResponse = await alpacaRequest(
    `/v2/stocks/snapshots?symbols=${encodeURIComponent(symbols.join(","))}&feed=${DATA_FEED}`,
    { data: true },
  );
  const snapshots = snapshotsResponse.snapshots || snapshotsResponse;
  const items = rankOpportunities(
    symbols.map((symbol, index) =>
      buildOpportunity({
        asset: assets.get(symbol),
        snapshot: snapshots[symbol],
        activityRank: index + 1,
        researchUpdatedAt: updatedAt,
        feed: DATA_FEED,
      }),
    ),
  );

  opportunitiesCache = {
    items,
    updatedAt,
    expiresAt: Date.now() + settings.scanIntervalMinutes * 60 * 1000,
    unavailableReason: null,
  };
  marketStream.setSymbols(items.slice(0, 30).map((item) => item.symbol));
  broadcast("opportunities", {
    updatedAt,
    top: items[0]
      ? { symbol: items[0].symbol, rank: 1, score: items[0].score }
      : null,
  });
  return opportunitiesCache;
}

async function getDashboardData() {
  const connection = await verifyPaperConnection();
  if (!connection.connected) {
    return {
      connection,
      account: null,
      positions: [],
      orders: [],
      clock: null,
      syncedAt: null,
    };
  }

  const [account, positions, orders, clock] = await Promise.all([
    alpacaRequest("/v2/account"),
    alpacaRequest("/v2/positions"),
    alpacaRequest(
      "/v2/orders?status=all&limit=100&direction=desc&nested=true&asset_class=us_equity",
    ),
    alpacaRequest("/v2/clock"),
  ]);

  const thresholds = {
    stopLossPct: settings.stopLossPercent,
    takeProfitPct: settings.takeProfitPercent,
  };

  return {
    connection,
    account,
    positions: positions.map((position) => ({
      ...position,
      recommendation: positionRecommendation(position, thresholds),
    })),
    orders,
    clock,
    syncedAt: new Date().toISOString(),
  };
}

class MarketStream {
  constructor() {
    this.socket = null;
    this.symbols = [];
    this.status = credentialsConfigured ? "idle" : "not-configured";
    this.lastMessageAt = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
  }

  setSymbols(symbols) {
    const next = [...new Set(symbols)].slice(0, 30).sort();
    if (next.join(",") === this.symbols.join(",")) return;
    this.symbols = next;
    if (!credentialsConfigured || !next.length) return;
    this.connect(true);
  }

  connect(replace = false) {
    if (!credentialsConfigured || !this.symbols.length) return;
    if (replace && this.socket) {
      this.socket.paperIntentionalClose = true;
      this.socket.close();
      this.socket = null;
    }
    if (this.socket) return;

    this.intentionalClose = false;
    this.status = "connecting";
    const socket = new WebSocket(
      `wss://stream.data.alpaca.markets/v2/${DATA_FEED}`,
    );
    this.socket = socket;

    socket.addEventListener("open", () => {
      socket.send(
        JSON.stringify({ action: "auth", key: API_KEY, secret: SECRET_KEY }),
      );
    });

    socket.addEventListener("message", (event) => {
      let messages;
      try {
        messages = JSON.parse(String(event.data));
      } catch {
        return;
      }
      for (const message of Array.isArray(messages) ? messages : [messages]) {
        if (message.T === "success" && message.msg === "authenticated") {
          this.status = "connected";
          socket.send(
            JSON.stringify({
              action: "subscribe",
              trades: this.symbols,
              quotes: this.symbols,
            }),
          );
          broadcast("feed", this.summary());
        }
        if (message.T === "t" || message.T === "q") {
          this.lastMessageAt = message.t || new Date().toISOString();
          broadcast("price", {
            type: message.T === "t" ? "trade" : "quote",
            symbol: message.S,
            price: message.p ?? null,
            bid: message.bp ?? null,
            ask: message.ap ?? null,
            timestamp: message.t,
            feed: DATA_FEED,
          });
        }
        if (message.T === "error") {
          this.status = "error";
          broadcast("feed", this.summary(message.msg || "Stream error"));
        }
      }
    });

    socket.addEventListener("close", () => {
      if (socket.paperIntentionalClose) return;
      if (this.socket === socket) this.socket = null;
      this.status = "disconnected";
      broadcast("feed", this.summary());
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = setTimeout(() => this.connect(), 10000);
    });

    socket.addEventListener("error", () => {
      this.status = "error";
      broadcast("feed", this.summary("Unable to connect to market stream"));
    });
  }

  summary(message = null) {
    const stale =
      this.lastMessageAt &&
      Date.now() - new Date(this.lastMessageAt).getTime() > 90000;
    return {
      status: this.status,
      feed: DATA_FEED,
      coverage:
        DATA_FEED === "iex"
          ? "IEX exchange only"
          : DATA_FEED === "delayed_sip"
            ? "Consolidated SIP, delayed"
            : "Consolidated SIP",
      symbolCount: this.symbols.length,
      lastMessageAt: this.lastMessageAt,
      stale: Boolean(stale),
      message,
    };
  }
}

const marketStream = new MarketStream();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of eventClients) response.write(frame);
}

function startAutoTimer() {
  clearInterval(autoTimer);
  if (!settings.autoRunning) return;
  const interval = settings.scanIntervalMinutes * 60 * 1000;
  autoTimer = setInterval(() => {
    runAutomaticCycle().catch(() => {
      // Errors are surfaced through the event stream without logging credentials.
    });
  }, interval);
}

async function existingOrderForClientId(clientOrderId) {
  return alpacaRequest(
    `/v2/orders:by_client_order_id?client_order_id=${encodeURIComponent(clientOrderId)}`,
    { allowNotFound: true },
  );
}

function automaticClientOrderId(action, symbol) {
  const slot = Math.floor(
    Date.now() / (settings.scanIntervalMinutes * 60 * 1000),
  );
  return `paperdash-${action}-${symbol}-${slot}`.slice(0, 128);
}

async function submitAutomaticOrder(payload, clientOrderId) {
  if (!settings.autoRunning || settings.mode !== "auto") return null;
  const existing = await existingOrderForClientId(clientOrderId);
  if (existing) return existing;
  return alpacaRequest("/v2/orders", {
    method: "POST",
    body: { ...payload, client_order_id: clientOrderId },
  });
}

async function runAutomaticCycle() {
  if (
    autoCycleRunning ||
    !settings.autoRunning ||
    settings.mode !== "auto" ||
    !ownsWorkerLock
  ) {
    return;
  }
  autoCycleRunning = true;
  try {
    const connection = await verifyPaperConnection(true);
    if (!connection.connected) throw new AlpacaError(connection.message, 503);

    const [account, positions, openOrders, clock, discovery] = await Promise.all([
      alpacaRequest("/v2/account"),
      alpacaRequest("/v2/positions"),
      alpacaRequest(
        "/v2/orders?status=open&limit=500&direction=desc&asset_class=us_equity",
      ),
      alpacaRequest("/v2/clock"),
      discoverOpportunities(true),
    ]);

    if (!clock.is_open) {
      broadcast("auto", {
        status: "waiting",
        message: "Market is closed; no automatic paper order was submitted.",
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    for (const position of positions) {
      const recommendation = positionRecommendation(position, {
        stopLossPct: settings.stopLossPercent,
        takeProfitPct: settings.takeProfitPercent,
      });
      if (recommendation.action === "Hold and monitor") continue;
      const clientOrderId = automaticClientOrderId("exit", position.symbol);
      const order = await submitAutomaticOrder(
        {
          symbol: position.symbol,
          qty: String(Math.abs(Number(position.qty))),
          side: Number(position.qty) >= 0 ? "sell" : "buy",
          type: "market",
          time_in_force: "day",
        },
        clientOrderId,
      );
      if (order) {
        broadcast("auto", {
          status: "order-submitted",
          action: "exit",
          symbol: position.symbol,
          orderId: order.id,
          message: `Submitted a simulated exit order for ${position.symbol}.`,
        });
        return;
      }
    }

    if (positions.length >= settings.maxOpenPositions) {
      broadcast("auto", {
        status: "limit-reached",
        message: "Maximum open-position limit reached.",
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    const held = new Set(positions.map((position) => position.symbol));
    const pending = new Set(openOrders.map((order) => order.symbol));
    const candidate = discovery.items.find(
      (item) =>
        item.tradable &&
        item.score >= settings.minimumRankScore &&
        !held.has(item.symbol) &&
        !pending.has(item.symbol),
    );
    if (!candidate) {
      broadcast("auto", {
        status: "no-eligible-opportunity",
        message: "No ranked opportunity met every configured paper limit.",
        checkedAt: new Date().toISOString(),
      });
      return;
    }

    const equity = Number(account.equity || 0);
    const buyingPower = Number(account.buying_power || 0);
    const notional = Math.min(
      settings.maxOrderNotional,
      equity * (settings.maxPositionPercent / 100),
      buyingPower * 0.95,
    );
    if (notional < 1) {
      throw new AlpacaError("Insufficient paper buying power for configured limits.", 409);
    }

    const payload = candidate.fractionable
      ? {
          symbol: candidate.symbol,
          notional: notional.toFixed(2),
          side: "buy",
          type: "market",
          time_in_force: "day",
        }
      : {
          symbol: candidate.symbol,
          qty: String(Math.floor(notional / candidate.price)),
          side: "buy",
          type: "market",
          time_in_force: "day",
        };
    if (payload.qty === "0") return;

    const clientOrderId = automaticClientOrderId("entry", candidate.symbol);
    const order = await submitAutomaticOrder(payload, clientOrderId);
    if (order) {
      broadcast("auto", {
        status: "order-submitted",
        action: "entry",
        symbol: candidate.symbol,
        orderId: order.id,
        message: `Submitted a simulated entry order for ${candidate.symbol}.`,
      });
    }
  } catch (error) {
    broadcast("auto", {
      status: "error",
      message: error.message,
      checkedAt: new Date().toISOString(),
    });
  } finally {
    autoCycleRunning = false;
  }
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 100000) throw new AlpacaError("Request body is too large.", 413);
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new AlpacaError("Request body must be valid JSON.", 400);
  }
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(payload));
}

function sendStatic(response, fileName, contentType) {
  const filePath = path.join(ROOT, fileName);
  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(response, 404, { error: "Not found" });
      return;
    }
    response.writeHead(200, {
      "Content-Type": contentType,
      "Cache-Control": "no-cache",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy":
        "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'",
      "Referrer-Policy": "no-referrer",
    });
    response.end(data);
  });
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/status") {
    const connection = await verifyPaperConnection();
    sendJson(response, 200, {
      connection,
      paperOnly: true,
      endpoint: PAPER_BASE_URL,
      feed: marketStream.summary(),
      settings,
      automaticController: {
        lockOwned: ownsWorkerLock,
        cycleRunning: autoCycleRunning,
      },
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/connection/verify") {
    sendJson(response, 200, await verifyPaperConnection(true));
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, await getDashboardData());
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/opportunities") {
    const result = await discoverOpportunities(url.searchParams.get("refresh") === "1");
    sendJson(response, 200, {
      ...result,
      feed: marketStream.summary(),
      methodology: {
        type: "Rule-based market-data screen",
        probability: "Not calculated",
        eventVerification: "Unavailable",
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/settings") {
    sendJson(response, 200, {
      settings,
      endpoint: PAPER_BASE_URL,
      credentialsConfigured,
      feed: DATA_FEED,
    });
    return;
  }

  if (request.method === "PUT" && url.pathname === "/api/settings") {
    const body = await readJsonBody(request);
    settings = sanitizeSettings({ ...settings, ...body });
    if (settings.mode !== "auto") settings.autoRunning = false;
    saveSettings();
    opportunitiesCache.expiresAt = 0;
    startAutoTimer();
    sendJson(response, 200, { settings });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auto/start") {
    const body = await readJsonBody(request);
    if (body.confirmPaper !== true) {
      throw new AlpacaError("Paper-mode confirmation is required.", 400);
    }
    if (!ownsWorkerLock) {
      throw new AlpacaError(
        "Another local backend already controls automatic paper trading.",
        409,
      );
    }
    const connection = await verifyPaperConnection(true);
    if (!connection.connected) throw new AlpacaError(connection.message, 503);
    settings.mode = "auto";
    settings.autoRunning = true;
    saveSettings();
    startAutoTimer();
    runAutomaticCycle();
    broadcast("auto", {
      status: "running",
      message: "Automatic paper trading started.",
      startedAt: new Date().toISOString(),
    });
    sendJson(response, 200, { settings });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auto/pause") {
    settings.autoRunning = false;
    settings.mode = "manual";
    saveSettings();
    startAutoTimer();
    broadcast("auto", {
      status: "paused",
      message:
        "New automatic orders are paused. Existing positions and pending orders are unchanged.",
      pausedAt: new Date().toISOString(),
    });
    sendJson(response, 200, { settings });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    response.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    response.write(
      `event: ready\ndata: ${JSON.stringify({ connectedAt: new Date().toISOString() })}\n\n`,
    );
    eventClients.add(response);
    request.on("close", () => eventClients.delete(response));
    return;
  }

  sendJson(response, 404, { error: "API route not found." });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || HOST}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(request, response, url);
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    const files = {
      "/": ["index.html", "text/html; charset=utf-8"],
      "/index.html": ["index.html", "text/html; charset=utf-8"],
      "/styles.css": ["styles.css", "text/css; charset=utf-8"],
      "/app.js": ["app.js", "text/javascript; charset=utf-8"],
    };
    const file = files[url.pathname];
    if (!file) {
      sendJson(response, 404, { error: "Not found." });
      return;
    }
    sendStatic(response, file[0], file[1]);
  } catch (error) {
    const status = error instanceof AlpacaError ? error.status : 500;
    sendJson(response, status, {
      error: error.message || "Unexpected server error.",
      details: error instanceof AlpacaError ? error.details : null,
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Paper Compass is running at http://${HOST}:${PORT}`);
  console.log(`Trading endpoint locked to ${PAPER_BASE_URL}`);
  console.log(
    credentialsConfigured
      ? "Alpaca paper credentials detected."
      : "Alpaca not connected. Add paper credentials to .env, then restart.",
  );
});

function shutdown() {
  clearInterval(autoTimer);
  clearTimeout(marketStream.reconnectTimer);
  if (marketStream.socket) marketStream.socket.paperIntentionalClose = true;
  marketStream.socket?.close();
  releaseWorkerLock();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

