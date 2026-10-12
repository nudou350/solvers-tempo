// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";

import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {PLATFORM_ROLE, VERIFIER_ROLE, USAGE_ROLE, GUARDIAN_ROLE} from "../src/SolversTypes.sol";

/// @notice Deploys the six UUPS proxies (upgrade-safety validated by openzeppelin-foundry-upgrades), wires them, grants
/// the hot roles and starts the 2-step handover of DEFAULT_ADMIN to the cold admin (accept with AcceptAdmin.s.sol).
/// Writes `../deployments/<chainId>.json`.
///
/// Env: PAYMENT_TOKEN, TREASURY_ADDRESS, PLATFORM_ADDRESS, VERIFIER_ADDRESS, COLD_ADMIN, LICENSE_BASE_URI;
/// optional GUARDIAN_ADDRESS, FEE_BPS (1000), PLATFORM_ROYALTY_BPS (500), MIN_STAKE (0), MIN_PRICE (5_000_000),
/// DEPLOYMENT_NAME, GIT_SHA.
///   forge script script/Deploy.s.sol --rpc-url moderato --broadcast --private-key $DEPLOYER_PRIVATE_KEY
contract Deploy is Script {
    struct Params {
        address token;
        address treasury;
        address platform;
        address verifier;
        address guardian;
        address coldAdmin;
        uint16 feeBps;
        uint16 platformRoyaltyBps;
        uint96 minStake;
        uint96 minPrice;
        string baseURI;
        string name;
    }

    struct Deployed {
        address registry;
        address license;
        address credits;
        address reviews;
        address escrow;
        address staking;
    }

    function run() external returns (Deployed memory d) {
        Params memory p = Params({
            token: vm.envAddress("PAYMENT_TOKEN"),
            treasury: vm.envAddress("TREASURY_ADDRESS"),
            platform: vm.envAddress("PLATFORM_ADDRESS"),
            verifier: vm.envAddress("VERIFIER_ADDRESS"),
            guardian: vm.envOr("GUARDIAN_ADDRESS", address(0)),
            coldAdmin: vm.envAddress("COLD_ADMIN"),
            feeBps: uint16(_bounded("FEE_BPS", 1000, type(uint16).max)),
            platformRoyaltyBps: uint16(_bounded("PLATFORM_ROYALTY_BPS", 500, type(uint16).max)),
            minStake: uint96(_bounded("MIN_STAKE", 0, type(uint96).max)),
            minPrice: uint96(_bounded("MIN_PRICE", 5_000_000, type(uint96).max)),
            baseURI: vm.envString("LICENSE_BASE_URI"),
            name: vm.envOr("DEPLOYMENT_NAME", string("solvers"))
        });
        require(p.coldAdmin != address(0), "COLD_ADMIN is zero");
        if (block.chainid != 31_337) {
            // Off anvil the hot deployer must never stay default admin, and the deployment must name its source commit.
            require(p.coldAdmin != msg.sender, "COLD_ADMIN must differ from the deployer");
            require(bytes(vm.envOr("GIT_SHA", string(""))).length == 40, "GIT_SHA (40 hex) is required off anvil");
        }
        uint256 deployBlock = block.number;
        vm.startBroadcast();
        d = deploy(p, msg.sender);
        vm.stopBroadcast();
        writeDeployment(p, d, deployBlock);
    }

    function _bounded(string memory name, uint256 defaultValue, uint256 max) private view returns (uint256 v) {
        v = vm.envOr(name, defaultValue);
        require(v <= max, string.concat(name, " out of range"));
    }

    /// @dev `deployer` is the temporary default admin until the cold admin accepts the transfer.
    function deploy(Params memory p, address deployer) public returns (Deployed memory d) {
        Options memory opts;
        d.registry = Upgrades.deployUUPSProxy(
            "SolversRegistry.sol:SolversRegistry",
            abi.encodeCall(
                SolversRegistry.initialize,
                (deployer, 0, p.token, p.treasury, p.feeBps, p.platformRoyaltyBps, p.minStake, p.minPrice)
            ),
            opts
        );
        d.license = Upgrades.deployUUPSProxy(
            "SolversLicense.sol:SolversLicense",
            abi.encodeCall(SolversLicense.initialize, (d.registry, p.baseURI)),
            opts
        );
        d.credits = Upgrades.deployUUPSProxy(
            "SolversCredits.sol:SolversCredits", abi.encodeCall(SolversCredits.initialize, (d.registry)), opts
        );
        d.reviews = Upgrades.deployUUPSProxy(
            "SolversReviews.sol:SolversReviews",
            abi.encodeCall(SolversReviews.initialize, (d.registry, d.license, d.credits)),
            opts
        );
        d.escrow = Upgrades.deployUUPSProxy(
            "SolversEscrow.sol:SolversEscrow", abi.encodeCall(SolversEscrow.initialize, (d.registry)), opts
        );
        d.staking = Upgrades.deployUUPSProxy(
            "SolversStaking.sol:SolversStaking", abi.encodeCall(SolversStaking.initialize, (d.registry)), opts
        );

        SolversRegistry registry = SolversRegistry(d.registry);
        registry.setSatellites(d.license, d.credits, d.reviews, d.escrow, d.staking);
        registry.grantRole(PLATFORM_ROLE, p.platform);
        registry.grantRole(USAGE_ROLE, p.platform);
        registry.grantRole(VERIFIER_ROLE, p.verifier);
        if (p.guardian != address(0)) registry.grantRole(GUARDIAN_ROLE, p.guardian);
        if (p.coldAdmin != deployer) registry.beginDefaultAdminTransfer(p.coldAdmin);
    }

    function writeDeployment(Params memory p, Deployed memory d, uint256 deployBlock) public {
        string memory o = "deployment";
        vm.serializeUint(o, "chainId", block.chainid);
        vm.serializeString(o, "name", p.name);
        vm.serializeAddress(o, "token", p.token);
        vm.serializeAddress(o, "treasury", p.treasury);
        vm.serializeAddress(o, "registry", d.registry);
        vm.serializeAddress(o, "license", d.license);
        vm.serializeAddress(o, "credits", d.credits);
        vm.serializeAddress(o, "reviews", d.reviews);
        vm.serializeAddress(o, "escrow", d.escrow);
        vm.serializeAddress(o, "staking", d.staking);

        string memory i = "impls";
        vm.serializeAddress(i, "registry", Upgrades.getImplementationAddress(d.registry));
        vm.serializeAddress(i, "license", Upgrades.getImplementationAddress(d.license));
        vm.serializeAddress(i, "credits", Upgrades.getImplementationAddress(d.credits));
        vm.serializeAddress(i, "reviews", Upgrades.getImplementationAddress(d.reviews));
        vm.serializeAddress(i, "escrow", Upgrades.getImplementationAddress(d.escrow));
        string memory impls = vm.serializeAddress(i, "staking", Upgrades.getImplementationAddress(d.staking));

        vm.serializeString(o, "impls", impls);
        vm.serializeUint(o, "deployBlock", deployBlock);
        vm.serializeString(o, "gitSha", vm.envOr("GIT_SHA", string("")));
        string memory json = vm.serializeUint(o, "deployedAt", block.timestamp);
        string memory path = string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console.log("deployment written to", path);
    }
}
