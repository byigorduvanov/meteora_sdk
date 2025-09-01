import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import nacl from "tweetnacl";

export function loadKeypair(): Keypair {
  const b58 = process.env.WALLET_SECRET_BASE58?.trim();
  const json = process.env.WALLET_SECRET_JSON?.trim();

  if (b58) {
    const raw = bs58.decode(b58);
    const secret =
      raw.length === 32 ? nacl.sign.keyPair.fromSeed(raw).secretKey : raw;
    return Keypair.fromSecretKey(Uint8Array.from(secret));
  }
  if (json) {
    const arr = JSON.parse(json) as number[];
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  throw new Error("No wallet secret provided (WALLET_SECRET_BASE58 or WALLET_SECRET_JSON).");
}
