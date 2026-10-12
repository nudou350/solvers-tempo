// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {ITIP403Registry} from "tempo-std/interfaces/ITIP403Registry.sol";

import {SolversTestBase, IReceivePolicies} from "./utils/SolversTestBase.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversPayouts} from "../src/base/SolversPayouts.sol";
import {AgentView, Reputation} from "../src/interfaces/ISolversRegistry.sol";
import {
    SaleKind,
    PAUSE_ENTRIES,
    PAUSE_TRANSFERS,
    PLATFORM_ROLE,
    AgentNotFound,
    Paused,
    PriceChanged,
    PriceTooLow,
    ZeroAddress,
    NothingToClaim,
    RecipientBlocked
} from "../src/SolversTypes.sol";

// =====================================================================================================================
// helper contracts
// =====================================================================================================================

/// @dev A contract buyer WITHOUT `onERC721Received`.
contract NoReceiverBuyer {
    function buy(SolversLicense lic, IERC20 t, bytes32 agentId, uint96 price, bytes32 pid) external returns (uint256) {
        t.approve(address(lic), price);
        return lic.purchaseLicense(agentId, price, pid);
    }
}

/// @dev A contract buyer WITH `onERC721Received` (OZ ERC721Holder).
contract HolderBuyer is ERC721Holder {
    function buy(SolversLicense lic, IERC20 t, bytes32 agentId, uint96 price, bytes32 pid) external returns (uint256) {
        t.approve(address(lic), price);
        return lic.purchaseLicense(agentId, price, pid);
    }
}

/// @dev Receiver that tries to move the freshly minted token on from inside the mint hook (purchase is nonReentrant).
contract ReentrantMintReceiver is IERC721Receiver {
    SolversLicense internal immutable lic;
    address internal immutable next;

    constructor(SolversLicense lic_, address next_) {
        lic = lic_;
        next = next_;
    }

    function buy(IERC20 t, bytes32 agentId, uint96 price, bytes32 pid) external returns (uint256) {
        t.approve(address(lic), type(uint256).max);
        return lic.purchaseLicense(agentId, price, pid);
    }

    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        lic.transferFrom(address(this), next, tokenId);
        return IERC721Receiver.onERC721Received.selector;
    }
}

// =====================================================================================================================
// shared base for the License suites
// =====================================================================================================================

abstract contract LicenseTestBase is SolversTestBase {
    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    /// @dev Default agent: PRICE = 10 USD, fee 10%, royalty 5% creator + 5% platform.
    uint256 internal constant FEE = 1_000_000;
    uint256 internal constant CREATOR_SHARE = 9_000_000;
    uint256 internal constant ROYALTY_C = 500_000;
    uint256 internal constant ROYALTY_P = 500_000;
    uint256 internal constant ROYALTY = 1_000_000;

    /// @dev Lifts the TIP-403 receive policy installed by `_blockReceives` (sender policy 1 = built-in always-allow).
    function _unblockReceives(address account) internal {
        vm.prank(account);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(1, 1, address(0));
    }

    /// @dev Receive policy that accepts inbound transfers only from `allowedSender` (whitelist sender policy).
    function _receiveOnlyFrom(address account, address allowedSender) internal {
        uint64 pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(account, ITIP403Registry.PolicyType.WHITELIST);
        vm.startPrank(account);
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyWhitelist(pid, allowedSender, true);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(pid, 1, address(0));
        vm.stopPrank();
    }

    /// @dev Lifts the token-level blacklist installed by `_blacklist` (policy 1 = built-in always-allow).
    function _clearTokenPolicy() internal {
        token.changeTransferPolicyId(1);
    }

    function _signPermit(uint256 pk, address owner, address spender, uint256 value, uint256 deadline)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, token.nonces(owner), deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (v, r, s) = vm.sign(pk, digest);
    }

    function _approveToken(address owner, address spender, uint256 amount) internal {
        vm.prank(owner);
        usd.approve(spender, amount);
    }

    function _ref(SaleKind kind, uint256 id) internal pure returns (bytes32) {
        return bytes32((uint256(uint8(kind)) << 248) | id);
    }

    function _registerActiveWith(address who, bytes32 agentId, uint96 price, uint16 royaltyBps) internal {
        _register(who, agentId, price, 0, royaltyBps);
        vm.prank(admin);
        registry.approveAgent(agentId);
    }

    function _setConfig(uint16 feeBps, uint16 platformRoyaltyBps, uint96 minPrice) internal {
        vm.prank(admin);
        registry.setConfig(treasury, feeBps, platformRoyaltyBps, MIN_STAKE, minPrice);
    }

    function _buyAt(address who, bytes32 agentId, uint96 price) internal returns (uint256 tokenId) {
        vm.startPrank(who);
        usd.approve(address(license), price);
        tokenId = license.purchaseLicense(agentId, price, _pid());
        vm.stopPrank();
    }

    function _countLogs(Vm.Log[] memory logs, address emitter, bytes32 topic0) internal pure returns (uint256 n) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == emitter && logs[i].topics.length > 0 && logs[i].topics[0] == topic0) ++n;
        }
    }

    function _assertNoDeferred() internal view {
        assertEq(license.totalDeferred(), 0, "totalDeferred");
        assertEq(_bal(address(license)), 0, "license holds no tokens");
    }
}

// =====================================================================================================================
// purchase, burn, reviews, sweep
// =====================================================================================================================

