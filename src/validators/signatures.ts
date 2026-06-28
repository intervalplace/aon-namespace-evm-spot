import { getAddress, verifyTypedData } from "viem";
import type { AonObject } from "../object.js";

export async function verifyObjectSignature(
  obj: AonObject
) {
  const sig = (obj as any).signature;

  if (!sig) return;

  const ok = await verifyTypedData({
    address: getAddress(sig.signer),
    domain: sig.domain,
    types: sig.types,
    primaryType: sig.primaryType,
    message: sig.message,
    signature: sig.signature,
  } as any);

  if (!ok) {
    throw new Error("BAD_OBJECT_SIGNATURE");
  }
}
