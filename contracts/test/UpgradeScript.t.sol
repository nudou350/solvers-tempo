// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {ERC1967Utils} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Utils.sol";

import {RegistryHelpers} from "./Registry.t.sol";
import {
    IVersioned,
    SolversRegistryV2,
    SolversLicenseV2,
    SolversCreditsV2,
    SolversReviewsV2,
    SolversEscrowV2,
    SolversStakingV2
} from "./Upgrade.t.sol";
import {Upgrade} from "../script/Upgrade.s.sol";

/// @notice The planning, guards and calldata of script/Upgrade.s.sol (X16), executed against the six live test proxies.
/// The ffi-based `validateUpgrade` against a reference build runs in script/upgrade-anvil.sh (anvil --tempo), because it
/// needs the OpenZeppelin upgrades-core CLI (npx) and a build with exactly one build-info per contract.
contract UpgradeScriptTest is RegistryHelpers {
    Upgrade internal script;
    string internal constant SHA = "0c876b870b948c42029c56933d886b07023f0034";
    string internal constant SHA2 = "1111111111111111111111111111111111111111";

    function setUp() public override {
        super.setUp();
        _registerActive(creator, AGENT);
        _buy(buyer, AGENT);
        script = new Upgrade();
    }

    function _proxies() internal view returns (address[6] memory) {
        return
            [address(registry), address(license), address(credits), address(reviews), address(escrow), address(staking)];
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, ERC1967Utils.IMPLEMENTATION_SLOT))));
    }

    /// Deployment file as Deploy.s.sol writes it, optionally with one recorded upgrade (implGitSha.license).
    function _json(bool withImplSha) internal returns (string memory) {
        string[6] memory keys = ["registry", "license", "credits", "reviews", "escrow", "staking"];
        address[6] memory proxies = _proxies();
        string memory impls;
        for (uint256 i; i < 6; ++i) {
            impls = vm.serializeAddress("impls", keys[i], _impl(proxies[i]));
        }
        string memory o = "dep";
        vm.serializeUint(o, "chainId", block.chainid);
        for (uint256 i; i < 6; ++i) {
            vm.serializeAddress(o, keys[i], proxies[i]);
        }
        if (withImplSha) vm.serializeString(o, "implGitSha", vm.serializeString("isha", "license", SHA2));
        vm.serializeString(o, "impls", impls);
        return vm.serializeString(o, "gitSha", SHA);
    }

    function _keys(string memory list) internal pure returns (string[] memory) {
        return vm.split(list, ",");
    }

    function test_plan_resolvesAllSix() public {
        Upgrade.Target[] memory t =
            script.plan(_json(false), _keys("registry, license,credits,REVIEWS,escrow,staking"), "reference-build");
        address[6] memory proxies = _proxies();
        assertEq(t.length, 6);
        for (uint256 i; i < 6; ++i) {
            assertEq(t[i].proxy, proxies[i]);
            assertEq(t[i].impl, _impl(proxies[i]));
            assertEq(t[i].sha, SHA);
            assertEq(t[i].referenceDir, "reference-build/sha-0c876b870b94");
        }
        assertEq(t[3].key, "reviews");
        assertEq(t[0].artifact, "SolversRegistry.sol:SolversRegistry");
        assertEq(t[0].referenceContract, "sha-0c876b870b94:src/SolversRegistry.sol:SolversRegistry");
        assertEq(script.options(t[5]).referenceBuildInfoDir, "reference-build/sha-0c876b870b94");
        assertEq(script.options(t[5]).referenceContract, "sha-0c876b870b94:src/SolversStaking.sol:SolversStaking");
    }

    function test_plan_prefersRecordedImplSha() public {
        Upgrade.Target[] memory t = script.plan(_json(true), _keys("license,credits"), "reference-build");
        assertEq(t[0].sha, SHA2);
        assertEq(t[0].referenceContract, "sha-111111111111:src/SolversLicense.sol:SolversLicense");
        assertEq(t[1].sha, SHA);
    }

    function test_plan_rejectsUnknownRepeatedAndEmpty() public {
        string memory json = _json(false);
        vm.expectRevert(bytes("unknown contract key: treasury"));
        script.plan(json, _keys("registry,treasury"), "reference-build");
        vm.expectRevert(bytes("repeated: escrow"));
        script.plan(json, _keys("escrow,ESCROW"), "reference-build");
        vm.expectRevert(bytes("UPGRADE lists no contract"));
        script.plan(json, new string[](0), "reference-build");
    }

    function test_plan_rejectsUnrecordedUpgrade() public {
        string memory json = _json(false);
        address v2 = address(new SolversLicenseV2());
        vm.prank(admin);
        license.upgradeToAndCall(v2, "");
        vm.expectRevert(
            bytes(
                "license: the implementation on chain differs from impls.license (record the previous upgrade with script/record-upgrade.mjs first)"
            )
        );
        script.plan(json, _keys("license"), "reference-build");
    }

    function test_plan_rejectsMissingSha() public {
        string memory o = "nosha";
        vm.serializeAddress(o, "registry", address(registry));
        string memory impls = vm.serializeAddress("nosha-impls", "registry", _impl(address(registry)));
        vm.serializeString(o, "impls", impls);
        string memory json = vm.serializeString(o, "gitSha", "");
        vm.expectRevert(bytes("registry: no 40-hex source commit in the deployment file"));
        script.plan(json, _keys("registry"), "reference-build");
    }

    function test_guards() public {
        assertEq(uint8(script.parseMode("validate")), uint8(Upgrade.Mode.Validate));
        assertEq(uint8(script.parseMode("prepare")), uint8(Upgrade.Mode.Prepare));
        assertEq(uint8(script.parseMode("execute")), uint8(Upgrade.Mode.Execute));
        vm.expectRevert(bytes("UPGRADE_MODE must be validate, prepare or execute"));
        script.parseMode("upgrade");

        script.checkExecutor(31_337, admin, admin);
        script.checkExecutor(42_431, admin, admin);
        vm.expectRevert(bytes("execute is refused on mainnet: use UPGRADE_MODE=prepare (X21)"));
        script.checkExecutor(4217, admin, admin);
        vm.expectRevert(bytes("execute must be signed by the default admin"));
        script.checkExecutor(31_337, stranger, admin);

        assertTrue(script.isSha(SHA));
        assertFalse(script.isSha("0C876B870B948C42029C56933D886B07023F0034"));
        assertFalse(script.isSha("0c876b8"));
    }

    /// The prepared calldata, sent by the default admin, upgrades all six proxies and keeps their state; sent by anyone
    /// else it reverts.
    function test_preparedCalldata_upgradesAllSix() public {
        address[6] memory proxies = _proxies();
        address[6] memory impls = [
            address(new SolversRegistryV2()),
            address(new SolversLicenseV2()),
            address(new SolversCreditsV2()),
            address(new SolversReviewsV2()),
            address(new SolversEscrowV2()),
            address(new SolversStakingV2())
        ];
        bytes memory reinit = abi.encodeCall(SolversRegistryV2.initializeV2, ());
        string memory before = _json(false);
        for (uint256 i; i < 6; ++i) {
            bytes memory data = script.upgradeCalldata(impls[i], i == 0 ? reinit : bytes(""));
            vm.prank(stranger);
            (bool okStranger,) = proxies[i].call(data);
            assertFalse(okStranger);
            vm.prank(admin);
            (bool ok,) = proxies[i].call(data);
            assertTrue(ok);
            assertEq(_impl(proxies[i]), impls[i]);
            assertEq(IVersioned(proxies[i]).version(), 2);
        }
        assertEq(registry.getAgent(AGENT).totalSales, 1);
        assertEq(license.totalMinted(), 1);
        assertEq(registry.defaultAdmin(), admin);

        // The new implementations are now live: a plan from the old file refuses until record-upgrade.mjs updates it.
        vm.expectRevert();
        script.plan(before, _keys("registry"), "reference-build");
    }
}
