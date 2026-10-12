// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {SolversSatellite} from "./base/SolversSatellite.sol";
import {ISolversLicense, ISolversCredits} from "./interfaces/ISolversSatellites.sol";
import {ZeroAddress} from "./SolversTypes.sol";

/// @title SolversReviews
/// @notice One review per (agent, author); editing replaces the rating in the running sum. A license can back only the
/// review it was first used for (a transferred, already used license cannot create another review). Reviews are never
/// paused.
contract SolversReviews is SolversSatellite {
    /// @dev Slot 0 holds every mutable field but the content hash. `id` binds licenses to this review.
    struct Review {
        uint8 rating;
        uint40 createdAt;
        uint40 updatedAt;
        uint64 tokenId; // license used for the last submission (0 = credits)
        uint64 id;
        bytes32 contentHash;
    }

    struct Rating {
        uint64 sum;
        uint32 count;
    }

    /// @custom:storage-location erc7201:solvers.storage.Reviews
    struct ReviewsStorage {
        ISolversLicense license;
        ISolversCredits credits;
        uint64 nextReviewId;
        mapping(bytes32 agentId => mapping(address author => Review)) reviews;
        mapping(bytes32 agentId => Rating) ratings;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Reviews")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant REVIEWS_STORAGE = 0xe2cff80bfce33bc65b046b3d64bc827485c68070f91006cdbebe92913fdc7100;

    event ReviewSubmitted(
        bytes32 indexed agentId,
        address indexed author,
        uint8 rating,
        bytes32 contentHash,
        uint64 tokenId,
        bool edited,
        uint64 ratingSum,
        uint32 ratingCount
    );

    error InvalidRating();
    error NoLicense();
    error LicenseAlreadyReviewed(uint256 tokenId);
    error SelfReview();

    function initialize(address registry_, address license_, address credits_) external initializer {
        __SolversSatellite_init(registry_);
        if (license_ == address(0) || credits_ == address(0)) revert ZeroAddress();
        ReviewsStorage storage $ = _reviewsStorage();
        $.license = ISolversLicense(license_);
        $.credits = ISolversCredits(credits_);
    }

    /// @notice Reviews `agentId` backed by license `tokenId` owned by the caller.
    function submitReview(bytes32 agentId, uint64 tokenId, uint8 rating, bytes32 contentHash) external nonReentrant {
        ReviewsStorage storage $ = _reviewsStorage();
        Review storage r = _prepare($, agentId, rating);
        uint64 id = r.id;
        if (id == 0) {
            id = ++$.nextReviewId;
            r.id = id;
        }
        uint64 bound = $.license.useForReview(tokenId, msg.sender, agentId, id);
        if (bound != id) revert LicenseAlreadyReviewed(tokenId);
        _apply($, r, agentId, tokenId, rating, contentHash);
    }

    /// @notice Reviews `agentId` backed by pay-per-use credits the caller bought.
    function submitReviewWithCredits(bytes32 agentId, uint8 rating, bytes32 contentHash) external nonReentrant {
        ReviewsStorage storage $ = _reviewsStorage();
        if ($.credits.purchasedOf(agentId, msg.sender) == 0) revert NoLicense();
        Review storage r = _prepare($, agentId, rating);
        if (r.id == 0) r.id = ++$.nextReviewId;
        _apply($, r, agentId, 0, rating, contentHash);
    }

    function reviewOf(bytes32 agentId, address author) external view returns (Review memory) {
        return _reviewsStorage().reviews[agentId][author];
    }

    function ratingOf(bytes32 agentId) external view returns (uint64 sum, uint32 count) {
        Rating memory r = _reviewsStorage().ratings[agentId];
        return (r.sum, r.count);
    }

    function _prepare(ReviewsStorage storage $, bytes32 agentId, uint8 rating) private view returns (Review storage) {
        if (rating < 1 || rating > 5) revert InvalidRating();
        // Creators cannot rate their own Solver, even with a license received by transfer (D12).
        if (registry().creatorOf(agentId) == msg.sender) revert SelfReview();
        return $.reviews[agentId][msg.sender];
    }

    function _apply(
        ReviewsStorage storage $,
        Review storage r,
        bytes32 agentId,
        uint64 tokenId,
        uint8 rating,
        bytes32 contentHash
    ) private {
        Rating storage total = $.ratings[agentId];
        bool edited = r.createdAt != 0;
        if (edited) {
            total.sum -= r.rating;
        } else {
            r.createdAt = uint40(block.timestamp);
            total.count += 1;
        }
        total.sum += rating;
        r.rating = rating;
        r.updatedAt = uint40(block.timestamp);
        r.tokenId = tokenId;
        r.contentHash = contentHash;
        emit ReviewSubmitted(agentId, msg.sender, rating, contentHash, tokenId, edited, total.sum, total.count);
    }

    function _reviewsStorage() private pure returns (ReviewsStorage storage $) {
        assembly {
            $.slot := REVIEWS_STORAGE
        }
    }
}
