// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";

import {SolversTestBase, IReceivePolicies} from "./utils/SolversTestBase.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {
    AgentStatus,
    InvalidAmount,
    NotCreator,
    NotSatellite,
    AgentNotFound,
    NothingToClaim,
    RecipientBlocked,
    PAUSE_MASK
} from "../src/SolversTypes.sol";

/// @notice SolversStaking: stake in, 30-day exit with up to two admin extensions, two-step slash with a
/// `[proposedAt + 72h, proposedAt + 72h + 14d]` execution window, deferred payouts. Mirrors `stake.rs`.
contract StakingTest is SolversTestBase {
    uint256 internal constant EXIT_DELAY = 30 days;
    uint256 internal constant SLASH_DELAY = 72 hours;
    uint256 internal constant SLASH_GRACE = 14 days;
    bytes32 internal constant REASON = keccak256("reason");
    bytes32 internal constant CONTEST = keccak256("contest");

    // ---------------------------------------------------------------------------------------------------- helpers

    function _unblockReceives(address account) internal {
        vm.prank(account);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(1, 1, address(0));
    }

    function _topUp(address who, bytes32 agentId, uint96 amount) internal {
        vm.startPrank(who);
        usd.approve(address(staking), amount);
        staking.topUpStake(agentId, amount);
        vm.stopPrank();
    }

    function _requestExit(bytes32 agentId) internal returns (uint40 exitAt) {
        vm.prank(registry.creatorOf(agentId));
        staking.requestStakeExit(agentId);
        exitAt = staking.stakeExitOf(agentId).exitAt;
    }

    function _propose(bytes32 agentId, uint96 amount) internal returns (uint256 proposedAt) {
        vm.prank(admin);
        staking.proposeSlash(agentId, amount, REASON);
        proposedAt = block.timestamp;
    }

    function _status(bytes32 agentId) internal view returns (AgentStatus) {
        return registry.statusOf(agentId);
    }

    function _adminErr(address who) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, bytes32(0));
    }

    function _buyCredits(address who, bytes32 agentId, uint32 amount) internal {
        uint256 total = uint256(PRICE_PER_USE) * amount;
        vm.startPrank(who);
        usd.approve(address(credits), total);
        credits.buyCredits(agentId, amount, total, _pid());
        vm.stopPrank();
    }

    // =============================================================================================== pullStake

    function test_pullStake_onlyRegistry() public {
        vm.prank(creator);
        usd.approve(address(staking), MIN_STAKE);
        address[3] memory callers = [stranger, admin, creator];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(NotSatellite.selector);
            staking.pullStake(AGENT, creator, MIN_STAKE);
        }
        assertEq(staking.totalStaked(), 0);
        assertEq(_bal(address(staking)), 0);
    }

    function test_pullStake_atRegistration() public {
        uint256 creatorBefore = _bal(creator);
        vm.startPrank(creator);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.StakePulled(AGENT, creator, MIN_STAKE);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
        assertEq(creatorBefore - _bal(creator), MIN_STAKE);
        assertEq(_bal(address(staking)), MIN_STAKE);
        assertEq(staking.totalStaked(), MIN_STAKE);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Pending));
    }

    function test_pullStake_withoutAllowanceRevertsRegistration() public {
        vm.prank(creator);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        assertFalse(registry.agentExists(AGENT));
        assertEq(staking.totalStaked(), 0);
    }

    function test_pullStake_skippedWhenMinStakeZero() public {
        _deploy(0);
        vm.prank(creator);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        assertEq(registry.stakeOf(AGENT), 0);
        assertEq(staking.totalStaked(), 0);
        vm.prank(admin);
        registry.approveAgent(AGENT); // stake 0 >= minStake 0
        _buy(buyer, AGENT);
    }

    // ============================================================================================== topUpStake

    function test_topUp_zeroAmount() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(InvalidAmount.selector);
        staking.topUpStake(AGENT, 0);
    }

    function test_topUp_onlyCreator() public {
        _registerActive(creator, AGENT);
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        address[3] memory callers = [stranger, admin, creator2];
        for (uint256 i; i < callers.length; ++i) {
            vm.startPrank(callers[i]);
            usd.approve(address(staking), 1_000_000);
            vm.expectRevert(NotCreator.selector);
            staking.topUpStake(AGENT, 1_000_000);
            vm.stopPrank();
        }
    }

    function test_topUp_unknownAgent() public {
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT));
        staking.topUpStake(AGENT, 1);
    }

    function test_topUp_overflowUint96() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(InvalidAmount.selector);
        staking.topUpStake(AGENT, type(uint96).max);
    }

    function test_topUp_withoutAllowanceReverts() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        staking.topUpStake(AGENT, 1_000_000);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);
        assertEq(staking.totalStaked(), MIN_STAKE);
    }

    function test_topUp_balanceDiffAndMirrors() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        uint96 amount = 7_500_001;
        uint256 creatorBefore = _bal(creator);
        uint256 vaultBefore = _bal(address(staking));

        vm.startPrank(creator);
        usd.approve(address(staking), amount);
        vm.expectEmit(true, false, false, true, address(registry));
        emit SolversRegistry.StakeChanged(AGENT, MIN_STAKE + amount);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.StakeToppedUp(AGENT, creator, amount, MIN_STAKE + amount);
        staking.topUpStake(AGENT, amount);
        vm.stopPrank();

        assertEq(creatorBefore - _bal(creator), amount);
        assertEq(_bal(address(staking)) - vaultBefore, amount);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE + amount);
        assertEq(registry.stakeOf(AGENT2), MIN_STAKE);
        assertEq(staking.totalStaked(), 2 * uint256(MIN_STAKE) + amount);
        assertEq(_bal(address(staking)), staking.totalStaked());
    }

    function test_topUp_anyStatus() public {
        // Pending
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        _topUp(creator, AGENT, 1);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Pending));
        // Active
        vm.prank(admin);
        registry.approveAgent(AGENT);
        _topUp(creator, AGENT, 1);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Active));
        // Suspended
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        _topUp(creator, AGENT, 1);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));
        // Retired (exit pending): rejected, the new stake could never be withdrawn again after the exit
        _requestExit(AGENT);
        vm.startPrank(creator);
        usd.approve(address(staking), 1);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentRetired.selector, AGENT));
        staking.topUpStake(AGENT, 1);
        vm.stopPrank();
        assertEq(registry.stakeOf(AGENT), MIN_STAKE + 3);
        assertEq(staking.totalStaked(), MIN_STAKE + 3);
    }

    function test_topUp_doesNotReactivate() public {
        _registerActive(creator, AGENT);
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        _topUp(creator, AGENT, 5_000_000);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));
    }

    /// Regression (found by this suite, fixed in topUpStake): `stake.rs` closes the stake vault on `withdraw_stake`, so a later `top_up_stake` cannot succeed there.
    /// Here `topUpStake` is accepted on a Retired agent whose stake was already withdrawn: the exit record is gone,
    /// `requestStakeExit` reverts `AgentRetired`, `withdrawStake` reverts `NoStakeExit`, and `sweepStray` cannot touch
    /// the amount (it is counted in `totalStaked`). The creator's top-up is locked forever (only a slash can move it,
    /// to the treasury). Correct behaviour asserted: either the top-up is rejected, or the creator can get it back.
    function test_topUp_afterWithdraw_fundsMustNotBeLocked() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);
        vm.prank(creator);
        staking.withdrawStake(AGENT);

        uint256 creatorBefore = _bal(creator);
        vm.startPrank(creator);
        usd.approve(address(staking), 5_000_000);
        try staking.topUpStake(AGENT, 5_000_000) {
            vm.stopPrank();
            // Accepted: the creator must be able to withdraw it again.
            vm.prank(creator);
            (bool ok,) = address(staking).call(abi.encodeCall(SolversStaking.withdrawStake, (AGENT)));
            assertTrue(ok, "top-up after withdraw would be locked forever");
            assertEq(_bal(creator), creatorBefore, "top-up not returned");
        } catch {
            vm.stopPrank();
            assertEq(_bal(creator), creatorBefore);
        }
    }

    // ======================================================================================== requestStakeExit

    function test_requestExit_onlyCreator() public {
        _registerActive(creator, AGENT);
        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        staking.requestStakeExit(AGENT);
        vm.prank(admin);
        vm.expectRevert(NotCreator.selector);
        staking.requestStakeExit(AGENT);
    }

    function test_requestExit_setsRetiredAndExitAt() public {
        _registerActive(creator, AGENT);
        vm.warp(1_800_000_000);
        uint40 expected = uint40(block.timestamp + EXIT_DELAY);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.StakeExitRequested(AGENT, creator, expected);
        vm.expectEmit(true, true, false, true, address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Retired, creator);
        vm.prank(creator);
        staking.requestStakeExit(AGENT);

        SolversStaking.StakeExit memory x = staking.stakeExitOf(AGENT);
        assertEq(x.exitAt, expected);
        assertEq(x.requestedAt, block.timestamp);
        assertEq(x.extensions, 0);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Retired));
        assertEq(registry.stakeOf(AGENT), MIN_STAKE); // stake stays until withdraw
    }

    function test_requestExit_twiceReverts() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentRetired.selector, AGENT));
        staking.requestStakeExit(AGENT);
    }

    function test_requestExit_fromPendingAndSuspended() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        _requestExit(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Retired));

        _registerActive(creator2, AGENT2);
        vm.prank(admin);
        registry.suspendAgent(AGENT2);
        _requestExit(AGENT2);
        assertEq(uint8(_status(AGENT2)), uint8(AgentStatus.Retired));
    }

    function test_requestExit_retiredBlocksSalesAndAdminStatus() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);

        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentRetired.selector, AGENT));
        registry.approveAgent(AGENT);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentRetired.selector, AGENT));
        registry.suspendAgent(AGENT);
        vm.stopPrank();
    }

    function test_requestExit_allowedWithPendingSlash() public {
        _registerActive(creator, AGENT);
        _propose(AGENT, 1_000_000);
        uint40 exitAt = _requestExit(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Retired));
        vm.warp(exitAt);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashPending.selector, AGENT));
        staking.withdrawStake(AGENT);
    }

    // ========================================================================================= extendStakeExit

    function test_extendExit_onlyAdmin() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        address[3] memory callers = [stranger, creator, platform];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_adminErr(callers[i]));
            staking.extendStakeExit(AGENT, REASON);
        }
    }

    function test_extendExit_noExit() public {
        _registerActive(creator, AGENT);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoStakeExit.selector, AGENT));
        staking.extendStakeExit(AGENT, REASON);
        // unknown agent: no exit either
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoStakeExit.selector, AGENT2));
        staking.extendStakeExit(AGENT2, REASON);
    }

    function test_extendExit_twiceThenExhausted() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        uint40 requestedAt = staking.stakeExitOf(AGENT).requestedAt;

        vm.expectEmit(true, false, false, true, address(staking));
        emit SolversStaking.StakeExitExtended(AGENT, uint40(exitAt + EXIT_DELAY), 1, REASON);
        vm.prank(admin);
        staking.extendStakeExit(AGENT, REASON);
        vm.warp(block.timestamp + 10 days); // extension adds to exitAt, not to now
        vm.prank(admin);
        staking.extendStakeExit(AGENT, keccak256("again"));

        SolversStaking.StakeExit memory x = staking.stakeExitOf(AGENT);
        assertEq(x.exitAt, exitAt + 2 * EXIT_DELAY);
        assertEq(x.extensions, 2);
        assertEq(x.requestedAt, requestedAt);

        vm.prank(admin);
        vm.expectRevert(SolversStaking.StakeExitExtensionsExhausted.selector);
        staking.extendStakeExit(AGENT, REASON);

        // withdraw waits for the extended date (inclusive)
        vm.warp(x.exitAt - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.StakeExitNotReached.selector, uint256(x.exitAt)));
        staking.withdrawStake(AGENT);
        vm.warp(x.exitAt);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(registry.stakeOf(AGENT), 0);
    }

    function test_extendExit_afterExitDateStillExtends() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt + 1);
        vm.prank(admin);
        staking.extendStakeExit(AGENT, REASON);
        vm.prank(creator);
        vm.expectRevert(
            abi.encodeWithSelector(SolversStaking.StakeExitNotReached.selector, uint256(exitAt + EXIT_DELAY))
        );
        staking.withdrawStake(AGENT);
    }

    // ========================================================================================= cancelStakeExit

    function test_cancelExit_onlyCreator() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        staking.cancelStakeExit(AGENT);
        vm.prank(admin);
        vm.expectRevert(NotCreator.selector);
        staking.cancelStakeExit(AGENT);
    }

    function test_cancelExit_onlyRetired() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentNotRetired.selector, AGENT));
        staking.cancelStakeExit(AGENT);
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentNotRetired.selector, AGENT));
        staking.cancelStakeExit(AGENT);
    }

    function test_cancelExit_afterExtensionReverts() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        vm.prank(admin);
        staking.extendStakeExit(AGENT, REASON);
        vm.prank(creator);
        vm.expectRevert(SolversStaking.StakeExitAlreadyExtended.selector);
        staking.cancelStakeExit(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Retired));
    }

    function test_cancelExit_suspendsAndCanRequestAgain() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        vm.warp(block.timestamp + 5 days);

        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.StakeExitCancelled(AGENT, creator);
        vm.expectEmit(true, true, false, true, address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Suspended, creator);
        vm.prank(creator);
        staking.cancelStakeExit(AGENT);

        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));
        assertEq(staking.stakeExitOf(AGENT).exitAt, 0);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);

        // a suspended agent cannot withdraw
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentNotRetired.selector, AGENT));
        staking.withdrawStake(AGENT);

        // request again later: the wait restarts
        vm.warp(block.timestamp + 3 days);
        uint40 exitAt = _requestExit(AGENT);
        assertEq(exitAt, block.timestamp + EXIT_DELAY);
        assertEq(staking.stakeExitOf(AGENT).extensions, 0);
    }

    function test_cancelExit_thenApproveReactivates() public {
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        vm.prank(creator);
        staking.cancelStakeExit(AGENT);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Active));
        _buy(buyer, AGENT);
    }

    function test_cancelExit_afterWithdrawHasNoExit() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoStakeExit.selector, AGENT));
        staking.cancelStakeExit(AGENT);
    }

    // =========================================================================================== withdrawStake

    function test_withdraw_onlyCreator() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);
        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        staking.withdrawStake(AGENT);
        vm.prank(admin);
        vm.expectRevert(NotCreator.selector);
        staking.withdrawStake(AGENT);
    }

    function test_withdraw_onlyRetired() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentNotRetired.selector, AGENT));
        staking.withdrawStake(AGENT);
    }

    function test_withdraw_boundary() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.StakeExitNotReached.selector, uint256(exitAt)));
        staking.withdrawStake(AGENT);

        vm.warp(exitAt - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.StakeExitNotReached.selector, uint256(exitAt)));
        staking.withdrawStake(AGENT);

        vm.warp(exitAt); // now == exitAt is allowed
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(registry.stakeOf(AGENT), 0);
    }

    function test_withdraw_blockedByPendingSlashUntilCancelled() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        _propose(AGENT, 1_000_000);
        vm.warp(exitAt + 100 days);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashPending.selector, AGENT));
        staking.withdrawStake(AGENT);

        // the proposal expired long ago: the creator may close it and then withdraw
        vm.prank(creator);
        staking.cancelSlash(AGENT);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(registry.stakeOf(AGENT), 0);
    }

    function test_withdraw_paysWholeStake() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        _topUp(creator, AGENT, 3_333_333);
        uint96 stake = MIN_STAKE + 3_333_333;
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);

        uint256 creatorBefore = _bal(creator);
        uint256 totalBefore = staking.totalStaked();
        vm.expectEmit(true, false, false, true, address(registry));
        emit SolversRegistry.StakeChanged(AGENT, 0);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.StakeWithdrawn(AGENT, creator, stake, false);
        vm.prank(creator);
        staking.withdrawStake(AGENT);

        assertEq(_bal(creator) - creatorBefore, stake);
        assertEq(registry.stakeOf(AGENT), 0);
        assertEq(staking.totalStaked(), totalBefore - stake);
        assertEq(staking.totalStaked(), MIN_STAKE); // AGENT2 untouched
        assertEq(_bal(address(staking)), MIN_STAKE);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Retired));
        assertEq(staking.stakeExitOf(AGENT).exitAt, 0);

        // second withdraw: the exit is gone
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoStakeExit.selector, AGENT));
        staking.withdrawStake(AGENT);
        // and the agent never comes back
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.AgentRetired.selector, AGENT));
        staking.requestStakeExit(AGENT);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentRetired.selector, AGENT));
        registry.approveAgent(AGENT);
    }

    function test_withdraw_receiveBlockedCreatorDefersThenClaims() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);
        _blockReceives(creator);

        uint256 creatorBefore = _bal(creator);
        vm.expectEmit(true, false, false, true, address(staking));
        emit SolversStaking.StakeWithdrawn(AGENT, creator, MIN_STAKE, true);
        vm.prank(creator);
        staking.withdrawStake(AGENT);

        assertEq(_bal(creator), creatorBefore);
        assertEq(staking.deferredOf(creator), MIN_STAKE);
        assertEq(staking.totalDeferred(), MIN_STAKE);
        assertEq(staking.totalStaked(), 0);
        assertEq(_bal(address(staking)), staking.totalStaked() + staking.totalDeferred());
        assertEq(_bal(RECEIVE_POLICY_GUARD), 0); // never parked in the guard

        // still blocked: claim refuses instead of redirecting
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(RecipientBlocked.selector, creator));
        staking.claim();

        _unblockReceives(creator);
        vm.prank(stranger);
        vm.expectRevert(NothingToClaim.selector);
        staking.claim();
        vm.prank(creator);
        staking.claim();
        assertEq(_bal(creator) - creatorBefore, MIN_STAKE);
        assertEq(staking.deferredOf(creator), 0);
        assertEq(staking.totalDeferred(), 0);
        assertEq(_bal(address(staking)), 0);
        vm.prank(creator);
        vm.expectRevert(NothingToClaim.selector);
        staking.claim();
    }

    function test_withdraw_tokenBlacklistedCreatorDefers() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);
        _blacklist(creator);
        uint256 creatorBefore = _bal(creator);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(_bal(creator), creatorBefore);
        assertEq(staking.deferredOf(creator), MIN_STAKE);
        assertEq(_bal(address(staking)), staking.totalStaked() + staking.totalDeferred());
    }

    // ============================================================================================ proposeSlash

    function test_proposeSlash_onlyAdmin() public {
        _registerActive(creator, AGENT);
        address[3] memory callers = [stranger, creator, verifier];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_adminErr(callers[i]));
            staking.proposeSlash(AGENT, 1, REASON);
        }
    }

    function test_proposeSlash_amountChecks() public {
        _registerActive(creator, AGENT);
        vm.startPrank(admin);
        vm.expectRevert(InvalidAmount.selector);
        staking.proposeSlash(AGENT, 0, REASON);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.InsufficientStake.selector, MIN_STAKE, MIN_STAKE + 1));
        staking.proposeSlash(AGENT, MIN_STAKE + 1, REASON);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        staking.proposeSlash(AGENT2, 1, REASON);
        staking.proposeSlash(AGENT, MIN_STAKE, REASON); // the whole stake is allowed
        vm.stopPrank();
    }

    function test_proposeSlash_secondPending() public {
        _registerActive(creator, AGENT);
        _propose(AGENT, 1_000_000);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashPending.selector, AGENT));
        staking.proposeSlash(AGENT, 2_000_000, REASON);
        // even an invalid amount reports the pending proposal first
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashPending.selector, AGENT));
        staking.proposeSlash(AGENT, 0, REASON);
    }

    function test_proposeSlash_activeBecomesSuspended() public {
        _registerActive(creator, AGENT);
        vm.warp(1_800_000_000);
        vm.expectEmit(true, false, false, true, address(staking));
        emit SolversStaking.SlashProposed(
            AGENT,
            4_000_000,
            REASON,
            uint40(block.timestamp + SLASH_DELAY),
            uint40(block.timestamp + SLASH_DELAY + SLASH_GRACE)
        );
        vm.expectEmit(true, true, false, true, address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Suspended, admin);
        _propose(AGENT, 4_000_000);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));

        SolversStaking.Slash memory s = staking.slashOf(AGENT);
        assertEq(s.amount, 4_000_000);
        assertEq(s.proposedAt, block.timestamp);
        assertEq(s.contestedAt, 0);
        assertEq(s.reasonHash, REASON);
        assertEq(s.contestHash, bytes32(0));
        assertEq(registry.stakeOf(AGENT), MIN_STAKE); // nothing moves at proposal

        // sales stop right away
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
    }

    function test_proposeSlash_otherStatusesUnchanged() public {
        // Retired stays Retired
        _registerActive(creator, AGENT);
        _requestExit(AGENT);
        _propose(AGENT, 1);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Retired));
        // Suspended stays Suspended
        _registerActive(creator2, AGENT2);
        vm.prank(admin);
        registry.suspendAgent(AGENT2);
        _propose(AGENT2, 1);
        assertEq(uint8(_status(AGENT2)), uint8(AgentStatus.Suspended));
        // Pending stays Pending
        bytes32 agent3 = bytes32(bytes16(0x33333333333333333333333333333333));
        _register(creator, agent3, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        _propose(agent3, 1);
        assertEq(uint8(_status(agent3)), uint8(AgentStatus.Pending));
    }

    function test_proposeSlash_afterWithdrawNoStake() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        vm.warp(exitAt);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.InsufficientStake.selector, uint96(0), uint96(1)));
        staking.proposeSlash(AGENT, 1, REASON);
    }

    // ============================================================================================ contestSlash

    function test_contestSlash_noSlash() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoSlash.selector, AGENT));
        staking.contestSlash(AGENT, CONTEST);
    }

    function test_contestSlash_onlyCreator() public {
        _registerActive(creator, AGENT);
        _propose(AGENT, 1_000_000);
        vm.prank(stranger);
        vm.expectRevert(NotCreator.selector);
        staking.contestSlash(AGENT, CONTEST);
        vm.prank(admin);
        vm.expectRevert(NotCreator.selector);
        staking.contestSlash(AGENT, CONTEST);
    }

    function test_contestSlash_once() public {
        _registerActive(creator, AGENT);
        uint256 proposedAt = _propose(AGENT, 1_000_000);
        vm.warp(block.timestamp + 1 hours);
        vm.expectEmit(true, false, false, true, address(staking));
        emit SolversStaking.SlashContested(AGENT, CONTEST);
        vm.prank(creator);
        staking.contestSlash(AGENT, CONTEST);

        SolversStaking.Slash memory s = staking.slashOf(AGENT);
        assertEq(s.contestedAt, block.timestamp);
        assertEq(s.contestHash, CONTEST);
        assertEq(s.proposedAt, proposedAt); // the window does not move

        vm.prank(creator);
        vm.expectRevert(SolversStaking.SlashAlreadyContested.selector);
        staking.contestSlash(AGENT, keccak256("again"));

        // contesting is evidence only: the admin can still execute in the window
        vm.warp(proposedAt + SLASH_DELAY);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE - 1_000_000);
    }

    function test_contestSlash_newProposalCanBeContestedAgain() public {
        _registerActive(creator, AGENT);
        _propose(AGENT, 1_000_000);
        vm.prank(creator);
        staking.contestSlash(AGENT, CONTEST);
        vm.prank(admin);
        staking.cancelSlash(AGENT);
        _propose(AGENT, 2_000_000);
        assertEq(staking.slashOf(AGENT).contestedAt, 0);
        vm.prank(creator);
        staking.contestSlash(AGENT, CONTEST);
    }

    // ============================================================================================= cancelSlash

    function test_cancelSlash_noSlash() public {
        _registerActive(creator, AGENT);
        address[3] memory callers = [admin, creator, stranger];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoSlash.selector, AGENT));
            staking.cancelSlash(AGENT);
        }
    }

    function test_cancelSlash_strangerNotAdmin() public {
        _registerActive(creator, AGENT);
        uint256 proposedAt = _propose(AGENT, 1_000_000);
        vm.prank(stranger);
        vm.expectRevert(SolversStaking.NotAdmin.selector);
        staking.cancelSlash(AGENT);
        vm.warp(proposedAt + SLASH_DELAY + SLASH_GRACE + 1); // even after expiry
        vm.prank(stranger);
        vm.expectRevert(SolversStaking.NotAdmin.selector);
        staking.cancelSlash(AGENT);
        vm.prank(creator2);
        vm.expectRevert(SolversStaking.NotAdmin.selector);
        staking.cancelSlash(AGENT);
    }

    function test_cancelSlash_adminAnyTime() public {
        _registerActive(creator, AGENT);
        _propose(AGENT, 1_000_000);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.SlashCancelled(AGENT, 1_000_000, admin);
        vm.prank(admin);
        staking.cancelSlash(AGENT); // same block as the proposal
        assertEq(staking.slashOf(AGENT).proposedAt, 0);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended)); // stays until approveAgent

        // inside the execution window too
        uint256 p = _propose(AGENT, 1_000_000);
        vm.warp(p + SLASH_DELAY + 1 days);
        vm.prank(admin);
        staking.cancelSlash(AGENT);
        // and after expiry
        p = _propose(AGENT, 1_000_000);
        vm.warp(p + SLASH_DELAY + SLASH_GRACE + 1);
        vm.prank(admin);
        staking.cancelSlash(AGENT);
        assertEq(staking.slashOf(AGENT).proposedAt, 0);

        vm.prank(admin);
        registry.approveAgent(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Active));
    }

    function test_cancelSlash_creatorOnlyFromExpiryInclusive() public {
        _registerActive(creator, AGENT);
        uint256 proposedAt = _propose(AGENT, 1_000_000);
        uint256 expiresAt = proposedAt + SLASH_DELAY + SLASH_GRACE;

        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashNotExpired.selector, expiresAt));
        staking.cancelSlash(AGENT);
        vm.warp(proposedAt + SLASH_DELAY);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashNotExpired.selector, expiresAt));
        staking.cancelSlash(AGENT);
        vm.warp(expiresAt - 1);
        vm.prank(creator);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashNotExpired.selector, expiresAt));
        staking.cancelSlash(AGENT);

        vm.warp(expiresAt);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.SlashCancelled(AGENT, 1_000_000, creator);
        vm.prank(creator);
        staking.cancelSlash(AGENT);
        assertEq(staking.slashOf(AGENT).proposedAt, 0);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));
    }

    /// @dev At exactly `proposedAt + 72h + 14d` both the admin's execution and the creator's cancellation are valid
    /// (same as `stake.rs`: `now <= expiry` executes, `now >= expiry` cancels). Whoever lands first wins.
    function test_slash_expirySecondIsSharedByExecuteAndCreatorCancel() public {
        _registerActive(creator, AGENT);
        uint256 proposedAt = _propose(AGENT, 1_000_000);
        vm.warp(proposedAt + SLASH_DELAY + SLASH_GRACE);
        uint256 snap = vm.snapshotState();
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE - 1_000_000);
        vm.revertToState(snap);
        vm.prank(creator);
        staking.cancelSlash(AGENT);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoSlash.selector, AGENT));
        staking.executeSlash(AGENT);
    }

    // ============================================================================================ executeSlash

    function test_executeSlash_onlyAdmin() public {
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, 1_000_000);
        vm.warp(p + SLASH_DELAY);
        address[3] memory callers = [stranger, creator, treasury];
        for (uint256 i; i < callers.length; ++i) {
            vm.prank(callers[i]);
            vm.expectRevert(_adminErr(callers[i]));
            staking.executeSlash(AGENT);
        }
    }

    function test_executeSlash_noSlash() public {
        _registerActive(creator, AGENT);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoSlash.selector, AGENT));
        staking.executeSlash(AGENT);
    }

    function test_executeSlash_windowStartInclusive() public {
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, 1_000_000);
        uint256 executableAt = p + SLASH_DELAY;
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashDelayNotReached.selector, executableAt));
        staking.executeSlash(AGENT);
        vm.warp(executableAt - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashDelayNotReached.selector, executableAt));
        staking.executeSlash(AGENT);
        vm.warp(executableAt);
        vm.prank(admin);
        staking.executeSlash(AGENT);
    }

    function test_executeSlash_windowEndInclusive() public {
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, 1_000_000);
        uint256 expiry = p + SLASH_DELAY + SLASH_GRACE;
        uint256 snap = vm.snapshotState();
        vm.warp(expiry);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        vm.revertToState(snap);
        vm.warp(expiry + 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashExpired.selector, expiry));
        staking.executeSlash(AGENT);
        // the expired proposal still blocks a new one until cancelled
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.SlashPending.selector, AGENT));
        staking.proposeSlash(AGENT, 1, REASON);
    }

    function test_executeSlash_paysTreasury() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        uint256 p = _propose(AGENT, 6_000_000);
        vm.warp(p + SLASH_DELAY + 1 days);
        uint256 treasuryBefore = _bal(treasury);

        vm.expectEmit(true, false, false, true, address(registry));
        emit SolversRegistry.StakeChanged(AGENT, MIN_STAKE - 6_000_000);
        vm.expectEmit(true, false, false, true, address(staking));
        emit SolversStaking.SlashExecuted(AGENT, 6_000_000, treasury, false);
        vm.prank(admin);
        staking.executeSlash(AGENT);

        assertEq(_bal(treasury) - treasuryBefore, 6_000_000);
        assertEq(registry.stakeOf(AGENT), MIN_STAKE - 6_000_000);
        assertEq(registry.stakeOf(AGENT2), MIN_STAKE);
        assertEq(staking.totalStaked(), 2 * uint256(MIN_STAKE) - 6_000_000);
        assertEq(_bal(address(staking)), staking.totalStaked());
        assertEq(staking.slashOf(AGENT).proposedAt, 0);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));

        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversStaking.NoSlash.selector, AGENT));
        staking.executeSlash(AGENT);
    }

    function test_executeSlash_blockedTreasuryDefers() public {
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, 6_000_000);
        vm.warp(p + SLASH_DELAY);
        _blockReceives(treasury);
        uint256 treasuryBefore = _bal(treasury);
        vm.expectEmit(true, false, false, true, address(staking));
        emit SolversStaking.SlashExecuted(AGENT, 6_000_000, treasury, true);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(_bal(treasury), treasuryBefore);
        assertEq(staking.deferredOf(treasury), 6_000_000);
        assertEq(_bal(address(staking)), staking.totalStaked() + staking.totalDeferred());
        _unblockReceives(treasury);
        vm.prank(treasury);
        staking.claim();
        assertEq(_bal(treasury) - treasuryBefore, 6_000_000);
        assertEq(_bal(address(staking)), staking.totalStaked());
    }

    function test_executeSlash_statusTransitions() public {
        // re-approved during the pending proposal: Active → Suspended at execution
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, 1_000_000);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Active));
        vm.warp(p + SLASH_DELAY);
        vm.expectEmit(true, true, false, true, address(registry));
        emit SolversRegistry.AgentStatusChanged(AGENT, AgentStatus.Suspended, admin);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));

        // Retired stays Retired
        _registerActive(creator2, AGENT2);
        _requestExit(AGENT2);
        p = _propose(AGENT2, 1_000_000);
        vm.warp(p + SLASH_DELAY);
        vm.prank(admin);
        staking.executeSlash(AGENT2);
        assertEq(uint8(_status(AGENT2)), uint8(AgentStatus.Retired));

        // Pending → Suspended (not Retired/Suspended)
        bytes32 agent3 = bytes32(bytes16(0x33333333333333333333333333333333));
        _register(creator, agent3, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        p = _propose(agent3, 1_000_000);
        assertEq(uint8(_status(agent3)), uint8(AgentStatus.Pending));
        vm.warp(p + SLASH_DELAY);
        vm.prank(admin);
        staking.executeSlash(agent3);
        assertEq(uint8(_status(agent3)), uint8(AgentStatus.Suspended));
    }

    function test_executeSlash_suspendedEmitsNoStatusChange() public {
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, 1_000_000); // Active → Suspended
        vm.warp(p + SLASH_DELAY);
        vm.recordLogs();
        vm.prank(admin);
        staking.executeSlash(AGENT);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertGt(logs.length, 0);
        for (uint256 i; i < logs.length; ++i) {
            assertTrue(logs[i].topics[0] != SolversRegistry.AgentStatusChanged.selector, "unexpected status change");
        }
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Suspended));
    }

    /// @dev `executeSlash` pays `min(amount, stake)`. While a proposal is pending the stake can only grow (top-ups):
    /// `withdrawStake` is blocked by `SlashPending`, a second proposal is rejected and `proposeSlash` caps
    /// `amount <= stake`. So `amount > stake` is unreachable at execution and the proposed amount is always paid,
    /// never more, even after top-ups.
    function test_executeSlash_minAmountStake_topUpsDoNotIncreaseSlash() public {
        _registerActive(creator, AGENT);
        uint256 p = _propose(AGENT, MIN_STAKE); // the whole stake at proposal time
        _topUp(creator, AGENT, 9_000_000); // allowed while Suspended
        uint40 exitAt = _requestExit(AGENT);
        assertGe(registry.stakeOf(AGENT), staking.slashOf(AGENT).amount);

        vm.warp(p + SLASH_DELAY + SLASH_GRACE); // last second of the execution window (before the exit date)
        uint256 treasuryBefore = _bal(treasury);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(_bal(treasury) - treasuryBefore, MIN_STAKE); // the proposed amount, not the topped-up stake
        assertEq(registry.stakeOf(AGENT), 9_000_000);

        // Retired with an exit: once the exit date passes the creator withdraws the remainder
        vm.warp(exitAt);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(registry.stakeOf(AGENT), 0);
        assertEq(staking.totalStaked(), 0);
        assertEq(_bal(address(staking)), 0);
    }

    function test_executeSlash_fullStakeThenWithdrawPaysZero() public {
        _registerActive(creator, AGENT);
        uint40 exitAt = _requestExit(AGENT);
        uint256 p = _propose(AGENT, MIN_STAKE);
        vm.warp(p + SLASH_DELAY);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(registry.stakeOf(AGENT), 0);
        vm.warp(exitAt);
        uint256 creatorBefore = _bal(creator);
        vm.expectEmit(true, true, false, true, address(staking));
        emit SolversStaking.StakeWithdrawn(AGENT, creator, 0, false);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(_bal(creator), creatorBefore);
        assertEq(staking.stakeExitOf(AGENT).exitAt, 0);
    }

    function test_executeSlash_partialBelowMinStakeBlocksSalesUntilTopUp() public {
        _registerActive(creator, AGENT);
        uint96 cut = 5_000_000;
        uint256 p = _propose(AGENT, cut);
        vm.warp(p + SLASH_DELAY);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        uint96 stake = MIN_STAKE - cut;
        assertEq(registry.stakeOf(AGENT), stake);

        // approveAgent refuses while the stake is short
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, stake, MIN_STAKE));
        registry.approveAgent(AGENT);

        // the top-up must reach minStake exactly
        _topUp(creator, AGENT, cut - 1);
        vm.prank(admin);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, MIN_STAKE - 1, MIN_STAKE));
        registry.approveAgent(AGENT);
        _topUp(creator, AGENT, 1);
        vm.prank(admin);
        registry.approveAgent(AGENT);
        _buy(buyer, AGENT);
        assertEq(registry.getAgent(AGENT).totalSales, 1);
    }

    /// @dev An Active agent whose stake fell below `minStake` cannot sell any kind. Reached by raising `minStake` after
    /// approval (a slash always suspends first) and also after re-approving with a stake that later fell short.
    function test_belowMinStake_activeAgentCannotSell() public {
        _registerActive(creator, AGENT);
        uint96 newMin = MIN_STAKE + 1_000_000;
        vm.prank(admin);
        registry.setConfig(treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, newMin, MIN_PRICE);
        assertEq(uint8(_status(AGENT)), uint8(AgentStatus.Active));

        bytes memory err = abi.encodeWithSelector(SolversRegistry.InsufficientStake.selector, MIN_STAKE, newMin);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectRevert(err);
        license.purchaseLicense(AGENT, PRICE, pid);

        usd.approve(address(credits), 5 * uint256(PRICE_PER_USE));
        pid = _pid();
        vm.expectRevert(err);
        credits.buyCredits(AGENT, 5, 5 * uint256(PRICE_PER_USE), pid);

        SolversEscrow.MilestoneInput[] memory ms = new SolversEscrow.MilestoneInput[](1);
        ms[0] = SolversEscrow.MilestoneInput({amount: 6_000_000, criteriaHash: keccak256("m")});
        usd.approve(address(escrow), 6_000_000);
        pid = _pid();
        vm.expectRevert(err);
        escrow.createEscrow(AGENT, ms, 3600, 0, pid);
        vm.stopPrank();

        _topUp(creator, AGENT, 1_000_000);
        _buy(buyer, AGENT);
        _buyCredits(buyer, AGENT, 5);
    }

    // ================================================================================================= general

    function test_staking_neverPaused() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        vm.prank(admin);
        registry.setPause(PAUSE_MASK);

        _topUp(creator, AGENT, 1_000_000);
        uint40 exitAt = _requestExit(AGENT);
        vm.prank(admin);
        staking.extendStakeExit(AGENT, REASON);
        uint256 p = _propose(AGENT2, 1_000_000);
        vm.prank(creator2);
        staking.contestSlash(AGENT2, CONTEST);
        vm.warp(p + SLASH_DELAY);
        vm.prank(admin);
        staking.executeSlash(AGENT2);
        vm.warp(exitAt + EXIT_DELAY);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(registry.stakeOf(AGENT), 0);
        assertEq(registry.stakeOf(AGENT2), MIN_STAKE - 1_000_000);
    }

    function test_sweepStray_onlyExcess() public {
        _registerActive(creator, AGENT);
        vm.prank(stranger);
        usd.transfer(address(staking), 123);
        vm.prank(stranger);
        vm.expectRevert(_adminErr(stranger));
        staking.sweepStray(stranger);
        uint256 before = _bal(admin);
        vm.prank(admin);
        staking.sweepStray(admin);
        assertEq(_bal(admin) - before, 123);
        assertEq(_bal(address(staking)), staking.totalStaked());
        vm.prank(admin);
        vm.expectRevert(NothingToClaim.selector);
        staking.sweepStray(admin);
    }

    function test_initialize_onlyOnce() public {
        vm.expectRevert(bytes4(keccak256("InvalidInitialization()")));
        staking.initialize(address(registry));
    }

    /// @dev Full lifecycle with warps: exit requested, extended once, slashed (contested), remainder withdrawn.
    function testFuzz_lifecycle(uint96 topUp, uint96 cut, uint8 extensions) public {
        topUp = uint96(bound(topUp, 1, 1_000_000_000));
        uint96 stake = MIN_STAKE + topUp;
        cut = uint96(bound(cut, 1, stake));
        extensions = uint8(bound(extensions, 0, 2));

        _registerActive(creator, AGENT);
        _topUp(creator, AGENT, topUp);
        uint40 exitAt = _requestExit(AGENT);
        for (uint8 i; i < extensions; ++i) {
            vm.prank(admin);
            staking.extendStakeExit(AGENT, REASON);
        }
        uint256 p = _propose(AGENT, cut);
        vm.prank(creator);
        staking.contestSlash(AGENT, CONTEST);
        vm.warp(p + SLASH_DELAY);
        uint256 treasuryBefore = _bal(treasury);
        vm.prank(admin);
        staking.executeSlash(AGENT);
        assertEq(_bal(treasury) - treasuryBefore, cut);

        uint256 due = uint256(exitAt) + uint256(extensions) * EXIT_DELAY;
        assertEq(staking.stakeExitOf(AGENT).exitAt, due);
        vm.warp(due);
        uint256 creatorBefore = _bal(creator);
        vm.prank(creator);
        staking.withdrawStake(AGENT);
        assertEq(_bal(creator) - creatorBefore, stake - cut);
        assertEq(staking.totalStaked(), 0);
        assertEq(_bal(address(staking)), 0);
    }
}
