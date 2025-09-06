// src/jupiter.ts
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "node:buffer";

export const LITE_JUP = "https://lite-api.jup.ag";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// ---- Types for APIs ----
type PriceV3 = { data?: Record<string, { price?: number }> };
type CoingeckoPrice = { solana: { usd: number } };
type LiteSwapOk = { swapTransaction: string; lastValidBlockHeight: number };

// ---- Price API v3 (Lite) ----
export async function getSolUsd(): Promise<number> {
  const r = await fetch(`${LITE_JUP}/price/v3?ids=${WSOL_MINT}`);

  if (r.ok) {
    const j = (await r.json()) as PriceV3;
    const p = j?.data?.[WSOL_MINT]?.price;
    if (typeof p === "number" && isFinite(p) && p > 0) return p;
  }

  // very simple fallback (Coingecko)
  const cg = (await (
    await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd"
    )
  ).json()) as CoingeckoPrice;
  return cg.solana.usd;
}

// ---- Quote SOL(WSOL) -> outMint ----
export async function jupQuoteSOLtoMint(
  outMint: string,
  lamportsIn: number,
  slippageBps = 100
) {
  const url =
    `${LITE_JUP}/swap/v1/quote?` +
    new URLSearchParams({
      inputMint: WSOL_MINT,
      outputMint: outMint,
      amount: String(lamportsIn), // raw lamports
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true",
    });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return (await res.json()) as unknown; // залишаємо як unknown — споживач сам типізує
}

// ---- Build & send swap ----
export async function jupBuildAndSendSwap(
  connection: Connection,
  kp: Keypair,
  quoteResponse: unknown,
  opts?: { dynamicSlippage?: boolean }
) {
  const res = await fetch(`${LITE_JUP}/swap/v1/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: kp.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      dynamicSlippage: !!opts?.dynamicSlippage,
    }),
  });

  const body = (await res.json()) as Partial<LiteSwapOk> & { error?: unknown };

  if (!res.ok || !body?.swapTransaction) {
    throw new Error(
      `Jupiter swap build failed: ${JSON.stringify(body ?? {})}`
    );
  }

  const raw = Buffer.from(body.swapTransaction, "base64");
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([kp]);

  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });

  await connection.confirmTransaction(
    {
      signature: sig,
      blockhash: (tx.message as any).recentBlockhash,
      lastValidBlockHeight: body.lastValidBlockHeight!,
    },
    "confirmed"
  );

  return { signature: sig };
}

// +++ Mint -> Mint quote (додатково, як і було) +++
export async function jupQuoteMintToMint(
  inputMint: string,
  outputMint: string,
  rawAmount: number,
  slippageBps = 100
) {
  const url =
    `${LITE_JUP}/swap/v1/quote?` +
    new URLSearchParams({
      inputMint,
      outputMint,
      amount: String(rawAmount),
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true",
    });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return (await res.json()) as unknown;
}
