import "dotenv/config";
import express from "express";
import cors from "cors";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";

import { getConnection } from "./meteora.js";
import { loadKeypair } from "./wallet.js";
import { enterAutoSol, exitPositionSdk } from "./sdk_liquidity.js";
import { jupBuildAndSendSwap, jupQuoteMintToMint, WSOL_MINT } from "./jupiter.js";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

/** ======== 1) ВХІД: SOL-бюджет + ratio  ======== */
app.post("/pool/:address/enter-auto-sol", async (req, res) => {
  try {
    const connection = getConnection();
    const out = await enterAutoSol(connection, req.params.address, {
      solTotal: Number(req.body?.solTotal),
      ratio: req.body?.ratio,
      strategy: String(req.body?.strategy || "BidAsk") as any,
      upPct: Number(req.body?.upPct ?? 10),
      slippageBps: Number(req.body?.slippageBps ?? 100),
      dynamicSlippage: req.body?.dynamicSlippage !== false,
    });
    res.json(out);
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

/** ======== 2) ВИХІД: за адресою ПОЗИЦІЇ + продаж у outMint  ======== */
/**
 * POST /position/:position/exit-and-sell
 * Body: { pool?: string, pct?: number, outMint?: string, slippageBps?: number, dynamicSlippage?: boolean }
 *
 * Якщо pool не переданий — пробуємо знайти через POSITION_LOOKUP_URL?position=<address>.
 */
const POSITION_LOOKUP_URL = process.env.POSITION_LOOKUP_URL || ""; // опційно: твій API для пошуку пулу за позицією

async function resolvePoolByPosition(positionPk: string): Promise<string | null> {
  if (!POSITION_LOOKUP_URL) return null;
  try {
    const url = `${POSITION_LOOKUP_URL}?position=${encodeURIComponent(positionPk)}`;
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) return null;
    const j = await r.json();
    // очікуємо від твого сервісу поле poolAddress
    if (j?.poolAddress && typeof j.poolAddress === "string") return j.poolAddress;
  } catch { /* ignore */ }
  return null;
}

app.post("/position/:position/exit-and-sell", async (req, res) => {
  try {
    const connection = getConnection();
    const position   = String(req.params.position);
    const pct        = typeof req.body?.pct === "number" ? req.body.pct : 100;
    const outMint    = String(req.body?.outMint || WSOL_MINT);
    const slippageBps     = Number(req.body?.slippageBps ?? 100);
    const dynamicSlippage = req.body?.dynamicSlippage !== false;

    // 1) визначити пул
    const poolAddr = String(req.body?.pool || (await resolvePoolByPosition(position)) || "");
    if (!poolAddr) {
      throw new Error("Pool address is required (provide in body.pool, або налаштуй POSITION_LOOKUP_URL для автопошуку).");
    }

    // 2) remove liquidity конкретно з цієї позиції
    const exitResult = await exitPositionSdk(connection, poolAddr, position, pct);

    // 3) дізнаємось mint X/Y через DLMM pool (SDK)
    const Meteora = await import("./meteora.js");
    const pool = await Meteora.createPool(connection as any, poolAddr);
    const kp   = loadKeypair();
    const mintX = pool.tokenX.publicKey;
    const mintY = pool.tokenY.publicKey;

    // 4) читаємо залишки X/Y на ATA та готуємо свопи в outMint (через Jupiter /quote → /swap) :contentReference[oaicite:3]{index=3}
    const plans: Array<{ inMint: PublicKey; amount: bigint }> = [];
    for (const mint of [mintX, mintY]) {
      const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
      const acc = await getAccount(connection, ata).catch(() => null);
      const amt = acc?.amount ?? 0n;
      if (amt > 0n) plans.push({ inMint: mint, amount: amt });
    }

    const swaps: Array<{ inMint: string; signature: string; rawIn: string }> = [];
    for (const p of plans) {
      if (p.inMint.toBase58() === outMint) continue;
      const quote = await jupQuoteMintToMint(p.inMint.toBase58(), outMint, Number(p.amount), slippageBps);
      const { signature } = await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
      swaps.push({ inMint: p.inMint.toBase58(), signature, rawIn: p.amount.toString() });
    }

    res.json({ ok: true, exit: exitResult, soldTo: outMint, swaps });
  } catch (e: any) {
    res.status(500).json({ error: e.message || String(e) });
  }
});

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`DLMM node helper listening on :${port}`);
});
