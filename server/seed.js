/**
 * Demo account, recreated from scratch at every server start so a visitor
 * (friend, recruiter) always lands on a clean, filled-in portfolio.
 * Disable with SEED_DEMO=false. The demo account cannot change its
 * credentials or delete itself (see middleware/demoGuard.js).
 */
import bcrypt from "bcryptjs";
import db, {
  findUserByEmail, insertUser, deleteUserById, setOnboarded, updateCash,
  upsertBudget, upsertPlan, insertDeposit, runOrderTx,
} from "./db.js";
import { KNOWN_ASSETS } from "./services/market.js";

export const DEMO_EMAIL = (process.env.DEMO_EMAIL || "demo@finwise.app").toLowerCase();
export const DEMO_PASSWORD = process.env.DEMO_PASSWORD || "finwise-demo";

// Deliberately tech-heavy, so the coach has a concentration risk to talk about.
const DEMO_ORDERS = [
  { symbol: "AAPL", qty: 6, discount: 0.86, daysAgo: 160 },
  { symbol: "NVDA", qty: 12, discount: 0.72, daysAgo: 150 },
  { symbol: "MSFT", qty: 3, discount: 0.93, daysAgo: 120 },
  { symbol: "CW8.PA", qty: 2, discount: 0.95, daysAgo: 95 },
  { symbol: "JNJ", qty: 4, discount: 1.03, daysAgo: 70 },
  { symbol: "UST10", qty: 5, discount: 1.0, daysAgo: 45 },
  { symbol: "BTC", qty: 0.004, discount: 0.9, daysAgo: 30 },
];

export function seedDemoAccount() {
  if (process.env.SEED_DEMO === "false") return;

  const existing = findUserByEmail.get(DEMO_EMAIL);
  if (existing) deleteUserById.run(existing.id); // cascade: start from a clean slate

  const info = insertUser.run(DEMO_EMAIL, bcrypt.hashSync(DEMO_PASSWORD, 10), "Alex");
  const id = info.lastInsertRowid;

  const income = 2400;
  upsertBudget.run({
    user_id: id, monthly_income: income, housing: 780, daily_life: 620, subscriptions: 145,
    invest_pct: 10, dca_mode: "dca",
  });
  upsertPlan.run(id, income * 0.10);
  setOnboarded.run(id);

  // Initial deposit plus six monthly DCA contributions.
  updateCash.run(9000, id);
  insertDeposit.run(id, 9000, "oneoff", (9000 / income) * 100, 1);
  for (let i = 0; i < 6; i++) {
    updateCash.run(240, id);
    insertDeposit.run(id, 240, "monthly", 10, 0);
  }

  for (const o of DEMO_ORDERS) {
    const meta = KNOWN_ASSETS.find(a => a.symbol === o.symbol);
    if (!meta) continue;
    const price = +(meta.base * o.discount).toFixed(2);
    runOrderTx(id, o.symbol, "buy", o.qty, price, {
      name: meta.name, sector: meta.sector, country: meta.country, assetClass: meta.class,
    });
  }

  // Spread the history over the last months so it reads like a real journey.
  const txs = db.prepare("SELECT id, symbol FROM transactions WHERE user_id = ? ORDER BY id").all(id);
  const setTxDate = db.prepare("UPDATE transactions SET created_at = datetime('now', ?) WHERE id = ?");
  txs.forEach(t => {
    const o = DEMO_ORDERS.find(x => x.symbol === t.symbol);
    setTxDate.run(`-${o?.daysAgo ?? 1} days`, t.id);
  });
  const deps = db.prepare("SELECT id FROM deposits WHERE user_id = ? ORDER BY id").all(id);
  const setDepDate = db.prepare("UPDATE deposits SET created_at = datetime('now', ?) WHERE id = ?");
  deps.forEach((d, i) => setDepDate.run(`-${i === 0 ? 170 : 180 - i * 30} days`, d.id));

  console.log(`✓ Demo account ready: ${DEMO_EMAIL} / ${DEMO_PASSWORD}`);
}
