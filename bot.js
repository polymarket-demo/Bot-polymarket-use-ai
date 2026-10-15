
require("dotenv").config();

const { createClient } = require("@supabase/supabase-js");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const CLOB_API_URL = process.env.CLOB_API_URL || "https://clob.polymarket.com";
const GAMMA_API_URL = "https://gamma-api.polymarket.com";

const RECORD_ALL = process.env.RECORD_ALL !== "false";

const RECORD_EXTREMES = true;
const LOW_THRESHOLD = 0.10;
const HIGH_THRESHOLD = 0.90;

const MIN_LIQUIDITY = 500;
const MIN_EDGE = 0.02;
const MAX_CAPITAL = 250;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

const round = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

async function fetchActiveMarkets() {
  const out = [];
  const LIMIT = 500;

  for (let offset = 0; offset < 3000; offset += LIMIT) {
    const res = await fetch(
      `${GAMMA_API_URL}/markets?closed=false&active=true&limit=${LIMIT}&offset=${offset}`
    );
    if (!res.ok) break;
    const data = await res.json();
    const page = Array.isArray(data) ? data : data.data ?? [];
    if (page.length === 0) break;
    out.push(...page);
    if (page.length < LIMIT) break;
  }

  return out.filter(
    (m) => m.closed === false && m.active === true && m.acceptingOrders === true
  );
}

async function fetchBook(tokenId) {
  const res = await fetch(`${CLOB_API_URL}/book?token_id=${tokenId}`);
  if (!res.ok) throw new Error(`book ${res.status}`);
  const data = await res.json();
  const parse = (arr) =>
    (arr ?? []).map((l) => [parseFloat(l.price), parseFloat(l.size)]);
  return { bids: parse(data.bids), asks: parse(data.asks) };
}

function topOfBook(book) {
  const bestBid = book.bids.length ? Math.max(...book.bids.map(([p]) => p)) : 0;
  const bestAsk = book.asks.length ? Math.min(...book.asks.map(([p]) => p)) : 1;
  return { bestBid, bestAsk };
}

function bookLiquidity(book) {
  const sum = (arr) => arr.reduce((a, [p, s]) => a + p * s, 0);
  return sum(book.bids) + sum(book.asks);
}

function extremeRows(m, tokens, quotes) {
  if (!RECORD_EXTREMES) return [];
  const rows = [];
  const names = ["YES", "NO"];

  for (let i = 0; i < 2; i++) {
    const { yesBid, yesAsk, noBid, noAsk } = quotes;
    const bid = i === 0 ? yesBid : noBid;
    const ask = i === 0 ? yesAsk : noAsk;
    if (bid <= 0 || ask >= 1) continue;

    let side = null;
    if (ask <= LOW_THRESHOLD) side = "LOW";
    else if (bid >= HIGH_THRESHOLD) side = "HIGH";
    if (!side) continue;

    rows.push({
      category: m.category ?? null,
      event_title: null,
      market_title: `${m.question} [${names[i]}]`,
      condition_id: m.conditionId,
      signal_type: side === "LOW" ? "EXTREME_LOW" : "EXTREME_HIGH",
      side,
      detail: `side=${side} bid=${bid.toFixed(4)} ask=${ask.toFixed(4)} token=${tokens[i]}`,
      price_sum: round(bid + (i === 0 ? noBid : yesBid), 4),
      edge: round(1 - (yesAsk + noAsk), 4),
      spread: round(ask - bid, 6),
      capital_needed: 0,
      liquidity: 0,
      live: false,
    });
  }
  return rows;
}

