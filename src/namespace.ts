import type { NamespaceDriver } from "@intervalplace/aon-sdk";
import { findExecutableEvmSpotGraphs } from "./executableEvmSpot.js";
import { executeEvmSpotOnEvm } from "./executors/evmSpotSettlement.js";
import { verifyAuthorizationObject } from "./verifiers/authorization.js";
import { validateOrderObject, validateFillObject, validateRevocationObject, validateReceiptObject } from "./validators/objects.js";
import { recordFillFailure, clearFillFailure } from "./executableEvmSpot.js";
import { finalizeObject } from "@intervalplace/aon-sdk";
import { getAddress } from "viem";

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
    { name: "receiveNative",   type: "bool"    },
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

    // Amount is in raw quote-token units. The namespace doesn't know token
    // metadata, so symbol/decimals are left for the caller to resolve.
    return {
      token: a.quoteToken,
      amount: String(f.executorFeeQuoteAmount ?? "0"),
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

  async validateObject(obj: any) {
    // Wire the authorization verifier — cross-checks payload.authorization
    // against signature.message before the object is accepted by the node
    switch (obj.objectType) {
      case "authorization": return verifyAuthorizationObject(obj);
      case "order":         return validateOrderObject(obj);
      case "fill":          return validateFillObject(obj);
      case "revocation":    return validateRevocationObject(obj);
      case "receipt":       return validateReceiptObject(obj);
    }
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
      let result;
      try {
        result = await executeEvmSpotOnEvm({ graph });
      } catch (err) {
        // Back off this fill so a permanently failing match (e.g. the seller
        // moved their tokens) isn't retried on every poll.
        recordFillFailure(graph.fill?.objectHash);
        throw err;
      }
      clearFillFailure(graph.fill?.objectHash);

      const refs = [
        graph.fill?.objectHash,
        graph.makerAuthorization?.objectHash,
        graph.takerAuthorization?.objectHash,
      ].filter(Boolean);

      const receiptObject = finalizeObject({
        objectType:    "receipt",
        schemaVersion: "1",
        namespace:     "aon:evm-spot",
        createdAt:     Date.now(),
        references:    refs,
        payload: {
          receiptType: "authorized_state_transition_completed",
          executionTx: result.executionTx,
          // Binds the receipt to one fill so it can be checked on-chain
          fillNonce: graph.fill?.payload?.fill?.fillNonce,
          settlementContract: result.details?.settlementContract,
        },
      });

      return { ...result, receiptObject };
    }

    throw new Error("UNKNOWN_EXECUTOR_MODE");
  },
};
