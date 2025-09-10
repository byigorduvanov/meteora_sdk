// node_helper/scripts/add_via_sdk.ts
import "dotenv/config";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { getAssociatedTokenAddress, getAccount, getMint } from "@solana/spl-token";
import BN from "bn.js";

// Використовуємо вже існуючий хелпер з проєкту
import { loadKeypair } from "../../src/wallet.js";

/**
 * CLI:
 *   ts-node node_helper/scripts/add_via_sdk.ts <POOL_ADDRESS?> <AMOUNT_UI?> <BINS_SPAN?>
 *
 *  POOL_ADDRESS — опціонально (або .env.POOL)
 *  AMOUNT_UI    — опціонально (або .env.AMOUNT_UI, інакше 98% балансу tokenX)
 *  BINS_SPAN    — опціонально, скільки бінів у кожен бік від активного (дефолт 10)
 */
async function main() {
  const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  const argPool = process.argv[2];
  const argAmountUi = process.argv[3];
  const argBinsSpan = process.argv[4];

  const POOL = new PublicKey(argPool || process.env.POOL || "EFXXyGFTGkubdW7bse9fwnYr2xsaRGgyA3vP1UXVbWLh");
  const kp = loadKeypair();
  const connection = new Connection(RPC, "confirmed");

  // 1) DLMM пул
  const dlmmPool = await DLMM.create(connection, POOL);

  // 2) TokenX (у твоєму пулі це ваш токен; додаємо в односторонньому X)
  const tokenXMint = dlmmPool.tokenX.publicKey;
  const mintInfo = await getMint(connection, tokenXMint);
  const decimals = mintInfo.decimals;

  // 3) Баланс нашого ATA для tokenX
  const ata = await getAssociatedTokenAddress(tokenXMint, kp.publicKey);
  const acc = await getAccount(connection, ata).catch(() => null);
  if (!acc) {
    throw new Error(
      "Немає ATA для tokenX або на ньому 0. Спочатку отримай трохи tokenX на гаманець."
    );
  }
  const balanceUi = Number(acc.amount) / Math.pow(10, decimals);

  // 4) Сума введення
  const amountUi =
    argAmountUi !== undefined
      ? Number(argAmountUi)
      : process.env.AMOUNT_UI !== undefined
      ? Number(process.env.AMOUNT_UI)
      : balanceUi * 0.98;

  if (!Number.isFinite(amountUi) || !(amountUi > 0)) {
    throw new Error("amountUi <= 0: поповни tokenX на гаманці або задай суму аргументом.");
  }
  const amountAtoms = new BN(Math.floor(amountUi * Math.pow(10, decimals)));

  // 5) Діапазон бінів навколо активного
  const span = Number.isFinite(Number(argBinsSpan)) ? Number(argBinsSpan) : 10;
  const active = await dlmmPool.getActiveBin();
  const minBinId = active.binId - span;
  const maxBinId = active.binId + span;

  // 6) Створення позиції + ліквідність
  const position = Keypair.generate();
  const txOrTxs = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: position.publicKey,
    user: kp.publicKey,
    totalXAmount: amountAtoms,   // вводимо односторонньо в tokenX
    totalYAmount: new BN(0),
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
  });

  const txs = Array.isArray(txOrTxs) ? txOrTxs : [txOrTxs];
  const signatures: string[] = [];
  for (const tx of txs) {
    const sig = await sendAndConfirmTransaction(connection, tx, [kp, position]);
    signatures.push(sig);
  }

  console.log(
    JSON.stringify(
      {
        pool: POOL.toBase58(),
        position: position.publicKey.toBase58(),
        tokenXMint: tokenXMint.toBase58(),
        amountUi,
        bins: { minBinId, maxBinId },
        signatures,
      },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error("ERROR:", e?.stack || e?.message || e);
  process.exit(1);
});
