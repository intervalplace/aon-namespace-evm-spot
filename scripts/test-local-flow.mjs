import { privateKeyToAccount } from "viem/accounts";
import {
  AonNodeClient, registerNamespace, getNamespace, finalizeObject,
} from "@intervalplace/aon-sdk";
import {
  evmSpotNamespace, buildEvmSpotAuthorizationObject,
  buildEvmSpotOrderObject, buildEvmSpotFillObject,
} from "../dist/index.js";

// ── Config ────────────────────────────────────────────────────────────────────
const AON_URL = process.env.AON_URL ?? "http://127.0.0.1:8787";
const client  = new AonNodeClient(AON_URL);
registerNamespace(evmSpotNamespace);

const hex32 = (byte) => `0x${byte.repeat(32)}`;
const e18   = (n)    => String(BigInt(n) * 1_000_000_000_000_000_000n);

// ── Helpers ───────────────────────────────────────────────────────────────────
async function submit(obj, label) {
  const res = await client.putObject(obj);
  console.log(`${label}: ${res.objectHash}`);
  return res.object ?? obj;
}

async function getGraphs() {
  const all = await client.listObjects({ namespace: "aon:evm-spot" });
  return getNamespace("aon:evm-spot").evaluate(all, { includeCompleted: false });
}

function findExecutable(evaluated) {
  return (Array.isArray(evaluated) ? evaluated : (evaluated.graphs ?? []))
    .filter(g => g.status === "executable");
}

function assertExecutable(evaluated, fillObj, label) {
  const match = findExecutable(evaluated).find(g => g.fill?.objectHash === fillObj.objectHash);
  if (!match) throw new Error(`EXPECTED_EXECUTABLE: ${label}`);
  const pf = match.partialFill ?? {};
  console.log(`✓ ${label} executable — wouldOverfillMaker=${pf.wouldOverfillMaker} alreadyFilled=${pf.makerAlreadyFilled} remaining=${pf.makerRemaining}`);
  return match;
}

function assertNotExecutable(evaluated, fillObj, label) {
  const match = findExecutable(evaluated).find(g => g.fill?.objectHash === fillObj.objectHash);
  if (match) throw new Error(`EXPECTED_NOT_EXECUTABLE: ${label} — was executable with wouldOverfillMaker=${match.partialFill?.wouldOverfillMaker}`);
  console.log(`✓ ${label} correctly not executable`);
}

async function submitReceipt(graph, label) {
  const receipt = await finalizeObject({
    objectType: "receipt", schemaVersion: "1", namespace: "aon:evm-spot",
    createdAt: Date.now(),
    references: [
      graph.makerAuthorization.objectHash, graph.takerAuthorization.objectHash,
      graph.makerOrder.objectHash, graph.takerOrder.objectHash, graph.fill.objectHash,
    ],
    payload: {
      receiptType: "authorized_state_transition_completed",
      result: "simulated_evm_spot_settlement",
      executionTx: `simulated:aon:evm-spot:${graph.fill.objectHash}`,
      verification: { ok: true, proofType: "evm_spot_fill", reason: "EVM_SPOT_VERIFIED_BY_NAMESPACE" },
      executor: { mode: "simulate", executed: true },
    },
  });
  return submit(receipt, label ?? "receipt");
}

// ── Accounts & setup ──────────────────────────────────────────────────────────
const maker = privateKeyToAccount(process.env.MAKER_PK ?? "0x4019e96887def59e26a0929378394432f1b3986f42029269720f249943bf5fb5");
const taker = privateKeyToAccount(process.env.TAKER_PK ?? "0x59c6995e998f97a5a0044966f094538b3f50d8da019ff5f6347e10d7c5d525c6");

const now                = Math.floor(Date.now() / 1000);
const settlementContract = process.env.AON_EVM_SPOT_SETTLEMENT_CONTRACT ?? "0x0000000000000000000000000000000000000009";
const baseToken          = process.env.BASE_TOKEN  ?? "0x0000000000000000000000000000000000000010";
const quoteToken         = process.env.QUOTE_TOKEN ?? "0x0000000000000000000000000000000000000020";
const marketId           = hex32("aa");
const domain             = { name: "AON EVM Spot", version: "1", chainId: Number(process.env.CHAIN_ID ?? 1), verifyingContract: settlementContract };
const authTypes          = evmSpotNamespace.types();
const orderTypes         = evmSpotNamespace.orderTypes();

// ── Authorizations ────────────────────────────────────────────────────────────
const makerAuthStruct = { grantor: maker.address, settlementContract, baseToken, quoteToken, marketId, sideMask: 2, maxBaseExposure: e18(1), maxQuoteExposure: "0", maxExecutorFeeQuote: "1000000000000000", minPrice: e18(1), maxPrice: e18(1), validAfter: String(now - 60), validBefore: String(now + 3600), authNonce: hex32("bb") };
const takerAuthStruct = { grantor: taker.address, settlementContract, baseToken, quoteToken, marketId, sideMask: 1, maxBaseExposure: "0", maxQuoteExposure: e18(2), maxExecutorFeeQuote: "1000000000000000", minPrice: e18(1), maxPrice: e18(1), validAfter: String(now - 60), validBefore: String(now + 3600), authNonce: hex32("cc") };

