// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {ITIP403Registry} from "tempo-std/interfaces/ITIP403Registry.sol";

import {IReceivePolicies} from "../utils/SolversTestBase.sol";
import {SolversRegistry} from "../../src/SolversRegistry.sol";
import {SolversLicense} from "../../src/SolversLicense.sol";
import {SolversCredits} from "../../src/SolversCredits.sol";
import {SolversReviews} from "../../src/SolversReviews.sol";
import {SolversEscrow} from "../../src/SolversEscrow.sol";
import {SolversStaking} from "../../src/SolversStaking.sol";
import {SolversPayouts} from "../../src/base/SolversPayouts.sol";
import {AgentRegistration, AgentView} from "../../src/interfaces/ISolversRegistry.sol";
import {AgentStatus, MilestoneStatus, RecipientBlocked} from "../../src/SolversTypes.sol";

/// @notice Multi-actor handler for the Solvers invariants. Every action models its preconditions so that, with
/// `fail_on_revert = true`, any unexpected revert fails the campaign; paths that MUST revert are wrapped in try/catch
/// and an unexpected success is recorded in `violation`. Ghost ledgers are built from events and balance deltas.
contract SolversInvariantHandler is CommonBase, StdUtils {
    uint256 internal constant MAX_AGENTS = 6;
    uint256 internal constant MAX_TOKENS = 120;
    uint256 internal constant MAX_ESCROWS = 60;

    bytes32 internal constant LICENSE_PURCHASED =
        keccak256("LicensePurchased(bytes32,address,uint256,address,uint96,uint96,uint96,bytes32,bool,bool)");
    bytes32 internal constant CREDITS_BOUGHT = keccak256(
        "CreditsBought(bytes32,address,address,uint32,uint256,uint256,uint256,bytes32,uint32,uint32,bool,bool)"
    );
    bytes32 internal constant ROYALTY_PAID =
        keccak256("RoyaltyPaid(uint256,address,address,address,uint256,uint256,bool,bool)");

    SolversRegistry internal immutable registry;
    SolversLicense internal immutable license;
    SolversCredits internal immutable credits;
    SolversReviews internal immutable reviews;
    SolversEscrow internal immutable escrow;
    SolversStaking internal immutable staking;
    IERC20 internal immutable usd;
    address internal immutable admin;
    address internal immutable treasury;
    address internal immutable platform;
    address internal immutable verifier;
    address internal immutable stranger;

    address[] internal creators;
    address[] internal buyers;
    address[] internal receivers; // creators + buyers + treasury (receive-policy targets, claimers)

    // ---- ghosts: catalog ----
    bytes32[] public agentIds;
    mapping(bytes32 agentId => uint32) public salesSeen;
    mapping(bytes32 agentId => uint32) public ghostMinted;

    // ---- ghosts: licenses ----
    uint256[] public tokenIds;
    mapping(uint256 tokenId => address) public ghostOwner;
    mapping(uint256 tokenId => bytes32) public tokenAgent;
    mapping(uint256 tokenId => bool) public burned;
    mapping(uint256 tokenId => uint64) public tokenReviewId;

    // ---- ghosts: purchase ids ----
    bytes32[] public pids;
    mapping(bytes32 pid => bytes32) public expectedRef;
    mapping(bytes32 pid => address) public expectedPayer;
    mapping(bytes32 ref => bytes32) internal refPid; // License / Escrow refs only
    uint256 internal nonce;

    // ---- ghosts: money ledgers ----
    uint256 public licensePriceSum; // Σ price over LicensePurchased
    uint256 public licenseSplitSum; // Σ (fee + creatorAmount) over LicensePurchased
    uint256 public licensePaidSum; // Σ payer balance decrease
    uint256 public licenseReceivedSum; // Σ (creator + treasury) balance + deferred increase
    uint256 public creditsTotalSum;
    uint256 public creditsSplitSum;
    uint256 public creditsPaidSum;
    uint256 public creditsReceivedSum;
    uint256 public royaltyQuotedSum;
    uint256 public royaltyEventSum;
    uint256 public royaltyReceivedSum;
    uint256 public escrowDeposited;
    uint256 public escrowReleased;
    uint256 public escrowRefunded;
    uint256 public stakeIn;
    uint256 public stakeWithdrawn;
    uint256 public stakeSlashed;

    // ---- ghosts: reviews ----
    mapping(bytes32 agentId => address[]) internal authors;
    mapping(bytes32 agentId => mapping(address author => uint8)) public ghostRating;

    // ---- receive policies ----
    mapping(address => bool) public blocked;

    string public violation;
    mapping(bytes32 => uint256) public calls;

    constructor(
        SolversRegistry registry_,
        SolversLicense license_,
        SolversCredits credits_,
        SolversReviews reviews_,
        SolversEscrow escrow_,
        SolversStaking staking_,
        address[5] memory roles, // admin, treasury, platform, verifier, stranger
        address[] memory creators_,
        address[] memory buyers_
    ) {
        registry = registry_;
        license = license_;
        credits = credits_;
        reviews = reviews_;
        escrow = escrow_;
        staking = staking_;
        usd = IERC20(registry_.token());
        admin = roles[0];
        treasury = roles[1];
        platform = roles[2];
        verifier = roles[3];
        stranger = roles[4];
        creators = creators_;
        buyers = buyers_;
        for (uint256 i; i < creators_.length; ++i) {
            receivers.push(creators_[i]);
        }
        for (uint256 i; i < buyers_.length; ++i) {
            receivers.push(buyers_[i]);
        }
        receivers.push(roles[1]);
    }

    // =====================================================================================================
    // views for the invariant contract
    // =====================================================================================================

    function agentCount() external view returns (uint256) {
        return agentIds.length;
    }

    function tokenCount() external view returns (uint256) {
        return tokenIds.length;
    }

    function pidCount() external view returns (uint256) {
        return pids.length;
    }

    function authorsOf(bytes32 agentId) external view returns (address[] memory) {
        return authors[agentId];
    }

    function receiversList() external view returns (address[] memory) {
        return receivers;
    }

    // =====================================================================================================
    // catalog
    // =====================================================================================================

    function registerAgent(uint256 creatorSeed, uint96 price, uint96 ppuSeed, uint16 royalty, uint32 capSeed)
        external
        tally("registerAgent")
    {
        if (agentIds.length >= MAX_AGENTS) return;
        address c = creators[creatorSeed % creators.length];
        price = uint96(bound(price, 5_000_000, 50_000_000));
        uint96 ppu = ppuSeed % 4 == 0 ? 0 : uint96(bound(ppuSeed, 1, price));
        royalty = uint16(bound(royalty, 0, 2000));
        bytes32 id = bytes32(bytes16(keccak256(abi.encode("agent", agentIds.length))));
        uint96 minStake = registry.minStake();
        AgentRegistration memory r = AgentRegistration({
            agentId: id,
            metadataUri: "ipfs://x",
            version: "1.0.0",
            versionHash: keccak256(abi.encode(id)),
            price: price,
            pricePerUse: ppu,
            royaltyBps: royalty
        });
        vm.startPrank(c);
        usd.approve(address(staking), minStake);
        registry.registerAgent(r);
        if (capSeed % 3 == 0) registry.setSupplyCap(id, uint32(bound(capSeed, 1, 4)));
        vm.stopPrank();
        stakeIn += minStake;
        agentIds.push(id);
        if (capSeed % 4 != 3) {
            vm.prank(admin);
            registry.approveAgent(id);
        }
    }

    function approveAgent(uint256 agentSeed) external tally("approveAgent") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        AgentStatus s = registry.statusOf(id);
        uint96 stake = registry.stakeOf(id);
        if (s == AgentStatus.Active || s == AgentStatus.Retired || stake < registry.minStake()) return;
        vm.prank(admin);
        registry.approveAgent(id);
    }

    function suspendAgent(uint256 agentSeed) external tally("suspendAgent") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok || registry.statusOf(id) == AgentStatus.Retired) return;
        vm.prank(admin);
        registry.suspendAgent(id);
    }

    function setSupplyCap(uint256 agentSeed, uint32 maxSeed) external tally("setSupplyCap") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        AgentView memory a = registry.getAgent(id);
        uint32 max;
        if (a.maxSupply == 0) {
            uint32 floor_ = a.totalSales == 0 ? 1 : a.totalSales;
            max = uint32(bound(maxSeed, floor_, uint256(floor_) + 3));
        } else {
            max = uint32(bound(maxSeed, uint256(a.maxSupply) + 1, uint256(a.maxSupply) + 3));
        }
        vm.prank(a.creator);
        registry.setSupplyCap(id, max);
    }

    function setFee(uint16 feeBps) external tally("setFee") {
        feeBps = uint16(bound(feeBps, 0, 2000));
        (address t,, uint16 platformBps,, uint96 minStake, uint96 minPrice) = registry.config();
        vm.prank(admin);
        registry.setConfig(t, feeBps, platformBps, minStake, minPrice);
    }

    // =====================================================================================================
    // licenses
    // =====================================================================================================

    function buyLicense(uint256 agentSeed, uint256 buyerSeed, bool viaPlatform) external tally("buyLicense") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok || tokenIds.length >= MAX_TOKENS) return;
        AgentView memory a = registry.getAgent(id);
        if (a.status != AgentStatus.Active || a.stake < registry.minStake()) return;
        address b = buyers[buyerSeed % buyers.length];
        address payer = viaPlatform ? platform : b;
        bytes32 pid = _newPid();

        if (a.maxSupply != 0 && a.totalSales >= a.maxSupply) {
            vm.prank(payer);
            try license.purchaseLicense(id, a.price, pid) {
                _violate("purchase past the supply cap");
            } catch (bytes memory err) {
                calls["rejected:soldOut"] += 1;
                if (bytes4(err) != SolversRegistry.SoldOut.selector) _violate("SoldOut expected");
            }
            return;
        }

        Bal memory before = _balances(SolversPayouts(address(license)), payer, a.creator);
        vm.recordLogs();
        vm.prank(payer);
        uint256 tokenId =
            viaPlatform ? license.purchaseLicenseFor(b, id, a.price, pid) : license.purchaseLicense(id, a.price, pid);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Bal memory after_ = _balances(SolversPayouts(address(license)), payer, a.creator);

        (bool found, uint256 price, uint256 split) = _licenseEvent(logs, pid);
        if (!found) _violate("LicensePurchased missing");
        if (price != a.price) _violate("LicensePurchased price");
        licensePriceSum += price;
        licenseSplitSum += split;
        licensePaidSum += before.payer - after_.payer;
        licenseReceivedSum += _received(before, after_);

        tokenIds.push(tokenId);
        ghostOwner[tokenId] = b;
        tokenAgent[tokenId] = id;
        ghostMinted[id] += 1;
        _recordPid(pid, payer, bytes32((uint256(1) << 248) | tokenId), true);
    }

    function transferLicense(uint256 tokenSeed, uint256 toSeed, uint8 mode) external tally("transferLicense") {
        (uint256 tokenId, bool ok) = _token(tokenSeed);
        if (!ok) return;
        address from = ghostOwner[tokenId];
        address to = receivers[toSeed % (receivers.length - 1)]; // never the treasury
        if (to == from) to = buyers[(toSeed / 7) % buyers.length];
        if (to == from) return;
        (address c, uint256 ca, address t, uint256 pa) = license.quoteRoyalty(tokenId);
        uint256 quote = ca + pa;

        Bal memory before = _balances(SolversPayouts(address(license)), from, c);
        vm.recordLogs();
        mode = mode % 3;
        if (mode == 0) {
            vm.prank(from);
            license.transferWithRoyalty(to, tokenId, quote);
        } else if (mode == 1) {
            // an approved operator moves it; the owner still pays
            address operator = stranger;
            vm.prank(from);
            license.approve(operator, tokenId);
            vm.prank(operator);
            license.transferFrom(from, to, tokenId);
        } else {
            vm.prank(from);
            license.safeTransferFrom(from, to, tokenId);
        }
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Bal memory after_ = _balances(SolversPayouts(address(license)), from, c);

        uint256 evt = _royaltyEvent(logs, tokenId);
        if (evt != quote) _violate("RoyaltyPaid != quote");
        royaltyQuotedSum += quote;
        royaltyEventSum += evt;
        if (from != c && from != t) {
            if (before.payer - after_.payer != quote) _violate("royalty payer delta");
            royaltyReceivedSum += _received(before, after_);
        } else {
            royaltyReceivedSum += quote; // the payer is also a recipient: covered by the vault invariants
        }
        ghostOwner[tokenId] = to;
    }

    function burnLicense(uint256 tokenSeed) external tally("burnLicense") {
        (uint256 tokenId, bool ok) = _token(tokenSeed);
        if (!ok || tokenSeed % 5 != 0) return; // rare
        vm.prank(ghostOwner[tokenId]);
        license.burn(tokenId);
        burned[tokenId] = true;
        ghostOwner[tokenId] = address(0);
    }

    // =====================================================================================================
    // credits + reviews
    // =====================================================================================================

    function buyCredits(uint256 agentSeed, uint256 buyerSeed, uint32 amountSeed, bool viaPlatform)
        external
        tally("buyCredits")
    {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        AgentView memory a = registry.getAgent(id);
        if (a.status != AgentStatus.Active || a.stake < registry.minStake() || a.pricePerUse == 0) return;
        uint96 minPrice = registry.minPrice();
        uint256 minAmount = (uint256(minPrice) + a.pricePerUse - 1) / a.pricePerUse;
        uint32 amount = uint32(bound(amountSeed, minAmount, minAmount + 20));
        uint256 total = uint256(a.pricePerUse) * amount;
        address b = buyers[buyerSeed % buyers.length];
        address payer = viaPlatform ? platform : b;
        bytes32 pid = _newPid();

        Bal memory before = _balances(SolversPayouts(address(credits)), payer, a.creator);
        vm.recordLogs();
        vm.prank(payer);
        if (viaPlatform) credits.buyCreditsFor(b, id, amount, total, pid);
        else credits.buyCredits(id, amount, total, pid);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Bal memory after_ = _balances(SolversPayouts(address(credits)), payer, a.creator);

        (bool found, uint256 evtTotal, uint256 split) = _creditsEvent(logs, pid);
        if (!found || evtTotal != total) _violate("CreditsBought total");
        creditsTotalSum += evtTotal;
        creditsSplitSum += split;
        creditsPaidSum += before.payer - after_.payer;
        creditsReceivedSum += _received(before, after_);
        _recordPid(pid, payer, bytes32((uint256(2) << 248) | uint256(uint160(b))), false);
    }

    function submitReview(uint256 tokenSeed, uint8 rating) external tally("submitReview") {
        (uint256 tokenId, bool ok) = _token(tokenSeed);
        if (!ok) return;
        rating = uint8(bound(rating, 1, 5));
        address author = ghostOwner[tokenId];
        bytes32 id = tokenAgent[tokenId];
        (,,, uint64 bound_) = license.licenseOf(tokenId);
        uint64 rid = reviews.reviewOf(id, author).id;
        bool selfReview = registry.creatorOf(id) == author;
        bool mustFail = selfReview || (bound_ != 0 && bound_ != rid);
        if (mustFail) {
            vm.prank(author);
            try reviews.submitReview(id, uint64(tokenId), rating, keccak256("c")) {
                _violate("review accepted with a used license or by the creator");
            } catch (bytes memory err) {
                calls["rejected:review"] += 1;
                bytes4 sel = bytes4(err);
                if (sel != SolversReviews.SelfReview.selector && sel != SolversReviews.LicenseAlreadyReviewed.selector)
                {
                    _violate("unexpected review error");
                }
            }
            return;
        }
        vm.prank(author);
        reviews.submitReview(id, uint64(tokenId), rating, keccak256(abi.encode(rating)));
        _rate(id, author, rating);
        if (tokenReviewId[tokenId] == 0) tokenReviewId[tokenId] = reviews.reviewOf(id, author).id;
    }

    function submitReviewWithCredits(uint256 agentSeed, uint256 authorSeed, uint8 rating)
        external
        tally("submitReviewWithCredits")
    {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        rating = uint8(bound(rating, 1, 5));
        address author = buyers[authorSeed % buyers.length];
        if (credits.purchasedOf(id, author) == 0) {
            vm.prank(author);
            try reviews.submitReviewWithCredits(id, rating, keccak256("c")) {
                _violate("credit review without credits");
            } catch (bytes memory err) {
                if (bytes4(err) != SolversReviews.NoLicense.selector) _violate("NoLicense expected");
            }
            return;
        }
        vm.prank(author);
        reviews.submitReviewWithCredits(id, rating, keccak256(abi.encode(rating)));
        _rate(id, author, rating);
    }

    // =====================================================================================================
    // escrow
    // =====================================================================================================

    struct EscrowArgs {
        bytes32 id;
        address buyer;
        address payer;
        bool viaPlatform;
        SolversEscrow.MilestoneInput[] ms;
        uint256 total;
        uint32 window;
        uint16 days_;
        bytes32 pid;
    }

    function createEscrow(
        uint256 agentSeed,
        uint256 buyerSeed,
        uint8 n,
        uint256 amountSeed,
        uint32 window,
        uint16 days_,
        bool viaPlatform
    ) external tally("createEscrow") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok || escrow.escrowCount() >= MAX_ESCROWS) return;
        AgentView memory a = registry.getAgent(id);
        if (a.status != AgentStatus.Active || a.stake < registry.minStake()) return;
        EscrowArgs memory x;
        x.id = id;
        x.buyer = buyers[buyerSeed % buyers.length];
        x.viaPlatform = viaPlatform;
        x.payer = viaPlatform ? platform : x.buyer;
        (x.ms, x.total) = _milestoneInputs(uint8(bound(n, 1, 5)), amountSeed);
        x.window = uint32(bound(window, 60, 3 days));
        x.days_ = uint16(bound(days_, 0, 60));
        x.pid = _newPid();
        _createEscrow(x);
    }

    function _milestoneInputs(uint8 n, uint256 amountSeed)
        private
        view
        returns (SolversEscrow.MilestoneInput[] memory ms, uint256 total)
    {
        ms = new SolversEscrow.MilestoneInput[](n);
        for (uint256 i; i < n; ++i) {
            uint96 amt = uint96(bound(uint256(keccak256(abi.encode(amountSeed, i))), 1, 10_000_000));
            ms[i] = SolversEscrow.MilestoneInput({amount: amt, criteriaHash: keccak256(abi.encode(i))});
            total += amt;
        }
        uint96 minPrice = registry.minPrice();
        if (total < minPrice) {
            ms[0].amount += uint96(minPrice - total);
            total = minPrice;
        }
    }

    function _createEscrow(EscrowArgs memory x) private {
        if (registry.reputationOf(x.buyer).disputesLost >= 3) {
            bool succeeded;
            bytes memory err;
            vm.prank(x.payer);
            if (x.viaPlatform) {
                try escrow.createEscrowFor(x.buyer, x.id, x.ms, x.window, x.days_, x.pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            } else {
                try escrow.createEscrow(x.id, x.ms, x.window, x.days_, x.pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            }
            if (succeeded) _violate("escrow for an ineligible buyer");
            calls["rejected:ineligible"] += 1;
            if (!succeeded && bytes4(err) != SolversRegistry.BuyerNotEligible.selector) {
                _violate("BuyerNotEligible expected");
            }
            return;
        }
        vm.prank(x.payer);
        uint256 escrowId = x.viaPlatform
            ? escrow.createEscrowFor(x.buyer, x.id, x.ms, x.window, x.days_, x.pid)
            : escrow.createEscrow(x.id, x.ms, x.window, x.days_, x.pid);
        escrowDeposited += x.total;
        _recordPid(x.pid, x.payer, bytes32((uint256(3) << 248) | escrowId), true);
    }

    function markPassed(uint256 escrowSeed, uint8 idx) external tally("markPassed") {
        (uint256 eid, uint8 i, SolversEscrow.Milestone memory m,,) = _milestone(escrowSeed, idx);
        if (eid == 0 || m.status != MilestoneStatus.Pending) return;
        vm.prank(verifier);
        escrow.markPassed(eid, i, keccak256("deliverable"));
    }

    function releaseMilestone(uint256 escrowSeed, uint8 idx, bool byBuyer) external tally("releaseMilestone") {
        (uint256 eid, uint8 i, SolversEscrow.Milestone memory m, address b, uint32 window) = _milestone(escrowSeed, idx);
        if (eid == 0) return;
        if (byBuyer && (m.status == MilestoneStatus.Pending || m.status == MilestoneStatus.Passed)) {
            vm.prank(b);
            escrow.releaseMilestone(eid, i);
        } else if (m.status == MilestoneStatus.Passed) {
            uint256 at = uint256(m.passedAt) + window;
            if (block.timestamp < at) vm.warp(at);
            vm.prank(stranger);
            escrow.releaseMilestone(eid, i);
        } else {
            return;
        }
        escrowReleased += m.amount;
    }

    function openDispute(uint256 escrowSeed, uint8 idx) external tally("openDispute") {
        (uint256 eid, uint8 i, SolversEscrow.Milestone memory m, address b, uint32 window) = _milestone(escrowSeed, idx);
        if (eid == 0) return;
        bool canDispute = m.status == MilestoneStatus.Pending
            || (m.status == MilestoneStatus.Passed && block.timestamp < uint256(m.passedAt) + window);
        if (!canDispute) return;
        vm.prank(b);
        escrow.openDispute(eid, i, keccak256("why"));
    }

    function resolveDispute(uint256 escrowSeed, uint8 idx, bool refund) external tally("resolveDispute") {
        (uint256 eid, uint8 i, SolversEscrow.Milestone memory m,,) = _milestone(escrowSeed, idx);
        if (eid == 0 || m.status != MilestoneStatus.Disputed) return;
        vm.prank(admin);
        escrow.resolveDispute(eid, i, refund);
        if (refund) escrowRefunded += m.amount;
        else escrowReleased += m.amount;
    }

    function cancelUndelivered(uint256 escrowSeed, uint8 idx) external tally("cancelUndelivered") {
        (uint256 eid, uint8 i, SolversEscrow.Milestone memory m, address b,) = _milestone(escrowSeed, idx);
        if (eid == 0 || m.status != MilestoneStatus.Pending) return;
        (,,,,,, uint40 deadline,) = escrow.escrowOf(eid);
        if (block.timestamp <= deadline) vm.warp(uint256(deadline) + 1);
        vm.prank(b);
        escrow.cancelUndelivered(eid, i);
        escrowRefunded += m.amount;
    }

    function resolveStaleDispute(uint256 escrowSeed, uint8 idx) external tally("resolveStaleDispute") {
        (uint256 eid, uint8 i, SolversEscrow.Milestone memory m,,) = _milestone(escrowSeed, idx);
        if (eid == 0 || m.status != MilestoneStatus.Disputed || m.passedAt != 0) return;
        (,,,,,, uint40 deadline,) = escrow.escrowOf(eid);
        uint256 due = uint256(m.disputedAt) + 7 days;
        if (due < uint256(deadline) + 1) due = uint256(deadline) + 1;
        if (block.timestamp < due) vm.warp(due);
        vm.prank(stranger);
        escrow.resolveStaleDispute(eid, i);
        escrowRefunded += m.amount;
    }

    // =====================================================================================================
    // staking
    // =====================================================================================================

    function topUpStake(uint256 agentSeed, uint96 amount) external tally("topUpStake") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        if (registry.statusOf(id) == AgentStatus.Retired) return; // top-ups are rejected while retired
        amount = uint96(bound(amount, 1, 30_000_000));
        address c = registry.creatorOf(id);
        vm.startPrank(c);
        usd.approve(address(staking), amount);
        staking.topUpStake(id, amount);
        vm.stopPrank();
        stakeIn += amount;
    }

    function requestStakeExit(uint256 agentSeed) external tally("requestStakeExit") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok || agentSeed % 3 != 0) return; // exits are terminal: keep them rarer
        if (registry.statusOf(id) == AgentStatus.Retired) return;
        vm.prank(registry.creatorOf(id));
        staking.requestStakeExit(id);
    }

    function extendStakeExit(uint256 agentSeed) external tally("extendStakeExit") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        SolversStaking.StakeExit memory x = staking.stakeExitOf(id);
        if (x.exitAt == 0 || x.extensions >= 2) return;
        vm.prank(admin);
        staking.extendStakeExit(id, keccak256("ext"));
    }

    function cancelStakeExit(uint256 agentSeed) external tally("cancelStakeExit") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        SolversStaking.StakeExit memory x = staking.stakeExitOf(id);
        if (x.exitAt == 0 || x.extensions != 0 || registry.statusOf(id) != AgentStatus.Retired) return;
        vm.prank(registry.creatorOf(id));
        staking.cancelStakeExit(id);
    }

    function withdrawStake(uint256 agentSeed) external tally("withdrawStake") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        SolversStaking.StakeExit memory x = staking.stakeExitOf(id);
        if (x.exitAt == 0) return;
        address c = registry.creatorOf(id);
        if (block.timestamp < x.exitAt) vm.warp(x.exitAt);
        if (staking.slashOf(id).proposedAt != 0) {
            vm.prank(c);
            try staking.withdrawStake(id) {
                _violate("withdraw with a pending slash");
            } catch (bytes memory err) {
                calls["rejected:slashPending"] += 1;
                if (bytes4(err) != SolversStaking.SlashPending.selector) _violate("SlashPending expected");
            }
            return;
        }
        uint96 stake = registry.stakeOf(id);
        vm.prank(c);
        staking.withdrawStake(id);
        stakeWithdrawn += stake;
    }

    function proposeSlash(uint256 agentSeed, uint96 amount) external tally("proposeSlash") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok || staking.slashOf(id).proposedAt != 0) return;
        uint96 stake = registry.stakeOf(id);
        if (stake == 0) return;
        amount = uint96(bound(amount, 1, stake));
        vm.prank(admin);
        staking.proposeSlash(id, amount, keccak256("slash"));
    }

    function contestSlash(uint256 agentSeed) external tally("contestSlash") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        SolversStaking.Slash memory s = staking.slashOf(id);
        if (s.proposedAt == 0 || s.contestedAt != 0) return;
        vm.prank(registry.creatorOf(id));
        staking.contestSlash(id, keccak256("contest"));
    }

    function cancelSlash(uint256 agentSeed, bool byCreator) external tally("cancelSlash") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        SolversStaking.Slash memory s = staking.slashOf(id);
        if (s.proposedAt == 0) return;
        address who = admin;
        if (byCreator) {
            uint256 expiry = uint256(s.proposedAt) + 72 hours + 14 days;
            if (block.timestamp < expiry) vm.warp(expiry);
            who = registry.creatorOf(id);
        }
        vm.prank(who);
        staking.cancelSlash(id);
    }

    function executeSlash(uint256 agentSeed, uint32 into) external tally("executeSlash") {
        (bytes32 id, bool ok) = _agent(agentSeed);
        if (!ok) return;
        SolversStaking.Slash memory s = staking.slashOf(id);
        if (s.proposedAt == 0) return;
        uint256 executableAt = uint256(s.proposedAt) + 72 hours;
        uint256 expiry = executableAt + 14 days;
        if (block.timestamp > expiry) {
            vm.prank(admin);
            try staking.executeSlash(id) {
                _violate("expired slash executed");
            } catch (bytes memory err) {
                calls["rejected:slashExpired"] += 1;
                if (bytes4(err) != SolversStaking.SlashExpired.selector) _violate("SlashExpired expected");
            }
            return;
        }
        if (block.timestamp < executableAt) vm.warp(executableAt + bound(into, 0, 14 days));
        uint96 stake = registry.stakeOf(id);
        uint96 amount = s.amount < stake ? s.amount : stake;
        if (s.amount > stake) _violate("slash amount above stake at execution");
        vm.prank(admin);
        staking.executeSlash(id);
        stakeSlashed += amount;
    }

    // =====================================================================================================
    // time, receive policies, claims, replays
    // =====================================================================================================

    function warp(uint32 secs) external tally("warp") {
        vm.warp(block.timestamp + bound(secs, 1 hours, 10 days));
    }

    function blockReceiver(uint256 seed) external tally("blockReceiver") {
        address account = receivers[seed % receivers.length];
        if (blocked[account]) return;
        uint64 pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(account, ITIP403Registry.PolicyType.WHITELIST);
        vm.prank(account);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(pid, 1, address(0));
        blocked[account] = true;
    }

    function unblockReceiver(uint256 seed) external tally("unblockReceiver") {
        address account = receivers[seed % receivers.length];
        if (!blocked[account]) return;
        vm.prank(account);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(1, 1, address(0));
        blocked[account] = false;
    }

    function claim(uint256 contractSeed, uint256 actorSeed) external tally("claim") {
        SolversPayouts[4] memory vaults = [
            SolversPayouts(address(license)),
            SolversPayouts(address(credits)),
            SolversPayouts(address(escrow)),
            SolversPayouts(address(staking))
        ];
        SolversPayouts v = vaults[contractSeed % 4];
        address account = receivers[actorSeed % receivers.length];
        uint256 owed = v.deferredOf(account);
        if (owed == 0) return;
        if (blocked[account]) {
            vm.prank(account);
            try v.claim() {
                _violate("claim delivered to a blocked receiver");
            } catch (bytes memory err) {
                calls["rejected:claimBlocked"] += 1;
                if (bytes4(err) != RecipientBlocked.selector) _violate("RecipientBlocked expected");
            }
            return;
        }
        uint256 before = usd.balanceOf(account);
        vm.prank(account);
        v.claim();
        if (usd.balanceOf(account) - before != owed) _violate("claim amount");
        calls["claimed"] += 1;
    }

    /// @dev Reusing a settled purchase id must revert with `DuplicatePurchase`, across kinds.
    function replayPurchase(uint256 pidSeed, uint8 kind) external tally("replayPurchase") {
        if (pids.length == 0 || agentIds.length == 0) return;
        bytes32 pid = pids[pidSeed % pids.length];
        bytes32 id = agentIds[pidSeed % agentIds.length];
        // the duplicate check runs before every agent/buyer check, so any agent state must report it
        AgentView memory a = registry.getAgent(id);
        // ids are scoped by payer: replay as the payer that settled it (a platform id is replayed through *For)
        address payer = expectedPayer[pid];
        bool viaPlatform = payer == platform;
        address b = viaPlatform ? buyers[pidSeed % buyers.length] : payer;
        kind = kind % 3;
        bytes memory err;
        bool succeeded;
        if (kind == 0) {
            vm.prank(payer);
            if (viaPlatform) {
                try license.purchaseLicenseFor(b, id, a.price, pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            } else {
                try license.purchaseLicense(id, a.price, pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            }
        } else if (kind == 1) {
            if (a.pricePerUse == 0) return;
            uint256 amount = (uint256(registry.minPrice()) + a.pricePerUse - 1) / a.pricePerUse;
            vm.prank(payer);
            if (viaPlatform) {
                try credits.buyCreditsFor(b, id, uint32(amount), amount * a.pricePerUse, pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            } else {
                try credits.buyCredits(id, uint32(amount), amount * a.pricePerUse, pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            }
        } else {
            SolversEscrow.MilestoneInput[] memory ms = new SolversEscrow.MilestoneInput[](1);
            ms[0] = SolversEscrow.MilestoneInput({amount: registry.minPrice(), criteriaHash: bytes32(0)});
            vm.prank(payer);
            if (viaPlatform) {
                try escrow.createEscrowFor(b, id, ms, 60, 0, pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            } else {
                try escrow.createEscrow(id, ms, 60, 0, pid) {
                    succeeded = true;
                } catch (bytes memory e) {
                    err = e;
                }
            }
        }
        calls["rejected:duplicate"] += 1;
        if (succeeded) {
            _violate("purchase id settled twice");
        } else if (
            keccak256(err)
                != keccak256(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, pid, expectedRef[pid]))
        ) {
            _violate("DuplicatePurchase(pid, ref) expected");
        }
    }

    // =====================================================================================================
    // internal
    // =====================================================================================================

    struct Bal {
        uint256 payer;
        uint256 creator;
        uint256 treasury;
        uint256 creatorDeferred;
        uint256 treasuryDeferred;
    }

    modifier tally(bytes32 name) {
        calls[name] += 1;
        uint256[4] memory d = _deferredTotals();
        _;
        uint256[4] memory a = _deferredTotals();
        if (a[0] > d[0]) calls["deferred:license"] += 1;
        if (a[1] > d[1]) calls["deferred:credits"] += 1;
        if (a[2] > d[2]) calls["deferred:escrow"] += 1;
        if (a[3] > d[3]) calls["deferred:staking"] += 1;
        _checkSalesMonotonic();
    }

    function _deferredTotals() private view returns (uint256[4] memory t) {
        t[0] = license.totalDeferred();
        t[1] = credits.totalDeferred();
        t[2] = escrow.totalDeferred();
        t[3] = staking.totalDeferred();
    }

    function _balances(SolversPayouts vault, address payer, address c) private view returns (Bal memory b) {
        b.payer = usd.balanceOf(payer);
        b.creator = usd.balanceOf(c);
        b.treasury = usd.balanceOf(treasury);
        b.creatorDeferred = vault.deferredOf(c);
        b.treasuryDeferred = vault.deferredOf(treasury);
    }

    /// @dev Value that reached the recipients (wallet or deferred credit). Only called when the payer is neither.
    function _received(Bal memory b, Bal memory a) private pure returns (uint256) {
        return (a.creator - b.creator) + (a.treasury - b.treasury) + (a.creatorDeferred - b.creatorDeferred)
            + (a.treasuryDeferred - b.treasuryDeferred);
    }

    function _licenseEvent(Vm.Log[] memory logs, bytes32 pid)
        private
        view
        returns (bool found, uint256 price, uint256 split)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(license) || logs[i].topics[0] != LICENSE_PURCHASED) continue;
            (, uint96 p, uint96 fee, uint96 rest, bytes32 id,,) =
                abi.decode(logs[i].data, (address, uint96, uint96, uint96, bytes32, bool, bool));
            if (id != pid) continue;
            return (true, p, uint256(fee) + rest);
        }
    }

    function _creditsEvent(Vm.Log[] memory logs, bytes32 pid)
        private
        view
        returns (bool found, uint256 total, uint256 split)
    {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(credits) || logs[i].topics[0] != CREDITS_BOUGHT) continue;
            (, uint32 amount, uint256 t, uint256 fee, uint256 rest, bytes32 id,,,,) = abi.decode(
                logs[i].data, (address, uint32, uint256, uint256, uint256, bytes32, uint32, uint32, bool, bool)
            );
            amount;
            if (id != pid) continue;
            return (true, t, fee + rest);
        }
    }

    function _royaltyEvent(Vm.Log[] memory logs, uint256 tokenId) private view returns (uint256 total) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(license) || logs[i].topics[0] != ROYALTY_PAID) continue;
            if (uint256(logs[i].topics[1]) != tokenId) continue;
            (, uint256 c, uint256 p,,) = abi.decode(logs[i].data, (address, uint256, uint256, bool, bool));
            total += c + p;
        }
    }

    function _rate(bytes32 id, address author, uint8 rating) private {
        if (ghostRating[id][author] == 0) authors[id].push(author);
        ghostRating[id][author] = rating;
    }

    function _newPid() private returns (bytes32) {
        return keccak256(abi.encode("handler-pid", ++nonce));
    }

    function _recordPid(bytes32 pid, address payer, bytes32 ref, bool unique) private {
        if (expectedRef[pid] != bytes32(0)) _violate("purchase id reused");
        pids.push(pid);
        expectedRef[pid] = ref;
        expectedPayer[pid] = payer;
        if (unique) {
            if (refPid[ref] != bytes32(0)) _violate("purchase ref not injective");
            refPid[ref] = pid;
        }
    }

    function _checkSalesMonotonic() private {
        for (uint256 i; i < agentIds.length; ++i) {
            bytes32 id = agentIds[i];
            uint32 sales = registry.getAgent(id).totalSales;
            if (sales < salesSeen[id]) _violate("totalSales decreased");
            salesSeen[id] = sales;
        }
    }

    function _violate(string memory why) private {
        if (bytes(violation).length == 0) violation = why;
    }

    function _agent(uint256 seed) private view returns (bytes32 id, bool ok) {
        if (agentIds.length == 0) return (bytes32(0), false);
        return (agentIds[seed % agentIds.length], true);
    }

    function _token(uint256 seed) private view returns (uint256 tokenId, bool ok) {
        uint256 n = tokenIds.length;
        if (n == 0) return (0, false);
        for (uint256 k; k < 4; ++k) {
            tokenId = tokenIds[(seed % n + k) % n];
            if (!burned[tokenId]) return (tokenId, true);
        }
        return (0, false);
    }

    function _milestone(uint256 escrowSeed, uint8 idx)
        private
        view
        returns (uint256 eid, uint8 i, SolversEscrow.Milestone memory m, address b, uint32 window)
    {
        uint256 count = escrow.escrowCount();
        if (count == 0) return (0, 0, m, address(0), 0);
        eid = bound(escrowSeed, 1, count);
        SolversEscrow.Milestone[] memory ms;
        (b,,,,, window,, ms) = escrow.escrowOf(eid);
        i = uint8(idx % ms.length);
        m = ms[i];
    }
}
