// src/index.ts
import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";

import { getConnection } from "./meteora.js";
import { loadKeypair } from "./wallet.js";
import { enterAutoSol, exitPositionSdk, enterSplitMultiSol, exitPositionsBatchSdk } from "./sdk_liquidity.js";
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

type EnterSplitMultiBody = {
  solTotal?: number; // обов'язково
  ratio?: string | number; // % у токен
  strategy?: "Spot" | "BidAsk" | "Curve"; // обов'язково
  upPct?: number; // обов'язково
  downPct?: number; // обов'язково
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

type ExitAllBody = {
  pct?: number;                  // default 100
  outMint?: string;              // default WSOL_MINT
  slippageBps?: number;          // default 100
  dynamicSlippage?: boolean;     // default true
};

type ExitSelectedBody = {
  positions?: string[];          // обов'язково
  pct?: number;                  // default 100
  outMint?: string;              // default WSOL_MINT
  slippageBps?: number;          // default 100
  dynamicSlippage?: boolean;     // default true
};


type LookupResponse = { poolAddress?: string };

const app = express();
app.use(cors());
app.use(express.json());

/** Локальний реєстр позиція -> пул (in-memory) */
const positionToPool = new Map<string, string>();

/** Healthcheck */
app.get("/health", (_req, res) => res.json({ ok: true }));

/** ===== 1) ВХІД: SOL-бюджет + ratio (legacy) ===== */
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
      // тут повертається одна позиція
      positionToPool.set(out.position, out.pool);

      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }
);

/** ===== 1a) НОВЕ: Split Multi-Range =====
 * Користувач задає: solTotal, ratio, strategy, upPct, downPct
 * UP покривається ТІЛЬКИ токен-частиною; DOWN — ТІЛЬКИ WSOL-частиною.
 * Діапазони автоматично б’ються на кілька позицій під ліміт бінів.
 */
