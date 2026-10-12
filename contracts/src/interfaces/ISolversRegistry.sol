// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {AgentStatus, SaleKind} from "../SolversTypes.sol";

/// @notice What a satellite needs to settle an authorized sale (one Registry call per purchase).
struct SaleAuth {
    address creator;
    address treasury;
    address token;
    uint96 price;
    uint96 pricePerUse;
    uint16 feeBps;
    uint96 minPrice;
    uint32 agentIndex;
}

/// @notice Arguments of `registerAgent` (one struct keeps the ABI readable and the stack shallow).
struct AgentRegistration {
    bytes32 agentId;
    string metadataUri;
    string version;
    bytes32 versionHash;
    uint96 price;
    uint96 pricePerUse;
    uint16 royaltyBps;
}

/// @notice Read model of an agent (Solver) returned by `getAgent`.
struct AgentView {
    bytes32 agentId;
    address creator;
    AgentStatus status;
    uint16 royaltyBps;
    uint32 totalSales;
    uint32 maxSupply;
    uint96 price;
    uint96 pricePerUse;
    uint32 disputesLost;
    uint32 index;
    uint96 stake;
    uint40 registeredAt;
    uint40 versionAt;
    bytes32 versionHash;
    string version;
    string metadataUri;
}

/// @notice A version-scoped evaluation (D6). `at == 0` means "not measured".
struct Eval {
    uint16 scoreBps;
    uint40 at;
    address by;
    bytes32 evalHash;
}

/// @notice Buyer reputation counters.
struct Reputation {
    uint32 purchases;
    uint32 disputesOpened;
    uint32 disputesLost;
}

/// @dev Role checks go through `IAccessControl(registry).hasRole` (the Registry is an OZ AccessControl).
interface ISolversRegistry {
    // ---- satellite-only ----
    function authorizeSale(
        bytes32 agentId,
        address buyer,
        address payer,
        SaleKind kind,
        bytes32 purchaseId,
        bytes32 ref
    ) external returns (SaleAuth memory);
    function recordDisputeOpened(address buyer) external;
    function recordDisputeOutcome(bytes32 agentId, address buyer, bool refunded) external;
    function setStake(bytes32 agentId, uint96 stake) external;
    function setStatus(bytes32 agentId, AgentStatus status, address by) external;

    // ---- views used by satellites ----
    function token() external view returns (address);
    function treasury() external view returns (address);
    function pauseFlags() external view returns (uint8);
    function minStake() external view returns (uint96);
    function agentIdAt(uint32 index) external view returns (bytes32);
    function creatorOf(bytes32 agentId) external view returns (address);
    function stakeOf(bytes32 agentId) external view returns (uint96);
    function statusOf(bytes32 agentId) external view returns (AgentStatus);
    function agentExists(bytes32 agentId) external view returns (bool);
    function satellites()
        external
        view
        returns (address license, address credits, address reviews, address escrow, address staking);
    function royaltyParams(uint32 agentIndex)
        external
        view
        returns (address creator, uint16 creatorBps, address treasury, uint16 platformBps, uint8 pauseFlags);
}
