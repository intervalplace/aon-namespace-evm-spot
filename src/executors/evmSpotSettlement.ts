import {
  createWalletClient,
  createPublicClient,
  http,
  getAddress,
  hashTypedData,
  defineChain,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evmSpotNamespace } from "../namespace.js";

// ── ABI ───────────────────────────────────────────────────────────────────────

const abi = [
  {
    type: "function",
    name: "settleSpotTrade",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "makerAuth", type: "tuple",
        components: [
          { name: "grantor",             type: "address" },
          { name: "settlementContract",  type: "address" },
          { name: "baseToken",           type: "address" },
          { name: "quoteToken",          type: "address" },
          { name: "marketId",            type: "bytes32" },
          { name: "sideMask",            type: "uint8"   },
          { name: "maxBaseExposure",     type: "uint256" },
          { name: "maxQuoteExposure",    type: "uint256" },
          { name: "maxExecutorFeeQuote", type: "uint256" },
          { name: "minPrice",            type: "uint256" },
          { name: "maxPrice",            type: "uint256" },
          { name: "validAfter",          type: "uint64"  },
          { name: "validBefore",         type: "uint64"  },
          { name: "authNonce",           type: "bytes32" },
        ],
      },
      { name: "makerAuthSig", type: "bytes" },
      {
        name: "makerOrder", type: "tuple",
        components: [
          { name: "trader",          type: "address" },
          { name: "marketId",        type: "bytes32" },
          { name: "side",            type: "uint8"   },
          { name: "price",           type: "uint256" },
          { name: "baseAmount",      type: "uint256" },
          { name: "orderNonce",      type: "bytes32" },
          { name: "sessionAuthHash", type: "bytes32" },
          { name: "validAfter",      type: "uint64"  },
          { name: "validBefore",     type: "uint64"  },
        ],
      },
      { name: "makerOrderSig", type: "bytes" },
      {
        name: "takerAuth", type: "tuple",
        components: [
          { name: "grantor",             type: "address" },
          { name: "settlementContract",  type: "address" },
          { name: "baseToken",           type: "address" },
          { name: "quoteToken",          type: "address" },
          { name: "marketId",            type: "bytes32" },
          { name: "sideMask",            type: "uint8"   },
          { name: "maxBaseExposure",     type: "uint256" },
          { name: "maxQuoteExposure",    type: "uint256" },
          { name: "maxExecutorFeeQuote", type: "uint256" },
          { name: "minPrice",            type: "uint256" },
          { name: "maxPrice",            type: "uint256" },
          { name: "validAfter",          type: "uint64"  },
          { name: "validBefore",         type: "uint64"  },
          { name: "authNonce",           type: "bytes32" },
        ],
      },
      { name: "takerAuthSig", type: "bytes" },
      {
        name: "takerOrder", type: "tuple",
        components: [
          { name: "trader",          type: "address" },
          { name: "marketId",        type: "bytes32" },
          { name: "side",            type: "uint8"   },
          { name: "price",           type: "uint256" },
          { name: "baseAmount",      type: "uint256" },
          { name: "orderNonce",      type: "bytes32" },
          { name: "sessionAuthHash", type: "bytes32" },
          { name: "validAfter",      type: "uint64"  },
          { name: "validBefore",     type: "uint64"  },
        ],
      },
      { name: "takerOrderSig", type: "bytes" },
      {
        name: "fill", type: "tuple",
        components: [
          { name: "makerOrderHash",         type: "bytes32" },
          { name: "takerOrderHash",         type: "bytes32" },
          { name: "makerAuthHash",          type: "bytes32" },
          { name: "takerAuthHash",          type: "bytes32" },
          { name: "price",                  type: "uint256" },
          { name: "baseAmount",             type: "uint256" },
          { name: "quoteAmount",            type: "uint256" },
          { name: "executorFeeQuoteAmount", type: "uint256" },
          { name: "fillNonce",              type: "bytes32" },
        ],
      },
    ],
    outputs: [],
  },
] as const;

// ── Helpers ───────────────────────────────────────────────────────────────────

function requireEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`${name}_MISSING`);
  return v;
}

function asHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

function authTuple(a: any) {
  return {
    grantor:             getAddress(a.grantor),
    settlementContract:  getAddress(a.settlementContract),
    baseToken:           getAddress(a.baseToken),
    quoteToken:          getAddress(a.quoteToken),
    marketId:            asHex(a.marketId,   "INVALID_MARKET_ID"),
    sideMask:            Number(a.sideMask),
    maxBaseExposure:     BigInt(a.maxBaseExposure),
    maxQuoteExposure:    BigInt(a.maxQuoteExposure),
    maxExecutorFeeQuote: BigInt(a.maxExecutorFeeQuote ?? 0),
    minPrice:            BigInt(a.minPrice),
    maxPrice:            BigInt(a.maxPrice),
    validAfter:          BigInt(a.validAfter),
    validBefore:         BigInt(a.validBefore),
    authNonce:           asHex(a.authNonce, "INVALID_AUTH_NONCE"),
  };
}

