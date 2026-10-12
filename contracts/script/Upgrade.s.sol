// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Script, console} from "forge-std/Script.sol";
import {Upgrades, Options} from "openzeppelin-foundry-upgrades/Upgrades.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {
    IAccessControlDefaultAdminRules
} from "@openzeppelin/contracts/access/extensions/IAccessControlDefaultAdminRules.sol";

/// @notice Upgrades the UUPS proxies listed in `deployments/<chainId>.json` (decision X16). Every new implementation is
/// checked by openzeppelin-foundry-upgrades `validateUpgrade` against the build of the commit that produced the LIVE
/// implementation (`implGitSha.<key>` when a previous upgrade recorded one, else the deployment's `gitSha`), so storage
/// layout and upgrade-safety are compared with what is actually on chain, not with the working tree.
///
/// Order of operations (from contracts/; never against mainnet without the runbook):
///   1. bash script/reference-build.sh <chainId>
///        Builds every source commit named in the deployment file in a temporary git worktree and copies its
///        build-info into reference-build/sha-<first 12 hex>/ (gitignored, never committed).
///   2. forge clean
///        The validator needs exactly one build-info per contract; a previous `forge build` leaves a second unit.
///   3. UPGRADE=registry,license forge script script/Upgrade.s.sol --skip test --rpc-url <rpc>
///        UPGRADE_MODE=validate (default): reads the chain, validates, sends nothing.
///   4. UPGRADE_MODE=prepare ... --broadcast --private-key $DEPLOYER_PRIVATE_KEY
///        Deploys the validated implementations (no role needed) and prints, per proxy, the `upgradeToAndCall` calldata
///        that the default admin must send. This is the mainnet path: the cold admin holds no tokens (X21), so the call
///        goes through a sponsored admin transaction or a Safe, never through this script.
///      UPGRADE_MODE=execute ... --broadcast --private-key $ADMIN_PRIVATE_KEY
///        Local chain and testnet only (refused on chain 4217): the default admin deploys and upgrades in one run.
///   5. node script/record-upgrade.mjs <chainId> --rpc-url <rpc>
///        After the upgrade is mined: writes the new `impls.<key>` and `implGitSha.<key>` into the deployment file, so the
///        next upgrade validates against this one.
///
/// Env: UPGRADE (required: comma list of registry, license, credits, reviews, escrow, staking, or "all");
/// optional UPGRADE_MODE (validate | prepare | execute), DEPLOYMENT_FILE (default ../deployments/<chainId>.json),
/// REFERENCE_ROOT (default reference-build), UPGRADE_DATA_<KEY> (hex calldata for upgradeToAndCall, e.g. a
/// reinitializer; default empty).
contract Upgrade is Script {
    enum Mode {
        Validate,
        Prepare,
        Execute
    }

    struct Target {
        string key; // deployment file key, e.g. "registry"
        string name; // contract name, e.g. "SolversRegistry"
        string artifact; // Foundry artifact name, e.g. "SolversRegistry.sol:SolversRegistry"
        address proxy;
        address impl; // recorded in the deployment file and checked against the proxy's ERC-1967 slot
        string sha; // source commit of the live implementation
        string referenceDir; // <REFERENCE_ROOT>/sha-<12 hex>
        string referenceContract; // sha-<12 hex>:src/<Name>.sol:<Name>
    }

    uint256 internal constant MAINNET_CHAIN_ID = 4217;
    string internal constant ALL = "registry,license,credits,reviews,escrow,staking";

    function run() external {
        Mode mode = parseMode(vm.envOr("UPGRADE_MODE", string("validate")));
        string memory path = vm.envOr(
            "DEPLOYMENT_FILE", string.concat(vm.projectRoot(), "/../deployments/", vm.toString(block.chainid), ".json")
        );
        string memory json = vm.readFile(path);
        require(vm.parseJsonUint(json, ".chainId") == block.chainid, "deployment file belongs to another chain");
        string memory list = vm.trim(vm.envString("UPGRADE"));
        if (keccak256(bytes(list)) == keccak256("all")) list = ALL;
        Target[] memory targets = plan(json, vm.split(list, ","), vm.envOr("REFERENCE_ROOT", string("reference-build")));
        for (uint256 i; i < targets.length; ++i) {
            require(
                vm.isDir(targets[i].referenceDir),
                string.concat(
                    targets[i].key,
                    ": reference build ",
                    targets[i].referenceDir,
                    " is missing (run: bash script/reference-build.sh ",
                    vm.toString(block.chainid),
                    ")"
                )
            );
        }

        if (mode == Mode.Validate) {
            for (uint256 i; i < targets.length; ++i) {
                Upgrades.validateUpgrade(targets[i].artifact, options(targets[i]));
                console.log("valid upgrade:", targets[i].key, "reference", targets[i].sha);
            }
            console.log("validation only: nothing was sent");
            return;
        }

        address admin = IAccessControlDefaultAdminRules(vm.parseJsonAddress(json, ".registry")).defaultAdmin();
        if (mode == Mode.Execute) checkExecutor(block.chainid, msg.sender, admin);

        vm.startBroadcast();
        for (uint256 i; i < targets.length; ++i) {
            Target memory t = targets[i];
            address newImpl = Upgrades.prepareUpgrade(t.artifact, options(t));
            bytes memory data = vm.envOr(string.concat("UPGRADE_DATA_", vm.toUppercase(t.key)), bytes(""));
            if (mode == Mode.Execute) {
                UUPSUpgradeable(t.proxy).upgradeToAndCall(newImpl, data);
                console.log("upgraded:", t.key, newImpl);
            } else {
                console.log("prepared:", t.key, newImpl);
                console.log("  default admin", admin, "must call proxy", t.proxy);
                console.log("  calldata", vm.toString(upgradeCalldata(newImpl, data)));
            }
        }
        vm.stopBroadcast();
        console.log("after the upgrade is mined: node script/record-upgrade.mjs", vm.toString(block.chainid));
    }

    /// @notice Resolves the requested keys against the deployment file and the chain. Reverts on an unknown or repeated
    /// key, a missing source commit, or an implementation that differs from the recorded one (an unrecorded upgrade would
    /// make the reference build wrong).
    function plan(string memory json, string[] memory keys, string memory referenceRoot)
        public
        view
        returns (Target[] memory targets)
    {
        require(keys.length > 0, "UPGRADE lists no contract");
        targets = new Target[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            string memory key = vm.toLowercase(vm.trim(keys[i]));
            for (uint256 j; j < i; ++j) {
                require(keccak256(bytes(targets[j].key)) != keccak256(bytes(key)), string.concat("repeated: ", key));
            }
            Target memory t = targets[i];
            t.key = key;
            t.name = contractName(key);
            t.artifact = string.concat(t.name, ".sol:", t.name);
            t.proxy = vm.parseJsonAddress(json, string.concat(".", key));
            t.impl = vm.parseJsonAddress(json, string.concat(".impls.", key));
            require(
                Upgrades.getImplementationAddress(t.proxy) == t.impl,
                string.concat(
                    key,
                    ": the implementation on chain differs from impls.",
                    key,
                    " (record the previous upgrade with script/record-upgrade.mjs first)"
                )
            );
            string memory shaKey = string.concat(".implGitSha.", key);
            t.sha =
                vm.keyExistsJson(json, shaKey) ? vm.parseJsonString(json, shaKey) : vm.parseJsonString(json, ".gitSha");
            require(isSha(t.sha), string.concat(key, ": no 40-hex source commit in the deployment file"));
            string memory short = string.concat("sha-", prefix(t.sha, 12));
            t.referenceDir = string.concat(referenceRoot, "/", short);
            t.referenceContract = string.concat(short, ":src/", t.name, ".sol:", t.name);
        }
    }

    function options(Target memory t) public pure returns (Options memory opts) {
        opts.referenceBuildInfoDir = t.referenceDir;
        opts.referenceContract = t.referenceContract;
    }

    /// @notice The direct upgrade is for the local chain and testnets; on mainnet the default admin signs elsewhere.
    function checkExecutor(uint256 chainId, address sender, address admin) public pure {
        require(chainId != MAINNET_CHAIN_ID, "execute is refused on mainnet: use UPGRADE_MODE=prepare (X21)");
        require(sender == admin, "execute must be signed by the default admin");
    }

    function upgradeCalldata(address newImpl, bytes memory data) public pure returns (bytes memory) {
        return abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (newImpl, data));
    }

    function parseMode(string memory s) public pure returns (Mode) {
        bytes32 h = keccak256(bytes(s));
        if (h == keccak256("validate")) return Mode.Validate;
        if (h == keccak256("prepare")) return Mode.Prepare;
        if (h == keccak256("execute")) return Mode.Execute;
        revert("UPGRADE_MODE must be validate, prepare or execute");
    }

    function contractName(string memory key) public pure returns (string memory) {
        bytes32 h = keccak256(bytes(key));
        if (h == keccak256("registry")) return "SolversRegistry";
        if (h == keccak256("license")) return "SolversLicense";
        if (h == keccak256("credits")) return "SolversCredits";
        if (h == keccak256("reviews")) return "SolversReviews";
        if (h == keccak256("escrow")) return "SolversEscrow";
        if (h == keccak256("staking")) return "SolversStaking";
        revert(string.concat("unknown contract key: ", key));
    }

    function isSha(string memory s) public pure returns (bool) {
        bytes memory b = bytes(s);
        if (b.length != 40) return false;
        for (uint256 i; i < 40; ++i) {
            bytes1 c = b[i];
            if (!((c >= "0" && c <= "9") || (c >= "a" && c <= "f"))) return false;
        }
        return true;
    }

    function prefix(string memory s, uint256 n) internal pure returns (string memory) {
        bytes memory b = bytes(s);
        bytes memory out = new bytes(n);
        for (uint256 i; i < n; ++i) {
            out[i] = b[i];
        }
        return string(out);
    }
}
