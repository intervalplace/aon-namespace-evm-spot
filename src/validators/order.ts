import type { AonObject } from "@intervalplace/aon-sdk";
import { verifyObjectSignature } from "./signatures.js";
import {
  requireNamespace,
  requireReferenceTypes,
  type ValidationGraph,
} from "./graph.js";

export async function validateOrder(obj: AonObject) {
  await verifyObjectSignature(obj);
}

export async function validateOrderGraph(
  obj: AonObject,
  graph: ValidationGraph
) {
  await validateOrder(obj);

  const [auth] = requireReferenceTypes(graph, obj, ["authorization"]);

  requireNamespace(auth.namespace, obj.namespace);
}
