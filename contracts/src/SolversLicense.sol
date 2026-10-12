// SPDX-License-Identifier: FSL-1.1-ALv2
pragma solidity ^0.8.30;

import {ERC721Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC721/ERC721Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IERC2981} from "@openzeppelin/contracts/interfaces/IERC2981.sol";
import {IERC165} from "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";

import {SolversPayouts} from "./base/SolversPayouts.sol";
import {ISolversRegistry, SaleAuth} from "./interfaces/ISolversRegistry.sol";
import {ISolversLicense} from "./interfaces/ISolversSatellites.sol";
import {SolversMath} from "./libraries/SolversMath.sol";
import {SaleKind, PAUSE_TRANSFERS, PLATFORM_ROLE, PriceChanged, PriceTooLow, ZeroAddress} from "./SolversTypes.sol";

/// @title SolversLicense
/// @notice License NFTs (ERC-721). Primary sales split the price between creator and treasury (`feeSplit`); every
/// secondary transfer pays an on-chain royalty on the ORIGINAL price (creator share + platform share), pulled from the
/// current owner (`from`), also when an approved operator moves the token.
contract SolversLicense is SolversPayouts, ERC721Upgradeable, IERC2981, ISolversLicense {
    using Strings for uint256;

    /// @dev One slot per license: `agentIndex` instead of the bytes32 agent id; `reviewId` binds the license to the
    /// review it was first used for (0 = never used).
    struct LicenseData {
        uint32 agentIndex;
        uint96 originalPrice;
        uint40 mintedAt;
        uint64 reviewId;
    }

    struct RoyaltyQuote {
        address creator;
        address treasury;
        uint256 creatorAmount;
        uint256 platformAmount;
        uint8 pauseFlags;
    }

    /// @custom:storage-location erc7201:solvers.storage.License
    struct LicenseStorage {
        uint256 nextId;
        string baseURI;
        mapping(uint256 tokenId => LicenseData) licenses;
    }

    // keccak256(abi.encode(uint256(keccak256("solvers.storage.License")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant LICENSE_STORAGE = 0x3a30cef44f7755833df2e19d37b371e39266205f853e05a67bf123426e8fde00;

    event LicensePurchased(
        bytes32 indexed agentId,
        address indexed buyer,
        uint256 indexed tokenId,
        address payer,
        uint96 price,
        uint96 fee,
        uint96 creatorAmount,
        bytes32 purchaseId,
        bool creatorDeferred,
        bool treasuryDeferred
    );
    event RoyaltyPaid(
        uint256 indexed tokenId,
        address indexed from,
        address indexed to,
        address creator,
        uint256 creatorAmount,
        uint256 platformAmount,
        bool creatorDeferred,
        bool platformDeferred
    );
    event LicenseReviewed(uint256 indexed tokenId, uint64 reviewId);
    event BaseURISet(string baseURI);

    error RoyaltyNotPaid(uint256 required);
    error RoyaltyChanged(uint256 current);
    error TransfersPaused();
    error NotReviews();
    error WrongAgent();
    error NotOwner();

    function initialize(address registry_, string calldata baseURI_) external initializer {
        __ERC721_init("Solvers License", "SOLVERS");
        __SolversSatellite_init(registry_);
        _licenseStorage().baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    // =====================================================================================================
    // purchase
    // =====================================================================================================

    /// @notice Buys a license for `msg.sender` (payer = buyer). Direct wallets batch `token.approve(license, price)`.
    function purchaseLicense(bytes32 agentId, uint96 expectedPrice, bytes32 purchaseId)
        external
        nonReentrant
        returns (uint256 tokenId)
    {
        return _purchase(msg.sender, msg.sender, agentId, expectedPrice, purchaseId);
    }

    /// @notice Buys a license for `buyer`, paid by the platform float (Pix / agent payments; PLATFORM_ROLE).
    function purchaseLicenseFor(address buyer, bytes32 agentId, uint96 expectedPrice, bytes32 purchaseId)
        external
        nonReentrant
        onlyRegistryRole(PLATFORM_ROLE)
        returns (uint256 tokenId)
    {
        return _purchase(buyer, msg.sender, agentId, expectedPrice, purchaseId);
    }

    /// @notice Single-call purchase for wallets that cannot batch: EIP-2612 permit on the payment token, then buy.
    /// A failed permit (e.g. already used by a front-runner) is ignored; the allowance check decides.
    function purchaseLicenseWithPermit(
        bytes32 agentId,
        uint96 expectedPrice,
        bytes32 purchaseId,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 tokenId) {
        _tryPermit(msg.sender, expectedPrice, deadline, v, r, s);
        return _purchase(msg.sender, msg.sender, agentId, expectedPrice, purchaseId);
    }

    function _purchase(address buyer, address payer, bytes32 agentId, uint96 expectedPrice, bytes32 purchaseId)
        private
        returns (uint256 tokenId)
    {
        LicenseStorage storage $ = _licenseStorage();
        tokenId = ++$.nextId;
        SaleAuth memory auth =
            registry().authorizeSale(agentId, buyer, payer, SaleKind.License, purchaseId, bytes32(tokenId));
        if (auth.price != expectedPrice) revert PriceChanged(auth.price);
        // Every purchase is >= minPrice, also when the admin raised minPrice after the agent set its price.
        if (auth.price < auth.minPrice) revert PriceTooLow();
        $.licenses[tokenId] = LicenseData({
            agentIndex: auth.agentIndex, originalPrice: auth.price, mintedAt: uint40(block.timestamp), reviewId: 0
        });
        (uint256 fee, uint256 rest) = SolversMath.feeSplit(auth.price, auth.feeBps);
        bool treasuryDeferred = _pullTo(payer, auth.treasury, fee);
        bool creatorDeferred = _pullTo(payer, auth.creator, rest);
        emit LicensePurchased(
            agentId,
            buyer,
            tokenId,
            payer,
            auth.price,
            uint96(fee),
            uint96(rest),
            purchaseId,
            creatorDeferred,
            treasuryDeferred
        );
        // Last: a contract buyer without onERC721Received reverts the whole purchase atomically.
        _safeMint(buyer, tokenId);
    }

    // =====================================================================================================
    // transfers with royalty
    // =====================================================================================================

    /// @notice Transfers `tokenId` paying the royalty, reverting if the quote grew above `maxRoyalty`.
    /// The owner (`from`) pays and must have approved this contract on the payment token.
    function transferWithRoyalty(address to, uint256 tokenId, uint256 maxRoyalty) external nonReentrant {
        address from = _requireOwned(tokenId);
        _checkQuote(tokenId, maxRoyalty);
        _checkedTransfer(from, to, tokenId);
    }

    /// @notice Same as `transferWithRoyalty` with an EIP-2612 permit signed by the owner (one call, no batch).
    function transferWithRoyaltyPermit(
        address to,
        uint256 tokenId,
        uint256 maxRoyalty,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        address from = _requireOwned(tokenId);
        _checkQuote(tokenId, maxRoyalty);
        // The owner signs an allowance for the maximum royalty they accept; only the quote is pulled.
        _tryPermit(from, maxRoyalty, deadline, v, r, s);
        _checkedTransfer(from, to, tokenId);
    }

    /// @dev Both `safeTransferFrom` overloads route through here, so `onERC721Received` runs after the guard is
    /// released and any re-entrant transfer is itself a complete, royalty-paid transfer.
    function transferFrom(address from, address to, uint256 tokenId) public override nonReentrant {
        _checkedTransfer(from, to, tokenId);
    }

    /// @notice Burns a license (owner or approved). Royalty-exempt; the supply-cap slot is never freed.
    function burn(uint256 tokenId) external nonReentrant {
        _update(address(0), tokenId, msg.sender);
    }

    /// @notice Royalty a transfer of `tokenId` would pay now.
    function quoteRoyalty(uint256 tokenId)
        public
        view
        returns (address creator, uint256 creatorAmount, address treasury, uint256 platformAmount)
    {
        RoyaltyQuote memory q = _royaltyQuote(tokenId);
        return (q.creator, q.creatorAmount, q.treasury, q.platformAmount);
    }

    /// @notice ERC-2981, informational: fixed base (the original price, not `salePrice`), receiver = this contract
    /// (strays are swept by the admin). The amount equals what every transfer is charged (each share floored).
    function royaltyInfo(uint256 tokenId, uint256) external view returns (address receiver, uint256 royaltyAmount) {
        RoyaltyQuote memory q = _royaltyQuote(tokenId);
        return (address(this), q.creatorAmount + q.platformAmount);
    }

    // =====================================================================================================
    // reviews
    // =====================================================================================================

    /// @inheritdoc ISolversLicense
    function useForReview(uint256 tokenId, address author, bytes32 agentId, uint64 reviewId)
        external
        returns (uint64 boundReviewId)
    {
        (,, address reviews_,,) = _satellites();
        if (msg.sender != reviews_) revert NotReviews();
        if (_ownerOf(tokenId) != author || author == address(0)) revert NotOwner();
        LicenseData storage l = _licenseStorage().licenses[tokenId];
        if (registry().agentIdAt(l.agentIndex) != agentId) revert WrongAgent();
        boundReviewId = l.reviewId;
        if (boundReviewId == 0) {
            l.reviewId = reviewId;
            boundReviewId = reviewId;
            emit LicenseReviewed(tokenId, reviewId);
        }
    }

    // =====================================================================================================
    // views + admin
    // =====================================================================================================

    function licenseOf(uint256 tokenId)
        external
        view
        returns (bytes32 agentId, uint96 originalPrice, uint40 mintedAt, uint64 reviewId)
    {
        LicenseData memory l = _license(tokenId);
        return (registry().agentIdAt(l.agentIndex), l.originalPrice, l.mintedAt, l.reviewId);
    }

    function agentIndexOf(uint256 tokenId) external view returns (uint32) {
        return _license(tokenId).agentIndex;
    }

    /// @notice Number of licenses ever minted (token ids are 1..totalMinted).
    function totalMinted() external view returns (uint256) {
        return _licenseStorage().nextId;
    }

    function setBaseURI(string calldata baseURI_) external onlyRegistryRole(0x00) {
        _licenseStorage().baseURI = baseURI_;
        emit BaseURISet(baseURI_);
    }

    function supportsInterface(bytes4 interfaceId) public view override(ERC721Upgradeable, IERC165) returns (bool) {
        return interfaceId == type(IERC2981).interfaceId || super.supportsInterface(interfaceId);
    }

    function _baseURI() internal view override returns (string memory) {
        return _licenseStorage().baseURI;
    }

    // =====================================================================================================
    // internal
    // =====================================================================================================

    /// @dev Royalty hook. Effects of the ownership change happen first (CEI); mint, burn and self-transfers are
    /// exempt; the payer is always `from`.
    function _update(address to, uint256 tokenId, address auth) internal override returns (address from) {
        from = super._update(to, tokenId, auth);
        if (from != address(0) && to != address(0) && from != to) _chargeRoyalty(from, to, tokenId);
    }

    function _chargeRoyalty(address from, address to, uint256 tokenId) private {
        RoyaltyQuote memory q = _royaltyQuote(tokenId);
        if (q.pauseFlags & PAUSE_TRANSFERS != 0) revert TransfersPaused();
        uint256 total = q.creatorAmount + q.platformAmount;
        if (total == 0) return;
        IERC20 t = paymentToken();
        if (t.allowance(from, address(this)) < total || t.balanceOf(from) < total) revert RoyaltyNotPaid(total);
        bool cd = _pullTo(from, q.creator, q.creatorAmount);
        bool pd = _pullTo(from, q.treasury, q.platformAmount);
        emit RoyaltyPaid(tokenId, from, to, q.creator, q.creatorAmount, q.platformAmount, cd, pd);
    }

    function _royaltyQuote(uint256 tokenId) private view returns (RoyaltyQuote memory q) {
        LicenseData memory l = _license(tokenId);
        (address creator, uint16 creatorBps, address treasury, uint16 platformBps, uint8 flags) =
            registry().royaltyParams(l.agentIndex);
        (uint256 c, uint256 p) = SolversMath.royaltySplit(l.originalPrice, creatorBps, platformBps);
        q = RoyaltyQuote({creator: creator, treasury: treasury, creatorAmount: c, platformAmount: p, pauseFlags: flags});
    }

    function _checkedTransfer(address from, address to, uint256 tokenId) private {
        if (to == address(0)) revert ERC721InvalidReceiver(address(0));
        address previousOwner = _update(to, tokenId, msg.sender);
        if (previousOwner != from) revert ERC721IncorrectOwner(from, tokenId, previousOwner);
    }

    function _checkQuote(uint256 tokenId, uint256 maxRoyalty) private view returns (uint256 quote) {
        (, uint256 c,, uint256 p) = quoteRoyalty(tokenId);
        quote = c + p;
        if (quote > maxRoyalty) revert RoyaltyChanged(quote);
    }

    function _tryPermit(address owner, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) private {
        if (owner == address(0)) revert ZeroAddress();
        try IERC20Permit(address(paymentToken())).permit(owner, address(this), value, deadline, v, r, s) {} catch {}
    }

    function _license(uint256 tokenId) private view returns (LicenseData memory l) {
        l = _licenseStorage().licenses[tokenId];
        if (l.mintedAt == 0) revert ERC721NonexistentToken(tokenId);
    }

    function _satellites() private view returns (address, address, address, address, address) {
        return registry().satellites();
    }

    function _licenseStorage() private pure returns (LicenseStorage storage $) {
        assembly {
            $.slot := LICENSE_STORAGE
        }
    }
}
