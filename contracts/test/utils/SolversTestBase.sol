// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ITIP20} from "tempo-std/interfaces/ITIP20.sol";
import {ITIP20RolesAuth} from "tempo-std/interfaces/ITIP20RolesAuth.sol";
import {ITIP403Registry} from "tempo-std/interfaces/ITIP403Registry.sol";
import {StdPrecompiles} from "tempo-std/StdPrecompiles.sol";
import {StdTokens} from "tempo-std/StdTokens.sol";

import {SolversRegistry} from "../../src/SolversRegistry.sol";
import {SolversLicense} from "../../src/SolversLicense.sol";
import {SolversCredits} from "../../src/SolversCredits.sol";
import {SolversReviews} from "../../src/SolversReviews.sol";
import {SolversEscrow} from "../../src/SolversEscrow.sol";
import {SolversStaking} from "../../src/SolversStaking.sol";
import {AgentRegistration} from "../../src/interfaces/ISolversRegistry.sol";
import {PLATFORM_ROLE, VERIFIER_ROLE, USAGE_ROLE, GUARDIAN_ROLE} from "../../src/SolversTypes.sol";

interface IReceivePolicies {
    function setReceivePolicy(uint64 senderPolicyId, uint64 tokenFilterId, address recoveryAuthority) external;
}

/// @notice Deploys the six contracts behind ERC1967 proxies against a REAL TIP-20 token created through the Tempo
/// TIP20Factory precompile (forge runs with `tempo = true`), so transfers, permits, TIP-403 policies and receive
/// policies behave exactly as on Tempo.
abstract contract SolversTestBase is Test {
    address internal constant RECEIVE_POLICY_GUARD = 0xB10C000000000000000000000000000000000000;

    uint16 internal constant FEE_BPS = 1000;
    uint16 internal constant PLATFORM_ROYALTY_BPS = 500;
    uint16 internal constant CREATOR_ROYALTY_BPS = 500;
    uint96 internal constant MIN_STAKE = 20_000_000;
    uint96 internal constant MIN_PRICE = 5_000_000;
    uint96 internal constant PRICE = 10_000_000;
    uint96 internal constant PRICE_PER_USE = 1_000_000;

    ITIP20 internal token;
    IERC20 internal usd;

    SolversRegistry internal registry;
    SolversLicense internal license;
    SolversCredits internal credits;
    SolversReviews internal reviews;
    SolversEscrow internal escrow;
    SolversStaking internal staking;

    address internal admin = makeAddr("admin");
    address internal treasury = makeAddr("treasury");
    address internal platform = makeAddr("platform");
    address internal verifier = makeAddr("verifier");
    address internal guardian = makeAddr("guardian");
    address internal creator = makeAddr("creator");
    address internal creator2 = makeAddr("creator2");
    address internal buyer = makeAddr("buyer");
    address internal buyer2 = makeAddr("buyer2");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant AGENT = bytes32(bytes16(0xc71ad0a50f750e75c71ad0a50f750e75));
    bytes32 internal constant AGENT2 = bytes32(bytes16(0x0123456789abcdef0123456789abcdef));
    bytes32 internal constant VERSION_HASH = keccak256("v1");

    uint256 private purchaseNonce;

    function setUp() public virtual {
        StdPrecompiles.TIP_FEE_MANAGER.setUserToken(StdTokens.PATH_USD_ADDRESS);
        token = ITIP20(
            StdPrecompiles.TIP20_FACTORY
                .createToken("Test USD", "tUSD", "USD", StdTokens.PATH_USD, address(this), keccak256("solvers-test"))
        );
        ITIP20RolesAuth(address(token)).grantRole(token.ISSUER_ROLE(), address(this));
        usd = IERC20(address(token));
        _deploy(MIN_STAKE);
        address[8] memory funded = [creator, creator2, buyer, buyer2, stranger, platform, admin, address(this)];
        for (uint256 i; i < funded.length; ++i) {
            token.mint(funded[i], 1_000_000_000_000);
        }
    }

    function _deploy(uint96 minStake) internal {
        registry = SolversRegistry(
            address(
                new ERC1967Proxy(
                    address(new SolversRegistry()),
                    abi.encodeCall(
                        SolversRegistry.initialize,
                        (admin, 0, address(token), treasury, FEE_BPS, PLATFORM_ROYALTY_BPS, minStake, MIN_PRICE)
                    )
                )
            )
        );
        license = SolversLicense(
            address(
                new ERC1967Proxy(
                    address(new SolversLicense()),
                    abi.encodeCall(SolversLicense.initialize, (address(registry), "https://api.test/api/license/"))
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
        registry.grantRole(USAGE_ROLE, platform);
        registry.grantRole(VERIFIER_ROLE, verifier);
        registry.grantRole(GUARDIAN_ROLE, guardian);
        vm.stopPrank();
    }

    // ---- helpers ----

    function _registration(bytes32 agentId, uint96 price, uint96 ppu, uint16 royaltyBps)
        internal
        pure
        returns (AgentRegistration memory)
    {
        return AgentRegistration({
            agentId: agentId,
            metadataUri: "https://api.test/agents/x.json",
            version: "1.0.0",
            versionHash: VERSION_HASH,
            price: price,
            pricePerUse: ppu,
            royaltyBps: royaltyBps
        });
    }

    function _register(address who, bytes32 agentId, uint96 price, uint96 ppu, uint16 royaltyBps) internal {
        vm.startPrank(who);
        usd.approve(address(staking), registry.minStake());
        registry.registerAgent(_registration(agentId, price, ppu, royaltyBps));
        vm.stopPrank();
    }

    function _registerActive(address who, bytes32 agentId) internal {
        _register(who, agentId, PRICE, PRICE_PER_USE, CREATOR_ROYALTY_BPS);
        vm.prank(admin);
        registry.approveAgent(agentId);
    }

    function _pid() internal returns (bytes32) {
        return keccak256(abi.encode("pid", ++purchaseNonce));
    }

    function _buy(address who, bytes32 agentId) internal returns (uint256 tokenId) {
        vm.startPrank(who);
        usd.approve(address(license), PRICE);
        tokenId = license.purchaseLicense(agentId, PRICE, _pid());
        vm.stopPrank();
    }

    /// @dev Makes `account` refuse inbound transfers from everyone (TIP-403 receive policy, originator recovery).
    function _blockReceives(address account) internal {
        uint64 pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(account, ITIP403Registry.PolicyType.WHITELIST);
        vm.prank(account);
        IReceivePolicies(address(StdPrecompiles.TIP403_REGISTRY)).setReceivePolicy(pid, 1, address(0));
    }

    /// @dev Token-level TIP-403 blacklist (the token issuer blocks `account`); transfers to it revert.
    function _blacklist(address account) internal {
        uint64 pid = StdPrecompiles.TIP403_REGISTRY.createPolicy(address(this), ITIP403Registry.PolicyType.BLACKLIST);
        StdPrecompiles.TIP403_REGISTRY.modifyPolicyBlacklist(pid, account, true);
        token.changeTransferPolicyId(pid);
    }

    function _bal(address who) internal view returns (uint256) {
        return usd.balanceOf(who);
    }
}
