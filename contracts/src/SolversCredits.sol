// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {SolversPayouts} from "./base/SolversPayouts.sol";
import {SaleAuth} from "./interfaces/ISolversRegistry.sol";
import {ISolversCredits} from "./interfaces/ISolversSatellites.sol";
import {SolversMath} from "./libraries/SolversMath.sol";
import {
    SaleKind,
    PLATFORM_ROLE,
    USAGE_ROLE,
    InvalidAmount,
    PriceChanged,
    PriceTooLow,
    AgentNotFound
} from "./SolversTypes.sol";

/// @title SolversCredits
/// @notice Pay-per-use credits per (agent, owner) and the verified-use counter.
contract SolversCredits is SolversPayouts, ISolversCredits {
    struct Credit {
        uint32 remaining;
        uint32 purchased;
    }

    /// @custom:storage-location erc7201:solvers.storage.Credits
    struct CreditsStorage {
        mapping(bytes32 agentId => mapping(address owner => Credit)) credits;
        mapping(bytes32 agentId => uint64) verifiedUses;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Credits")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant CREDITS_STORAGE = 0x7d365b5b898b6f9a4d740bf10c628a04e18fc25c9c09680f1b9e8dbf10573200;

    event CreditsBought(
        bytes32 indexed agentId,
        address indexed buyer,
        address payer,
        uint32 amount,
        uint256 total,
        uint256 fee,
        uint256 creatorAmount,
        bytes32 purchaseId,
        uint32 remaining,
        uint32 purchased,
        bool creatorDeferred,
        bool treasuryDeferred
    );
    event CreditsConsumed(
        bytes32 indexed agentId, address indexed owner, uint32 count, uint32 remaining, uint64 verifiedUses
    );
    event UsageRecorded(bytes32 indexed agentId, uint64 count, bytes32 merkleRoot, uint64 verifiedUses);

    error NoCredits(uint32 remaining);

    function initialize(address registry_) external initializer {
        __SolversSatellite_init(registry_);
    }

    /// @notice Buys `amount` credits for `msg.sender`; `maxTotal` protects against a price change.
    function buyCredits(bytes32 agentId, uint32 amount, uint256 maxTotal, bytes32 purchaseId) external nonReentrant {
        _buy(msg.sender, msg.sender, agentId, amount, maxTotal, purchaseId);
    }

    /// @notice Buys credits for `buyer`, paid by the platform float (PLATFORM_ROLE).
    function buyCreditsFor(address buyer, bytes32 agentId, uint32 amount, uint256 maxTotal, bytes32 purchaseId)
        external
        nonReentrant
        onlyRegistryRole(PLATFORM_ROLE)
    {
        _buy(buyer, msg.sender, agentId, amount, maxTotal, purchaseId);
    }

    /// @notice Single-call variant with an EIP-2612 permit for `maxTotal`.
    function buyCreditsWithPermit(
        bytes32 agentId,
        uint32 amount,
        uint256 maxTotal,
        bytes32 purchaseId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        try IERC20Permit(address(paymentToken())).permit(msg.sender, address(this), maxTotal, deadline, v, r, s) {}
            catch {}
        _buy(msg.sender, msg.sender, agentId, amount, maxTotal, purchaseId);
    }

    /// @notice Consumes `count` credits of `owner` (USAGE_ROLE, after a verified use).
    function consumeCredits(bytes32 agentId, address owner, uint32 count) external onlyRegistryRole(USAGE_ROLE) {
        if (count == 0) revert InvalidAmount();
        CreditsStorage storage $ = _creditsStorage();
        Credit storage c = $.credits[agentId][owner];
        if (c.remaining < count) revert NoCredits(c.remaining);
        c.remaining -= count;
        uint64 uses = $.verifiedUses[agentId] + count;
        $.verifiedUses[agentId] = uses;
        emit CreditsConsumed(agentId, owner, count, c.remaining, uses);
    }

    /// @notice Records a batch of verified uses (license holders) committed by a Merkle root (USAGE_ROLE).
    function recordUsageBatch(bytes32 agentId, uint64 count, bytes32 merkleRoot) external onlyRegistryRole(USAGE_ROLE) {
        if (count == 0) revert InvalidAmount();
        if (!registry().agentExists(agentId)) revert AgentNotFound(agentId);
        CreditsStorage storage $ = _creditsStorage();
        uint64 uses = $.verifiedUses[agentId] + count;
        $.verifiedUses[agentId] = uses;
        emit UsageRecorded(agentId, count, merkleRoot, uses);
    }

    function creditsOf(bytes32 agentId, address owner) external view returns (uint32 remaining, uint32 purchased) {
        Credit memory c = _creditsStorage().credits[agentId][owner];
        return (c.remaining, c.purchased);
    }

    function purchasedOf(bytes32 agentId, address owner) external view returns (uint32) {
        return _creditsStorage().credits[agentId][owner].purchased;
    }

    function verifiedUsesOf(bytes32 agentId) external view returns (uint64) {
        return _creditsStorage().verifiedUses[agentId];
    }

    function _buy(address buyer, address payer, bytes32 agentId, uint32 amount, uint256 maxTotal, bytes32 purchaseId)
        private
    {
        if (amount == 0) revert InvalidAmount();
        SaleAuth memory auth = registry()
            .authorizeSale(agentId, buyer, payer, SaleKind.Credits, purchaseId, bytes32(uint256(uint160(buyer))));
        uint256 total = uint256(auth.pricePerUse) * amount;
        if (total > maxTotal) revert PriceChanged(total);
        if (total < auth.minPrice) revert PriceTooLow();

        Credit storage c = _creditsStorage().credits[agentId][buyer];
        if (uint256(c.purchased) + amount > type(uint32).max) revert InvalidAmount();
        c.remaining += amount;
        c.purchased += amount;

        (uint256 fee, uint256 rest) = SolversMath.feeSplit(total, auth.feeBps);
        bool[2] memory deferred = [_pullTo(payer, auth.treasury, fee), _pullTo(payer, auth.creator, rest)];
        emit CreditsBought(
            agentId,
            buyer,
            payer,
            amount,
            total,
            fee,
            rest,
            purchaseId,
            c.remaining,
            c.purchased,
            deferred[1],
            deferred[0]
        );
    }

    function _creditsStorage() private pure returns (CreditsStorage storage $) {
        assembly {
            $.slot := CREDITS_STORAGE
        }
    }
}
