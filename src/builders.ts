// builders.ts — object construction helpers for aon:evm-spot
//
// These functions build and verify signed EVM spot objects
// before submitting them to a node.

import { getAddress, verifyTypedData, type Hex } from "viem";
import { finalizeObject, nowMs } from "@intervalplace/aon-sdk";
import type { AonObject } from "@intervalplace/aon-sdk";
import { evmSpotNamespace, type EvmSpotDriver } from "./namespace.js";

const ns: EvmSpotDriver = evmSpotNamespace;

function requireHex(x: any, code: string): Hex {
  if (typeof x !== "string" || !x.startsWith("0x")) throw new Error(code);
  return x as Hex;
}

async function requireValidTypedSignature(args: {
  domain: any;
  types: any;
  primaryType: string;
  message: any;
  signature: any;
  expectedSigner: string;
  code: string;
}) {
  const signature = requireHex(args.signature, "INVALID_SIGNATURE");
  const ok = await verifyTypedData({
    address: getAddress(args.expectedSigner),
    domain: args.domain,
    types: args.types,
    primaryType: args.primaryType as any,
    message: args.message,
    signature,
  } as any);
  if (!ok) throw new Error(args.code);
}

export async function buildEvmSpotAuthorizationObject(body: {
  authorization: any;
  signature: any;
  domain: any;
  types?: any;
  primaryType?: string;
  signer?: string;
  namespace?: string;
  createdAt?: number;
  references?: string[];
}): Promise<AonObject> {
  const authorization = ns.normalizeAuthorization!(body.authorization);
  const signer = getAddress(body.signer ?? authorization.grantor);

  if (signer.toLowerCase() !== authorization.grantor.toLowerCase()) {
    throw new Error("SIGNER_GRANTOR_MISMATCH");
  }

  await requireValidTypedSignature({
    domain: body.domain,
    types: body.types ?? ns.types!(),
    primaryType: body.primaryType ?? "TradingSessionAuthorization",
    message: authorization,
    signature: body.signature,
    expectedSigner: signer,
    code: "BAD_AUTHORIZATION_SIGNATURE",
  });

  return finalizeObject({
    objectType: "authorization",
    schemaVersion: "1",
    namespace: body.namespace ?? "aon:evm-spot",
    createdAt: body.createdAt ?? Date.now(),
    references: body.references ?? [],
    payload: {
      authorizationType: "evm_spot_session",
      authorization,
    },
    signature: {
      scheme: "eip712",
      signer,
      domain: body.domain,
      types: body.types ?? ns.types!(),
      primaryType: body.primaryType ?? "TradingSessionAuthorization",
      message: authorization,
      signature: body.signature,
    },
  } as any);
}

export async function buildEvmSpotOrderObject(body: {
  authorizationHash: string;
  authorization: AonObject;
  order: any;
  signature: any;
  domain: any;
  types?: any;
  primaryType?: string;
  signer?: string;
  createdAt?: number;
}): Promise<AonObject> {
  const orderTypes = ns.orderTypes!();
  const authHash = body.authorizationHash.toLowerCase();

  const order = {
    trader:          getAddress(body.order.trader),
    marketId:        requireHex(body.order.marketId, "INVALID_MARKET_ID"),
    side:            Number(body.order.side),
    price:           String(body.order.price),
    baseAmount:      String(body.order.baseAmount),
    orderNonce:      requireHex(body.order.orderNonce, "INVALID_ORDER_NONCE"),
    sessionAuthHash: requireHex(body.order.sessionAuthHash, "INVALID_SESSION_AUTH_HASH"),
    validAfter:      String(body.order.validAfter),
    validBefore:     String(body.order.validBefore),
  };

  // sessionAuthHash is the EIP-712 hash of the authorization struct — what the
  // settlement contract verifies on-chain. This is intentionally different from
  // authorizationHash (the AON content-addressed object hash), which is used for
  // graph traversal via references[]. Two separate hashing schemes, two purposes.

  const signer = getAddress(body.signer ?? order.trader);
  if (signer.toLowerCase() !== order.trader.toLowerCase()) {
    throw new Error("SIGNER_TRADER_MISMATCH");
  }

  await requireValidTypedSignature({
    domain: body.domain,
    types: body.types ?? orderTypes,
    primaryType: body.primaryType ?? "SignedOrder",
    message: order,
    signature: body.signature,
    expectedSigner: signer,
    code: "BAD_ORDER_SIGNATURE",
  });

  return finalizeObject({
    objectType: "order",
    schemaVersion: "1",
    namespace: "aon:evm-spot",
    createdAt: body.createdAt ?? nowMs(),
    references: [authHash],
    payload: {
      orderType: "evm_spot_order",
      order,
    },
    signature: {
      scheme: "eip712",
      signer,
      domain: body.domain,
      types: body.types ?? orderTypes,
      primaryType: body.primaryType ?? "SignedOrder",
      message: order,
      signature: body.signature,
    },
  } as any);
}

