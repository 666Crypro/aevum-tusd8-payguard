// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, console2} from "forge-std/Test.sol";
import {ITUSD8} from "../src/interfaces/ITUSD8.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {TUSD8PayGuard} from "../src/TUSD8PayGuard.sol";

/// @notice Fork test against live QDay Aevum Testnet (Chain ID 44005) and official tUSD8 contract.
contract PayGuardForkTest is Test {
    address constant OFFICIAL_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;
    address constant OFFICIAL_TUSD8_FAUCET = 0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564;

    ITUSD8 tusd8;
    PayeeRegistry registry;
    TUSD8PayGuard guard;

    address owner = address(0xA11CE);
    address merchant = address(0xB0B);
    address treasury = address(0xC0C0);
    address agent = address(0xD00D);

    function setUp() public {
        string memory rpc = vm.envOr("AEVUM_RPC_URL", string("https://rpc-test.qday.info"));
        vm.createSelectFork(rpc);
        require(block.chainid == 44005, "Expected QDay Aevum Testnet chainId 44005");

        tusd8 = ITUSD8(OFFICIAL_TUSD8);
        registry = new PayeeRegistry(owner);
        guard = new TUSD8PayGuard(OFFICIAL_TUSD8, address(registry), owner, owner, owner, 0);

        // Fund treasury from the real Aevum tUSD8Faucet on fork
        vm.prank(OFFICIAL_TUSD8_FAUCET);
        require(tusd8.transfer(treasury, 100_000_000), "fork faucet transfer failed"); // 100.000000 tUSD8

        vm.prank(treasury);
        tusd8.approve(address(guard), type(uint256).max);
    }

    function test_ForkEndToEndRealTUSD8() public {
        assertEq(tusd8.decimals(), 6);
        assertEq(tusd8.symbol(), "tUSD8");

        // 1. Register verified merchant in PayeeRegistry
        vm.prank(merchant);
        bytes32 cop = registry.registerPayee(
            "Aevum Cloud Node #1",
            PayeeRegistry.PayeeType.Merchant,
            "https://example.invalid/aevum-node.json"
        );

        // 2. Escrow invoice funded with real tUSD8 (25.000000 tUSD8)
        uint64 deadline = uint64(block.timestamp + 2 days);
        vm.prank(merchant);
        uint256 invId = guard.createInvoice(
            merchant,
            25_000_000,
            TUSD8PayGuard.InvoiceMode.Escrow,
            deadline,
            cop,
            keccak256("INV-AEVUM-44005-1"),
            keccak256("GPU compute 50h @ 0.50 tUSD8/h"),
            true
        );

        vm.prank(treasury);
        guard.fundInvoice(invId, merchant, cop);
        assertEq(tusd8.balanceOf(address(guard)), 25_000_000);

        // Release milestone 1 (10 tUSD8) and milestone 2 (15 tUSD8)
        vm.prank(treasury);
        guard.releaseEscrow(invId, 10_000_000);
        vm.prank(treasury);
        guard.releaseEscrow(invId, 15_000_000);
        assertEq(tusd8.balanceOf(merchant), 25_000_000);

        // 3. Autonomous agent session key executes bounded tUSD8 payment (12.500000 tUSD8)
        vm.prank(treasury);
        guard.grantSession(agent, 15_000_000, 30_000_000, uint64(block.timestamp + 7 days), true, address(0));

        vm.prank(agent);
        guard.payWithSession(
            treasury,
            merchant,
            cop,
            12_500_000,
            keccak256("AGENT-AUTO-001"),
            keccak256("Monthly API renewal"),
            keccak256('{"policy":"within_15_per_tx","cop_verified":true}')
        );

        assertEq(tusd8.balanceOf(merchant), 37_500_000);
        assertEq(tusd8.balanceOf(treasury), 62_500_000);
        console2.log("Verified real tUSD8 fork settlement. Merchant balance:", tusd8.balanceOf(merchant));
    }
}
