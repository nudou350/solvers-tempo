// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Metadata} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Metadata.sol";
import {IERC721Enumerable} from "@openzeppelin/contracts/token/ERC721/extensions/IERC721Enumerable.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";

import {LicenseTestBase} from "./License.t.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversPayouts} from "../src/base/SolversPayouts.sol";
import {PAUSE_TRANSFERS, PAUSE_ENTRIES, NothingToClaim, RecipientBlocked} from "../src/SolversTypes.sol";

/// @dev Receives a license through `safeTransferFrom` and, inside `onERC721Received`, passes it on with a plain
/// `transferFrom` (the second transfer must itself pay the royalty, from this contract).
contract RelayReceiver is IERC721Receiver {
    SolversLicense internal immutable lic;
    address internal immutable next;
    uint256 public hops;

    constructor(SolversLicense lic_, IERC20 t, address next_) {
        lic = lic_;
        next = next_;
        t.approve(address(lic_), type(uint256).max);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        ++hops;
        lic.transferFrom(address(this), next, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }
}

/// @dev Plain contract without `onERC721Received`.
contract PlainContract {}

/// @dev Concrete OZ ERC721Holder.
contract Holder is ERC721Holder {}

contract LicenseRoyaltyTest is LicenseTestBase {
    uint256 internal tokenId;

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
        tokenId = _buy(buyer, AGENT);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // helpers
    // ---------------------------------------------------------------------------------------------------------------

    struct Bals {
        uint256 from;
        uint256 to;
        uint256 creator;
        uint256 treasury;
        uint256 lic;
    }

    function _bals(address from, address to) internal view returns (Bals memory b) {
        b = Bals(_bal(from), _bal(to), _bal(creator), _bal(treasury), _bal(address(license)));
    }

    function _assertPaid(Bals memory b0, address from, address to, uint256 c, uint256 p) internal view {
        assertEq(b0.from - _bal(from), c + p, "from paid c + p");
        assertEq(_bal(to), b0.to, "to pays nothing");
        assertEq(_bal(creator) - b0.creator, c, "creator share");
        assertEq(_bal(treasury) - b0.treasury, p, "platform share");
        assertEq(_bal(address(license)), b0.lic, "license holds nothing new");
    }

    function _assertUnchanged(Bals memory b0, address from, address to) internal view {
        assertEq(_bal(from), b0.from);
        assertEq(_bal(to), b0.to);
        assertEq(_bal(creator), b0.creator);
        assertEq(_bal(treasury), b0.treasury);
        assertEq(_bal(address(license)), b0.lic);
    }

    function _royaltyLogs(Vm.Log[] memory logs) internal view returns (uint256) {
        return _countLogs(logs, address(license), SolversLicense.RoyaltyPaid.selector);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // owner transfers: exact (c, p) on the ORIGINAL price
    // ---------------------------------------------------------------------------------------------------------------

    function test_quoteRoyalty_fivePlusFivePercent() public view {
        (address c, uint256 ca, address t, uint256 pa) = license.quoteRoyalty(tokenId);
        assertEq(c, creator);
        assertEq(ca, ROYALTY_C);
        assertEq(t, treasury);
        assertEq(pa, ROYALTY_P);
        assertEq(ca + pa, ROYALTY);
    }

    function test_quoteRoyalty_nonexistent_reverts() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        license.quoteRoyalty(999);
    }

    function test_transferWithRoyalty_ownerPaysExactSplit() public {
        _approveToken(buyer, address(license), 3 * ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.expectEmit(address(license));
        emit IERC721.Transfer(buyer, buyer2, tokenId);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer, buyer2, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(buyer);
        license.transferWithRoyalty(buyer2, tokenId, ROYALTY);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);
        assertEq(license.ownerOf(tokenId), buyer2);
        assertEq(license.balanceOf(buyer), 0);
        assertEq(license.balanceOf(buyer2), 1);
        assertEq(usd.allowance(buyer, address(license)), 2 * ROYALTY, "exactly c + p pulled");
        _assertNoDeferred();
    }

    function test_transferWithRoyalty_maxAboveQuote_chargesQuoteOnly() public {
        _approveToken(buyer, address(license), 10 * ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.prank(buyer);
        license.transferWithRoyalty(buyer2, tokenId, 10 * ROYALTY);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);
    }

    function test_royalty_basedOnOriginalPrice_afterUpdatePricing() public {
        vm.prank(creator);
        registry.updatePricing(AGENT, 20_000_000, 0);
        (, uint256 c,, uint256 p) = license.quoteRoyalty(tokenId);
        assertEq(c, ROYALTY_C);
        assertEq(p, ROYALTY_P);

        _approveToken(buyer, address(license), ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);

        // a license sold at the new price carries the new base
        uint256 id2 = _buyAt(stranger, AGENT, 20_000_000);
        (, c,, p) = license.quoteRoyalty(id2);
        assertEq(c, 1_000_000);
        assertEq(p, 1_000_000);
        (address recv, uint256 amt) = license.royaltyInfo(id2, 0);
        assertEq(recv, address(license));
        assertEq(amt, 2_000_000);
    }

    function test_transferFrom_and_bothSafeTransferFrom_chargeSameRoyalty() public {
        // buyer -> buyer2 (transferFrom)
        _approveToken(buyer, address(license), ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer, buyer2, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);

        // buyer2 -> stranger (safeTransferFrom, 3 args)
        _approveToken(buyer2, address(license), ROYALTY);
        b0 = _bals(buyer2, stranger);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer2, stranger, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(buyer2);
        license.safeTransferFrom(buyer2, stranger, tokenId);
        _assertPaid(b0, buyer2, stranger, ROYALTY_C, ROYALTY_P);

        // stranger -> buyer (safeTransferFrom, 4 args)
        _approveToken(stranger, address(license), ROYALTY);
        b0 = _bals(stranger, buyer);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, stranger, buyer, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(stranger);
        license.safeTransferFrom(stranger, buyer, tokenId, hex"beef");
        _assertPaid(b0, stranger, buyer, ROYALTY_C, ROYALTY_P);

        assertEq(license.ownerOf(tokenId), buyer);
        _assertNoDeferred();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // operators: royalty always pulled from the owner
    // ---------------------------------------------------------------------------------------------------------------

    function test_approvedOperator_royaltyPulledFromOwner() public {
        vm.prank(buyer);
        license.approve(stranger, tokenId);
        _approveToken(buyer, address(license), ROYALTY);
        _approveToken(stranger, address(license), type(uint256).max); // never used
        uint256 op0 = _bal(stranger);
        Bals memory b0 = _bals(buyer, buyer2);

        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer, buyer2, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(stranger);
        license.transferFrom(buyer, buyer2, tokenId);

        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);
        assertEq(_bal(stranger), op0, "operator balance unchanged");
        assertEq(license.ownerOf(tokenId), buyer2);
        assertEq(license.getApproved(tokenId), address(0), "approval cleared");
    }

    function test_approvalForAllOperator_royaltyPulledFromOwner_allEntryPoints() public {
        uint256 id2 = _buy(buyer, AGENT);
        uint256 id3 = _buy(buyer, AGENT);
        vm.prank(buyer);
        license.setApprovalForAll(stranger, true);
        _approveToken(buyer, address(license), 3 * ROYALTY);
        _approveToken(stranger, address(license), type(uint256).max);
        uint256 op0 = _bal(stranger);
        Bals memory b0 = _bals(buyer, buyer2);

        vm.startPrank(stranger);
        license.transferFrom(buyer, buyer2, tokenId);
        license.safeTransferFrom(buyer, buyer2, id2);
        license.transferWithRoyalty(buyer2, id3, ROYALTY);
        vm.stopPrank();

        _assertPaid(b0, buyer, buyer2, 3 * ROYALTY_C, 3 * ROYALTY_P);
        assertEq(_bal(stranger), op0, "operator balance unchanged");
        assertEq(license.balanceOf(buyer2), 3);
    }

    function test_operator_ownerWithoutTokenAllowance_royaltyNotPaid() public {
        vm.prank(buyer);
        license.setApprovalForAll(stranger, true);
        _approveToken(stranger, address(license), type(uint256).max); // the operator's own allowance is irrelevant
        Bals memory b0 = _bals(buyer, buyer2);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyNotPaid.selector, ROYALTY));
        vm.prank(stranger);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertUnchanged(b0, buyer, buyer2);
        assertEq(license.ownerOf(tokenId), buyer);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // RoyaltyNotPaid / RoyaltyChanged
    // ---------------------------------------------------------------------------------------------------------------

    function test_insufficientAllowance_royaltyNotPaid_noStateChange_allEntryPoints() public {
        _approveToken(buyer, address(license), ROYALTY - 1);
        Bals memory b0 = _bals(buyer, buyer2);
        bytes memory err = abi.encodeWithSelector(SolversLicense.RoyaltyNotPaid.selector, ROYALTY);

        vm.startPrank(buyer);
        vm.expectRevert(err);
        license.transferFrom(buyer, buyer2, tokenId);
        vm.expectRevert(err);
        license.safeTransferFrom(buyer, buyer2, tokenId);
        vm.expectRevert(err);
        license.safeTransferFrom(buyer, buyer2, tokenId, "");
        vm.expectRevert(err);
        license.transferWithRoyalty(buyer2, tokenId, ROYALTY);
        vm.stopPrank();

        _assertUnchanged(b0, buyer, buyer2);
        assertEq(license.ownerOf(tokenId), buyer);
        assertEq(license.balanceOf(buyer2), 0);
        assertEq(usd.allowance(buyer, address(license)), ROYALTY - 1);
    }

    function test_insufficientBalance_royaltyNotPaid_noStateChange() public {
        _approveToken(buyer, address(license), type(uint256).max);
        uint256 drain = _bal(buyer) - (ROYALTY - 1);
        vm.prank(buyer);
        usd.transfer(stranger, drain);
        assertEq(_bal(buyer), ROYALTY - 1);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyNotPaid.selector, ROYALTY));
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertUnchanged(b0, buyer, buyer2);
        assertEq(license.ownerOf(tokenId), buyer);

        // exactly enough works and leaves the owner at 0
        token.mint(buyer, 1);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        assertEq(_bal(buyer), 0);
    }

    function test_maxRoyaltyBelowQuote_royaltyChanged() public {
        _approveToken(buyer, address(license), 10 * ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyChanged.selector, ROYALTY));
        vm.prank(buyer);
        license.transferWithRoyalty(buyer2, tokenId, ROYALTY - 1);
        _assertUnchanged(b0, buyer, buyer2);
        assertEq(license.ownerOf(tokenId), buyer);
    }

    function test_platformBpsChangedBetweenQuoteAndTx() public {
        (, uint256 c,, uint256 p) = license.quoteRoyalty(tokenId);
        uint256 quoted = c + p;
        assertEq(quoted, ROYALTY);
        _approveToken(buyer, address(license), 10 * ROYALTY);

        // admin raises the platform share before the tx lands
        _setConfig(FEE_BPS, 1000, MIN_PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyChanged.selector, uint256(1_500_000)));
        vm.prank(buyer);
        license.transferWithRoyalty(buyer2, tokenId, quoted);

        // plain transferFrom has no ceiling and pays the new amount
        Bals memory b0 = _bals(buyer, buyer2);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, 1_000_000);

        // lowered to 0: only the creator share, RoyaltyPaid reports platformAmount 0
        _setConfig(FEE_BPS, 0, MIN_PRICE);
        _approveToken(buyer2, address(license), ROYALTY);
        b0 = _bals(buyer2, stranger);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer2, stranger, creator, ROYALTY_C, 0, false, false);
        vm.prank(buyer2);
        license.transferWithRoyalty(stranger, tokenId, quoted);
        _assertPaid(b0, buyer2, stranger, ROYALTY_C, 0);
    }

    function test_platformBpsClampedToTotalCap() public {
        // creator 5% + platform 25% configured => platform clamped to 20% (total 25%)
        _setConfig(FEE_BPS, 2500, MIN_PRICE);
        (, uint256 c,, uint256 p) = license.quoteRoyalty(tokenId);
        assertEq(c, 500_000);
        assertEq(p, 2_000_000);
        (, uint256 amt) = license.royaltyInfo(tokenId, 0);
        assertEq(amt, 2_500_000);
        _approveToken(buyer, address(license), 2_500_000);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertPaid(b0, buyer, buyer2, 500_000, 2_000_000);
    }

    function test_setRoyaltyBps_lockedAfterFirstSale_quoteFollowsUntilFirstSale() public {
        vm.expectRevert(SolversRegistry.RoyaltyLocked.selector);
        vm.prank(creator);
        registry.setRoyaltyBps(AGENT, 100);

        _register(creator2, AGENT2, PRICE, 0, 500);
        vm.prank(creator2);
        registry.setRoyaltyBps(AGENT2, 1500);
        vm.prank(admin);
        registry.approveAgent(AGENT2);
        uint256 id2 = _buy(buyer, AGENT2);
        (, uint256 c,, uint256 p) = license.quoteRoyalty(id2);
        assertEq(c, 1_500_000);
        assertEq(p, 500_000);
        vm.expectRevert(SolversRegistry.RoyaltyLocked.selector);
        vm.prank(creator2);
        registry.setRoyaltyBps(AGENT2, 1500);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // rounding
    // ---------------------------------------------------------------------------------------------------------------

    struct Row {
        uint96 price;
        uint16 cBps;
        uint16 pBps;
        uint256 c;
        uint256 p;
    }

    function test_roundingTable_dustStaysWithPayer() public {
        Row[8] memory rows = [
            Row(1_000_001, 333, 333, 33_300, 33_300),
            Row(5_000_009, 500, 1000, 250_000, 500_000),
            Row(19, 500, 1000, 0, 1),
            Row(7, 1, 1, 0, 0),
            Row(9_999_999, 2499, 1, 2_498_999, 999),
            Row(10_000_000, 0, 0, 0, 0),
            Row(10_000_000, 2500, 0, 2_500_000, 0),
            Row(1_000_003, 1, 2499, 100, 249_900)
        ];
        for (uint256 i; i < rows.length; ++i) {
            Row memory row = rows[i];
            _setConfig(FEE_BPS, row.pBps, 1);
            bytes32 agentId = bytes32(uint256(0xA000 + i) << 128);
            _registerActiveWith(creator2, agentId, row.price, row.cBps);
            uint256 id = _buyAt(buyer, agentId, row.price);

            (, uint256 qc,, uint256 qp) = license.quoteRoyalty(id);
            assertEq(qc, row.c, "quote c");
            assertEq(qp, row.p, "quote p");

            _approveToken(buyer, address(license), row.c + row.p);
            uint256 b0 = _bal(buyer);
            uint256 c0 = _bal(creator2);
            uint256 t0 = _bal(treasury);
            vm.recordLogs();
            vm.prank(buyer);
            license.transferFrom(buyer, buyer2, id);
            uint256 events = _royaltyLogs(vm.getRecordedLogs());
            assertEq(b0 - _bal(buyer), row.c + row.p, "payer pays floors only");
            assertEq(_bal(creator2) - c0, row.c, "creator floor");
            assertEq(_bal(treasury) - t0, row.p, "platform floor");
            assertEq(events, row.c + row.p == 0 ? 0 : 1, "RoyaltyPaid only when something is charged");
            assertEq(license.ownerOf(id), buyer2);
        }
        _assertNoDeferred();
    }

    function testFuzz_royaltySplit_exactFloors(uint96 price, uint16 cBps, uint16 pBps) public {
        price = uint96(bound(price, 1, 1e15));
        pBps = uint16(bound(pBps, 0, 2500));
        cBps = uint16(bound(cBps, 0, 2500 - pBps));
        _setConfig(FEE_BPS, pBps, 1);
        token.mint(buyer, 2 * uint256(price));
        _registerActiveWith(creator2, AGENT2, price, cBps);
        uint256 id = _buyAt(buyer, AGENT2, price);
        uint256 c = uint256(price) * cBps / 10_000;
        uint256 p = uint256(price) * pBps / 10_000;
        _approveToken(buyer, address(license), type(uint256).max);
        Bals memory b0 = _bals(buyer, buyer2);
        uint256 c0 = _bal(creator2);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, id);
        assertEq(b0.from - _bal(buyer), c + p);
        assertEq(_bal(creator2) - c0, c);
        assertEq(_bal(treasury) - b0.treasury, p);
        assertLe(c + p, uint256(price) * 2500 / 10_000);
        (, uint256 info) = license.royaltyInfo(id, 12_345);
        assertEq(info, c + p); // royaltyInfo reports exactly what a transfer is charged
    }

    // ---------------------------------------------------------------------------------------------------------------
    // exemptions and pause
    // ---------------------------------------------------------------------------------------------------------------

    function test_selfTransfer_noCharge() public {
        Bals memory b0 = _bals(buyer, buyer);
        vm.recordLogs();
        vm.prank(buyer);
        license.transferFrom(buyer, buyer, tokenId);
        assertEq(_royaltyLogs(vm.getRecordedLogs()), 0);
        // transferWithRoyalty applies its slippage guard to the quote before the self-transfer exemption, so a
        // self-transfer needs maxRoyalty >= quote even though nothing is charged (harmless; documented)
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyChanged.selector, ROYALTY));
        vm.prank(buyer);
        license.transferWithRoyalty(buyer, tokenId, 0);
        vm.prank(buyer);
        license.transferWithRoyalty(buyer, tokenId, ROYALTY);
        vm.prank(buyer);
        license.safeTransferFrom(buyer, buyer, tokenId);
        // exempt from the TRANSFERS pause as well (no ownership change)
        vm.prank(admin);
        registry.setPause(PAUSE_TRANSFERS);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer, tokenId);
        _assertUnchanged(b0, buyer, buyer);
        assertEq(license.ownerOf(tokenId), buyer);
    }

    function test_mintAndBurn_royaltyExempt() public {
        // mint: the buyer approves exactly the price and nothing else is pulled (setUp already minted one)
        uint256 b0 = _bal(buyer2);
        vm.recordLogs();
        uint256 id = _buy(buyer2, AGENT);
        assertEq(_royaltyLogs(vm.getRecordedLogs()), 0);
        assertEq(b0 - _bal(buyer2), PRICE);
        // burn: no allowance at all, nothing moves
        assertEq(usd.allowance(buyer2, address(license)), 0);
        Bals memory s0 = _bals(buyer2, buyer2);
        vm.recordLogs();
        vm.prank(buyer2);
        license.burn(id);
        assertEq(_royaltyLogs(vm.getRecordedLogs()), 0);
        _assertUnchanged(s0, buyer2, buyer2);
    }

    function test_transfersPause_blocksTransfersNotPurchaseOrBurn() public {
        // TRANSFERS is an admin-only emergency bit: a guardian cannot set it
        vm.expectRevert(SolversRegistry.NotPauseAuthority.selector);
        vm.prank(guardian);
        registry.setPause(PAUSE_TRANSFERS);
        vm.prank(admin);
        registry.setPause(PAUSE_TRANSFERS);
        _approveToken(buyer, address(license), 10 * ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);

        vm.startPrank(buyer);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.transferFrom(buyer, buyer2, tokenId);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.safeTransferFrom(buyer, buyer2, tokenId);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.safeTransferFrom(buyer, buyer2, tokenId, "x");
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        license.transferWithRoyalty(buyer2, tokenId, ROYALTY);
        vm.stopPrank();
        _assertUnchanged(b0, buyer, buyer2);

        // purchase and burn still work
        uint256 id2 = _buy(buyer2, AGENT);
        vm.prank(buyer2);
        license.burn(id2);

        // the guardian cannot lift it; the admin can
        vm.expectRevert(SolversRegistry.GuardianCannotUnpause.selector);
        vm.prank(guardian);
        registry.setPause(0);
        vm.prank(admin);
        registry.setPause(0);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        assertEq(license.ownerOf(tokenId), buyer2);
    }

    function test_transfersPause_blocksEvenZeroRoyaltyAgents() public {
        _setConfig(FEE_BPS, 0, MIN_PRICE);
        _registerActiveWith(creator2, AGENT2, PRICE, 0);
        uint256 id = _buy(buyer, AGENT2);
        (, uint256 c,, uint256 p) = license.quoteRoyalty(id);
        assertEq(c + p, 0);
        vm.prank(admin);
        registry.setPause(PAUSE_TRANSFERS);
        vm.expectRevert(SolversLicense.TransfersPaused.selector);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, id);
        vm.prank(admin);
        registry.setPause(0);
        // zero royalty: transfers without any allowance
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, id);
        assertEq(license.ownerOf(id), buyer2);
    }

    function test_entriesPause_doesNotBlockTransfers() public {
        vm.prank(admin);
        registry.setPause(PAUSE_ENTRIES);
        _approveToken(buyer, address(license), ROYALTY);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        assertEq(license.ownerOf(tokenId), buyer2);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // deferred royalty
    // ---------------------------------------------------------------------------------------------------------------

    function test_blockedCreator_royaltyDeferred_claimLater() public {
        _blockReceives(creator);
        _approveToken(buyer, address(license), ROYALTY);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 b0 = _bal(buyer);

        vm.expectEmit(address(license));
        emit SolversPayouts.PayoutDeferred(creator, ROYALTY_C, ROYALTY_C);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer, buyer2, creator, ROYALTY_C, ROYALTY_P, true, false);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);

        assertEq(b0 - _bal(buyer), ROYALTY);
        assertEq(_bal(creator), c0);
        assertEq(_bal(treasury) - t0, ROYALTY_P);
        assertEq(license.deferredOf(creator), ROYALTY_C);
        assertEq(license.totalDeferred(), ROYALTY_C);
        assertEq(_bal(address(license)), license.totalDeferred());

        vm.expectRevert(abi.encodeWithSelector(RecipientBlocked.selector, creator));
        vm.prank(creator);
        license.claim();

        _unblockReceives(creator);
        vm.prank(creator);
        license.claim();
        assertEq(_bal(creator) - c0, ROYALTY_C);
        _assertNoDeferred();
        vm.expectRevert(NothingToClaim.selector);
        vm.prank(creator);
        license.claim();
    }

    function test_blacklistedTreasury_platformRoyaltyDeferred() public {
        _blacklist(treasury);
        _approveToken(buyer, address(license), ROYALTY);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer, buyer2, creator, ROYALTY_C, ROYALTY_P, false, true);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        assertEq(license.deferredOf(treasury), ROYALTY_P);
        assertEq(_bal(address(license)), ROYALTY_P);
        _clearTokenPolicy();
        uint256 t0 = _bal(treasury);
        vm.prank(treasury);
        license.claim();
        assertEq(_bal(treasury) - t0, ROYALTY_P);
        _assertNoDeferred();
    }

    function test_blacklistedOwner_cannotPayRoyalty_revertsTokenError() public {
        _approveToken(buyer, address(license), ROYALTY);
        _blacklist(buyer);
        vm.expectRevert(ITIP20.PolicyForbids.selector);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        assertEq(license.ownerOf(tokenId), buyer);
        _assertNoDeferred();
    }

    function test_royalty_receivePolicyJudgedOnOwner_whitelistedOwnerPaysCreatorDirectly() public {
        _receiveOnlyFrom(creator, buyer);
        _approveToken(buyer, address(license), ROYALTY);
        uint256 guard0 = _bal(RECEIVE_POLICY_GUARD);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);
        assertEq(_bal(RECEIVE_POLICY_GUARD), guard0);
        _assertNoDeferred();
    }

    function test_receiveBlockedRecipientOfNft_irrelevant() public {
        _blockReceives(buyer2);
        _approveToken(buyer, address(license), ROYALTY);
        Bals memory b0 = _bals(buyer, buyer2);
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, tokenId);
        _assertPaid(b0, buyer, buyer2, ROYALTY_C, ROYALTY_P);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // permit variants
    // ---------------------------------------------------------------------------------------------------------------

    function _permitOwnerWithLicense() internal returns (address signer, uint256 pk, uint256 id) {
        (signer, pk) = makeAddrAndKey("royaltySigner");
        token.mint(signer, 100_000_000);
        id = _buy(signer, AGENT);
        assertEq(usd.allowance(signer, address(license)), 0);
    }

    function test_transferWithRoyaltyPermit_byOwner_singleCall() public {
        (address signer, uint256 pk, uint256 id) = _permitOwnerWithLicense();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), ROYALTY, deadline);
        Bals memory b0 = _bals(signer, buyer2);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(id, signer, buyer2, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(signer);
        license.transferWithRoyaltyPermit(buyer2, id, ROYALTY, deadline, v, r, s);
        _assertPaid(b0, signer, buyer2, ROYALTY_C, ROYALTY_P);
        assertEq(license.ownerOf(id), buyer2);
        assertEq(token.nonces(signer), 1);
        assertEq(usd.allowance(signer, address(license)), 0);
    }

    function test_transferWithRoyaltyPermit_byApprovedOperator() public {
        (address signer, uint256 pk, uint256 id) = _permitOwnerWithLicense();
        vm.prank(signer);
        license.approve(stranger, id);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), ROYALTY, deadline);
        uint256 op0 = _bal(stranger);
        Bals memory b0 = _bals(signer, buyer2);
        vm.prank(stranger);
        license.transferWithRoyaltyPermit(buyer2, id, ROYALTY, deadline, v, r, s);
        _assertPaid(b0, signer, buyer2, ROYALTY_C, ROYALTY_P);
        assertEq(_bal(stranger), op0, "operator pays nothing");
        assertEq(license.ownerOf(id), buyer2);
    }

    function test_transferWithRoyaltyPermit_frontRunPermit_stillWorks() public {
        (address signer, uint256 pk, uint256 id) = _permitOwnerWithLicense();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), ROYALTY, deadline);
        vm.prank(stranger);
        token.permit(signer, address(license), ROYALTY, deadline, v, r, s);
        vm.prank(signer);
        license.transferWithRoyaltyPermit(buyer2, id, ROYALTY, deadline, v, r, s);
        assertEq(license.ownerOf(id), buyer2);
    }

    function test_transferWithRoyaltyPermit_invalidPermit_royaltyNotPaid() public {
        (address signer, uint256 pk, uint256 id) = _permitOwnerWithLicense();
        uint256 deadline = block.timestamp + 1 hours;
        // the permit is applied for maxRoyalty: a signature over the quote does not verify when maxRoyalty differs
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), ROYALTY, deadline);
        Bals memory b0 = _bals(signer, buyer2);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyNotPaid.selector, ROYALTY));
        vm.prank(signer);
        license.transferWithRoyaltyPermit(buyer2, id, 2 * ROYALTY, deadline, v, r, s);
        _assertUnchanged(b0, signer, buyer2);
        assertEq(token.nonces(signer), 0);

        // signed by someone else
        (, uint256 otherPk) = makeAddrAndKey("other");
        (v, r, s) = _signPermit(otherPk, signer, address(license), ROYALTY, deadline);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyNotPaid.selector, ROYALTY));
        vm.prank(signer);
        license.transferWithRoyaltyPermit(buyer2, id, ROYALTY, deadline, v, r, s);
    }

    function test_transferWithRoyaltyPermit_quoteAboveMax_royaltyChanged() public {
        (address signer, uint256 pk, uint256 id) = _permitOwnerWithLicense();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), ROYALTY, deadline);
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyChanged.selector, ROYALTY));
        vm.prank(signer);
        license.transferWithRoyaltyPermit(buyer2, id, ROYALTY - 1, deadline, v, r, s);
    }

    function test_transferWithRoyaltyPermit_unauthorizedCaller_reverts() public {
        (address signer, uint256 pk, uint256 id) = _permitOwnerWithLicense();
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), ROYALTY, deadline);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, id));
        vm.prank(stranger);
        license.transferWithRoyaltyPermit(stranger, id, ROYALTY, deadline, v, r, s);
        assertEq(license.ownerOf(id), signer);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // receivers
    // ---------------------------------------------------------------------------------------------------------------

    function test_safeTransferFrom_toERC721Holder() public {
        Holder holder = new Holder();
        _approveToken(buyer, address(license), ROYALTY);
        Bals memory b0 = _bals(buyer, address(holder));
        vm.prank(buyer);
        license.safeTransferFrom(buyer, address(holder), tokenId);
        _assertPaid(b0, buyer, address(holder), ROYALTY_C, ROYALTY_P);
        assertEq(license.ownerOf(tokenId), address(holder));
    }

    function test_safeTransferFrom_toContractWithoutReceiver_reverts_plainTransferWorks() public {
        PlainContract plain = new PlainContract();
        _approveToken(buyer, address(license), ROYALTY);
        Bals memory b0 = _bals(buyer, address(plain));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(plain)));
        vm.prank(buyer);
        license.safeTransferFrom(buyer, address(plain), tokenId);
        _assertUnchanged(b0, buyer, address(plain));
        // transferWithRoyalty is not a safe transfer
        vm.prank(buyer);
        license.transferWithRoyalty(address(plain), tokenId, ROYALTY);
        assertEq(license.ownerOf(tokenId), address(plain));
    }

    function test_reentrantReceiver_passesTokenOn_bothTransfersPayRoyalty() public {
        RelayReceiver relay = new RelayReceiver(license, usd, buyer2);
        token.mint(address(relay), ROYALTY);
        _approveToken(buyer, address(license), ROYALTY);
        uint256 b0 = _bal(buyer);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 x0 = _bal(buyer2);

        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, buyer, address(relay), creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.expectEmit(address(license));
        emit SolversLicense.RoyaltyPaid(tokenId, address(relay), buyer2, creator, ROYALTY_C, ROYALTY_P, false, false);
        vm.prank(buyer);
        license.safeTransferFrom(buyer, address(relay), tokenId);

        assertEq(relay.hops(), 1);
        assertEq(license.ownerOf(tokenId), buyer2);
        assertEq(license.balanceOf(buyer), 0);
        assertEq(license.balanceOf(address(relay)), 0);
        assertEq(license.balanceOf(buyer2), 1);
        assertEq(b0 - _bal(buyer), ROYALTY, "first hop paid by buyer");
        assertEq(_bal(address(relay)), 0, "second hop paid by the relay");
        assertEq(_bal(buyer2), x0);
        assertEq(_bal(creator) - c0, 2 * ROYALTY_C);
        assertEq(_bal(treasury) - t0, 2 * ROYALTY_P);
        _assertNoDeferred();
    }

    function test_reentrantReceiver_cannotPaySecondHop_wholeTransferReverts() public {
        RelayReceiver relay = new RelayReceiver(license, usd, buyer2); // unfunded
        _approveToken(buyer, address(license), ROYALTY);
        Bals memory b0 = _bals(buyer, address(relay));
        vm.expectRevert(abi.encodeWithSelector(SolversLicense.RoyaltyNotPaid.selector, ROYALTY));
        vm.prank(buyer);
        license.safeTransferFrom(buyer, address(relay), tokenId);
        _assertUnchanged(b0, buyer, address(relay));
        assertEq(license.ownerOf(tokenId), buyer);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // ERC-721 auth paths
    // ---------------------------------------------------------------------------------------------------------------

    function test_transfer_authErrors() public {
        _approveToken(buyer, address(license), 10 * ROYALTY);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, tokenId));
        vm.prank(stranger);
        license.transferFrom(buyer, stranger, tokenId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, tokenId));
        vm.prank(stranger);
        license.transferWithRoyalty(stranger, tokenId, ROYALTY);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721IncorrectOwner.selector, buyer2, tokenId, buyer));
        vm.prank(buyer);
        license.transferFrom(buyer2, stranger, tokenId);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0)));
        vm.prank(buyer);
        license.transferFrom(buyer, address(0), tokenId);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(0)));
        vm.prank(buyer);
        license.transferWithRoyalty(address(0), tokenId, ROYALTY);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        vm.prank(buyer);
        license.transferWithRoyalty(buyer2, 999, ROYALTY);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, 999);

        assertEq(license.ownerOf(tokenId), buyer);
        assertEq(usd.allowance(buyer, address(license)), 10 * ROYALTY);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // ERC-2981 + ERC-165
    // ---------------------------------------------------------------------------------------------------------------

    function test_royaltyInfo_fixedBase_receiverIsLicense() public {
        uint256[4] memory sales = [uint256(0), 1, 50_000_000, 1e30];
        for (uint256 i; i < sales.length; ++i) {
            (address recv, uint256 amt) = license.royaltyInfo(tokenId, sales[i]);
            assertEq(recv, address(license));
            assertEq(amt, ROYALTY, "independent of salePrice");
        }
        vm.prank(creator);
        registry.updatePricing(AGENT, 50_000_000, 0);
        (, uint256 a2) = license.royaltyInfo(tokenId, 1);
        assertEq(a2, ROYALTY, "original price, not the current one");

        _setConfig(FEE_BPS, 1000, MIN_PRICE);
        (, uint256 a3) = license.royaltyInfo(tokenId, 1);
        assertEq(a3, 1_500_000, "follows the live platform bps");

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 999));
        license.royaltyInfo(999, 1);
    }

    /// @dev Documented: `royaltyInfo` floors the summed bps (plan formula) while the enforced royalty floors each share,
    /// so the informational amount can exceed the charged one by at most 1 base unit.
    function test_royaltyInfo_equalsChargedAmount() public {
        _setConfig(FEE_BPS, 1000, 1);
        _registerActiveWith(creator2, AGENT2, 19, 500);
        uint256 id = _buyAt(buyer, AGENT2, 19);
        (, uint256 c,, uint256 p) = license.quoteRoyalty(id);
        (, uint256 info) = license.royaltyInfo(id, 0);
        assertEq(c + p, 1); // 0 + 1
        assertEq(info, 1); // each share floored like the charge (not floor(19 * 1500 / 10000) = 2)
    }

    function test_supportsInterface() public view {
        assertTrue(license.supportsInterface(type(IERC721).interfaceId));
        assertTrue(license.supportsInterface(type(IERC721Metadata).interfaceId));
        assertTrue(license.supportsInterface(type(IERC2981).interfaceId));
        assertTrue(license.supportsInterface(type(IERC165).interfaceId));
        assertEq(type(IERC721).interfaceId, bytes4(0x80ac58cd));
        assertEq(type(IERC721Metadata).interfaceId, bytes4(0x5b5e139f));
        assertEq(type(IERC2981).interfaceId, bytes4(0x2a55205a));
        assertEq(type(IERC165).interfaceId, bytes4(0x01ffc9a7));
        assertFalse(license.supportsInterface(type(IERC721Enumerable).interfaceId));
        assertFalse(license.supportsInterface(0xffffffff));
    }
}
