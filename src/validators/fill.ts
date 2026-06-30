import type { AonObject } from "@intervalplace/aon-sdk";

export async function validateFill(obj: AonObject) {
  if ((obj.references ?? []).length !== 4) {
    throw new Error("INVALID_FILL_REFERENCE_COUNT");
  }
}
