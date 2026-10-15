# Changes (Covenant hardening)

Security and reliability fixes found while building Covenant's EVM markets.
No contract changes.

## Validation (`validateObject`, run by the executor on every object)
- **Orders**: signature verified, payload must equal the signed message, exactly one auth reference.
- **Fills**: all four referenced hashes must be in `references`; `quoteAmount` must equal `baseAmount * price / 1e18`; non-zero amounts.
- **Revocations**: EIP-712 signature verified; target must be referenced.
- **Receipts** (when `AON_EVM_RPC_URL` is set): the tx must have succeeded and emitted a `SpotTradeSettled` event from its `settlementContract` matching every claim (fill key, nonce, order hashes, price, base, quote, fee).

## Evaluator
- **Revocations only count when signed by the target's owner** (grantor for an authorization, trader for an order). Previously any object referencing an auth hash blocked it, so anyone could stop any order from executing.
- **Receipts only complete a fill when they carry that fill's nonce and contract.** Previously any receipt referencing a fill hash marked it completed, so a fake receipt could block settlement forever.
- Orders must reference the auths the fill names; all objects must agree on the settlement contract.
- Skips fills whose auths/orders are expired or not yet valid.
- **Failure backoff**: fills that fail on-chain back off exponentially (30s → 30min) instead of retrying every poll.

## Executor
- The contract to call is taken from what both parties signed (auth + EIP-712 domain), never from the unsigned fill. Optional pin via `AON_EVM_SPOT_SETTLEMENT_CONTRACT`.
- **A reverted settlement tx no longer produces a receipt.** Previously a revert (e.g. two executors racing) was published as a successful receipt.
- Receipts now include `fillNonce` and `settlementContract`.

## Other
- `reward()` no longer claims 18 decimals / "QUOTE" symbol; amount is raw quote units.

Note: receipts published by older executors lack `fillNonce` and are ignored.
Their fills are re-evaluated; re-execution reverts with `FillReplay` in gas
estimation (no gas spent) and then backs off.

## Contract: native ETH payout (breaking: new constructor arg and order field)
- `constructor(address wrappedNative)`; pass WETH, or `address(0)` to disable.
- `SignedOrder` gains `bool receiveNative` (EIP-712 type updated). Only valid on
  buy orders in markets whose base token is `WRAPPED_NATIVE`; the contract
  rejects it anywhere else.
- When set, settlement pulls WETH from the seller into the contract, unwraps
  it, and sends ETH to the buyer — after every state change and the quote
  transfers. If the buyer refuses ETH, the whole trade reverts.
- `settleSpotTrade` is `nonReentrant`. Verified with an EIP-7702 wallet that
  re-enters with a valid second trade during the payout: the guard rejects it.
- `receive()` only accepts ETH from `WRAPPED_NATIVE`.
- `_safeTransferFrom` rejects token addresses with no code (a call to an EOA
  would otherwise "succeed"). Zero-amount fills are rejected.
- Still requires `viaIR: true` to compile (unchanged from before).

## Contract: front-running protection (breaking: new order fields and fill fields)
- `SignedOrder` gains `bytes32 counterSetHash, uint256 exclusiveBase, uint64 exclusiveUntil`
  (EIP-712 type updated). `FillInstruction` gains `CounterLeg[] makerCounterSet, takerCounterSet`
  (`CounterLeg{bytes32 orderHash, uint256 maxBase}`; `counterSetHash = keccak256(abi.encode(legs))`).
- If an order's `counterSetHash` is non-zero, then while `block.timestamp < exclusiveUntil`
  a fill must supply the counter set matching the hash. A named counterparty fills at exactly
  its price, up to its leg's `maxBase` in total. Anyone else is rejected until the reserved part
  (`exclusiveBase`) has filled. Fills with anyone else never exceed `baseAmount - exclusiveBase`,
  so an unfilled reserved part is void after the window. Errors: `CounterSetMismatch`,
  `CounterpartyNotAllowed`, `InvalidPrice`, `CounterLegExceeded`, `ReservedPartVoid`.
  (Final semantics after the review rounds below.)
- Closes two holes: an observer pairing a public taker order with their own order at the
  taker's limit, and anyone publishing an honest pairing at a worse-than-quoted price
  (fills are unsigned, and the contract previously accepted any price between both limits).
- Orders publish the list as `payload.counterSet`; `validateOrderObject` checks it against the
  signed hash. The executor passes both sets to the contract.

## Independent review, rounds 1–4 (all fixed; PoC tests in Covenant's e2e suite)

Round 1
- **Fill-nonce griefing (High):** replay protection is keyed on every field of the
  fill (`fillKey`), not the nonce alone, so reusing a published fill's nonce can't burn it.
- **Receipts are checked against the `SpotTradeSettled` event:** fill key, nonce, both
  order hashes, price, base, quote, fee. A receipt for another trade can't complete a fill.
- **Counter sets are legs** `{orderHash, maxBase}`: the executor can't choose how a
  taker's reserved part is split across the orders it matched.
- **Executor fee is capped pro-rata** to the fill's share of the authorization, so a dust
  fill can't take a whole fee budget. The check is written so an unlimited cap can't overflow.
- **Balance-delta checks** (`ReceivedLessThanSigned`): if a token ever charges a transfer
  fee, the trade reverts instead of shortchanging anyone. This also makes self-trades revert.
- Zero-quote fills are rejected. The native-ETH payout is gas-capped (50k) with a WETH
  fallback, and the domain separator is recomputed if the chain id changes.

Round 2
- **Clone credit:** a cloned fill plus a copied receipt is credited once per on-chain fill key.
- **Reserved parts:** fills with anyone but the named counterparties are capped at
  `baseAmount - exclusiveBase`. An unfilled reserved part is void after the window
  (`ReservedPartVoid`) and the rest of the order keeps working.
- **Forced WETH fallback:** an executor can't force it with a tight gas limit
  (`NotEnoughGasForPayout`).

Round 3
- **Duplicate legs:** orders that name the same counterparty twice are rejected
  (`ORDER_COUNTER_SET_DUPLICATE`).
- **Per-order totals by EIP-712 hash:** the evaluator keys these by the order's EIP-712
  hash, so republished copies of an order object share one total.

Round 4
- **Fills clamp to what fits.** The contract settles `min(fill, what's left of both
  orders, the named leg's room or the unreserved part)` and scales the fee pro-rata,
  rounded down. It reverts with the specific reason only when nothing fits. Fill sizes are
  unsigned, so this grants nothing new. It means a third party settling a sliver first
  can't make an honest fill revert and let the reserved part go void.
- **Named legs fill partially,** cumulatively up to `maxBase`.
- **Receipts claim the amounts in the event** (what actually moved). The evaluator
  credits the receipt's `baseAmount`, and "overfilled" now means a side has nothing left.
