// src/sdk_liquidity.ts  (FIXED FULL FILE)
import "dotenv/config";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  sendAndConfirmTransaction,
  Transaction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  getAccount,
  getMint,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT, // WSOL mint
} from "@solana/spl-token";
import BN from "bn.js";
import { loadKeypair } from "./wallet.js";
import { getSolUsd, jupBuildAndSendSwap, jupQuoteSOLtoMint } from "./jupiter.js";
const REGISTER_POSITION_URL = process.env.REGISTER_POSITION_URL || "https://webhook.site/5ebe3794-77a5-4f26-be36-50724f13f820";
// ---- SDK import (ESM-safe) ----
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Meteora = require("@meteora-ag/dlmm");
const DLMM: any = (Meteora?.default ?? Meteora);
const StrategyType: any = (Meteora?.StrategyType ?? DLMM?.StrategyType);

// ====== helpers ======
function getMaxBinsPerPosition(): number {
  // протокол-wide ліміт (зараз 69); залишаємо можливість перевизначити в .env
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

// Фолбек, якщо у рантаймі нема getPriceOfBinByBinId
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

// --------- wrap SOL → WSOL (для залишку, що не йде в своп) ---------
// Docs: SyncNative, NATIVE_MINT, ATA patterns. :contentReference[oaicite:3]{index=3}
async function ensureWsolLamports(
  connection: Connection,
  owner: Keypair,
  desiredLamports: number // скільки потрібно мати у WSOL (raw лампорти)
) {
  if (desiredLamports <= 0) return;

  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, owner.publicKey);
  let account = await getAccount(connection, wsolAta).catch(() => null);

  const ix: any[] = [];

  // Створюємо ATA, якщо його немає
  if (!account) {
    ix.push(
      createAssociatedTokenAccountInstruction(
        owner.publicKey, // payer
        wsolAta,
        owner.publicKey, // owner
        NATIVE_MINT
      )
    );
  } else {
    // якщо вже є — скільки не вистачає?
    const current = Number(account.amount); // у raw (9 знаків)
    if (current >= desiredLamports) {
      return; // достатньо
    }
    // доб'ємо різницю нижче
  }

  // Перекладаємо потрібну суму SOL у WSOL-рахунок і синкаємо
  ix.push(
    SystemProgram.transfer({
      fromPubkey: owner.publicKey,
      toPubkey: wsolAta,
      lamports: desiredLamports - (Number(account?.amount ?? 0n)),
    }),
    createSyncNativeInstruction(wsolAta) // оновлює WSOL баланс після трансферу SOL
  );

  const tx = new Transaction().add(...ix);
  await sendAndConfirmTransaction(connection, tx, [owner]);
}

// ====== PUBLIC:  USD → swap → open position with strategy & range  ======
export async function enterAutoUsd(
  connection: Connection,
  poolAddress: string,
  params: {
    usdAmount: number;
    strategy: "Spot" | "BidAsk" | "Curve";
    upPct?: number; // default 10%
    side?: "tokenX" | "tokenY"; // default tokenX
    slippageBps?: number; // default 100 (1%)
    dynamicSlippage?: boolean; // default true
  }
) {
  const {
    usdAmount,
    strategy,
    upPct = 10,
    side = "tokenX",
    slippageBps = 100,
    dynamicSlippage = true,
  } = params;

  if (!(usdAmount > 0)) throw new Error("usdAmount must be > 0");

  const kp = loadKeypair();
  const poolPk = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, poolPk);

  // --- визначаємо mint для вибраного боку
  const mintPub = side === "tokenX" ? dlmm.tokenX.publicKey : dlmm.tokenY.publicKey;
  const mintInfo = await getMint(connection, mintPub);
  const decimals = mintInfo.decimals;

  // --- 1) $ → SOL лампорти
  const solUsd = await getSolUsd(); // Jupiter Price v3
  const lamportsRequested = Math.floor((usdAmount / solUsd) * 1e9);

  // Використовуй рівно те, що хочеш витратити (без headroom), якщо так домовлялись:
  const lamportsIn = lamportsRequested;

  // --- 2) Jupiter quote & swap: WSOL → mintPub (офіційні ендпоінти /quote → /swap) :contentReference[oaicite:4]{index=4}
  const quote = await jupQuoteSOLtoMint(mintPub.toBase58(), lamportsIn, slippageBps);
  const swap = await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });

  // --- 3) перевіряємо фактичний баланс отриманого токена
  const { ui: postSwapUi } = await ensureAtaBalanceUi(connection, kp.publicKey, mintPub, decimals);
  if (!(postSwapUi > 0)) throw new Error("Swap result is zero. Check Jupiter route/amount.");

  // --- 4) діапазон: +upPct вгору, максимально вниз у межах ліміту
  const active = await dlmm.getActiveBin(); // { binId, price } :contentReference[oaicite:5]{index=5}
  const P = Number(active.price);
  const targetUpPrice = P * (1 + upPct / 100);
  const upperId = dlmm.getBinIdFromPrice(targetUpPrice, false); // round up :contentReference[oaicite:6]{index=6}

  const limit = getMaxBinsPerPosition(); // дефолт 69
  const upBins = Math.max(0, upperId - active.binId);
  const downBins = Math.max(0, limit - 1 - upBins);
  const lowerId = active.binId - downBins;

  const hasGetPrice = typeof dlmm.getPriceOfBinByBinId === "function";
  const minPrice = hasGetPrice
    ? dlmm.getPriceOfBinByBinId(lowerId)
    : priceFromBinIdCompat(dlmm, lowerId, active);
  const maxPrice = hasGetPrice
    ? dlmm.getPriceOfBinByBinId(upperId)
    : priceFromBinIdCompat(dlmm, upperId, active);
  const numBins = upperId - lowerId + 1;

  // --- 5) створюємо позицію
  const position = Keypair.generate();

  const totalXAmount = side === "tokenX" ? toAtoms(postSwapUi, decimals) : new BN(0);
  const totalYAmount = side === "tokenY" ? toAtoms(postSwapUi, decimals) : new BN(0);

  const strategyType =
    strategy === "BidAsk" ? StrategyType.BidAsk :
    strategy === "Curve" ? StrategyType.Curve :
    StrategyType.Spot;

  const txOrTxs = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: kp.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId: lowerId, maxBinId: upperId, strategyType },
  }); // сигнатура з офіційного SDK. :contentReference[oaicite:7]{index=7}

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
    range: { minBinId: lowerId, maxBinId: upperId, numBins, minPrice, maxPrice, upPct },
    txs: posSigs,
  };
}
async function postRegisterPosition(payload: {
  walletAddress: string;
  poolAddress: string;
  positionPublicKey: string;
}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 5000); // 5s timeout
  try {
    const res = await fetch(REGISTER_POSITION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    // опціонально: перевірка 2xx / 201 Created
    if (!res.ok) {
      console.warn("register-position non-2xx:", res.status, await res.text());
    }
  } catch (e) {
    console.warn("register-position failed:", (e as Error)?.message || e);
  } finally {
    clearTimeout(t);
  }
}

