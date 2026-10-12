// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {
    SaleKind,
    PLATFORM_ROLE,
    USAGE_ROLE,
    PAUSE_ENTRIES,
    PAUSE_PAYMENTS,
    PAUSE_TRANSFERS,
    Paused,
    PriceChanged,
    PriceTooLow,
    InvalidAmount,
    AgentNotFound
} from "../src/SolversTypes.sol";

contract CreditsTest is SolversTestBase {
    // 1_000_003 per use x 7 = 7_000_021; fee 10% = 700_002 (floor of 700_002.1), creator 6_300_019
    uint96 internal constant ODD_PPU = 1_000_003;

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
    }

    function _setPpu(uint96 ppu) internal {
        uint96 price = ppu > MIN_PRICE ? ppu : MIN_PRICE;
        vm.prank(creator);
        registry.updatePricing(AGENT, price, ppu);
    }

    function _buyCredits(address who, uint32 amount) internal returns (uint256 total) {
        total = uint256(registry.getAgent(AGENT).pricePerUse) * amount;
        vm.startPrank(who);
        usd.approve(address(credits), total);
        credits.buyCredits(AGENT, amount, total, _pid());
        vm.stopPrank();
    }

    // =====================================================================================================
    // buyCredits
    // =====================================================================================================

    function test_buyCredits_splitWithFloorFee() public {
        _setPpu(ODD_PPU);
        bytes32 pid = keccak256("credits-1");
        uint256 b0 = _bal(buyer);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);

        vm.startPrank(buyer);
        usd.approve(address(credits), 7_000_021);
        vm.expectEmit(address(credits));
        emit SolversCredits.CreditsBought(
            AGENT, buyer, buyer, 7, 7_000_021, 700_002, 6_300_019, pid, 7, 7, false, false
        );
        credits.buyCredits(AGENT, 7, 7_000_021, pid);
        vm.stopPrank();

        assertEq(b0 - _bal(buyer), 7_000_021);
        assertEq(_bal(creator) - c0, 6_300_019);
        assertEq(_bal(treasury) - t0, 700_002);
        assertEq(_bal(address(credits)), 0, "credits holds no funds");
        (uint32 remaining, uint32 purchased) = credits.creditsOf(AGENT, buyer);
        assertEq(remaining, 7);
        assertEq(purchased, 7);
        assertEq(credits.purchasedOf(AGENT, buyer), 7);
        assertEq(registry.reputationOf(buyer).purchases, 1);
        assertEq(registry.purchaseRef(buyer, pid), bytes32((uint256(uint8(SaleKind.Credits)) << 248) | uint160(buyer)));
    }

    function test_buyCredits_accumulates() public {
        _buyCredits(buyer, 5);
        _buyCredits(buyer, 6);
        (uint32 remaining, uint32 purchased) = credits.creditsOf(AGENT, buyer);
        assertEq(remaining, 11);
        assertEq(purchased, 11);
        assertEq(registry.reputationOf(buyer).purchases, 2);
    }

    function test_buyCredits_maxTotalAboveTotalChargesOnlyTotal() public {
        uint256 b0 = _bal(buyer);
        vm.startPrank(buyer);
        usd.approve(address(credits), 100_000_000);
        credits.buyCredits(AGENT, 5, 100_000_000, _pid());
        vm.stopPrank();
        assertEq(b0 - _bal(buyer), 5_000_000);
    }

    function test_buyCredits_priceChanged() public {
        vm.startPrank(buyer);
        usd.approve(address(credits), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, uint256(5_000_000)));
        credits.buyCredits(AGENT, 5, 4_999_999, _pid());
        vm.stopPrank();

        // the creator raises the price between quote and purchase
        uint256 quoted = 6 * uint256(PRICE_PER_USE);
        _setPpu(PRICE_PER_USE + 1);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, quoted + 6));
        credits.buyCredits(AGENT, 6, quoted, _pid());
    }

    function test_buyCredits_priceTooLow() public {
        vm.startPrank(buyer);
        usd.approve(address(credits), type(uint256).max);
        vm.expectRevert(PriceTooLow.selector);
        credits.buyCredits(AGENT, 4, type(uint256).max, _pid()); // 4 USD < 5 USD
        credits.buyCredits(AGENT, 5, type(uint256).max, _pid()); // exactly minPrice
        vm.stopPrank();
    }

    function test_buyCredits_payPerUseDisabled() public {
        _register(creator2, AGENT2, PRICE, 0, CREATOR_ROYALTY_BPS);
        vm.prank(admin);
        registry.approveAgent(AGENT2);
        vm.prank(buyer);
        vm.expectRevert(SolversRegistry.PayPerUseDisabled.selector);
        credits.buyCredits(AGENT2, 10, type(uint256).max, _pid());

        // disabling ppu later also blocks
        vm.prank(creator);
        registry.updatePricing(AGENT, PRICE, 0);
        vm.prank(buyer);
        vm.expectRevert(SolversRegistry.PayPerUseDisabled.selector);
        credits.buyCredits(AGENT, 10, type(uint256).max, _pid());
    }

    function test_buyCredits_zeroAmount() public {
        vm.prank(buyer);
        vm.expectRevert(InvalidAmount.selector);
        credits.buyCredits(AGENT, 0, type(uint256).max, _pid());
        vm.prank(platform);
        vm.expectRevert(InvalidAmount.selector);
        credits.buyCreditsFor(buyer, AGENT, 0, type(uint256).max, _pid());
    }

    function test_buyCredits_purchasedOverflowUint32() public {
        // with ppu = 1, the top-up that reaches exactly uint32.max is valid when it clears minPrice
        _setPpu(1);
        uint32 first = type(uint32).max - uint32(MIN_PRICE);
        vm.startPrank(buyer);
        usd.approve(address(credits), type(uint256).max);
        credits.buyCredits(AGENT, first, type(uint256).max, _pid());
        credits.buyCredits(AGENT, uint32(MIN_PRICE), type(uint256).max, _pid()); // reaches uint32.max exactly
        (, uint32 purchased) = credits.creditsOf(AGENT, buyer);
        assertEq(purchased, type(uint32).max);
        vm.expectRevert(InvalidAmount.selector);
        credits.buyCredits(AGENT, uint32(MIN_PRICE), type(uint256).max, _pid());
        vm.stopPrank();
    }

    function test_buyCredits_selfPurchase() public {
        vm.startPrank(creator);
        usd.approve(address(credits), type(uint256).max);
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        credits.buyCredits(AGENT, 10, type(uint256).max, _pid());
        vm.stopPrank();

        vm.startPrank(platform);
        usd.approve(address(credits), type(uint256).max);
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        credits.buyCreditsFor(creator, AGENT, 10, type(uint256).max, _pid());
        vm.stopPrank();
    }

    function test_buyCredits_inactiveAgentAndPause() public {
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.startPrank(buyer);
        usd.approve(address(credits), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT2));
        credits.buyCredits(AGENT2, 10, type(uint256).max, _pid());
        vm.stopPrank();

        vm.prank(admin);
        registry.setPause(PAUSE_ENTRIES);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        credits.buyCredits(AGENT, 10, type(uint256).max, _pid());

        vm.prank(admin);
        registry.setPause(PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        _buyCredits(buyer, 5);
    }

    function test_buyCredits_duplicatePurchaseId() public {
        bytes32 pid = keccak256("dup");
        vm.startPrank(buyer);
        usd.approve(address(credits), type(uint256).max);
        credits.buyCredits(AGENT, 5, type(uint256).max, pid);
        bytes32 ref = bytes32((uint256(uint8(SaleKind.Credits)) << 248) | uint160(buyer));
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, pid, ref));
        credits.buyCredits(AGENT, 5, type(uint256).max, pid);
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        credits.buyCredits(AGENT, 5, type(uint256).max, bytes32(0));
        vm.stopPrank();
    }

    function test_buyCredits_blockedCreatorDeferred() public {
        _blockReceives(creator);
        uint256 c0 = _bal(creator);
        bytes32 pid = keccak256("blocked");
        vm.startPrank(buyer);
        usd.approve(address(credits), 5_000_000);
        vm.expectEmit(address(credits));
        emit SolversCredits.CreditsBought(AGENT, buyer, buyer, 5, 5_000_000, 500_000, 4_500_000, pid, 5, 5, true, false);
        credits.buyCredits(AGENT, 5, 5_000_000, pid);
        vm.stopPrank();
        assertEq(_bal(creator), c0);
        assertEq(credits.deferredOf(creator), 4_500_000);
        assertEq(credits.totalDeferred(), 4_500_000);
        assertEq(_bal(address(credits)), 4_500_000);
    }

    // =====================================================================================================
    // buyCreditsFor / buyCreditsWithPermit
    // =====================================================================================================

    function test_buyCreditsFor_platformPays() public {
        bytes32 pid = keccak256("pix");
        uint256 p0 = _bal(platform);
        uint256 b0 = _bal(buyer);
        vm.startPrank(platform);
        usd.approve(address(credits), 5_000_000);
        vm.expectEmit(address(credits));
        emit SolversCredits.CreditsBought(
            AGENT, buyer, platform, 5, 5_000_000, 500_000, 4_500_000, pid, 5, 5, false, false
        );
        credits.buyCreditsFor(buyer, AGENT, 5, 5_000_000, pid);
        vm.stopPrank();
        assertEq(p0 - _bal(platform), 5_000_000);
        assertEq(_bal(buyer), b0);
        assertEq(credits.purchasedOf(AGENT, buyer), 5);
        assertEq(credits.purchasedOf(AGENT, platform), 0);
        assertEq(registry.reputationOf(buyer).purchases, 1);
        assertEq(registry.reputationOf(platform).purchases, 0);
    }

    function test_buyCreditsFor_onlyPlatform() public {
        address[4] memory others = [buyer, admin, verifier, creator];
        for (uint256 i; i < others.length; ++i) {
            vm.startPrank(others[i]);
            usd.approve(address(credits), type(uint256).max);
            vm.expectRevert(
                abi.encodeWithSelector(
                    IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], PLATFORM_ROLE
                )
            );
            credits.buyCreditsFor(buyer, AGENT, 5, type(uint256).max, _pid());
            vm.stopPrank();
        }
    }

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function _signPermit(uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 domain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(token.name())),
                keccak256("1"),
                block.chainid,
                address(token)
            )
        );
        assertEq(domain, token.DOMAIN_SEPARATOR());
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, token.nonces(owner), deadline));
        (v, r, s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
    }

    function test_buyCreditsWithPermit_realSignature() public {
        (address signer, uint256 pk) = makeAddrAndKey("credits-signer");
        token.mint(signer, 50_000_000);
        uint256 maxTotal = 6_000_000;
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(credits), maxTotal, deadline);
        assertTrue(v == 27 || v == 28);

        vm.prank(signer);
        credits.buyCreditsWithPermit(AGENT, 5, maxTotal, _pid(), deadline, v, r, s);
        assertEq(credits.purchasedOf(AGENT, signer), 5);
        assertEq(_bal(signer), 45_000_000);
        assertEq(token.nonces(signer), 1);
        // the permit is for maxTotal; only total was spent
        assertEq(usd.allowance(signer, address(credits)), 1_000_000);
    }

    function test_buyCreditsWithPermit_invalidPermitFallsBackToAllowance() public {
        (address signer, uint256 pk) = makeAddrAndKey("credits-signer");
        token.mint(signer, 50_000_000);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, address(0xBEEF), address(credits), 5_000_000, deadline);
        vm.prank(signer);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        credits.buyCreditsWithPermit(AGENT, 5, 5_000_000, _pid(), deadline, v, r, s);

        vm.startPrank(signer);
        usd.approve(address(credits), 5_000_000);
        credits.buyCreditsWithPermit(AGENT, 5, 5_000_000, _pid(), deadline, v, r, s);
        vm.stopPrank();
        assertEq(credits.purchasedOf(AGENT, signer), 5);
    }

    // =====================================================================================================
    // consumeCredits
    // =====================================================================================================

    function test_consumeCredits() public {
        _buyCredits(buyer, 6);
        vm.expectEmit(address(credits));
        emit SolversCredits.CreditsConsumed(AGENT, buyer, 4, 2, 4);
        vm.prank(platform);
        credits.consumeCredits(AGENT, buyer, 4);
        (uint32 remaining, uint32 purchased) = credits.creditsOf(AGENT, buyer);
        assertEq(remaining, 2);
        assertEq(purchased, 6, "purchased never decreases");
        assertEq(credits.verifiedUsesOf(AGENT), 4);

        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(SolversCredits.NoCredits.selector, uint32(2)));
        credits.consumeCredits(AGENT, buyer, 3);

        vm.prank(platform);
        credits.consumeCredits(AGENT, buyer, 2);
        (remaining,) = credits.creditsOf(AGENT, buyer);
        assertEq(remaining, 0);
        assertEq(credits.verifiedUsesOf(AGENT), 6);

        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(SolversCredits.NoCredits.selector, uint32(0)));
        credits.consumeCredits(AGENT, buyer, 1);
    }

    function test_consumeCredits_noCreditsForStranger() public {
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(SolversCredits.NoCredits.selector, uint32(0)));
        credits.consumeCredits(AGENT, stranger, 1);
    }

    function test_consumeCredits_zeroCount() public {
        _buyCredits(buyer, 5);
        vm.prank(platform);
        vm.expectRevert(InvalidAmount.selector);
        credits.consumeCredits(AGENT, buyer, 0);
    }

    function test_consumeCredits_onlyUsage() public {
        _buyCredits(buyer, 5);
        address[4] memory others = [buyer, admin, verifier, creator];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], USAGE_ROLE)
            );
            credits.consumeCredits(AGENT, buyer, 1);
        }
        // a dedicated USAGE key without PLATFORM works
        address usage = makeAddr("usage");
        vm.prank(admin);
        registry.grantRole(USAGE_ROLE, usage);
        vm.prank(usage);
        credits.consumeCredits(AGENT, buyer, 1);
    }

    function test_consumeCredits_notPaused() public {
        _buyCredits(buyer, 5);
        vm.prank(admin);
        registry.setPause(PAUSE_ENTRIES | PAUSE_PAYMENTS | PAUSE_TRANSFERS);
        vm.prank(platform);
        credits.consumeCredits(AGENT, buyer, 1);
        vm.prank(platform);
        credits.recordUsageBatch(AGENT, 3, bytes32(0));
        assertEq(credits.verifiedUsesOf(AGENT), 4);
    }

    // =====================================================================================================
    // recordUsageBatch
    // =====================================================================================================

    function test_recordUsageBatch() public {
        bytes32 root = keccak256("root");
        vm.expectEmit(address(credits));
        emit SolversCredits.UsageRecorded(AGENT, 10, root, 10);
        vm.prank(platform);
        credits.recordUsageBatch(AGENT, 10, root);
        _buyCredits(buyer, 5);
        vm.prank(platform);
        credits.consumeCredits(AGENT, buyer, 2);
        vm.expectEmit(address(credits));
        emit SolversCredits.UsageRecorded(AGENT, 5, root, 17);
        vm.prank(platform);
        credits.recordUsageBatch(AGENT, 5, root);
        assertEq(credits.verifiedUsesOf(AGENT), 17);
        assertEq(credits.verifiedUsesOf(AGENT2), 0);
    }

    function test_recordUsageBatch_pendingAgentAllowed() public {
        // only existence is required (a license holder may use a Solver that was later suspended)
        _register(creator2, AGENT2, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.prank(platform);
        credits.recordUsageBatch(AGENT2, 1, bytes32(0));
        assertEq(credits.verifiedUsesOf(AGENT2), 1);
    }

    function test_recordUsageBatch_unknownAgent() public {
        bytes32 unknown = keccak256("nope");
        vm.prank(platform);
        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, unknown));
        credits.recordUsageBatch(unknown, 1, bytes32(0));
    }

    function test_recordUsageBatch_zeroCount() public {
        vm.prank(platform);
        vm.expectRevert(InvalidAmount.selector);
        credits.recordUsageBatch(AGENT, 0, bytes32(0));
    }

    function test_recordUsageBatch_onlyUsage() public {
        address[4] memory others = [buyer, admin, verifier, creator];
        for (uint256 i; i < others.length; ++i) {
            vm.prank(others[i]);
            vm.expectRevert(
                abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, others[i], USAGE_ROLE)
            );
            credits.recordUsageBatch(AGENT, 1, bytes32(0));
        }
    }

    // =====================================================================================================
    // fuzz: pricePerUse x amount
    // =====================================================================================================

    /// @dev uint96 x uint32 always fits in uint256: PriceChanged reports the exact product, even at the extremes.
    function testFuzz_totalIsExactProduct(uint96 ppu, uint32 amount) public {
        ppu = uint96(bound(ppu, 1, type(uint96).max));
        amount = uint32(bound(amount, 1, type(uint32).max));
        _setPpu(ppu);
        uint256 expected = uint256(ppu) * uint256(amount);
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, expected));
        credits.buyCredits(AGENT, amount, expected - 1, _pid());
    }

    function test_totalAtExtremes() public {
        _setPpu(type(uint96).max);
        uint256 expected = uint256(type(uint96).max) * type(uint32).max;
        vm.prank(buyer);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, expected));
        credits.buyCredits(AGENT, type(uint32).max, expected - 1, _pid());
    }

    /// @dev Affordable range: actual purchase, exact split (fee floor, conservation).
    function testFuzz_buySplitConserves(uint96 ppu, uint32 amount) public {
        ppu = uint96(bound(ppu, 1, 1e12));
        amount = uint32(bound(amount, 1, 1e6));
        uint256 total = uint256(ppu) * amount;
        vm.assume(total >= MIN_PRICE);
        _setPpu(ppu);
        token.mint(buyer2, total);
        uint256 b0 = _bal(buyer2);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        vm.startPrank(buyer2);
        usd.approve(address(credits), total);
        credits.buyCredits(AGENT, amount, total, _pid());
        vm.stopPrank();
        uint256 fee = total * FEE_BPS / 10_000;
        assertEq(b0 - _bal(buyer2), total);
        assertEq(_bal(treasury) - t0, fee);
        assertEq(_bal(creator) - c0, total - fee);
        (uint32 remaining, uint32 purchased) = credits.creditsOf(AGENT, buyer2);
        assertEq(remaining, amount);
        assertEq(purchased, amount);
    }
}
