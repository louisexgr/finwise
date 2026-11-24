/**
 * Finwise coach — Claude with tools.
 *
 * The coach can read the user's portfolio, budget, quotes and news through
 * tools that call the same server-side code as the rest of the app. It can
 * PROPOSE simulated orders but never execute them: proposals are returned
 * to the browser, which shows a confirmation card; the order only runs when
 * the user clicks "Confirm" (regular POST /api/portfolio/order, server-side
 * price). Without ANTHROPIC_API_KEY the caller falls back to the rules engine.
 */
import Anthropic from "@anthropic-ai/sdk";
import { getHoldings, findUserById, getBudget, getPlan, getDeposits } from "../db.js";
import { getQuote, getQuotes, getProfile, searchSymbols } from "./market.js";
import { getMarketNews, NEWS_CATEGORIES } from "./news.js";
import { analyzePortfolio } from "./agent.js";

export const COACH_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5-5";
const MAX_TOOL_ROUNDS = 6;

let client = null;
export function coachEnabled() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}
function getClient() {
  if (!client) client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
  return client;
}

/* ------------------------------------------------------------------ */
/* Data helpers shared by the tools and the rules engine               */
/* ------------------------------------------------------------------ */
export async function buildAnalysis(userId) {
  const holdings = getHoldings.all(userId);
  const user = findUserById.get(userId);
  const quotes = holdings.length ? await getQuotes(holdings.map(h => h.symbol)) : {};
  return analyzePortfolio(holdings, quotes, user.cash);
}

export function buildBudgetSummary(userId) {
  const b = getBudget.get(userId);
  const plan = getPlan.get(userId);
  const deposits = getDeposits.all(userId).slice(0, 10);
  if (!b) return { hasBudget: false };
  const income = b.monthly_income;
  const fixed = b.housing + b.daily_life + b.subscriptions;
  const invest = +(income * b.invest_pct / 100).toFixed(2);
  const leftover = +(income - fixed - invest).toFixed(2);
  const pct = v => (income > 0 ? +((v / income) * 100).toFixed(1) : 0);
  return {
    hasBudget: true,
    monthlyIncome: income,
    housing: { amount: b.housing, pctOfIncome: pct(b.housing) },
    dailyLife: { amount: b.daily_life, pctOfIncome: pct(b.daily_life) },
    subscriptions: { amount: b.subscriptions, pctOfIncome: pct(b.subscriptions) },
    investing: { amount: invest, pctOfIncome: b.invest_pct },
    leftoverPerMonth: { amount: leftover, pctOfIncome: pct(leftover) },
    savingsCautionThresholdPct: 10,
    recurringPlan: plan ? { monthlyAmount: plan.monthly_amount, active: !!plan.active, lastExecutedAt: plan.last_executed_at } : null,
    recentDeposits: deposits.map(d => ({ amount: d.amount, type: d.type, date: d.created_at })),
  };
}

