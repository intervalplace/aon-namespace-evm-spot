import { getAddress, verifyTypedData, type Address, type Hex } from "viem";
import type { AonObject } from "@intervalplace/aon-sdk";

function stableStringify(x: any): string {
  if (x === null || typeof x !== "object") return JSON.stringify(x);
  if (Array.isArray(x)) return `[${x.map(stableStringify).join(",")}]`;

  return `{${Object.keys(x)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(x[k])}`)
    .join(",")}}`;
}

function assertSameObject(a: any, b: any) {
  if (stableStringify(a) !== stableStringify(b)) {
    throw new Error("AUTH_PAYLOAD_MESSAGE_MISMATCH");
  }
}


