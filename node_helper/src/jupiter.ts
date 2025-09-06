// src/jupiter.ts  (FULL REPLACE)
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";

export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// ---- Price API v3 (Lite) ----
export async function getSolUsd(): Promise<number> {
  const r = await fetch("https://lite-api.jup.ag/price/v3?ids=" + WSOL_MINT);
  if (r.ok) {
    const j = await r.json();
    const p = j?.data?.[WSOL_MINT]?.price;
    if (typeof p === "number" && p > 0) return p;
  }
  // very simple fallback
  const cg = await (await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd")).json();
  return cg.solana.usd;
}

// ---- Quote SOL(WSOL) -> outMint ----
export async function jupQuoteSOLtoMint(outMint: string, lamportsIn: number, slippageBps = 100) {
  const url = "https://lite-api.jup.ag/swap/v1/quote?" + new URLSearchParams({
    inputMint: WSOL_MINT,
    outputMint: outMint,
    amount: String(lamportsIn),       // raw lamports
    slippageBps: String(slippageBps),
    restrictIntermediateTokens: "true",
  });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return res.json();
}

// ---- Build & send swap ----
export async function jupBuildAndSendSwap(
  connection: Connection,
  kp: Keypair,
  quoteResponse: any,
  opts?: { dynamicSlippage?: boolean }
) {
  const res = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,               // важливо для SOL⇄WSOL
      dynamicComputeUnitLimit: true,
      dynamicSlippage: !!opts?.dynamicSlippage
    }),
  });
  const body = await res.json();
  if (!res.ok || !body.swapTransaction) throw new Error(`Jupiter swap build failed: ${JSON.stringify(body)}`);

  const raw = Buffer.from(body.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([kp]);

  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction({
    signature: sig,
    blockhash: (tx.message as any).recentBlockhash,
    lastValidBlockHeight: body.lastValidBlockHeight,
  }, "confirmed");

  return { signature: sig };
}