export function buildEvmSpotFillObject(body: {
  makerAuthorizationHash: string;
  takerAuthorizationHash: string;
  makerOrderHash: string;
  takerOrderHash: string;
  fill: any;
  createdAt?: number;
}): AonObject {
  const makerAuthorizationHash = body.makerAuthorizationHash.toLowerCase();
  const takerAuthorizationHash = body.takerAuthorizationHash.toLowerCase();
  const makerOrderHash = body.makerOrderHash.toLowerCase();
  const takerOrderHash = body.takerOrderHash.toLowerCase();

  const fill = {
    makerOrderHash:        requireHex(body.fill.makerOrderHash ?? makerOrderHash, "INVALID_MAKER_ORDER_HASH"),
    takerOrderHash:        requireHex(body.fill.takerOrderHash ?? takerOrderHash, "INVALID_TAKER_ORDER_HASH"),
    makerAuthHash:         requireHex(body.fill.makerAuthHash  ?? makerAuthorizationHash, "INVALID_MAKER_AUTH_HASH"),
    takerAuthHash:         requireHex(body.fill.takerAuthHash  ?? takerAuthorizationHash, "INVALID_TAKER_AUTH_HASH"),
    price:                 String(body.fill.price),
    baseAmount:            String(body.fill.baseAmount),
    quoteAmount:           String(body.fill.quoteAmount),
    executorFeeQuoteAmount: String(body.fill.executorFeeQuoteAmount ?? "0"),
    fillNonce:             requireHex(body.fill.fillNonce, "INVALID_FILL_NONCE"),
    settlementContract:    body.fill.settlementContract,
  };

  return finalizeObject({
    objectType: "fill",
    schemaVersion: "1",
    namespace: "aon:evm-spot",
    createdAt: body.createdAt ?? Date.now(),
    references: [makerAuthorizationHash, takerAuthorizationHash, makerOrderHash, takerOrderHash],
    payload: {
      fillType: "evm_spot_fill",
      fill,
    },
  });
}

export async function buildEvmSpotRevocationObject(
  objects: AonObject[],
  body: {
    targetHash: string;
    signature: any;
    signer?: string;
    reason?: string;
    nonce?: string;
    createdAt?: number;
  }
): Promise<AonObject> {
  const revocationTypes = ns.revocationTypes!();
  const targetHash = body.targetHash.toLowerCase();
  const target = objects.find((o) => o.objectHash?.toLowerCase() === targetHash);

  if (!target) throw new Error("TARGET_OBJECT_NOT_FOUND");

  const alreadyRevoked = objects.some(
    (o) => o.objectType === "revocation" &&
    (o.references ?? []).map(r => r.toLowerCase()).includes(targetHash)
  );
  if (alreadyRevoked) throw new Error("TARGET_ALREADY_REVOKED");

  const signer = body.signer ??
    (target.payload as any)?.authorization?.grantor;

  const reason = body.reason ?? "user_revoked";
  const nonce  = requireHex(body.nonce ?? body.signature?.message?.nonce, "MISSING_REVOCATION_NONCE");

  const revocationMessage = { targetHash, targetType: target.objectType, reason, nonce };

  await requireValidTypedSignature({
    domain: body.signature.domain,
    types:  body.signature.types ?? revocationTypes,
    primaryType: body.signature.primaryType ?? "AonRevocation",
    message: revocationMessage,
    signature: body.signature.signature,
    expectedSigner: signer!,
    code: "BAD_REVOCATION_SIGNATURE",
  });

  return finalizeObject({
    objectType: "revocation",
    schemaVersion: "1",
    namespace: target.namespace,
    createdAt: body.createdAt ?? Date.now(),
    references: [targetHash],
    payload: {
      revocationType: `${target.objectType}_revocation`,
      targetType: target.objectType,
      targetHash,
      reason,
      nonce,
      signature: {
        scheme: body.signature.scheme ?? "eip712",
        signer,
        domain: body.signature.domain,
        types: body.signature.types ?? revocationTypes,
        primaryType: body.signature.primaryType ?? "AonRevocation",
        message: revocationMessage,
        signature: body.signature.signature,
      },
    },
  } as any);
}
