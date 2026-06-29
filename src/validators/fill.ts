import type { AonObject } from "@intervalplace/aon-sdk";
import {
  requireNamespace,
  requireReferenceTypes,
  type ValidationGraph,
} from "./graph.js";

export async function validateFill(obj: AonObject) {
  if ((obj.references ?? []).length !== 4) {
    throw new Error("INVALID_FILL_REFERENCE_COUNT");
  }
}

export async function validateFillGraph(
  obj: AonObject,
  graph: ValidationGraph
) {
  await validateFill(obj);

  const [makerAuth, takerAuth, makerOrder, takerOrder] =
    requireReferenceTypes(graph, obj, [
      "authorization",
      "authorization",
      "order",
      "order",
    ]);

  requireNamespace(makerAuth.namespace, obj.namespace);
  requireNamespace(takerAuth.namespace, obj.namespace);
  requireNamespace(makerOrder.namespace, obj.namespace);
  requireNamespace(takerOrder.namespace, obj.namespace);
}
