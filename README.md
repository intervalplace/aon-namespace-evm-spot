# @intervalplace/aon-namespace-evm-spot

EVM spot trading namespace for the Authorization Object Network.

Implements the `aon:evm-spot` namespace: spot trading on EVM without a reserve step, with partial fill support.

## Install

```bash
npm install @intervalplace/aon-sdk @intervalplace/aon-namespace-evm-spot
```

## Flow

```
makerAuthorization + takerAuthorization  (trading session grants, EIP-712 signed)
  → makerOrder + takerOrder              (signed order parameters)
    → fill                               (proposed match with amounts and nonce)
      → receipt                          (settled on-chain via settlement contract)
```

Partial fills are supported. Multiple fills can reference the same orders. The graph evaluator tracks cumulative filled amounts per order across all receipted fills to detect overfill conditions.

## Quickstart

```ts
import { registerNamespace, runExecutor, AonNodeClient } from "@intervalplace/aon-sdk";
import {
  evmSpotNamespace,
  buildEvmSpotAuthorizationObject,
  buildEvmSpotOrderObject,
  buildEvmSpotFillObject,
} from "@intervalplace/aon-namespace-evm-spot";
import { privateKeyToAccount } from "viem/accounts";

// Register the namespace
registerNamespace(evmSpotNamespace);

const client  = new AonNodeClient("http://localhost:8787");
const account = privateKeyToAccount("0x...");

const domain = {
  name: "AON EVM Spot",
  version: "1",
  chainId: 1,
  verifyingContract: "0x...",  // your settlement contract
};

// Build and submit a trading session authorization
const authData = {
  grantor:             account.address,
  settlementContract:  "0x...",
  baseToken:           "0x...",
  quoteToken:          "0x...",
  marketId:            "0x" + "aa".repeat(32),
  sideMask:            3,           // 1=buy, 2=sell, 3=both
  maxBaseExposure:     "1000000000000000000",
  maxQuoteExposure:    "1000000000000000000",
  maxExecutorFeeQuote: "1000000000000000",
  minPrice:            "0",
  maxPrice:            "999999999999999999999",
  validAfter:          String(Math.floor(Date.now() / 1000) - 60),
  validBefore:         String(Math.floor(Date.now() / 1000) + 3600),
  authNonce:           "0x" + "bb".repeat(32),
};

const sig = await account.signTypedData({
  domain,
  types: evmSpotNamespace.types!(),
  primaryType: "TradingSessionAuthorization",
  message: authData,
});

const authObj = await buildEvmSpotAuthorizationObject({
  authorization: authData,
  signature: sig,
  signer: account.address,
  domain,
});

await client.putObject(authObj);
console.log("authorization submitted:", authObj.objectHash);

// Run an executor against this namespace
await runExecutor({
  nodeUrl: "http://localhost:8787",
  namespace: "aon:evm-spot",
  mode: "contract",
  pollIntervalMs: 5000,
});
```

## Exports

```ts
import {
  // Namespace driver — register this with the SDK
  evmSpotNamespace,

  // Object builders
  buildEvmSpotAuthorizationObject,
  buildEvmSpotOrderObject,
  buildEvmSpotFillObject,
  buildEvmSpotRevocationObject,

  // Graph evaluation
  findExecutableEvmSpotGraphs,
} from "@intervalplace/aon-namespace-evm-spot";
```

## Object types

| Type | Description |
|---|---|
| `authorization` | Trading session grant. Defines grantor, settlement contract, market, exposure limits, validity window. |
| `order` | Signed order parameters. References an authorization. |
| `fill` | Proposed match between maker and taker orders. References both authorizations and both orders. |
| `receipt` | Settlement confirmed. References the fill. |
| `revocation` | Cancels an authorization or order. |

## Settlement contract

`src/contracts/GenericEvmSpotSettlement.sol` — the on-chain settlement contract that verifies and settles matched fills.

## Node and SDK

- Node: [intervalplace/aon](https://github.com/intervalplace/aon)
- SDK: [intervalplace/aon-sdk](https://github.com/intervalplace/aon-sdk)
- Spec: [SPEC.md](https://github.com/intervalplace/aon/blob/master/docs/spec.md)
