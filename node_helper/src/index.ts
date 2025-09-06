import "dotenv/config";

import express from "express";
import cors from "cors";
import {
  getConnection,
  listPairsFromAPI,
  getPoolState,
  getBinsAroundActive,
  getUserPositions,
} from "./meteora.js";
import { loadKeypair } from "./wallet.js";
import { enterPoolSdk, exitPoolSdk, exitPositionSdk, readPositionBins} from "./sdk_liquidity.js";
import { enterAutoUsd } from "./sdk_liquidity.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/wallet/address", (_req, res) => {
  const kp = loadKeypair();
  res.json({ address: kp.publicKey.toBase58() });
});

app.get("/pairs", async (req, res) => {
  try {
    const data = (await listPairsFromAPI()) as any[];
    const q = (req.query.q as string)?.toLowerCase();
    const filtered = q
      ? data.filter((p: any) =>
          (p.symbol || "").toLowerCase().includes(q) || (p.address || "").toLowerCase().includes(q)
        )
      : data;
    res.json(filtered);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/pool/:address/state", async (req, res) => {
  try {
    const connection = getConnection();
    const state = await getPoolState(connection, req.params.address);
    res.json(state);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/pool/:address/bins", async (req, res) => {
  try {
    const connection = getConnection();
    const around = parseInt((req.query.around as string) || "10", 10);
    const data = await getBinsAroundActive(connection, req.params.address, around);
    res.json(data);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.get("/positions/:owner", async (req, res) => {
  try {
    const connection = getConnection();
    const positions = await getUserPositions(connection, req.params.owner);
    res.json(positions);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** === NEW: SDK endpoints === **/

// УВІЙТИ (create position + add liquidity через SDK)
app.post("/pool/:address/enter-sdk", async (req, res) => {
  try {
    const connection = getConnection();
    const amountUi = typeof req.body?.amountUi === "number" ? req.body.amountUi : undefined;
    const out = await enterPoolSdk(connection, req.params.address, amountUi);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// ВИЙТИ (remove liquidity % від усіх позицій у пулі)
app.post("/pool/:address/exit-sdk", async (req, res) => {
  try {
    const connection = getConnection();
    const pct = typeof req.body?.pct === "number" ? req.body.pct : 100;
    const out = await exitPoolSdk(connection, req.params.address, pct);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`DLMM node helper listening on :${port}`);
});


// --- подивитися бін-діапазон позиції
app.post("/position/:position/bins", async (req, res) => {
  try {
    const connection = getConnection();
    const pool = String(req.body?.pool);
    if (!pool) throw new Error("Body must include { pool: <address> }");
    const out = await readPositionBins(connection, pool, req.params.position);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// --- прибрати ліквідність з конкретної позиції
app.post("/position/:position/exit-sdk", async (req, res) => {
  try {
    const connection = getConnection();
    const pool = String(req.body?.pool);
    if (!pool) throw new Error("Body must include { pool: <address> }");
    const pct  = typeof req.body?.pct  === "number" ? req.body.pct  : 100;
    const from = typeof req.body?.from === "number" ? req.body.from : undefined;
    const to   = typeof req.body?.to   === "number" ? req.body.to   : undefined;

    const out = await exitPositionSdk(connection, pool, req.params.position, pct, from, to);
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

app.post("/pool/:address/enter-auto", async (req, res) => {
  try {
    const connection = getConnection();
    const out = await enterAutoUsd(connection, req.params.address, {
      usdAmount: Number(req.body?.usdAmount),
      strategy: String(req.body?.strategy || "Spot") as any,       // "Spot" | "BidAsk" | "Curve"
      upPct: Number(req.body?.upPct ?? 10),
      side: (req.body?.side === "tokenY" ? "tokenY" : "tokenX"),
      slippageBps: Number(req.body?.slippageBps ?? 100),
      dynamicSlippage: req.body?.dynamicSlippage !== false,
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
