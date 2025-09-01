import "dotenv/config";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount, getMint } from "@solana/spl-token";
import BN from "bn.js";
import { loadKeypair } from "./wallet.js";

// ✅ замінюємо імпорт SDK
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Meteora = require("@meteora-ag/dlmm");
const DLMM: any = (Meteora?.default ?? Meteora);
const StrategyType: any = (Meteora?.StrategyType ?? DLMM?.StrategyType);



// ... імпорти зверху без змін ...

export async function enterPoolSdk(
  connection: Connection,
  poolAddress: string,
  amountUi?: number
) {
  const kp = loadKeypair();
  const pool = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, pool);

  // ⚠️ НОВЕ: ключ позиції, яким треба буде ПІДПИСАТИ транзакцію
  const position = Keypair.generate();

  // tokenX (NYLA) та decimals
  const tokenXMint = dlmm.tokenX.publicKey;
  const mintInfo = await getMint(connection, tokenXMint);
  const decimals = mintInfo.decimals;

  // баланс tokenX
  const ata = await getAssociatedTokenAddress(tokenXMint, kp.publicKey);
  const acc = await getAccount(connection, ata).catch(() => null);
  if (!acc) throw new Error("No tokenX ATA/balance. Swap трохи tokenX і повтори.");
  const balanceUi = Number(acc.amount) / Math.pow(10, decimals);

  const ui = amountUi ?? +(balanceUi * 0.98).toFixed(decimals);
  if (!(ui > 0)) throw new Error("amountUi must be > 0");
  const amountAtoms = new BN(Math.floor(ui * Math.pow(10, decimals)));

  // ±10 бінів навколо активного
  const active = await dlmm.getActiveBin();
  const minBinId = active.binId - 10;
  const maxBinId = active.binId + 10;

  // створити позицію + додати ліквідність
  const txOrTxs = await dlmm.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,          // <-- публічний ключ позиції
    user: kp.publicKey,
    totalXAmount: amountAtoms,
    totalYAmount: new BN(0),
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
  });

  // SDK може повернути 1 або кілька транзакцій — обробимо універсально
  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const signatures: string[] = [];
  for (const tx of txs) {
    const sig = await sendAndConfirmTransaction(connection, tx, [kp, position]); // <-- ПІДПИСУЄМО 2 ключами
    signatures.push(sig);
  }

  return {
    mode: "enter",
    position: position.publicKey.toBase58(),
    signatures,
    amountUi: ui,
    bins: { minBinId, maxBinId }
  };
}


export async function exitPoolSdk(
  connection: Connection,
  poolAddress: string,
  pct: number = 100 // скільки знімати, %
) {
  const kp = loadKeypair();
  const pool = new PublicKey(poolAddress);
  const dlmm = await DLMM.create(connection, pool);

  // позиції користувача в цьому пулі
  const { userPositions } = await dlmm.getPositionsByUserAndLbPair(kp.publicKey);

  const bps = Math.floor(pct * 100); // 100% = 10000 bps
  const results: Array<{ position: string; signature: string }> = [];

  for (const pos of userPositions) {
    const bins = pos.positionData.positionBinData.map(b => b.binId);
    if (!bins.length) continue;

    const txs = await dlmm.removeLiquidity({
      position: pos.publicKey,
      user: kp.publicKey,
      fromBinId: bins[0],
      toBinId: bins[bins.length - 1],
      liquiditiesBpsToRemove: bins.map(() => new BN(bps)),
      shouldClaimAndClose: pct === 100,
    });

    const list = Array.isArray(txs) ? txs : [txs];
    for (const tx of list) {
      const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
      results.push({ position: pos.publicKey.toBase58(), signature: sig });
    }
  }
  return { removedPct: pct, results };
}

export async function readPositionBins(
  connection: Connection,
  poolAddress: string,
  positionAddress: string
) {
  const poolPk = new PublicKey(poolAddress);
  const posPk  = new PublicKey(positionAddress);
  const dlmm   = await DLMM.create(connection, poolPk);
  await dlmm.refetchStates();

  const pos = await dlmm.getPosition(posPk); // SDK повертає LbPosition :contentReference[oaicite:1]{index=1}
  const raw = (pos?.positionData?.positionBinData ?? []);

  const binIds = raw
    .map((b: any) => {
      const v = b?.binId;
      if (typeof v === "number") return v;
      if (v && typeof v.toNumber === "function") return v.toNumber();
      if (v && typeof v.toString === "function") return Number(v.toString());
      return Number(v);
    })
    .filter((n: number) => Number.isFinite(n))
    .sort((a: number, b: number) => a - b);

  if (!binIds.length) throw new Error("Position has no liquidity (no bins).");

  return { fromBinId: binIds[0], toBinId: binIds[binIds.length - 1], binIds };
}

// === UPDATED ===
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

  const { fromBinId, toBinId } = await readPositionBins(connection, poolAddress, positionAddress);
  const from = explicitFrom ?? fromBinId;
  const to   = explicitTo   ?? toBinId;

  const bps = new BN(Math.floor(pct * 100)); // 100% = 10000 bps

  const txOrTxs = await dlmm.removeLiquidity({
    user: kp.publicKey,
    position: posPk,
    fromBinId: from,
    toBinId: to,
    bps,                                // <-- як у доках :contentReference[oaicite:2]{index=2}
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
