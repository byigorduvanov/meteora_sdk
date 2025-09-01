// node_helper/src/meteora.ts
import { Connection, PublicKey } from "@solana/web3.js";
import fetch from "node-fetch";

// ✅ надійний імпорт SDK у ESM-проекті
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Meteora = require("@meteora-ag/dlmm");
const DLMM: any = (Meteora?.default ?? Meteora);


export function getConnection(): Connection {
  const url = process.env.SOLANA_RPC_URL;
  if (!url) throw new Error("SOLANA_RPC_URL is not set");
  return new Connection(url, { commitment: "confirmed" });
}

export async function createPool(connection: Connection, poolAddress: string) {
  const pubkey = new PublicKey(poolAddress);
  return await DLMM.create(connection, pubkey);
}

export async function listPairsFromAPI() {
  const resp = await fetch("https://dlmm-api.meteora.ag/pair/all");
  if (!resp.ok) throw new Error(`dlmm-api.meteora.ag failed: ${resp.status}`);
  return await resp.json();
}

export async function getPoolState(connection: Connection, poolAddress: string) {
  const pool = await createPool(connection, poolAddress);
  const activeBin = await pool.getActiveBin();
  const feeInfo = await pool.getFeeInfo();
  return { activeBin, feeInfo };
}

export async function getBinsAroundActive(connection: Connection, poolAddress: string, around: number) {
  const pool = await createPool(connection, poolAddress);
  const active = await pool.getActiveBin();
  const bins = await pool.getBinsAroundActiveBin(around);
  return { active, bins };
}

export async function getUserPositions(connection: Connection, owner: string) {
  const ownerPk = new PublicKey(owner);
  return await DLMM.getAllLbPairPositionsByUser(connection, ownerPk);
}

/* Dialect-версію лишаю на випадок зворотної сумісності; SDK — пріоритет */
export async function addLiquidityViaDialect(opts: {
  pool: string; ownerBase58: string; amount?: number; rawOwner: Uint8Array; connection: Connection;
}) {
  const base = `https://meteora.dial.to/api/v0/dlmm/${opts.pool}/add-liquidity`;
  const url = opts.amount ? `${base}?amount=${encodeURIComponent(opts.amount)}` : base;
  const resp = await fetch(url, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "transaction", account: opts.ownerBase58 })
  });
  if (!resp.ok) { const txt = await resp.text(); throw new Error(`Dialect add-liquidity failed: ${resp.status} ${txt}`); }
  const data = (await resp.json()) as { transaction: string };
  const raw = Buffer.from(data.transaction, "base64");
  const sig = await opts.connection.sendRawTransaction(raw, { skipPreflight: false });
  const conf = await opts.connection.confirmTransaction(sig, "confirmed");
  return { signature: sig, confirmation: conf };
}