export async function buildOrderProposal(userId, { symbol, side, qty, reason }) {
  const sym = String(symbol || "").toUpperCase().trim();
  if (!/^[A-Z0-9.\-]{1,12}$/.test(sym)) return { error: "INVALID_SYMBOL" };
  if (!["buy", "sell"].includes(side)) return { error: "INVALID_SIDE" };
  const q = Math.round(Number(qty) * 1e6) / 1e6;
  if (!isFinite(q) || q <= 0 || q > 100000) return { error: "INVALID_QTY" };

  let quote, profile;
  try {
    quote = await getQuote(sym);
    profile = await getProfile(sym);
  } catch {
    return { error: "SYMBOL_NOT_FOUND" };
  }
  const user = findUserById.get(userId);
  const held = getHoldings.all(userId).find(h => h.symbol === sym);
  const estTotal = +(quote.price * q).toFixed(2);
  if (side === "buy" && estTotal > user.cash) {
    return { error: "INSUFFICIENT_CASH", cash: user.cash, estimatedTotal: estTotal, price: quote.price };
  }
  if (side === "sell" && (!held || held.shares < q)) {
    return { error: "INSUFFICIENT_SHARES", sharesHeld: held?.shares || 0 };
  }
  return {
    proposal: {
      symbol: sym, side, qty: q,
      name: profile?.name || sym,
      estimatedPrice: quote.price,
      estimatedTotal: estTotal,
      cashAfter: +(side === "buy" ? user.cash - estTotal : user.cash + estTotal).toFixed(2),
      reason: String(reason || "").slice(0, 300),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */
const NEWS_IDS = NEWS_CATEGORIES.map(c => c.id);

const TOOLS = [
  {
    name: "get_portfolio",
    description: "Returns the user's simulated portfolio: cash, invested value, every position (symbol, shares, average cost, current price, value), breakdowns by sector / country / asset class, and concentration alerts. Call this before commenting on the portfolio.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_budget",
    description: "Returns the user's monthly budget: income, housing, daily life, subscriptions, amount invested each month (and % of income), money left over, recurring investment plan and recent deposits.",
    input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
  },
  {
    name: "get_quote",
    description: "Returns the current price and daily change of one asset, plus its name, sector, country and asset class.",
    input_schema: {
      type: "object",
      properties: { symbol: { type: "string", description: "Ticker, e.g. AAPL, CW8, BTC" } },
      required: ["symbol"], additionalProperties: false,
    },
  },
  {
    name: "search_assets",
    description: "Searches tradable assets by name or ticker. Use it to find the right ticker before quoting or proposing an order.",
    input_schema: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"], additionalProperties: false,
    },
  },
  {
    name: "get_news",
    description: "Returns recent financial news headlines with summaries and related tickers. Category 'portfolio' returns news about the assets the user holds.",
    input_schema: {
      type: "object",
      properties: {
        category: { type: "string", enum: NEWS_IDS },
        limit: { type: "integer", enum: [3, 5, 8] },
      },
      required: ["category", "limit"], additionalProperties: false,
    },
  },
  {
    name: "propose_order",
    description: "Proposes a SIMULATED buy or sell order. It does NOT execute anything: the user sees a confirmation card and decides. Only propose an order when the user asks for one or agrees to one. Returns the estimated price and total, or an error (insufficient cash or shares, unknown ticker).",
    input_schema: {
      type: "object",
      properties: {
        symbol: { type: "string" },
        side: { type: "string", enum: ["buy", "sell"] },
        qty: { type: "number", description: "Number of shares; fractions allowed" },
        reason: { type: "string", description: "One short sentence the user will see on the card" },
      },
      required: ["symbol", "side", "qty", "reason"], additionalProperties: false,
    },
  },
].map(t => ({ ...t, strict: true }));

async function runTool(name, input, ctx) {
  switch (name) {
    case "get_portfolio": {
      const a = await buildAnalysis(ctx.userId);
      return {
        cash: a.cash, invested: a.invested, total: +(a.cash + a.invested).toFixed(2),
        positions: a.positions.map(p => ({
          symbol: p.symbol, name: p.name, assetClass: p.asset_class, sector: p.sector, country: p.country,
          shares: p.shares, avgCost: p.avg_cost, price: p.price, value: p.value,
          pnl: +((p.price - p.avg_cost) * p.shares).toFixed(2),
        })),
        sectorBreakdown: a.sectorBreakdown, countryBreakdown: a.countryBreakdown, classBreakdown: a.classBreakdown,
        alerts: a.alerts, underRepresentedSectors: a.underRepresented, sectorCautionThresholdPct: a.threshold,
      };
    }
    case "get_budget":
      return buildBudgetSummary(ctx.userId);
    case "get_quote": {
      const sym = String(input.symbol || "").toUpperCase();
      const [quote, profile] = await Promise.all([getQuote(sym), getProfile(sym)]);
      return { ...quote, ...profile };
    }
    case "search_assets":
      return (await searchSymbols(String(input.query || ""))).slice(0, 8);
    case "get_news": {
      const held = getHoldings.all(ctx.userId).map(h => h.symbol);
      const items = await getMarketNews({ category: input.category, heldSymbols: held });
      return items.slice(0, input.limit || 5).map(n => ({
        headline: n.headline, summary: (n.summary || "").slice(0, 500), source: n.source,
        date: new Date(n.datetime).toISOString().slice(0, 10),
        relatedSymbols: (n.relatedSymbols || []).map(r => r.symbol ?? r),
      }));
    }
    case "propose_order": {
      const out = await buildOrderProposal(ctx.userId, input);
      if (out.proposal) {
        ctx.proposals.push(out.proposal);
        return { ...out.proposal, status: "shown_to_user_for_confirmation" };
      }
      return out;
    }
    default:
      return { error: "UNKNOWN_TOOL" };
  }
}

/* ------------------------------------------------------------------ */
/* System prompt — static, so it can be cached                         */
/* ------------------------------------------------------------------ */
const SYSTEM_PROMPT = `You are the Finwise coach, a friendly money coach inside Finwise, a portfolio SIMULATOR used by students and young people to learn investing with virtual money.

What you do:
- Analyse the user's simulated portfolio (diversification, concentration, risk in dollars, gains and losses) and their monthly budget (how much goes to housing, daily life, subscriptions, investing, and what is left).
- Explain financial news in plain words: what happened, why it matters, and which of the user's holdings it may affect.
- Teach concepts when useful: diversification, volatility, DCA, compound interest, ETFs, bonds, crypto, fees, time horizon, emergency fund.
- Propose simulated buy or sell orders with the propose_order tool when the user asks for an order or agrees to one. The user confirms or cancels on a card; never say an order was executed.

How you work:
- Use the tools to get real numbers before talking about the portfolio, the budget, a price or the news. Never invent numbers, prices or headlines.
- Turn percentages into dollar amounts to make risk concrete (for example: "a 20% drop in tech would cost you about $1,240").
- This is a simulator with virtual money and you are an educational tool, not a financial adviser. Do not tell the user what to do with real money. When you suggest a move in the simulator, explain the trade-off.
- If the user asks for something outside personal finance and investing, say briefly that you are here for money questions.
- Reply in English, in a warm and direct tone, in at most about 150 words unless the user asks for detail. Use short paragraphs or a short list; no tables, no headings.`;

/* ------------------------------------------------------------------ */
/* Chat loop                                                           */
/* ------------------------------------------------------------------ */
/**
 * @param {string} message      the user's new message
 * @param {{role:string, content:string}[]} history  previous text turns
 * @param {{userId:number}} ctx
 * @returns {Promise<{reply:string, proposals:object[]}>}
 */
export async function coachReply(message, history, { userId }) {
  const ctx = { userId, proposals: [] };
  const messages = [...history, { role: "user", content: message }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await getClient().beta.messages.create({
      model: COACH_MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium" },
      system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
      tools: TOOLS,
      messages,
    });

    if (response.stop_reason === "refusal") {
      return { reply: "I can't help with that one. Ask me about your portfolio, your budget or the news.", proposals: ctx.proposals };
    }

    const toolUses = response.content.filter(b => b.type === "tool_use");
    if (response.stop_reason !== "tool_use" || !toolUses.length) {
      const reply = response.content.filter(b => b.type === "text").map(b => b.text).join("\n").trim();
      return { reply: reply || "Sorry, I lost my train of thought. Could you ask again?", proposals: ctx.proposals };
    }

    // Keep the assistant turn exactly as returned (thinking and fallback blocks included).
    messages.push({ role: "assistant", content: response.content });
    const results = await Promise.all(toolUses.map(async tu => {
      try {
        const out = await runTool(tu.name, tu.input, ctx);
        return { type: "tool_result", tool_use_id: tu.id, content: JSON.stringify(out) };
      } catch (e) {
        return { type: "tool_result", tool_use_id: tu.id, content: `Tool failed: ${e.message}`, is_error: true };
      }
    }));
    messages.push({ role: "user", content: results });
  }
  return { reply: "That took me too many steps. Could you ask a narrower question?", proposals: ctx.proposals };
}