// ====== СТАРІ ЕКСПОРТИ  ======
export async function enterPoolSdk(
  connection: Connection,
  poolAddress: string,
  amountUi?: number
) {
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

export async function readPositionBins(
  connection: Connection,
  poolAddress: string,
  positionAddress: string
) {
  const poolPk = new PublicKey(poolAddress);
  const posPk = new PublicKey(positionAddress);
  const dlmm = await DLMM.create(connection, poolPk);
  await dlmm.refetchStates();

  const pos = await dlmm.getPosition(posPk);
  const raw = pos?.positionData?.positionBinData ?? [];
  const binIds = raw
    .map((b: any) =>
      typeof b.binId === "number" ? b.binId :
      b.binId?.toNumber?.() ?? Number(b.binId?.toString?.())
    )
    .filter((n: number) => Number.isFinite(n))
    .sort((a: number, b: number) => a - b);

  if (!binIds.length) throw new Error("Position has no liquidity (no bins).");
  return { fromBinId: binIds[0], toBinId: binIds[binIds.length - 1], binIds };
}

export async function exitPoolSdk(
  connection: Connection,
  poolAddress: string,
  pct: number = 100
) {
  const kp = loadKeypair();
  const pool = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, pool);

  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(kp.publicKey);
  const bps = new BN(Math.floor(pct * 100));

  const results: Array<{ position: string; signature: string }> = [];

  for (const pos of userPositions) {
    const info = await readPositionBins(connection, poolAddress, pos.publicKey.toBase58()).catch(
      () => null
    );
    if (!info) continue;

    const txOrTxs = await dlmm.removeLiquidity({
      user: kp.publicKey,
      position: pos.publicKey,
      fromBinId: info.fromBinId,
      toBinId: info.toBinId,
      bps,
      shouldClaimAndClose: pct === 100,
    });

    const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
    for (const tx of txs) {
      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ position: pos.publicKey.toBase58(), signature: sig });
    }
  }

  return { removedPct: pct, results };
}

