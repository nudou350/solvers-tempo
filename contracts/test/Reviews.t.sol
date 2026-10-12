// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {PAUSE_ENTRIES, PAUSE_PAYMENTS, PAUSE_TRANSFERS, AgentNotFound} from "../src/SolversTypes.sol";

contract ReviewsTest is SolversTestBase {
    bytes32 internal constant H1 = keccak256("content-1");
    bytes32 internal constant H2 = keccak256("content-2");

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
    }

    function _review(address who, uint256 tokenId, uint8 rating, bytes32 h) internal {
        vm.prank(who);
        reviews.submitReview(AGENT, uint64(tokenId), rating, h);
    }

    /// @dev Owner-paid royalty transfer (5% + 5% of the 10 USD original price).
    function _transfer(address from, address to, uint256 tokenId) internal {
        vm.startPrank(from);
        usd.approve(address(license), 1_000_000);
        license.transferWithRoyalty(to, tokenId, 1_000_000);
        vm.stopPrank();
    }

    function _buyCredits(address who, bytes32 agentId, uint32 amount) internal {
        vm.startPrank(who);
        usd.approve(address(credits), type(uint256).max);
        credits.buyCredits(agentId, amount, type(uint256).max, _pid());
        vm.stopPrank();
    }

    function _reviewId(uint256 tokenId) internal view returns (uint64 id) {
        (,,, id) = license.licenseOf(tokenId);
    }

    function _rating() internal view returns (uint64 sum, uint32 count) {
        return reviews.ratingOf(AGENT);
    }

    // =====================================================================================================
    // rating bounds
    // =====================================================================================================

    function test_rating_bounds() public {
        uint256 t = _buy(buyer, AGENT);
        vm.startPrank(buyer);
        vm.expectRevert(SolversReviews.InvalidRating.selector);
        reviews.submitReview(AGENT, uint64(t), 0, H1);
        vm.expectRevert(SolversReviews.InvalidRating.selector);
        reviews.submitReview(AGENT, uint64(t), 6, H1);
        vm.expectRevert(SolversReviews.InvalidRating.selector);
        reviews.submitReview(AGENT, uint64(t), 255, H1);
        vm.stopPrank();
        assertEq(_reviewId(t), 0, "a rejected rating never binds the license");

        _buyCredits(buyer2, AGENT, 5);
        vm.startPrank(buyer2);
        vm.expectRevert(SolversReviews.InvalidRating.selector);
        reviews.submitReviewWithCredits(AGENT, 0, H1);
        vm.expectRevert(SolversReviews.InvalidRating.selector);
        reviews.submitReviewWithCredits(AGENT, 6, H1);
        vm.stopPrank();
    }

    function test_rating_oneAndFiveAccepted() public {
        uint256 t1 = _buy(buyer, AGENT);
        uint256 t2 = _buy(buyer2, AGENT);
        _review(buyer, t1, 1, H1);
        _review(buyer2, t2, 5, H2);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 6);
        assertEq(count, 2);
    }

    // =====================================================================================================
    // one review per (agent, author); edits
    // =====================================================================================================

    function test_firstReview_storesEverythingAndEmits() public {
        uint256 t = _buy(buyer, AGENT);
        vm.warp(5000);
        vm.expectEmit(address(license));
        emit SolversLicense.LicenseReviewed(t, 1);
        vm.expectEmit(address(reviews));
        emit SolversReviews.ReviewSubmitted(AGENT, buyer, 4, H1, uint64(t), false, 4, 1);
        _review(buyer, t, 4, H1);

        SolversReviews.Review memory r = reviews.reviewOf(AGENT, buyer);
        assertEq(r.rating, 4);
        assertEq(r.createdAt, 5000);
        assertEq(r.updatedAt, 5000);
        assertEq(r.tokenId, t);
        assertEq(r.id, 1);
        assertEq(r.contentHash, H1);
        assertEq(_reviewId(t), 1);
    }

    function test_edit_replacesRatingInSum() public {
        uint256 t = _buy(buyer, AGENT);
        uint256 t2 = _buy(buyer2, AGENT);
        _review(buyer2, t2, 3, H1);
        vm.warp(1000);
        _review(buyer, t, 5, H1);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 8);
        assertEq(count, 2);

        vm.warp(2000);
        vm.recordLogs();
        vm.expectEmit(address(reviews));
        emit SolversReviews.ReviewSubmitted(AGENT, buyer, 2, H2, uint64(t), true, 5, 2);
        _review(buyer, t, 2, H2);
        (sum, count) = _rating();
        assertEq(sum, 5, "5 replaced by 2");
        assertEq(count, 2, "an edit does not add a review");

        SolversReviews.Review memory r = reviews.reviewOf(AGENT, buyer);
        assertEq(r.rating, 2);
        assertEq(r.createdAt, 1000);
        assertEq(r.updatedAt, 2000);
        assertEq(r.contentHash, H2);
        assertEq(r.id, 2, "review id is stable across edits");
    }

    function test_edit_sameRatingKeepsSum() public {
        uint256 t = _buy(buyer, AGENT);
        _review(buyer, t, 4, H1);
        _review(buyer, t, 4, H2);
        _review(buyer, t, 4, H1);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 4);
        assertEq(count, 1);
    }

    function test_reviewsArePerAgent() public {
        _registerActive(creator2, AGENT2);
        uint256 t1 = _buy(buyer, AGENT);
        uint256 t2 = _buy(buyer, AGENT2);
        _review(buyer, t1, 5, H1);
        vm.prank(buyer);
        reviews.submitReview(AGENT2, uint64(t2), 1, H1);
        (uint64 s1, uint32 c1) = reviews.ratingOf(AGENT);
        (uint64 s2, uint32 c2) = reviews.ratingOf(AGENT2);
        assertEq(s1, 5);
        assertEq(c1, 1);
        assertEq(s2, 1);
        assertEq(c2, 1);
        assertTrue(reviews.reviewOf(AGENT, buyer).id != reviews.reviewOf(AGENT2, buyer).id);
    }

    // =====================================================================================================
    // SelfReview
    // =====================================================================================================

    function test_selfReview_creatorWithTransferredLicense() public {
        uint256 t = _buy(buyer, AGENT);
        _transfer(buyer, creator, t);
        assertEq(license.ownerOf(t), creator);
        vm.prank(creator);
        vm.expectRevert(SolversReviews.SelfReview.selector);
        reviews.submitReview(AGENT, uint64(t), 5, H1);
        assertEq(_reviewId(t), 0, "license stays unused");

        // the license is still good for a normal buyer afterwards
        _transfer(creator, buyer2, t);
        _review(buyer2, t, 3, H1);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 3);
        assertEq(count, 1);
    }

    function test_selfReview_creatorOfAnotherAgentMayReview() public {
        _registerActive(creator2, AGENT2);
        uint256 t = _buy(creator2, AGENT);
        _review(creator2, t, 4, H1);
        (, uint32 count) = _rating();
        assertEq(count, 1);
    }

    function test_selfReview_creditsPathCreatorHasNoPurchases() public {
        // the creator cannot buy their own credits (SelfPurchase), so the credits path stops at NoLicense
        vm.prank(creator);
        vm.expectRevert(SolversReviews.NoLicense.selector);
        reviews.submitReviewWithCredits(AGENT, 5, H1);
    }

    // =====================================================================================================
    // credits path
    // =====================================================================================================

    function test_credits_noPurchaseNoLicense() public {
        vm.prank(buyer);
        vm.expectRevert(SolversReviews.NoLicense.selector);
        reviews.submitReviewWithCredits(AGENT, 5, H1);

        // credits of another agent do not count
        _registerActive(creator2, AGENT2);
        _buyCredits(buyer, AGENT2, 5);
        vm.prank(buyer);
        vm.expectRevert(SolversReviews.NoLicense.selector);
        reviews.submitReviewWithCredits(AGENT, 5, H1);

        // owning a license is not a credits purchase either
        _buy(buyer2, AGENT);
        vm.prank(buyer2);
        vm.expectRevert(SolversReviews.NoLicense.selector);
        reviews.submitReviewWithCredits(AGENT, 5, H1);
    }

    function test_credits_reviewAndEdit() public {
        _buyCredits(buyer, AGENT, 5);
        vm.expectEmit(address(reviews));
        emit SolversReviews.ReviewSubmitted(AGENT, buyer, 3, H1, 0, false, 3, 1);
        vm.prank(buyer);
        reviews.submitReviewWithCredits(AGENT, 3, H1);

        // consuming every credit keeps the right to review (purchased never decreases)
        vm.prank(platform);
        credits.consumeCredits(AGENT, buyer, 5);
        vm.expectEmit(address(reviews));
        emit SolversReviews.ReviewSubmitted(AGENT, buyer, 5, H2, 0, true, 5, 1);
        vm.prank(buyer);
        reviews.submitReviewWithCredits(AGENT, 5, H2);

        SolversReviews.Review memory r = reviews.reviewOf(AGENT, buyer);
        assertEq(r.tokenId, 0);
        assertEq(r.id, 1);
    }

    function test_credits_thenLicenseIsOneReview() public {
        _buyCredits(buyer, AGENT, 5);
        vm.prank(buyer);
        reviews.submitReviewWithCredits(AGENT, 2, H1);
        uint256 t = _buy(buyer, AGENT);
        vm.expectEmit(address(reviews));
        emit SolversReviews.ReviewSubmitted(AGENT, buyer, 4, H2, uint64(t), true, 4, 1);
        _review(buyer, t, 4, H2);
        assertEq(_reviewId(t), reviews.reviewOf(AGENT, buyer).id, "license bound to the existing review");
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 4);
        assertEq(count, 1);
    }

    function test_credits_buyCreditsForCountsForBuyer() public {
        vm.startPrank(platform);
        usd.approve(address(credits), type(uint256).max);
        credits.buyCreditsFor(buyer, AGENT, 5, type(uint256).max, _pid());
        vm.stopPrank();
        vm.prank(buyer);
        reviews.submitReviewWithCredits(AGENT, 5, H1);
        vm.prank(platform);
        vm.expectRevert(SolversReviews.NoLicense.selector);
        reviews.submitReviewWithCredits(AGENT, 5, H1);
    }

    // =====================================================================================================
    // license binding
    // =====================================================================================================

    function test_binding_usedLicenseCannotBackANewAuthor() public {
        uint256 t = _buy(buyer, AGENT);
        _review(buyer, t, 5, H1);
        uint64 bound = _reviewId(t);
        _transfer(buyer, buyer2, t);

        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(SolversReviews.LicenseAlreadyReviewed.selector, t));
        reviews.submitReview(AGENT, uint64(t), 1, H2);

        assertEq(_reviewId(t), bound);
        assertEq(reviews.reviewOf(AGENT, buyer2).id, 0, "no review id allocated for the rejected author");
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 5);
        assertEq(count, 1);
    }

    function test_binding_usedLicenseCannotBackAnotherAuthorsExistingReview() public {
        uint256 t1 = _buy(buyer, AGENT);
        uint256 t2 = _buy(buyer2, AGENT);
        _review(buyer, t1, 5, H1);
        _review(buyer2, t2, 4, H1);
        _transfer(buyer, buyer2, t1); // buyer2 now holds a license bound to buyer's review

        vm.prank(buyer2);
        vm.expectRevert(abi.encodeWithSelector(SolversReviews.LicenseAlreadyReviewed.selector, t1));
        reviews.submitReview(AGENT, uint64(t1), 1, H2);
        // with its own license buyer2 can still edit
        _review(buyer2, t2, 1, H2);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 6);
        assertEq(count, 2);
    }

    function test_binding_originalAuthorCanEditWithSameLicense() public {
        uint256 t = _buy(buyer, AGENT);
        _review(buyer, t, 5, H1);
        _review(buyer, t, 3, H2);
        // round trip: the license comes back to its author, who can edit with it again
        _transfer(buyer, buyer2, t);
        _transfer(buyer2, buyer, t);
        _review(buyer, t, 1, H1);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 1);
        assertEq(count, 1);
    }

    function test_binding_reviewerCanBindASecondUnusedLicense() public {
        uint256 t1 = _buy(buyer, AGENT);
        _review(buyer, t1, 5, H1);
        uint64 rid = reviews.reviewOf(AGENT, buyer).id;
        _transfer(buyer, buyer2, t1); // sold the first license

        uint256 t2 = _buy(buyer, AGENT);
        vm.expectEmit(address(license));
        emit SolversLicense.LicenseReviewed(t2, rid);
        _review(buyer, t2, 2, H2);
        assertEq(_reviewId(t2), rid);
        assertEq(reviews.reviewOf(AGENT, buyer).tokenId, t2);
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 2);
        assertEq(count, 1);
    }

    function test_binding_unusedTransferredLicenseWorksForNewOwner() public {
        uint256 t = _buy(buyer, AGENT);
        _transfer(buyer, buyer2, t);
        _review(buyer2, t, 4, H1);
        assertEq(_reviewId(t), reviews.reviewOf(AGENT, buyer2).id);
        // the seller (no review, no license) cannot review
        vm.prank(buyer);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        reviews.submitReview(AGENT, uint64(t), 4, H1);
    }

    function test_binding_licenseReviewedEmittedOnlyOnFirstUse() public {
        uint256 t = _buy(buyer, AGENT);
        _review(buyer, t, 5, H1);
        vm.recordLogs();
        _review(buyer, t, 4, H1);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            assertFalse(
                logs[i].emitter == address(license) && logs[i].topics[0] == SolversLicense.LicenseReviewed.selector,
                "no LicenseReviewed on an edit"
            );
        }
    }

    // =====================================================================================================
    // errors bubbling from License
    // =====================================================================================================

    function test_notOwner() public {
        uint256 t = _buy(buyer, AGENT);
        vm.prank(stranger);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        reviews.submitReview(AGENT, uint64(t), 5, H1);
        // nonexistent token
        vm.prank(stranger);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        reviews.submitReview(AGENT, 999, 5, H1);
        // token id 0
        vm.prank(buyer);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        reviews.submitReview(AGENT, 0, 5, H1);
    }

    function test_wrongAgent() public {
        _registerActive(creator2, AGENT2);
        uint256 t = _buy(buyer, AGENT);
        vm.prank(buyer);
        vm.expectRevert(SolversLicense.WrongAgent.selector);
        reviews.submitReview(AGENT2, uint64(t), 5, H1);
        assertEq(_reviewId(t), 0);
    }

    function test_unknownAgent() public {
        bytes32 unknown = keccak256("unknown-agent");
        uint256 t = _buy(buyer, AGENT);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, unknown));
        reviews.submitReview(unknown, uint64(t), 5, H1);
        vm.prank(buyer);
        vm.expectRevert(SolversReviews.NoLicense.selector);
        reviews.submitReviewWithCredits(unknown, 5, H1);
    }

    function test_useForReview_onlyReviews() public {
        uint256 t = _buy(buyer, AGENT);
        vm.prank(buyer);
        vm.expectRevert(SolversLicense.NotReviews.selector);
        license.useForReview(t, buyer, AGENT, 77);
    }

    function test_burnedLicenseCannotReview() public {
        uint256 t = _buy(buyer, AGENT);
        vm.prank(buyer);
        license.burn(t);
        vm.prank(buyer);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        reviews.submitReview(AGENT, uint64(t), 5, H1);
    }

    // =====================================================================================================
    // never paused
    // =====================================================================================================

    function test_reviewsNeverPaused() public {
        uint256 t = _buy(buyer, AGENT);
        _buyCredits(buyer2, AGENT, 5);
        vm.prank(admin);
        registry.setPause(PAUSE_ENTRIES | PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        assertEq(registry.pauseFlags(), 7);

        _review(buyer, t, 5, H1);
        vm.prank(buyer2);
        reviews.submitReviewWithCredits(AGENT, 3, H1);
        _review(buyer, t, 4, H2); // edit
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, 7);
        assertEq(count, 2);
    }

    function test_reviewsOfSuspendedAgentStillAllowed() public {
        uint256 t = _buy(buyer, AGENT);
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        _review(buyer, t, 1, H1);
        (, uint32 count) = _rating();
        assertEq(count, 1);
    }

    // =====================================================================================================
    // fuzz: ratingSum == sum of current ratings
    // =====================================================================================================

    function testFuzz_ratingSumTracksCurrentRatings(uint8[12] memory ratings, uint8[12] memory who) public {
        address[3] memory authors = [buyer, buyer2, stranger];
        uint256[3] memory tokens;
        for (uint256 i; i < 3; ++i) {
            tokens[i] = _buy(authors[i], AGENT);
        }
        uint8[3] memory current;
        for (uint256 k; k < ratings.length; ++k) {
            uint256 a = who[k] % 3;
            uint8 r = uint8(bound(ratings[k], 1, 5));
            _review(authors[a], tokens[a], r, H1);
            current[a] = r;
        }
        uint256 expectedSum;
        uint256 expectedCount;
        for (uint256 i; i < 3; ++i) {
            expectedSum += current[i];
            if (current[i] != 0) ++expectedCount;
            assertEq(reviews.reviewOf(AGENT, authors[i]).rating, current[i]);
        }
        (uint64 sum, uint32 count) = _rating();
        assertEq(sum, expectedSum);
        assertEq(count, expectedCount);
    }
}
