import { createWalletClient, createPublicClient, http, getAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { mainnet } from "viem/chains";

const abi = [
  {
    type: "function",
    name: "settleSpotTrade",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "makerAuth",
        type: "tuple",
        components: [
          { name: "grantor", type: "address" },
          { name: "settlementContract", type: "address" },
          { name: "baseToken", type: "address" },
          { name: "quoteToken", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "sideMask", type: "uint8" },
          { name: "maxBaseExposure", type: "uint256" },
          { name: "maxQuoteExposure", type: "uint256" },
          { name: "maxExecutorFeeQuote", type: "uint256" },
          { name: "minPrice", type: "uint256" },
          { name: "maxPrice", type: "uint256" },
          { name: "validAfter", type: "uint64" },
          { name: "validBefore", type: "uint64" },
          { name: "authNonce", type: "bytes32" },
        ],
      },
      { name: "makerAuthSig", type: "bytes" },
      {
        name: "makerOrder",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "side", type: "uint8" },
          { name: "price", type: "uint256" },
          { name: "baseAmount", type: "uint256" },
          { name: "orderNonce", type: "bytes32" },
          { name: "sessionAuthHash", type: "bytes32" },
          { name: "validAfter", type: "uint64" },
          { name: "validBefore", type: "uint64" },
        ],
      },
      { name: "makerOrderSig", type: "bytes" },
      {
        name: "takerAuth",
        type: "tuple",
        components: [
          { name: "grantor", type: "address" },
          { name: "settlementContract", type: "address" },
          { name: "baseToken", type: "address" },
          { name: "quoteToken", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "sideMask", type: "uint8" },
          { name: "maxBaseExposure", type: "uint256" },
          { name: "maxQuoteExposure", type: "uint256" },
          { name: "maxExecutorFeeQuote", type: "uint256" },
          { name: "minPrice", type: "uint256" },
          { name: "maxPrice", type: "uint256" },
          { name: "validAfter", type: "uint64" },
          { name: "validBefore", type: "uint64" },
          { name: "authNonce", type: "bytes32" },
        ],
      },
      { name: "takerAuthSig", type: "bytes" },
      {
        name: "takerOrder",
        type: "tuple",
        components: [
          { name: "trader", type: "address" },
          { name: "marketId", type: "bytes32" },
          { name: "side", type: "uint8" },
          { name: "price", type: "uint256" },
          { name: "baseAmount", type: "uint256" },
          { name: "orderNonce", type: "bytes32" },
          { name: "sessionAuthHash", type: "bytes32" },
          { name: "validAfter", type: "uint64" },
          { name: "validBefore", type: "uint64" },
        ],
      },
      { name: "takerOrderSig", type: "bytes" },
      {
        name: "fill",
        type: "tuple",
        components: [
          { name: "makerOrderHash", type: "bytes32" },
          { name: "takerOrderHash", type: "bytes32" },
          { name: "makerAuthHash", type: "bytes32" },
          { name: "takerAuthHash", type: "bytes32" },
          { name: "price", type: "uint256" },
          { name: "baseAmount", type: "uint256" },
          { name: "quoteAmount", type: "uint256" },
          { name: "executorFeeQuoteAmount", type: "uint256" },
          { name: "fillNonce", type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_MISSING`);
  return value;
}

function asHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

function authTuple(a: any) {
  return {
    grantor: getAddress(a.grantor),
    settlementContract: getAddress(a.settlementContract),
    baseToken: getAddress(a.baseToken),
    quoteToken: getAddress(a.quoteToken),
    marketId: asHex(a.marketId, "INVALID_MARKET_ID"),
    sideMask: Number(a.sideMask),
    maxBaseExposure: BigInt(a.maxBaseExposure),
    maxQuoteExposure: BigInt(a.maxQuoteExposure),
    maxExecutorFeeQuote: BigInt(a.maxExecutorFeeQuote ?? 0),
    minPrice: BigInt(a.minPrice),
    maxPrice: BigInt(a.maxPrice),
    validAfter: BigInt(a.validAfter),
    validBefore: BigInt(a.validBefore),
    authNonce: asHex(a.authNonce, "INVALID_AUTH_NONCE"),
  };
}

function orderTuple(o: any) {
  return {
    trader: getAddress(o.trader),
    marketId: asHex(o.marketId, "INVALID_ORDER_MARKET_ID"),
    side: Number(o.side),
    price: BigInt(o.price),
    baseAmount: BigInt(o.baseAmount),
    orderNonce: asHex(o.orderNonce, "INVALID_ORDER_NONCE"),
    sessionAuthHash: asHex(o.sessionAuthHash, "INVALID_SESSION_AUTH_HASH"),
    validAfter: BigInt(o.validAfter),
    validBefore: BigInt(o.validBefore),
  };
}

function fillTuple(f: any) {
  return {
    makerOrderHash: asHex(f.makerOrderHash, "INVALID_MAKER_ORDER_HASH"),
    takerOrderHash: asHex(f.takerOrderHash, "INVALID_TAKER_ORDER_HASH"),
    makerAuthHash: asHex(f.makerAuthHash, "INVALID_MAKER_AUTH_HASH"),
    takerAuthHash: asHex(f.takerAuthHash, "INVALID_TAKER_AUTH_HASH"),
    price: BigInt(f.price),
    baseAmount: BigInt(f.baseAmount),
    quoteAmount: BigInt(f.quoteAmount),
    executorFeeQuoteAmount: BigInt(f.executorFeeQuoteAmount ?? 0),
    fillNonce: asHex(f.fillNonce, "INVALID_FILL_NONCE"),
  };
}

export async function executeEvmSpotOnEvm(args: {
  graph: any;
}) {
  const rpcUrl = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const account = privateKeyToAccount(privateKey);

  const client = createWalletClient({
    account,
    chain: mainnet,
    transport: http(rpcUrl),
  });

  const publicClient = createPublicClient({
    chain: mainnet,
    transport: http(rpcUrl),
  });

const graph = args.graph;

const makerAuth = graph.makerAuthorization.payload.authorization;
const takerAuth = graph.takerAuthorization.payload.authorization;
const makerOrder = graph.makerOrder.payload.order;
const takerOrder = graph.takerOrder.payload.order;
const fill = graph.fill.payload.fill;

const makerAuthSig = graph.makerAuthorization.signature?.signature;
const takerAuthSig = graph.takerAuthorization.signature?.signature;
const makerOrderSig = graph.makerOrder.signature?.signature;
const takerOrderSig = graph.takerOrder.signature?.signature;

const contract = getAddress(
  fill.settlementContract ??
    makerAuth.settlementContract ??
    requireEnv("AON_EVM_SPOT_SETTLEMENT_CONTRACT")
);

  const tx = await client.writeContract({
    address: contract,
    abi,
    functionName: "settleSpotTrade",
    args: [
      authTuple(makerAuth),
      asHex(makerAuthSig, "INVALID_MAKER_AUTH_SIG"),
      orderTuple(makerOrder),
      asHex(makerOrderSig, "INVALID_MAKER_ORDER_SIG"),
      authTuple(takerAuth),
      asHex(takerAuthSig, "INVALID_TAKER_AUTH_SIG"),
      orderTuple(takerOrder),
      asHex(takerOrderSig, "INVALID_TAKER_ORDER_SIG"),
      fillTuple(fill),
    ],
  });

  const receipt = await publicClient.waitForTransactionReceipt({
    hash: tx,
    confirmations: 1,
  });

  return {
    executed: true,
    mode: "contract",
    executionTx: tx,
    result: "evm_spot_settlement_submitted",
    details: {
      settlementContract: contract,
      executor: account.address,
      tx,
      status: receipt.status,
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
    },
  };
}
