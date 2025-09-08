import "dotenv/config";
import { PublicKey } from "@solana/web3.js";


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

// +++ ADD to src/index.ts +++
import { jupBuildAndSendSwap, jupQuoteMintToMint, WSOL_MINT } from "./jupiter.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";

// POST /pool/:address/exit-and-sell
// Body: { pct?: number, position?: string, outMint?: string, slippageBps?: number, dynamicSlippage?: boolean }
app.post("/pool/:address/exit-and-sell", async (req, res) => {
  try {
    const connection = getConnection();
    const poolAddr   = req.params.address;
    const pct        = typeof req.body?.pct === "number" ? req.body.pct : 100;
    const position   = typeof req.body?.position === "string" ? req.body.position : undefined;
    const outMint    = String(req.body?.outMint || WSOL_MINT);
    const slippageBps     = Number(req.body?.slippageBps ?? 100);
    const dynamicSlippage = req.body?.dynamicSlippage !== false;

    // 1) Вихід із пулу: або з конкретної позиції, або з усіх у цьому пулі
    let exitResult: any;
    if (position) {
      exitResult = await exitPositionSdk(connection, poolAddr, position, pct);
    } else {
      exitResult = await exitPoolSdk(connection, poolAddr, pct);
    }

    // 2) Дізнаємось mint X/Y пулу (через DLMM)
    const Meteora = (await import("./meteora.js"));
    const pool = await Meteora.createPool(connection as any, poolAddr);
    const kp   = loadKeypair();
    const mintX = pool.tokenX.publicKey;
    const mintY = pool.tokenY.publicKey;

    // 3) Прочитати реальні баланси X/Y і підготувати свопи на outMint
    const plans: Array<{ inMint: PublicKey; amount: bigint }> = [];
    for (const mint of [mintX, mintY]) {
      const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
      const acc = await getAccount(connection, ata).catch(() => null);
      const amt = acc?.amount ?? 0n;
      if (amt > 0n) plans.push({ inMint: mint, amount: amt });
    }

    // 4) Продаємо кожен нуль-ненульовий залишок у outMint через Jupiter Lite
    const swaps: Array<{ inMint: string; signature: string; rawIn: string }> = [];
    for (const p of plans) {
      if (p.inMint.toBase58() === outMint) continue; // вже потрібний mint
      const quote = await jupQuoteMintToMint(p.inMint.toBase58(), outMint, Number(p.amount), slippageBps);
      const { signature } = await jupBuildAndSendSwap(connection, loadKeypair(), quote, { dynamicSlippage });
      swaps.push({ inMint: p.inMint.toBase58(), signature, rawIn: p.amount.toString() });
    }

    res.json({ ok: true, exit: exitResult, soldTo: outMint, swaps });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

// --- ADD to src/index.ts ---
import { enterAutoSol } from "./sdk_liquidity.js";

app.post("/pool/:address/enter-auto-sol", async (req, res) => {
  try {
    const connection = getConnection();
    const out = await enterAutoSol(connection, req.params.address, {
      solTotal: Number(req.body?.solTotal),             // напр. 0.1
      ratio: req.body?.ratio,                           // "50:50" або 50
      strategy: String(req.body?.strategy || "BidAsk") as any, // "Spot" | "BidAsk" | "Curve"
      upPct: Number(req.body?.upPct ?? 10),
      slippageBps: Number(req.body?.slippageBps ?? 100),
      dynamicSlippage: req.body?.dynamicSlippage !== false,
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});
