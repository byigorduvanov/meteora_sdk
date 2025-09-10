// src/sdk_liquidity.ts
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
import { jupBuildAndSendSwap, jupQuoteSOLtoMint } from "./jupiter.js";

// ---- SDK import (ESM-safe) ----
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Meteora = require("@meteora-ag/dlmm");
const DLMM: any = (Meteora?.default ?? Meteora);
const StrategyType: any = (Meteora?.StrategyType ?? DLMM?.StrategyType);

// ====== конфіг ======
const REGISTER_POSITION_URL =
  process.env.REGISTER_POSITION_URL ||
  "https://webhook.site/5ebe3794-77a5-4f26-be36-50724f13f820";

// ====== helpers ======
function getMaxBinsPerPosition(): number {
  // протокол-wide ліміт (зараз 69); залишаємо можливість перевизначити в .env
  return Number(process.env.MAX_BINS_PER_POSITION || "69");
}

function toAtoms(uiAmount: number, decimals: number): BN {
  const atoms = Math.floor(uiAmount * Math.pow(10, decimals));
  return new BN(atoms < 0 ? 0 : atoms);
}

// Обгортання SOL → WSOL (для частки бюджету, що йде в “SOL-сторону”)
async function ensureWsolLamports(
  connection: Connection,
  owner: Keypair,
  desiredLamports: number // скільки треба мати у WSOL (raw лампорти)
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
  }

  const current = Number(account?.amount ?? 0n); // raw 9 знаків
  if (current < desiredLamports) {
    ix.push(
      SystemProgram.transfer({
        fromPubkey: owner.publicKey,
        toPubkey: wsolAta,
        lamports: desiredLamports - current,
      }),
      createSyncNativeInstruction(wsolAta) // синкає баланс WSOL після трансферу SOL
    );
  }

  if (ix.length) {
    const tx = new Transaction().add(...ix);
    await sendAndConfirmTransaction(connection, tx, [owner]);
  }
}

// Опційна реєстрація створеної позиції (вебхук)
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
    if (!res.ok) {
      console.warn("register-position non-2xx:", res.status, await res.text());
    }
  } catch (e) {
    console.warn("register-position failed:", (e as Error)?.message || e);
  } finally {
    clearTimeout(t);
  }
}

// ====== PUBLIC: прочитати бін-діапазон у позиції ======
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
      typeof b.binId === "number"
        ? b.binId
        : b.binId?.toNumber?.() ?? Number(b.binId?.toString?.())
    )
    .filter((n: number) => Number.isFinite(n))
    .sort((a: number, b: number) => a - b);

  if (!binIds.length) throw new Error("Position has no liquidity (no bins).");
  return { fromBinId: binIds[0], toBinId: binIds[binIds.length - 1], binIds };
}

// ====== PUBLIC: вихід із КОНКРЕТНОЇ позиції (pct%, із закриттям при 100%) ======
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
  return {
    removedPct: pct,
    fromBinId: from,
    toBinId: to,
    position: posPk.toBase58(),
    signatures,
  };
}

// ====== PUBLIC: Вхід у пул за SOL-бюджетом і співвідношенням ======
export async function enterAutoSol(
  connection: Connection,
  poolAddress: string,
  params: {
    solTotal: number; // загальний SOL бюджет
    ratio?: string | number; // "50:50" або число 50 (% у МОНЕТУ)
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
      if (a + b > 0) return Math.round((b / (a + b)) * 100); // SOL:Token -> % у Token
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

  // Визначаємо, на якому боці пари WSOL
  const isXwsol = dlmm.tokenX.publicKey.toBase58() === NATIVE_MINT.toBase58();
  const isYwsol = dlmm.tokenY.publicKey.toBase58() === NATIVE_MINT.toBase58();
  if (!isXwsol && !isYwsol) throw new Error("Pool is not SOL-paired (WSOL not found).");

  const tokenMint = new PublicKey(isXwsol ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey);
  const tokenInfo = await getMint(connection, tokenMint);
  const tokenDecimals = tokenInfo.decimals;

  // Розподіл SOL бюджету
  const lamportsTotal = Math.floor(solTotal * 1e9);
  const pctToToken = parseRatioToTokenPct(ratio);
  const toTokenLamports = Math.floor((lamportsTotal * pctToToken) / 100);
  const toWsolLamports = lamportsTotal - toTokenLamports;

  // 1) Своп частини SOL → token (через Jupiter)
  if (toTokenLamports > 0) {
    const quote = await jupQuoteSOLtoMint(tokenMint.toBase58(), toTokenLamports, slippageBps);
    await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
  }

  // 2) Обгортаємо решту SOL у WSOL
  if (toWsolLamports > 0) {
    await ensureWsolLamports(connection, kp, toWsolLamports);
  }

  // 3) Читаємо фактичні баланси після свопу/wrap
  const tokenAta = await getAssociatedTokenAddress(tokenMint, kp.publicKey);
  const tokenAcc = await getAccount(connection, tokenAta).catch(() => null);
  const tokenUi = tokenAcc ? Number(tokenAcc.amount) / Math.pow(10, tokenDecimals) : 0;

  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  const wsolAcc = await getAccount(connection, wsolAta).catch(() => null);
  const wsolUi = wsolAcc ? Number(wsolAcc.amount) / 1e9 : 0;

  // 4) Будуємо діапазон: вгору — upPct, вниз — за лімітом бінів
  const active = await dlmm.getActiveBin(); // { binId, price }
  const P = Number(active.price);
  const tgtUp = P * (1 + upPct / 100);
  const upperId = dlmm.getBinIdFromPrice(tgtUp, false);

  const maxBins = getMaxBinsPerPosition();
  const upBins = Math.max(0, upperId - active.binId);
  const downBins = Math.max(0, maxBins - 1 - upBins);
  const lowerId = active.binId - downBins;

  // 5) Формуємо X/Y залежно від розташування WSOL
  const position = Keypair.generate();
  const totalXAmount = isXwsol ? toAtoms(wsolUi, 9) : toAtoms(tokenUi, tokenDecimals);
  const totalYAmount = isXwsol ? toAtoms(tokenUi, tokenDecimals) : toAtoms(wsolUi, 9);

  const strategyType =
    strategy === "BidAsk"
      ? StrategyType.BidAsk
      : strategy === "Curve"
      ? StrategyType.Curve
      : StrategyType.Spot;

  const txOrTxs = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: kp.publicKey,
    totalXAmount,
    totalYAmount,
    strategy: { minBinId: lowerId, maxBinId: upperId, strategyType },
  });

  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const sigs: string[] = [];
  for (const tx of txs) {
    sigs.push(await sendAndConfirmTransaction(connection, tx, [kp, position]));
  }

  // (Опціонально) реєстрація позиції
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
