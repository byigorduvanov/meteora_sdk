// src/sdk_liquidity.ts  (FULL REPLACE)
import "dotenv/config";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, getMint } from "@solana/spl-token";
import BN from "bn.js";
import { loadKeypair } from "./wallet.js";
import { getSolUsd, jupBuildAndSendSwap, jupQuoteSOLtoMint } from "./jupiter.js";

// ---- SDK import (ESM-safe) ----
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Meteora = require("@meteora-ag/dlmm");
const DLMM: any = (Meteora?.default ?? Meteora);
const StrategyType: any = (Meteora?.StrategyType ?? DLMM?.StrategyType);

// ====== helpers ======
function getMaxBinsPerPosition(): number {
  // протокол-wide ліміт (наразі 69); залишаємо можливість перевизначити в .env на майбутнє
  return Number(process.env.MAX_BINS_PER_POSITION || "69");
}

async function ensureAtaBalanceUi(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  decimals: number
) {
  const ata = await getAssociatedTokenAddress(mint, owner);
  const acc = await getAccount(connection, ata).catch(() => null);
  const ui = acc ? Number(acc.amount) / Math.pow(10, decimals) : 0;
  return { ata, ui, raw: acc?.amount ?? 0n };
}

function toAtoms(uiAmount: number, decimals: number): BN {
  const atoms = Math.floor(uiAmount * Math.pow(10, decimals));
  return new BN(atoms < 0 ? 0 : atoms);
}

// --- Fallback на випадок відсутності getPriceOfBinByBinId у рантаймі SDK.
// Формула: price(binId) = activeLamportPrice * (1 + binStepBps/10000)^(binId - activeId),
// потім конвертація lamport price -> звична ціна.
function priceFromBinIdCompat(
  dlmm: any,
  binId: number,
  active: { binId: number; price: string }
) {
  const activeLam = Number(active.price); // lamport price
  const stepBps = Number(dlmm?.lbPair?.binStep ?? 0);
  const ratio = 1 + stepBps / 10_000;
  const d = binId - active.binId;
  const lam = activeLam * Math.pow(ratio, d);
  return dlmm.fromPricePerLamport(lam);
}

// ====== PUBLIC:  USD → swap → open position with strategy & range  ======
export async function enterAutoUsd(
  connection: Connection,
  poolAddress: string,
  params: {
    usdAmount: number,
    strategy: "Spot" | "BidAsk" | "Curve",
    upPct?: number,                     // default 10%
    side?: "tokenX" | "tokenY",         // default tokenX
    slippageBps?: number,               // default 100 (1%)
    dynamicSlippage?: boolean           // default true
  }
) {
  const {
    usdAmount,
    strategy,
    upPct = 10,
    side = "tokenX",
    slippageBps = 100,
    dynamicSlippage = true
  } = params;

  if (!(usdAmount > 0)) throw new Error("usdAmount must be > 0");

  const kp = loadKeypair();
  const poolPk = new PublicKey(poolAddress);
  const dlmm  = await DLMM.create(connection, poolPk);

  // --- визначаємо mint для вибраного боку
  const mintPub = side === "tokenX" ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey;
  const mintInfo = await getMint(connection, mintPub);
  const decimals = mintInfo.decimals;

  // --- 1) $ → SOL лампорти (із «подушкою» на ренти/фі)
  const solUsd = await getSolUsd();                       // Jupiter Price API v3 (Lite)
  const lamportsRequested = Math.floor((usdAmount / solUsd) * 1e9);

  // бюджет SOL з урахуванням створення ATA (~0.00203928 SOL) + тимчасового WSOL (~0.00203928 SOL) + фі
  const currentLamports = await connection.getBalance(kp.publicKey);
  const HEADROOM_LAMPORTS =
    Math.floor(0.00203928 * 1e9) +  // ATA (rent-exempt мінімум 165 байт)
    Math.floor(0.00203928 * 1e9) +  // temp WSOL (якщо не існує)
    Math.floor(0.005 * 1e9);        // buffer на fees/priority

  let lamportsBudget = currentLamports - HEADROOM_LAMPORTS;
  if (lamportsBudget <= 0) {
    throw new Error(`Not enough SOL for rent/fees. Need > ${(HEADROOM_LAMPORTS/1e9).toFixed(4)} SOL buffer.`);
  }
  const lamportsIn = Math.max(0, Math.min(lamportsRequested, lamportsBudget));
  if (lamportsIn <= 0) {
    throw new Error(`SOL balance too low for requested usdAmount after reserves (${(HEADROOM_LAMPORTS/1e9).toFixed(4)} SOL).`);
  }

  // --- 2) Jupiter quote & swap: WSOL → mintPub
  const quote = await jupQuoteSOLtoMint(mintPub.toBase58(), lamportsIn, slippageBps);
  const swap  = await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });

  // --- 3) перевіряємо фактичний баланс отриманого токена
  const { ui: postSwapUi } = await ensureAtaBalanceUi(connection, kp.publicKey, mintPub, decimals);
  if (!(postSwapUi > 0)) throw new Error("Swap result is zero. Check Jupiter route/amount.");

  // --- 4) рахуємо діапазон: +upPct вгору, максимально вниз, але ≤ ліміт бінів на позицію
  const active = await dlmm.getActiveBin();               // { binId, price }
  const P = Number(active.price);                         // lamport price
  const targetUpPrice = P * (1 + (upPct / 100));
  const upperId = dlmm.getBinIdFromPrice(targetUpPrice, false);

  const limit = getMaxBinsPerPosition();                  // дефолт 69 (див. .env на випадок змін)
  const upBins = Math.max(0, upperId - active.binId);
  const downBins = Math.max(0, limit - 1 - upBins);
  const lowerId = active.binId - downBins;

  // --- межі ціни (fallback, якщо в рантаймі немає getPriceOfBinByBinId)
  const hasGetPrice = typeof dlmm.getPriceOfBinByBinId === "function";
  const minPrice = hasGetPrice
    ? dlmm.getPriceOfBinByBinId(lowerId)
    : priceFromBinIdCompat(dlmm, lowerId, active);
  const maxPrice = hasGetPrice
    ? dlmm.getPriceOfBinByBinId(upperId)
    : priceFromBinIdCompat(dlmm, upperId, active);
  const numBins  = upperId - lowerId + 1;

  // --- 5) створюємо позицію з обраною стратегією
  const position = Keypair.generate();

  const totalXAmount = side === "tokenX" ? toAtoms(postSwapUi, decimals) : new BN(0);
  const totalYAmount = side === "tokenY" ? toAtoms(postSwapUi, decimals) : new BN(0);

  const strategyType =
    strategy === "BidAsk" ? StrategyType.BidAsk :
    strategy === "Curve"  ? StrategyType.Curve  :
                             StrategyType.Spot;

  const txOrTxs = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: kp.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId: lowerId, maxBinId: upperId, strategyType },
  });

  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const posSigs: string[] = [];
  for (const tx of txs) {
    const sig = await sendAndConfirmTransaction(connection, tx, [kp, position]);
    posSigs.push(sig);
  }

  return {
    mode: "enter-auto-usd",
    pool: poolPk.toBase58(),
    side,
    usdAmount,
    swap: { signature: swap.signature },
    position: position.publicKey.toBase58(),
    strategy,
    range: {
      minBinId: lowerId, maxBinId: upperId, numBins,
      minPrice, maxPrice, upPct
    },
    txs: posSigs,
  };
}

