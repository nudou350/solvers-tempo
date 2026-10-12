// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {EscrowFixture} from "./Escrow.t.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {MilestoneStatus, EscrowStatus, PAUSE_PAYMENTS, Paused} from "../src/SolversTypes.sol";

/// @notice Table-driven milestone state machine, mirroring `programs/solvers/src/instructions/escrow.rs`.
/// Every (milestone status x action) pair is run from a fresh snapshot and must either succeed with the expected next
/// status or revert with the exact error the old program raised.
contract EscrowStateMachineTest is EscrowFixture {
    // ---- setups (milestone 0 of a 2-milestone escrow, all reached at T1) ----
    uint256 internal constant S_PENDING = 0;
    uint256 internal constant S_PASSED = 1;
    uint256 internal constant S_APPROVED = 2;
    uint256 internal constant S_DISPUTED = 3; // disputed while Pending (never passed)
    uint256 internal constant S_DISPUTED_PASSED = 4; // disputed after passing (passedAt kept)
    uint256 internal constant S_REFUNDED = 5;
    uint256 internal constant N_SETUPS = 6;

    uint256 internal constant T1 = T0 + 1 hours;
    uint256 internal constant SLA = 7 days;

    struct Outcome {
        bool ok;
        bytes err;
        MilestoneStatus next;
    }

    struct Action {
        string name;
        address actor;
        uint256 at; // timestamp of the call
        bytes data;
    }

    // =====================================================================================================
    // table plumbing
    // =====================================================================================================

    function _setupName(uint256 s) internal pure returns (string memory) {
        if (s == S_PENDING) return "Pending";
        if (s == S_PASSED) return "Passed";
        if (s == S_APPROVED) return "Approved";
        if (s == S_DISPUTED) return "Disputed";
        if (s == S_DISPUTED_PASSED) return "Disputed(after pass)";
        return "Refunded";
    }

    function _setupStatus(uint256 s) internal pure returns (MilestoneStatus) {
        if (s == S_PENDING) return MilestoneStatus.Pending;
        if (s == S_PASSED) return MilestoneStatus.Passed;
        if (s == S_APPROVED) return MilestoneStatus.Approved;
        if (s == S_DISPUTED || s == S_DISPUTED_PASSED) return MilestoneStatus.Disputed;
        return MilestoneStatus.Refunded;
    }

    /// @dev Creates the escrow at T0 and brings milestone 0 to the setup status at T1.
    function _setup(uint256 s) internal returns (uint256 id) {
        vm.warp(T0);
        id = _createDefault();
        vm.warp(T1);
        if (s == S_PASSED) {
            _pass(id, 0);
        } else if (s == S_APPROVED) {
            _releaseAs(buyer, id, 0);
        } else if (s == S_DISPUTED) {
            _dispute(id, 0);
        } else if (s == S_DISPUTED_PASSED) {
            _pass(id, 0);
            _dispute(id, 0);
        } else if (s == S_REFUNDED) {
            _dispute(id, 0);
            _resolve(id, 0, true);
        }
        assertEq(uint8(_mstatus(id, 0)), uint8(_setupStatus(s)), "setup");
    }

    function _ok(MilestoneStatus next) internal pure returns (Outcome memory) {
        return Outcome({ok: true, err: "", next: next});
    }

    function _fail(bytes memory err) internal pure returns (Outcome memory) {
        return Outcome({ok: false, err: err, next: MilestoneStatus.Pending});
    }

    function _inv(uint256 s) internal pure returns (Outcome memory) {
        return _fail(_invalid(_setupStatus(s)));
    }

    function _run(Action memory a, Outcome[N_SETUPS] memory table) internal {
        for (uint256 s; s < N_SETUPS; ++s) {
            uint256 snap = vm.snapshotState();
            uint256 id = _setup(s);
            string memory label = string.concat(a.name, " on ", _setupName(s));

            uint256 locked0 = escrow.lockedBalance();
            MilestoneStatus before = _mstatus(id, 0);
            vm.warp(a.at);
            vm.prank(a.actor);
            (bool ok, bytes memory ret) = address(escrow).call(a.data);

            Outcome memory o = table[s];
            assertEq(ok, o.ok, string.concat(label, ": success"));
            if (o.ok) {
                MilestoneStatus next = _mstatus(id, 0);
                assertEq(uint8(next), uint8(o.next), string.concat(label, ": next status"));
                bool terminal = next == MilestoneStatus.Approved || next == MilestoneStatus.Refunded;
                assertEq(locked0 - escrow.lockedBalance(), terminal ? M0 : 0, string.concat(label, ": locked delta"));
            } else {
                assertEq(ret, o.err, string.concat(label, ": revert data"));
                assertEq(uint8(_mstatus(id, 0)), uint8(before), string.concat(label, ": unchanged"));
                assertEq(escrow.lockedBalance(), locked0, string.concat(label, ": locked unchanged"));
            }
            _assertVault();
            vm.revertToState(snap);
        }
    }

    function _call(bytes memory data, address actor, uint256 at, string memory name)
        internal
        pure
        returns (Action memory)
    {
        return Action({name: name, actor: actor, at: at, data: data});
    }

    // escrow id is always 1 inside a snapshot (the first escrow created)
    uint256 internal constant ID = 1;

    // =====================================================================================================
    // markPassed (verifier)
    // =====================================================================================================

    function test_table_markPassed() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Passed);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.markPassed, (ID, 0, keccak256("d"))), verifier, T1, "markPassed"), t);
    }

    // =====================================================================================================
    // releaseMilestone
    // =====================================================================================================

    function test_table_releaseByBuyer() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Approved);
        t[S_PASSED] = _ok(MilestoneStatus.Approved);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.releaseMilestone, (ID, 0)), buyer, T1, "release(buyer)"), t);
    }

    function test_table_releaseByBuyerAfterWindow() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Approved);
        t[S_PASSED] = _ok(MilestoneStatus.Approved);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(abi.encodeCall(escrow.releaseMilestone, (ID, 0)), buyer, DEFAULT_DEADLINE + 1, "release(buyer,late)"),
            t
        );
    }

    function test_table_releaseByStrangerBeforeWindow() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.AutoReleaseNotReached.selector, T1 + WINDOW));
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(
                abi.encodeCall(escrow.releaseMilestone, (ID, 0)), stranger, T1 + WINDOW - 1, "release(stranger,early)"
            ),
            t
        );
    }

    function test_table_releaseByStrangerAfterWindow() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _ok(MilestoneStatus.Approved);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(abi.encodeCall(escrow.releaseMilestone, (ID, 0)), stranger, T1 + WINDOW, "release(stranger,late)"), t
        );
    }

    function test_table_releaseByCreatorIsAStranger() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.AutoReleaseNotReached.selector, T1 + WINDOW));
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.releaseMilestone, (ID, 0)), creator, T1, "release(creator,early)"), t);
    }

    // =====================================================================================================
    // openDispute
    // =====================================================================================================

    function test_table_openDisputeBeforeWindow() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Disputed);
        t[S_PASSED] = _ok(MilestoneStatus.Disputed);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(
                abi.encodeCall(escrow.openDispute, (ID, 0, keccak256("r"))), buyer, T1 + WINDOW - 1, "dispute(early)"
            ),
            t
        );
    }

    function test_table_openDisputeAfterWindow() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Disputed);
        t[S_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.DisputeWindowClosed.selector));
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.openDispute, (ID, 0, keccak256("r"))), buyer, T1 + WINDOW, "dispute(late)"), t);
    }

    function test_table_openDisputeByStranger() public {
        Outcome[N_SETUPS] memory t;
        for (uint256 s; s < N_SETUPS; ++s) {
            t[s] = _fail(abi.encodeWithSelector(SolversEscrow.NotBuyer.selector));
        }
        _run(_call(abi.encodeCall(escrow.openDispute, (ID, 0, keccak256("r"))), stranger, T1, "dispute(stranger)"), t);
    }

    // =====================================================================================================
    // resolveDispute (admin)
    // =====================================================================================================

    function test_table_resolveDisputeRefund() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _ok(MilestoneStatus.Refunded);
        t[S_DISPUTED_PASSED] = _ok(MilestoneStatus.Refunded);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.resolveDispute, (ID, 0, true)), admin, T1, "resolve(refund)"), t);
    }

    function test_table_resolveDisputePay() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _ok(MilestoneStatus.Approved);
        t[S_DISPUTED_PASSED] = _ok(MilestoneStatus.Approved);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.resolveDispute, (ID, 0, false)), admin, T1, "resolve(pay)"), t);
    }

    // =====================================================================================================
    // cancelUndelivered (buyer, Pending, now > deadline)
    // =====================================================================================================

    function test_table_cancelUndeliveredAtDeadline() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] =
            _fail(abi.encodeWithSelector(SolversEscrow.DeliveryDeadlineNotReached.selector, DEFAULT_DEADLINE));
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(abi.encodeCall(escrow.cancelUndelivered, (ID, 0)), buyer, DEFAULT_DEADLINE, "cancel(at deadline)"), t
        );
    }

    function test_table_cancelUndeliveredBeforeDeadline() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] =
            _fail(abi.encodeWithSelector(SolversEscrow.DeliveryDeadlineNotReached.selector, DEFAULT_DEADLINE));
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.cancelUndelivered, (ID, 0)), buyer, T1, "cancel(early)"), t);
    }

    function test_table_cancelUndeliveredAfterDeadline() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Refunded);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.cancelUndelivered, (ID, 0)), buyer, DEFAULT_DEADLINE + 1, "cancel(late)"), t);
    }

    function test_table_cancelUndeliveredByStranger() public {
        Outcome[N_SETUPS] memory t;
        for (uint256 s; s < N_SETUPS; ++s) {
            t[s] = _fail(abi.encodeWithSelector(SolversEscrow.NotBuyer.selector));
        }
        _run(
            _call(
                abi.encodeCall(escrow.cancelUndelivered, (ID, 0)), stranger, DEFAULT_DEADLINE + 1, "cancel(stranger)"
            ),
            t
        );
    }

    // =====================================================================================================
    // resolveStaleDispute (anyone; Disputed, never passed, SLA elapsed, deadline over)
    // =====================================================================================================

    function test_table_staleBeforeSla() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _fail(abi.encodeWithSelector(SolversEscrow.DisputeSlaNotReached.selector, T1 + SLA));
        t[S_DISPUTED_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.StaleDisputeNeedsJudgment.selector));
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(_call(abi.encodeCall(escrow.resolveStaleDispute, (ID, 0)), stranger, T1 + SLA - 1, "stale(before SLA)"), t);
    }

    function test_table_staleAfterSlaBeforeDeadline() public {
        // SLA reached (T1 + 7d) but the 14-day delivery deadline is not over yet
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] =
            _fail(abi.encodeWithSelector(SolversEscrow.DeliveryDeadlineNotReached.selector, DEFAULT_DEADLINE));
        t[S_DISPUTED_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.StaleDisputeNeedsJudgment.selector));
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(abi.encodeCall(escrow.resolveStaleDispute, (ID, 0)), stranger, T1 + SLA, "stale(SLA, no deadline)"), t
        );
    }

    function test_table_staleAtDeadline() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] =
            _fail(abi.encodeWithSelector(SolversEscrow.DeliveryDeadlineNotReached.selector, DEFAULT_DEADLINE));
        t[S_DISPUTED_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.StaleDisputeNeedsJudgment.selector));
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(
                abi.encodeCall(escrow.resolveStaleDispute, (ID, 0)), stranger, DEFAULT_DEADLINE, "stale(at deadline)"
            ),
            t
        );
    }

    function test_table_staleReady() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _inv(S_PENDING);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _ok(MilestoneStatus.Refunded);
        t[S_DISPUTED_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.StaleDisputeNeedsJudgment.selector));
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _run(
            _call(abi.encodeCall(escrow.resolveStaleDispute, (ID, 0)), stranger, DEFAULT_DEADLINE + 1, "stale(ready)"),
            t
        );
        // the buyer (or anyone) may trigger it too
        _run(_call(abi.encodeCall(escrow.resolveStaleDispute, (ID, 0)), buyer, DEFAULT_DEADLINE + 1, "stale(buyer)"), t);
    }

    /// @dev When the deadline is shorter than the SLA, the SLA is the binding constraint.
    function test_stale_slaBindsWhenDeadlineIsEarlier() public {
        vm.warp(T0);
        uint256 id = _createWith(buyer, AGENT, _inputs(_amounts1(5_000_000)), WINDOW, 1); // deadline T0 + 1d
        vm.warp(T1);
        _dispute(id, 0);
        vm.warp(T0 + 1 days + 1);
        vm.expectRevert(abi.encodeWithSelector(SolversEscrow.DisputeSlaNotReached.selector, T1 + SLA));
        escrow.resolveStaleDispute(id, 0);
        vm.warp(T1 + SLA);
        escrow.resolveStaleDispute(id, 0);
        assertEq(uint8(_mstatus(id, 0)), uint8(MilestoneStatus.Refunded));
    }

    // =====================================================================================================
    // PAYMENTS pause across the table: only release and resolveDispute are blocked
    // =====================================================================================================

    function _paused() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(Paused.selector, PAUSE_PAYMENTS);
    }

    function _runPaused(Action memory a, Outcome[N_SETUPS] memory table) internal {
        for (uint256 s; s < N_SETUPS; ++s) {
            uint256 snap = vm.snapshotState();
            uint256 id = _setup(s);
            _pause(PAUSE_PAYMENTS);
            string memory label = string.concat("paused ", a.name, " on ", _setupName(s));
            vm.warp(a.at);
            vm.prank(a.actor);
            (bool ok, bytes memory ret) = address(escrow).call(a.data);
            Outcome memory o = table[s];
            assertEq(ok, o.ok, string.concat(label, ": success"));
            if (o.ok) {
                assertEq(uint8(_mstatus(id, 0)), uint8(o.next), string.concat(label, ": next status"));
            } else {
                assertEq(ret, o.err, string.concat(label, ": revert data"));
            }
            vm.revertToState(snap);
        }
    }

    function test_pausedTable_releaseAlwaysPaused() public {
        Outcome[N_SETUPS] memory t;
        for (uint256 s; s < N_SETUPS; ++s) {
            t[s] = _fail(_paused());
        }
        _runPaused(_call(abi.encodeCall(escrow.releaseMilestone, (ID, 0)), buyer, T1, "release(buyer)"), t);
        _runPaused(
            _call(abi.encodeCall(escrow.releaseMilestone, (ID, 0)), stranger, T1 + WINDOW, "release(stranger)"), t
        );
    }

    function test_pausedTable_resolveDisputePaused() public {
        Outcome[N_SETUPS] memory t;
        for (uint256 s; s < N_SETUPS; ++s) {
            t[s] = _fail(_paused());
        }
        _runPaused(_call(abi.encodeCall(escrow.resolveDispute, (ID, 0, true)), admin, T1, "resolve(refund)"), t);
        _runPaused(_call(abi.encodeCall(escrow.resolveDispute, (ID, 0, false)), admin, T1, "resolve(pay)"), t);
    }

    function test_pausedTable_nonPayoutActionsUnaffected() public {
        Outcome[N_SETUPS] memory t;
        t[S_PENDING] = _ok(MilestoneStatus.Passed);
        t[S_PASSED] = _inv(S_PASSED);
        t[S_APPROVED] = _inv(S_APPROVED);
        t[S_DISPUTED] = _inv(S_DISPUTED);
        t[S_DISPUTED_PASSED] = _inv(S_DISPUTED_PASSED);
        t[S_REFUNDED] = _inv(S_REFUNDED);
        _runPaused(_call(abi.encodeCall(escrow.markPassed, (ID, 0, bytes32(0))), verifier, T1, "markPassed"), t);

        t[S_PENDING] = _ok(MilestoneStatus.Disputed);
        t[S_PASSED] = _ok(MilestoneStatus.Disputed);
        _runPaused(_call(abi.encodeCall(escrow.openDispute, (ID, 0, bytes32(0))), buyer, T1, "dispute"), t);

        t[S_PENDING] = _ok(MilestoneStatus.Refunded);
        t[S_PASSED] = _inv(S_PASSED);
        _runPaused(
            _call(abi.encodeCall(escrow.cancelUndelivered, (ID, 0)), buyer, DEFAULT_DEADLINE + 1, "cancel(late)"), t
        );

        t[S_PENDING] = _inv(S_PENDING);
        t[S_DISPUTED] = _ok(MilestoneStatus.Refunded);
        t[S_DISPUTED_PASSED] = _fail(abi.encodeWithSelector(SolversEscrow.StaleDisputeNeedsJudgment.selector));
        _runPaused(
            _call(abi.encodeCall(escrow.resolveStaleDispute, (ID, 0)), stranger, DEFAULT_DEADLINE + 1, "stale"), t
        );
    }

    // =====================================================================================================
    // property: derived status == refresh_status after any action sequence; one event per change; money conserved
    // =====================================================================================================

    uint256 internal constant N_MS = 3;
    uint96 internal constant AMT = 2_000_000;

    function _refreshStatus(MilestoneStatus[] memory ss) internal pure returns (EscrowStatus) {
        bool allDone = true;
        bool anyDisputed;
        bool allRefunded = true;
        for (uint256 i; i < ss.length; ++i) {
            if (ss[i] != MilestoneStatus.Approved && ss[i] != MilestoneStatus.Refunded) allDone = false;
            if (ss[i] == MilestoneStatus.Disputed) anyDisputed = true;
            if (ss[i] != MilestoneStatus.Refunded) allRefunded = false;
        }
        if (allRefunded) return EscrowStatus.Refunded;
        if (allDone) return EscrowStatus.Completed;
        if (anyDisputed) return EscrowStatus.Disputed;
        return EscrowStatus.Active;
    }

    function _statuses(uint256 id) internal view returns (MilestoneStatus[] memory ss) {
        SolversEscrow.Milestone[] memory ms = _ms(id);
        ss = new MilestoneStatus[](ms.length);
        for (uint256 i; i < ms.length; ++i) {
            ss[i] = ms[i].status;
        }
    }

    function _allowedEdge(MilestoneStatus a, MilestoneStatus b) internal pure returns (bool) {
        if (a == b) return true;
        if (a == MilestoneStatus.Pending) {
            return b == MilestoneStatus.Passed || b == MilestoneStatus.Approved || b == MilestoneStatus.Disputed
                || b == MilestoneStatus.Refunded;
        }
        if (a == MilestoneStatus.Passed) return b == MilestoneStatus.Approved || b == MilestoneStatus.Disputed;
        if (a == MilestoneStatus.Disputed) return b == MilestoneStatus.Approved || b == MilestoneStatus.Refunded;
        return false; // Approved and Refunded are terminal
    }

    function _statusEvents(Vm.Log[] memory logs, uint256 id) internal view returns (uint256 n, EscrowStatus last) {
        for (uint256 i; i < logs.length; ++i) {
            if (
                logs[i].emitter == address(escrow) && logs[i].topics[0] == SolversEscrow.EscrowStatusChanged.selector
                    && logs[i].topics[1] == bytes32(id)
            ) {
                ++n;
                last = abi.decode(logs[i].data, (EscrowStatus));
            }
        }
    }

    function _apply(uint256 id, uint8 op) internal {
        uint8 i = uint8(op % N_MS);
        uint256 act = (op / N_MS) % 9;
        address actor;
        bytes memory data;
        if (act == 0) {
            actor = verifier;
            data = abi.encodeCall(escrow.markPassed, (id, i, bytes32(uint256(op))));
        } else if (act == 1) {
            actor = buyer;
            data = abi.encodeCall(escrow.releaseMilestone, (id, i));
        } else if (act == 2) {
            actor = stranger;
            data = abi.encodeCall(escrow.releaseMilestone, (id, i));
        } else if (act == 3) {
            actor = buyer;
            data = abi.encodeCall(escrow.openDispute, (id, i, bytes32(uint256(op))));
        } else if (act == 4) {
            actor = admin;
            data = abi.encodeCall(escrow.resolveDispute, (id, i, true));
        } else if (act == 5) {
            actor = admin;
            data = abi.encodeCall(escrow.resolveDispute, (id, i, false));
        } else if (act == 6) {
            actor = buyer;
            data = abi.encodeCall(escrow.cancelUndelivered, (id, i));
        } else if (act == 7) {
            actor = stranger;
            data = abi.encodeCall(escrow.resolveStaleDispute, (id, i));
        } else {
            vm.warp(block.timestamp + 1 days + (op % 3) * 1 days);
            return;
        }
        vm.prank(actor);
        (bool ok,) = address(escrow).call(data);
        ok; // validity is asserted through the state checks below
    }

    struct Tally {
        uint256 refunded;
        uint256 approved;
        uint256 disputesOpened;
        uint256 buyerLost;
        uint256 agentLost;
    }

    Tally internal tally;

    function _step(uint256 id, uint8 op) internal {
        MilestoneStatus[] memory before = _statuses(id);
        EscrowStatus sBefore = escrow.statusOf(id);
        uint32 buyerLost0 = _rep(buyer).disputesLost;
        uint32 agentLost0 = _agentDisputesLost(AGENT);

        vm.recordLogs();
        _apply(id, op);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        MilestoneStatus[] memory afterS = _statuses(id);
        EscrowStatus sAfter = escrow.statusOf(id);
        assertEq(uint8(sAfter), uint8(_refreshStatus(afterS)), "statusOf == refresh_status");
        (uint256 n, EscrowStatus last) = _statusEvents(logs, id);
        assertEq(n, sAfter != sBefore ? 1 : 0, "one EscrowStatusChanged per change");
        if (n == 1) assertEq(uint8(last), uint8(sAfter), "EscrowStatusChanged value");

        uint256 changed;
        uint256 locked;
        for (uint256 m; m < N_MS; ++m) {
            assertTrue(_allowedEdge(before[m], afterS[m]), "legal milestone edge");
            if (before[m] != afterS[m]) {
                ++changed;
                if (afterS[m] == MilestoneStatus.Refunded) ++tally.refunded;
                if (afterS[m] == MilestoneStatus.Approved) ++tally.approved;
                if (afterS[m] == MilestoneStatus.Disputed) ++tally.disputesOpened;
            }
            if (afterS[m] != MilestoneStatus.Approved && afterS[m] != MilestoneStatus.Refunded) locked += AMT;
        }
        assertLe(changed, 1, "one milestone per call");
        assertEq(escrow.lockedBalance(), locked, "locked == open milestones");
        _assertVault();

        uint256 dBuyer = _rep(buyer).disputesLost - buyerLost0;
        uint256 dAgent = _agentDisputesLost(AGENT) - agentLost0;
        assertLe(dBuyer + dAgent, 1, "at most one loser per call");
        tally.buyerLost += dBuyer;
        tally.agentLost += dAgent;
    }

    function testFuzz_derivedStatusMatchesRefreshStatus(uint8[24] memory ops) public {
        uint256 id = _create(_amountsN(N_MS, AMT));
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 b0 = _bal(buyer);
        uint32 opened0 = _rep(buyer).disputesOpened;
        delete tally;

        for (uint256 k; k < ops.length; ++k) {
            _step(id, ops[k]);
        }

        // money: every closed milestone moved exactly AMT out of the vault, with the 10% fee only on payouts
        uint256 fee = uint256(AMT) * FEE_BPS / 10_000;
        assertEq(_bal(buyer) - b0, tally.refunded * AMT, "buyer refunds");
        assertEq(_bal(creator) - c0, tally.approved * (AMT - fee), "creator payouts");
        assertEq(_bal(treasury) - t0, tally.approved * fee, "treasury fees");
        assertEq(_rep(buyer).disputesOpened - opened0, tally.disputesOpened, "disputesOpened");
        assertLe(tally.buyerLost + tally.agentLost, tally.disputesOpened, "at most one loser per dispute");
    }

    /// @dev A deterministic walk through the whole graph (also a regression for the fuzz helpers).
    function test_fullWalk() public {
        uint8[24] memory ops;
        // m0: pass, dispute (within window), resolve pay; m1: dispute, warp past deadline, stale; m2: cancel
        ops[0] = 0; // markPassed m0
        ops[1] = 9; // openDispute m0  (act 3 * 3 + 0)
        ops[2] = 15; // resolve pay m0 (act 5 * 3 + 0)
        ops[3] = 10; // openDispute m1
        ops[4] = 26; // warp 3 days (x6 = past the 14-day deadline)
        ops[5] = 26;
        ops[6] = 26;
        ops[7] = 26;
        ops[8] = 26;
        ops[9] = 26;
        ops[10] = 22; // stale m1 (act 7 * 3 + 1)
        ops[11] = 20; // cancel m2 (act 6 * 3 + 2)
        for (uint256 k = 12; k < 24; ++k) {
            ops[k] = 26; // warps
        }
        testFuzz_derivedStatusMatchesRefreshStatus(ops);
        MilestoneStatus[] memory ss = _statuses(1);
        assertEq(uint8(ss[0]), uint8(MilestoneStatus.Approved));
        assertEq(uint8(ss[1]), uint8(MilestoneStatus.Refunded));
        assertEq(uint8(ss[2]), uint8(MilestoneStatus.Refunded));
        assertEq(uint8(escrow.statusOf(1)), uint8(EscrowStatus.Completed));
        assertEq(_rep(buyer).disputesLost, 1);
        assertEq(_agentDisputesLost(AGENT), 0);
    }
}
