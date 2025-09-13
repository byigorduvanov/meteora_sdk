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
  "https://webhook.site/5ebe3794-77a5-4f26-be36-50724f13f820/api/register-position";

// ====== helpers ======
function getMaxBinsPerPosition(): number {
  // протокол-wide ліміт (зараз 69); залишаємо можливість перевизначити в .env
  return Number(process.env.MAX_BINS_PER_POSITION || "69");
}

function toAtoms(uiAmount: number, decimals: number): BN {
  const atoms = Math.floor(uiAmount * Math.pow(10, decimals));
  return new BN(atoms < 0 ? 0 : atoms);
}

function fromAtomsToUi(atoms: bigint | number, decimals: number): number {
  const n = typeof atoms === "bigint" ? Number(atoms) : atoms;
  return n / Math.pow(10, decimals);
}

function bnMin(a: BN, b: BN) {
  return a.gt(b) ? b : a;
}

function bnMax(a: BN, b: BN) {
  return a.gt(b) ? a : b;
}

// ====== helpers ======
//  батч-реєстрація створених позицій
async function postRegisterPositionsBatch(payload: {
  walletAddress: string;
  poolAddress: string;
  tokenAddress: string;          // mint токена (НЕ WSOL)
  positionPublicKeys: string[];  // масив адрес позицій
}) {
  if (!payload?.positionPublicKeys?.length) return;

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), 8000); // 8s timeout
  try {
    const res = await fetch(REGISTER_POSITION_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      console.warn("register-position batch non-2xx:", res.status, await res.text());
    }
  } catch (e) {
    console.warn("register-position batch failed:", (e as Error)?.message || e);
  } finally {
    clearTimeout(t);
  }
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

// ====== PUBLIC: батч-вихід з МАСИВУ позицій (за одним пулом) ======
export async function exitPositionsBatchSdk(
  connection: Connection,
  poolAddress: string,
  positions: string[],
  pct: number = 100
) {
  const results: Array<{
    removedPct: number;
    fromBinId: number;
    toBinId: number;
    position: string;
    signatures: string[];
  }> = [];

  for (const pos of positions || []) {
    const out = await exitPositionSdk(connection, poolAddress, String(pos), pct);
    results.push(out);
  }

  return results;
}

