import type { AonObject } from "@intervalplace/aon-sdk";

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

// A receipt consumes a fill only if it references the fill AND carries the
// fill's nonce (checked against the chain in validateReceiptObject).
function receiptConsumesFill(receipt: any, fill: any) {
  const fillHash = fill.objectHash?.toLowerCase?.();
  const nonce = fillData(fill).fillNonce?.toLowerCase?.();
  if (!fillHash || !nonce) return false;
  if (!refsLower(receipt).includes(fillHash)) return false;
  if (receipt.payload?.fillNonce?.toLowerCase?.() !== nonce) return false;
  // …and the event must come from the contract this fill settles on
  const contract = fillData(fill).settlementContract?.toLowerCase?.();
  return !!contract && receipt.payload?.settlementContract?.toLowerCase?.() === contract;
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

// ── Failure backoff ───────────────────────────────────────────────────────────
// A fill can be structurally valid yet fail on-chain (a party lacks balance,
// another executor already settled it, ...). Back off exponentially instead
// of retrying every poll.

const failures = new Map<string, { count: number; retryAt: number }>();
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 30 * 60_000;

export function recordFillFailure(fillHash?: string) {
  if (!fillHash) return;
  const k = fillHash.toLowerCase();
  const count = (failures.get(k)?.count ?? 0) + 1;
  const delay = Math.min(BACKOFF_BASE_MS * 2 ** (count - 1), BACKOFF_MAX_MS);
  failures.set(k, { count, retryAt: Date.now() + delay });
}
export function clearFillFailure(fillHash?: string) {
  if (fillHash) failures.delete(fillHash.toLowerCase());
}
const inBackoff = (fillHash: string) => (failures.get(fillHash.toLowerCase())?.retryAt ?? 0) > Date.now();

const lower = (x: any) => String(x ?? "").toLowerCase();

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

  const revocations = objects.filter(
    (o: any) =>
      o.namespace === "aon:evm-spot" &&
      o.objectType === "revocation"
  );

  // Revocations only count when signed by the owner of the target:
  // the grantor for an authorization, the trader for an order.
  // (Signature validity itself is checked in validateObject.)
  const ownerOf = new Map<string, string>();
  for (const a of authorizations) ownerOf.set(lower(a.objectHash), lower((a.payload as any)?.authorization?.grantor));
  for (const o of orders)         ownerOf.set(lower(o.objectHash), lower((o.payload as any)?.order?.trader));

  const revokedHashes = new Set<string>();
  for (const rev of revocations) {
    const p = (rev.payload as any) ?? {};
    const target = lower(p.targetHash);
    const owner = ownerOf.get(target);
    if (owner && owner === lower(p.signature?.signer)) revokedHashes.add(target);
  }

  const nowSecs = Math.floor(Date.now() / 1000);
  const expired = (x: any) => Number(x?.validBefore ?? 0) < nowSecs || Number(x?.validAfter ?? 0) > nowSecs;

  const out = [];

  for (const fill of fills) {
    if (!fill.objectHash) continue;

    // H6: Match objects against payload fields, not reference array position.
    // Reference ordering is an implementation detail that could change.
    const fp = fill.payload?.fill as {
      makerAuthHash?: string; takerAuthHash?: string;
      makerOrderHash?: string; takerOrderHash?: string;
    } ?? {};

    const makerAuth = authorizations.find(
      (o: any) => o.objectHash?.toLowerCase() === fp.makerAuthHash?.toLowerCase()
    );

    const takerAuth = authorizations.find(
      (o: any) => o.objectHash?.toLowerCase() === fp.takerAuthHash?.toLowerCase()
    );

    const makerOrder = orders.find(
      (o: any) => o.objectHash?.toLowerCase() === fp.makerOrderHash?.toLowerCase()
    );

    const takerOrder = orders.find(
      (o: any) => o.objectHash?.toLowerCase() === fp.takerOrderHash?.toLowerCase()
    );

    if (!makerAuth || !takerAuth || !makerOrder || !takerOrder) continue;

    // Orders must belong to the authorizations the fill names
    if (!refsLower(makerOrder).includes(lower(makerAuth.objectHash))) continue;
    if (!refsLower(takerOrder).includes(lower(takerAuth.objectHash))) continue;

    // H8/M19: Skip fills where an authorization or order has been revoked
    if ([makerAuth, takerAuth, makerOrder, takerOrder].some((o: any) => revokedHashes.has(lower(o.objectHash)))) continue;

    // All four objects must name the same settlement contract
    const ma = (makerAuth.payload as any).authorization, ta = (takerAuth.payload as any).authorization;
    const sc = lower(ma?.settlementContract);
    if (!sc || lower(ta?.settlementContract) !== sc) continue;
    if (fp && (fp as any).settlementContract && lower((fp as any).settlementContract) !== sc) continue;

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

    // Don't hand the executor work the contract will reject anyway
    if (status === "executable") {
      if ([ma, ta, (makerOrder.payload as any).order, (takerOrder.payload as any).order].some(expired)) continue;
      if (inBackoff(fill.objectHash)) continue;
    }

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
