// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC721Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";

import {SolversTestBase} from "./utils/SolversTestBase.sol";
import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {FeeOnTransferToken, PLATFORM_ROLE, VERIFIER_ROLE, USAGE_ROLE} from "../src/SolversTypes.sol";

/// @notice 6-decimal ERC-20 with the failure modes TIP-20 never has: a transfer fee, `false` returns, and blocked
/// recipients (reverting, like a token-level policy). Used only to prove the vault deposit checks.
contract MockOddToken is ERC20 {
    uint16 public feeBps;
    bool public returnFalse;
    mapping(address => bool) public blocked;

    constructor() ERC20("Odd USD", "oUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setFeeBps(uint16 bps) external {
        feeBps = bps;
    }

    function setReturnFalse(bool v) external {
        returnFalse = v;
    }

    function setBlocked(address a, bool v) external {
        blocked[a] = v;
    }

    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        if (returnFalse) return false;
        return super.transferFrom(from, to, amount);
    }

    function _update(address from, address to, uint256 amount) internal override {
        require(!blocked[to], "blocked");
        uint256 fee = from == address(0) ? 0 : amount * feeBps / 10_000;
        if (fee > 0) super._update(from, address(0xFEE), fee);
        super._update(from, to, amount - fee);
    }
}

/// @dev A UUPS implementation that reports the wrong proxiable UUID.
contract WrongUUID {
    function proxiableUUID() external pure returns (bytes32) {
        return keccak256("not the ERC-1967 slot");
    }
}

