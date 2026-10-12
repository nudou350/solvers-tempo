// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {Eval} from "../src/interfaces/ISolversRegistry.sol";

/// @notice Fuzz of version-scoped evals (D6). Fee/royalty conservation, pay-per-use totals and milestone sums are
/// fuzzed in SolversMath.t.sol, LicenseRoyalty.t.sol, Credits.t.sol and EscrowStateMachine.t.sol.
contract FuzzTest is SolversTestBase {
    /// `currentEval` is measured iff an eval was set for the CURRENT version hash; older evals stay readable.
    function testFuzz_evalVersionPairs(bytes32 v1, bytes32 v2, uint16 s1, uint16 s2, bool evalNewVersion) public {
        vm.assume(v1 != v2 && v1 != VERSION_HASH && v2 != VERSION_HASH);
        s1 = uint16(bound(s1, 0, 10_000));
        s2 = uint16(bound(s2, 0, 10_000));
        _registerActive(creator, AGENT);
        (bool measured,) = registry.currentEval(AGENT);
        assertFalse(measured);

        vm.prank(creator);
        registry.updateVersion(AGENT, "1.1.0", v1);
        vm.prank(verifier);
        registry.setEval(AGENT, v1, s1, keccak256("e1"));
        Eval memory e;
        (measured, e) = registry.currentEval(AGENT);
        assertTrue(measured);
        assertEq(e.scoreBps, s1);

        vm.prank(creator);
        registry.updateVersion(AGENT, "1.2.0", v2);
        (measured,) = registry.currentEval(AGENT);
        assertFalse(measured, "a new version is not measured until its own eval");
        assertEq(registry.evalOf(AGENT, v1).scoreBps, s1, "the previous eval is never zeroed");

        if (evalNewVersion) {
            vm.prank(verifier);
            registry.setEval(AGENT, v2, s2, keccak256("e2"));
            (measured, e) = registry.currentEval(AGENT);
            assertTrue(measured);
            assertEq(e.scoreBps, s2);
            assertEq(e.evalHash, keccak256("e2"));
        }
    }
}
