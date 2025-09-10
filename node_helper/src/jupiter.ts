// src/jupiter.ts
import { Connection, Keypair, VersionedTransaction } from "@solana/web3.js";
import { Buffer } from "node:buffer";

export const LITE_JUP = "https://lite-api.jup.ag";
export const WSOL_MINT = "So11111111111111111111111111111111111111112";

// ---- Types for APIs ----
type LiteSwapOk = { swapTransaction: string; lastValidBlockHeight: number };

function toAmountString(a: number | bigint | string): string {
  if (typeof a === "string") return a;
  if (typeof a === "bigint") return a.toString();
  if (!Number.isFinite(a)) throw new Error("amount is not finite");
  // для сирих атомів/лампортів без дробової частини
  return Math.trunc(a).toString();
}

/** Quote: SOL(WSOL) -> outMint */
export async function jupQuoteSOLtoMint(
  outMint: string,
  lamportsIn: number | bigint | string,
  slippageBps = 100
) {
  const url =
    `${LITE_JUP}/swap/v1/quote?` +
    new URLSearchParams({
      inputMint: WSOL_MINT,
      outputMint: outMint,
      amount: toAmountString(lamportsIn), // raw lamports
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true",
    });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return (await res.json()) as unknown; // типізується на місці використання
}

/** Build & send swap */
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
    throw new Error(`Jupiter swap build failed: ${JSON.stringify(body ?? {})}`);
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

/** Quote: Mint -> Mint */
export async function jupQuoteMintToMint(
  inputMint: string,
  outputMint: string,
  rawAmount: number | bigint | string,
  slippageBps = 100
) {
  const url =
    `${LITE_JUP}/swap/v1/quote?` +
    new URLSearchParams({
      inputMint,
      outputMint,
      amount: toAmountString(rawAmount), // сирі атоми inputMint
      slippageBps: String(slippageBps),
      restrictIntermediateTokens: "true",
    });

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Jupiter quote failed: ${res.status}`);
  return (await res.json()) as unknown;
}
