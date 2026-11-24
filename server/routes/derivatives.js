import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import {
  getOptionChain, getDerivativesPositions, previewOptionOrder, executeOptionOrder,
  previewFutureOrder, openFuture, closeFuture, DERIVATIVE_UNDERLYINGS, listExpiries,
  INITIAL_MARGIN, MAINTENANCE_MARGIN, RISK_FREE,
} from "../services/derivatives.js";

const router = Router();
router.use(requireAuth);

const KNOWN_ERRORS = new Set([
  "INVALID_SYMBOL", "SYMBOL_NOT_FOUND", "INVALID_TYPE", "INVALID_SIDE", "INVALID_QTY", "INVALID_EXPIRY",
  "INVALID_STRIKE", "INSUFFICIENT_CASH", "INSUFFICIENT_CONTRACTS", "NOT_FOUND",
]);
const fail = (res, e) => {
  if (KNOWN_ERRORS.has(e.code)) return res.status(e.code === "NOT_FOUND" ? 404 : 422).json({ error: e.code });
  throw e;
};

router.get("/meta", (req, res) => {
  res.json({
    underlyings: DERIVATIVE_UNDERLYINGS, expiries: listExpiries(),
    initialMargin: INITIAL_MARGIN, maintenanceMargin: MAINTENANCE_MARGIN, riskFree: RISK_FREE,
  });
});

router.get("/chain", async (req, res) => {
  try { res.json(await getOptionChain(req.query.symbol, req.query.expiry)); } catch (e) { fail(res, e); }
});

router.get("/positions", async (req, res) => {
  res.json(await getDerivativesPositions(req.userId));
});

router.post("/options/preview", async (req, res) => {
  const out = await previewOptionOrder(req.userId, req.body || {});
  if (out.error) return res.status(422).json(out);
  res.json(out.proposal);
});

router.post("/options/order", async (req, res) => {
  try { res.json(await executeOptionOrder(req.userId, req.body || {})); } catch (e) { fail(res, e); }
});

router.post("/futures/preview", async (req, res) => {
  const out = await previewFutureOrder(req.userId, req.body || {});
  if (out.error) return res.status(422).json(out);
  res.json(out.proposal);
});

router.post("/futures/open", async (req, res) => {
  try { res.json(await openFuture(req.userId, req.body || {})); } catch (e) { fail(res, e); }
});

router.post("/futures/:id/close", async (req, res) => {
  try { res.json(await closeFuture(req.userId, req.params.id)); } catch (e) { fail(res, e); }
});

export default router;
