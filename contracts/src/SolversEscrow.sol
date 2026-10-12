// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";

import {SolversPayouts} from "./base/SolversPayouts.sol";
import {SaleAuth} from "./interfaces/ISolversRegistry.sol";
import {SolversMath} from "./libraries/SolversMath.sol";
import {
    SaleKind,
    MilestoneStatus,
    EscrowStatus,
    MAX_MILESTONES,
    PAUSE_PAYMENTS,
    PLATFORM_ROLE,
    VERIFIER_ROLE,
    InvalidAmount,
    PriceTooLow
} from "./SolversTypes.sol";

/// @title SolversEscrow
/// @notice Milestone guarantees. The buyer locks the total up front; each milestone is released to the creator (minus
/// the fee frozen at creation), refunded to the buyer, or disputed and judged by the admin. The escrow status is
/// derived from the milestones (never stored); terminal states are Completed and Refunded.
contract SolversEscrow is SolversPayouts {
    struct MilestoneInput {
        uint96 amount;
        bytes32 criteriaHash;
    }

    /// @dev Slot 0 holds every state-machine field (warm transitions); criteria at creation, the other hashes later.
    struct Milestone {
        uint96 amount;
        MilestoneStatus status;
        uint40 passedAt;
        uint40 disputedAt;
        bytes32 criteriaHash;
        bytes32 deliverableHash;
        bytes32 disputeReasonHash;
    }

    struct EscrowData {
        // slot 0
        address buyer;
        uint40 deliveryDeadline;
        uint32 reviewWindowSecs;
        uint16 feeBps;
        uint8 milestoneCount;
        // slot 1
        bytes32 agentId;
        // slot 2
        address creator;
        uint96 total;
        Milestone[5] milestones;
    }

    /// @custom:storage-location erc7201:solvers.storage.Escrow
    struct EscrowStorage {
        uint256 nextId;
        uint256 totalLocked;
        mapping(uint256 escrowId => EscrowData) escrows;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Escrow")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant ESCROW_STORAGE = 0x34214e68b974a499e6e40726e1f62f10ad1aaf1ff9aea2ee226dd1443e772300;

    uint32 public constant MIN_REVIEW_WINDOW = 60;
    uint32 public constant MAX_REVIEW_WINDOW = 30 days;
    uint16 public constant DEFAULT_DELIVERY_DAYS = 14;
    uint16 public constant MAX_DELIVERY_DAYS = 60;
    /// @dev After 7 days without a judgment, anyone may refund a disputed, never-delivered milestone.
    uint256 public constant DISPUTE_SLA = 7 days;

    /// @dev Lean on purpose (stack limit): the indexer re-reads milestones, creator, window and deadline via `escrowOf`.
    event EscrowCreated(
        uint256 indexed escrowId,
        bytes32 indexed agentId,
        address indexed buyer,
        address payer,
        uint96 total,
        uint16 feeBps,
        bytes32 purchaseId
    );
    event MilestoneUpdated(
        uint256 indexed escrowId, uint8 indexed index, MilestoneStatus status, address by, bytes32 hash
    );
    event MilestonePaid(
        uint256 indexed escrowId, uint8 index, address indexed creator, uint256 amount, uint256 fee, bool deferred
    );
    event MilestoneRefunded(
        uint256 indexed escrowId, uint8 index, address indexed buyer, uint256 amount, bool deferred
    );
    event DisputeResolved(uint256 indexed escrowId, uint8 index, bool refunded, address by);
    event EscrowStatusChanged(uint256 indexed escrowId, EscrowStatus status);

    error EscrowNotFound(uint256 escrowId);
    error InvalidMilestones();
    error InvalidMilestoneIndex();
    error InvalidMilestoneStatus(MilestoneStatus status);
    error InvalidReviewWindow();
    error InvalidDeliveryDays();
    error NotBuyer();
    error AutoReleaseNotReached(uint256 at);
    error DisputeWindowClosed();
    error DeliveryDeadlineNotReached(uint256 deadline);
    error DisputeSlaNotReached(uint256 at);
    error StaleDisputeNeedsJudgment();

    function initialize(address registry_) external initializer {
        __SolversSatellite_init(registry_);
    }

    // =====================================================================================================
    // create
    // =====================================================================================================

    function createEscrow(
        bytes32 agentId,
        MilestoneInput[] calldata milestones,
        uint32 reviewWindowSecs,
        uint16 deliveryDays,
        bytes32 purchaseId
    ) external nonReentrant returns (uint256 escrowId) {
        return _create(msg.sender, msg.sender, agentId, milestones, reviewWindowSecs, deliveryDays, purchaseId);
    }

    /// @notice Creates a guarantee for `buyer`, funded by the platform float (PLATFORM_ROLE).
    function createEscrowFor(
        address buyer,
        bytes32 agentId,
        MilestoneInput[] calldata milestones,
        uint32 reviewWindowSecs,
        uint16 deliveryDays,
        bytes32 purchaseId
    ) external nonReentrant onlyRegistryRole(PLATFORM_ROLE) returns (uint256 escrowId) {
        return _create(buyer, msg.sender, agentId, milestones, reviewWindowSecs, deliveryDays, purchaseId);
    }

    /// @notice Single-call variant with an EIP-2612 permit for the milestone total.
    function createEscrowWithPermit(
        bytes32 agentId,
        MilestoneInput[] calldata milestones,
        uint32 reviewWindowSecs,
        uint16 deliveryDays,
        bytes32 purchaseId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 escrowId) {
        uint256 total = 0;
        for (uint256 i = 0; i < milestones.length && i < MAX_MILESTONES; ++i) {
            total += milestones[i].amount;
        }
        try IERC20Permit(address(paymentToken())).permit(msg.sender, address(this), total, deadline, v, r, s) {}
            catch {}
        return _create(msg.sender, msg.sender, agentId, milestones, reviewWindowSecs, deliveryDays, purchaseId);
    }

    function _create(
        address buyer,
        address payer,
        bytes32 agentId,
        MilestoneInput[] calldata ms,
        uint32 reviewWindowSecs,
        uint16 deliveryDays,
        bytes32 purchaseId
    ) private returns (uint256 escrowId) {
        if (ms.length == 0 || ms.length > MAX_MILESTONES) revert InvalidMilestones();
        if (reviewWindowSecs < MIN_REVIEW_WINDOW || reviewWindowSecs > MAX_REVIEW_WINDOW) revert InvalidReviewWindow();
        if (deliveryDays > MAX_DELIVERY_DAYS) revert InvalidDeliveryDays();

        EscrowStorage storage $ = _escrowStorage();
        escrowId = ++$.nextId;
        SaleAuth memory auth =
            registry().authorizeSale(agentId, buyer, payer, SaleKind.Escrow, purchaseId, bytes32(escrowId));
        EscrowData storage e = $.escrows[escrowId];
        uint96 total = _writeMilestones(e, ms);
        if (total < auth.minPrice) revert PriceTooLow();
        _writeHeader(e, buyer, agentId, auth, reviewWindowSecs, deliveryDays, total);
        $.totalLocked += total;

        emit EscrowCreated(escrowId, agentId, buyer, payer, total, auth.feeBps, purchaseId);
        _pullIn(payer, total);
    }

    function _writeMilestones(EscrowData storage e, MilestoneInput[] calldata ms) private returns (uint96) {
        uint256 total = 0;
        for (uint256 i = 0; i < ms.length; ++i) {
            uint96 amount = ms[i].amount;
            // Bounded loop (<= MAX_MILESTONES, checked by the caller); one bad milestone rejects the whole escrow.
            // forge-lint: disable-next-line(require-revert-in-loop)
            if (amount == 0) revert InvalidAmount();
            total += amount;
            Milestone storage m = e.milestones[i];
            m.amount = amount;
            m.criteriaHash = ms[i].criteriaHash;
        }
        if (total > type(uint96).max) revert InvalidAmount();
        e.milestoneCount = uint8(ms.length);
        return uint96(total);
    }

    function _writeHeader(
        EscrowData storage e,
        address buyer,
        bytes32 agentId,
        SaleAuth memory auth,
        uint32 reviewWindowSecs,
        uint16 deliveryDays,
        uint96 total
    ) private {
        uint256 days_ = deliveryDays == 0 ? DEFAULT_DELIVERY_DAYS : deliveryDays;
        e.buyer = buyer;
        e.deliveryDeadline = uint40(block.timestamp + days_ * 1 days);
        e.reviewWindowSecs = reviewWindowSecs;
        e.feeBps = auth.feeBps; // frozen: a later setConfig never changes what the creator receives
        e.agentId = agentId;
        e.creator = auth.creator;
        e.total = total;
    }

    // =====================================================================================================
    // milestone lifecycle
    // =====================================================================================================

    /// @notice The verifier marks a delivered milestone as passing its tests (never paused: it moves no money).
    function markPassed(uint256 escrowId, uint8 index, bytes32 deliverableHash)
        external
        onlyRegistryRole(VERIFIER_ROLE)
    {
        (EscrowData storage e, Milestone storage m) = _milestone(escrowId, index);
        if (m.status != MilestoneStatus.Pending) revert InvalidMilestoneStatus(m.status);
        EscrowStatus before = _statusOf(e);
        m.status = MilestoneStatus.Passed;
        m.passedAt = uint40(block.timestamp);
        m.deliverableHash = deliverableHash;
        emit MilestoneUpdated(escrowId, index, MilestoneStatus.Passed, msg.sender, deliverableHash);
        _emitStatusIfChanged(escrowId, e, before);
    }

    /// @notice Pays a milestone to the creator: the buyer at any time (Pending or Passed), anyone once the review
    /// window after `passedAt` has elapsed.
    function releaseMilestone(uint256 escrowId, uint8 index) external nonReentrant {
        _requireNotPaused(PAUSE_PAYMENTS);
        (EscrowData storage e, Milestone storage m) = _milestone(escrowId, index);
        if (msg.sender == e.buyer) {
            if (m.status != MilestoneStatus.Pending && m.status != MilestoneStatus.Passed) {
                revert InvalidMilestoneStatus(m.status);
            }
        } else {
            if (m.status != MilestoneStatus.Passed) revert InvalidMilestoneStatus(m.status);
            uint256 at = uint256(m.passedAt) + e.reviewWindowSecs;
            if (block.timestamp < at) revert AutoReleaseNotReached(at);
        }
        EscrowStatus before = _statusOf(e);
        m.status = MilestoneStatus.Approved;
        emit MilestoneUpdated(escrowId, index, MilestoneStatus.Approved, msg.sender, bytes32(0));
        _payCreator(escrowId, e, index, m.amount);
        _emitStatusIfChanged(escrowId, e, before);
    }

    /// @notice The buyer disputes a Pending milestone, or a Passed one before its review window closes.
    function openDispute(uint256 escrowId, uint8 index, bytes32 reasonHash) external nonReentrant {
        (EscrowData storage e, Milestone storage m) = _milestone(escrowId, index);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (m.status == MilestoneStatus.Passed) {
            if (block.timestamp >= uint256(m.passedAt) + e.reviewWindowSecs) revert DisputeWindowClosed();
        } else if (m.status != MilestoneStatus.Pending) {
            revert InvalidMilestoneStatus(m.status);
        }
        EscrowStatus before = _statusOf(e);
        m.status = MilestoneStatus.Disputed;
        m.disputeReasonHash = reasonHash;
        m.disputedAt = uint40(block.timestamp);
        emit MilestoneUpdated(escrowId, index, MilestoneStatus.Disputed, msg.sender, reasonHash);
        _emitStatusIfChanged(escrowId, e, before);
        registry().recordDisputeOpened(e.buyer);
    }

    /// @notice Admin judgment: refund (full amount to the buyer, no fee; the agent loses the dispute) or pay the
    /// creator (with fee; the buyer loses the dispute).
    function resolveDispute(uint256 escrowId, uint8 index, bool refund) external nonReentrant onlyRegistryRole(0x00) {
        _requireNotPaused(PAUSE_PAYMENTS);
        (EscrowData storage e, Milestone storage m) = _milestone(escrowId, index);
        if (m.status != MilestoneStatus.Disputed) revert InvalidMilestoneStatus(m.status);
        EscrowStatus before = _statusOf(e);
        MilestoneStatus next = refund ? MilestoneStatus.Refunded : MilestoneStatus.Approved;
        m.status = next;
        emit MilestoneUpdated(escrowId, index, next, msg.sender, bytes32(0));
        emit DisputeResolved(escrowId, index, refund, msg.sender);
        registry().recordDisputeOutcome(e.agentId, e.buyer, refund);
        if (refund) {
            _refundBuyer(escrowId, e, index, m.amount);
        } else {
            _payCreator(escrowId, e, index, m.amount);
        }
        _emitStatusIfChanged(escrowId, e, before);
    }

    /// @notice After the delivery deadline the buyer recovers a milestone that was never delivered (no fee).
    function cancelUndelivered(uint256 escrowId, uint8 index) external nonReentrant {
        (EscrowData storage e, Milestone storage m) = _milestone(escrowId, index);
        if (msg.sender != e.buyer) revert NotBuyer();
        if (m.status != MilestoneStatus.Pending) revert InvalidMilestoneStatus(m.status);
        if (block.timestamp <= e.deliveryDeadline) revert DeliveryDeadlineNotReached(e.deliveryDeadline);
        EscrowStatus before = _statusOf(e);
        m.status = MilestoneStatus.Refunded;
        emit MilestoneUpdated(escrowId, index, MilestoneStatus.Refunded, msg.sender, bytes32(0));
        _refundBuyer(escrowId, e, index, m.amount);
        _emitStatusIfChanged(escrowId, e, before);
    }

    /// @notice Anyone refunds a disputed milestone that never passed, once the admin missed the 7-day SLA and the
    /// delivery deadline is over. No reputation change (nobody lost the dispute).
    function resolveStaleDispute(uint256 escrowId, uint8 index) external nonReentrant {
        (EscrowData storage e, Milestone storage m) = _milestone(escrowId, index);
        if (m.status != MilestoneStatus.Disputed) revert InvalidMilestoneStatus(m.status);
        if (m.passedAt != 0) revert StaleDisputeNeedsJudgment();
        uint256 due = uint256(m.disputedAt) + DISPUTE_SLA;
        if (block.timestamp < due) revert DisputeSlaNotReached(due);
        if (block.timestamp <= e.deliveryDeadline) revert DeliveryDeadlineNotReached(e.deliveryDeadline);
        EscrowStatus before = _statusOf(e);
        m.status = MilestoneStatus.Refunded;
        emit MilestoneUpdated(escrowId, index, MilestoneStatus.Refunded, msg.sender, bytes32(0));
        emit DisputeResolved(escrowId, index, true, msg.sender);
        _refundBuyer(escrowId, e, index, m.amount);
        _emitStatusIfChanged(escrowId, e, before);
    }

    // =====================================================================================================
    // views
    // =====================================================================================================

    function escrowOf(uint256 escrowId)
        external
        view
        returns (
            address buyer,
            bytes32 agentId,
            address creator,
            uint96 total,
            uint16 feeBps,
            uint32 reviewWindowSecs,
            uint40 deliveryDeadline,
            Milestone[] memory milestones
        )
    {
        EscrowData storage e = _escrow(escrowId);
        uint256 n = e.milestoneCount;
        milestones = new Milestone[](n);
        for (uint256 i; i < n; ++i) {
            milestones[i] = e.milestones[i];
        }
        return (e.buyer, e.agentId, e.creator, e.total, e.feeBps, e.reviewWindowSecs, e.deliveryDeadline, milestones);
    }

    function statusOf(uint256 escrowId) external view returns (EscrowStatus) {
        return _statusOf(_escrow(escrowId));
    }

    /// @notice When the most recently passed milestone becomes releasable by anyone (0 when none is Passed).
    function autoReleaseAt(uint256 escrowId) external view returns (uint256 at) {
        EscrowData storage e = _escrow(escrowId);
        for (uint256 i; i < e.milestoneCount; ++i) {
            Milestone storage m = e.milestones[i];
            if (m.status == MilestoneStatus.Passed) {
                uint256 t = uint256(m.passedAt) + e.reviewWindowSecs;
                if (t > at) at = t;
            }
        }
    }

    /// @notice Tokens locked in open milestones (excludes deferred credits).
    function lockedBalance() external view returns (uint256) {
        return _escrowStorage().totalLocked;
    }

    function escrowCount() external view returns (uint256) {
        return _escrowStorage().nextId;
    }

    // =====================================================================================================
    // internal
    // =====================================================================================================

    function _payCreator(uint256 escrowId, EscrowData storage e, uint8 index, uint96 amount) private {
        _escrowStorage().totalLocked -= amount;
        (uint256 fee, uint256 rest) = SolversMath.feeSplit(amount, e.feeBps);
        _payOut(registry().treasury(), fee);
        bool deferred = _payOut(e.creator, rest);
        emit MilestonePaid(escrowId, index, e.creator, amount, fee, deferred);
    }

    function _refundBuyer(uint256 escrowId, EscrowData storage e, uint8 index, uint96 amount) private {
        _escrowStorage().totalLocked -= amount;
        bool deferred = _payOut(e.buyer, amount);
        emit MilestoneRefunded(escrowId, index, e.buyer, amount, deferred);
    }

    /// @dev Exactly `Escrow::refresh_status` of the previous program.
    function _statusOf(EscrowData storage e) private view returns (EscrowStatus) {
        bool allDone = true;
        bool anyDisputed = false;
        bool allRefunded = true;
        for (uint256 i; i < e.milestoneCount; ++i) {
            MilestoneStatus s = e.milestones[i].status;
            if (s != MilestoneStatus.Approved && s != MilestoneStatus.Refunded) allDone = false;
            if (s == MilestoneStatus.Disputed) anyDisputed = true;
            if (s != MilestoneStatus.Refunded) allRefunded = false;
        }
        if (allRefunded) return EscrowStatus.Refunded;
        if (allDone) return EscrowStatus.Completed;
        if (anyDisputed) return EscrowStatus.Disputed;
        return EscrowStatus.Active;
    }

    function _emitStatusIfChanged(uint256 escrowId, EscrowData storage e, EscrowStatus before) private {
        EscrowStatus after_ = _statusOf(e);
        if (after_ != before) emit EscrowStatusChanged(escrowId, after_);
    }

    function _escrow(uint256 escrowId) private view returns (EscrowData storage e) {
        e = _escrowStorage().escrows[escrowId];
        if (e.buyer == address(0)) revert EscrowNotFound(escrowId);
    }

    function _milestone(uint256 escrowId, uint8 index)
        private
        view
        returns (EscrowData storage e, Milestone storage m)
    {
        e = _escrow(escrowId);
        if (index >= e.milestoneCount) revert InvalidMilestoneIndex();
        m = e.milestones[index];
    }

    function _lockedFunds() internal view override returns (uint256) {
        return _escrowStorage().totalLocked;
    }

    function _escrowStorage() private pure returns (EscrowStorage storage $) {
        assembly {
            $.slot := ESCROW_STORAGE
        }
    }
}
