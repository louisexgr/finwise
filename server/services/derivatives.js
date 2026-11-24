/**
 * Simulated derivatives on the same underlyings as the rest of the app.
 *
 *  - Options (European, long only): priced with Black-Scholes from the live
 *    (or simulated) spot price, a per-asset implied volatility and a fixed
 *    risk-free rate. Greeks are computed analytically. Buying costs the
 *    premium; selling closes an existing position at the current model price.
 *    At expiry, positions settle automatically at intrinsic value.
 *  - Futures (long or short): futures price = spot × e^(rT) (cost of carry).
 *    Opening a position locks an initial margin (10% of notional) taken from
 *    cash; profit and loss is marked to market on every read. If losses eat
 *    the margin down to the maintenance level (5% of notional), the position
 *    is liquidated (margin call). At expiry it settles at the spot price.
 *
 * Everything is virtual money and deliberately simplified for teaching.
 */
import db, { findUserById } from "../db.js";
import { getQuote, getProfile, KNOWN_ASSETS } from "./market.js";

export const RISK_FREE = 0.04;
export const INITIAL_MARGIN = 0.10;
export const MAINTENANCE_MARGIN = 0.05;
const DAY_MS = 86_400_000;

db.exec(`
CREATE TABLE IF NOT EXISTS option_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  underlying  TEXT NOT NULL,
  type        TEXT NOT NULL,          -- 'call' | 'put'
  strike      REAL NOT NULL,
  expiry      TEXT NOT NULL,          -- YYYY-MM-DD
  multiplier  REAL NOT NULL,
  contracts   REAL NOT NULL,
  avg_premium REAL NOT NULL,          -- per unit of underlying
  UNIQUE (user_id, underlying, type, strike, expiry)
);
CREATE TABLE IF NOT EXISTS future_positions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  underlying  TEXT NOT NULL,
  side        TEXT NOT NULL,          -- 'long' | 'short'
  qty         REAL NOT NULL,          -- units of underlying
  entry_price REAL NOT NULL,
  margin      REAL NOT NULL,
  expiry      TEXT NOT NULL,
  opened_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* ------------------------------------------------------------------ */
/* Maths                                                               */
/* ------------------------------------------------------------------ */
function normCdf(x) {
  // Abramowitz & Stegun 7.1.26, max error ~1.5e-7
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}
const normPdf = x => Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);

/**
 * Black-Scholes price and Greeks for one unit of underlying.
 * @param {"call"|"put"} type  @param S spot  @param K strike  @param T years  @param sigma vol  @param r rate
 */
export function blackScholes(type, S, K, T, sigma, r = RISK_FREE) {
  if (T <= 0) {
    const intrinsic = Math.max(type === "call" ? S - K : K - S, 0);
    return { price: intrinsic, delta: intrinsic > 0 ? (type === "call" ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0 };
  }
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const disc = Math.exp(-r * T);
  const price = type === "call"
    ? S * normCdf(d1) - K * disc * normCdf(d2)
    : K * disc * normCdf(-d2) - S * normCdf(-d1);
  const delta = type === "call" ? normCdf(d1) : normCdf(d1) - 1;
  const gamma = normPdf(d1) / (S * sigma * sqrtT);
  const vega = S * normPdf(d1) * sqrtT / 100;                  // per 1 vol point
  const thetaYear = type === "call"
    ? -S * normPdf(d1) * sigma / (2 * sqrtT) - r * K * disc * normCdf(d2)
    : -S * normPdf(d1) * sigma / (2 * sqrtT) + r * K * disc * normCdf(-d2);
  return { price, delta, gamma, theta: thetaYear / 365, vega };    // theta per calendar day
}

/* ------------------------------------------------------------------ */
/* Market parameters                                                   */
/* ------------------------------------------------------------------ */
const VOL_OVERRIDE = { NVDA: 0.5, TSLA: 0.55, META: 0.38, AMZN: 0.32, BTC: 0.55, ETH: 0.7, SOL: 0.85, DOGE: 0.9 };
const CLASS_VOL = { stock: 0.28, etf: 0.17, crypto: 0.75, bond: 0.06 };

export function impliedVol(symbol, assetClass) {
  return VOL_OVERRIDE[symbol] ?? CLASS_VOL[assetClass] ?? 0.3;
}
/** Contract size: 100 units like listed equity options, 1 unit for very expensive assets. */
export function contractMultiplier(spot) {
  return spot >= 1000 ? 1 : 100;
}
const isoDay = d => d.toISOString().slice(0, 10);
function nextFriday(from, minDays) {
  const d = new Date(from.getTime() + minDays * DAY_MS);
  while (d.getUTCDay() !== 5) d.setTime(d.getTime() + DAY_MS);
  return d;
}
export function listExpiries(now = new Date()) {
  return [14, 30, 60, 90].map(n => isoDay(nextFriday(now, n)));
}
export function yearsTo(expiry, now = Date.now()) {
  return Math.max((new Date(expiry + "T21:00:00Z").getTime() - now) / (365 * DAY_MS), 0);
}
function strikeStep(spot) {
  const raw = spot * 0.05;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n < 1.5 ? 1 : n < 3.5 ? 2.5 : n < 7.5 ? 5 : 10) * pow;
}
export function futurePrice(spot, expiry) {
  return spot * Math.exp(RISK_FREE * yearsTo(expiry));
}

async function underlyingInfo(symbol) {
  const sym = String(symbol || "").toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) throw Object.assign(new Error("INVALID_SYMBOL"), { code: "INVALID_SYMBOL" });
  const [quote, profile] = await Promise.all([getQuote(sym), getProfile(sym)]);
  return { symbol: sym, spot: quote.price, name: profile.name, assetClass: profile.assetClass, simulated: !!quote.simulated };
}

/* ------------------------------------------------------------------ */
/* Option chain                                                        */
/* ------------------------------------------------------------------ */
const round = (n, d = 4) => +(+n).toFixed(d);
function quoteOption(type, spot, strike, expiry, sigma) {
  const g = blackScholes(type, spot, strike, yearsTo(expiry), sigma);
  return { price: round(g.price, 2), delta: round(g.delta, 3), gamma: round(g.gamma, 4), theta: round(g.theta, 3), vega: round(g.vega, 3) };
}

export async function getOptionChain(symbol, expiry) {
  const u = await underlyingInfo(symbol);
  const sigma = impliedVol(u.symbol, u.assetClass);
  const expiries = listExpiries();
  const exp = expiries.includes(expiry) ? expiry : expiries[1];
  const step = strikeStep(u.spot);
  const atm = Math.round(u.spot / step) * step;
  const strikes = [-3, -2, -1, 0, 1, 2, 3].map(i => round(atm + i * step, 2)).filter(k => k > 0);
  return {
    underlying: u.symbol, name: u.name, spot: u.spot, simulated: u.simulated,
    impliedVol: sigma, riskFree: RISK_FREE, multiplier: contractMultiplier(u.spot),
    expiries, expiry: exp, daysToExpiry: Math.round(yearsTo(exp) * 365),
    rows: strikes.map(K => ({ strike: K, call: quoteOption("call", u.spot, K, exp, sigma), put: quoteOption("put", u.spot, K, exp, sigma) })),
  };
}

/* ------------------------------------------------------------------ */
/* Positions, settlement, orders                                       */
/* ------------------------------------------------------------------ */
const q = {
  options: db.prepare("SELECT * FROM option_positions WHERE user_id = ? ORDER BY expiry, underlying, strike"),
  option: db.prepare("SELECT * FROM option_positions WHERE user_id = ? AND underlying = ? AND type = ? AND strike = ? AND expiry = ?"),
  insOption: db.prepare(`INSERT INTO option_positions (user_id, underlying, type, strike, expiry, multiplier, contracts, avg_premium)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
  updOption: db.prepare("UPDATE option_positions SET contracts = ?, avg_premium = ? WHERE id = ?"),
  delOption: db.prepare("DELETE FROM option_positions WHERE id = ?"),
  futures: db.prepare("SELECT * FROM future_positions WHERE user_id = ? ORDER BY id"),
  future: db.prepare("SELECT * FROM future_positions WHERE user_id = ? AND id = ?"),
  insFuture: db.prepare(`INSERT INTO future_positions (user_id, underlying, side, qty, entry_price, margin, expiry) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  delFuture: db.prepare("DELETE FROM future_positions WHERE id = ?"),
  cash: db.prepare("SELECT cash FROM users WHERE id = ?"),
  setCash: db.prepare("UPDATE users SET cash = ? WHERE id = ?"),
  tx: db.prepare("INSERT INTO transactions (user_id, symbol, side, qty, price, total) VALUES (?, ?, ?, ?, ?, ?)"),
};
const addCash = (userId, delta) => q.setCash.run(round(q.cash.get(userId).cash + delta, 2), userId);
export const optionLabel = (o) => `${o.underlying} ${o.strike}${o.type === "call" ? "C" : "P"} ${o.expiry}`;

function futurePnl(f, price) {
  return (price - f.entry_price) * f.qty * (f.side === "long" ? 1 : -1);
}

/** Settles expired options/futures and liquidates futures under maintenance margin. */
async function settle(userId) {
  const events = [];
  const now = Date.now();
  for (const o of q.options.all(userId)) {
    if (yearsTo(o.expiry, now) > 0) continue;
    const { spot } = await underlyingInfo(o.underlying);
    const intrinsic = Math.max(o.type === "call" ? spot - o.strike : o.strike - spot, 0);
    const payout = round(intrinsic * o.multiplier * o.contracts, 2);
    db.transaction(() => {
      addCash(userId, payout);
      q.tx.run(userId, optionLabel(o), "expire", o.contracts, intrinsic, payout);
      q.delOption.run(o.id);
    })();
    events.push({ kind: "option_expired", label: optionLabel(o), payout });
  }
  for (const f of q.futures.all(userId)) {
    const { spot } = await underlyingInfo(f.underlying);
    const expired = yearsTo(f.expiry, now) <= 0;
    const price = expired ? spot : futurePrice(spot, f.expiry);
    const pnl = futurePnl(f, price);
    const equity = f.margin + pnl;
    const maintenance = MAINTENANCE_MARGIN * price * f.qty;
    if (!expired && equity > maintenance) continue;
    const back = round(Math.max(equity, 0), 2);
    db.transaction(() => {
      addCash(userId, back);
      q.tx.run(userId, `${f.underlying} FUT ${f.expiry}`, expired ? "expire" : "liquidated", f.qty, round(price, 2), back);
      q.delFuture.run(f.id);
    })();
    events.push({ kind: expired ? "future_expired" : "margin_call", label: `${f.side} ${f.qty} ${f.underlying} future`, cashBack: back, pnl: round(pnl, 2) });
  }
  return events;
}

export async function getDerivativesPositions(userId) {
  const events = await settle(userId);
  const options = await Promise.all(q.options.all(userId).map(async o => {
    const u = await underlyingInfo(o.underlying);
    const g = quoteOption(o.type, u.spot, o.strike, o.expiry, impliedVol(u.symbol, u.assetClass));
    const units = o.multiplier * o.contracts;
    return {
      id: o.id, label: optionLabel(o), underlying: o.underlying, type: o.type, strike: o.strike, expiry: o.expiry,
      daysToExpiry: Math.ceil(yearsTo(o.expiry) * 365), multiplier: o.multiplier, contracts: o.contracts,
      spot: u.spot, avgPremium: o.avg_premium, price: g.price,
      value: round(g.price * units, 2), cost: round(o.avg_premium * units, 2),
      pnl: round((g.price - o.avg_premium) * units, 2),
      delta: round(g.delta * units, 2), gamma: round(g.gamma * units, 3), theta: round(g.theta * units, 2), vega: round(g.vega * units, 2),
      deltaPerContract: g.delta, thetaPerContract: round(g.theta * o.multiplier, 2),
    };
  }));
  const futures = await Promise.all(q.futures.all(userId).map(async f => {
    const u = await underlyingInfo(f.underlying);
    const price = futurePrice(u.spot, f.expiry);
    const pnl = futurePnl(f, price);
    const dir = f.side === "long" ? 1 : -1;
    // price at which equity = maintenance margin
    const liq = (f.entry_price * dir * f.qty - f.margin) / (f.qty * (dir - MAINTENANCE_MARGIN));
    return {
      id: f.id, underlying: f.underlying, side: f.side, qty: f.qty, expiry: f.expiry, spot: u.spot,
      entryPrice: round(f.entry_price, 2), price: round(price, 2), notional: round(price * f.qty, 2),
      margin: round(f.margin, 2), pnl: round(pnl, 2), equity: round(f.margin + pnl, 2),
      leverage: round((price * f.qty) / Math.max(f.margin + pnl, 0.01), 1),
      liquidationPrice: round(liq, 2), openedAt: f.opened_at,
    };
  }));
  return { options, futures, events, cash: findUserById.get(userId).cash };
}

/** Prices an option order without executing it (used by the coach and the UI). */
export async function previewOptionOrder(userId, { underlying, type, strike, expiry, contracts, side }) {
  if (!["call", "put"].includes(type)) return { error: "INVALID_TYPE" };
  if (!["buy", "sell"].includes(side)) return { error: "INVALID_SIDE" };
  const n = Math.round(Number(contracts));
  if (!Number.isFinite(n) || n < 1 || n > 1000) return { error: "INVALID_QTY" };
  if (!listExpiries().includes(expiry)) return { error: "INVALID_EXPIRY", expiries: listExpiries() };
  const K = Number(strike);
  if (!Number.isFinite(K) || K <= 0) return { error: "INVALID_STRIKE" };
  let u;
  try { u = await underlyingInfo(underlying); } catch { return { error: "SYMBOL_NOT_FOUND" }; }
  const g = quoteOption(type, u.spot, K, expiry, impliedVol(u.symbol, u.assetClass));
  const multiplier = contractMultiplier(u.spot);
  const total = round(g.price * multiplier * n, 2);
  const cash = findUserById.get(userId).cash;
  const held = q.option.get(userId, u.symbol, type, K, expiry);
  if (side === "buy" && total > cash) return { error: "INSUFFICIENT_CASH", cash, estimatedTotal: total };
  if (side === "sell" && (!held || held.contracts < n)) return { error: "INSUFFICIENT_CONTRACTS", held: held?.contracts || 0 };
  const breakeven = type === "call" ? K + g.price : K - g.price;
  return {
    proposal: {
      kind: "option", underlying: u.symbol, name: u.name, type, strike: K, expiry, side, contracts: n, multiplier,
      spot: u.spot, premium: g.price, estimatedTotal: total, breakeven: round(breakeven, 2),
      maxLoss: side === "buy" ? total : null, greeks: g,
      cashAfter: round(side === "buy" ? cash - total : cash + total, 2),
    },
  };
}

export async function executeOptionOrder(userId, input) {
  const p = await previewOptionOrder(userId, input);
  if (!p.proposal) throw Object.assign(new Error(p.error), { code: p.error });
  const o = p.proposal;
  db.transaction(() => {
    const held = q.option.get(userId, o.underlying, o.type, o.strike, o.expiry);
    if (o.side === "buy") {
      if (q.cash.get(userId).cash < o.estimatedTotal) throw Object.assign(new Error("INSUFFICIENT_CASH"), { code: "INSUFFICIENT_CASH" });
      addCash(userId, -o.estimatedTotal);
      if (held) {
        const n = held.contracts + o.contracts;
        q.updOption.run(n, round((held.avg_premium * held.contracts + o.premium * o.contracts) / n, 4), held.id);
      } else {
        q.insOption.run(userId, o.underlying, o.type, o.strike, o.expiry, o.multiplier, o.contracts, o.premium);
      }
    } else {
      addCash(userId, o.estimatedTotal);
      const left = held.contracts - o.contracts;
      if (left <= 0) q.delOption.run(held.id); else q.updOption.run(left, held.avg_premium, held.id);
    }
    q.tx.run(userId, optionLabel(o), o.side, o.contracts, o.premium, o.estimatedTotal);
  })();
  return o;
}

/** Prices a futures position without opening it. */
export async function previewFutureOrder(userId, { underlying, side, qty }) {
  if (!["long", "short"].includes(side)) return { error: "INVALID_SIDE" };
  const n = Math.round(Number(qty) * 1e6) / 1e6;
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return { error: "INVALID_QTY" };
  let u;
  try { u = await underlyingInfo(underlying); } catch { return { error: "SYMBOL_NOT_FOUND" }; }
  const expiry = listExpiries()[3];
  const price = futurePrice(u.spot, expiry);
  const notional = round(price * n, 2);
  const margin = round(notional * INITIAL_MARGIN, 2);
  const cash = findUserById.get(userId).cash;
  if (margin > cash) return { error: "INSUFFICIENT_CASH", cash, marginRequired: margin };
  const dir = side === "long" ? 1 : -1;
  const liq = (price * dir * n - margin) / (n * (dir - MAINTENANCE_MARGIN));
  return {
    proposal: {
      kind: "future", underlying: u.symbol, name: u.name, side, qty: n, expiry, spot: u.spot,
      futurePrice: round(price, 2), notional, margin, leverage: round(1 / INITIAL_MARGIN, 0),
      liquidationPrice: round(liq, 2), pnlPer1Pct: round(notional * 0.01 * dir, 2),
      cashAfter: round(cash - margin, 2),
    },
  };
}

export async function openFuture(userId, input) {
  const p = await previewFutureOrder(userId, input);
  if (!p.proposal) throw Object.assign(new Error(p.error), { code: p.error });
  const f = p.proposal;
  db.transaction(() => {
    if (q.cash.get(userId).cash < f.margin) throw Object.assign(new Error("INSUFFICIENT_CASH"), { code: "INSUFFICIENT_CASH" });
    addCash(userId, -f.margin);
    q.insFuture.run(userId, f.underlying, f.side, f.qty, f.futurePrice, f.margin, f.expiry);
    q.tx.run(userId, `${f.underlying} FUT ${f.expiry}`, f.side === "long" ? "buy" : "sell", f.qty, f.futurePrice, f.margin);
  })();
  return f;
}

export async function closeFuture(userId, id) {
  await settle(userId);
  const f = q.future.get(userId, Number(id));
  if (!f) throw Object.assign(new Error("NOT_FOUND"), { code: "NOT_FOUND" });
  const { spot } = await underlyingInfo(f.underlying);
  const price = futurePrice(spot, f.expiry);
  const pnl = futurePnl(f, price);
  const back = round(Math.max(f.margin + pnl, 0), 2);
  db.transaction(() => {
    addCash(userId, back);
    q.tx.run(userId, `${f.underlying} FUT ${f.expiry}`, f.side === "long" ? "sell" : "buy", f.qty, round(price, 2), back);
    q.delFuture.run(f.id);
  })();
  return { closedAt: round(price, 2), pnl: round(pnl, 2), cashBack: back };
}

/** Underlyings offered in the UI picker. */
export const DERIVATIVE_UNDERLYINGS = KNOWN_ASSETS
  .filter(a => ["stock", "etf", "crypto"].includes(a.class))
  .map(a => ({ symbol: a.symbol, name: a.name, assetClass: a.class }));
