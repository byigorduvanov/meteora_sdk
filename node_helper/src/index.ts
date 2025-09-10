// src/server.ts (або де в тебе розміщений HTTP-сервер)
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";

import { getConnection } from "./meteora.js";
import { loadKeypair } from "./wallet.js";
import { enterAutoSol, exitPositionSdk } from "./sdk_liquidity.js";
import { jupBuildAndSendSwap, jupQuoteMintToMint, WSOL_MINT } from "./jupiter.js";

/** ===== Типи для боді ===== */
type RegisterBody = {
  walletAddress?: string;
  poolAddress?: string;
  positionPublicKey?: string;
};

type EnterAutoSolBody = {
  solTotal?: number;
  ratio?: string | number;
  strategy?: "Spot" | "BidAsk" | "Curve";
  upPct?: number;
  slippageBps?: number;
  dynamicSlippage?: boolean;
};

type ExitAndSellBody = {
  pct?: number;
  outMint?: string;
  slippageBps?: number;
  dynamicSlippage?: boolean;
  pool?: string; // можна не передавати, якщо працює POSITION_LOOKUP_URL або локальний реєстр
};

type LookupResponse = { poolAddress?: string };

const app = express();
app.use(cors());
app.use(express.json());

/** Локальний реєстр позиція -> пул (in-memory) */
const positionToPool = new Map<string, string>();

/** Healthcheck */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** ===== 1) ВХІД: SOL-бюджет + ratio ===== */
app.post(
  "/pool/:address/enter-auto-sol",
  async (req: Request<{ address: string }, any, EnterAutoSolBody>, res: Response) => {
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

      // реєструємо позицію локально (для автопошуку пулу під час виходу)
      positionToPool.set(out.position, out.pool);

      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }
);

/** ===== 1a) Локальний API для реєстрації позиції ===== */
app.post("/api/register-position", (req: Request<{}, any, RegisterBody>, res: Response) => {
  const { walletAddress = "", poolAddress = "", positionPublicKey = "" } = req.body ?? {};
  if (!walletAddress || !poolAddress || !positionPublicKey) {
    return res
      .status(400)
      .json({ error: "walletAddress, poolAddress, positionPublicKey are required" });
  }
  positionToPool.set(positionPublicKey, poolAddress);
  return res.status(201).json({ ok: true });
});

/** ===== 1b) Локальний API для пошуку пулу за позицією ===== */
app.get("/api/lookup", (req: Request<{}, any, any, { position?: string }>, res: Response) => {
  const position = String(req.query?.position || "");
  const pool = positionToPool.get(position);
  if (!pool) return res.status(404).json({ error: "not found" });
  res.json({ poolAddress: pool });
});

/** ===== 2) ВИХІД: за адресою ПОЗИЦІЇ + продаж у outMint ===== */
const POSITION_LOOKUP_URL = process.env.POSITION_LOOKUP_URL || ""; // зовнішній lookup (опційно)

async function resolvePoolByPosition(positionPk: string): Promise<string | null> {
  // 1) локальний реєстр
  const local = positionToPool.get(positionPk);
  if (local) return local;

  // 2) зовнішній сервіс
  if (!POSITION_LOOKUP_URL) return null;
  try {
    const url = `${POSITION_LOOKUP_URL}?position=${encodeURIComponent(positionPk)}`;
    const r = await fetch(url, { method: "GET" });
    if (!r.ok) return null;
    const j = (await r.json()) as LookupResponse;
    if (j?.poolAddress && typeof j.poolAddress === "string") return j.poolAddress;
  } catch {
    // ignore
  }
  return null;
}

app.post(
  "/position/:position/exit-and-sell",
  async (req: Request<{ position: string }, any, ExitAndSellBody>, res: Response) => {
    try {
      const connection = getConnection();
      const position = String(req.params.position);
      const pct = typeof req.body?.pct === "number" ? req.body.pct : 100;
      const outMint = String(req.body?.outMint || WSOL_MINT);
      const slippageBps = Number(req.body?.slippageBps ?? 100);
      const dynamicSlippage = req.body?.dynamicSlippage !== false;

      // 1) визначити пул (з body, локального реєстру або зовнішнього lookup)
      const poolAddr = String(req.body?.pool || (await resolvePoolByPosition(position)) || "");
      if (!poolAddr) {
        throw new Error(
          "Pool address is required (provide in body.pool, або налаштуй POSITION_LOOKUP_URL / користуйся локальним реєстром)."
        );
      }

      // 2) remove liquidity конкретно з цієї позиції
      const exitResult = await exitPositionSdk(connection, poolAddr, position, pct);

      // 3) дізнаємось mint X/Y через DLMM pool (SDK)
      const Meteora = await import("./meteora.js");
      const pool = await Meteora.createPool(connection as any, poolAddr);
      const kp = loadKeypair();
      const mintX = pool.tokenX.publicKey;
      const mintY = pool.tokenY.publicKey;

      // 4) читаємо залишки X/Y на ATA
      const plans: Array<{ inMint: PublicKey; amount: bigint }> = [];
      for (const mint of [mintX, mintY]) {
        const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
        const acc = await getAccount(connection, ata).catch(() => null);
        const amt = acc?.amount ?? 0n;
        if (amt > 0n) plans.push({ inMint: mint, amount: amt });
      }

      // 5) продаємо залишки у outMint через Jupiter (/quote -> /swap)
      const swaps: Array<{ inMint: string; signature: string; rawIn: string }> = [];
      for (const p of plans) {
        if (p.inMint.toBase58() === outMint) continue;
        const rawAmount = Number(p.amount); // якщо боїшся переповнення — адаптуй jupQuoteMintToMint під string
        if (!(rawAmount > 0)) continue;

        const quote = await jupQuoteMintToMint(p.inMint.toBase58(), outMint, rawAmount, slippageBps);
        const { signature } = await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
        swaps.push({ inMint: p.inMint.toBase58(), signature, rawIn: p.amount.toString() });
      }

      res.json({ ok: true, exit: exitResult, soldTo: outMint, swaps });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }
);

const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`DLMM node helper listening on :${port}`);
});