/** =========================
 *  ENTER: Single auto range (legacy)
 *  ========================= */
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
await postRegisterPositionsBatch({
  walletAddress: kp.publicKey.toBase58(),
  poolAddress: poolPk.toBase58(),
  tokenAddress: tokenMint.toBase58(), // МИНТ НЕ-WSOL
  positionPublicKeys: [position.publicKey.toBase58()],
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

/** =========================
 *  ENTER: Split multi (нове ТЗ)
 *  ========================= */
type SplitMultiParams = {
  solTotal: number; // загальний бюджет у SOL
  ratio?: string | number; // % у токен (50 => 50% у токен, 50% у SOL/WSOL)
  strategy: "Spot" | "BidAsk" | "Curve";
  upPct: number; // наприклад 80
  downPct: number; // наприклад 70
  slippageBps?: number;
  dynamicSlippage?: boolean;
};

/** Розбиває суцільний діапазон [fromId..toId] на сегменти не довші за maxSpan. */
function segmentRange(fromId: number, toId: number, maxSpan: number): Array<{ minBinId: number; maxBinId: number; bins: number }> {
  const segments: Array<{ minBinId: number; maxBinId: number; bins: number }> = [];
  if (fromId > toId) return segments;
  let start = fromId;
  while (start <= toId) {
    const end = Math.min(start + maxSpan, toId);
    const bins = Math.max(0, end - start + 1);
    segments.push({ minBinId: start, maxBinId: end, bins });
    start = end + 1;
  }
  return segments;
}

/** Перетворює % → таргетні binId відносно активної ціни. */
async function computeTargetIds(dlmm: any, upPct: number, downPct: number) {
  await dlmm.refetchStates();
  const active = await dlmm.getActiveBin(); // {binId, price}
  const P = Number(active.price);

  const upperPrice = P * (1 + upPct / 100);
  const lowerPrice = P * (1 - downPct / 100);

  const upperId = dlmm.getBinIdFromPrice(upperPrice, false);
  const lowerId = dlmm.getBinIdFromPrice(lowerPrice, false);

  return { activeId: active.binId, upperId, lowerId, activePrice: P };
}

/** Пропорційний розподіл BN-сум за кількістю бінів із обрізанням похибок на останньому сегменті. */
function splitAmountAcrossSegments(total: BN, segments: Array<{ bins: number }>): BN[] {
  if (!segments.length) return [];
  const binsTotal = segments.reduce((s, x) => s + x.bins, 0);
  if (binsTotal <= 0) return segments.map(() => new BN(0));

  const shares: BN[] = [];
  let acc = new BN(0);
  for (let i = 0; i < segments.length; i++) {
    if (i === segments.length - 1) {
      shares.push(total.sub(acc)); // останньому — все, що залишилось
    } else {
      const part = total.muln(segments[i].bins).divn(binsTotal);
      shares.push(part);
      acc = acc.add(part);
    }
  }
  return shares;
}

/**
 * Відкриває СУМІСНИЙ діапазон: +upPct (виключно за рахунок токен-частини), і –downPct (виключно за рахунок WSOL-частини),
 * автоматично б’є на кілька позицій по ліміту бінів.
 */
export async function enterSplitMultiSol(
  connection: Connection,
  poolAddress: string,
  params: {
    solTotal: number;
    ratio?: string | number;
    strategy: "Spot" | "BidAsk" | "Curve";
    upPct: number;
    downPct: number;
    slippageBps?: number;
    dynamicSlippage?: boolean;
  }
) {
  const {
    solTotal,
    ratio,
    strategy,
    upPct,
    downPct,
    slippageBps = 100,
    dynamicSlippage = true,
  } = params;

  if (!(solTotal > 0)) throw new Error("solTotal must be > 0");
  if (!(upPct > 0) && !(downPct > 0)) {
    throw new Error("Both upPct and downPct are 0 — nothing to do.");
  }

  // parse ratio -> % у токен
  function parseRatioToTokenPct(r?: string | number): number {
    if (typeof r === "number") return Math.max(0, Math.min(100, r));
    if (!r) return 50;
    const s = String(r).trim();
    const m = s.match(/^(\d+(?:\.\d+)?)\s*[:/]\s*(\d+(?:\.\d+)?)$/);
    if (m) {
      const a = parseFloat(m[1]);
      const b = parseFloat(m[2]);
      if (a + b > 0) return Math.round((b / (a + b)) * 100);
    }
    const n = Number(s);
    if (Number.isFinite(n)) return Math.max(0, Math.min(100, n));
    return 50;
  }

  const kp = loadKeypair();
  const poolPk = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, poolPk);

  // Сторони пари
  const isXwsol = dlmm.tokenX.publicKey.toBase58() === NATIVE_MINT.toBase58();
  const isYwsol = dlmm.tokenY.publicKey.toBase58() === NATIVE_MINT.toBase58();
  if (!isXwsol && !isYwsol) throw new Error("Pool is not SOL-paired (WSOL not found).");

  const tokenMint = new PublicKey(isXwsol ? dlmm.tokenY.publicKey : dlmm.tokenX.publicKey);
  const tokenInfo = await getMint(connection, tokenMint);
  const tokenDecimals = tokenInfo.decimals;

  // 1) Budget split & swaps
  const lamportsTotal = Math.floor(solTotal * 1e9);
  const pctToToken = parseRatioToTokenPct(ratio);
  const toTokenLamports = Math.floor((lamportsTotal * pctToToken) / 100);
  const toWsolLamports = lamportsTotal - toTokenLamports;

  if (toTokenLamports > 0) {
    const quote = await jupQuoteSOLtoMint(tokenMint.toBase58(), toTokenLamports, slippageBps);
    await jupBuildAndSendSwap(connection, kp, quote, { dynamicSlippage });
  }
  if (toWsolLamports > 0) {
    await ensureWsolLamports(connection, kp, toWsolLamports);
  }

  // 2) Баланси
  const tokenAta = await getAssociatedTokenAddress(tokenMint, kp.publicKey);
  const tokenAcc = await getAccount(connection, tokenAta).catch(() => null);
  const tokenRaw = tokenAcc?.amount ?? 0n;
  const tokenUi = (typeof tokenRaw === "bigint" ? Number(tokenRaw) : tokenRaw) / Math.pow(10, tokenDecimals);

  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, kp.publicKey);
  const wsolAcc = await getAccount(connection, wsolAta).catch(() => null);
  const wsolRaw = wsolAcc?.amount ?? 0n;
  const wsolUi = (typeof wsolRaw === "bigint" ? Number(wsolRaw) : wsolRaw) / 1e9;

  // 3) Цільові діапазони
  async function computeTargetIds(dlmmInst: any, up: number, down: number) {
    await dlmmInst.refetchStates();
    const active = await dlmmInst.getActiveBin();
    const P = Number(active.price);
    const upperId = dlmmInst.getBinIdFromPrice(P * (1 + up / 100), false);
    const lowerId = dlmmInst.getBinIdFromPrice(P * (1 - down / 100), false);
    return { activeId: active.binId, upperId, lowerId, activePrice: P };
  }
  const { activeId, upperId, lowerId, activePrice } = await computeTargetIds(dlmm, upPct, downPct);

  // 4) Сегментація
  const maxSpan = Math.max(1, getMaxBinsPerPosition() - 1);
  function segmentRange(fromId: number, toId: number, span: number) {
    const segs: Array<{ minBinId: number; maxBinId: number; bins: number }> = [];
    if (fromId > toId) return segs;
    let start = fromId;
    while (start <= toId) {
      const end = Math.min(start + span, toId);
      segs.push({ minBinId: start, maxBinId: end, bins: Math.max(0, end - start + 1) });
      start = end + 1;
    }
    return segs;
  }
  const upSegments = upperId > activeId ? segmentRange(activeId, upperId, maxSpan) : [];
  const downSegments = lowerId < activeId ? segmentRange(lowerId, activeId, maxSpan) : [];

  // 5) Розподіл сум
  function toAtoms(uiAmount: number, decimals: number): BN {
    const atoms = Math.floor(uiAmount * Math.pow(10, decimals));
    return new BN(atoms < 0 ? 0 : atoms);
  }
  function splitAmountAcrossSegments(total: BN, segments: Array<{ bins: number }>): BN[] {
    if (!segments.length) return [];
    const binsTotal = segments.reduce((s, x) => s + x.bins, 0);
    if (binsTotal <= 0) return segments.map(() => new BN(0));
    const shares: BN[] = [];
    let acc = new BN(0);
    for (let i = 0; i < segments.length; i++) {
      if (i === segments.length - 1) {
        shares.push(total.sub(acc));
      } else {
        const part = total.muln(segments[i].bins).divn(binsTotal);
        shares.push(part);
        acc = acc.add(part);
      }
    }
    return shares;
  }

  const tokenTotalBN = toAtoms(tokenUi, tokenDecimals);
  const wsolTotalBN = toAtoms(wsolUi, 9);
  const upShares = splitAmountAcrossSegments(tokenTotalBN, upSegments);
  const downShares = splitAmountAcrossSegments(wsolTotalBN, downSegments);

  // 6) Strategy
  const strategyType =
    strategy === "BidAsk" ? StrategyType.BidAsk :
    strategy === "Curve"  ? StrategyType.Curve  :
                            StrategyType.Spot;

  // 7) Створюємо позиції
  type CreatedPos = {
    side: "up" | "down";
    minBinId: number;
    maxBinId: number;
    bins: number;
    position: string;
    allocatedTokenAtoms?: string;
    allocatedWsolAtoms?: string;
    txs: string[];
  };
  const created: CreatedPos[] = [];

  async function createSingleSidedPosition(
    minBinId: number,
    maxBinId: number,
    side: "up" | "down",
    amountBN: BN
  ) {
    if (amountBN.lten(0)) return null;

    const position = Keypair.generate();

    const totalXAmount =
      side === "up"
        ? (isXwsol ? new BN(0) : amountBN)
        : (isXwsol ? amountBN : new BN(0));

    const totalYAmount =
      side === "up"
        ? (isXwsol ? amountBN : new BN(0))
        : (isXwsol ? new BN(0) : amountBN);

    const txOrTxs = await dlmm.initializePositionAndAddLiquidityByStrategy({
      positionPubKey: position.publicKey,
      user: kp.publicKey,
      totalXAmount,
      totalYAmount,
      strategy: { minBinId, maxBinId, strategyType },
    });

    const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
    const sigs: string[] = [];
    for (const tx of txs) {
      sigs.push(await sendAndConfirmTransaction(connection, tx, [kp, position]));
    }

    const rec: CreatedPos = {
      side,
      minBinId,
      maxBinId,
      bins: maxBinId - minBinId + 1,
      position: position.publicKey.toBase58(),
      allocatedTokenAtoms: side === "up" ? amountBN.toString() : undefined,
      allocatedWsolAtoms: side === "down" ? amountBN.toString() : undefined,
      txs: sigs,
    };
    return rec;
  }

  // UP
  for (let i = 0; i < upSegments.length; i++) {
    const seg = upSegments[i];
    const share = upShares[i] ?? new BN(0);
    const rec = await createSingleSidedPosition(seg.minBinId, seg.maxBinId, "up", share);
    if (rec) created.push(rec);
  }
  // DOWN
  for (let i = 0; i < downSegments.length; i++) {
    const seg = downSegments[i];
    const share = downShares[i] ?? new BN(0);
    const rec = await createSingleSidedPosition(seg.minBinId, seg.maxBinId, "down", share);
    if (rec) created.push(rec);
  }

  // 8) ОДИН батч на всі створені позиції
  const allKeys = Array.from(new Set(created.map(c => c.position)));
  if (allKeys.length) {
    await postRegisterPositionsBatch({
      walletAddress: kp.publicKey.toBase58(),
      poolAddress: poolPk.toBase58(),
      tokenAddress: tokenMint.toBase58(), // mint НЕ-WSOL
      positionPublicKeys: allKeys,
    });
  }

  // Підсумки
  const upBinsTotal = upSegments.reduce((s, x) => s + x.bins, 0);
  const downBinsTotal = downSegments.reduce((s, x) => s + x.bins, 0);

  return {
    mode: "enter-split-multi",
    pool: poolPk.toBase58(),
    strategy,
    ratioPctToToken: pctToToken,
    price: { active: activePrice, targets: { upPct, downPct } },
    limits: { maxBinsPerPosition: getMaxBinsPerPosition() },
    resources: { tokenUi, wsolUi },
    coverage: {
      activeId, upperId, lowerId,
      up: { segments: upSegments, binsTotal: upBinsTotal },
      down: { segments: downSegments, binsTotal: downBinsTotal },
    },
    created,
  };
}
