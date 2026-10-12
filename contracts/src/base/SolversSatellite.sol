// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {Initializable} from "@openzeppelin/contracts/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts/proxy/utils/UUPSUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ISolversRegistry} from "../interfaces/ISolversRegistry.sol";
import {ZeroAddress, Paused} from "../SolversTypes.sol";

/// @notice Base of every Solvers satellite: link to the Registry (roles, config, pause bits), the payment token and
/// UUPS upgrade authorization by the Registry's default admin. The Registry address has no setter.
abstract contract SolversSatellite is Initializable, UUPSUpgradeable, ReentrancyGuardTransient {
    /// @custom:storage-location erc7201:solvers.storage.Satellite
    struct SatelliteStorage {
        ISolversRegistry registry;
        IERC20 token;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.Satellite")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant SATELLITE_STORAGE = 0x73ebe217f9826ba6b57c856f726352a85fe54d034adbc9166e36574b15705700;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _satelliteStorage() private pure returns (SatelliteStorage storage $) {
        assembly {
            $.slot := SATELLITE_STORAGE
        }
    }

    // forge-lint: disable-next-line(mixed-case-function)
    function __SolversSatellite_init(address registry_) internal onlyInitializing {
        if (registry_ == address(0)) revert ZeroAddress();
        SatelliteStorage storage $ = _satelliteStorage();
        $.registry = ISolversRegistry(registry_);
        address t = ISolversRegistry(registry_).token();
        if (t == address(0)) revert ZeroAddress();
        $.token = IERC20(t);
    }

    /// @notice The SolversRegistry this satellite trusts for roles, config and pause bits.
    function registry() public view returns (ISolversRegistry) {
        return _satelliteStorage().registry;
    }

    /// @notice The TIP-20 payment token (fixed at initialization, same as the Registry's).
    function paymentToken() public view returns (IERC20) {
        return _satelliteStorage().token;
    }

    modifier onlyRegistryRole(bytes32 role) {
        _checkRegistryRole(role);
        _;
    }

    function _checkRegistryRole(bytes32 role) internal view {
        if (!IAccessControl(address(_satelliteStorage().registry)).hasRole(role, msg.sender)) {
            revert IAccessControl.AccessControlUnauthorizedAccount(msg.sender, role);
        }
    }

    function _requireNotPaused(uint8 flag) internal view {
        if (_satelliteStorage().registry.pauseFlags() & flag != 0) revert Paused(flag);
    }

    /// @dev Upgrades are authorized by the Registry's default admin (the single holder of DEFAULT_ADMIN_ROLE).
    function _authorizeUpgrade(address) internal view override onlyRegistryRole(0x00) {}
}
