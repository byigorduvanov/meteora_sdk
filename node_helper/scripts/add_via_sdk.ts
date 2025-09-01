// node_helper/scripts/add_via_sdk.ts
import "dotenv/config";
import { Connection, Keypair, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import DLMM, { StrategyType } from "@meteora-ag/dlmm";
import { getAssociatedTokenAddress, getAccount, getMint } from "@solana/spl-token";
import BN from "bn.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

// --- завантажуємо ключ із .env (BASE58 або JSON 64 чисел)
function loadKeypair(): Keypair {
  const b58 = process.env.WALLET_SECRET_BASE58?.trim();
  const json = process.env.WALLET_SECRET_JSON?.trim();
  if (b58) {
    const raw = bs58.decode(b58);
    const seed = raw.length === 32 ? nacl.sign.keyPair.fromSeed(raw).secretKey : raw;
    return Keypair.fromSecretKey(Uint8Array.from(seed));
  }
  if (json) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(json)));
  throw new Error("Set WALLET_SECRET_BASE58 or WALLET_SECRET_JSON in .env");
}

async function main() {
  const RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const POOL_ARG = process.argv[2]; // можна передати адресу пулу аргументом
  const POOL = new PublicKey(POOL_ARG || process.env.POOL || "EFXXyGFTGkubdW7bse9fwnYr2xsaRGgyA3vP1UXVbWLh");

  const kp = loadKeypair();
  const connection = new Connection(RPC, "confirmed");

  // 1) Ініціалізуємо DLMM-пул (офіційний SDK)
  const dlmmPool = await DLMM.create(connection, POOL); // :contentReference[oaicite:1]{index=1}

  // 2) TokenX (у твоєму пулі це NYLA) і його decimals
  const tokenXMint = dlmmPool.tokenX.publicKey;
  const mintInfo = await getMint(connection, tokenXMint);
  const decimals = mintInfo.decimals;

  // 3) Наш ATA для tokenX і баланс у «людських» одиницях
  const ata = await getAssociatedTokenAddress(tokenXMint, kp.publicKey);
  const acc = await getAccount(connection, ata).catch(() => null);
  if (!acc) throw new Error("Немає токен-акаунта tokenX. Спочатку отримай трохи tokenX (NYLA).");
  const balanceUi = Number(acc.amount) / Math.pow(10, decimals);

  // 4) Скільки заводимо: або AMOUNT_UI з .env, або ~98% від балансу
  const amountUi = Number(process.env.AMOUNT_UI ?? (balanceUi * 0.98));
  if (!(amountUi > 0)) throw new Error("amount <= 0: поповни tokenX на гаманці.");

  const amountAtoms = new BN(Math.floor(amountUi * Math.pow(10, decimals)));

  // 5) Обираємо діапазон біни навколо активного (±10 — дефолт)
  const active = await dlmmPool.getActiveBin();
  const minBinId = active.binId - 10;
  const maxBinId = active.binId + 10;

  // 6) ОДНА транзакція: створити позицію + додати ліквідність (SDK)
  const tx = await dlmmPool.initializePositionAndAddLiquidityByStrategy({
    positionPubKey: Keypair.generate().publicKey,
    user: kp.publicKey,
    totalXAmount: amountAtoms,          // tokenX (NYLA) у «сирих» атомах
    totalYAmount: new BN(0),            // односторонньо в tokenX
    strategy: { minBinId, maxBinId, strategyType: StrategyType.Spot },
  }); // функція на додачу ліквідності через SDK :contentReference[oaicite:2]{index=2}

  const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
  console.log(JSON.stringify({
    signature: sig,
    pool: POOL.toBase58(),
    tokenXMint: tokenXMint.toBase58(),
    amountUi,
    bins: { minBinId, maxBinId }
  }, null, 2));
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