function orderTuple(o: any) {
  return {
    trader:          getAddress(o.trader),
    marketId:        asHex(o.marketId,        "INVALID_ORDER_MARKET_ID"),
    side:            Number(o.side),
    price:           BigInt(o.price),
    baseAmount:      BigInt(o.baseAmount),
    orderNonce:      asHex(o.orderNonce,      "INVALID_ORDER_NONCE"),
    sessionAuthHash: asHex(o.sessionAuthHash, "INVALID_SESSION_AUTH_HASH"),
    validAfter:      BigInt(o.validAfter),
    validBefore:     BigInt(o.validBefore),
  };
}

// ── Executor ──────────────────────────────────────────────────────────────────

export async function executeEvmSpotOnEvm(args: { graph: any }) {
  const rpcUrl     = requireEnv("AON_EVM_RPC_URL");
  const privateKey = asHex(requireEnv("AON_EXECUTOR_PRIVATE_KEY"), "INVALID_EXECUTOR_PRIVATE_KEY");

  const graph = args.graph;

  const makerAuth  = graph.makerAuthorization.payload.authorization;
  const takerAuth  = graph.takerAuthorization.payload.authorization;
  const makerOrder = graph.makerOrder.payload.order;
  const takerOrder = graph.takerOrder.payload.order;
  const fill       = graph.fill.payload.fill;

  const makerAuthSig  = graph.makerAuthorization.signature?.signature;
  const takerAuthSig  = graph.takerAuthorization.signature?.signature;
  const makerOrderSig = graph.makerOrder.signature?.signature;
  const takerOrderSig = graph.takerOrder.signature?.signature;

  // Derive chain from the authorization's EIP-712 domain — ensures the executor
  // submits to the same chain the parties signed for, not a hardcoded network.
  const domain = graph.makerAuthorization.signature?.domain;
  if (!domain) throw new Error("MISSING_EIP712_DOMAIN");

  const chainId = Number(domain.chainId);
  const chain = defineChain({
    id:             chainId,
    name:           `evm-${chainId}`,
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls:        { default: { http: [rpcUrl] } },
  });

  const account = privateKeyToAccount(privateKey);
  const wallet  = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const pub     = createPublicClient({           chain, transport: http(rpcUrl) });

  const contract = getAddress(
    fill.settlementContract ??
    makerAuth.settlementContract ??
    requireEnv("AON_EVM_SPOT_SETTLEMENT_CONTRACT")
  );

  // Recompute EIP-712 hashes for the fill instruction.
  // The hashes stored in the AON fill payload are AON content-addressed hashes
  // (used for graph traversal). The settlement contract needs EIP-712 hashes,
  // which are a different hashing scheme derived from the auth/order structs.
  const authTypes  = evmSpotNamespace.types();
  const orderTypes = evmSpotNamespace.orderTypes();

  const makerAuthEip712  = hashTypedData({ domain, types: authTypes,  primaryType: "TradingSessionAuthorization", message: makerAuth });
  const takerAuthEip712  = hashTypedData({ domain, types: authTypes,  primaryType: "TradingSessionAuthorization", message: takerAuth });
  const makerOrderEip712 = hashTypedData({ domain, types: orderTypes, primaryType: "SignedOrder",                 message: makerOrder });
  const takerOrderEip712 = hashTypedData({ domain, types: orderTypes, primaryType: "SignedOrder",                 message: takerOrder });

  const fillArg = {
    makerOrderHash:         makerOrderEip712,
    takerOrderHash:         takerOrderEip712,
    makerAuthHash:          makerAuthEip712,
    takerAuthHash:          takerAuthEip712,
    price:                  BigInt(fill.price),
    baseAmount:             BigInt(fill.baseAmount),
    quoteAmount:            BigInt(fill.quoteAmount),
    executorFeeQuoteAmount: BigInt(fill.executorFeeQuoteAmount ?? 0),
    fillNonce:              asHex(fill.fillNonce, "INVALID_FILL_NONCE"),
  };

  const tx = await wallet.writeContract({
    address: contract,
    abi,
    functionName: "settleSpotTrade",
    args: [
      authTuple(makerAuth),  asHex(makerAuthSig,  "INVALID_MAKER_AUTH_SIG"),
      orderTuple(makerOrder), asHex(makerOrderSig, "INVALID_MAKER_ORDER_SIG"),
      authTuple(takerAuth),  asHex(takerAuthSig,  "INVALID_TAKER_AUTH_SIG"),
      orderTuple(takerOrder), asHex(takerOrderSig, "INVALID_TAKER_ORDER_SIG"),
      fillArg,
    ],
  });

  const receipt = await pub.waitForTransactionReceipt({ hash: tx, confirmations: 1 });

  return {
    executed:    true,
    mode:        "contract",
    executionTx: tx,
    result:      "evm_spot_settlement_submitted",
    details: {
      settlementContract: contract,
      executor:           account.address,
      tx,
      status:             receipt.status,
      blockNumber:        receipt.blockNumber.toString(),
      gasUsed:            receipt.gasUsed.toString(),
    },
  };
}
