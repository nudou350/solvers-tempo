// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {SolversRegistry} from "../src/SolversRegistry.sol";
import {SolversLicense} from "../src/SolversLicense.sol";
import {SolversCredits} from "../src/SolversCredits.sol";
import {SolversReviews} from "../src/SolversReviews.sol";
import {SolversEscrow} from "../src/SolversEscrow.sol";
import {SolversStaking} from "../src/SolversStaking.sol";
import {SolversSatellite} from "../src/base/SolversSatellite.sol";
import {SolversPayouts} from "../src/base/SolversPayouts.sol";

// Never deployed. Each probe declares one ERC-7201 namespace struct as ordinary storage at slot 0, so
// `forge inspect <Probe> storageLayout` exposes every member's relative slot, offset and type. The layouts are
// committed under contracts/storage-layouts/ and `node script/check-layouts.mjs` enforces append-only changes.

contract RegistryLayoutProbe {
    SolversRegistry.RegistryStorage internal s;
}

contract LicenseLayoutProbe {
    SolversLicense.LicenseStorage internal s;
}

contract CreditsLayoutProbe {
    SolversCredits.CreditsStorage internal s;
}

contract ReviewsLayoutProbe {
    SolversReviews.ReviewsStorage internal s;
}

contract EscrowLayoutProbe {
    SolversEscrow.EscrowStorage internal s;
}

contract StakingLayoutProbe {
    SolversStaking.StakingStorage internal s;
}

contract SatelliteLayoutProbe {
    SolversSatellite.SatelliteStorage internal s;
}

contract PayoutsLayoutProbe {
    SolversPayouts.PayoutsStorage internal s;
}