async function analyzeMarket(m) {
  let tokens;
  try {
    tokens =
      typeof m.clobTokenIds === "string"
        ? JSON.parse(m.clobTokenIds)
        : m.clobTokenIds;
  } catch {
    return { main: null, extremes: [] };
  }
  if (!Array.isArray(tokens) || tokens.length !== 2) {
    return { main: null, extremes: [] };
  }

  const [yesBook, noBook] = await Promise.all([
    fetchBook(tokens[0]),
    fetchBook(tokens[1]),
  ]);

  const { bestBid: yesBid, bestAsk: yesAsk } = topOfBook(yesBook);
  const { bestBid: noBid, bestAsk: noAsk } = topOfBook(noBook);

  const priceSum = yesAsk + noAsk;
  const edge = 1 - priceSum;
  const spread = ((yesAsk - yesBid) + (noAsk - noBid)) / 2;
  const liquidity = bookLiquidity(yesBook) + bookLiquidity(noBook);
  const capitalNeeded = Math.min(MAX_CAPITAL, liquidity * 0.1);

  const extremes = extremeRows(m, tokens, { yesBid, yesAsk, noBid, noAsk });

  let main = null;
  if (priceSum > 0 && priceSum < 2) {
    main = {
      category: m.category ?? null,
      sport: null,
      is_live_event: false,
      side: null,
      event_title: null,
      market_title: m.question,
      condition_id: m.conditionId,
      signal_type: edge >= MIN_EDGE ? "ARB_BUY_BOTH" : "WATCH",
      detail: `yesBid=${yesBid.toFixed(3)} yesAsk=${yesAsk.toFixed(3)} noBid=${noBid.toFixed(3)} noAsk=${noAsk.toFixed(3)} sum=${priceSum.toFixed(3)} edge=${(edge * 100).toFixed(2)}% spread=${(spread * 100).toFixed(3)}%`,
      price_sum: round(priceSum, 4),
      edge: round(edge, 4),
      spread: round(spread, 6),
      capital_needed: round(capitalNeeded, 2),
      liquidity: round(liquidity, 2),
      live: Math.abs(edge) >= MIN_EDGE && liquidity >= MIN_LIQUIDITY,
    };
  }

  return { main, extremes };
}

async function scanOnce() {
  const markets = await fetchActiveMarkets();
  console.log(`[scan] ${markets.length} mercati attivi`);

  const signals = [];
  const extremes = [];
  const BATCH = 8;

  for (let i = 0; i < markets.length; i += BATCH) {
    const slice = markets.slice(i, i + BATCH);
    const results = await Promise.all(
      slice.map((m) => analyzeMarket(m).catch(() => ({ main: null, extremes: [] })))
    );
    for (const r of results) {
      if (r.main) signals.push(r.main);
      for (const e of r.extremes) extremes.push(e);
    }
  }

  const mainToSave = RECORD_ALL ? signals : signals.filter((s) => s.live);
  const toSave = [...mainToSave, ...extremes];

  if (toSave.length > 0) {
    const CHUNK = 500;
    for (let i = 0; i < toSave.length; i += CHUNK) {
      const chunk = toSave.slice(i, i + CHUNK);
      const { error } = await supabase.from("signals").insert(chunk);
      if (error) throw new Error(`insert: ${error.message}`);
    }
    console.log(`[scan] scritte ${toSave.length} righe (${extremes.length} estremi)`);
  }

  const best = signals.reduce((a, s) => (a === null || s.edge > a ? s.edge : a), null);
  const widest = signals.reduce((a, s) => (a === null || s.spread > a ? s.spread : a), null);
  const lowCount = extremes.filter((e) => e.side === "LOW").length;
  const highCount = extremes.filter((e) => e.side === "HIGH").length;

  console.log(
    `[scan] ${signals.length} analizzati | edge migliore: ${
      best === null ? "n/d" : (best * 100).toFixed(2) + "%"
    } | spread max: ${widest === null ? "n/d" : (widest * 100).toFixed(2) + "%"} | estremi: ${lowCount} sotto ${LOW_THRESHOLD} / ${highCount} sopra ${HIGH_THRESHOLD}`
  );
  return toSave.length;
}

async function main() {
  const intervalMs = Number(process.env.SCAN_INTERVAL_MS ?? 60000);
  console.log(`[start] scan ogni ${intervalMs / 1000}s | registra tutto: ${RECORD_ALL} | estremi: ${RECORD_EXTREMES}`);

  const loop = async () => {
    try {
      await scanOnce();
    } catch (e) {
      console.error("[scan] errore:", e);
    }
  };

  await loop();
  if (!process.env.GITHUB_ACTIONS) {
    setInterval(loop, intervalMs);
  }
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
