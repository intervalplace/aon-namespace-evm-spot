/**
 * Full on-chain integration test for aon:evm-spot namespace.
 * Deploys GenericEvmSpotSettlement, two mock tokens, runs the complete
 * trade flow through AON and settles on-chain via settleSpotTrade().
 */

import { createPublicClient, createWalletClient, http, defineChain, hashTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "fs";
import {
  AonNodeClient, registerNamespace, getNamespace, finalizeObject,
} from "@intervalplace/aon-sdk";

// ── Artifacts ─────────────────────────────────────────────────────────────────

const ARTIFACTS = "/home/claude/work/evm-test/artifacts";
const load = (n) => JSON.parse(readFileSync(`${ARTIFACTS}/${n}.json`, "utf8"));
const MockUSDC            = load("MockUSDC");
const AonEvmSpotSettlement = load("AonEvmSpotSettlement");

// ── Namespace ─────────────────────────────────────────────────────────────────

const { evmSpotNamespace, buildEvmSpotAuthorizationObject,
        buildEvmSpotOrderObject, buildEvmSpotFillObject } =
  await import("/home/claude/work/evm-spot/aon-namespace-evm-spot-main/dist/index.js");

// ── Chain + clients ───────────────────────────────────────────────────────────

const hardhat = defineChain({
  id: 31337, name: "Hardhat",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
});

const DEPLOYER_PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const MAKER_PK    = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const TAKER_PK    = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";

const deployer = privateKeyToAccount(DEPLOYER_PK);
const maker    = privateKeyToAccount(MAKER_PK);
const taker    = privateKeyToAccount(TAKER_PK);
const executor = deployer; // executor = deployer for simplicity

const wc  = (acct) => createWalletClient({ account: acct, chain: hardhat, transport: http() });
const pub = createPublicClient({ chain: hardhat, transport: http() });

const deploy = async (artifact, args = [], acct = deployer) => {
  const hash = await wc(acct).deployContract({ abi: artifact.abi, bytecode: artifact.bytecode, args });
  return (await pub.waitForTransactionReceipt({ hash })).contractAddress;
};

const txn = async (addr, abi, fn, args, acct = deployer) => {
  const hash = await wc(acct).writeContract({ address: addr, abi, functionName: fn, args });
  return pub.waitForTransactionReceipt({ hash });
};

const read = (addr, abi, fn, args = []) =>
  pub.readContract({ address: addr, abi, functionName: fn, args });

// ── Trade constants ───────────────────────────────────────────────────────────

const PRICE       = 1_000_000_000_000_000_000n; // 1:1
const BASE_AMOUNT = 400_000_000_000_000_000n;   // 0.4 base
const QUOTE_AMOUNT = 400_000_000_000_000_000n;  // 0.4 quote
const FEE_AMOUNT  = 100_000_000_000_000n;        // 0.0001 quote (executor fee)
const MARKET_ID   = "0x" + "aa".repeat(32);

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("=== evm-spot Full On-Chain Integration Test ===\n");

// 1. Deploy contracts
console.log("[1] Deploying contracts...");
const baseTokenAddr  = await deploy(MockUSDC);
const quoteTokenAddr = await deploy(MockUSDC);
const settlementAddr = await deploy(AonEvmSpotSettlement);
console.log("  baseToken:   ", baseTokenAddr);
console.log("  quoteToken:  ", quoteTokenAddr);
console.log("  settlement:  ", settlementAddr);

// 2. Mint and approve
console.log("\n[2] Minting tokens and approving settlement contract...");
const makerBase  = BASE_AMOUNT * 2n;
const takerQuote = QUOTE_AMOUNT + FEE_AMOUNT + 1_000_000_000_000_000_000n;
await txn(baseTokenAddr,  MockUSDC.abi, "mint",    [maker.address, makerBase],  deployer);
await txn(quoteTokenAddr, MockUSDC.abi, "mint",    [taker.address, takerQuote], deployer);
await txn(baseTokenAddr,  MockUSDC.abi, "approve", [settlementAddr, makerBase],  maker);
await txn(quoteTokenAddr, MockUSDC.abi, "approve", [settlementAddr, takerQuote], taker);
console.log("  maker base balance: ", (await read(baseTokenAddr,  MockUSDC.abi, "balanceOf", [maker.address])).toString());
console.log("  taker quote balance:", (await read(quoteTokenAddr, MockUSDC.abi, "balanceOf", [taker.address])).toString());

// 3. AON flow
console.log("\n[3] Building AON objects...");
registerNamespace(evmSpotNamespace);
const client = new AonNodeClient(process.env.AON_URL ?? "http://127.0.0.1:8787");
const now    = Math.floor(Date.now() / 1000);

const domain = {
  name: "AON EVM Spot", version: "1",
  chainId: 31337, verifyingContract: settlementAddr,
};

// Maker authorization (sell side, sideMask=2)
const makerAuthStruct = {
  grantor:             maker.address,
  settlementContract:  settlementAddr,
  baseToken:           baseTokenAddr,
  quoteToken:          quoteTokenAddr,
  marketId:            MARKET_ID,
  sideMask:            2,
  maxBaseExposure:     "1000000000000000000",
  maxQuoteExposure:    "0",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice:            PRICE.toString(),
  maxPrice:            PRICE.toString(),
  validAfter:          String(now - 60),
  validBefore:         String(now + 3600),
  authNonce:           "0x" + "bb".repeat(32),
};

const makerAuthSig = await maker.signTypedData({
  domain, types: evmSpotNamespace.types(),
  primaryType: "TradingSessionAuthorization", message: makerAuthStruct,
});

const makerAuthObj = await buildEvmSpotAuthorizationObject({
  authorization: makerAuthStruct, signature: makerAuthSig, signer: maker.address, domain,
});
await client.putObject(makerAuthObj);
console.log("  maker auth:  ", makerAuthObj.objectHash);

// EIP-712 auth hashes for sessionAuthHash in orders (contract uses these, not AON object hashes)
const makerAuthEip712 = hashTypedData({ domain, types: evmSpotNamespace.types(), primaryType: "TradingSessionAuthorization", message: makerAuthStruct });

// Taker authorization (buy side, sideMask=1)
const takerAuthStruct = {
  grantor:             taker.address,
  settlementContract:  settlementAddr,
  baseToken:           baseTokenAddr,
  quoteToken:          quoteTokenAddr,
  marketId:            MARKET_ID,
  sideMask:            1,
  maxBaseExposure:     "0",
  maxQuoteExposure:    "1000000000000000000",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice:            PRICE.toString(),
  maxPrice:            PRICE.toString(),
  validAfter:          String(now - 60),
  validBefore:         String(now + 3600),
  authNonce:           "0x" + "cc".repeat(32),
};

const takerAuthSig = await taker.signTypedData({
  domain, types: evmSpotNamespace.types(),
  primaryType: "TradingSessionAuthorization", message: takerAuthStruct,
});

const takerAuthObj = await buildEvmSpotAuthorizationObject({
  authorization: takerAuthStruct, signature: takerAuthSig, signer: taker.address, domain,
});
await client.putObject(takerAuthObj);
console.log("  taker auth:  ", takerAuthObj.objectHash);
const takerAuthEip712 = hashTypedData({ domain, types: evmSpotNamespace.types(), primaryType: "TradingSessionAuthorization", message: takerAuthStruct });

// Maker order (sell, side=0)
const makerOrderStruct = {
  trader:          maker.address,
  marketId:        MARKET_ID,
  side:            0,
  price:           PRICE.toString(),
  baseAmount:      "1000000000000000000",
  orderNonce:      "0x" + "dd".repeat(32),
  sessionAuthHash: makerAuthEip712,  // EIP-712 hash — what the contract verifies
  validAfter:      String(now - 60),
  validBefore:     String(now + 3600),
};

const makerOrderSig = await maker.signTypedData({
  domain, types: evmSpotNamespace.orderTypes(),
  primaryType: "SignedOrder", message: makerOrderStruct,
});

const makerOrderObj = await buildEvmSpotOrderObject({
  order: makerOrderStruct, signature: makerOrderSig, signer: maker.address, domain,
  authorizationHash: makerAuthObj.objectHash,
});
await client.putObject(makerOrderObj);
console.log("  maker order: ", makerOrderObj.objectHash);

// Taker order (buy, side=1)
const takerOrderStruct = {
  trader:          taker.address,
  marketId:        MARKET_ID,
  side:            1,
  price:           PRICE.toString(),
  baseAmount:      "1000000000000000000",
  orderNonce:      "0x" + "ee".repeat(32),
  sessionAuthHash: takerAuthEip712,  // EIP-712 hash — what the contract verifies
  validAfter:      String(now - 60),
  validBefore:     String(now + 3600),
};

const takerOrderSig = await taker.signTypedData({
  domain, types: evmSpotNamespace.orderTypes(),
  primaryType: "SignedOrder", message: takerOrderStruct,
});

const takerOrderObj = await buildEvmSpotOrderObject({
  order: takerOrderStruct, signature: takerOrderSig, signer: taker.address, domain,
  authorizationHash: takerAuthObj.objectHash,
});
await client.putObject(takerOrderObj);
console.log("  taker order: ", takerOrderObj.objectHash);

// Fill
const fillObj = await buildEvmSpotFillObject({
  makerAuthorizationHash: makerAuthObj.objectHash,
  takerAuthorizationHash: takerAuthObj.objectHash,
  makerOrderHash:         makerOrderObj.objectHash,
  takerOrderHash:         takerOrderObj.objectHash,
  fill: {
    price:                  PRICE.toString(),
    baseAmount:             BASE_AMOUNT.toString(),
    quoteAmount:            QUOTE_AMOUNT.toString(),
    executorFeeQuoteAmount: FEE_AMOUNT.toString(),
    fillNonce:              "0x" + "f1".repeat(32),
    settlementContract:     settlementAddr,
  },
});
await client.putObject(fillObj);

// EIP-712 hashes — what the settlement contract computes and expects in FillInstruction
// EIP-712 auth hashes already computed above as makerAuthEip712 and takerAuthEip712
const makerAuthEip712Hash = makerAuthEip712;
const takerAuthEip712Hash = takerAuthEip712;
const makerOrderEip712Hash = hashTypedData({ domain, types: evmSpotNamespace.orderTypes(), primaryType: "SignedOrder",                 message: { ...makerOrderStruct, sessionAuthHash: makerAuthEip712Hash } });
const takerOrderEip712Hash = hashTypedData({ domain, types: evmSpotNamespace.orderTypes(), primaryType: "SignedOrder",                 message: { ...takerOrderStruct, sessionAuthHash: takerAuthEip712Hash } });
console.log("  fill:        ", fillObj.objectHash);

// 4. Evaluate
console.log("\n[4] Evaluating graph...");
const allObjects = await client.listObjects({ namespace: "aon:evm-spot" });
const evmSpotNs = getNamespace("aon:evm-spot");
const evaluated = evmSpotNs.evaluate(allObjects, { includeCompleted: false });
const executable = Array.isArray(evaluated)
  ? evaluated.find(g => g.status === "executable")
  : evaluated.graphs?.find(g => g.status === "executable");
if (!executable) throw new Error("NO_EXECUTABLE_GRAPH");
console.log("  executable graph found");

// 5. On-chain settlement
console.log("\n[5] Settling on-chain via namespace.execute() in contract mode...");

// Set env vars so the executor knows where to send
process.env.AON_EVM_RPC_URL = "http://127.0.0.1:8545";
process.env.AON_EXECUTOR_PRIVATE_KEY = DEPLOYER_PK; // executor = deployer
process.env.AON_EVM_SPOT_SETTLEMENT_CONTRACT = settlementAddr;

// namespace already obtained above
const executeResult = await evmSpotNs.execute(executable, { mode: "contract" });
console.log("  tx:       ", executeResult.executionTx);
console.log("  gas used: ", executeResult.details?.gasUsed);
console.log("  status:   ", executeResult.details?.status);
if (executeResult.details?.status !== "success") throw new Error("SETTLEMENT_FAILED");

// --- rest of balance checks use the existing receipt logic ---
const settleReceipt = { transactionHash: executeResult.executionTx, gasUsed: executeResult.details?.gasUsed };

const authTuple = (s) => ({
  grantor:             s.grantor,
  settlementContract:  s.settlementContract,
  baseToken:           s.baseToken,
  quoteToken:          s.quoteToken,
  marketId:            s.marketId,
  sideMask:            Number(s.sideMask),
  maxBaseExposure:     BigInt(s.maxBaseExposure),
  maxQuoteExposure:    BigInt(s.maxQuoteExposure),
  maxExecutorFeeQuote: BigInt(s.maxExecutorFeeQuote),
  minPrice:            BigInt(s.minPrice),
  maxPrice:            BigInt(s.maxPrice),
  validAfter:          BigInt(s.validAfter),
  validBefore:         BigInt(s.validBefore),
  authNonce:           s.authNonce,
});

const orderTuple = (s) => ({
  trader:          s.trader,
  marketId:        s.marketId,
  side:            Number(s.side),
  price:           BigInt(s.price),
  baseAmount:      BigInt(s.baseAmount),
  orderNonce:      s.orderNonce,
  sessionAuthHash: s.sessionAuthHash,
  validAfter:      BigInt(s.validAfter),
  validBefore:     BigInt(s.validBefore),
});

const mAuth = executable.makerAuthorization.payload.authorization;
const tAuth = executable.takerAuthorization.payload.authorization;
const mOrder = executable.makerOrder.payload.order;
const tOrder = executable.takerOrder.payload.order;
const fill   = executable.fill.payload.fill;

const fillTuple = {
  makerOrderHash:         makerOrderEip712Hash,
  takerOrderHash:         takerOrderEip712Hash,
  makerAuthHash:          makerAuthEip712Hash,
  takerAuthHash:          takerAuthEip712Hash,
  price:                  BigInt(fill.price),
  baseAmount:             BigInt(fill.baseAmount),
  quoteAmount:            BigInt(fill.quoteAmount),
  executorFeeQuoteAmount: BigInt(fill.executorFeeQuoteAmount),
  fillNonce:              fill.fillNonce,
};

// settlement already done above via namespace.execute()

// 6. Check balances
console.log("\n[6] Verifying balances...");
const makerBaseFinal   = await read(baseTokenAddr,  MockUSDC.abi, "balanceOf", [maker.address]);
const takerBaseFinal   = await read(baseTokenAddr,  MockUSDC.abi, "balanceOf", [taker.address]);
const makerQuoteFinal  = await read(quoteTokenAddr, MockUSDC.abi, "balanceOf", [maker.address]);
const takerQuoteFinal = await read(quoteTokenAddr, MockUSDC.abi, "balanceOf", [taker.address]);
const execQuoteFinal   = await read(quoteTokenAddr, MockUSDC.abi, "balanceOf", [executor.address]);
console.log("  maker base:    ", makerBaseFinal.toString(),   "(started with 2e18, sold 0.4e18)");
console.log("  taker base:    ", takerBaseFinal.toString(),   "(received 0.4e18)");
console.log("  maker quote:   ", makerQuoteFinal.toString(),  "(received 0.4e18)");
console.log("  taker quote:   ", takerQuoteFinal.toString(), "(started with ~1.4e18, paid 0.4e18 + fee)");
console.log("  executor quote:", execQuoteFinal.toString(),   "(received fee 1e14)");

if (takerBaseFinal !== BASE_AMOUNT)   throw new Error(`TAKER_BASE_WRONG: ${takerBase}`);
if (makerQuoteFinal !== QUOTE_AMOUNT) throw new Error(`MAKER_QUOTE_WRONG: ${makerQuote}`);
if (execQuoteFinal !== FEE_AMOUNT)    throw new Error(`EXEC_FEE_WRONG: ${execQuote}`);

// 7. Submit receipt
console.log("\n[7] Submitting receipt to AON...");
const receiptObj = await finalizeObject({
  objectType: "receipt", schemaVersion: "1", namespace: "aon:evm-spot",
  createdAt: Date.now(), creator: executor.address,
  references: [
    executable.makerAuthorization.objectHash,
    executable.takerAuthorization.objectHash,
    executable.makerOrder.objectHash,
    executable.takerOrder.objectHash,
    executable.fill.objectHash,
  ],
  payload: {
    receiptType: "authorized_state_transition_completed",
    executionTx: settleReceipt.transactionHash,
    gasUsed: String(settleReceipt.gasUsed),
  },
});
const receiptRes = await client.putObject(receiptObj);
console.log("  receipt: ", receiptRes.objectHash);

console.log("\n=== ok: evm-spot full on-chain flow completed ===");