const makerAuthObj = await buildEvmSpotAuthorizationObject({ authorization: makerAuthStruct, signature: await maker.signTypedData({ domain, types: authTypes, primaryType: "TradingSessionAuthorization", message: makerAuthStruct }), signer: maker.address, domain });
const takerAuthObj = await buildEvmSpotAuthorizationObject({ authorization: takerAuthStruct, signature: await taker.signTypedData({ domain, types: authTypes, primaryType: "TradingSessionAuthorization", message: takerAuthStruct }), signer: taker.address, domain });

await submit(makerAuthObj, "maker authorization");
await submit(takerAuthObj, "taker authorization");

// ── Orders (1.0 base each) ────────────────────────────────────────────────────
const makerOrderStruct = { trader: maker.address, marketId, side: 0, price: e18(1), baseAmount: e18(1), orderNonce: hex32("dd"), sessionAuthHash: makerAuthObj.objectHash, validAfter: String(now - 60), validBefore: String(now + 3600) };
const takerOrderStruct = { trader: taker.address, marketId, side: 1, price: e18(1), baseAmount: e18(1), orderNonce: hex32("ee"), sessionAuthHash: takerAuthObj.objectHash, validAfter: String(now - 60), validBefore: String(now + 3600) };

const makerOrderObj = await buildEvmSpotOrderObject({ authorizationHash: makerAuthObj.objectHash, authorization: makerAuthObj, order: makerOrderStruct, signature: await maker.signTypedData({ domain, types: orderTypes, primaryType: "SignedOrder", message: makerOrderStruct }), signer: maker.address, domain });
const takerOrderObj = await buildEvmSpotOrderObject({ authorizationHash: takerAuthObj.objectHash, authorization: takerAuthObj, order: takerOrderStruct, signature: await taker.signTypedData({ domain, types: orderTypes, primaryType: "SignedOrder", message: takerOrderStruct }), signer: taker.address, domain });

await submit(makerOrderObj, "maker order");
await submit(takerOrderObj, "taker order");

const fillBase = { makerAuthorizationHash: makerAuthObj.objectHash, takerAuthorizationHash: takerAuthObj.objectHash, makerOrderHash: makerOrderObj.objectHash, takerOrderHash: takerOrderObj.objectHash };

// ── Test 1: Valid partial fill (0.4 of 1.0) ──────────────────────────────────
console.log("\n── Test 1: Valid partial fill (0.4 of 1.0) ─────────────────────────────");
const fill1 = buildEvmSpotFillObject({ ...fillBase, fill: { price: e18(1), baseAmount: "400000000000000000", quoteAmount: "400000000000000000", executorFeeQuoteAmount: "100000000000000", fillNonce: hex32("f1"), settlementContract } });
await submit(fill1, "fill (0.4)");
const graph1 = assertExecutable(await getGraphs(), fill1, "0.4 fill");
await submitReceipt(graph1, "receipt (fill 1)");

// ── Test 2: Overfill attempt (1.5 of 1.0) ────────────────────────────────────
console.log("\n── Test 2: Overfill attempt (1.5 of 1.0) — must NOT be executable ──────");
const fill2 = buildEvmSpotFillObject({ ...fillBase, fill: { price: e18(1), baseAmount: "1500000000000000000", quoteAmount: "1500000000000000000", executorFeeQuoteAmount: "100000000000000", fillNonce: hex32("f2"), settlementContract } });
await submit(fill2, "fill (1.5 — overfill)");
assertNotExecutable(await getGraphs(), fill2, "1.5 overfill");

// ── Test 3: Second valid fill (0.5 of remaining 0.6) ─────────────────────────
console.log("\n── Test 3: Second valid fill (0.5 of remaining 0.6 after 0.4 receipt) ──");
const fill3 = buildEvmSpotFillObject({ ...fillBase, fill: { price: e18(1), baseAmount: "500000000000000000", quoteAmount: "500000000000000000", executorFeeQuoteAmount: "100000000000000", fillNonce: hex32("f3"), settlementContract } });
await submit(fill3, "fill (0.5)");
const graph3 = assertExecutable(await getGraphs(), fill3, "0.5 fill");
if (graph3.partialFill?.makerAlreadyFilled !== "400000000000000000")
  throw new Error(`WRONG_ALREADY_FILLED: got ${graph3.partialFill?.makerAlreadyFilled}`);
console.log(`  makerAlreadyFilled correctly = 0.4e18 ✓`);
await submitReceipt(graph3, "receipt (fill 3)");

// ── Test 4: Third fill overfills remaining (0.7 of 0.1 left) ─────────────────
console.log("\n── Test 4: Third fill overfills remaining (0.7 of 0.1 left) ───────────");
const fill4 = buildEvmSpotFillObject({ ...fillBase, fill: { price: e18(1), baseAmount: "700000000000000000", quoteAmount: "700000000000000000", executorFeeQuoteAmount: "100000000000000", fillNonce: hex32("f4"), settlementContract } });
await submit(fill4, "fill (0.7 — overfills remaining 0.1)");
assertNotExecutable(await getGraphs(), fill4, "0.7 fill (only 0.1 remains)");

console.log("\nok: evm spot local flow completed");
