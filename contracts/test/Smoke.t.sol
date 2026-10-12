// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {MilestoneStatus, EscrowStatus} from "../src/SolversTypes.sol";

/// @notice End-to-end happy paths across the six contracts (detailed suites live in the per-contract files).
contract SmokeTest is SolversTestBase {
    function test_purchaseTransferReviewEscrow() public {
        _registerActive(creator, AGENT);
        assertEq(staking.totalStaked(), MIN_STAKE);

        uint256 creatorBefore = _bal(creator);
        uint256 treasuryBefore = _bal(treasury);
        uint256 tokenId = _buy(buyer, AGENT);
        assertEq(license.ownerOf(tokenId), buyer);
        assertEq(_bal(treasury) - treasuryBefore, 1_000_000); // 10% of 10 USD
        assertEq(_bal(creator) - creatorBefore, 9_000_000);

        // royalty transfer: 5% + 5% of the original price, paid by the owner
        vm.startPrank(buyer);
        usd.approve(address(license), 1_000_000);
        license.transferWithRoyalty(buyer2, tokenId, 1_000_000);
        vm.stopPrank();
        assertEq(license.ownerOf(tokenId), buyer2);
        assertEq(_bal(creator) - creatorBefore, 9_500_000);
        assertEq(_bal(treasury) - treasuryBefore, 1_500_000);

        // review by the new owner: the license was never used, so it binds now
        vm.prank(buyer2);
        reviews.submitReview(AGENT, uint64(tokenId), 5, keccak256("great"));
        (uint64 sum, uint32 count) = reviews.ratingOf(AGENT);
        assertEq(sum, 5);
        assertEq(count, 1);

        // escrow with two milestones
        SolversEscrow.MilestoneInput[] memory ms = new SolversEscrow.MilestoneInput[](2);
        ms[0] = SolversEscrow.MilestoneInput({amount: 3_000_000, criteriaHash: keccak256("m0")});
        ms[1] = SolversEscrow.MilestoneInput({amount: 4_000_000, criteriaHash: keccak256("m1")});
        vm.startPrank(buyer);
        usd.approve(address(escrow), 7_000_000);
        uint256 escrowId = escrow.createEscrow(AGENT, ms, 3600, 0, _pid());
        vm.stopPrank();
        assertEq(escrow.lockedBalance(), 7_000_000);

        vm.prank(verifier);
        escrow.markPassed(escrowId, 0, keccak256("deliverable"));
        vm.warp(block.timestamp + 3600);
        vm.prank(stranger);
        escrow.releaseMilestone(escrowId, 0);
        vm.prank(buyer);
        escrow.openDispute(escrowId, 1, keccak256("late"));
        vm.prank(admin);
        escrow.resolveDispute(escrowId, 1, true);
        assertEq(uint8(escrow.statusOf(escrowId)), uint8(EscrowStatus.Completed));
        assertEq(escrow.lockedBalance(), 0);
        assertEq(_bal(address(escrow)), 0);
    }
}
