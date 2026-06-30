import type { NamespaceDriver } from "@intervalplace/aon-sdk";
import { findExecutableEvmSpotGraphs } from "./executableEvmSpot.js";
import { executeEvmSpotOnEvm } from "./executors/evmSpotSettlement.js";

export const evmSpotNamespace: NamespaceDriver = {
  namespace: "aon:evm-spot",

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
    if (!graph.makerAuthorization?.objectHash) throw new Error("MISSING_MAKER_AUTH");
    if (!graph.takerAuthorization?.objectHash) throw new Error("MISSING_TAKER_AUTH");
    if (!graph.makerOrder?.objectHash) throw new Error("MISSING_MAKER_ORDER");
    if (!graph.takerOrder?.objectHash) throw new Error("MISSING_TAKER_ORDER");
    if (!graph.fill?.objectHash) throw new Error("MISSING_FILL");

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