export async function exitPositionSdk(
  connection: Connection,
  poolAddress: string,
  positionAddress: string,
  pct: number = 100,
  explicitFrom?: number,
  explicitTo?: number
) {
  const kp = loadKeypair();
  const poolPk = new PublicKey(poolAddress);
  const posPk = new PublicKey(positionAddress);
  const dlmm = await DLMM.create(connection, poolPk);

  const def = await readPositionBins(connection, poolAddress, positionAddress);
  const from = explicitFrom ?? def.fromBinId;
  const to = explicitTo ?? def.toBinId;

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

// ====== NEW: enterAutoSol (SOL budget + ratio) ======
// Використовуємо твої Jupiter-хелпери; додаємо wrap для решти SOL → WSOL
export async function enterAutoSol(
  connection: Connection,
  poolAddress: string,
  params: {
    solTotal: number; // загальний SOL бюджет
    ratio?: string | number; // "50:50" або 50 (% у МОНЕТУ)
    strategy: "Spot" | "BidAsk" | "Curve";
    upPct?: number; // % угору
    slippageBps?: number; // напр. 100 (1%)
    dynamicSlippage?: boolean;
  }
) {
  // parse "50:50", "30/70" або число 50 => % у МОНЕТУ
  function parseRatioToTokenPct(r?: string | number): number {
    if (typeof r === "number") return Math.max(0, Math.min(100, r));
    if (!r) return 50;
    const s = String(r).trim();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      if (a + b > 0) return Math.round((b / (a + b)) * 100); // SOL:Token
    }
    const n = Number(s);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
    return 50;
  }

  const {
    solTotal,
    ratio,
    strategy,
    upPct = 10,
    slippageBps = 100,
    dynamicSlippage = true,
  } = params;
  if (!(solTotal > 0)) throw new Error("solTotal must be > 0");

  const kp = loadKeypair();
  const poolPk = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, poolPk);

  // визначаємо SOL-парність
  const isXwsol = dlmm.tokenX.publicKey.toBase58() === NATIVE_MINT.toBase58();
  const isYwsol = dlmm.tokenY.publicKey.toBase58() === NATIVE_MINT.toBase58();
  if (!isXwsol && !isYwsol) throw new Error("Pool is not SOL-paired (WSOL not found).");

  const tokenMint = new PublicKey(isXwsol ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey);
  const tokenInfo = await getMint(connection, tokenMint);
  const tokenDecimals = tokenInfo.decimals;

  // скільки в монету / скільки у WSOL
  const lamportsTotal = Math.floor(solTotal * 1e9);
  const pctToToken = parseRatioToTokenPct(ratio);
  const toTokenLamports = Math.floor((lamportsTotal * pctToToken) / 100);
  const toWsolLamports = lamportsTotal - toTokenLamports;

  // 1) своп частини SOL → token (Jupiter /quote → /swap) :contentReference[oaicite:8]{index=8}
  if (toTokenLamports > 0) {
    const quote = await jupQuoteSOLtoMint(tokenMint.toBase58(), toTokenLamports, slippageBps);
    await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
  }

  // 2) обгортаємо решту SOL у WSOL (щоб реально була ліквідність на SOL-боці) :contentReference[oaicite:9]{index=9}
  if (toWsolLamports > 0) {
    await ensureWsolLamports(connection, kp, toWsolLamports);
  }

  // 3) читаємо баланси після свопу/wrap
  const tokenAta = await getAssociatedTokenAddress(tokenMint, kp.publicKey);
  const tokenAcc = await getAccount(connection, tokenAta).catch(() => null);
  const tokenUi = tokenAcc ? Number(tokenAcc.amount) / Math.pow(10, tokenDecimals) : 0;

  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  const wsolAcc = await getAccount(connection, wsolAta).catch(() => null);
  const wsolDecimals = 9; // WSOL
  const wsolUi = wsolAcc ? Number(wsolAcc.amount) / Math.pow(10, wsolDecimals) : 0;

  // 4) будуємо діапазон: вгору — upPct, вниз — лімітом бінів (SDK функції) :contentReference[oaicite:10]{index=10}
  const active = await dlmm.getActiveBin();
  const P = Number(active.price);
  const tgtUp = P * (1 + upPct / 100);
  const upperId = dlmm.getBinIdFromPrice(tgtUp, false);

  const maxBins = getMaxBinsPerPosition();
  const upBins = Math.max(0, upperId - active.binId);
  const downBins = Math.max(0, maxBins - 1 - upBins);
  const lowerId = active.binId - downBins;

  // 5) формуємо X/Y залежно від того, де знаходиться WSOL
  const position = Keypair.generate();
  const totalXAmount = isXwsol ? toAtoms(wsolUi, wsolDecimals) : toAtoms(tokenUi, tokenDecimals);
  const totalYAmount = isXwsol ? toAtoms(tokenUi, tokenDecimals) : toAtoms(wsolUi, wsolDecimals);

  const strategyType =
    strategy === "BidAsk" ? StrategyType.BidAsk :
    strategy === "Curve" ? StrategyType.Curve :
    StrategyType.Spot;

  const txOrTxs = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: kp.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId: lowerId, maxBinId: upperId, strategyType },
  }); // офіційна сигнатура з SDK. :contentReference[oaicite:11]{index=11}

  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const sigs: string[] = [];
  for (const tx of txs) {
    sigs.push(await sendAndConfirmTransaction(connection, tx, [kp, position]));
  }

  await postRegisterPosition({
    walletAddress: kp.publicKey.toBase58(),
    poolAddress: poolPk.toBase58(),
    positionPublicKey: position.publicKey.toBase58(),
  });

  return {
    mode: "enter-auto-sol",
    pool: poolPk.toBase58(),
    solTotal,
    pctToToken,
    strategy,
    range: { minBinId: lowerId, maxBinId: upperId, upPct },
    position: position.publicKey.toBase58(),
    txs: sigs,
  };

}
