import type { AonObject } from "@intervalplace/aon-sdk";
import { hashTypedData, keccak256, encodeAbiParameters, type Hex } from "viem";

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

// A receipt consumes a fill only if every claim in it matches this exact
// trade: the fill's nonce, price, amounts and fee, the contract, and the
// EIP-712 hashes of the fill's two orders (from which the on-chain fill key
// is derived). validateReceiptObject has already checked those claims against
// the SpotTradeSettled event on-chain. Together that means a receipt from some
// other trade (e.g. an attacker's own tiny trade reusing this nonce) can't
// mark this fill as done.
let genuineReceipts = new Map<string, any>(); // fill objectHash -> receipt (incl. duplicates of a settled fill)
let creditedFills = new Set<string>();       // one fill objectHash per on-chain fill key

const eipCache = new Map<string, string | null>();
function orderEip712FromObject(order: any): string | null {
  const k = String(order?.objectHash ?? "").toLowerCase();
  if (k && eipCache.has(k)) return eipCache.get(k)!;
  const sig = order?.signature;
  let h: string | null = null;
  if (sig?.domain && sig?.types && sig?.message) {
    try { h = hashTypedData({ domain: sig.domain, types: sig.types, primaryType: "SignedOrder", message: sig.message } as any).toLowerCase(); }
    catch { h = null; }
  }
  if (k) eipCache.set(k, h);
  return h;
}

// The contract's replay key for a fill: every field of it
export function fillKeyFor(f: any, makerOrderEip712: string, takerOrderEip712: string) {
  return keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }],
    [f.fillNonce, makerOrderEip712 as Hex, takerOrderEip712 as Hex, BigInt(f.price), BigInt(f.baseAmount), BigInt(f.quoteAmount), BigInt(f.executorFeeQuoteAmount ?? 0)])).toLowerCase();
}

function computeGenuineReceipts(objects: any[], fills: any[], receipts: any[]) {
  const byHash = new Map(objects.map((o: any) => [String(o.objectHash).toLowerCase(), o]));
  const out = new Map<string, any>();
  const credited = new Set<string>();
  const byKey = new Map<string, any>(); // fill key -> the receipt that proved it
  // Oldest first, so the original fill object is the one credited
  const ordered = [...fills].sort((a: any, b: any) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  const keyOf = new Map<string, string>();
  for (const fill of ordered) {
    const f = fillData(fill);
    const mk = orderEip712FromObject(byHash.get(String(f.makerOrderHash ?? "").toLowerCase()));
    const tk = orderEip712FromObject(byHash.get(String(f.takerOrderHash ?? "").toLowerCase()));
    if (!mk || !tk || !f.fillNonce) continue;
    let key: string;
    try { key = fillKeyFor(f, mk, tk); } catch { continue; }
    keyOf.set(String(fill.objectHash).toLowerCase(), key);
    const contract = lower(f.settlementContract);
    const fh = String(fill.objectHash).toLowerCase();
    const r = receipts.find((r: any) => {
      const p = r.payload ?? {};
      return refsLower(r).includes(fh)
        && lower(p.fillKey) === key
        && lower(p.makerOrderHash) === mk && lower(p.takerOrderHash) === tk
        && !!contract && lower(p.settlementContract) === contract;
    });
    if (r && !byKey.has(key)) byKey.set(key, r);
  }
  // Every fill object with a proven key counts as done, but each on-chain
  // settlement is credited to exactly one fill object, so clones can't
  // double-count it.
  for (const fill of ordered) {
    const fh = String(fill.objectHash).toLowerCase();
    const key = keyOf.get(fh);
    if (!key || !byKey.has(key)) continue;
    out.set(fh, byKey.get(key));
    if (![...credited].some((c) => keyOf.get(c) === key)) credited.add(fh);
  }
  return { out, credited };
}

function receiptConsumesFill(receipt: any, fill: any) {
  return genuineReceipts.get(String(fill.objectHash).toLowerCase()) === receipt;
}

function isFillReceipted(receipts: any[], fill: any) {
  return receipts.some((r) => receiptConsumesFill(r, fill));
}

function orderHash(order: any) {
  return order.objectHash?.toLowerCase?.();
}

// Per-order totals are keyed by the order's EIP-712 hash, not its AON object
// hash: a republished copy of an order object is the same signed order, so
// fills pointing at either copy count toward the same total.
let objIndex = new Map<string, any>();
function eipOfOrderRef(ref: any): string | null {
  return orderEip712FromObject(objIndex.get(String(ref ?? "").toLowerCase()));
}
function fillReferencesOrder(fill: any, order: any) {
  const target = orderEip712FromObject(order);
  if (!target) return false;
  const f = fillData(fill);
  return eipOfOrderRef(f.makerOrderHash) === target || eipOfOrderRef(f.takerOrderHash) === target;
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
    if (!creditedFills.has(String(fill.objectHash).toLowerCase())) continue; // count each settlement once

    // what actually settled (the receipt's amount is checked against the event)
    const r = genuineReceipts.get(String(fill.objectHash).toLowerCase());
    total += asBigInt(r?.payload?.baseAmount ?? fillData(fill).baseAmount);
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
  objIndex = new Map((objects as any[]).map((o: any) => [String(o.objectHash).toLowerCase(), o]));
  ({ out: genuineReceipts, credited: creditedFills } = computeGenuineReceipts(objects as any[], fills, receipts));

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

    // The contract settles whatever part of a fill still fits, so a fill is
    // only dead once one side has nothing left.
    const wouldOverfillMaker = makerTotal > 0n && makerRemaining === 0n;
    const wouldOverfillTaker = takerTotal > 0n && takerRemaining === 0n;

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
