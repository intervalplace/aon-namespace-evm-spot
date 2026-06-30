import type { AonObject } from "@intervalplace/aon-sdk";
import { verifyObjectSignature } from "./signatures.js";

export async function validateOrder(obj: AonObject) {
  await verifyObjectSignature(obj);
}
