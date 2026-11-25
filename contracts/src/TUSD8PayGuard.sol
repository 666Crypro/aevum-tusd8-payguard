// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITUSD8} from "./interfaces/ITUSD8.sol";
import {SafeERC20Lite} from "./libraries/SafeERC20Lite.sol";
import {PayeeRegistry} from "./PayeeRegistry.sol";

/// @title TUSD8PayGuard
/// @notice Non-custodial tUSD8 stablecoin invoicing, milestone escrow, Confirmation-of-Payee enforcement,
///         and scoped session-key clearinghouse for autonomous agents on QDay Aevum.
contract TUSD8PayGuard {
    using SafeERC20Lite for ITUSD8;

    enum InvoiceMode {
        Instant,
        Escrow
    }

    enum InvoiceStatus {
        None,
        Open,
        Funded,
        Disputed,
        Settled,
        Refunded,
        Cancelled
    }

    struct Invoice {
        uint256 id;
        address creator;
        address payer;
        address payee;
        address agent;
        uint256 totalAmount;
        uint256 releasedAmount;
        uint64 createdAt;
        uint64 deadline;
        InvoiceMode mode;
        InvoiceStatus status;
        bytes32 expectedLabelHash;
        bytes32 externalRef;
        bytes32 memoHash;
        bytes32 reasonHash;
    }

    struct SessionPolicy {
        bool active;
        bool revoked;
        bool requireVerifiedPayee;
        uint64 expiresAt;
        uint64 lastSpendDay;
        uint256 maxPerTx;
        uint256 dailyCap;
        uint256 spentToday;
        uint256 totalSpent;
        address allowedPayee;
    }

    uint16 public constant MAX_FEE_BPS = 100; // 1.00% hard ceiling
    uint8 public constant EXPECTED_TOKEN_DECIMALS = 6;

    ITUSD8 public immutable tusd8;
    PayeeRegistry public immutable registry;

    address public owner;
    address public arbiter;
    address public feeRecipient;
    uint16 public feeBps;
    bool public paused;
    uint256 public nextInvoiceId = 1;

    uint256 private _locked = 1;

    mapping(uint256 => Invoice) private _invoices;
    mapping(address => mapping(address => SessionPolicy)) private _sessions;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event ArbiterUpdated(address indexed previousArbiter, address indexed newArbiter);
    event FeeUpdated(address indexed feeRecipient, uint16 feeBps);
    event PausedSet(bool paused);

    event InvoiceCreated(
        uint256 indexed invoiceId,
        address indexed creator,
        address indexed payee,
        uint256 totalAmount,
        InvoiceMode mode,
        uint64 deadline,
        bytes32 expectedLabelHash,
        bytes32 externalRef,
        bytes32 memoHash
    );
    event InvoiceFunded(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 totalAmount,
        InvoiceMode mode
    );
    event MilestoneReleased(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 grossAmount,
        uint256 netAmount,
        uint256 feeAmount,
        uint256 totalReleased
    );
    event InvoiceSettled(
        uint256 indexed invoiceId,
        address indexed payer,
        address indexed payee,
        uint256 grossAmount,
        uint256 feeAmount
    );
    event InvoiceRefunded(uint256 indexed invoiceId, address indexed payer, uint256 refundAmount);
    event InvoiceCancelled(uint256 indexed invoiceId, address indexed creator);
    event DisputeRaised(uint256 indexed invoiceId, address indexed raisedBy, bytes32 reasonHash);
    event DisputeResolved(
        uint256 indexed invoiceId,
        address indexed resolvedBy,
        uint256 payeeAward,
        uint256 payerRefund
    );

    event SessionGranted(
        address indexed treasury,
        address indexed agent,
        uint256 maxPerTx,
        uint256 dailyCap,
        uint64 expiresAt,
        bool requireVerifiedPayee,
        address allowedPayee
    );
    event SessionRevoked(address indexed treasury, address indexed agent);
    event AgentPaymentExecuted(
        uint256 indexed invoiceId,
        address indexed treasury,
        address indexed agent,
        address payee,
        uint256 amount,
        bytes32 reasonHash,
        uint256 dailyRemaining
    );

    error NotOwner();
    error NotArbiterOrParty();
    error ContractPaused();
    error Reentrancy();
    error ZeroAddress();
    error ZeroAmount();
    error InvalidDecimals();
    error InvalidFee();
    error InvalidDeadline();
    error InvalidSessionConfig();
    error InvoiceNotFound();
    error InvalidStatus();
    error NotCreator();
    error NotPayer();
    error PayeeMismatch();
    error ConfirmationOfPayeeFailed();
    error UnverifiedPayee();
    error AmountExceedsRemaining();
    error DeadlineNotReached();
    error TokenTransferDeltaMismatch();
    error SessionNotActive();
    error SessionRevokedErr();
    error SessionExpired();
    error PerTxCapExceeded();
    error DailyCapExceeded();
    error PayeeNotAllowed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert ContractPaused();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address tusd8Address,
        address registryAddress,
        address initialOwner,
        address initialArbiter,
        address initialFeeRecipient,
        uint16 initialFeeBps
    ) {
        if (
            tusd8Address == address(0) ||
            registryAddress == address(0) ||
            initialOwner == address(0) ||
            initialArbiter == address(0) ||
            initialFeeRecipient == address(0)
        ) revert ZeroAddress();
        if (initialFeeBps > MAX_FEE_BPS) revert InvalidFee();

        ITUSD8 token = ITUSD8(tusd8Address);
        if (token.decimals() != EXPECTED_TOKEN_DECIMALS) revert InvalidDecimals();

        tusd8 = token;
        registry = PayeeRegistry(registryAddress);
        owner = initialOwner;
        arbiter = initialArbiter;
        feeRecipient = initialFeeRecipient;
        feeBps = initialFeeBps;

        emit OwnershipTransferred(address(0), initialOwner);
        emit ArbiterUpdated(address(0), initialArbiter);
        emit FeeUpdated(initialFeeRecipient, initialFeeBps);
    }

    // -------------------------------------------------------------------------
    // Admin / Safety Controls
    // -------------------------------------------------------------------------

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setArbiter(address newArbiter) external onlyOwner {
        if (newArbiter == address(0)) revert ZeroAddress();
        emit ArbiterUpdated(arbiter, newArbiter);
        arbiter = newArbiter;
    }

    function setFee(address newFeeRecipient, uint16 newFeeBps) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        if (newFeeBps > MAX_FEE_BPS) revert InvalidFee();
        feeRecipient = newFeeRecipient;
        feeBps = newFeeBps;
        emit FeeUpdated(newFeeRecipient, newFeeBps);
    }

    function setPaused(bool isPaused) external onlyOwner {
        paused = isPaused;
        emit PausedSet(isPaused);
    }

    // -------------------------------------------------------------------------
    // Invoice Creation & Payment (Instant or Escrow)
    // -------------------------------------------------------------------------

    function createInvoice(
        address payee,
        uint256 totalAmount,
        InvoiceMode mode,
        uint64 deadline,
        bytes32 expectedLabelHash,
        bytes32 externalRef,
        bytes32 memoHash,
        bool requireRegisteredPayee
    ) external whenNotPaused returns (uint256 invoiceId) {
        if (payee == address(0)) revert ZeroAddress();
        if (totalAmount == 0) revert ZeroAmount();
        if (mode == InvoiceMode.Escrow && deadline <= block.timestamp) revert InvalidDeadline();

        if (requireRegisteredPayee || expectedLabelHash != bytes32(0)) {
            (bool matches, , , , ) = registry.verifyPayee(payee, expectedLabelHash);
            if (!matches) revert ConfirmationOfPayeeFailed();
        }

        invoiceId = nextInvoiceId++;
        _invoices[invoiceId] = Invoice({
            id: invoiceId,
            creator: msg.sender,
            payer: address(0),
            payee: payee,
            agent: address(0),
            totalAmount: totalAmount,
            releasedAmount: 0,
            createdAt: uint64(block.timestamp),
            deadline: deadline,
            mode: mode,
            status: InvoiceStatus.Open,
            expectedLabelHash: expectedLabelHash,
            externalRef: externalRef,
            memoHash: memoHash,
            reasonHash: bytes32(0)
        });

        emit InvoiceCreated(
            invoiceId,
            msg.sender,
            payee,
            totalAmount,
            mode,
            deadline,
            expectedLabelHash,
            externalRef,
            memoHash
        );
    }

    function cancelInvoice(uint256 invoiceId) external {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (inv.status != InvoiceStatus.Open) revert InvalidStatus();
        if (msg.sender != inv.creator) revert NotCreator();

        inv.status = InvoiceStatus.Cancelled;
        emit InvoiceCancelled(invoiceId, msg.sender);
    }

    /// @notice Fund an Open invoice with exact tUSD8 amount after verifying payee & optional CoP label hash.
    function fundInvoice(
        uint256 invoiceId,
        address expectedPayee,
        bytes32 expectedLabelHash
    ) external whenNotPaused nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (inv.status != InvoiceStatus.Open) revert InvalidStatus();
        if (inv.payee != expectedPayee) revert PayeeMismatch();

        bytes32 copHash = expectedLabelHash != bytes32(0) ? expectedLabelHash : inv.expectedLabelHash;
        if (copHash != bytes32(0)) {
            (bool matches, , , , ) = registry.verifyPayee(inv.payee, copHash);
            if (!matches) revert ConfirmationOfPayeeFailed();
        }

        uint256 amount = inv.totalAmount;
        inv.payer = msg.sender;

        if (inv.mode == InvoiceMode.Instant) {
            inv.releasedAmount = amount;
            inv.status = InvoiceStatus.Settled;
            _pullExactFrom(msg.sender, amount);
            (uint256 net, uint256 fee) = _payoutWithFee(inv.payee, amount);
            emit InvoiceFunded(invoiceId, msg.sender, inv.payee, amount, InvoiceMode.Instant);
            emit MilestoneReleased(invoiceId, msg.sender, inv.payee, amount, net, fee, amount);
            emit InvoiceSettled(invoiceId, msg.sender, inv.payee, amount, fee);
        } else {
            inv.status = InvoiceStatus.Funded;
            _pullExactFrom(msg.sender, amount);
            emit InvoiceFunded(invoiceId, msg.sender, inv.payee, amount, InvoiceMode.Escrow);
        }
    }

    /// @notice Release partial or full milestone amount from a Funded Escrow invoice to the payee.
    function releaseEscrow(uint256 invoiceId, uint256 releaseAmount) external whenNotPaused nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (inv.status != InvoiceStatus.Funded) revert InvalidStatus();
        if (msg.sender != inv.payer) revert NotPayer();
        if (releaseAmount == 0) revert ZeroAmount();

        uint256 remaining = inv.totalAmount - inv.releasedAmount;
        if (releaseAmount > remaining) revert AmountExceedsRemaining();

        inv.releasedAmount += releaseAmount;
        bool settled = inv.releasedAmount == inv.totalAmount;
        if (settled) {
            inv.status = InvoiceStatus.Settled;
        }

        (uint256 net, uint256 fee) = _payoutWithFee(inv.payee, releaseAmount);
        emit MilestoneReleased(invoiceId, msg.sender, inv.payee, releaseAmount, net, fee, inv.releasedAmount);

        if (settled) {
            emit InvoiceSettled(invoiceId, msg.sender, inv.payee, inv.releasedAmount, fee);
        }
    }

    /// @notice Reclaim unreleased tUSD8 if an Escrow invoice passes its delivery deadline without dispute.
    function claimExpiredRefund(uint256 invoiceId) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (inv.status != InvoiceStatus.Funded) revert InvalidStatus();
        if (msg.sender != inv.payer) revert NotPayer();
        if (block.timestamp <= inv.deadline) revert DeadlineNotReached();

        uint256 refundAmount = inv.totalAmount - inv.releasedAmount;
        inv.status = InvoiceStatus.Refunded;

        tusd8.safeTransfer(inv.payer, refundAmount);
        emit InvoiceRefunded(invoiceId, inv.payer, refundAmount);
    }

    /// @notice Freeze a Funded Escrow invoice so neither side loses funds unilaterally.
    function raiseDispute(uint256 invoiceId, bytes32 reasonHash) external {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (inv.status != InvoiceStatus.Funded) revert InvalidStatus();
        if (msg.sender != inv.payer && msg.sender != inv.payee) revert NotArbiterOrParty();

        inv.status = InvoiceStatus.Disputed;
        inv.reasonHash = reasonHash;
        emit DisputeRaised(invoiceId, msg.sender, reasonHash);
    }

    /// @notice Resolve a Disputed invoice. Arbiter may split arbitrarily; payer may concede all; payee may refund all.
    function resolveDispute(uint256 invoiceId, uint256 payeeAward) external nonReentrant {
        Invoice storage inv = _invoices[invoiceId];
        if (inv.status == InvoiceStatus.None) revert InvoiceNotFound();
        if (inv.status != InvoiceStatus.Disputed) revert InvalidStatus();

        uint256 remaining = inv.totalAmount - inv.releasedAmount;
        if (payeeAward > remaining) revert AmountExceedsRemaining();

        if (msg.sender == arbiter) {
            // Arbiter can split remaining funds
        } else if (msg.sender == inv.payer && payeeAward == remaining) {
            // Payer concedes full remaining amount to payee
        } else if (msg.sender == inv.payee && payeeAward == 0) {
            // Payee concedes full refund to payer
        } else {
            revert NotArbiterOrParty();
        }

        uint256 payerRefund = remaining - payeeAward;
        if (payeeAward > 0) {
            inv.releasedAmount += payeeAward;
            inv.status = InvoiceStatus.Settled;
            (uint256 net, uint256 fee) = _payoutWithFee(inv.payee, payeeAward);
            emit MilestoneReleased(invoiceId, inv.payer, inv.payee, payeeAward, net, fee, inv.releasedAmount);
            emit InvoiceSettled(invoiceId, inv.payer, inv.payee, payeeAward, fee);
        } else {
            inv.status = InvoiceStatus.Refunded;
        }

        if (payerRefund > 0) {
            tusd8.safeTransfer(inv.payer, payerRefund);
            emit InvoiceRefunded(invoiceId, inv.payer, payerRefund);
        }

        emit DisputeResolved(invoiceId, msg.sender, payeeAward, payerRefund);
    }

    // -------------------------------------------------------------------------
    // Scoped Agent Session Keys (Least-Privilege Autonomous Payments)
    // -------------------------------------------------------------------------

    function grantSession(
        address agent,
        uint256 maxPerTx,
        uint256 dailyCap,
        uint64 expiresAt,
        bool requireVerifiedPayee,
        address allowedPayee
    ) external whenNotPaused {
        if (agent == address(0)) revert ZeroAddress();
        if (maxPerTx == 0 || dailyCap < maxPerTx) revert InvalidSessionConfig();
        if (expiresAt <= block.timestamp) revert InvalidDeadline();

        _sessions[msg.sender][agent] = SessionPolicy({
            active: true,
            revoked: false,
            requireVerifiedPayee: requireVerifiedPayee,
            expiresAt: expiresAt,
            lastSpendDay: uint64(block.timestamp / 1 days),
            maxPerTx: maxPerTx,
            dailyCap: dailyCap,
            spentToday: 0,
            totalSpent: 0,
            allowedPayee: allowedPayee
        });

        emit SessionGranted(
            msg.sender,
            agent,
            maxPerTx,
            dailyCap,
            expiresAt,
            requireVerifiedPayee,
            allowedPayee
        );
    }

    function revokeSession(address agent) external {
        SessionPolicy storage s = _sessions[msg.sender][agent];
        s.active = false;
        s.revoked = true;
        emit SessionRevoked(msg.sender, agent);
    }

    /// @notice Execute a policy-bounded tUSD8 payment on behalf of `treasury` using msg.sender's session key.
    function payWithSession(
        address treasury,
        address payee,
        bytes32 expectedLabelHash,
        uint256 amount,
        bytes32 externalRef,
        bytes32 memoHash,
        bytes32 reasonHash
    ) external whenNotPaused nonReentrant returns (uint256 invoiceId) {
        if (treasury == address(0) || payee == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();

        SessionPolicy storage s = _sessions[treasury][msg.sender];
        if (s.revoked) revert SessionRevokedErr();
        if (!s.active) revert SessionNotActive();
        if (block.timestamp > s.expiresAt) revert SessionExpired();
        if (amount > s.maxPerTx) revert PerTxCapExceeded();
        if (s.allowedPayee != address(0) && payee != s.allowedPayee) revert PayeeNotAllowed();

        if (s.requireVerifiedPayee || expectedLabelHash != bytes32(0)) {
            (bool matches, bool active, , , ) = registry.verifyPayee(payee, expectedLabelHash);
            if (!active) revert UnverifiedPayee();
            if (!matches) revert ConfirmationOfPayeeFailed();
        }

        uint64 today = uint64(block.timestamp / 1 days);
        if (today != s.lastSpendDay) {
            s.lastSpendDay = today;
            s.spentToday = 0;
        }
        if (s.spentToday + amount > s.dailyCap) revert DailyCapExceeded();

        s.spentToday += amount;
        s.totalSpent += amount;
        uint256 dailyRemaining = s.dailyCap - s.spentToday;

        invoiceId = nextInvoiceId++;
        _invoices[invoiceId] = Invoice({
            id: invoiceId,
            creator: treasury,
            payer: treasury,
            payee: payee,
            agent: msg.sender,
            totalAmount: amount,
            releasedAmount: amount,
            createdAt: uint64(block.timestamp),
            deadline: 0,
            mode: InvoiceMode.Instant,
            status: InvoiceStatus.Settled,
            expectedLabelHash: expectedLabelHash,
            externalRef: externalRef,
            memoHash: memoHash,
            reasonHash: reasonHash
        });

        _pullExactFrom(treasury, amount);
        (uint256 net, uint256 fee) = _payoutWithFee(payee, amount);

        emit InvoiceCreated(
            invoiceId,
            treasury,
            payee,
            amount,
            InvoiceMode.Instant,
            0,
            expectedLabelHash,
            externalRef,
            memoHash
        );
        emit InvoiceFunded(invoiceId, treasury, payee, amount, InvoiceMode.Instant);
        emit MilestoneReleased(invoiceId, treasury, payee, amount, net, fee, amount);
        emit InvoiceSettled(invoiceId, treasury, payee, amount, fee);
        emit AgentPaymentExecuted(invoiceId, treasury, msg.sender, payee, amount, reasonHash, dailyRemaining);
    }

    // -------------------------------------------------------------------------
    // Views & Internals
    // -------------------------------------------------------------------------

    function getInvoice(uint256 invoiceId) external view returns (Invoice memory) {
        return _invoices[invoiceId];
    }

    function getSession(address treasury, address agent) external view returns (SessionPolicy memory) {
        return _sessions[treasury][agent];
    }

    function remainingDailyAllowance(address treasury, address agent) external view returns (uint256) {
        SessionPolicy storage s = _sessions[treasury][agent];
        if (!s.active || s.revoked || block.timestamp > s.expiresAt) return 0;
        uint64 today = uint64(block.timestamp / 1 days);
        uint256 spent = (today == s.lastSpendDay) ? s.spentToday : 0;
        return spent >= s.dailyCap ? 0 : s.dailyCap - spent;
    }

    function _pullExactFrom(address from, uint256 amount) internal {
        uint256 beforeBal = tusd8.balanceOf(address(this));
        tusd8.safeTransferFrom(from, address(this), amount);
        uint256 afterBal = tusd8.balanceOf(address(this));
        if (afterBal - beforeBal != amount) revert TokenTransferDeltaMismatch();
    }

    function _payoutWithFee(address payee, uint256 grossAmount) internal returns (uint256 net, uint256 fee) {
        if (feeBps == 0) {
            net = grossAmount;
            fee = 0;
            tusd8.safeTransfer(payee, net);
        } else {
            fee = (grossAmount * feeBps) / 10_000;
            net = grossAmount - fee;
            if (net > 0) tusd8.safeTransfer(payee, net);
            if (fee > 0) tusd8.safeTransfer(feeRecipient, fee);
        }
    }
}
