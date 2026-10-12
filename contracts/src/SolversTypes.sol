// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

// Shared constants, enums and errors of the Solvers contracts.
// Enums are append-only (they are stored in upgradeable storage).

/// @dev Basis-points denominator.
uint16 constant MAX_BPS = 10_000;
/// @dev Cap of the platform fee on primary sales and escrow releases (20%).
uint16 constant MAX_FEE_BPS = 2000;
/// @dev Cap of creator + platform transfer royalty (25% of the original price).
uint16 constant MAX_TOTAL_ROYALTY_BPS = 2500;
uint256 constant MAX_MILESTONES = 5;
uint256 constant MAX_URI_LEN = 200;
uint256 constant MAX_VERSION_LEN = 16;
/// @dev TIP-20 tokens always have 6 decimals.
uint8 constant TOKEN_DECIMALS = 6;

/// @dev Pause bits (Registry `pauseFlags`). ENTRIES: register/purchase/buyCredits/createEscrow. PAYMENTS:
/// releaseMilestone/resolveDispute. TRANSFERS: secondary license transfers (emergency, admin only by default).
uint8 constant PAUSE_ENTRIES = 1;
uint8 constant PAUSE_PAYMENTS = 2;
uint8 constant PAUSE_TRANSFERS = 4;
uint8 constant PAUSE_MASK = 7;

/// @dev Role ids (roles live only in SolversRegistry; satellites ask `registry.hasRole`).
bytes32 constant PLATFORM_ROLE = keccak256("PLATFORM_ROLE");
bytes32 constant VERIFIER_ROLE = keccak256("VERIFIER_ROLE");
bytes32 constant USAGE_ROLE = keccak256("USAGE_ROLE");
bytes32 constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");

enum AgentStatus {
    Pending,
    Active,
    Suspended,
    Retired
}

enum SaleKind {
    None,
    License,
    Credits,
    Escrow
}

enum MilestoneStatus {
    Pending,
    Passed,
    Approved,
    Disputed,
    Refunded
}

enum EscrowStatus {
    Active,
    Completed,
    Disputed,
    Refunded
}

// ---- errors shared by several contracts ----
error AgentNotFound(bytes32 agentId);
error NotCreator();
error InvalidAmount();
error ZeroAddress();
error Paused(uint8 flag);
error NotSatellite();
error PriceChanged(uint256 current);
error PriceTooLow();
error FeeOnTransferToken();
error NothingToClaim();
error RecipientBlocked(address recipient);
