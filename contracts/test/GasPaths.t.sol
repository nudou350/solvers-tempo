// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {console} from "forge-std/Test.sol";

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";

/// @notice Gas per user path under Tempo's schedule (forge runs with `tempo = true`: a new storage slot costs 250,000).
/// Each test measures one call and asserts a budget = measured + ~15% (2026-10-11); the breakdown by new slots,
/// including TIP-20 balance slots of first-time recipients that plan §4.9 did not count, is in
/// docs/migration/phase-2.md. A layout change that adds slots fails here. Run `forge test --match-contract GasPathsTest -vv` to print the table.
contract GasPathsTest is SolversTestBase {
    SolversEscrow.MilestoneInput[] internal five;

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
        for (uint256 i; i < 5; ++i) {
            five.push(SolversEscrow.MilestoneInput({amount: 2_000_000, criteriaHash: keccak256(abi.encode(i))}));
        }
    }

    function _report(string memory path, uint256 used, uint256 budget) internal view {
        console.log(path, used);
        if (vm.envOr("GAS_PRINT_ONLY", false)) return;
        require(used <= budget, string.concat(path, ": over the gas budget"));
    }

    function test_gas_registerAgent() public {
        vm.startPrank(creator2);
        usd.approve(address(staking), MIN_STAKE);
        uint256 g = gasleft();
        registry.registerAgent(_registration(AGENT2, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        _report("registerAgent (+stake pull)", g - gasleft(), 2_200_000);
        vm.stopPrank();
    }

    function test_gas_purchaseLicense_firstAndRepeat() public {
        vm.startPrank(buyer);
        usd.approve(address(license), 2 * PRICE);
        bytes32 p1 = _pid();
        uint256 g = gasleft();
        license.purchaseLicense(AGENT, PRICE, p1);
        _report("purchaseLicense, first purchase of a buyer", g - gasleft(), 2_200_000);
        bytes32 p2 = _pid();
        g = gasleft();
        license.purchaseLicense(AGENT, PRICE, p2);
        _report("purchaseLicense, repeat buyer", g - gasleft(), 1_050_000);
        vm.stopPrank();
    }

    function test_gas_buyCredits_firstAndRepeat() public {
        vm.startPrank(buyer);
        usd.approve(address(credits), 20 * PRICE_PER_USE);
        bytes32 p1 = _pid();
        uint256 g = gasleft();
        credits.buyCredits(AGENT, 5, 5 * PRICE_PER_USE, p1);
        _report("buyCredits, first", g - gasleft(), 1_300_000);
        bytes32 p2 = _pid();
        g = gasleft();
        credits.buyCredits(AGENT, 5, 5 * PRICE_PER_USE, p2);
        _report("buyCredits, repeat", g - gasleft(), 450_000);
        vm.stopPrank();
    }

    function test_gas_escrowLifecycle() public {
        vm.startPrank(buyer);
        usd.approve(address(escrow), 10_000_000);
        bytes32 p = _pid();
        uint256 g = gasleft();
        uint256 id = escrow.createEscrow(AGENT, five, 3600, 0, p);
        _report("createEscrow, 5 milestones", g - gasleft(), 5_100_000);
        vm.stopPrank();

        vm.prank(verifier);
        g = gasleft();
        escrow.markPassed(id, 0, keccak256("d"));
        _report("markPassed", g - gasleft(), 380_000);

        vm.prank(buyer);
        g = gasleft();
        escrow.releaseMilestone(id, 0);
        _report("releaseMilestone", g - gasleft(), 430_000);

        vm.prank(buyer);
        g = gasleft();
        escrow.openDispute(id, 1, keccak256("r"));
        _report("openDispute", g - gasleft(), 680_000);

        vm.prank(admin);
        g = gasleft();
        escrow.resolveDispute(id, 1, true);
        _report("resolveDispute (refund)", g - gasleft(), 150_000);
    }

    function test_gas_reviewAndTransfer() public {
        uint256 id = _buy(buyer, AGENT);
        vm.prank(buyer);
        uint256 g = gasleft();
        reviews.submitReview(AGENT, uint64(id), 5, keccak256("c"));
        _report("submitReview, first for the agent", g - gasleft(), 1_000_000);
        vm.prank(buyer);
        g = gasleft();
        reviews.submitReview(AGENT, uint64(id), 4, keccak256("c2"));
        _report("submitReview, edit", g - gasleft(), 120_000);

        vm.startPrank(buyer);
        usd.approve(address(license), 1_000_000);
        g = gasleft();
        license.transferWithRoyalty(buyer2, id, 1_000_000);
        _report("transferWithRoyalty, first token of the receiver", g - gasleft(), 450_000);
        vm.stopPrank();
    }
}
