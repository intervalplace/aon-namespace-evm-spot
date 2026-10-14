// Per-object validation for aon:evm-spot.
//
// The executor runs validateObject() on every object before evaluate(), and
// drops anything that throws. That makes this the place for all async
// cryptographic checks; the evaluator then only does cheap, synchronous
// cross-object checks (e.g. "was this revocation signed by the auth's owner").

import { getAddress, verifyTypedData, createPublicClient, http, parseAbiItem, decodeEventLog, keccak256, encodeAbiParameters, type Address, type Hex } from "viem";
import type { AonObject } from "@intervalplace/aon-sdk";

function stable(x: any): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stable).join(",")}]`;
  return `{${Object.keys(x).sort().map((k) => `${JSON.stringify(k)}:${stable(x[k])}`).join(",")}}`;
}

async function verifySig(sig: any, expectedSigner: string, primaryType: string, code: string) {
  if (!sig || sig.scheme !== "eip712") throw new Error(`${code}_MISSING_SIGNATURE`);
  if (sig.primaryType !== primaryType) throw new Error(`${code}_WRONG_PRIMARY_TYPE`);
  if (String(sig.signer).toLowerCase() !== expectedSigner.toLowerCase()) throw new Error(`${code}_SIGNER_MISMATCH`);
  const ok = await verifyTypedData({
    address: getAddress(expectedSigner) as Address,
    domain: sig.domain, types: sig.types, primaryType: sig.primaryType,
    message: sig.message, signature: sig.signature as Hex,
  } as any);
  if (!ok) throw new Error(`${code}_BAD_SIGNATURE`);
}

export const counterSetHash = (legs: { orderHash: string; maxBase: string | bigint }[]) =>
  keccak256(encodeAbiParameters(
    [{ type: "tuple[]", components: [{ name: "orderHash", type: "bytes32" }, { name: "maxBase", type: "uint256" }] }],
    [legs.map((l) => ({ orderHash: l.orderHash as Hex, maxBase: BigInt(l.maxBase) }))],
  ));

export async function validateOrderObject(obj: AonObject) {
  const o = (obj.payload as any)?.order;
  if (!o) throw new Error("MISSING_ORDER_PAYLOAD");
  if ((obj.references ?? []).length !== 1) throw new Error("ORDER_MUST_REFERENCE_ONE_AUTH");
  const sig = (obj as any).signature;
  if (stable(o) !== stable(sig?.message)) throw new Error("ORDER_PAYLOAD_MESSAGE_MISMATCH");
  await verifySig(sig, o.trader, "SignedOrder", "ORDER");

  // Counter set: published next to the signed order as [{orderHash, maxBase}],
  // must match the signed hash keccak256(abi.encode(legs))
  const set = (obj.payload as any)?.counterSet;
  const zero = /^0x0{64}$/i.test(String(o.counterSetHash ?? ""));
  if (zero) {
    if (set !== undefined && !(Array.isArray(set) && set.length === 0)) throw new Error("ORDER_COUNTER_SET_UNEXPECTED");
  } else {
    if (!Array.isArray(set) || set.length === 0 || set.length > 32) throw new Error("ORDER_COUNTER_SET_INVALID");
    if (!set.every((l: any) => /^0x[0-9a-fA-F]{64}$/.test(String(l?.orderHash)) && /^\d+$/.test(String(l?.maxBase)))) throw new Error("ORDER_COUNTER_SET_INVALID");
    if (new Set(set.map((l: any) => String(l.orderHash).toLowerCase())).size !== set.length) throw new Error("ORDER_COUNTER_SET_DUPLICATE");
    if (counterSetHash(set).toLowerCase() !== String(o.counterSetHash).toLowerCase()) throw new Error("ORDER_COUNTER_SET_HASH_MISMATCH");
  }
  if (BigInt(o.exclusiveBase ?? 0) > BigInt(o.baseAmount)) throw new Error("ORDER_EXCLUSIVE_EXCEEDS_SIZE");
}

export function validateFillObject(obj: AonObject) {
  const f = (obj.payload as any)?.fill;
  if (!f) throw new Error("MISSING_FILL_PAYLOAD");
  const refs = (obj.references ?? []).map((r) => r.toLowerCase());
  if (refs.length !== 4) throw new Error("INVALID_FILL_REFERENCE_COUNT");
  for (const k of ["makerAuthHash", "takerAuthHash", "makerOrderHash", "takerOrderHash"]) {
    if (!refs.includes(String(f[k] ?? "").toLowerCase())) throw new Error(`FILL_REFERENCE_MISSING_${k}`);
  }
  const base = BigInt(f.baseAmount), price = BigInt(f.price), quote = BigInt(f.quoteAmount);
  if (base <= 0n || price <= 0n) throw new Error("FILL_ZERO_AMOUNT");
  if ((base * price) / 10n ** 18n !== quote) throw new Error("FILL_QUOTE_MISMATCH");
  if (BigInt(f.executorFeeQuoteAmount ?? 0) < 0n) throw new Error("FILL_NEGATIVE_FEE");
}

// Proves the revocation was signed by payload.signature.signer. Whether that
// signer is allowed to revoke the target is checked in the evaluator, where
// the target object is available.
export async function validateRevocationObject(obj: AonObject) {
  const p = (obj.payload as any) ?? {};
  const sig = p.signature;
  const msg = { targetHash: p.targetHash, targetType: p.targetType, reason: p.reason, nonce: p.nonce };
  if (!p.targetHash || !(obj.references ?? []).map((r) => r.toLowerCase()).includes(String(p.targetHash).toLowerCase())) {
    throw new Error("REVOCATION_TARGET_NOT_REFERENCED");
  }
  if (stable(msg) !== stable(sig?.message)) throw new Error("REVOCATION_PAYLOAD_MESSAGE_MISMATCH");
  await verifySig(sig, String(sig?.signer ?? ""), "AonRevocation", "REVOCATION");
}

// ── Receipts ──────────────────────────────────────────────────────────────────
// A receipt is published by whoever executed the fill and is unsigned, so it
// proves nothing by itself. When the executor has an RPC (contract mode), we
// check the claimed tx succeeded and emitted SpotTradeSettled from the claimed
// contract with exactly the receipt's claims: fill key, order hashes, nonce,
// price, amounts and fee. The evaluator then checks those claims match the
// fill and its orders. Receipts that fail are dropped.

export const SETTLED_EVENT = parseAbiItem(
  "event SpotTradeSettled(bytes32 indexed fillKey, bytes32 indexed makerOrderHash, bytes32 indexed takerOrderHash, bytes32 fillNonce, bytes32 makerAuthHash, bytes32 takerAuthHash, address maker, address taker, address seller, address buyer, address executor, address baseToken, address quoteToken, uint256 price, uint256 baseAmount, uint256 quoteAmount, uint256 executorFeeQuoteAmount)"
);
let rpcClient: ReturnType<typeof createPublicClient> | null = null;
const lc = (x: any) => String(x ?? "").toLowerCase();

export async function validateReceiptObject(obj: AonObject) {
  const rpc = process.env.AON_EVM_RPC_URL;
  if (!rpc) return; // simulate/off modes: nothing to verify against
  const p = (obj.payload as any) ?? {};
  const txHash = String(p.executionTx ?? "");
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new Error("RECEIPT_NOT_ONCHAIN");
  for (const k of ["fillKey", "fillNonce", "makerOrderHash", "takerOrderHash", "settlementContract", "price", "baseAmount", "quoteAmount"]) {
    if (p[k] === undefined || p[k] === null || p[k] === "") throw new Error("RECEIPT_MISSING_FILL_BINDING");
  }
  const pinned = process.env.AON_EVM_SPOT_SETTLEMENT_CONTRACT;
  if (pinned && lc(pinned) !== lc(p.settlementContract)) throw new Error("RECEIPT_WRONG_CONTRACT");

  rpcClient ??= createPublicClient({ transport: http(rpc) });
  const r = await rpcClient.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
  if (!r || r.status !== "success") throw new Error("RECEIPT_TX_NOT_SUCCESSFUL");
  const matches = r.logs.some((l) => {
    if (lc(l.address) !== lc(p.settlementContract)) return false;
    let ev: any;
    try { ev = decodeEventLog({ abi: [SETTLED_EVENT], data: l.data, topics: l.topics as any }); } catch { return false; }
    const a = ev.args;
    return lc(a.fillKey) === lc(p.fillKey) && lc(a.fillNonce) === lc(p.fillNonce)
      && lc(a.makerOrderHash) === lc(p.makerOrderHash) && lc(a.takerOrderHash) === lc(p.takerOrderHash)
      && String(a.price) === String(p.price) && String(a.baseAmount) === String(p.baseAmount)
      && String(a.quoteAmount) === String(p.quoteAmount)
      && String(a.executorFeeQuoteAmount) === String(p.executorFeeQuoteAmount ?? "0");
  });
  if (!matches) throw new Error("RECEIPT_EVENT_NOT_FOUND");
}
