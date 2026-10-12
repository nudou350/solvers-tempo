// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

import {SolversPayouts} from "./base/SolversPayouts.sol";
import {ISolversStaking} from "./interfaces/ISolversSatellites.sol";
import {AgentStatus, InvalidAmount, NotCreator, NotSatellite} from "./SolversTypes.sol";

/// @title SolversStaking
/// @notice Creator stake custody. Exit: the creator asks to leave (agent → Retired), waits 30 days (the admin may extend
/// twice by 30 days) and withdraws, unless a slash is pending. Slash: the admin proposes, waits 72 h, then may execute
/// within 14 days (`min(amount, stake)` goes to the treasury); the creator may contest once (evidence only) and may
/// cancel an expired proposal. None of these functions is paused. `Agent.stake` in the Registry is the mirror written
/// only by this contract.
contract SolversStaking is SolversPayouts, ISolversStaking {
    struct StakeExit {
        uint40 exitAt; // 0 = no exit requested
        uint40 requestedAt;
        uint8 extensions;
    }

    struct Slash {
        uint96 amount;
        uint40 proposedAt; // 0 = no proposal
        uint40 contestedAt;
        bytes32 reasonHash;
        bytes32 contestHash;
    }

    /// @custom:storage-location erc7201:solvers.storage.Staking
    struct StakingStorage {
        uint256 totalStaked;
        mapping(bytes32 agentId => StakeExit) exits;
        mapping(bytes32 agentId => Slash) slashes;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Staking")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STAKING_STORAGE = 0xa4fa87ffa45915befcec6196edc51215febf1a443d4d615d9660719b253cc300;

    uint256 public constant STAKE_EXIT_DELAY = 30 days;
    uint8 public constant MAX_STAKE_EXIT_EXTENSIONS = 2;
    uint256 public constant SLASH_DELAY = 72 hours;
    uint256 public constant SLASH_EXPIRY_GRACE = 14 days;

    event StakePulled(bytes32 indexed agentId, address indexed creator, uint96 amount);
    event StakeToppedUp(bytes32 indexed agentId, address indexed creator, uint96 amount, uint96 stake);
    event StakeExitRequested(bytes32 indexed agentId, address indexed creator, uint40 exitAt);
    event StakeExitExtended(bytes32 indexed agentId, uint40 exitAt, uint8 extensions, bytes32 reasonHash);
    event StakeExitCancelled(bytes32 indexed agentId, address indexed creator);
    event StakeWithdrawn(bytes32 indexed agentId, address indexed creator, uint96 amount, bool deferred);
    event SlashProposed(
        bytes32 indexed agentId, uint96 amount, bytes32 reasonHash, uint40 executableAt, uint40 expiresAt
    );
    event SlashContested(bytes32 indexed agentId, bytes32 contestHash);
    event SlashCancelled(bytes32 indexed agentId, uint96 amount, address indexed by);
    event SlashExecuted(bytes32 indexed agentId, uint96 amount, address treasury, bool deferred);

    error AgentRetired(bytes32 agentId);
    error AgentNotRetired(bytes32 agentId);
    error NoStakeExit(bytes32 agentId);
    error StakeExitNotReached(uint256 exitAt);
    error StakeExitExtensionsExhausted();
    error StakeExitAlreadyExtended();
    error SlashPending(bytes32 agentId);
    error NoSlash(bytes32 agentId);
    error SlashDelayNotReached(uint256 executableAt);
    error SlashExpired(uint256 expiredAt);
    error SlashNotExpired(uint256 expiresAt);
    error SlashAlreadyContested();
    error InsufficientStake(uint96 stake, uint96 amount);
    error NotAdmin();

    function initialize(address registry_) external initializer {
        __SolversSatellite_init(registry_);
    }

    // =====================================================================================================
    // stake in
    // =====================================================================================================

    /// @inheritdoc ISolversStaking
    function pullStake(bytes32 agentId, address creator, uint96 amount) external nonReentrant returns (uint96) {
        if (msg.sender != address(registry())) revert NotSatellite();
        _pullIn(creator, amount);
        _stakingStorage().totalStaked += amount;
        emit StakePulled(agentId, creator, amount);
        return amount;
    }

    function topUpStake(bytes32 agentId, uint96 amount) external nonReentrant {
        if (amount == 0) revert InvalidAmount();
        _onlyCreator(agentId);
        // A retired agent is leaving (or already withdrew): new stake could never be withdrawn again.
        if (registry().statusOf(agentId) == AgentStatus.Retired) revert AgentRetired(agentId);
        uint96 stake = registry().stakeOf(agentId);
        uint256 next = uint256(stake) + amount;
        if (next > type(uint96).max) revert InvalidAmount();
        _stakingStorage().totalStaked += amount;
        registry().setStake(agentId, uint96(next));
        emit StakeToppedUp(agentId, msg.sender, amount, uint96(next));
        _pullIn(msg.sender, amount);
    }

    // =====================================================================================================
    // exit
    // =====================================================================================================

    function requestStakeExit(bytes32 agentId) external {
        _onlyCreator(agentId);
        if (registry().statusOf(agentId) == AgentStatus.Retired) revert AgentRetired(agentId);
        uint40 exitAt = uint40(block.timestamp + STAKE_EXIT_DELAY);
        _stakingStorage().exits[agentId] =
            StakeExit({exitAt: exitAt, requestedAt: uint40(block.timestamp), extensions: 0});
        emit StakeExitRequested(agentId, msg.sender, exitAt);
        registry().setStatus(agentId, AgentStatus.Retired, msg.sender);
    }

    /// @notice Admin adds 30 days to a pending exit (open report or dispute), at most twice.
    function extendStakeExit(bytes32 agentId, bytes32 reasonHash) external onlyRegistryRole(0x00) {
        StakeExit storage x = _exit(agentId);
        if (x.extensions >= MAX_STAKE_EXIT_EXTENSIONS) revert StakeExitExtensionsExhausted();
        x.exitAt = uint40(uint256(x.exitAt) + STAKE_EXIT_DELAY);
        x.extensions += 1;
        emit StakeExitExtended(agentId, x.exitAt, x.extensions, reasonHash);
    }

    /// @notice The creator gives up the exit (agent → Suspended; reactivation needs `approveAgent`). Not allowed after
    /// an admin extension (re-requesting would reset the wait).
    function cancelStakeExit(bytes32 agentId) external {
        _onlyCreator(agentId);
        if (registry().statusOf(agentId) != AgentStatus.Retired) revert AgentNotRetired(agentId);
        StakeExit storage x = _exit(agentId);
        if (x.extensions != 0) revert StakeExitAlreadyExtended();
        delete _stakingStorage().exits[agentId];
        emit StakeExitCancelled(agentId, msg.sender);
        registry().setStatus(agentId, AgentStatus.Suspended, msg.sender);
    }

    /// @notice Withdraws the whole stake once the exit date passed and no slash is pending.
    function withdrawStake(bytes32 agentId) external nonReentrant {
        _onlyCreator(agentId);
        if (registry().statusOf(agentId) != AgentStatus.Retired) revert AgentNotRetired(agentId);
        StakingStorage storage $ = _stakingStorage();
        StakeExit storage x = _exit(agentId);
        if (block.timestamp < x.exitAt) revert StakeExitNotReached(x.exitAt);
        if ($.slashes[agentId].proposedAt != 0) revert SlashPending(agentId);
        uint96 amount = registry().stakeOf(agentId);
        delete $.exits[agentId];
        $.totalStaked -= amount;
        registry().setStake(agentId, 0);
        bool deferred = _payOut(msg.sender, amount);
        emit StakeWithdrawn(agentId, msg.sender, amount, deferred);
    }

    // =====================================================================================================
    // slash
    // =====================================================================================================

    /// @notice Admin proposes to slash `amount` of the stake. An Active agent becomes Suspended right away.
    function proposeSlash(bytes32 agentId, uint96 amount, bytes32 reasonHash) external onlyRegistryRole(0x00) {
        StakingStorage storage $ = _stakingStorage();
        if ($.slashes[agentId].proposedAt != 0) revert SlashPending(agentId);
        if (amount == 0) revert InvalidAmount();
        uint96 stake = registry().stakeOf(agentId);
        if (amount > stake) revert InsufficientStake(stake, amount);
        $.slashes[agentId] = Slash({
            amount: amount,
            proposedAt: uint40(block.timestamp),
            contestedAt: 0,
            reasonHash: reasonHash,
            contestHash: bytes32(0)
        });
        emit SlashProposed(
            agentId,
            amount,
            reasonHash,
            uint40(block.timestamp + SLASH_DELAY),
            uint40(block.timestamp + SLASH_DELAY + SLASH_EXPIRY_GRACE)
        );
        if (registry().statusOf(agentId) == AgentStatus.Active) {
            registry().setStatus(agentId, AgentStatus.Suspended, msg.sender);
        }
    }

    /// @notice The creator records a contest (evidence only; the admin decides). Once per proposal.
    function contestSlash(bytes32 agentId, bytes32 contestHash) external {
        _onlyCreator(agentId);
        Slash storage s = _slash(agentId);
        if (s.contestedAt != 0) revert SlashAlreadyContested();
        s.contestedAt = uint40(block.timestamp);
        s.contestHash = contestHash;
        emit SlashContested(agentId, contestHash);
    }

    /// @notice The admin cancels at any time; the creator only after the proposal expired. The agent stays suspended
    /// until `approveAgent`.
    function cancelSlash(bytes32 agentId) external {
        Slash storage s = _slash(agentId);
        if (!_isAdmin(msg.sender)) {
            if (registry().creatorOf(agentId) != msg.sender) revert NotAdmin();
            uint256 expiry = _expiry(s);
            if (block.timestamp < expiry) revert SlashNotExpired(expiry);
        }
        uint96 amount = s.amount;
        delete _stakingStorage().slashes[agentId];
        emit SlashCancelled(agentId, amount, msg.sender);
    }

    /// @notice Executes a proposal inside its window: `min(amount, stake)` goes to the treasury.
    function executeSlash(bytes32 agentId) external nonReentrant onlyRegistryRole(0x00) {
        StakingStorage storage $ = _stakingStorage();
        Slash storage s = _slash(agentId);
        uint256 executableAt = uint256(s.proposedAt) + SLASH_DELAY;
        if (block.timestamp < executableAt) revert SlashDelayNotReached(executableAt);
        uint256 expiry = _expiry(s);
        if (block.timestamp > expiry) revert SlashExpired(expiry);
        uint96 stake = registry().stakeOf(agentId);
        uint96 amount = s.amount < stake ? s.amount : stake;
        delete $.slashes[agentId];
        $.totalStaked -= amount;
        registry().setStake(agentId, stake - amount);
        AgentStatus status = registry().statusOf(agentId);
        if (status != AgentStatus.Retired && status != AgentStatus.Suspended) {
            registry().setStatus(agentId, AgentStatus.Suspended, msg.sender);
        }
        address treasury = registry().treasury();
        bool deferred = _payOut(treasury, amount);
        emit SlashExecuted(agentId, amount, treasury, deferred);
    }

    // =====================================================================================================
    // views
    // =====================================================================================================

    function totalStaked() external view returns (uint256) {
        return _stakingStorage().totalStaked;
    }

    function stakeExitOf(bytes32 agentId) external view returns (StakeExit memory) {
        return _stakingStorage().exits[agentId];
    }

    function slashOf(bytes32 agentId) external view returns (Slash memory) {
        return _stakingStorage().slashes[agentId];
    }

    // =====================================================================================================
    // internal
    // =====================================================================================================

    function _onlyCreator(bytes32 agentId) private view {
        if (registry().creatorOf(agentId) != msg.sender) revert NotCreator();
    }

    function _isAdmin(address account) private view returns (bool) {
        return IAccessControl(address(registry())).hasRole(0x00, account);
    }

    function _exit(bytes32 agentId) private view returns (StakeExit storage x) {
        x = _stakingStorage().exits[agentId];
        if (x.exitAt == 0) revert NoStakeExit(agentId);
    }

    function _slash(bytes32 agentId) private view returns (Slash storage s) {
        s = _stakingStorage().slashes[agentId];
        if (s.proposedAt == 0) revert NoSlash(agentId);
    }

    /// @dev Last second at which the proposal can still be executed (and first at which the creator may cancel it).
    function _expiry(Slash storage s) private view returns (uint256) {
        return uint256(s.proposedAt) + SLASH_DELAY + SLASH_EXPIRY_GRACE;
    }

    function _lockedFunds() internal view override returns (uint256) {
        return _stakingStorage().totalStaked;
    }

    function _stakingStorage() private pure returns (StakingStorage storage $) {
        assembly {
            $.slot := STAKING_STORAGE
        }
    }
}
