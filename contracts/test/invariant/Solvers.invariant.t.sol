// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

import {console} from "forge-std/console.sol";
import {SolversTestBase} from "../utils/SolversTestBase.sol";
import {SolversInvariantHandler} from "./SolversHandler.sol";
import {AgentView} from "../../src/interfaces/ISolversRegistry.sol";

/// @notice Handler-based, multi-actor invariants (plan §4.10). The handler drives every flow (registration,
/// approval, direct and platform purchases, royalty transfers, burns, credits, reviews, escrows with every milestone
/// exit, the stake lifecycle and slashes, warps, receive-policy blocks and claims, purchase-id replays).
///
/// The default profile keeps the campaign short; the `ci` profile uses its own runs/depth (256 x 64).
/// forge-config: default.invariant.runs = 8
/// forge-config: default.invariant.depth = 400
/// forge-config: default.invariant.fail-on-revert = true
/// forge-config: ci.invariant.fail-on-revert = true
/// forge-config: ci.invariant.runs = 256
/// forge-config: ci.invariant.depth = 64
contract SolversInvariantTest is SolversTestBase {
    SolversInvariantHandler internal handler;
    address[] internal creatorsList;
    address[] internal buyersList;

    function setUp() public override {
        super.setUp();
        address creator3 = makeAddr("creator3");
        address buyer3 = makeAddr("buyer3");
        address buyer4 = makeAddr("buyer4");
        token.mint(creator3, 1_000_000_000_000);
        token.mint(buyer3, 1_000_000_000_000);
        token.mint(buyer4, 1_000_000_000_000);
        creatorsList = [creator, creator2, creator3];
        buyersList = [buyer, buyer2, buyer3, buyer4];

        address[] memory payers = new address[](8);
        for (uint256 i; i < 3; ++i) {
            payers[i] = creatorsList[i];
        }
        for (uint256 i; i < 4; ++i) {
            payers[3 + i] = buyersList[i];
        }
        payers[7] = platform;
        for (uint256 i; i < payers.length; ++i) {
            vm.startPrank(payers[i]);
            usd.approve(address(license), type(uint256).max);
            usd.approve(address(credits), type(uint256).max);
            usd.approve(address(escrow), type(uint256).max);
            vm.stopPrank();
        }

        handler = new SolversInvariantHandler(
            registry,
            license,
            credits,
            reviews,
            escrow,
            staking,
            [admin, treasury, platform, verifier, stranger],
            creatorsList,
            buyersList
        );
        // Every run starts from a populated market so the shallow ci depth still reaches the later states.
        // capSeed: 0 → capped at 1 and active, 2 and 4 → unlimited and active, 7 → unlimited and Pending
        uint32[4] memory capSeeds = [uint32(0), 2, 7, 4];
        for (uint256 i; i < 4; ++i) {
            handler.registerAgent(
                i, uint96(5_000_000 + i * 7_777_777), uint96(i + 1) * 1_234_567, uint16(i * 500), capSeeds[i]
            );
        }
        for (uint256 i; i < 6; ++i) {
            handler.buyLicense(i, i, i % 2 == 0);
            handler.createEscrow(i, i + 1, uint8(i), i, 3600, 0, i % 2 == 1);
        }
        handler.buyCredits(1, 0, 3, false);
        handler.buyCredits(2, 1, 0, true);
        targetContract(address(handler));
    }

    // =========================================================================================== vault balances

    function invariant_escrowBalanceIsLockedPlusDeferred() public view {
        assertEq(_bal(address(escrow)), escrow.lockedBalance() + escrow.totalDeferred(), "escrow balance");
        assertEq(
            escrow.lockedBalance(),
            handler.escrowDeposited() - handler.escrowReleased() - handler.escrowRefunded(),
            "escrow locked ledger"
        );
    }

    function invariant_stakingBalanceIsStakedPlusDeferred() public view {
        assertEq(_bal(address(staking)), staking.totalStaked() + staking.totalDeferred(), "staking balance");
        uint256 sum;
        uint256 n = handler.agentCount();
        for (uint256 i; i < n; ++i) {
            sum += registry.stakeOf(handler.agentIds(i));
        }
        assertEq(sum, staking.totalStaked(), "sum of stakes");
        assertEq(
            handler.stakeIn(), staking.totalStaked() + handler.stakeWithdrawn() + handler.stakeSlashed(), "stake ledger"
        );
    }

    function invariant_licenseAndCreditsHoldOnlyDeferred() public view {
        assertEq(_bal(address(license)), license.totalDeferred(), "license balance");
        assertEq(_bal(address(credits)), credits.totalDeferred(), "credits balance");
    }

    function invariant_deferredSumsMatchPerRecipient() public view {
        address[] memory rs = handler.receiversList();
        uint256[4] memory sums;
        for (uint256 i; i < rs.length; ++i) {
            sums[0] += license.deferredOf(rs[i]);
            sums[1] += credits.deferredOf(rs[i]);
            sums[2] += escrow.deferredOf(rs[i]);
            sums[3] += staking.deferredOf(rs[i]);
        }
        assertEq(sums[0], license.totalDeferred(), "license deferred");
        assertEq(sums[1], credits.totalDeferred(), "credits deferred");
        assertEq(sums[2], escrow.totalDeferred(), "escrow deferred");
        assertEq(sums[3], staking.totalDeferred(), "staking deferred");
    }

    // ================================================================================================ catalog

    function invariant_totalSalesBoundedAndMonotonic() public view {
        uint256 n = handler.agentCount();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.agentIds(i);
            AgentView memory a = registry.getAgent(id);
            if (a.maxSupply != 0) assertLe(a.totalSales, a.maxSupply, "totalSales > maxSupply");
            assertGe(a.totalSales, handler.salesSeen(id), "totalSales decreased");
            assertEq(a.totalSales, handler.ghostMinted(id), "totalSales != licenses minted");
        }
    }

    // ================================================================================================ ledgers

    function invariant_feeSplitLedger() public view {
        assertEq(handler.licenseSplitSum(), handler.licensePriceSum(), "license: fee + creator != price");
        assertEq(handler.licensePaidSum(), handler.licensePriceSum(), "license: payer paid != price");
        assertEq(handler.licenseReceivedSum(), handler.licensePriceSum(), "license: recipients got != price");
        assertEq(handler.creditsSplitSum(), handler.creditsTotalSum(), "credits: fee + creator != total");
        assertEq(handler.creditsPaidSum(), handler.creditsTotalSum(), "credits: payer paid != total");
        assertEq(handler.creditsReceivedSum(), handler.creditsTotalSum(), "credits: recipients got != total");
        assertEq(handler.royaltyEventSum(), handler.royaltyQuotedSum(), "royalty: event != quote");
        assertEq(handler.royaltyReceivedSum(), handler.royaltyQuotedSum(), "royalty: recipients got != quote");
    }

    function invariant_purchaseRefsMatchSettlements() public view {
        uint256 n = handler.pidCount();
        for (uint256 i; i < n; ++i) {
            bytes32 pid = handler.pids(i);
            assertEq(registry.purchaseRef(handler.expectedPayer(pid), pid), handler.expectedRef(pid), "purchaseRef");
        }
    }

    // ================================================================================================ reviews

    function invariant_reviewsOnePerAuthorAndRatingSum() public view {
        uint256 n = handler.agentCount();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.agentIds(i);
            address[] memory as_ = handler.authorsOf(id);
            uint256 sum;
            for (uint256 j; j < as_.length; ++j) {
                uint8 r = handler.ghostRating(id, as_[j]);
                sum += r;
                assertEq(reviews.reviewOf(id, as_[j]).rating, r, "review rating");
            }
            (uint64 rs, uint32 rc) = reviews.ratingOf(id);
            assertEq(rs, sum, "rating sum");
            assertEq(rc, as_.length, "rating count");
        }
        uint256 t = handler.tokenCount();
        for (uint256 i; i < t; ++i) {
            uint256 tokenId = handler.tokenIds(i);
            (,,, uint64 reviewId) = license.licenseOf(tokenId);
            assertEq(reviewId, handler.tokenReviewId(tokenId), "license bound to one review");
        }
    }

    // ============================================================================================== ownership

    function invariant_ownershipMatchesGhost() public view {
        uint256 t = handler.tokenCount();
        assertEq(license.totalMinted(), t, "minted");
        uint256 live;
        for (uint256 i; i < t; ++i) {
            uint256 tokenId = handler.tokenIds(i);
            (bytes32 agentId,,,) = license.licenseOf(tokenId);
            assertEq(agentId, handler.tokenAgent(tokenId), "license agent");
            if (handler.burned(tokenId)) {
                try license.ownerOf(tokenId) returns (address o) {
                    assertEq(o, address(0), "burned token has an owner");
                } catch (bytes memory err) {
                    assertEq(
                        keccak256(err),
                        keccak256(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, tokenId))
                    );
                }
            } else {
                ++live;
                assertEq(license.ownerOf(tokenId), handler.ghostOwner(tokenId), "owner");
            }
        }
        address[] memory rs = handler.receiversList();
        uint256 held;
        for (uint256 i; i < rs.length; ++i) {
            held += license.balanceOf(rs[i]);
        }
        assertEq(held, live, "balances");
    }

    // ================================================================================================ handler

    function invariant_handlerSawNoViolation() public view {
        assertEq(handler.violation(), "", handler.violation());
    }

    function afterInvariant() external view {
        bytes32[17] memory names = [
            bytes32("buyLicense"),
            "transferLicense",
            "submitReview",
            "createEscrow",
            "releaseMilestone",
            "resolveDispute",
            "withdrawStake",
            "executeSlash",
            "deferred:license",
            "deferred:credits",
            "deferred:escrow",
            "deferred:staking",
            "claimed",
            "rejected:claimBlocked",
            "rejected:slashPending",
            "rejected:review",
            "rejected:ineligible"
        ];
        for (uint256 i; i < names.length; ++i) {
            console.log("DBG", string(abi.encodePacked(names[i])), handler.calls(names[i]));
        }
        console.log(
            "DBG soldOut/dup/expired",
            handler.calls("rejected:soldOut"),
            handler.calls("rejected:duplicate"),
            handler.calls("rejected:slashExpired")
        );
    }
}
