import type { NamespaceDriver } from "@intervalplace/aon-sdk";
import { getAddress } from "viem";
import { findExecutableEvmSpotGraphs } from "./executableEvmSpot.js";
import { executeEvmSpotOnEvm } from "./executors/evmSpotSettlement.js";

// ── Extended driver type ───────────────────────────────────────────────────────
// The SDK's NamespaceDriver defines the minimum contract for the registry.
// EvmSpotDriver extends it with EIP-712 helpers that are only meaningful
// inside this namespace — the SDK never sees or depends on these.

type EIP712Field = { name: string; type: string };
type EIP712Types = Record<string, EIP712Field[]>;

export type EvmSpotDriver = NamespaceDriver & {
  types(): EIP712Types;
  orderTypes(): EIP712Types;
  revocationTypes(): EIP712Types;
  normalizeAuthorization(auth: any): any;
};

// ── EIP-712 type schemas ───────────────────────────────────────────────────────
// Derived from the on-chain struct definitions in GenericEvmSpotSettlement.sol.

const AUTH_TYPES = {
  TradingSessionAuthorization: [
    { name: "grantor",              type: "address" },
    { name: "settlementContract",   type: "address" },
    { name: "baseToken",            type: "address" },
    { name: "quoteToken",           type: "address" },
    { name: "marketId",             type: "bytes32" },
    { name: "sideMask",             type: "uint8"   },
    { name: "maxBaseExposure",      type: "uint256" },
    { name: "maxQuoteExposure",     type: "uint256" },
    { name: "maxExecutorFeeQuote",  type: "uint256" },
    { name: "minPrice",             type: "uint256" },
    { name: "maxPrice",             type: "uint256" },
    { name: "validAfter",           type: "uint64"  },
    { name: "validBefore",          type: "uint64"  },
    { name: "authNonce",            type: "bytes32" },
  ],
};

const ORDER_TYPES = {
  SignedOrder: [
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
};

const REVOCATION_TYPES = {
  AonRevocation: [
    { name: "targetHash", type: "bytes32" },
    { name: "targetType", type: "string"  },
    { name: "reason",     type: "string"  },
    { name: "nonce",      type: "bytes32" },
  ],
};

export const evmSpotNamespace: EvmSpotDriver = {
  namespace: "aon:evm-spot",

  // ── EIP-712 schemas ──────────────────────────────────────────────────────────

  types() { return AUTH_TYPES; },
  orderTypes() { return ORDER_TYPES; },
  revocationTypes() { return REVOCATION_TYPES; },

  // ── Authorization normalization ───────────────────────────────────────────────
  // Checksums addresses, coerces uint fields to strings, keeps bytes32 as-is.
  // The returned object is used directly as the EIP-712 message.

  normalizeAuthorization(auth: any) {
    return {
      grantor:             getAddress(auth.grantor),
      settlementContract:  getAddress(auth.settlementContract),
      baseToken:           getAddress(auth.baseToken),
      quoteToken:          getAddress(auth.quoteToken),
      marketId:            auth.marketId,
      sideMask:            Number(auth.sideMask),
      maxBaseExposure:     String(auth.maxBaseExposure),
      maxQuoteExposure:    String(auth.maxQuoteExposure),
      maxExecutorFeeQuote: String(auth.maxExecutorFeeQuote ?? "0"),
      minPrice:            String(auth.minPrice),
      maxPrice:            String(auth.maxPrice),
      validAfter:          String(auth.validAfter),
      validBefore:         String(auth.validBefore),
      authNonce:           auth.authNonce,
    };
  },

  evaluate(objects, opts) {
    return findExecutableEvmSpotGraphs(objects, opts);
  },

  reward(graph: any) {
    const a =
      graph.makerAuthorization?.payload?.authorization ??
      graph.takerAuthorization?.payload?.authorization ??
      {};

    const f = graph.fill?.payload?.fill ?? {};

    return {
      token: a.quoteToken,
      amount: String(f.executorFeeQuoteAmount ?? "0"),
      tokenSymbol: "QUOTE",
      decimals: 18,
    };
  },

  verify(graph: any) {
    if (!graph.makerAuthorization?.objectHash) return { ok: false, reason: "MISSING_MAKER_AUTH" };
    if (!graph.takerAuthorization?.objectHash) return { ok: false, reason: "MISSING_TAKER_AUTH" };
    if (!graph.makerOrder?.objectHash)         return { ok: false, reason: "MISSING_MAKER_ORDER" };
    if (!graph.takerOrder?.objectHash)         return { ok: false, reason: "MISSING_TAKER_ORDER" };
    if (!graph.fill?.objectHash)               return { ok: false, reason: "MISSING_FILL" };

    return {
      ok: true,
      proofType: "evm_spot_fill",
      reason: "EVM_SPOT_VERIFIED_BY_NAMESPACE",
    };
  },

  async execute(graph: any, args?: { mode?: "off" | "simulate" | "contract" }) {
    const mode = args?.mode ?? "simulate";

    if (mode === "off") {
      return {
        executed: false,
        mode,
        executionTx: null,
        result: "verified_only",
      };
    }

    if (mode === "simulate") {
      return {
        executed: true,
        mode,
        executionTx: `simulated:aon:evm-spot:${graph.fill?.objectHash}`,
        result: "simulated_evm_spot_settlement",
      };
    }

    if (mode === "contract") {
      return await executeEvmSpotOnEvm({ graph });
    }

    throw new Error("UNKNOWN_EXECUTOR_MODE");
  },
};