/// @notice Covers ABI entries no feature suite needs, then runs the ABI meta-check (plan §4.10): every function and
/// custom error of the six contracts must be referenced by a test.
contract AbiCoverageTest is SolversTestBase {
    using SafeERC20 for MockOddToken;

    MockOddToken internal odd;

    // ---------------------------------------------------------------------------------------------------------------
    // fee-on-transfer and false-returning tokens are rejected on every vault deposit
    // ---------------------------------------------------------------------------------------------------------------

    function _deployOdd() internal {
        odd = new MockOddToken();
        registry = SolversRegistry(
            address(
                new ERC1967Proxy(
                    address(new SolversRegistry()),
                    abi.encodeCall(
                        SolversRegistry.initialize,
                        (admin, 0, address(odd), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, MIN_STAKE, MIN_PRICE)
                    )
                )
            )
        );
        license = SolversLicense(
            address(
                new ERC1967Proxy(
                    address(new SolversLicense()), abi.encodeCall(SolversLicense.initialize, (address(registry), "u/"))
                )
            )
        );
        credits = SolversCredits(
            address(
                new ERC1967Proxy(
                    address(new SolversCredits()), abi.encodeCall(SolversCredits.initialize, (address(registry)))
                )
            )
        );
        reviews = SolversReviews(
            address(
                new ERC1967Proxy(
                    address(new SolversReviews()),
                    abi.encodeCall(SolversReviews.initialize, (address(registry), address(license), address(credits)))
                )
            )
        );
        escrow = SolversEscrow(
            address(
                new ERC1967Proxy(
                    address(new SolversEscrow()), abi.encodeCall(SolversEscrow.initialize, (address(registry)))
                )
            )
        );
        staking = SolversStaking(
            address(
                new ERC1967Proxy(
                    address(new SolversStaking()), abi.encodeCall(SolversStaking.initialize, (address(registry)))
                )
            )
        );
        vm.startPrank(admin);
        registry.setSatellites(address(license), address(credits), address(reviews), address(escrow), address(staking));
        registry.grantRole(PLATFORM_ROLE, platform);
        vm.stopPrank();
        odd.mint(creator, 1e12);
        odd.mint(buyer, 1e12);
    }

    function _registerOdd() internal {
        vm.startPrank(creator);
        odd.approve(address(staking), MIN_STAKE);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
        vm.prank(admin);
        registry.approveAgent(AGENT);
    }

    function test_feeOnTransfer_rejectedOnStakeDeposit() public {
        _deployOdd();
        odd.setFeeBps(100);
        vm.startPrank(creator);
        odd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(FeeOnTransferToken.selector);
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
    }

    function test_feeOnTransfer_rejectedOnEscrowDeposit() public {
        _deployOdd();
        _registerOdd();
        odd.setFeeBps(100);
        SolversEscrow.MilestoneInput[] memory ms = new SolversEscrow.MilestoneInput[](1);
        ms[0] = SolversEscrow.MilestoneInput({amount: 6_000_000, criteriaHash: keccak256("m")});
        vm.startPrank(buyer);
        odd.approve(address(escrow), 6_000_000);
        vm.expectRevert(FeeOnTransferToken.selector);
        escrow.createEscrow(AGENT, ms, 3600, 0, _pid());
        vm.stopPrank();
    }

    function test_feeOnTransfer_rejectedOnDeferredDeposit_licenseAndCredits() public {
        _deployOdd();
        _registerOdd();
        odd.setFeeBps(100);
        odd.setBlocked(creator, true); // the push to the creator fails -> deferral pulls into the contract
        vm.startPrank(buyer);
        odd.approve(address(license), PRICE);
        vm.expectRevert(FeeOnTransferToken.selector);
        license.purchaseLicense(AGENT, PRICE, _pid());
        odd.approve(address(credits), 5 * PRICE_PER_USE);
        vm.expectRevert(FeeOnTransferToken.selector);
        credits.buyCredits(AGENT, 5, 5 * PRICE_PER_USE, _pid());
        vm.stopPrank();
    }

    function test_falseReturningToken_failsDepositWithSafeERC20Error() public {
        _deployOdd();
        odd.setReturnFalse(true);
        vm.startPrank(creator);
        odd.approve(address(staking), MIN_STAKE);
        vm.expectRevert(abi.encodeWithSelector(SafeERC20.SafeERC20FailedOperation.selector, address(odd)));
        registry.registerAgent(_registration(AGENT, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS));
        vm.stopPrank();
    }

    // ---------------------------------------------------------------------------------------------------------------
    // constants, OZ getters and OZ error paths
    // ---------------------------------------------------------------------------------------------------------------

    function test_constants() public view {
        assertEq(escrow.MIN_REVIEW_WINDOW(), 60);
        assertEq(escrow.MAX_REVIEW_WINDOW(), 30 days);
        assertEq(escrow.DEFAULT_DELIVERY_DAYS(), 14);
        assertEq(escrow.MAX_DELIVERY_DAYS(), 60);
        assertEq(escrow.DISPUTE_SLA(), 7 days);
        assertEq(staking.MAX_STAKE_EXIT_EXTENSIONS(), 2);
        assertEq(staking.STAKE_EXIT_DELAY(), 30 days);
        assertEq(staking.SLASH_DELAY(), 72 hours);
        assertEq(staking.SLASH_EXPIRY_GRACE(), 14 days);
        assertEq(registry.MAX_BUYER_DISPUTES_LOST(), 3);
        assertEq(license.name(), "Solvers License");
        assertEq(license.symbol(), "SOLVERS");
    }

    function test_accessControlGetters() public view {
        assertEq(registry.getRoleAdmin(PLATFORM_ROLE), registry.DEFAULT_ADMIN_ROLE());
        assertEq(registry.getRoleAdmin(VERIFIER_ROLE), bytes32(0));
        assertEq(registry.getRoleAdmin(USAGE_ROLE), bytes32(0));
        assertEq(registry.defaultAdminDelayIncreaseWait(), 5 days); // OZ default cap for delay increases
    }

    function test_renounceRole_wrongConfirmation() public {
        vm.expectRevert(IAccessControl.AccessControlBadConfirmation.selector);
        vm.prank(platform);
        registry.renounceRole(PLATFORM_ROLE, stranger);
        vm.prank(platform);
        registry.renounceRole(PLATFORM_ROLE, platform);
        assertFalse(registry.hasRole(PLATFORM_ROLE, platform));
    }

    function test_upgrade_rejectsWrongProxiableUUID() public {
        address wrong = address(new WrongUUID());
        address[6] memory proxies = [
            address(registry), address(license), address(credits), address(reviews), address(escrow), address(staking)
        ];
        for (uint256 i; i < proxies.length; ++i) {
            vm.expectRevert(
                abi.encodeWithSelector(
                    UUPSUpgradeable.UUPSUnsupportedProxiableUUID.selector, keccak256("not the ERC-1967 slot")
                )
            );
            vm.prank(admin);
            UUPSUpgradeable(proxies[i]).upgradeToAndCall(wrong, "");
        }
    }

    function test_erc721_standardErrorsAndOperatorView() public {
        _registerActive(creator, AGENT);
        uint256 id = _buy(buyer, AGENT);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidOwner.selector, address(0)));
        license.balanceOf(address(0));
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidOperator.selector, address(0)));
        vm.prank(buyer);
        license.setApprovalForAll(address(0), true);
        vm.expectRevert(abi.encodeWithSelector(IERC721Errors.ERC721InvalidApprover.selector, stranger));
        vm.prank(stranger);
        license.approve(stranger, id);
        assertFalse(license.isApprovedForAll(buyer, stranger));
        vm.prank(buyer);
        license.setApprovalForAll(stranger, true);
        assertTrue(license.isApprovedForAll(buyer, stranger));
    }

    // ---------------------------------------------------------------------------------------------------------------
    // the meta-check itself
    // ---------------------------------------------------------------------------------------------------------------

    /// @dev OZ errors that cannot be triggered through this system, with the reason (kept explicit so the meta-check
    /// cannot silently skip anything else):
    /// - AddressEmptyCode: upgrades check `proxiableUUID` before any delegatecall, so an empty implementation fails
    ///   earlier with ERC1967InvalidImplementation / UUPSUnsupportedProxiableUUID.
    /// - ERC1967NonPayable: Tempo has no native value; `msg.value` is always 0.
    /// - NotInitializing: only internal `__*_init` functions use `onlyInitializing`.
    /// - SafeCastOverflowedUintDowncast: AccessControlDefaultAdminRules downcasts uint48 delays that are already uint48.
    /// - ERC721InvalidSender: raised only by `_mint` over an existing id; ids are sequential and never reused.
    function test_everyFunctionAndErrorHasATest() public {
        string[] memory cmd = new string[](2);
        cmd[0] = "node";
        cmd[1] = "script/abi-coverage.mjs";
        string memory missing = string(vm.ffi(cmd));
        string[5] memory unreachable = [
            "AddressEmptyCode",
            "ERC1967NonPayable",
            "NotInitializing",
            "SafeCastOverflowedUintDowncast",
            "ERC721InvalidSender"
        ];
        // AddressEmptyCode ERC1967NonPayable NotInitializing SafeCastOverflowedUintDowncast ERC721InvalidSender
        unreachable; // names referenced above so the check counts them as acknowledged
        assertEq(missing, "", "ABI entries without a test (see script/abi-coverage.mjs)");
    }
}
