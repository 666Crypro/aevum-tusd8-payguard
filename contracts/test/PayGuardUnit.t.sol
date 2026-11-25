// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {TUSD8PayGuard} from "../src/TUSD8PayGuard.sol";

contract MockTUSD8 {
    string public name = "tUSD8";
    string public symbol = "tUSD8";
    uint8 public immutable decimals;
    uint256 public totalSupply;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(uint8 _decimals) {
        decimals = _decimals;
    }

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "INSUFFICIENT");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= value, "ALLOWANCE");
            allowance[from][msg.sender] = allowed - value;
        }
        require(balanceOf[from] >= value, "INSUFFICIENT");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

contract PayGuardUnitTest is Test {
    MockTUSD8 token;
    PayeeRegistry registry;
    TUSD8PayGuard guard;

    address owner = address(0xA11CE);
    address arbiter = address(0xA4B1);
    address feeRecip = address(0xFEE0);
    address merchant = address(0xB0B);
    address payer = address(0xC0C0);
    address agent = address(0xD00D);
    address attacker = address(0xBAD);

    uint256 constant ONE_USD8 = 1_000_000; // 6 decimals

    function setUp() public {
        vm.warp(1_795_000_000);
        token = new MockTUSD8(6);
        registry = new PayeeRegistry(owner);
        guard = new TUSD8PayGuard(address(token), address(registry), owner, arbiter, feeRecip, 0);

        token.mint(payer, 1_000 * ONE_USD8);
        vm.prank(payer);
        token.approve(address(guard), type(uint256).max);

        vm.prank(merchant);
        registry.registerPayee("Acme Cloud Compute", PayeeRegistry.PayeeType.Merchant, "ipfs://acme-profile");
    }

    function test_ConstructorRejectsWrongDecimals() public {
        MockTUSD8 bad18 = new MockTUSD8(18);
        vm.expectRevert(TUSD8PayGuard.InvalidDecimals.selector);
        new TUSD8PayGuard(address(bad18), address(registry), owner, arbiter, feeRecip, 0);
    }

    function test_PayeeRegistrationAndCoPVerify() public view {
        bytes32 expected = registry.computeLabelHash("Acme Cloud Compute");
        (bool matches, bool active, bool attested, PayeeRegistry.PayeeType ptype, string memory label) =
            registry.verifyPayee(merchant, expected);
        assertTrue(matches);
        assertTrue(active);
        assertFalse(attested);
        assertEq(uint8(ptype), uint8(PayeeRegistry.PayeeType.Merchant));
        assertEq(label, "Acme Cloud Compute");

        (bool wrongMatches, , , , ) = registry.verifyPayee(merchant, keccak256("Lookalike Inc"));
        assertFalse(wrongMatches);
    }

    function test_AttestationByOwner() public {
        vm.prank(attacker);
        vm.expectRevert(PayeeRegistry.NotOwner.selector);
        registry.setAttested(merchant, true);

        vm.prank(owner);
        registry.setAttested(merchant, true);
        assertTrue(registry.getPayee(merchant).attested);
    }

    function test_InstantInvoiceWithCoP() public {
        bytes32 cop = registry.computeLabelHash("Acme Cloud Compute");
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            25 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Instant,
            0,
            cop,
            keccak256("INV-001"),
            keccak256("memo-001"),
            true
        );

        uint256 beforeM = token.balanceOf(merchant);
        vm.prank(payer);
        guard.fundInvoice(id, merchant, cop);

        assertEq(token.balanceOf(merchant) - beforeM, 25 * ONE_USD8);
        TUSD8PayGuard.Invoice memory inv = guard.getInvoice(id);
        assertEq(uint8(inv.status), uint8(TUSD8PayGuard.InvoiceStatus.Settled));
        assertEq(inv.releasedAmount, 25 * ONE_USD8);
    }

    function test_FundInvoiceRevertsOnCoPMismatch() public {
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            10 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Instant,
            0,
            bytes32(0),
            keccak256("INV-002"),
            keccak256("memo-002"),
            true
        );

        vm.prank(payer);
        vm.expectRevert(TUSD8PayGuard.ConfirmationOfPayeeFailed.selector);
        guard.fundInvoice(id, merchant, keccak256("Wrong Merchant Name"));
    }

    function test_FundInvoiceRevertsOnPayeeMismatch() public {
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            10 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Instant,
            0,
            bytes32(0),
            keccak256("INV-003"),
            bytes32(0),
            false
        );

        vm.prank(payer);
        vm.expectRevert(TUSD8PayGuard.PayeeMismatch.selector);
        guard.fundInvoice(id, attacker, bytes32(0));
    }

    function test_EscrowMilestoneReleaseFlow() public {
        uint64 deadline = uint64(block.timestamp + 3 days);
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            100 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Escrow,
            deadline,
            bytes32(0),
            keccak256("ESCROW-01"),
            bytes32(0),
            true
        );

        vm.prank(payer);
        guard.fundInvoice(id, merchant, bytes32(0));
        assertEq(token.balanceOf(address(guard)), 100 * ONE_USD8);

        // Release milestone 1 (40%)
        vm.prank(payer);
        guard.releaseEscrow(id, 40 * ONE_USD8);
        assertEq(token.balanceOf(merchant), 40 * ONE_USD8);
        assertEq(uint8(guard.getInvoice(id).status), uint8(TUSD8PayGuard.InvoiceStatus.Funded));

        // Non-payer cannot release
        vm.prank(attacker);
        vm.expectRevert(TUSD8PayGuard.NotPayer.selector);
        guard.releaseEscrow(id, 10 * ONE_USD8);

        // Release remaining 60%
        vm.prank(payer);
        guard.releaseEscrow(id, 60 * ONE_USD8);
        assertEq(token.balanceOf(merchant), 100 * ONE_USD8);
        assertEq(uint8(guard.getInvoice(id).status), uint8(TUSD8PayGuard.InvoiceStatus.Settled));
    }

    function test_EscrowExpiredRefund() public {
        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            60 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Escrow,
            deadline,
            bytes32(0),
            keccak256("ESCROW-EXP"),
            bytes32(0),
            true
        );

        vm.prank(payer);
        guard.fundInvoice(id, merchant, bytes32(0));

        vm.prank(payer);
        guard.releaseEscrow(id, 20 * ONE_USD8);

        // Before deadline -> revert
        vm.prank(payer);
        vm.expectRevert(TUSD8PayGuard.DeadlineNotReached.selector);
        guard.claimExpiredRefund(id);

        // After deadline -> refund remaining 40
        vm.warp(deadline + 1);
        uint256 beforeP = token.balanceOf(payer);
        vm.prank(payer);
        guard.claimExpiredRefund(id);
        assertEq(token.balanceOf(payer) - beforeP, 40 * ONE_USD8);
        assertEq(uint8(guard.getInvoice(id).status), uint8(TUSD8PayGuard.InvoiceStatus.Refunded));
    }

    function test_DisputeAndArbiterSplit() public {
        uint64 deadline = uint64(block.timestamp + 2 days);
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            100 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Escrow,
            deadline,
            bytes32(0),
            keccak256("DISPUTE-01"),
            bytes32(0),
            true
        );

        vm.prank(payer);
        guard.fundInvoice(id, merchant, bytes32(0));

        vm.prank(payer);
        guard.raiseDispute(id, keccak256("late delivery"));
        assertEq(uint8(guard.getInvoice(id).status), uint8(TUSD8PayGuard.InvoiceStatus.Disputed));

        // Attacker cannot resolve
        vm.prank(attacker);
        vm.expectRevert(TUSD8PayGuard.NotArbiterOrParty.selector);
        guard.resolveDispute(id, 50 * ONE_USD8);

        // Arbiter splits 70 to merchant, 30 refunded to payer
        uint256 beforeP = token.balanceOf(payer);
        vm.prank(arbiter);
        guard.resolveDispute(id, 70 * ONE_USD8);
        assertEq(token.balanceOf(merchant), 70 * ONE_USD8);
        assertEq(token.balanceOf(payer) - beforeP, 30 * ONE_USD8);
        assertEq(uint8(guard.getInvoice(id).status), uint8(TUSD8PayGuard.InvoiceStatus.Settled));
    }

    function test_SessionKeyCapsAndDailyRollover() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        vm.prank(payer);
        guard.grantSession(agent, 20 * ONE_USD8, 35 * ONE_USD8, exp, true, address(0));

        bytes32 cop = registry.computeLabelHash("Acme Cloud Compute");

        // 1) Over per-tx cap -> reverts
        vm.prank(agent);
        vm.expectRevert(TUSD8PayGuard.PerTxCapExceeded.selector);
        guard.payWithSession(payer, merchant, cop, 21 * ONE_USD8, keccak256("A1"), bytes32(0), keccak256("r1"));

        // 2) Valid 20 tUSD8 payment -> succeeds
        vm.prank(agent);
        guard.payWithSession(payer, merchant, cop, 20 * ONE_USD8, keccak256("A2"), bytes32(0), keccak256("r2"));
        assertEq(guard.remainingDailyAllowance(payer, agent), 15 * ONE_USD8);

        // 3) Next 16 tUSD8 exceeds daily 35 cap -> reverts
        vm.prank(agent);
        vm.expectRevert(TUSD8PayGuard.DailyCapExceeded.selector);
        guard.payWithSession(payer, merchant, cop, 16 * ONE_USD8, keccak256("A3"), bytes32(0), keccak256("r3"));

        // 4) 15 tUSD8 fits exactly -> succeeds
        vm.prank(agent);
        guard.payWithSession(payer, merchant, cop, 15 * ONE_USD8, keccak256("A4"), bytes32(0), keccak256("r4"));
        assertEq(guard.remainingDailyAllowance(payer, agent), 0);

        // 5) Next UTC day -> resets daily allowance
        vm.warp(block.timestamp + 1 days);
        assertEq(guard.remainingDailyAllowance(payer, agent), 35 * ONE_USD8);
        vm.prank(agent);
        guard.payWithSession(payer, merchant, cop, 10 * ONE_USD8, keccak256("A5"), bytes32(0), keccak256("r5"));
        assertEq(token.balanceOf(merchant), 45 * ONE_USD8);
    }

    function test_SessionBlocksUnverifiedPayeeAndRevocationAndExpiry() public {
        uint64 exp = uint64(block.timestamp + 1 hours);
        vm.prank(payer);
        guard.grantSession(agent, 50 * ONE_USD8, 100 * ONE_USD8, exp, true, address(0));

        // Unregistered address (e.g. prompt injection target) -> blocked
        vm.prank(agent);
        vm.expectRevert(TUSD8PayGuard.UnverifiedPayee.selector);
        guard.payWithSession(payer, attacker, bytes32(0), 5 * ONE_USD8, keccak256("INJ"), bytes32(0), keccak256("bad"));

        // Deactivated payee -> blocked
        vm.prank(merchant);
        registry.updatePayee(false, "ipfs://rotated");
        vm.prank(agent);
        vm.expectRevert(TUSD8PayGuard.UnverifiedPayee.selector);
        guard.payWithSession(payer, merchant, bytes32(0), 5 * ONE_USD8, keccak256("DEC"), bytes32(0), keccak256("dec"));

        // Re-activate, then revoke session -> blocked immediately
        vm.prank(merchant);
        registry.updatePayee(true, "ipfs://active");
        vm.prank(payer);
        guard.revokeSession(agent);

        vm.prank(agent);
        vm.expectRevert(TUSD8PayGuard.SessionRevokedErr.selector);
        guard.payWithSession(payer, merchant, bytes32(0), 5 * ONE_USD8, keccak256("REV"), bytes32(0), keccak256("rev"));

        // Re-grant with short expiry, warp past expiry -> blocked
        uint64 exp2 = uint64(block.timestamp + 60);
        vm.prank(payer);
        guard.grantSession(agent, 50 * ONE_USD8, 100 * ONE_USD8, exp2, true, merchant);
        vm.warp(exp2 + 1);
        vm.prank(agent);
        vm.expectRevert(TUSD8PayGuard.SessionExpired.selector);
        guard.payWithSession(payer, merchant, bytes32(0), 5 * ONE_USD8, keccak256("EXP"), bytes32(0), keccak256("exp"));
    }

    function test_PauseCircuitBreaker() public {
        vm.prank(owner);
        guard.setPaused(true);

        vm.prank(merchant);
        vm.expectRevert(TUSD8PayGuard.ContractPaused.selector);
        guard.createInvoice(merchant, ONE_USD8, TUSD8PayGuard.InvoiceMode.Instant, 0, bytes32(0), bytes32(0), bytes32(0), true);
    }

    function test_FeeCapAndPayout() public {
        vm.prank(owner);
        vm.expectRevert(TUSD8PayGuard.InvalidFee.selector);
        guard.setFee(feeRecip, 101);

        vm.prank(owner);
        guard.setFee(feeRecip, 50); // 0.50%

        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            100 * ONE_USD8,
            TUSD8PayGuard.InvoiceMode.Instant,
            0,
            bytes32(0),
            keccak256("FEE-1"),
            bytes32(0),
            true
        );

        vm.prank(payer);
        guard.fundInvoice(id, merchant, bytes32(0));
        assertEq(token.balanceOf(feeRecip), 500_000); // 0.50 tUSD8
        assertEq(token.balanceOf(merchant), 99_500_000); // 99.50 tUSD8
    }

    function testFuzz_EscrowPartialReleasesAndFee(uint96 rawAmount, uint16 rawSplitBps, uint16 rawFeeBps) public {
        uint256 total = bound(uint256(rawAmount), 100, 500 * ONE_USD8);
        uint256 splitBps = bound(uint256(rawSplitBps), 1, 9_999);
        uint16 fBps = uint16(bound(uint256(rawFeeBps), 0, 100));

        vm.prank(owner);
        guard.setFee(feeRecip, fBps);

        uint64 deadline = uint64(block.timestamp + 1 days);
        vm.prank(merchant);
        uint256 id = guard.createInvoice(
            merchant,
            total,
            TUSD8PayGuard.InvoiceMode.Escrow,
            deadline,
            bytes32(0),
            bytes32(uint256(total)),
            bytes32(0),
            true
        );

        vm.prank(payer);
        guard.fundInvoice(id, merchant, bytes32(0));

        uint256 part1 = (total * splitBps) / 10_000;
        if (part1 == 0) part1 = 1;
        if (part1 >= total) part1 = total - 1;
        uint256 part2 = total - part1;

        vm.prank(payer);
        guard.releaseEscrow(id, part1);
        vm.prank(payer);
        guard.releaseEscrow(id, part2);

        assertEq(token.balanceOf(address(guard)), 0);
        assertEq(token.balanceOf(merchant) + token.balanceOf(feeRecip), total);
    }
}
