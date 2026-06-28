import type { AonObject } from "./object.js";

function refsLower(obj: any) {
  return (obj.references ?? []).map((x: string) => x.toLowerCase());
}

function asBigInt(x: any) {
  if (x === undefined || x === null || x === "") return 0n;
  return BigInt(String(x));
}

function payload(obj: any) {
  return obj.payload ?? {};
}

function fillData(fill: any) {
  return fill.payload?.fill ?? fill.payload ?? {};
}

function receiptConsumesFill(receipt: any, fill: any) {
  const fillHash = fill.objectHash?.toLowerCase?.();
  const nonce = fillData(fill).fillNonce?.toLowerCase?.();

  return (
    (fillHash && refsLower(receipt).includes(fillHash)) ||
    (nonce && receipt.payload?.fillNonce?.toLowerCase?.() === nonce) ||
    (nonce && receipt.payload?.execution?.fillNonce?.toLowerCase?.() === nonce)
  );
}

function isFillReceipted(receipts: any[], fill: any) {
  return receipts.some((r) => receiptConsumesFill(r, fill));
}

function orderHash(order: any) {
  return order.objectHash?.toLowerCase?.();
}

function fillReferencesOrder(fill: any, order: any) {
  const refs = refsLower(fill);
  const h = orderHash(order);

  if (!h) return false;

  return (
    refs.includes(h) ||
    fillData(fill).makerOrderHash?.toLowerCase?.() === h ||
    fillData(fill).takerOrderHash?.toLowerCase?.() === h
  );
}

function sumReceiptedBaseForOrder(args: {
  fills: any[];
  receipts: any[];
  order: any;
}) {
  let total = 0n;

  for (const fill of args.fills) {
    if (!fillReferencesOrder(fill, args.order)) continue;
    if (!isFillReceipted(args.receipts, fill)) continue;

    total += asBigInt(fillData(fill).baseAmount);
  }

  return total;
}

export function findExecutableEvmSpotGraphs(
  objects: AonObject[],
  opts?: { includeCompleted?: boolean }
) {
  const authorizations = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "authorization" &&
      o.payload?.authorizationType === "evm_spot_session"
  );

  const orders = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "order" &&
      o.payload?.orderType === "evm_spot_order"
  );

  const fills = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "fill" &&
      o.payload?.fillType === "evm_spot_fill"
  );

  const receipts = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "receipt"
  );

  const out = [];

  for (const fill of fills) {
    if (!fill.objectHash) continue;

    const refs = refsLower(fill);
    if (refs.length < 4) continue;

    const makerAuth = authorizations.find(
      (o: any) => o.objectHash?.toLowerCase() === refs[0]
    );

    const takerAuth = authorizations.find(
      (o: any) => o.objectHash?.toLowerCase() === refs[1]
    );

    const makerOrder = orders.find(
      (o: any) => o.objectHash?.toLowerCase() === refs[2]
    );

    const takerOrder = orders.find(
      (o: any) => o.objectHash?.toLowerCase() === refs[3]
    );

    if (!makerAuth || !takerAuth || !makerOrder || !takerOrder) continue;

    const receipt = receipts.find((r: any) => receiptConsumesFill(r, fill));

    const f = fillData(fill);

    const currentFillBase = asBigInt(f.baseAmount);

    const makerAlreadyFilled = sumReceiptedBaseForOrder({
      fills,
      receipts,
      order: makerOrder,
    });

    const takerAlreadyFilled = sumReceiptedBaseForOrder({
      fills,
      receipts,
      order: takerOrder,
    });

    const makerTotal = asBigInt(payload(makerOrder).order?.baseAmount);
    const takerTotal = asBigInt(payload(takerOrder).order?.baseAmount);

    const makerRemaining =
      makerTotal > makerAlreadyFilled ? makerTotal - makerAlreadyFilled : 0n;

    const takerRemaining =
      takerTotal > takerAlreadyFilled ? takerTotal - takerAlreadyFilled : 0n;

    const wouldOverfillMaker =
      makerTotal > 0n && makerAlreadyFilled + currentFillBase > makerTotal;

    const wouldOverfillTaker =
      takerTotal > 0n && takerAlreadyFilled + currentFillBase > takerTotal;

    const status = receipt
      ? "completed"
      : wouldOverfillMaker || wouldOverfillTaker
        ? "overfilled"
        : "executable";

    if (!opts?.includeCompleted && status !== "executable") continue;

    out.push({
      status,
      namespace: "aon:evm-spot",
      makerAuthorization: makerAuth,
      takerAuthorization: takerAuth,
      makerOrder,
      takerOrder,
      fill,
      receipt: receipt ?? null,
      partialFill: {
        fillBaseAmount: currentFillBase.toString(),
        makerOrderHash: makerOrder.objectHash,
        takerOrderHash: takerOrder.objectHash,
        makerOrderBaseAmount: makerTotal.toString(),
        takerOrderBaseAmount: takerTotal.toString(),
        makerAlreadyFilled: makerAlreadyFilled.toString(),
        takerAlreadyFilled: takerAlreadyFilled.toString(),
        makerRemaining: makerRemaining.toString(),
        takerRemaining: takerRemaining.toString(),
        wouldOverfillMaker,
        wouldOverfillTaker,
      },
    });
  }

  return out;
}
