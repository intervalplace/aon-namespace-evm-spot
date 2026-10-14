// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IWETH {
    function withdraw(uint256 amount) external;
    function deposit() external payable;
    function transfer(address to, uint256 amount) external returns (bool);
}

interface IBalance {
    function balanceOf(address account) external view returns (uint256);
}

contract AonEvmSpotSettlement {
    bytes32 public constant AUTH_TYPEHASH = keccak256(
        "TradingSessionAuthorization(address grantor,address settlementContract,address baseToken,address quoteToken,bytes32 marketId,uint8 sideMask,uint256 maxBaseExposure,uint256 maxQuoteExposure,uint256 maxExecutorFeeQuote,uint256 minPrice,uint256 maxPrice,uint64 validAfter,uint64 validBefore,bytes32 authNonce)"
    );

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "SignedOrder(address trader,bytes32 marketId,uint8 side,uint256 price,uint256 baseAmount,bytes32 orderNonce,bytes32 sessionAuthHash,uint64 validAfter,uint64 validBefore,bool receiveNative,bytes32 counterSetHash,uint256 exclusiveBase,uint64 exclusiveUntil)"
    );

    bytes32 private immutable CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable CACHED_CHAIN_ID;

    /// Wrapped native token (WETH on Ethereum). A buy order with
    /// receiveNative = true in a market whose base token is this address is
    /// paid out in native ETH. address(0) disables native payouts.
    address public immutable WRAPPED_NATIVE;

    uint256 private _lock = 1;

    uint8 public constant SIDE_SELL_BASE = 0;
    uint8 public constant SIDE_BUY_BASE = 1;

    mapping(bytes32 => bool) public revokedAuth;
    mapping(bytes32 => bool) public cancelledOrder;
    // Replay protection is keyed on every field of the fill, so reusing a
    // published fill's nonce (even with the same orders but another size or
    // price) is a different fill and can't burn the original.
    // fillKey = keccak256(abi.encode(fillNonce, makerOrderHash, takerOrderHash,
    //                                price, baseAmount, quoteAmount, executorFeeQuoteAmount))
    // over the fill as submitted. If less fits, the fill settles what fits
    // (SpotTradeSettled carries the amounts that actually moved) and its key
    // is used up either way.
    mapping(bytes32 => bool) public usedFill;

    // Bound orders: base filled against named counterparties (the reserved
    // part), per counterparty and in total
    mapping(bytes32 => mapping(bytes32 => uint256)) public filledWithCounterparty;
    mapping(bytes32 => uint256) public boundFilledBase;

    // Gas forwarded to a buyer receiving native ETH; above that, they get WETH
    uint256 public constant NATIVE_SEND_GAS = 50_000;

    mapping(bytes32 => uint256) public usedBaseByAuth;
    mapping(bytes32 => uint256) public usedQuoteByAuth;
    mapping(bytes32 => uint256) public usedExecutorFeeQuoteByAuth;
    mapping(bytes32 => uint256) public filledBaseByOrder;

    struct TradingSessionAuthorization {
        address grantor;
        address settlementContract;
        address baseToken;
        address quoteToken;
        bytes32 marketId;
        uint8 sideMask;
        uint256 maxBaseExposure;
        uint256 maxQuoteExposure;
        uint256 maxExecutorFeeQuote;
        uint256 minPrice;
        uint256 maxPrice;
        uint64 validAfter;
        uint64 validBefore;
        bytes32 authNonce;
    }

    struct SignedOrder {
        address trader;
        bytes32 marketId;
        uint8 side;
        uint256 price;
        uint256 baseAmount;
        bytes32 orderNonce;
        bytes32 sessionAuthHash;
        uint64 validAfter;
        uint64 validBefore;
        // Buy orders only: receive the base token as native ETH (base must be
        // WRAPPED_NATIVE). Signed, so no one else can choose it for the buyer.
        bool receiveNative;
        // Front-running protection for the part of an order that fills
        // immediately (the reserved part, exclusiveBase). Until exclusiveUntil,
        // the reserved part may only fill against the legs in the counter set:
        // up to each leg's maxBase in total, at exactly that counterparty's
        // price. Nobody else may trade with the order until the
        // reserved part has filled. Fills with anyone else never exceed
        // baseAmount - exclusiveBase, so after the window the unfilled reserved
        // part is simply void and the rest rests as a normal limit order.
        // counterSetHash = keccak256(abi.encode(legs)). Zero = unbound.
        bytes32 counterSetHash;
        uint256 exclusiveBase;
        uint64 exclusiveUntil;
    }

    struct FillInstruction {
        bytes32 makerOrderHash;
        bytes32 takerOrderHash;
        bytes32 makerAuthHash;
        bytes32 takerAuthHash;
        uint256 price;
        uint256 baseAmount;
        uint256 quoteAmount;
        uint256 executorFeeQuoteAmount;
        bytes32 fillNonce;
        // The published counter sets of the two orders (empty if unbound)
        CounterLeg[] makerCounterSet;
        CounterLeg[] takerCounterSet;
    }

    // One named counterparty of a bound order: its EIP-712 order hash and the
    // most base this order may fill against it while the binding is active.
    struct CounterLeg {
        bytes32 orderHash;
        uint256 maxBase;
    }

    event SpotTradeSettled(
        bytes32 indexed fillKey,
        bytes32 indexed makerOrderHash,
        bytes32 indexed takerOrderHash,
        bytes32 fillNonce,
        bytes32 makerAuthHash,
        bytes32 takerAuthHash,
        address maker,
        address taker,
        address seller,
        address buyer,
        address executor,
        address baseToken,
        address quoteToken,
        uint256 price,
        uint256 baseAmount,
        uint256 quoteAmount,
        uint256 executorFeeQuoteAmount
    );

    event AuthorizationRevoked(bytes32 indexed authHash, address indexed grantor);
    event OrderCancelled(bytes32 indexed orderHash, address indexed trader);
    event AuthorizationConsumed(bytes32 indexed authHash, uint256 usedBase, uint256 usedQuote, uint256 usedFee);
    event OrderFilled(bytes32 indexed orderHash, uint256 fillBase, uint256 cumulativeFilledBase);
    event NativePayoutFellBackToWeth(address indexed buyer, uint256 amount);

    error BadSignature();
    error InvalidSettlementContract();
    error AuthorizationRevokedError(bytes32 authHash);
    error OrderCancelledError(bytes32 orderHash);
    error AuthorizationExpired(bytes32 authHash);
    error OrderExpired(bytes32 orderHash);
    error InvalidMarket();
    error InvalidSide();
    error InvalidPrice();
    error AuthExposureExceeded(bytes32 authHash);
    error OrderAmountExceeded(bytes32 orderHash);
    error FillReplay(bytes32 fillNonce);
    error TransferFailed();
    error NativePayoutNotAllowed();
    error NativeTransferFailed();
    error Reentrancy();
    error ZeroAmount();
    error CounterpartyNotAllowed(bytes32 orderHash);
    error CounterSetMismatch(bytes32 orderHash);
    error ReservedPartVoid(bytes32 orderHash);
    error NotEnoughGasForPayout();
    error CounterLegExceeded(bytes32 orderHash);
    error ExecutorFeeTooHigh(bytes32 authHash);
    error ReceivedLessThanSigned(address token, address recipient);

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address wrappedNative) {
        WRAPPED_NATIVE = wrappedNative;
        CACHED_CHAIN_ID = block.chainid;
        CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
    }

    // Recomputed if the chain id ever changes (a fork), so signatures for one
    // chain can't be replayed on the other.
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("AON EVM Spot")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _domainSeparator() private view returns (bytes32) {
        return block.chainid == CACHED_CHAIN_ID ? CACHED_DOMAIN_SEPARATOR : _buildDomainSeparator();
    }

    /// Only accepts ETH from the wrapped-native contract while unwrapping.
    receive() external payable {
        if (msg.sender != WRAPPED_NATIVE) revert NativeTransferFailed();
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparator();
    }

    function hashTradingSessionAuthorization(
        TradingSessionAuthorization memory auth
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                AUTH_TYPEHASH,
                auth.grantor,
                auth.settlementContract,
                auth.baseToken,
                auth.quoteToken,
                auth.marketId,
                auth.sideMask,
                auth.maxBaseExposure,
                auth.maxQuoteExposure,
                auth.maxExecutorFeeQuote,
                auth.minPrice,
                auth.maxPrice,
                auth.validAfter,
                auth.validBefore,
                auth.authNonce
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function hashSignedOrder(
        SignedOrder memory order
    ) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                ORDER_TYPEHASH,
                order.trader,
                order.marketId,
                order.side,
                order.price,
                order.baseAmount,
                order.orderNonce,
                order.sessionAuthHash,
                order.validAfter,
                order.validBefore,
                order.receiveNative,
                order.counterSetHash,
                order.exclusiveBase,
                order.exclusiveUntil
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function revokeAuthorization(TradingSessionAuthorization calldata auth) external {
        if (msg.sender != auth.grantor) revert BadSignature();

        bytes32 authHash = hashTradingSessionAuthorization(auth);
        revokedAuth[authHash] = true;

        emit AuthorizationRevoked(authHash, msg.sender);
    }

    function cancelOrder(SignedOrder calldata order) external {
        if (msg.sender != order.trader) revert BadSignature();

        bytes32 orderHash = hashSignedOrder(order);
        cancelledOrder[orderHash] = true;

        emit OrderCancelled(orderHash, msg.sender);
    }

    function settleSpotTrade(
        TradingSessionAuthorization calldata makerAuth,
        bytes calldata makerAuthSig,
        SignedOrder calldata makerOrder,
        bytes calldata makerOrderSig,
        TradingSessionAuthorization calldata takerAuth,
        bytes calldata takerAuthSig,
        SignedOrder calldata takerOrder,
        bytes calldata takerOrderSig,
        FillInstruction calldata fill
    ) external nonReentrant {
        if (fill.baseAmount == 0) revert ZeroAmount();

        bytes32 makerAuthHash = hashTradingSessionAuthorization(makerAuth);
        bytes32 takerAuthHash = hashTradingSessionAuthorization(takerAuth);
        bytes32 makerOrderHash = hashSignedOrder(makerOrder);
        bytes32 takerOrderHash = hashSignedOrder(takerOrder);

        if (fill.makerAuthHash != makerAuthHash) revert InvalidMarket();
        if (fill.takerAuthHash != takerAuthHash) revert InvalidMarket();
        if (fill.makerOrderHash != makerOrderHash) revert InvalidMarket();
        if (fill.takerOrderHash != takerOrderHash) revert InvalidMarket();
        bytes32 fillKey = keccak256(abi.encode(
            fill.fillNonce, makerOrderHash, takerOrderHash,
            fill.price, fill.baseAmount, fill.quoteAmount, fill.executorFeeQuoteAmount
        ));
        if (usedFill[fillKey]) revert FillReplay(fill.fillNonce);
        if (fill.quoteAmount == 0) revert ZeroAmount();

        _verifyAuth(makerAuth, makerAuthSig, makerAuthHash);
        _verifyAuth(takerAuth, takerAuthSig, takerAuthHash);

        _verifyOrder(makerOrder, makerOrderSig, makerOrderHash, makerAuthHash, makerAuth);
        _verifyOrder(takerOrder, takerOrderSig, takerOrderHash, takerAuthHash, takerAuth);

        _verifyFill(makerAuth, makerOrder, takerAuth, takerOrder, fill);

        // Settle as much of the fill as still fits: what's left of both orders
        // and, for bound orders, of the named leg or the unreserved part.
        // Fill sizes aren't signed by anyone, so clamping grants nothing new;
        // it means someone settling a sliver first can't make the rest revert.
        // If nothing fits, revert with the reason.
        uint256 base = fill.baseAmount;
        base = _min(base, _bindingRoom(makerOrder, makerOrderHash, takerOrderHash, takerOrder.price, fill.makerCounterSet, fill.price));
        base = _min(base, _bindingRoom(takerOrder, takerOrderHash, makerOrderHash, makerOrder.price, fill.takerCounterSet, fill.price));
        base = _min(base, _orderRoom(makerOrder, makerOrderHash));
        base = _min(base, _orderRoom(takerOrder, takerOrderHash));

        uint256 quote = (base * fill.price) / 1e18;
        if (quote == 0) revert ZeroAmount();
        // The executor fee scales down with the fill (rounded down)
        uint256 fee = base == fill.baseAmount
            ? fill.executorFeeQuoteAmount
            : (fill.executorFeeQuoteAmount * base) / fill.baseAmount;

        usedFill[fillKey] = true;

        _recordBinding(makerOrder, makerOrderHash, takerOrderHash, fill.makerCounterSet, base);
        _recordBinding(takerOrder, takerOrderHash, makerOrderHash, fill.takerCounterSet, base);
        filledBaseByOrder[makerOrderHash] += base;
        filledBaseByOrder[takerOrderHash] += base;

        _consumeExposure(makerAuthHash, makerAuth, makerOrder, base, quote, fee);
        _consumeExposure(takerAuthHash, takerAuth, takerOrder, base, quote, fee);

        address seller;
        address buyer;

        if (makerOrder.side == SIDE_SELL_BASE && takerOrder.side == SIDE_BUY_BASE) {
            seller = makerAuth.grantor;
            buyer = takerAuth.grantor;
        } else if (makerOrder.side == SIDE_BUY_BASE && takerOrder.side == SIDE_SELL_BASE) {
            seller = takerAuth.grantor;
            buyer = makerAuth.grantor;
        } else {
            revert InvalidSide();
        }

        bool payNative = (makerOrder.side == SIDE_BUY_BASE ? makerOrder : takerOrder).receiveNative;

        // Quote legs first; the native payout (an external call to the buyer)
        // goes last, after every state change and token transfer.
        // The seller must actually receive the full quote amount they signed
        // for (e.g. if the quote token ever charges a transfer fee).
        uint256 sellerQuoteBefore = IBalance(makerAuth.quoteToken).balanceOf(seller);
        _safeTransferFrom(makerAuth.quoteToken, buyer, seller, quote);
        if (IBalance(makerAuth.quoteToken).balanceOf(seller) < sellerQuoteBefore + quote) {
            revert ReceivedLessThanSigned(makerAuth.quoteToken, seller);
        }

        if (fee > 0) {
            _safeTransferFrom(
                makerAuth.quoteToken,
                buyer,
                msg.sender,
                fee
            );
        }

        if (payNative) {
            uint256 heldBefore = IBalance(WRAPPED_NATIVE).balanceOf(address(this));
            _safeTransferFrom(makerAuth.baseToken, seller, address(this), base);
            if (IBalance(WRAPPED_NATIVE).balanceOf(address(this)) < heldBefore + base) {
                revert ReceivedLessThanSigned(WRAPPED_NATIVE, address(this));
            }
            IWETH(WRAPPED_NATIVE).withdraw(base);
            // Make sure the buyer's call really gets NATIVE_SEND_GAS (the 63/64
            // rule), so an executor can't force the WETH fallback with a tight limit.
            if (gasleft() < (NATIVE_SEND_GAS * 64) / 63 + 10_000) revert NotEnoughGasForPayout();
            // Gas-capped so a buyer's wallet can't burn the executor's gas; if
            // the wallet won't take ETH, the buyer gets WETH instead.
            (bool sent, ) = buyer.call{value: base, gas: NATIVE_SEND_GAS}("");
            if (!sent) {
                IWETH(WRAPPED_NATIVE).deposit{value: base}();
                if (!IWETH(WRAPPED_NATIVE).transfer(buyer, base)) revert NativeTransferFailed();
                emit NativePayoutFellBackToWeth(buyer, base);
            }
        } else {
            uint256 buyerBaseBefore = IBalance(makerAuth.baseToken).balanceOf(buyer);
            _safeTransferFrom(makerAuth.baseToken, seller, buyer, base);
            if (IBalance(makerAuth.baseToken).balanceOf(buyer) < buyerBaseBefore + base) {
                revert ReceivedLessThanSigned(makerAuth.baseToken, buyer);
            }
        }

        emit OrderFilled(makerOrderHash, base, filledBaseByOrder[makerOrderHash]);
        emit OrderFilled(takerOrderHash, base, filledBaseByOrder[takerOrderHash]);

        emit SpotTradeSettled(
            fillKey,
            makerOrderHash,
            takerOrderHash,
            fill.fillNonce,
            makerAuthHash,
            takerAuthHash,
            makerAuth.grantor,
            takerAuth.grantor,
            seller,
            buyer,
            msg.sender,
            makerAuth.baseToken,
            makerAuth.quoteToken,
            fill.price,
            base,
            quote,
            fee
        );
    }

    function _verifyAuth(
        TradingSessionAuthorization calldata auth,
        bytes calldata sig,
        bytes32 authHash
    ) internal view {
        if (auth.settlementContract != address(this)) revert InvalidSettlementContract();
        if (revokedAuth[authHash]) revert AuthorizationRevokedError(authHash);

        if (block.timestamp < auth.validAfter || block.timestamp > auth.validBefore) {
            revert AuthorizationExpired(authHash);
        }

        if (_recover(authHash, sig) != auth.grantor) revert BadSignature();
    }

    function _verifyOrder(
        SignedOrder calldata order,
        bytes calldata sig,
        bytes32 orderHash,
        bytes32 authHash,
        TradingSessionAuthorization calldata auth
    ) internal view {
        if (order.trader != auth.grantor) revert BadSignature();
        if (order.marketId != auth.marketId) revert InvalidMarket();
        if (order.sessionAuthHash != authHash) revert InvalidMarket();
        if (cancelledOrder[orderHash]) revert OrderCancelledError(orderHash);

        if (order.receiveNative) {
            if (order.side != SIDE_BUY_BASE) revert NativePayoutNotAllowed();
            if (WRAPPED_NATIVE == address(0) || auth.baseToken != WRAPPED_NATIVE) revert NativePayoutNotAllowed();
        }

        if (block.timestamp < order.validAfter || block.timestamp > order.validBefore) {
            revert OrderExpired(orderHash);
        }

        if (_recover(orderHash, sig) != order.trader) revert BadSignature();
    }

    // How much of a fill a bound order can take from this counterparty right
    // now. Reverts when the answer is nothing (or the fill breaks the binding).
    function _bindingRoom(
        SignedOrder calldata order,
        bytes32 orderHash,
        bytes32 counterHash,
        uint256 counterPrice,
        CounterLeg[] calldata legs,
        uint256 fillPrice
    ) internal view returns (uint256) {
        if (order.counterSetHash == bytes32(0)) return type(uint256).max;

        if (block.timestamp < order.exclusiveUntil) {
            if (keccak256(abi.encode(legs)) != order.counterSetHash) revert CounterSetMismatch(orderHash);
            for (uint256 i = 0; i < legs.length; i++) {
                if (legs[i].orderHash != counterHash) continue;
                // A named leg: at exactly its price, up to its signed amount in total
                if (fillPrice != counterPrice) revert InvalidPrice();
                uint256 used = filledWithCounterparty[orderHash][counterHash];
                if (used >= legs[i].maxBase) revert CounterLegExceeded(orderHash);
                return legs[i].maxBase - used;
            }
            // Not a named leg: nobody else trades with it until the reserved part is done
            if (boundFilledBase[orderHash] < order.exclusiveBase) revert CounterpartyNotAllowed(orderHash);
        }

        // Fills with anyone else are limited to the unreserved part
        uint256 unbound = filledBaseByOrder[orderHash] - boundFilledBase[orderHash];
        uint256 cap = order.baseAmount - order.exclusiveBase;
        if (unbound >= cap) revert ReservedPartVoid(orderHash);
        return cap - unbound;
    }

    function _recordBinding(
        SignedOrder calldata order,
        bytes32 orderHash,
        bytes32 counterHash,
        CounterLeg[] calldata legs,
        uint256 base
    ) internal {
        if (order.counterSetHash == bytes32(0) || block.timestamp >= order.exclusiveUntil) return;
        for (uint256 i = 0; i < legs.length; i++) {
            if (legs[i].orderHash != counterHash) continue;
            filledWithCounterparty[orderHash][counterHash] += base;
            boundFilledBase[orderHash] += base;
            return;
        }
    }

    function _orderRoom(SignedOrder calldata order, bytes32 orderHash) internal view returns (uint256) {
        uint256 filled = filledBaseByOrder[orderHash];
        if (filled >= order.baseAmount) revert OrderAmountExceeded(orderHash);
        return order.baseAmount - filled;
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _verifyFill(
        TradingSessionAuthorization calldata makerAuth,
        SignedOrder calldata makerOrder,
        TradingSessionAuthorization calldata takerAuth,
        SignedOrder calldata takerOrder,
        FillInstruction calldata fill
    ) internal pure {
        if (makerAuth.marketId != takerAuth.marketId) revert InvalidMarket();
        if (makerAuth.baseToken != takerAuth.baseToken) revert InvalidMarket();
        if (makerAuth.quoteToken != takerAuth.quoteToken) revert InvalidMarket();

        if (makerOrder.marketId != takerOrder.marketId) revert InvalidMarket();
        if (makerOrder.marketId != makerAuth.marketId) revert InvalidMarket();

        if (makerOrder.side == takerOrder.side) revert InvalidSide();

        if (!_sideAllowed(makerAuth.sideMask, makerOrder.side)) revert InvalidSide();
        if (!_sideAllowed(takerAuth.sideMask, takerOrder.side)) revert InvalidSide();

        if (makerOrder.side == SIDE_SELL_BASE && takerOrder.side == SIDE_BUY_BASE) {
            if (fill.price < makerOrder.price) revert InvalidPrice();
            if (fill.price > takerOrder.price) revert InvalidPrice();
        } else if (makerOrder.side == SIDE_BUY_BASE && takerOrder.side == SIDE_SELL_BASE) {
            if (fill.price > makerOrder.price) revert InvalidPrice();
            if (fill.price < takerOrder.price) revert InvalidPrice();
        } else {
            revert InvalidSide();
        }

        if (fill.price < makerAuth.minPrice || fill.price > makerAuth.maxPrice) {
            revert InvalidPrice();
        }

        if (fill.price < takerAuth.minPrice || fill.price > takerAuth.maxPrice) {
            revert InvalidPrice();
        }

        // NOTE: Price is expressed as quote-per-base scaled by 1e18.
        // This assumes the base token uses 18 decimal places.
        // Tokens with non-18 decimals (e.g. USDC with 6) require a different
        // price scaling — do not use this contract with such tokens as base.
        if ((fill.baseAmount * fill.price) / 1e18 != fill.quoteAmount) {
            revert InvalidPrice();
        }
    }

    function _consumeExposure(
        bytes32 authHash,
        TradingSessionAuthorization calldata auth,
        SignedOrder calldata order,
        uint256 base,
        uint256 quote,
        uint256 fee
    ) internal {
        if (order.side == SIDE_SELL_BASE) {
            uint256 nextBase = usedBaseByAuth[authHash] + base;
            if (nextBase > auth.maxBaseExposure) revert AuthExposureExceeded(authHash);

            usedBaseByAuth[authHash] = nextBase;
        } else if (order.side == SIDE_BUY_BASE) {
            uint256 nextQuote = usedQuoteByAuth[authHash] + quote;
            uint256 nextFee = usedExecutorFeeQuoteByAuth[authHash] + fee;

            if (nextQuote > auth.maxQuoteExposure) revert AuthExposureExceeded(authHash);
            if (nextFee > auth.maxExecutorFeeQuote) revert AuthExposureExceeded(authHash);
            // The fee is capped in proportion to this fill's share of everything
            // the authorization may spend, so a small fill can only carry a small
            // fee. Written as a division so an "unlimited" cap can't overflow.
            if (fee > 0) {
                if (auth.maxQuoteExposure == 0) revert ExecutorFeeTooHigh(authHash);
                uint256 allowed = auth.maxExecutorFeeQuote > type(uint256).max / quote
                    ? type(uint256).max
                    : (auth.maxExecutorFeeQuote * quote) / auth.maxQuoteExposure;
                if (fee > allowed) revert ExecutorFeeTooHigh(authHash);
            }

            usedQuoteByAuth[authHash] = nextQuote;
            usedExecutorFeeQuoteByAuth[authHash] = nextFee;
        } else {
            revert InvalidSide();
        }

        emit AuthorizationConsumed(
            authHash,
            usedBaseByAuth[authHash],
            usedQuoteByAuth[authHash],
            usedExecutorFeeQuoteByAuth[authHash]
        );
    }

    function _sideAllowed(uint8 sideMask, uint8 side) internal pure returns (bool) {
        if (side == SIDE_BUY_BASE) return (sideMask & 1) != 0;
        if (side == SIDE_SELL_BASE) return (sideMask & 2) != 0;
        return false;
    }

    function _safeTransferFrom(
        address token,
        address from,
        address to,
        uint256 amount
    ) internal {
        // A call to an address with no code "succeeds" with empty return data
        if (token.code.length == 0) revert TransferFailed();

        (bool ok, bytes memory data) = token.call(
            abi.encodeWithSelector(
                bytes4(keccak256("transferFrom(address,address,uint256)")),
                from,
                to,
                amount
            )
        );

        if (!ok) revert TransferFailed();

        if (data.length > 0 && !abi.decode(data, (bool))) {
            revert TransferFailed();
        }
    }

    // Secp256k1 half-order — s must be in the lower half to prevent malleability
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function _recover(bytes32 digest, bytes calldata sig) internal pure returns (address) {
        if (sig.length != 65) revert BadSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;

        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }

        if (v < 27) v += 27;
        if (v != 27 && v != 28) revert BadSignature();
        // Reject upper-half s values (EIP-2 / OpenZeppelin ECDSA practice)
        if (uint256(s) > SECP256K1_HALF_ORDER) revert BadSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();

        return signer;
    }
}
