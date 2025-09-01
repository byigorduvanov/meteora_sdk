import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const LITE_JUP = "https://lite-api.jup.ag";
export const WSOL_MINT = "So11111111111111111111111111111111111111112"; // офіційний WSOL mint :contentReference[oaicite:1]{index=1}

export async function getSolUsd(): Promise<number> {
  // Спершу пробуємо офіційний Jupiter Price API v3 (free 'lite' хост) → якщо не вийде, падaємо на CoinGecko.
  try {
    const r = await fetch(`${LITE_JUP}/price/v3?ids=${WSOL_MINT}`);
    const j = await r.json();
    const p = j?.data?.[WSOL_MINT]?.price;
    if (typeof p === "number" && p > 0) return p; // ціна в USD
  } catch {}
  const cg = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).json();
  return cg.solana.usd; // fallback
}

export async function jupQuoteSOLtoMint(outMint: string, lamportsIn: number, slippageBps = 100) {
  const url = `${LITE_JUP}/swap/v1/quote?` +
    new URLSearchParams({
      inputMint: WSOL_MINT,
      outputMint: outMint,
      amount: String(lamportsIn),            // "raw amount" у лампортах/атомах :contentReference[oaicite:2]{index=2}
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true"
    });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return res.json();
}

export async function jupBuildAndSendSwap(
  connection: Connection,
  kp: Keypair,
  quoteResponse: any
) {
  const res = await fetch(`${LITE_JUP}/swap/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: kp.publicKey.toBase58(),
      // допомагає з лендінгом транз: авто-ліміт compute, пріоритетні фіси, динам. сліпедж
      dynamicComputeUnitLimit: true,
      dynamicSlippage: true
    })
  });
  const body = await res.json();
  if (!res.ok || !body.swapTransaction) throw new Error(`Jupiter swap build failed: ${JSON.stringify(body)}`);

  const raw = Buffer.from(body.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([kp]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  // Підтвердження (без зайвих RPC викликів)
  await connection.confirmTransaction({
    signature: sig,
    blockhash: (tx.message as any).recentBlockhash,
    lastValidBlockHeight: body.lastValidBlockHeight
  }, "confirmed");

  return { signature: sig };
}
