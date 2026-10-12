// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {SolversSatellite} from "./SolversSatellite.sol";
import {ITIP403ReceivePolicies} from "../interfaces/ISolversSatellites.sol";
import {FeeOnTransferToken, NothingToClaim, RecipientBlocked, ZeroAddress} from "../SolversTypes.sol";

/// @notice Money movement shared by License, Credits, Escrow and Staking (decision D5).
///
/// Shares are pushed straight from the payer to each recipient. If a push cannot be delivered for a recipient-side
/// reason, the amount is pulled into this contract instead and credited to `deferred[recipient]`, claimable only by
/// the recipient (`claim`), so a recipient's wallet policy can never block a sale, a release or a refund:
/// - Tempo TIP-403 receive policies do NOT revert: a blocked transfer succeeds and parks the funds in
///   ReceivePolicyGuard, claimable by the transfer's `from`. We therefore ask `validateReceivePolicy` first and defer
///   instead of letting the share be redirected (where the payer could reclaim it).
/// - Token-level TIP-403 policies and other recipient-side failures revert; the retry into this contract tells them
///   apart from payer-side failures (allowance, balance, a blocked payer), which bubble up.
/// Every deposit into this contract is balance-diff checked and rejects fee-on-transfer tokens.
abstract contract SolversPayouts is SolversSatellite {
    using SafeERC20 for IERC20;

    /// @dev TIP-403 registry precompile (https://tempo.xyz/developers/docs/protocol/tip403/spec).
    address internal constant TIP403_REGISTRY = 0x403c000000000000000000000000000000000000;

    /// @custom:storage-location erc7201:solvers.storage.Payouts
    struct PayoutsStorage {
        mapping(address recipient => uint256 amount) deferred;
        uint256 totalDeferred;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Payouts")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PAYOUTS_STORAGE = 0x9f00fa209ec811eff49a3ea086a37c214558f4cac735a5c8644c011f9848da00;

    event PayoutDeferred(address indexed to, uint256 amount, uint256 total);
    event PayoutClaimed(address indexed to, uint256 amount);
    event StraySwept(address indexed to, uint256 amount);

    function _payoutsStorage() private pure returns (PayoutsStorage storage $) {
        assembly {
            $.slot := PAYOUTS_STORAGE
        }
    }

    /// @notice Amount credited to `recipient` that could not be delivered at payment time.
    function deferredOf(address recipient) external view returns (uint256) {
        return _payoutsStorage().deferred[recipient];
    }

    /// @notice Sum of all deferred credits held by this contract.
    function totalDeferred() public view returns (uint256) {
        return _payoutsStorage().totalDeferred;
    }

    /// @notice Pays the caller's deferred credit. Reverts while the caller's receive policy would redirect it.
    function claim() external nonReentrant {
        PayoutsStorage storage $ = _payoutsStorage();
        uint256 amount = $.deferred[msg.sender];
        if (amount == 0) revert NothingToClaim();
        IERC20 t = paymentToken();
        if (_receiveBlocked(t, address(this), msg.sender)) revert RecipientBlocked(msg.sender);
        $.deferred[msg.sender] = 0;
        $.totalDeferred -= amount;
        emit PayoutClaimed(msg.sender, amount);
        t.safeTransfer(msg.sender, amount);
    }

    /// @notice Sends tokens held here beyond what is owed (locked funds + deferred credits) to `to` (admin only).
    function sweepStray(address to) external nonReentrant onlyRegistryRole(0x00) {
        if (to == address(0)) revert ZeroAddress();
        IERC20 t = paymentToken();
        uint256 balance = t.balanceOf(address(this));
        uint256 owed = _lockedFunds() + _payoutsStorage().totalDeferred;
        if (balance <= owed) revert NothingToClaim();
        uint256 stray = balance - owed;
        emit StraySwept(to, stray);
        t.safeTransfer(to, stray);
    }

    /// @dev Funds this contract holds on behalf of users besides deferred credits (escrow vault, stake vault).
    function _lockedFunds() internal view virtual returns (uint256) {
        return 0;
    }

    /// @dev Pays `amount` from `payer` to `to`; returns true when the amount was deferred instead.
    function _pullTo(address payer, address to, uint256 amount) internal returns (bool deferred) {
        if (amount == 0) return false;
        IERC20 t = paymentToken();
        if (!_receiveBlocked(t, payer, to) && _tryCall(t, abi.encodeCall(IERC20.transferFrom, (payer, to, amount)))) {
            return false;
        }
        _pullIn(payer, amount);
        _defer(to, amount);
        return true;
    }

    /// @dev Pays `amount` from this contract to `to`; returns true when the amount was deferred instead.
    function _payOut(address to, uint256 amount) internal returns (bool deferred) {
        if (amount == 0) return false;
        IERC20 t = paymentToken();
        if (!_receiveBlocked(t, address(this), to) && _tryCall(t, abi.encodeCall(IERC20.transfer, (to, amount)))) {
            return false;
        }
        _defer(to, amount);
        return true;
    }

    /// @dev Pulls `amount` from `payer` into this contract, balance-diff checked (reverts on fee-on-transfer).
    function _pullIn(address payer, uint256 amount) internal {
        IERC20 t = paymentToken();
        uint256 before = t.balanceOf(address(this));
        // `payer` is always authorized by the caller's own action: msg.sender (purchases, top-ups), the royalty-paying
        // owner moving their own NFT (or their approved operator), or the creator inside their own registerAgent call.
        // forge-lint: disable-next-line(arbitrary-send-erc20)
        t.safeTransferFrom(payer, address(this), amount);
        // Exact equality on purpose: anything else is a fee-on-transfer token.
        // forge-lint: disable-next-line(incorrect-strict-equality)
        if (t.balanceOf(address(this)) - before != amount) revert FeeOnTransferToken();
    }

    function _defer(address to, uint256 amount) private {
        PayoutsStorage storage $ = _payoutsStorage();
        uint256 total = $.deferred[to] + amount;
        $.deferred[to] = total;
        $.totalDeferred += amount;
        emit PayoutDeferred(to, amount, total);
    }

    /// @dev Low-level token call that never reverts: true only for a successful call returning `true` (or no data
    /// from a contract, as SafeERC20 accepts).
    function _tryCall(IERC20 t, bytes memory data) private returns (bool) {
        (bool success, bytes memory ret) = address(t).call(data);
        if (!success) return false;
        if (ret.length == 0) return address(t).code.length > 0;
        return ret.length >= 32 && uint256(bytes32(ret)) == 1;
    }

    /// @dev True when `to`'s TIP-403 receive policy would redirect a transfer from `sender`. False when the registry
    /// precompile is absent (non-Tempo chains) or answers unexpectedly.
    function _receiveBlocked(IERC20 t, address sender, address to) internal view returns (bool) {
        // No registry (non-Tempo chain): nothing can redirect a transfer.
        if (TIP403_REGISTRY.code.length == 0) return false;
        (bool success, bytes memory ret) = TIP403_REGISTRY.staticcall(
            abi.encodeCall(ITIP403ReceivePolicies.validateReceivePolicy, (address(t), sender, to))
        );
        // Fail closed: an unexpected answer is treated as blocked, so the amount is deferred (claimable by `to`) instead
        // of risking a silent redirect into ReceivePolicyGuard that no Solvers contract could reclaim.
        if (!success || ret.length < 64) return true;
        return uint256(bytes32(ret)) == 0;
    }
}