// ====== залишаємо твої попередні експортовані ф-ції (спрощено) ======
export async function enterPoolSdk(connection: Connection, poolAddress: string, amountUi?: number) {
  const kp = loadKeypair();
  const pool = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, pool);
  const pos = Keypair.generate();

  const tokenXMint = dlmm.tokenX.publicKey;
  const mintInfo = await getMint(connection, tokenXMint);
  const decimals = mintInfo.decimals;

  const { ui } = await ensureAtaBalanceUi(connection, kp.publicKey, tokenXMint, decimals);
  const useUi = amountUi ?? +(ui * 0.98).toFixed(decimals);
  if (!(useUi > 0)) throw new Error("amountUi must be > 0");

  const active = await dlmm.getActiveBin();
  const minBinId = active.binId - 10;
  const maxBinId = active.binId + 10;

  const tx = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: pos.publicKey,
    user: kp.publicKey,
    totalXAmount: toAtoms(useUi, decimals),
    totalYAmount: new BN(0),
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
  });

  const sig = await sendAndConfirmTransaction(connection, tx, [kp, pos]);
  return { position: pos.publicKey.toBase58(), signature: sig };
}

export async function exitPoolSdk(connection: Connection, poolAddress: string, pct: number = 100) {
  const kp = loadKeypair();
  const pool = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, pool);

  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(kp.publicKey);
  const bps = Math.floor(pct * 100);
  const results: Array<{ position: string; signature: string }> = [];

  for (const pos of userPositions) {
    const bins = pos.positionData.positionBinData.map((b: any) => b.binId);
    if (!bins.length) continue;
    const txs = await dlmm.removeLiquidity({
      position: pos.publicKey,
      user: kp.publicKey,
      fromBinId: bins[0],
      toBinId: bins[bins.length - 1],
      liquiditiesBpsToRemove: bins.map(() => new BN(bps)),
      shouldClaimAndClose: pct === 100,
    });
    const arr = Array.isArray(txs) ? txs : [txs];
    for (const tx of arr) {
      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ position: pos.publicKey.toBase58(), signature: sig });
    }
  }
  return { removedPct: pct, results };
}

export async function readPositionBins(connection: Connection, poolAddress: string, positionAddress: string) {
  const poolPk = new PublicKey(poolAddress);
  const posPk  = new PublicKey(positionAddress);
  const dlmm   = await DLMM.create(connection, poolPk);
  await dlmm.refetchStates();

  const pos = await dlmm.getPosition(posPk);
  const raw = (pos?.positionData?.positionBinData ?? []);
  const binIds = raw
    .map((b: any) => (typeof b.binId === "number" ? b.binId
      : (b.binId?.toNumber?.() ?? Number(b.binId?.toString?.()))))
    .filter((n: number) => Number.isFinite(n))
    .sort((a: number, b: number) => a - b);
  if (!binIds.length) throw new Error("Position has no liquidity (no bins).");
  return { fromBinId: binIds[0], toBinId: binIds[binIds.length - 1], binIds };
}

export async function exitPositionSdk(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  pct: number = 100,
  explicitFrom?: number,
  explicitTo?: number
) {
  const kp      = loadKeypair();
  const poolPk  = new PublicKey(poolAddress);
  const posPk   = new PublicKey(positionAddress);
  const dlmm    = await DLMM.create(connection, poolPk);

  const def = await readPositionBins(connection, poolAddress, positionAddress);
  const from = explicitFrom ?? def.fromBinId;
  const to   = explicitTo   ?? def.toBinId;

  const txOrTxs = await dlmm.removeLiquidity({
    user: kp.publicKey,
    position: posPk,
    fromBinId: from,
    toBinId: to,
    bps: new BN(Math.floor(pct * 100)),
    shouldClaimAndClose: pct === 100,
  });

  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const signatures: string[] = [];
  for (const tx of txs) {
    const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
    signatures.push(sig);
  }
  return { removedPct: pct, fromBinId: from, toBinId: to, position: posPk.toBase58(), signatures };
}
