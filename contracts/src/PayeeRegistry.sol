// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PayeeRegistry
/// @notice Confirmation-of-Payee (CoP) and identity registry for tUSD8 merchants, contractors, and AI agents on QDay Aevum.
contract PayeeRegistry {
    enum PayeeType {
        Merchant,
        Contractor,
        AutonomousAgent
    }

    struct PayeeProfile {
        bool registered;
        bool active;
        bool attested;
        PayeeType payeeType;
        uint64 registeredAt;
        uint64 updatedAt;
        bytes32 labelHash;
        string label;
        string metadataURI;
    }

    address public owner;
    mapping(address => PayeeProfile) private _profiles;
    mapping(bytes32 => address) public primaryAddressForLabel;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event PayeeRegistered(
        address indexed payee,
        bytes32 indexed labelHash,
        PayeeType payeeType,
        string label,
        string metadataURI
    );
    event PayeeUpdated(address indexed payee, bytes32 indexed labelHash, bool active, string metadataURI);
    event PayeeAttested(address indexed payee, bool attested);

    error NotOwner();
    error ZeroAddress();
    error EmptyLabel();
    error NotRegistered();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address initialOwner) {
        if (initialOwner == address(0)) revert ZeroAddress();
        owner = initialOwner;
        emit OwnershipTransferred(address(0), initialOwner);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Compute canonical Confirmation-of-Payee hash for a human-readable label.
    function computeLabelHash(string memory label) public pure returns (bytes32) {
        return keccak256(abi.encodePacked(label));
    }

    /// @notice Register or re-register msg.sender as an active tUSD8 payee.
    function registerPayee(
        string calldata label,
        PayeeType payeeType,
        string calldata metadataURI
    ) external returns (bytes32 labelHash) {
        if (bytes(label).length == 0) revert EmptyLabel();
        labelHash = computeLabelHash(label);

        PayeeProfile storage p = _profiles[msg.sender];
        uint64 nowTs = uint64(block.timestamp);
        if (!p.registered) {
            p.registered = true;
            p.registeredAt = nowTs;
        }
        p.active = true;
        p.payeeType = payeeType;
        p.updatedAt = nowTs;
        p.labelHash = labelHash;
        p.label = label;
        p.metadataURI = metadataURI;

        if (primaryAddressForLabel[labelHash] == address(0)) {
            primaryAddressForLabel[labelHash] = msg.sender;
        }

        emit PayeeRegistered(msg.sender, labelHash, payeeType, label, metadataURI);
    }

    /// @notice Update active state or metadata URI for msg.sender.
    function updatePayee(bool active, string calldata metadataURI) external {
        PayeeProfile storage p = _profiles[msg.sender];
        if (!p.registered) revert NotRegistered();
        p.active = active;
        p.metadataURI = metadataURI;
        p.updatedAt = uint64(block.timestamp);
        emit PayeeUpdated(msg.sender, p.labelHash, active, metadataURI);
    }

    /// @notice Optional curator attestation badge (e.g. verified business/merchant).
    function setAttested(address payee, bool attested) external onlyOwner {
        PayeeProfile storage p = _profiles[payee];
        if (!p.registered) revert NotRegistered();
        p.attested = attested;
        p.updatedAt = uint64(block.timestamp);
        emit PayeeAttested(payee, attested);
    }

    function getPayee(address payee) external view returns (PayeeProfile memory) {
        return _profiles[payee];
    }

    function isActivePayee(address payee) external view returns (bool) {
        PayeeProfile storage p = _profiles[payee];
        return p.registered && p.active;
    }

    /// @notice Pre-flight Confirmation-of-Payee check used by wallets, APIs, and TUSD8PayGuard.
    function verifyPayee(
        address payee,
        bytes32 expectedLabelHash
    )
        external
        view
        returns (
            bool matches,
            bool active,
            bool attested,
            PayeeType payeeType,
            string memory label
        )
    {
        PayeeProfile storage p = _profiles[payee];
        active = p.registered && p.active;
        attested = p.attested;
        payeeType = p.payeeType;
        label = p.label;
        matches = active && (expectedLabelHash == bytes32(0) || p.labelHash == expectedLabelHash);
    }
}
