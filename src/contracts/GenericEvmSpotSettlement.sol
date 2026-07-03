// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract AonEvmSpotSettlement {
    bytes32 public constant AUTH_TYPEHASH = keccak256(
        "TradingSessionAuthorization(address grantor,address settlementContract,address baseToken,address quoteToken,bytes32 marketId,uint8 sideMask,uint256 maxBaseExposure,uint256 maxQuoteExposure,uint256 maxExecutorFeeQuote,uint256 minPrice,uint256 maxPrice,uint64 validAfter,uint64 validBefore,bytes32 authNonce)"
    );

    bytes32 public constant ORDER_TYPEHASH = keccak256(
        "SignedOrder(address trader,bytes32 marketId,uint8 side,uint256 price,uint256 baseAmount,bytes32 orderNonce,bytes32 sessionAuthHash,uint64 validAfter,uint64 validBefore)"
    );

    bytes32 private immutable DOMAIN_SEPARATOR;

    uint8 public constant SIDE_SELL_BASE = 0;
    uint8 public constant SIDE_BUY_BASE = 1;

    mapping(bytes32 => bool) public revokedAuth;
    mapping(bytes32 => bool) public cancelledOrder;
    mapping(bytes32 => bool) public usedFillNonce;

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
    }

    event SpotTradeSettled(
        bytes32 indexed fillNonce,
        bytes32 indexed makerOrderHash,
        bytes32 indexed takerOrderHash,
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

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("AON EVM Spot")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return DOMAIN_SEPARATOR;
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

        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
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
                order.validBefore
            )
        );

        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
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
    ) external {
        bytes32 makerAuthHash = hashTradingSessionAuthorization(makerAuth);
        bytes32 takerAuthHash = hashTradingSessionAuthorization(takerAuth);
        bytes32 makerOrderHash = hashSignedOrder(makerOrder);
        bytes32 takerOrderHash = hashSignedOrder(takerOrder);

        if (fill.makerAuthHash != makerAuthHash) revert InvalidMarket();
        if (fill.takerAuthHash != takerAuthHash) revert InvalidMarket();
        if (fill.makerOrderHash != makerOrderHash) revert InvalidMarket();
        if (fill.takerOrderHash != takerOrderHash) revert InvalidMarket();
        if (usedFillNonce[fill.fillNonce]) revert FillReplay(fill.fillNonce);

        _verifyAuth(makerAuth, makerAuthSig, makerAuthHash);
        _verifyAuth(takerAuth, takerAuthSig, takerAuthHash);

        _verifyOrder(makerOrder, makerOrderSig, makerOrderHash, makerAuthHash, makerAuth);
        _verifyOrder(takerOrder, takerOrderSig, takerOrderHash, takerAuthHash, takerAuth);

        _verifyFill(makerAuth, makerOrder, takerAuth, takerOrder, fill);

        if (filledBaseByOrder[makerOrderHash] + fill.baseAmount > makerOrder.baseAmount) {
            revert OrderAmountExceeded(makerOrderHash);
        }

        if (filledBaseByOrder[takerOrderHash] + fill.baseAmount > takerOrder.baseAmount) {
            revert OrderAmountExceeded(takerOrderHash);
        }

        usedFillNonce[fill.fillNonce] = true;

        filledBaseByOrder[makerOrderHash] += fill.baseAmount;
        filledBaseByOrder[takerOrderHash] += fill.baseAmount;

        _consumeExposure(makerAuthHash, makerAuth, makerOrder, fill);
        _consumeExposure(takerAuthHash, takerAuth, takerOrder, fill);

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

        _safeTransferFrom(makerAuth.baseToken, seller, buyer, fill.baseAmount);
        _safeTransferFrom(makerAuth.quoteToken, buyer, seller, fill.quoteAmount);

        if (fill.executorFeeQuoteAmount > 0) {
            _safeTransferFrom(
                makerAuth.quoteToken,
                buyer,
                msg.sender,
                fill.executorFeeQuoteAmount
            );
        }

        emit OrderFilled(makerOrderHash, fill.baseAmount, filledBaseByOrder[makerOrderHash]);
        emit OrderFilled(takerOrderHash, fill.baseAmount, filledBaseByOrder[takerOrderHash]);

        emit SpotTradeSettled(
            fill.fillNonce,
            makerOrderHash,
            takerOrderHash,
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
            fill.baseAmount,
            fill.quoteAmount,
            fill.executorFeeQuoteAmount
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

        if (block.timestamp < order.validAfter || block.timestamp > order.validBefore) {
            revert OrderExpired(orderHash);
        }

        if (_recover(orderHash, sig) != order.trader) revert BadSignature();
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
        FillInstruction calldata fill
    ) internal {
        if (order.side == SIDE_SELL_BASE) {
            uint256 nextBase = usedBaseByAuth[authHash] + fill.baseAmount;
            if (nextBase > auth.maxBaseExposure) revert AuthExposureExceeded(authHash);

            usedBaseByAuth[authHash] = nextBase;
        } else if (order.side == SIDE_BUY_BASE) {
            uint256 nextQuote = usedQuoteByAuth[authHash] + fill.quoteAmount;
            uint256 nextFee = usedExecutorFeeQuoteByAuth[authHash] + fill.executorFeeQuoteAmount;

            if (nextQuote > auth.maxQuoteExposure) revert AuthExposureExceeded(authHash);
            if (nextFee > auth.maxExecutorFeeQuote) revert AuthExposureExceeded(authHash);

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
