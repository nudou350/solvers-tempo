// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

/// @notice Cross-contract surface of the satellites (only what other Solvers contracts call).
interface ISolversStaking {
    /// @notice Pulls the registration stake from `creator` (Registry only). Returns the amount received.
    function pullStake(bytes32 agentId, address creator, uint96 amount) external returns (uint96 received);
}

interface ISolversLicense {
    /// @notice Binds `tokenId` to review `reviewId` on first use and returns the review id the license is bound to
    /// (Reviews only). Reverts unless `author` owns `tokenId` and the license belongs to `agentId`.
    function useForReview(uint256 tokenId, address author, bytes32 agentId, uint64 reviewId)
        external
        returns (uint64 boundReviewId);
}

interface ISolversCredits {
    function purchasedOf(bytes32 agentId, address owner) external view returns (uint32);
}

/// @notice TIP-403 receive policies (TIP-1028). Only the view used to avoid silent redirects is declared.
/// https://tempo.xyz/developers/docs/protocol/tip403/receive-policies
interface ITIP403ReceivePolicies {
    function validateReceivePolicy(address token, address sender, address receiver)
        external
        view
        returns (bool authorized, uint8 blockedReason);
}