app.post(
  "/pool/:address/enter-split-multi",
  async (req: Request<{ address: string }, any, EnterSplitMultiBody>, res: Response) => {
    try {
      const connection = getConnection();
      const solTotal = Number(req.body?.solTotal);
      const ratio = req.body?.ratio;
      const strategy = String(req.body?.strategy || "BidAsk") as "Spot" | "BidAsk" | "Curve";
      const upPct = Number(req.body?.upPct);
      const downPct = Number(req.body?.downPct);
      const slippageBps = Number(req.body?.slippageBps ?? 100);
      const dynamicSlippage = req.body?.dynamicSlippage !== false;

      if (!(solTotal > 0)) throw new Error("solTotal must be > 0");
      if (!Number.isFinite(upPct) || !Number.isFinite(downPct))
        throw new Error("upPct and downPct are required numbers.");

      const out = await enterSplitMultiSol(connection, req.params.address, {
        solTotal,
        ratio,
        strategy,
        upPct,
        downPct,
        slippageBps,
        dynamicSlippage,
      });

      // зареєструємо всі створені позиції (up/down)
      for (const p of out.created ?? []) {
        positionToPool.set(p.position, out.pool);
      }

      res.json(out);
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }
);

/** ===== API для реєстрації позиції вручну ===== */
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

/** ===== API для пошуку пулу за позицією ===== */
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
  "/pool/:address/exit-all-and-sell",
  async (req: Request<{ address: string }, any, ExitAllBody>, res: Response) => {
    try {
      const connection = getConnection();
      const poolAddr = String(req.params.address);
      const pct = typeof req.body?.pct === "number" ? req.body.pct : 100;
      const outMint = String(req.body?.outMint || WSOL_MINT);
      const slippageBps = Number(req.body?.slippageBps ?? 100);
      const dynamicSlippage = req.body?.dynamicSlippage !== false;

      if (!poolAddr) throw new Error("Pool address is required in URL.");

      // 1) Знайти всі позиції цього пулу, про які ми знаємо (локальний реєстр)
      const positions: string[] = [];
      for (const [pos, pool] of positionToPool.entries()) {
        if (pool === poolAddr) positions.push(pos);
      }
      if (!positions.length) {
        return res.status(404).json({
          error:
            "No known positions for this pool in local registry. " +
            "Створи позиції через цей сервіс, або додай реєстрацію / зовнішній lookup.",
        });
      }

      // 2) Закрити всі позиції
      const exits: Array<{
        position: string;
        removedPct: number;
        fromBinId: number;
        toBinId: number;
        signatures: string[];
      }> = [];
      for (const pos of positions) {
        const out = await exitPositionSdk(connection, poolAddr, pos, pct);
        exits.push(out);
        // При бажанні — можеш одразу видаляти з реєстру:
        // positionToPool.delete(pos);
      }

      // 3) Прочитати мейн-міни X/Y пулу
      const Meteora = await import("./meteora.js");
      const pool = await Meteora.createPool(connection as any, poolAddr);
      const kp = loadKeypair();
      const mintX = pool.tokenX.publicKey;
      const mintY = pool.tokenY.publicKey;

      // 4) Прочитати залишки і скласти план свопів у outMint
      const plans: Array<{ inMint: PublicKey; amount: bigint }> = [];
      for (const mint of [mintX, mintY]) {
        const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
        const acc = await getAccount(connection, ata).catch(() => null);
        const amt = acc?.amount ?? 0n;
        if (amt > 0n) plans.push({ inMint: mint, amount: amt });
      }

      // 5) Продати все в outMint через Jupiter
      const swaps: Array<{ inMint: string; signature: string; rawIn: string }> = [];
      for (const p of plans) {
        const inMintStr = p.inMint.toBase58();
        if (inMintStr === outMint) continue;
        const rawAmount = Number(p.amount);
        if (!(rawAmount > 0)) continue;

        const quote = await jupQuoteMintToMint(inMintStr, outMint, rawAmount, slippageBps);
        const { signature } = await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
        swaps.push({ inMint: inMintStr, signature, rawIn: p.amount.toString() });
      }

      res.json({ ok: true, pool: poolAddr, closed: exits.length, exits, soldTo: outMint, swaps });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }
);

// ВИХІД: масив позицій для конкретного пулу + продаж у outMint
app.post(
  "/pool/:address/exit-selected-and-sell",
  async (req: Request<{ address: string }, any, ExitSelectedBody>, res: Response) => {
    try {
      const connection = getConnection();
      const poolAddr = String(req.params.address);
      const positions = Array.isArray(req.body?.positions) ? req.body.positions : [];
      const pct = typeof req.body?.pct === "number" ? req.body.pct : 100;
      const outMint = String(req.body?.outMint || WSOL_MINT);
      const slippageBps = Number(req.body?.slippageBps ?? 100);
      const dynamicSlippage = req.body?.dynamicSlippage !== false;

      if (!poolAddr) throw new Error("Pool address is required in URL.");
      if (!positions.length) throw new Error("'positions' array is required in body.");

      // 1) Закрити перелічені позиції
      const exits = await exitPositionsBatchSdk(connection, poolAddr, positions, pct);

      // 2) Прочитати мейн-міни X/Y пулу
      const Meteora = await import("./meteora.js");
      const pool = await Meteora.createPool(connection as any, poolAddr);
      const kp = loadKeypair();
      const mintX = pool.tokenX.publicKey;
      const mintY = pool.tokenY.publicKey;

      // 3) Прочитати залишки і скласти план свопів у outMint
      const plans: Array<{ inMint: PublicKey; amount: bigint }> = [];
      for (const mint of [mintX, mintY]) {
        const ata = await getAssociatedTokenAddress(mint, kp.publicKey);
        const acc = await getAccount(connection, ata).catch(() => null);
        const amt = acc?.amount ?? 0n;
        if (amt > 0n) plans.push({ inMint: mint, amount: amt });
      }

      // 4) Продати все в outMint через Jupiter
      const swaps: Array<{ inMint: string; signature: string; rawIn: string }> = [];
      for (const p of plans) {
        const inMintStr = p.inMint.toBase58();
        if (inMintStr === outMint) continue;
        const rawAmount = Number(p.amount);
        if (!(rawAmount > 0)) continue;

        const quote = await jupQuoteMintToMint(inMintStr, outMint, rawAmount, slippageBps);
        const { signature } = await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
        swaps.push({ inMint: inMintStr, signature, rawIn: p.amount.toString() });
      }

      res.json({ ok: true, pool: poolAddr, closed: exits.length, exits, soldTo: outMint, swaps });
    } catch (e: any) {
      res.status(500).json({ error: e.message || String(e) });
    }
  }
);


const port = Number(process.env.PORT || 4000);
app.listen(port, () => {
  console.log(`DLMM node helper listening on :${port}`);
});
