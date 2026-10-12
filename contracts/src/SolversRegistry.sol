// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {
    AccessControlDefaultAdminRulesUpgradeable
} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {
    ISolversRegistry,
    SaleAuth,
    AgentView,
    AgentRegistration,
    Eval,
    Reputation
} from "./interfaces/ISolversRegistry.sol";
import {ISolversStaking} from "./interfaces/ISolversSatellites.sol";
import {SolversMath} from "./libraries/SolversMath.sol";
import {
    AgentStatus,
    SaleKind,
    MAX_BPS,
    MAX_FEE_BPS,
    MAX_TOTAL_ROYALTY_BPS,
    MAX_URI_LEN,
    MAX_VERSION_LEN,
    TOKEN_DECIMALS,
    PAUSE_ENTRIES,
    PAUSE_TRANSFERS,
    PAUSE_MASK,
    VERIFIER_ROLE,
    GUARDIAN_ROLE,
    AgentNotFound,
    NotCreator,
    InvalidAmount,
    ZeroAddress,
    Paused,
    NotSatellite,
    PriceTooLow
} from "./SolversTypes.sol";

/// @dev What `setSatellites` checks on each satellite before wiring it.
interface ISatelliteWiring {
    function registry() external view returns (address);
    function paymentToken() external view returns (address);
}

