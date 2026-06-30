import { privateKeyToAccount } from "viem/accounts";
import {
  AonNodeClient,
  registerNamespace,
  getNamespace,
} from "@intervalplace/aon-sdk";

import {
  evmSpotNamespace,
  buildEvmSpotAuthorizationObject,
  buildEvmSpotOrderObject,
  buildEvmSpotFillObject,
} from "../dist/index.js";

const AON_URL = process.env.AON_URL ?? "http://127.0.0.1:8787";

const client = new AonNodeClient(AON_URL);

registerNamespace(evmSpotNamespace);

function hex32(byte) {
  return `0x${byte.repeat(32)}`;
}

async function submit(obj, label) {
  const res = await client.putObject(obj);
  console.log(`${label}: ${res.objectHash}`);
  return res.object ?? obj;
}

const maker = privateKeyToAccount(
  process.env.MAKER_PK ??
    "0x4019e96887def59e26a0929378394432f1b3986f42029269720f249943bf5fb5"
);

const taker = privateKeyToAccount(
  process.env.TAKER_PK ??
    "0x59c6995e998f97a5a0044966f094538b3f50d8da019ff5f6347e10d7c5d525c68"
);

const now = Math.floor(Date.now() / 1000);

const settlementContract =
  process.env.AON_EVM_SPOT_SETTLEMENT_CONTRACT ??
  "0x0000000000000000000000000000000000000009";

const baseToken =
  process.env.BASE_TOKEN ?? "0x0000000000000000000000000000000000000010";

const quoteToken =
  process.env.QUOTE_TOKEN ?? "0x0000000000000000000000000000000000000020";

const marketId = hex32("aa");

const domain = {
  name: "AON EVM Spot",
  version: "1",
  chainId: Number(process.env.CHAIN_ID ?? 1),
  verifyingContract: settlementContract,
};

const authTypes = evmSpotNamespace.types();
const orderTypes = evmSpotNamespace.orderTypes();

const makerAuth = {
  grantor: maker.address,
  settlementContract,
  baseToken,
  quoteToken,
  marketId,
  sideMask: 2,
  maxBaseExposure: "1000000000000000000",
  maxQuoteExposure: "0",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice: "1000000000000000000",
  maxPrice: "1000000000000000000",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  authNonce: hex32("bb"),
};

const takerAuth = {
  grantor: taker.address,
  settlementContract,
  baseToken,
  quoteToken,
  marketId,
  sideMask: 1,
  maxBaseExposure: "0",
  maxQuoteExposure: "1000000000000000000",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice: "1000000000000000000",
  maxPrice: "1000000000000000000",
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
  authNonce: hex32("cc"),
};

const makerAuthSig = await maker.signTypedData({
  domain,
  types: authTypes,
  primaryType: "TradingSessionAuthorization",
  message: makerAuth,
});

const takerAuthSig = await taker.signTypedData({
  domain,
  types: authTypes,
  primaryType: "TradingSessionAuthorization",
  message: takerAuth,
});

const makerAuthObj = await buildEvmSpotAuthorizationObject({
  authorization: makerAuth,
  signature: makerAuthSig,
  signer: maker.address,
  domain,
});

const takerAuthObj = await buildEvmSpotAuthorizationObject({
  authorization: takerAuth,
  signature: takerAuthSig,
  signer: taker.address,
  domain,
});

await submit(makerAuthObj, "maker authorization");
await submit(takerAuthObj, "taker authorization");

const makerOrder = {
  trader: maker.address,
  marketId,
  side: 0,
  price: "1000000000000000000",
  baseAmount: "1000000000000000000",
  orderNonce: hex32("dd"),
  sessionAuthHash: makerAuthObj.objectHash,
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
};

const takerOrder = {
  trader: taker.address,
  marketId,
  side: 1,
  price: "1000000000000000000",
  baseAmount: "1000000000000000000",
  orderNonce: hex32("ee"),
  sessionAuthHash: takerAuthObj.objectHash,
  validAfter: String(now - 60),
  validBefore: String(now + 3600),
};

const makerOrderSig = await maker.signTypedData({
  domain,
  types: orderTypes,
  primaryType: "SignedOrder",
  message: makerOrder,
});

const takerOrderSig = await taker.signTypedData({
  domain,
  types: orderTypes,
  primaryType: "SignedOrder",
  message: takerOrder,
});

const makerOrderObj = await buildEvmSpotOrderObject({
  authorizationHash: makerAuthObj.objectHash,
  authorization: makerAuthObj,
  order: makerOrder,
  signature: makerOrderSig,
  signer: maker.address,
  domain,
});

const takerOrderObj = await buildEvmSpotOrderObject({
  authorizationHash: takerAuthObj.objectHash,
  authorization: takerAuthObj,
  order: takerOrder,
  signature: takerOrderSig,
  signer: taker.address,
  domain,
});

await submit(makerOrderObj, "maker order");
await submit(takerOrderObj, "taker order");

const fillObj = buildEvmSpotFillObject({
  makerAuthorizationHash: makerAuthObj.objectHash,
  takerAuthorizationHash: takerAuthObj.objectHash,
  makerOrderHash: makerOrderObj.objectHash,
  takerOrderHash: takerOrderObj.objectHash,
  fill: {
    price: "1000000000000000000",
    baseAmount: "400000000000000000",
    quoteAmount: "400000000000000000",
    executorFeeQuoteAmount: "100000000000000",
    fillNonce: hex32("f1"),
    settlementContract,
  },
});

await submit(fillObj, "fill");

const graph = await client.walkGraph(makerAuthObj.objectHash);

const namespace = getNamespace("aon:evm-spot");
const evaluated = namespace.evaluate(graph.objects, {
  includeCompleted: false,
});

console.log("evaluated:");
console.log(JSON.stringify(evaluated, null, 2));

const executable = Array.isArray(evaluated)
  ? evaluated.find((g) => g.status === "executable")
  : evaluated.graphs?.find((g) => g.status === "executable");

if (!executable) {
  throw new Error("NO_EXECUTABLE_EVM_SPOT_GRAPH");
}

const verification = namespace.verify?.(executable) ?? { ok: true };

const action = await namespace.execute(executable, {
  mode: process.env.AON_EXECUTOR_MODE ?? "simulate",
});

const receipt = {
  objectType: "receipt",
  schemaVersion: "1",
  namespace: "aon:evm-spot",
  createdAt: Date.now(),
  creator: "aon-evm-spot-test",
  references: [
    executable.makerAuthorization.objectHash,
    executable.takerAuthorization.objectHash,
    executable.makerOrder.objectHash,
    executable.takerOrder.objectHash,
    executable.fill.objectHash,
  ],
  payload: {
    receiptType: "authorized_state_transition_completed",
    result: action.result,
    executionTx: action.executionTx ?? null,
    summary: "EVM spot fill consumed by split AON SDK flow",
    verification,
    executor: {
      mode: action.mode,
      executed: action.executed,
    },
  },
};

await submit(receipt, "receipt");

console.log("ok: evm spot local flow completed");
