// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {MAX_BPS, MAX_TOTAL_ROYALTY_BPS} from "../SolversTypes.sol";

/// @notice Money math shared by the Solvers contracts. Mirrored byte for byte by `packages/shared` (TypeScript).
library SolversMath {
    /// @notice Primary-sale / release split: `fee = amount * bps / 10_000` (floor), the remainder goes to the creator.
    function feeSplit(uint256 amount, uint16 feeBps) internal pure returns (uint256 fee, uint256 rest) {
        fee = amount * feeBps / MAX_BPS;
        rest = amount - fee;
    }

    /// @notice Transfer royalty on the original price. Each share is floored independently; dust stays with the payer.
    function royaltySplit(uint256 originalPrice, uint16 creatorBps, uint16 platformBps)
        internal
        pure
        returns (uint256 creatorAmount, uint256 platformAmount)
    {
        creatorAmount = originalPrice * creatorBps / MAX_BPS;
        platformAmount = originalPrice * platformBps / MAX_BPS;
    }

    /// @notice Platform royalty share after enforcing the 25% total cap against the creator share.
    function effectivePlatformBps(uint16 creatorBps, uint16 platformBps) internal pure returns (uint16) {
        if (creatorBps >= MAX_TOTAL_ROYALTY_BPS) return 0;
        uint16 room = MAX_TOTAL_ROYALTY_BPS - creatorBps;
        return platformBps > room ? room : platformBps;
    }
}