contract LicenseTest is LicenseTestBase {
    struct PurchaseState {
        uint256 tokenId;
        address owner;
        bytes32 agentId;
        uint96 originalPrice;
        uint40 mintedAt;
        uint64 reviewId;
        uint256 totalMinted;
        uint32 totalSales;
        bytes32 ref;
        uint32 buyerPurchases;
        uint256 creatorBal;
        uint256 treasuryBal;
        uint256 buyerNftBal;
    }

    function _state(uint256 tokenId, bytes32 pid) internal view returns (PurchaseState memory s) {
        s.tokenId = tokenId;
        s.owner = license.ownerOf(tokenId);
        (s.agentId, s.originalPrice, s.mintedAt, s.reviewId) = license.licenseOf(tokenId);
        s.totalMinted = license.totalMinted();
        s.totalSales = registry.getAgent(AGENT).totalSales;
        s.ref = registry.purchaseRef(buyer, pid) | registry.purchaseRef(platform, pid); // ids are scoped by payer
        s.buyerPurchases = registry.reputationOf(buyer).purchases;
        s.creatorBal = _bal(creator);
        s.treasuryBal = _bal(treasury);
        s.buyerNftBal = license.balanceOf(buyer);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // initialization / metadata
    // ---------------------------------------------------------------------------------------------------------------

    function test_initialize_metadataAndLinks() public view {
        assertEq(license.name(), "Solvers License");
        assertEq(license.symbol(), "SOLVERS");
        assertEq(address(license.registry()), address(registry));
        assertEq(address(license.paymentToken()), address(token));
        assertEq(license.totalMinted(), 0);
    }

    function test_initialize_cannotRunTwice() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        license.initialize(address(registry), "x");
    }

    function test_implementation_initializersDisabled() public {
        SolversLicense impl = new SolversLicense();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(registry), "x");
    }

    function test_permitDomainSeparator_isEip712NameVersion1() public view {
        bytes32 expected = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(token.name())),
                keccak256("1"),
                block.chainid,
                address(token)
            )
        );
        assertEq(token.DOMAIN_SEPARATOR(), expected);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // purchaseLicense: split, events, ids, views
    // ---------------------------------------------------------------------------------------------------------------

    function test_purchase_exactSplit_feeFloorRemainderToCreator() public {
        _registerActiveWith(creator, AGENT, 5_000_009, CREATOR_ROYALTY_BPS);
        uint256 b0 = _bal(buyer);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);

        vm.startPrank(buyer);
        usd.approve(address(license), 5_000_009);
        bytes32 pid = _pid();
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(AGENT, buyer, 1, buyer, 5_000_009, 500_000, 4_500_009, pid, false, false);
        license.purchaseLicense(AGENT, 5_000_009, pid);
        vm.stopPrank();

        assertEq(_bal(treasury) - t0, 500_000, "treasury = floor(10%)");
        assertEq(_bal(creator) - c0, 4_500_009, "creator = remainder");
        assertEq(b0 - _bal(buyer), 5_000_009, "buyer paid exactly the price");
        assertEq(usd.allowance(buyer, address(license)), 0, "allowance consumed");
        _assertNoDeferred();
    }

    function testFuzz_purchase_splitConservesPrice(uint96 price, uint16 feeBps) public {
        price = uint96(bound(price, MIN_PRICE, 1e16));
        feeBps = uint16(bound(feeBps, 0, 2000));
        token.mint(buyer, price);
        _setConfig(feeBps, PLATFORM_ROYALTY_BPS, MIN_PRICE);
        _registerActiveWith(creator, AGENT, price, CREATOR_ROYALTY_BPS);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 b0 = _bal(buyer);
        _buyAt(buyer, AGENT, price);
        uint256 fee = uint256(price) * feeBps / 10_000;
        assertEq(_bal(treasury) - t0, fee);
        assertEq(_bal(creator) - c0, price - fee);
        assertEq(b0 - _bal(buyer), price);
        _assertNoDeferred();
    }

    function test_purchase_zeroFeeSkipsTreasury() public {
        _setConfig(0, PLATFORM_ROYALTY_BPS, MIN_PRICE);
        _registerActive(creator, AGENT);
        uint256 t0 = _bal(treasury);
        uint256 c0 = _bal(creator);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(AGENT, buyer, 1, buyer, PRICE, 0, PRICE, pid, false, false);
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
        assertEq(_bal(treasury), t0);
        assertEq(_bal(creator) - c0, PRICE);
    }

    function test_purchase_emitsSaleAuthorizedAndRecordsRef() public {
        _registerActive(creator, AGENT);
        bytes32 pid = keccak256("order-1");
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectEmit(address(registry));
        emit SolversRegistry.SaleAuthorized(pid, AGENT, buyer, buyer, SaleKind.License, bytes32(uint256(1)));
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
        assertEq(registry.purchaseRef(buyer, pid), _ref(SaleKind.License, 1));
    }

    function test_purchase_tokenIdSequence_tokenURI_licenseOf_totalMinted() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        vm.warp(1_800_000_000);
        uint256 id1 = _buy(buyer, AGENT);
        vm.warp(1_800_000_100);
        uint256 id2 = _buy(buyer2, AGENT2);
        uint256 id3 = _buy(buyer, AGENT);
        assertEq(id1, 1);
        assertEq(id2, 2);
        assertEq(id3, 3);
        assertEq(license.totalMinted(), 3);
        assertEq(license.ownerOf(1), buyer);
        assertEq(license.ownerOf(2), buyer2);
        assertEq(license.balanceOf(buyer), 2);
        assertEq(license.tokenURI(1), "https://api.test/api/license/1");
        assertEq(license.tokenURI(3), "https://api.test/api/license/3");

        (bytes32 agentId, uint96 originalPrice, uint40 mintedAt, uint64 reviewId) = license.licenseOf(2);
        assertEq(agentId, AGENT2);
        assertEq(originalPrice, PRICE);
        assertEq(mintedAt, 1_800_000_100);
        assertEq(reviewId, 0);
        (agentId,, mintedAt,) = license.licenseOf(1);
        assertEq(agentId, AGENT);
        assertEq(mintedAt, 1_800_000_000);
        assertEq(license.agentIndexOf(1), 0);
        assertEq(license.agentIndexOf(2), 1);

        assertEq(registry.getAgent(AGENT).totalSales, 2);
        assertEq(registry.getAgent(AGENT2).totalSales, 1);
        assertEq(registry.reputationOf(buyer).purchases, 2);
    }

    function test_views_nonexistentToken_revert() public {
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        license.licenseOf(7);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        license.tokenURI(7);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        license.agentIndexOf(7);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 7));
        license.ownerOf(7);
    }

    function test_setBaseURI_adminOnly_changesTokenURI() public {
        _registerActive(creator, AGENT);
        _buy(buyer, AGENT);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0))
        );
        vm.prank(stranger);
        license.setBaseURI("https://evil/");

        vm.expectEmit(address(license));
        emit SolversLicense.BaseURISet("https://solvers.example/api/license/");
        vm.prank(admin);
        license.setBaseURI("https://solvers.example/api/license/");
        assertEq(license.tokenURI(1), "https://solvers.example/api/license/1");
    }

    // ---------------------------------------------------------------------------------------------------------------
    // purchaseLicenseFor
    // ---------------------------------------------------------------------------------------------------------------

    function test_purchaseFor_matchesDirectPurchaseExceptPayer() public {
        _registerActive(creator, AGENT);
        bytes32 pid = keccak256("charge-42");
        uint256 buyer0 = _bal(buyer);
        uint256 platform0 = _bal(platform);
        uint256 snap = vm.snapshotState();

        // direct
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(
            AGENT, buyer, 1, buyer, PRICE, uint96(FEE), uint96(CREATOR_SHARE), pid, false, false
        );
        uint256 idA = license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
        PurchaseState memory a = _state(idA, pid);
        assertEq(buyer0 - _bal(buyer), PRICE, "direct: buyer pays");
        assertEq(_bal(platform), platform0, "direct: platform untouched");

        vm.revertToState(snap);

        // on behalf
        _approveToken(platform, address(license), PRICE);
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(
            AGENT, buyer, 1, platform, PRICE, uint96(FEE), uint96(CREATOR_SHARE), pid, false, false
        );
        vm.prank(platform);
        uint256 idB = license.purchaseLicenseFor(buyer, AGENT, PRICE, pid);
        PurchaseState memory b = _state(idB, pid);
        assertEq(_bal(buyer), buyer0, "for: buyer untouched");
        assertEq(platform0 - _bal(platform), PRICE, "for: platform pays");

        assertEq(keccak256(abi.encode(a)), keccak256(abi.encode(b)), "identical state");
        assertEq(b.owner, buyer);
        assertEq(b.ref, _ref(SaleKind.License, 1));
    }

    function test_purchaseFor_nonPlatform_reverts() public {
        _registerActive(creator, AGENT);
        _approveToken(stranger, address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, PLATFORM_ROLE)
        );
        vm.prank(stranger);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, pid);

        // the buyer itself cannot use the For entry either
        _approveToken(buyer, address(license), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, buyer, PLATFORM_ROLE)
        );
        vm.prank(buyer);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, pid);

        // the admin does not hold PLATFORM_ROLE either
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, admin, PLATFORM_ROLE)
        );
        vm.prank(admin);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, pid);
        assertEq(license.totalMinted(), 0);
    }

    function test_purchaseFor_zeroBuyer_reverts() public {
        _registerActive(creator, AGENT);
        _approveToken(platform, address(license), PRICE);
        vm.expectRevert(ZeroAddress.selector);
        vm.prank(platform);
        license.purchaseLicenseFor(address(0), AGENT, PRICE, _pid());
    }

    function test_purchase_zeroPurchaseId_reverts() public {
        _registerActive(creator, AGENT);
        _approveToken(buyer, address(license), PRICE);
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, bytes32(0));
        _approveToken(platform, address(license), PRICE);
        vm.expectRevert(SolversRegistry.InvalidPurchaseId.selector);
        vm.prank(platform);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, bytes32(0));
    }

    function test_purchaseFor_contractBuyerWithoutReceiver_revertsAtomically() public {
        _registerActive(creator, AGENT);
        NoReceiverBuyer nr = new NoReceiverBuyer();
        _approveToken(platform, address(license), PRICE);
        uint256 p0 = _bal(platform);
        uint256 c0 = _bal(creator);
        bytes32 pid = _pid();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(nr)));
        vm.prank(platform);
        license.purchaseLicenseFor(address(nr), AGENT, PRICE, pid);
        assertEq(_bal(platform), p0);
        assertEq(_bal(creator), c0);
        assertEq(registry.purchaseRef(platform, pid), bytes32(0));
        assertEq(license.totalMinted(), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // purchaseLicenseWithPermit
    // ---------------------------------------------------------------------------------------------------------------

    function test_purchaseWithPermit_realSignature_singleCall() public {
        _registerActive(creator, AGENT);
        (address signer, uint256 pk) = makeAddrAndKey("permitBuyer");
        token.mint(signer, 100_000_000);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), PRICE, deadline);
        assertTrue(v == 27 || v == 28);
        assertEq(usd.allowance(signer, address(license)), 0);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);

        bytes32 pid = _pid();
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(
            AGENT, signer, 1, signer, PRICE, uint96(FEE), uint96(CREATOR_SHARE), pid, false, false
        );
        vm.prank(signer);
        uint256 id = license.purchaseLicenseWithPermit(AGENT, PRICE, pid, deadline, v, r, s);

        assertEq(license.ownerOf(id), signer);
        assertEq(token.nonces(signer), 1, "permit consumed");
        assertEq(usd.allowance(signer, address(license)), 0);
        assertEq(_bal(signer), 100_000_000 - PRICE);
        assertEq(_bal(creator) - c0, CREATOR_SHARE);
        assertEq(_bal(treasury) - t0, FEE);
    }

    function test_purchaseWithPermit_frontRunPermit_stillWorks() public {
        _registerActive(creator, AGENT);
        (address signer, uint256 pk) = makeAddrAndKey("permitBuyer");
        token.mint(signer, 100_000_000);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), PRICE, deadline);

        // a front-runner submits the permit first: the allowance exists, the permit inside the purchase fails
        vm.prank(stranger);
        token.permit(signer, address(license), PRICE, deadline, v, r, s);
        assertEq(usd.allowance(signer, address(license)), PRICE);

        vm.prank(signer);
        uint256 id = license.purchaseLicenseWithPermit(AGENT, PRICE, _pid(), deadline, v, r, s);
        assertEq(license.ownerOf(id), signer);
        assertEq(token.nonces(signer), 1);
    }

    function test_purchaseWithPermit_expiredPermitWithExistingAllowance_works() public {
        _registerActive(creator, AGENT);
        (address signer, uint256 pk) = makeAddrAndKey("permitBuyer");
        token.mint(signer, 100_000_000);
        _approveToken(signer, address(license), PRICE);
        vm.warp(1_900_000_000);
        uint256 deadline = block.timestamp - 1;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), PRICE, deadline);
        vm.prank(signer);
        uint256 id = license.purchaseLicenseWithPermit(AGENT, PRICE, _pid(), deadline, v, r, s);
        assertEq(license.ownerOf(id), signer);
        assertEq(token.nonces(signer), 0, "expired permit not consumed");
    }

    function test_purchaseWithPermit_badSignatureNoAllowance_revertsWithTokenError() public {
        _registerActive(creator, AGENT);
        (address signer,) = makeAddrAndKey("permitBuyer");
        (, uint256 otherPk) = makeAddrAndKey("someoneElse");
        token.mint(signer, 100_000_000);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(otherPk, signer, address(license), PRICE, deadline);
        uint256 c0 = _bal(creator);
        bytes32 pid = _pid();
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(signer);
        license.purchaseLicenseWithPermit(AGENT, PRICE, pid, deadline, v, r, s);
        assertEq(_bal(signer), 100_000_000);
        assertEq(_bal(creator), c0);
        assertEq(license.totalMinted(), 0);
        assertEq(registry.purchaseRef(signer, pid), bytes32(0));
    }

    function test_purchaseWithPermit_permitForLowerValue_ignoredAndReverts() public {
        _registerActive(creator, AGENT);
        (address signer, uint256 pk) = makeAddrAndKey("permitBuyer");
        token.mint(signer, 100_000_000);
        uint256 deadline = block.timestamp + 1 hours;
        // signed for less than the price: the permit call (value = expectedPrice) fails its signature check
        (uint8 v, bytes32 r, bytes32 s) = _signPermit(pk, signer, address(license), PRICE - 1, deadline);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(signer);
        license.purchaseLicenseWithPermit(AGENT, PRICE, _pid(), deadline, v, r, s);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // purchase guards
    // ---------------------------------------------------------------------------------------------------------------

    function test_purchase_priceChanged_revertsWithCurrentPrice() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        registry.updatePricing(AGENT, 12_000_000, 0);
        _approveToken(buyer, address(license), 20_000_000);

        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, uint256(12_000_000)));
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, _pid());

        // strict equality: an expected price above the current one is rejected too
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, uint256(12_000_000)));
        vm.prank(buyer);
        license.purchaseLicense(AGENT, 13_000_000, _pid());

        _approveToken(platform, address(license), 20_000_000);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, uint256(12_000_000)));
        vm.prank(platform);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, _pid());

        vm.prank(buyer);
        uint256 id = license.purchaseLicense(AGENT, 12_000_000, _pid());
        (, uint96 originalPrice,,) = license.licenseOf(id);
        assertEq(originalPrice, 12_000_000);
    }

    function test_purchaseWithPermit_priceChanged() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        registry.updatePricing(AGENT, 12_000_000, 0);
        _approveToken(buyer, address(license), 20_000_000);
        vm.expectRevert(abi.encodeWithSelector(PriceChanged.selector, uint256(12_000_000)));
        vm.prank(buyer);
        license.purchaseLicenseWithPermit(AGENT, PRICE, _pid(), 0, 27, bytes32(0), bytes32(0));
    }

    function test_purchase_duplicatePurchaseId_reverts() public {
        _registerActive(creator, AGENT);
        bytes32 pid = keccak256("dup");
        _approveToken(buyer, address(license), 2 * PRICE);
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, pid);

        vm.expectRevert(
            abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, pid, _ref(SaleKind.License, 1))
        );
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, pid);

        // ids are scoped by payer: the same id paid by the platform is a different purchase (nobody can burn an id
        // they do not pay for), and the platform cannot reuse it either
        _approveToken(platform, address(license), 2 * PRICE);
        vm.prank(platform);
        license.purchaseLicenseFor(buyer2, AGENT, PRICE, pid);
        assertEq(license.totalMinted(), 2);
        assertEq(registry.purchaseRef(platform, pid), _ref(SaleKind.License, 2));
        assertEq(registry.purchaseRef(buyer, pid), _ref(SaleKind.License, 1));
        vm.expectRevert(
            abi.encodeWithSelector(SolversRegistry.DuplicatePurchase.selector, pid, _ref(SaleKind.License, 2))
        );
        vm.prank(platform);
        license.purchaseLicenseFor(buyer2, AGENT, PRICE, pid);
    }

    function test_purchase_duplicatePurchaseIdAcrossKinds_reverts() public {
        _registerActive(creator, AGENT);
        bytes32 pid = keccak256("cross-kind");
        vm.startPrank(buyer);
        usd.approve(address(credits), 5 * PRICE_PER_USE);
        credits.buyCredits(AGENT, 5, 5 * PRICE_PER_USE, pid);
        usd.approve(address(license), PRICE);
        vm.expectRevert(
            abi.encodeWithSelector(
                SolversRegistry.DuplicatePurchase.selector, pid, _ref(SaleKind.Credits, uint160(buyer))
            )
        );
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
    }

    function test_purchase_selfPurchase_reverts() public {
        _registerActive(creator, AGENT);
        _approveToken(creator, address(license), PRICE);
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        vm.prank(creator);
        license.purchaseLicense(AGENT, PRICE, _pid());

        _approveToken(platform, address(license), PRICE);
        vm.expectRevert(SolversRegistry.SelfPurchase.selector);
        vm.prank(platform);
        license.purchaseLicenseFor(creator, AGENT, PRICE, _pid());
    }

    function test_purchase_soldOut_capAndBurnDoesNotFreeSlot() public {
        _registerActive(creator, AGENT);
        vm.prank(creator);
        registry.setSupplyCap(AGENT, 2);
        uint256 id1 = _buy(buyer, AGENT);
        _buy(buyer2, AGENT);

        _approveToken(stranger, address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(2)));
        vm.prank(stranger);
        license.purchaseLicense(AGENT, PRICE, _pid());

        vm.prank(buyer);
        license.burn(id1);
        assertEq(registry.getAgent(AGENT).totalSales, 2, "burn never frees a slot");
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(2)));
        vm.prank(stranger);
        license.purchaseLicense(AGENT, PRICE, _pid());

        // platform path hits the same cap
        _approveToken(platform, address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(2)));
        vm.prank(platform);
        license.purchaseLicenseFor(stranger, AGENT, PRICE, _pid());

        // raising the cap opens exactly one more slot
        vm.prank(creator);
        registry.setSupplyCap(AGENT, 3);
        vm.prank(stranger);
        uint256 id3 = license.purchaseLicense(AGENT, PRICE, _pid());
        assertEq(id3, 3);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.SoldOut.selector, AGENT, uint32(3)));
        vm.prank(platform);
        license.purchaseLicenseFor(stranger, AGENT, PRICE, _pid());
    }

    function test_purchase_entriesPaused_reverts_allEntryPoints() public {
        _registerActive(creator, AGENT);
        vm.prank(guardian);
        registry.setPause(PAUSE_ENTRIES);
        _approveToken(buyer, address(license), PRICE);
        _approveToken(platform, address(license), PRICE);

        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, _pid());
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        vm.prank(platform);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, _pid());
        vm.expectRevert(abi.encodeWithSelector(Paused.selector, PAUSE_ENTRIES));
        vm.prank(buyer);
        license.purchaseLicenseWithPermit(AGENT, PRICE, _pid(), 0, 27, bytes32(0), bytes32(0));

        vm.prank(admin);
        registry.setPause(0);
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, _pid());
        assertEq(license.totalMinted(), 1);
    }

    function test_purchase_transfersPauseDoesNotBlockPurchase() public {
        _registerActive(creator, AGENT);
        vm.prank(admin);
        registry.setPause(PAUSE_TRANSFERS);
        uint256 id = _buy(buyer, AGENT);
        assertEq(license.ownerOf(id), buyer);
    }

    function test_purchase_inactiveOrUnknownAgent_reverts() public {
        _register(creator, AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS); // Pending
        _approveToken(buyer, address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, _pid());

        vm.prank(admin);
        registry.approveAgent(AGENT);
        vm.prank(admin);
        registry.suspendAgent(AGENT);
        vm.expectRevert(abi.encodeWithSelector(SolversRegistry.AgentNotActive.selector, AGENT));
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, _pid());

        vm.expectRevert(abi.encodeWithSelector(AgentNotFound.selector, AGENT2));
        vm.prank(buyer);
        license.purchaseLicense(AGENT2, PRICE, _pid());
    }

    function test_purchase_contractBuyerWithoutReceiver_revertsAtomically() public {
        _registerActive(creator, AGENT);
        NoReceiverBuyer nr = new NoReceiverBuyer();
        token.mint(address(nr), PRICE);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        bytes32 pid = _pid();
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidReceiver.selector, address(nr)));
        nr.buy(license, usd, AGENT, PRICE, pid);
        assertEq(_bal(address(nr)), PRICE, "no token moved");
        assertEq(_bal(creator), c0);
        assertEq(_bal(treasury), t0);
        assertEq(license.totalMinted(), 0);
        assertEq(registry.getAgent(AGENT).totalSales, 0);
        assertEq(registry.purchaseRef(address(nr), pid), bytes32(0));
        _assertNoDeferred();
    }

    function test_purchase_contractBuyerWithReceiver_works() public {
        _registerActive(creator, AGENT);
        HolderBuyer hb = new HolderBuyer();
        token.mint(address(hb), PRICE);
        uint256 id = hb.buy(license, usd, AGENT, PRICE, _pid());
        assertEq(license.ownerOf(id), address(hb));
        assertEq(_bal(address(hb)), 0);
    }

    function test_purchase_receiverReenteringInMintHook_revertsAtomically() public {
        _registerActive(creator, AGENT);
        ReentrantMintReceiver rr = new ReentrantMintReceiver(license, buyer2);
        token.mint(address(rr), 10 * PRICE);
        uint256 c0 = _bal(creator);
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        rr.buy(usd, AGENT, PRICE, _pid());
        assertEq(_bal(address(rr)), 10 * PRICE);
        assertEq(_bal(creator), c0);
        assertEq(license.totalMinted(), 0);
    }

    function test_purchase_buyerReceiveBlocked_irrelevantForNft() public {
        _registerActive(creator, AGENT);
        _blockReceives(buyer);
        uint256 c0 = _bal(creator);
        uint256 id = _buy(buyer, AGENT);
        assertEq(license.ownerOf(id), buyer);
        assertEq(_bal(creator) - c0, CREATOR_SHARE);
        _assertNoDeferred();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // deferred payouts on purchase
    // ---------------------------------------------------------------------------------------------------------------

    function test_purchase_creatorReceiveBlocked_sharesDeferred_claimAfterUnblock() public {
        _registerActive(creator, AGENT);
        _blockReceives(creator);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        uint256 b0 = _bal(buyer);
        uint256 guard0 = _bal(RECEIVE_POLICY_GUARD);

        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectEmit(address(license));
        emit SolversPayouts.PayoutDeferred(creator, CREATOR_SHARE, CREATOR_SHARE);
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(
            AGENT, buyer, 1, buyer, PRICE, uint96(FEE), uint96(CREATOR_SHARE), pid, true, false
        );
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();

        assertEq(_bal(creator), c0, "creator not paid directly");
        assertEq(_bal(treasury) - t0, FEE, "treasury paid directly");
        assertEq(b0 - _bal(buyer), PRICE, "buyer paid exactly the price");
        assertEq(_bal(RECEIVE_POLICY_GUARD), guard0, "nothing parked in the guard");
        assertEq(license.deferredOf(creator), CREATOR_SHARE);
        assertEq(license.totalDeferred(), CREATOR_SHARE);
        assertEq(_bal(address(license)), license.totalDeferred(), "balance == totalDeferred");

        // a second sale accumulates
        _buy(buyer2, AGENT);
        assertEq(license.deferredOf(creator), 2 * CREATOR_SHARE);
        assertEq(_bal(address(license)), 2 * CREATOR_SHARE);

        vm.expectRevert(abi.encodeWithSelector(RecipientBlocked.selector, creator));
        vm.prank(creator);
        license.claim();

        vm.expectRevert(NothingToClaim.selector);
        vm.prank(stranger);
        license.claim();

        _unblockReceives(creator);
        vm.expectEmit(address(license));
        emit SolversPayouts.PayoutClaimed(creator, 2 * CREATOR_SHARE);
        vm.prank(creator);
        license.claim();
        assertEq(_bal(creator) - c0, 2 * CREATOR_SHARE, "claim pays exactly");
        assertEq(license.deferredOf(creator), 0);
        _assertNoDeferred();

        vm.expectRevert(NothingToClaim.selector);
        vm.prank(creator);
        license.claim();
    }

    function test_purchaseFor_creatorReceiveBlocked_pullsFromPlatform() public {
        _registerActive(creator, AGENT);
        _blockReceives(creator);
        _approveToken(platform, address(license), PRICE);
        uint256 p0 = _bal(platform);
        vm.prank(platform);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, _pid());
        assertEq(p0 - _bal(platform), PRICE);
        assertEq(license.deferredOf(creator), CREATOR_SHARE);
        assertEq(_bal(address(license)), CREATOR_SHARE);
    }

    function test_purchase_treasuryBlacklisted_feeDeferred() public {
        _registerActive(creator, AGENT);
        _blacklist(treasury);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);

        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectEmit(address(license));
        emit SolversPayouts.PayoutDeferred(treasury, FEE, FEE);
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(
            AGENT, buyer, 1, buyer, PRICE, uint96(FEE), uint96(CREATOR_SHARE), pid, false, true
        );
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();

        assertEq(_bal(treasury), t0);
        assertEq(_bal(creator) - c0, CREATOR_SHARE);
        assertEq(license.deferredOf(treasury), FEE);
        assertEq(_bal(address(license)), license.totalDeferred());

        // token-level policy still blocks: the claim's transfer itself reverts with the token error
        vm.expectRevert(ITIP20.PolicyForbids.selector);
        vm.prank(treasury);
        license.claim();

        _clearTokenPolicy();
        vm.prank(treasury);
        license.claim();
        assertEq(_bal(treasury) - t0, FEE);
        _assertNoDeferred();
    }

    function test_purchase_bothRecipientsBlocked_bothDeferred() public {
        _registerActive(creator, AGENT);
        _blockReceives(creator);
        _blacklist(treasury);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        bytes32 pid = _pid();
        vm.expectEmit(address(license));
        emit SolversLicense.LicensePurchased(
            AGENT, buyer, 1, buyer, PRICE, uint96(FEE), uint96(CREATOR_SHARE), pid, true, true
        );
        license.purchaseLicense(AGENT, PRICE, pid);
        vm.stopPrank();
        assertEq(license.totalDeferred(), PRICE);
        assertEq(_bal(address(license)), PRICE);
    }

    /// @dev The pre-check asks `validateReceivePolicy(token, payer, recipient)`. This pins that the precompile judges
    /// a `transferFrom` by its `from` (the payer), not by `msg.sender` (this contract): a creator who accepts only the
    /// buyer is paid directly, with nothing parked in ReceivePolicyGuard.
    function test_purchase_receivePolicyJudgedOnPayer_whitelistedPayerPaidDirectly() public {
        _registerActive(creator, AGENT);
        _receiveOnlyFrom(creator, buyer);
        uint256 c0 = _bal(creator);
        uint256 guard0 = _bal(RECEIVE_POLICY_GUARD);
        _buy(buyer, AGENT);
        assertEq(_bal(creator) - c0, CREATOR_SHARE, "paid directly");
        assertEq(_bal(RECEIVE_POLICY_GUARD), guard0, "nothing redirected to the guard");
        _assertNoDeferred();
    }

    /// @dev A creator who accepts only the License contract as sender: the payer push is deferred and the claim
    /// (sender = License) is deliverable at once.
    function test_purchase_receiveOnlyFromLicense_deferredThenClaimable() public {
        _registerActive(creator, AGENT);
        _receiveOnlyFrom(creator, address(license));
        uint256 c0 = _bal(creator);
        uint256 guard0 = _bal(RECEIVE_POLICY_GUARD);
        _buy(buyer, AGENT);
        assertEq(license.deferredOf(creator), CREATOR_SHARE);
        assertEq(_bal(RECEIVE_POLICY_GUARD), guard0);
        vm.prank(creator);
        license.claim();
        assertEq(_bal(creator) - c0, CREATOR_SHARE);
        assertEq(_bal(RECEIVE_POLICY_GUARD), guard0);
        _assertNoDeferred();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // payer-side failures: bubble up, nothing deferred
    // ---------------------------------------------------------------------------------------------------------------

    function test_purchase_noAllowance_revertsTokenError_noStateChange() public {
        _registerActive(creator, AGENT);
        uint256 b0 = _bal(buyer);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        bytes32 pid = _pid();
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, pid);
        assertEq(_bal(buyer), b0);
        assertEq(_bal(creator), c0);
        assertEq(_bal(treasury), t0);
        assertEq(license.totalMinted(), 0);
        assertEq(registry.getAgent(AGENT).totalSales, 0);
        assertEq(registry.reputationOf(buyer).purchases, 0);
        assertEq(registry.purchaseRef(buyer, pid), bytes32(0));
        _assertNoDeferred();
    }

    function test_purchase_partialAllowance_reverts() public {
        _registerActive(creator, AGENT);
        _approveToken(buyer, address(license), FEE); // enough for the treasury share only
        uint256 t0 = _bal(treasury);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(buyer);
        license.purchaseLicense(AGENT, PRICE, _pid());
        assertEq(_bal(treasury), t0, "treasury push rolled back");
        _assertNoDeferred();
    }

    function test_purchase_noBalance_revertsTokenError_noStateChange() public {
        _registerActive(creator, AGENT);
        address poor = makeAddr("poor");
        _approveToken(poor, address(license), PRICE);
        uint256 t0 = _bal(treasury);
        vm.expectRevert(abi.encodeWithSelector(ITIP20.InsufficientBalance.selector, 0, FEE, address(token)));
        vm.prank(poor);
        license.purchaseLicense(AGENT, PRICE, _pid());
        assertEq(_bal(treasury), t0);
        assertEq(license.totalMinted(), 0);
        _assertNoDeferred();
    }

    function test_purchase_payerBlockedAndCreatorBlocked_revertsNotDeferred() public {
        // payer-side failure while a recipient is blocked: the retry into the contract fails too and bubbles up
        _registerActive(creator, AGENT);
        _blockReceives(creator);
        address poor = makeAddr("poor");
        _approveToken(poor, address(license), PRICE);
        vm.expectRevert(abi.encodeWithSelector(ITIP20.InsufficientBalance.selector, 0, FEE, address(token)));
        vm.prank(poor);
        license.purchaseLicense(AGENT, PRICE, _pid());
        _assertNoDeferred();
    }

    function test_purchaseFor_platformWithoutAllowance_reverts() public {
        _registerActive(creator, AGENT);
        uint256 p0 = _bal(platform);
        vm.expectRevert(ITIP20.InsufficientAllowance.selector);
        vm.prank(platform);
        license.purchaseLicenseFor(buyer, AGENT, PRICE, _pid());
        assertEq(_bal(platform), p0);
        assertEq(license.totalMinted(), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // minPrice boundaries
    // ---------------------------------------------------------------------------------------------------------------

    function test_minPrice_exactBoundaryPurchase() public {
        _registerActiveWith(creator, AGENT, MIN_PRICE, CREATOR_ROYALTY_BPS);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        _buyAt(buyer, AGENT, MIN_PRICE);
        assertEq(_bal(treasury) - t0, 500_000);
        assertEq(_bal(creator) - c0, 4_500_000);
    }

    function test_minPrice_belowBoundary_cannotRegisterOrReprice() public {
        vm.startPrank(creator);
        usd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(PriceTooLow.selector);
        registry.registerAgent(_registration(AGENT, MIN_PRICE - 1, 0, CREATOR_ROYALTY_BPS));
        vm.stopPrank();

        _registerActive(creator, AGENT);
        vm.expectRevert(PriceTooLow.selector);
        vm.prank(creator);
        registry.updatePricing(AGENT, MIN_PRICE - 1, 0);
    }

    /// @dev Documented behaviour: minPrice is enforced at registerAgent/updatePricing only. If the admin raises
    /// minPrice later, licenses keep selling at the stored price (the previous implementation had no minimum check at
    /// purchase either; Credits/Escrow check their computed total). See the report.
    function test_minPrice_raisedAfterRegistration_blocksSalesBelowIt() public {
        _registerActive(creator, AGENT);
        _setConfig(FEE_BPS, PLATFORM_ROYALTY_BPS, PRICE + 1);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE);
        vm.expectRevert(PriceTooLow.selector);
        license.purchaseLicense(AGENT, PRICE, keccak256("min-price"));
        vm.stopPrank();
        // the creator re-prices at or above the new minimum and sales resume
        vm.prank(creator);
        registry.updatePricing(AGENT, PRICE + 1, PRICE_PER_USE);
        vm.startPrank(buyer);
        usd.approve(address(license), PRICE + 1);
        uint256 id = license.purchaseLicense(AGENT, PRICE + 1, keccak256("min-price-2"));
        vm.stopPrank();
        assertEq(license.ownerOf(id), buyer);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // burn
    // ---------------------------------------------------------------------------------------------------------------

    function test_burn_byOwner_royaltyExempt_licenseDataKept() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        uint256 b0 = _bal(buyer);
        uint256 c0 = _bal(creator);
        uint256 t0 = _bal(treasury);
        assertEq(usd.allowance(buyer, address(license)), 0);

        vm.recordLogs();
        vm.expectEmit(address(license));
        emit IERC721Transfer.Transfer(buyer, address(0), id);
        vm.prank(buyer);
        license.burn(id);
        assertEq(
            _countLogs(vm.getRecordedLogs(), address(license), SolversLicense.RoyaltyPaid.selector), 0, "no royalty"
        );

        assertEq(_bal(buyer), b0);
        assertEq(_bal(creator), c0);
        assertEq(_bal(treasury), t0);
        assertEq(license.balanceOf(buyer), 0);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        license.ownerOf(id);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        license.tokenURI(id);
        assertEq(license.totalMinted(), 1, "ids are never reused");
        assertEq(registry.getAgent(AGENT).totalSales, 1, "cap slot not freed");

        // Decision (from the code): the license slot is not deleted on burn, so the purchase record stays readable
        // (licenseOf, agentIndexOf, quoteRoyalty, royaltyInfo); ownership-dependent paths (tokenURI, transfers,
        // useForReview) treat the token as gone.
        (bytes32 agentId, uint96 originalPrice,,) = license.licenseOf(id);
        assertEq(agentId, AGENT);
        assertEq(originalPrice, PRICE);
        (, uint256 c,, uint256 p) = license.quoteRoyalty(id);
        assertEq(c + p, ROYALTY);

        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        vm.prank(buyer);
        license.transferFrom(buyer, buyer2, id);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, id));
        vm.prank(buyer);
        license.burn(id);
    }

    function test_burn_byApprovedAndOperator() public {
        _registerActive(creator, AGENT);
        uint256 id1 = _buy(buyer, AGENT);
        uint256 id2 = _buy(buyer, AGENT);
        vm.startPrank(buyer);
        license.approve(stranger, id1);
        license.setApprovalForAll(buyer2, true);
        vm.stopPrank();
        uint256 s0 = _bal(stranger);
        uint256 o0 = _bal(buyer2);

        vm.prank(stranger);
        license.burn(id1);
        vm.prank(buyer2);
        license.burn(id2);
        assertEq(license.balanceOf(buyer), 0);
        assertEq(_bal(stranger), s0);
        assertEq(_bal(buyer2), o0);
    }

    function test_burn_unauthorized_reverts() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, stranger, id));
        vm.prank(stranger);
        license.burn(id);
        // the creator has no special power over sold licenses
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InsufficientApproval.selector, creator, id));
        vm.prank(creator);
        license.burn(id);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721NonexistentToken.selector, 99));
        vm.prank(buyer);
        license.burn(99);
    }

    function test_burn_worksWhileTransfersAndEntriesPaused() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        vm.prank(admin);
        registry.setPause(PAUSE_ENTRIES | PAUSE_TRANSFERS);
        vm.prank(buyer);
        license.burn(id);
        assertEq(license.balanceOf(buyer), 0);
    }

    // ---------------------------------------------------------------------------------------------------------------
    // useForReview
    // ---------------------------------------------------------------------------------------------------------------

    function test_useForReview_onlyReviews() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        vm.expectRevert(SolversLicense.NotReviews.selector);
        vm.prank(buyer);
        license.useForReview(id, buyer, AGENT, 1);
        vm.expectRevert(SolversLicense.NotReviews.selector);
        vm.prank(admin);
        license.useForReview(id, buyer, AGENT, 1);
        vm.expectRevert(SolversLicense.NotReviews.selector);
        vm.prank(address(registry));
        license.useForReview(id, buyer, AGENT, 1);
    }

    function test_useForReview_notOwner() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        vm.startPrank(address(reviews));
        vm.expectRevert(SolversLicense.NotOwner.selector);
        license.useForReview(id, buyer2, AGENT, 1);
        // nonexistent token with author 0 (owner 0 == author 0) is still rejected
        vm.expectRevert(SolversLicense.NotOwner.selector);
        license.useForReview(42, address(0), AGENT, 1);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        license.useForReview(42, buyer, AGENT, 1);
        vm.stopPrank();
    }

    function test_useForReview_wrongAgent() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        uint256 id = _buy(buyer, AGENT);
        vm.startPrank(address(reviews));
        vm.expectRevert(SolversLicense.WrongAgent.selector);
        license.useForReview(id, buyer, AGENT2, 1);
        vm.expectRevert(SolversLicense.WrongAgent.selector);
        license.useForReview(id, buyer, keccak256("unknown"), 1);
        vm.stopPrank();
    }

    function test_useForReview_firstUseBinds_laterReturnsBoundId() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        vm.startPrank(address(reviews));
        vm.expectEmit(address(license));
        emit SolversLicense.LicenseReviewed(id, 77);
        assertEq(license.useForReview(id, buyer, AGENT, 77), 77);

        vm.recordLogs();
        assertEq(license.useForReview(id, buyer, AGENT, 88), 77, "stays bound to the first review");
        assertEq(_countLogs(vm.getRecordedLogs(), address(license), SolversLicense.LicenseReviewed.selector), 0);
        vm.stopPrank();
        (,,, uint64 reviewId) = license.licenseOf(id);
        assertEq(reviewId, 77);
    }

    function test_reviews_bindingSemantics() public {
        _registerActive(creator, AGENT);
        uint256 t1 = _buy(buyer, AGENT);

        // first use binds t1 to buyer's review
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(t1), 4, keccak256("ok"));
        uint64 rid = reviews.reviewOf(AGENT, buyer).id;
        assertGt(rid, 0);
        (,,, uint64 bound) = license.licenseOf(t1);
        assertEq(bound, rid);

        // same author, same license: edit
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(t1), 2, keccak256("meh"));
        (uint64 sum, uint32 count) = reviews.ratingOf(AGENT);
        assertEq(sum, 2);
        assertEq(count, 1);

        // the used license moves to buyer2: it cannot back a second review
        vm.startPrank(buyer);
        usd.approve(address(license), ROYALTY);
        license.transferWithRoyalty(buyer2, t1, ROYALTY);
        vm.stopPrank();
        vm.expectRevert(abi.encodeWithSelector(SolversReviews.LicenseAlreadyReviewed.selector, t1));
        vm.prank(buyer2);
        reviews.submitReview(AGENT, uint64(t1), 5, keccak256("x"));

        // the former owner can no longer use it either
        vm.expectRevert(SolversLicense.NotOwner.selector);
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(t1), 3, keccak256("y"));

        // buyer2 with a fresh license reviews normally
        uint256 t2 = _buy(buyer2, AGENT);
        vm.prank(buyer2);
        reviews.submitReview(AGENT, uint64(t2), 5, keccak256("great"));
        uint64 rid2 = reviews.reviewOf(AGENT, buyer2).id;
        assertTrue(rid2 != rid);
        (,,, bound) = license.licenseOf(t2);
        assertEq(bound, rid2);
        (sum, count) = reviews.ratingOf(AGENT);
        assertEq(sum, 7);
        assertEq(count, 2);

        // buyer re-uses ANOTHER license of the same agent: it binds to buyer's existing review (edit)
        uint256 t3 = _buy(buyer, AGENT);
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(t3), 3, keccak256("again"));
        (,,, bound) = license.licenseOf(t3);
        assertEq(bound, rid);
        assertEq(reviews.reviewOf(AGENT, buyer).id, rid);
        (sum, count) = reviews.ratingOf(AGENT);
        assertEq(sum, 8);
        assertEq(count, 2);
    }

    function test_reviews_licenseOfOtherAgent_wrongAgent() public {
        _registerActive(creator, AGENT);
        _registerActive(creator2, AGENT2);
        uint256 t = _buy(buyer, AGENT2);
        vm.expectRevert(SolversLicense.WrongAgent.selector);
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(t), 5, keccak256("x"));
    }

    function test_reviews_creatorWithTransferredLicense_selfReview() public {
        _registerActive(creator, AGENT);
        uint256 t = _buy(buyer, AGENT);
        vm.startPrank(buyer);
        usd.approve(address(license), ROYALTY);
        license.transferWithRoyalty(creator, t, ROYALTY);
        vm.stopPrank();
        vm.expectRevert(SolversReviews.SelfReview.selector);
        vm.prank(creator);
        reviews.submitReview(AGENT, uint64(t), 5, keccak256("me"));
    }

    function test_reviews_burnedLicense_notOwner() public {
        _registerActive(creator, AGENT);
        uint256 t = _buy(buyer, AGENT);
        vm.prank(buyer);
        license.burn(t);
        vm.expectRevert(SolversLicense.NotOwner.selector);
        vm.prank(buyer);
        reviews.submitReview(AGENT, uint64(t), 5, keccak256("x"));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // sweepStray
    // ---------------------------------------------------------------------------------------------------------------

    function test_sweepStray_adminOnly_sweepsDirectTransfers() public {
        vm.prank(stranger);
        usd.transfer(address(license), 123);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0))
        );
        vm.prank(stranger);
        license.sweepStray(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, platform, bytes32(0))
        );
        vm.prank(platform);
        license.sweepStray(platform);

        vm.expectRevert(ZeroAddress.selector);
        vm.prank(admin);
        license.sweepStray(address(0));

        uint256 a0 = _bal(admin);
        vm.expectEmit(address(license));
        emit SolversPayouts.StraySwept(admin, 123);
        vm.prank(admin);
        license.sweepStray(admin);
        assertEq(_bal(admin) - a0, 123);
        assertEq(_bal(address(license)), 0);

        vm.expectRevert(NothingToClaim.selector);
        vm.prank(admin);
        license.sweepStray(admin);
    }

    function test_sweepStray_neverTouchesDeferred() public {
        _registerActive(creator, AGENT);
        _blockReceives(creator);
        _buy(buyer, AGENT);
        assertEq(license.totalDeferred(), CREATOR_SHARE);

        vm.expectRevert(NothingToClaim.selector);
        vm.prank(admin);
        license.sweepStray(admin);

        // e.g. a marketplace paying the ERC-2981 amount to `royaltyInfo`'s receiver (this contract)
        vm.prank(stranger);
        usd.transfer(address(license), 777);
        uint256 a0 = _bal(admin);
        vm.prank(admin);
        license.sweepStray(admin);
        assertEq(_bal(admin) - a0, 777);
        assertEq(_bal(address(license)), CREATOR_SHARE);
        assertEq(license.totalDeferred(), CREATOR_SHARE);

        vm.expectRevert(NothingToClaim.selector);
        vm.prank(admin);
        license.sweepStray(admin);

        _unblockReceives(creator);
        uint256 c0 = _bal(creator);
        vm.prank(creator);
        license.claim();
        assertEq(_bal(creator) - c0, CREATOR_SHARE);
        _assertNoDeferred();
    }
}

interface IERC721Transfer {
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
}