/// @title SolversRegistry
/// @notice Config, roles, pause bits, agents (Solvers), version-scoped evals, the license supply cap, buyer reputation
/// and the purchase-id ledger. Satellites (License, Credits, Reviews, Escrow, Staking) call `authorizeSale` once per
/// purchase; roles live only here.
contract SolversRegistry is
    Initializable,
    AccessControlDefaultAdminRulesUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransient,
    ISolversRegistry
{
    /// @dev Config slot A: read together by `royaltyParams` and `authorizeSale`.
    struct Config {
        address treasury;
        uint16 feeBps;
        uint16 platformRoyaltyBps;
        uint8 pauseFlags;
    }

    /// @dev Config slot B.
    struct Limits {
        uint96 minStake;
        uint96 minPrice;
    }

    /// @dev 4 fixed slots + 2 strings. Slot 0 is the only slot `authorizeSale` writes for a license sale.
    struct Agent {
        // slot 0
        address creator;
        AgentStatus status;
        uint16 royaltyBps;
        uint32 totalSales;
        uint32 maxSupply; // 0 = unlimited
        // slot 1
        uint96 price;
        uint96 pricePerUse; // 0 = no pay-per-use
        uint32 disputesLost;
        uint32 index;
        // slot 2
        uint96 stake;
        uint40 registeredAt;
        uint40 versionAt;
        // slot 3
        bytes32 versionHash;
        string version;
        string metadataUri;
    }

    /// @custom:storage-location erc7201:solvers.storage.Registry
    struct RegistryStorage {
        Config config;
        Limits limits;
        address token;
        address license;
        address credits;
        address reviews;
        address escrow;
        address staking;
        mapping(bytes32 agentId => Agent) agents;
        bytes32[] agentIds;
        mapping(bytes32 agentId => mapping(bytes32 versionHash => Eval)) evals;
        mapping(address wallet => Reputation) reputations;
        mapping(bytes32 payerPurchaseKey => bytes32 ref) purchaseRefs; // key = keccak256(abi.encode(payer, purchaseId))
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Registry")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REGISTRY_STORAGE = 0xdedf9dd66a9c0a7978a0b5ed684fc272cf0208494205e197ca213a93b8181a00;

    /// @dev 12-byte address prefix of every TIP-20 token (https://tempo.xyz/developers/docs/protocol/tip20/spec).
    bytes12 private constant TIP20_PREFIX = 0x20c000000000000000000000;

    /// @dev A buyer with this many lost disputes cannot open a new guarantee.
    uint32 public constant MAX_BUYER_DISPUTES_LOST = 3;

    // ---- events ----
    event AgentRegistered(
        bytes32 indexed agentId,
        address indexed creator,
        uint32 index,
        string metadataUri,
        string version,
        bytes32 versionHash,
        uint96 price,
        uint96 pricePerUse,
        uint16 royaltyBps,
        uint96 stake
    );
    event AgentStatusChanged(bytes32 indexed agentId, AgentStatus status, address indexed by);
    event AgentVersionUpdated(bytes32 indexed agentId, string version, bytes32 versionHash);
    event AgentMetadataUpdated(bytes32 indexed agentId, string metadataUri);
    event PricingUpdated(bytes32 indexed agentId, uint96 price, uint96 pricePerUse);
    event RoyaltyBpsSet(bytes32 indexed agentId, uint16 royaltyBps);
    event SupplyCapSet(bytes32 indexed agentId, uint32 max);
    event EvalSet(bytes32 indexed agentId, bytes32 indexed versionHash, uint16 scoreBps, bytes32 evalHash, address by);
    event SaleAuthorized(
        bytes32 indexed purchaseId,
        bytes32 indexed agentId,
        address indexed buyer,
        address payer,
        SaleKind kind,
        bytes32 ref
    );
    event ReputationChanged(address indexed wallet, uint32 purchases, uint32 disputesOpened, uint32 disputesLost);
    event AgentDisputeLost(bytes32 indexed agentId, uint32 disputesLost);
    event StakeChanged(bytes32 indexed agentId, uint96 stake);
    event ConfigUpdated(address treasury, uint16 feeBps, uint16 platformRoyaltyBps, uint96 minStake, uint96 minPrice);
    event PauseChanged(address indexed by, uint8 oldFlags, uint8 newFlags);
    event SatellitesSet(address license, address credits, address reviews, address escrow, address staking);

    // ---- errors ----
    error AgentExists(bytes32 agentId);
    error InvalidAgentId();
    error AgentNotActive(bytes32 agentId);
    error AgentNotPending(bytes32 agentId);
    error AgentRetired(bytes32 agentId);
    error InsufficientStake(uint96 stake, uint96 required);
    error StringTooLong();
    error InvalidBps();
    error FeeTooHigh();
    error RoyaltyTooHigh();
    error InvalidPauseFlags();
    error GuardianCannotUnpause();
    error NotPauseAuthority();
    error SoldOut(bytes32 agentId, uint32 max);
    error SupplyCapTooLow();
    error SupplyCapCannotDecrease();
    error RoyaltyLocked();
    error SelfPurchase();
    error PayPerUseDisabled();
    error BuyerNotEligible();
    error InvalidPurchaseId();
    error DuplicatePurchase(bytes32 purchaseId, bytes32 ref);
    error InvalidTreasury();
    error BadToken();
    error SatellitesAlreadySet();
    error AgentIndexOutOfRange(uint32 index);
    error SatelliteMismatch(address satellite);

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @param admin initial (cold) default admin; `adminDelay` is the 2-step admin transfer delay (0 at bootstrap).
    /// @param token_ TIP-20 payment token (must report 6 decimals).
    function initialize(
        address admin,
        uint48 adminDelay,
        address token_,
        address treasury_,
        uint16 feeBps,
        uint16 platformRoyaltyBps,
        uint96 minStake_,
        uint96 minPrice_
    ) external initializer {
        __AccessControlDefaultAdminRules_init(adminDelay, admin);
        if (token_ == address(0)) revert ZeroAddress();
        if (token_.code.length == 0) revert BadToken();
        try IERC20Metadata(token_).decimals() returns (uint8 d) {
            if (d != TOKEN_DECIMALS) revert BadToken();
        } catch {
            revert BadToken();
        }
        RegistryStorage storage $ = _registryStorage();
        $.token = token_;
        _setConfig($, treasury_, feeBps, platformRoyaltyBps, minStake_, minPrice_);
    }

    // =====================================================================================================
    // admin
    // =====================================================================================================

    /// @notice Wires the five satellites, once.
    function setSatellites(address license_, address credits_, address reviews_, address escrow_, address staking_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        RegistryStorage storage $ = _registryStorage();
        if ($.license != address(0)) revert SatellitesAlreadySet();
        if (
            license_ == address(0) || credits_ == address(0) || reviews_ == address(0) || escrow_ == address(0)
                || staking_ == address(0)
        ) revert ZeroAddress();
        address[5] memory wired = [license_, credits_, reviews_, escrow_, staking_];
        for (uint256 i = 0; i < wired.length; ++i) {
            // Each satellite must point back at this Registry and use the same payment token.
            if (
                ISatelliteWiring(wired[i]).registry() != address(this)
                    || ISatelliteWiring(wired[i]).paymentToken() != $.token
            ) {
                revert SatelliteMismatch(wired[i]);
            }
        }
        $.license = license_;
        $.credits = credits_;
        $.reviews = reviews_;
        $.escrow = escrow_;
        $.staking = staking_;
        emit SatellitesSet(license_, credits_, reviews_, escrow_, staking_);
    }

    function setConfig(address treasury_, uint16 feeBps, uint16 platformRoyaltyBps, uint96 minStake_, uint96 minPrice_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _setConfig(_registryStorage(), treasury_, feeBps, platformRoyaltyBps, minStake_, minPrice_);
    }

    /// @notice Admin sets any pause bits; a guardian can only add bits.
    function setPause(uint8 flags) external {
        if (flags & ~PAUSE_MASK != 0) revert InvalidPauseFlags();
        Config storage c = _registryStorage().config;
        uint8 old = c.pauseFlags;
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender)) revert NotPauseAuthority();
            if (flags & old != old) revert GuardianCannotUnpause();
            // TRANSFERS is an admin-only emergency bit (plan §4.0): a guardian cannot add it.
            if ((flags & ~old) & PAUSE_TRANSFERS != 0) revert NotPauseAuthority();
        }
        c.pauseFlags = flags;
        emit PauseChanged(msg.sender, old, flags);
    }

    /// @notice Activates a pending or suspended agent whose stake is complete. A retired agent never comes back here.
    function approveAgent(bytes32 agentId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        RegistryStorage storage $ = _registryStorage();
        Agent storage a = _agent($, agentId);
        if (a.status == AgentStatus.Retired) revert AgentRetired(agentId);
        if (a.status == AgentStatus.Active) revert AgentNotPending(agentId);
        if (a.stake < $.limits.minStake) revert InsufficientStake(a.stake, $.limits.minStake);
        a.status = AgentStatus.Active;
        emit AgentStatusChanged(agentId, AgentStatus.Active, msg.sender);
    }

    /// @notice Kill switch for one agent (never touches a retired agent's exit).
    function suspendAgent(bytes32 agentId) external onlyRole(DEFAULT_ADMIN_ROLE) {
        Agent storage a = _agent(_registryStorage(), agentId);
        if (a.status == AgentStatus.Retired) revert AgentRetired(agentId);
        a.status = AgentStatus.Suspended;
        emit AgentStatusChanged(agentId, AgentStatus.Suspended, msg.sender);
    }

    /// @notice Version-scoped evaluation (D6): stored per (agentId, versionHash), never zeroed by `updateVersion`.
    function setEval(bytes32 agentId, bytes32 versionHash, uint16 scoreBps, bytes32 evalHash)
        external
        onlyRole(VERIFIER_ROLE)
    {
        RegistryStorage storage $ = _registryStorage();
        _agent($, agentId);
        if (scoreBps > MAX_BPS) revert InvalidBps();
        $.evals[agentId][versionHash] =
            Eval({scoreBps: scoreBps, at: uint40(block.timestamp), by: msg.sender, evalHash: evalHash});
        emit EvalSet(agentId, versionHash, scoreBps, evalHash, msg.sender);
    }

    // =====================================================================================================
    // creator
    // =====================================================================================================

    /// @notice Registers a Solver (status Pending until `approveAgent`). Pulls `minStake` from the creator through
    /// SolversStaking (the creator approves the Staking contract first, in the same batched transaction).
    /// `r.agentId` is `bytes32(bytes16(manifest.id))` (D1).
    function registerAgent(AgentRegistration calldata r) external nonReentrant {
        RegistryStorage storage $ = _registryStorage();
        if ($.config.pauseFlags & PAUSE_ENTRIES != 0) revert Paused(PAUSE_ENTRIES);
        bytes32 agentId = r.agentId;
        if (agentId == bytes32(0)) revert InvalidAgentId();
        if ($.agents[agentId].creator != address(0)) revert AgentExists(agentId);
        if (bytes(r.metadataUri).length > MAX_URI_LEN) revert StringTooLong();
        if (bytes(r.version).length > MAX_VERSION_LEN) revert StringTooLong();
        if (r.price < $.limits.minPrice) revert PriceTooLow();
        if (r.pricePerUse > r.price) revert InvalidAmount();
        if (uint256(r.royaltyBps) + $.config.platformRoyaltyBps > MAX_TOTAL_ROYALTY_BPS) revert RoyaltyTooHigh();
        if ($.staking == address(0)) revert NotSatellite();

        uint32 index = uint32($.agentIds.length);
        Agent storage a = $.agents[agentId];
        a.creator = msg.sender;
        a.status = AgentStatus.Pending;
        a.royaltyBps = r.royaltyBps;
        a.price = r.price;
        a.pricePerUse = r.pricePerUse;
        a.index = index;
        a.registeredAt = uint40(block.timestamp);
        a.versionAt = uint40(block.timestamp);
        a.versionHash = r.versionHash;
        a.version = r.version;
        a.metadataUri = r.metadataUri;
        $.agentIds.push(agentId);

        uint96 minStake_ = $.limits.minStake;
        uint96 stake = 0;
        if (minStake_ > 0) {
            stake = ISolversStaking($.staking).pullStake(agentId, msg.sender, minStake_);
            a.stake = stake;
        }
        _emitRegistered(r, index, stake);
    }

    function _emitRegistered(AgentRegistration calldata r, uint32 index, uint96 stake) private {
        emit AgentRegistered(
            r.agentId,
            msg.sender,
            index,
            r.metadataUri,
            r.version,
            r.versionHash,
            r.price,
            r.pricePerUse,
            r.royaltyBps,
            stake
        );
    }

    /// @notice New package version. The eval of the previous version stays recorded under its own versionHash (D6).
    function updateVersion(bytes32 agentId, string calldata version, bytes32 versionHash) external {
        Agent storage a = _creatorAgent(agentId);
        if (bytes(version).length > MAX_VERSION_LEN) revert StringTooLong();
        a.version = version;
        a.versionHash = versionHash;
        a.versionAt = uint40(block.timestamp);
        emit AgentVersionUpdated(agentId, version, versionHash);
    }

    function updateMetadataUri(bytes32 agentId, string calldata metadataUri) external {
        Agent storage a = _creatorAgent(agentId);
        if (bytes(metadataUri).length > MAX_URI_LEN) revert StringTooLong();
        a.metadataUri = metadataUri;
        emit AgentMetadataUpdated(agentId, metadataUri);
    }

    function updatePricing(bytes32 agentId, uint96 price, uint96 pricePerUse) external {
        Agent storage a = _creatorAgent(agentId);
        if (price < _registryStorage().limits.minPrice) revert PriceTooLow();
        if (pricePerUse > price) revert InvalidAmount();
        a.price = price;
        a.pricePerUse = pricePerUse;
        emit PricingUpdated(agentId, price, pricePerUse);
    }

    /// @notice Creator share of the transfer royalty; editable only until the first sale (D15).
    function setRoyaltyBps(bytes32 agentId, uint16 royaltyBps) external {
        Agent storage a = _creatorAgent(agentId);
        if (a.totalSales != 0) revert RoyaltyLocked();
        if (uint256(royaltyBps) + _registryStorage().config.platformRoyaltyBps > MAX_TOTAL_ROYALTY_BPS) {
            revert RoyaltyTooHigh();
        }
        a.royaltyBps = royaltyBps;
        emit RoyaltyBpsSet(agentId, royaltyBps);
    }

    /// @notice License supply cap. From unlimited: `max >= max(1, totalSales)`; afterwards it can only be raised.
    /// The cap counts licenses ever minted: burning or transferring never frees a slot.
    function setSupplyCap(bytes32 agentId, uint32 max) external {
        Agent storage a = _creatorAgent(agentId);
        uint32 current = a.maxSupply;
        if (current == 0) {
            if (max == 0 || max < a.totalSales) revert SupplyCapTooLow();
        } else if (max <= current) {
            revert SupplyCapCannotDecrease();
        }
        a.maxSupply = max;
        emit SupplyCapSet(agentId, max);
    }

    // =====================================================================================================
    // satellites
    // =====================================================================================================

    /// @notice Every shared purchase check, once (License / Credits / Escrow only). Records `(payer, purchaseId)` so the
    /// same id can never settle twice across kinds for the same payer; scoping by payer means nobody can burn the id of
    /// a purchase they do not pay for (e.g. a pending Pix charge fulfilled later by PLATFORM). `ref` is the tokenId,
    /// escrowId or buyer the satellite settles.
    function authorizeSale(
        bytes32 agentId,
        address buyer,
        address payer,
        SaleKind kind,
        bytes32 purchaseId,
        bytes32 ref
    ) external returns (SaleAuth memory auth) {
        RegistryStorage storage $ = _registryStorage();
        if (
            (kind == SaleKind.License && msg.sender != $.license)
                || (kind == SaleKind.Credits && msg.sender != $.credits)
                || (kind == SaleKind.Escrow && msg.sender != $.escrow) || kind == SaleKind.None
                || msg.sender == address(0)
        ) revert NotSatellite();
        Config memory c = $.config;
        if (c.pauseFlags & PAUSE_ENTRIES != 0) revert Paused(PAUSE_ENTRIES);
        if (buyer == address(0)) revert ZeroAddress();
        if (purchaseId == bytes32(0)) revert InvalidPurchaseId();
        bytes32 key = _purchaseKey(payer, purchaseId);
        bytes32 existing = $.purchaseRefs[key];
        if (existing != bytes32(0)) revert DuplicatePurchase(purchaseId, existing);

        Agent storage a = _agent($, agentId);
        if (a.status != AgentStatus.Active) revert AgentNotActive(agentId);
        Limits memory l = $.limits;
        if (a.stake < l.minStake) revert InsufficientStake(a.stake, l.minStake);

        Reputation storage rep = $.reputations[buyer];
        if (kind == SaleKind.License) {
            if (buyer == a.creator) revert SelfPurchase();
            uint32 sold = a.totalSales;
            if (a.maxSupply != 0 && sold >= a.maxSupply) revert SoldOut(agentId, a.maxSupply);
            a.totalSales = sold + 1;
            _bumpPurchases(buyer, rep);
        } else if (kind == SaleKind.Credits) {
            if (buyer == a.creator) revert SelfPurchase();
            if (a.pricePerUse == 0) revert PayPerUseDisabled();
            _bumpPurchases(buyer, rep);
        } else {
            if (rep.disputesLost >= MAX_BUYER_DISPUTES_LOST) revert BuyerNotEligible();
        }

        $.purchaseRefs[key] = bytes32((uint256(uint8(kind)) << 248) | uint256(ref));
        emit SaleAuthorized(purchaseId, agentId, buyer, payer, kind, ref);

        auth = SaleAuth({
            creator: a.creator,
            treasury: c.treasury,
            token: $.token,
            price: a.price,
            pricePerUse: a.pricePerUse,
            feeBps: c.feeBps,
            minPrice: l.minPrice,
            agentIndex: a.index
        });
    }

    function recordDisputeOpened(address buyer) external {
        RegistryStorage storage $ = _registryStorage();
        if (msg.sender != $.escrow || msg.sender == address(0)) revert NotSatellite();
        Reputation storage rep = $.reputations[buyer];
        if (rep.disputesOpened < type(uint32).max) rep.disputesOpened += 1;
        emit ReputationChanged(buyer, rep.purchases, rep.disputesOpened, rep.disputesLost);
    }

    /// @notice Refunded → the agent lost the dispute; otherwise the buyer lost it.
    function recordDisputeOutcome(bytes32 agentId, address buyer, bool refunded) external {
        RegistryStorage storage $ = _registryStorage();
        if (msg.sender != $.escrow || msg.sender == address(0)) revert NotSatellite();
        if (refunded) {
            Agent storage a = _agent($, agentId);
            if (a.disputesLost < type(uint32).max) a.disputesLost += 1;
            emit AgentDisputeLost(agentId, a.disputesLost);
        } else {
            Reputation storage rep = $.reputations[buyer];
            if (rep.disputesLost < type(uint32).max) rep.disputesLost += 1;
            emit ReputationChanged(buyer, rep.purchases, rep.disputesOpened, rep.disputesLost);
        }
    }

    /// @notice Stake mirror, written only by SolversStaking.
    function setStake(bytes32 agentId, uint96 stake) external {
        RegistryStorage storage $ = _registryStorage();
        if (msg.sender != $.staking || msg.sender == address(0)) revert NotSatellite();
        _agent($, agentId).stake = stake;
        emit StakeChanged(agentId, stake);
    }

    /// @notice Status changes driven by the stake lifecycle (exit, cancel, slash), written only by SolversStaking.
    function setStatus(bytes32 agentId, AgentStatus status, address by) external {
        RegistryStorage storage $ = _registryStorage();
        if (msg.sender != $.staking || msg.sender == address(0)) revert NotSatellite();
        _agent($, agentId).status = status;
        emit AgentStatusChanged(agentId, status, by);
    }

    // =====================================================================================================
    // views
    // =====================================================================================================

    function getAgent(bytes32 agentId) external view returns (AgentView memory v) {
        Agent storage a = _agent(_registryStorage(), agentId);
        v = AgentView({
            agentId: agentId,
            creator: a.creator,
            status: a.status,
            royaltyBps: a.royaltyBps,
            totalSales: a.totalSales,
            maxSupply: a.maxSupply,
            price: a.price,
            pricePerUse: a.pricePerUse,
            disputesLost: a.disputesLost,
            index: a.index,
            stake: a.stake,
            registeredAt: a.registeredAt,
            versionAt: a.versionAt,
            versionHash: a.versionHash,
            version: a.version,
            metadataUri: a.metadataUri
        });
    }

    function agentCount() external view returns (uint256) {
        return _registryStorage().agentIds.length;
    }

    function agentIdAt(uint32 index) external view returns (bytes32) {
        bytes32[] storage ids = _registryStorage().agentIds;
        if (index >= ids.length) revert AgentIndexOutOfRange(index);
        return ids[index];
    }

    function agentExists(bytes32 agentId) external view returns (bool) {
        return _registryStorage().agents[agentId].creator != address(0);
    }

    function creatorOf(bytes32 agentId) external view returns (address) {
        return _agent(_registryStorage(), agentId).creator;
    }

    function stakeOf(bytes32 agentId) external view returns (uint96) {
        return _agent(_registryStorage(), agentId).stake;
    }

    function statusOf(bytes32 agentId) external view returns (AgentStatus) {
        return _agent(_registryStorage(), agentId).status;
    }

    /// @notice Eval measured for the agent's current version, if any (`measured == false` otherwise; D6).
    function currentEval(bytes32 agentId) external view returns (bool measured, Eval memory e) {
        RegistryStorage storage $ = _registryStorage();
        Agent storage a = _agent($, agentId);
        e = $.evals[agentId][a.versionHash];
        measured = e.at != 0;
    }

    function evalOf(bytes32 agentId, bytes32 versionHash) external view returns (Eval memory) {
        return _registryStorage().evals[agentId][versionHash];
    }

    /// @notice Transfer royalty parameters for a license of agent `agentIndex` (2 SLOADs). The platform share is
    /// clamped so the total never exceeds 25%.
    function royaltyParams(uint32 agentIndex)
        external
        view
        returns (address creator, uint16 creatorBps, address treasury_, uint16 platformBps, uint8 flags)
    {
        RegistryStorage storage $ = _registryStorage();
        if (agentIndex >= $.agentIds.length) revert AgentIndexOutOfRange(agentIndex);
        Agent storage a = $.agents[$.agentIds[agentIndex]];
        Config memory c = $.config;
        creator = a.creator;
        creatorBps = a.royaltyBps;
        treasury_ = c.treasury;
        platformBps = SolversMath.effectivePlatformBps(creatorBps, c.platformRoyaltyBps);
        flags = c.pauseFlags;
    }

    function paymentParams()
        external
        view
        returns (address token_, address treasury_, uint16 feeBps, uint96 minPrice_)
    {
        RegistryStorage storage $ = _registryStorage();
        return ($.token, $.config.treasury, $.config.feeBps, $.limits.minPrice);
    }

    function config()
        external
        view
        returns (
            address treasury_,
            uint16 feeBps,
            uint16 platformRoyaltyBps,
            uint8 flags,
            uint96 minStake_,
            uint96 minPrice_
        )
    {
        RegistryStorage storage $ = _registryStorage();
        Config memory c = $.config;
        return (c.treasury, c.feeBps, c.platformRoyaltyBps, c.pauseFlags, $.limits.minStake, $.limits.minPrice);
    }

    function satellites()
        external
        view
        returns (address license_, address credits_, address reviews_, address escrow_, address staking_)
    {
        RegistryStorage storage $ = _registryStorage();
        return ($.license, $.credits, $.reviews, $.escrow, $.staking);
    }

    function token() external view returns (address) {
        return _registryStorage().token;
    }

    function treasury() external view returns (address) {
        return _registryStorage().config.treasury;
    }

    function pauseFlags() external view returns (uint8) {
        return _registryStorage().config.pauseFlags;
    }

    function minStake() external view returns (uint96) {
        return _registryStorage().limits.minStake;
    }

    function minPrice() external view returns (uint96) {
        return _registryStorage().limits.minPrice;
    }

    function reputationOf(address wallet) external view returns (Reputation memory) {
        return _registryStorage().reputations[wallet];
    }

    /// @notice `kind << 248 | ref` for a purchase id settled by `payer`, 0 when unused.
    function purchaseRef(address payer, bytes32 purchaseId) external view returns (bytes32) {
        return _registryStorage().purchaseRefs[_purchaseKey(payer, purchaseId)];
    }

    // =====================================================================================================
    // internal
    // =====================================================================================================

    function _registryStorage() private pure returns (RegistryStorage storage $) {
        assembly {
            $.slot := REGISTRY_STORAGE
        }
    }

    function _agent(RegistryStorage storage $, bytes32 agentId) private view returns (Agent storage a) {
        a = $.agents[agentId];
        if (a.creator == address(0)) revert AgentNotFound(agentId);
    }

    function _creatorAgent(bytes32 agentId) private view returns (Agent storage a) {
        a = _agent(_registryStorage(), agentId);
        if (a.creator != msg.sender) revert NotCreator();
    }

    function _purchaseKey(address payer, bytes32 purchaseId) private pure returns (bytes32) {
        return keccak256(abi.encode(payer, purchaseId));
    }

    function _bumpPurchases(address buyer, Reputation storage rep) private {
        if (rep.purchases < type(uint32).max) rep.purchases += 1;
        emit ReputationChanged(buyer, rep.purchases, rep.disputesOpened, rep.disputesLost);
    }

    function _setConfig(
        RegistryStorage storage $,
        address treasury_,
        uint16 feeBps,
        uint16 platformRoyaltyBps,
        uint96 minStake_,
        uint96 minPrice_
    ) private {
        // TIP-20 token addresses (12-byte prefix 0x20c0…) cannot receive TIP-20 transfers (they revert InvalidRecipient),
        // so fees would be deferred to an address that can never claim them.
        if (treasury_ == address(0) || bytes12(bytes20(treasury_)) == TIP20_PREFIX) revert InvalidTreasury();
        if (feeBps > MAX_FEE_BPS) revert FeeTooHigh();
        if (platformRoyaltyBps > MAX_TOTAL_ROYALTY_BPS) revert RoyaltyTooHigh();
        if (minPrice_ == 0) revert InvalidAmount();
        Config storage c = $.config;
        c.treasury = treasury_;
        c.feeBps = feeBps;
        c.platformRoyaltyBps = platformRoyaltyBps;
        $.limits = Limits({minStake: minStake_, minPrice: minPrice_});
        emit ConfigUpdated(treasury_, feeBps, platformRoyaltyBps, minStake_, minPrice_);
    }

    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {}
}
