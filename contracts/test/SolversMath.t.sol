// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";

import {SolversMath} from "../src/libraries/SolversMath.sol";
import {MAX_BPS, MAX_TOTAL_ROYALTY_BPS} from "../src/SolversTypes.sol";

/// @dev Exposes the internal library functions.
contract SolversMathHarness {
    function feeSplit(uint256 amount, uint16 bps) external pure returns (uint256, uint256) {
        return SolversMath.feeSplit(amount, bps);
    }

    function royaltySplit(uint256 price, uint16 creatorBps, uint16 platformBps)
        external
        pure
        returns (uint256, uint256)
    {
        return SolversMath.royaltySplit(price, creatorBps, platformBps);
    }

    function effectivePlatformBps(uint16 creatorBps, uint16 platformBps) external pure returns (uint16) {
        return SolversMath.effectivePlatformBps(creatorBps, platformBps);
    }
}

contract SolversMathTest is Test {
    SolversMathHarness internal m;

    function setUp() public {
        m = new SolversMathHarness();
    }

    // ---- vectors (Rust tests / plan §4.7) ----

    function test_feeSplit_vectors() public view {
        (uint256 fee, uint256 rest) = m.feeSplit(5_000_009, 1000);
        assertEq(fee, 500_000);
        assertEq(rest, 4_500_009);
        (fee, rest) = m.feeSplit(10_000_000, 1000);
        assertEq(fee, 1_000_000);
        assertEq(rest, 9_000_000);
        (fee, rest) = m.feeSplit(9, 1000); // floor to zero
        assertEq(fee, 0);
        assertEq(rest, 9);
        (fee, rest) = m.feeSplit(123, 0);
        assertEq(fee, 0);
        assertEq(rest, 123);
        (fee, rest) = m.feeSplit(0, 2000);
        assertEq(fee, 0);
        assertEq(rest, 0);
        (fee, rest) = m.feeSplit(777, MAX_BPS);
        assertEq(fee, 777);
        assertEq(rest, 0);
    }

    function test_royaltySplit_vectors() public view {
        (uint256 c, uint256 p) = m.royaltySplit(19, 500, 1000);
        assertEq(c, 0);
        assertEq(p, 1);
        (c, p) = m.royaltySplit(1_000_001, 333, 333);
        assertEq(c, 33_300);
        assertEq(p, 33_300);
        (c, p) = m.royaltySplit(10_000_000, 500, 500);
        assertEq(c, 500_000);
        assertEq(p, 500_000);
        assertEq(c + p, 1_000_000); // exact 5% + 5% sums to the charged amount
        (c, p) = m.royaltySplit(10_000_000, 0, 0);
        assertEq(c + p, 0);
    }

    function test_effectivePlatformBps_vectors() public view {
        // 100 @ 2000/1000 → creator 20, platform clamped to 500 bps → 5
        uint16 pb = m.effectivePlatformBps(2000, 1000);
        assertEq(pb, 500);
        (uint256 c, uint256 p) = m.royaltySplit(100, 2000, pb);
        assertEq(c, 20);
        assertEq(p, 5);

        assertEq(m.effectivePlatformBps(500, 500), 500);
        assertEq(m.effectivePlatformBps(0, 2500), 2500);
        assertEq(m.effectivePlatformBps(0, 3000), 2500);
        assertEq(m.effectivePlatformBps(2500, 1), 0);
        assertEq(m.effectivePlatformBps(2500, 0), 0);
        assertEq(m.effectivePlatformBps(type(uint16).max, 1000), 0);
        assertEq(m.effectivePlatformBps(2499, 1000), 1);
    }

    // ---- fuzz ----

    function testFuzz_feeSplit_conservationAndFloor(uint256 amount, uint16 bps) public view {
        amount = bound(amount, 0, type(uint96).max);
        bps = uint16(bound(bps, 0, MAX_BPS));
        (uint256 fee, uint256 rest) = m.feeSplit(amount, bps);
        assertEq(fee + rest, amount);
        assertEq(fee, amount * bps / 10_000);
        assertLe(fee, amount);
        // floor: fee is the largest integer with fee * 10000 <= amount * bps
        assertLe(fee * 10_000, amount * bps);
        assertGt((fee + 1) * 10_000, amount * bps);
    }

    function testFuzz_feeSplit_fullRange(uint256 amount, uint16 bps) public view {
        bps = uint16(bound(bps, 0, MAX_BPS));
        amount = bound(amount, 0, type(uint256).max / MAX_BPS);
        (uint256 fee, uint256 rest) = m.feeSplit(amount, bps);
        assertEq(fee + rest, amount);
    }

    function testFuzz_royaltySplit(uint96 price, uint16 creatorBps, uint16 platformBps) public view {
        creatorBps = uint16(bound(creatorBps, 0, MAX_TOTAL_ROYALTY_BPS));
        platformBps = uint16(bound(platformBps, 0, MAX_BPS));
        uint16 pb = m.effectivePlatformBps(creatorBps, platformBps);
        (uint256 c, uint256 p) = m.royaltySplit(price, creatorBps, pb);
        assertEq(c, uint256(price) * creatorBps / 10_000);
        assertEq(p, uint256(price) * pb / 10_000);
        // never above 25% of the original price; dust (< 2 units) stays with the payer
        assertLe(c + p, uint256(price) * MAX_TOTAL_ROYALTY_BPS / 10_000);
        uint256 exact = uint256(price) * (uint256(creatorBps) + pb);
        assertLe((c + p) * 10_000, exact);
        assertLt(exact - (c + p) * 10_000, 2 * 10_000);
    }

    function testFuzz_effectivePlatformBps(uint16 creatorBps, uint16 platformBps) public view {
        uint16 pb = m.effectivePlatformBps(creatorBps, platformBps);
        assertLe(pb, platformBps);
        if (creatorBps >= MAX_TOTAL_ROYALTY_BPS) {
            assertEq(pb, 0);
        } else {
            assertLe(uint256(creatorBps) + pb, MAX_TOTAL_ROYALTY_BPS);
            if (uint256(creatorBps) + platformBps <= MAX_TOTAL_ROYALTY_BPS) {
                assertEq(pb, platformBps);
            } else {
                assertEq(uint256(creatorBps) + pb, MAX_TOTAL_ROYALTY_BPS);
            }
        }
    }
}
