// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console2} from "forge-std/Script.sol";
import {PayeeRegistry} from "../src/PayeeRegistry.sol";
import {TUSD8PayGuard} from "../src/TUSD8PayGuard.sol";

contract Deploy is Script {
    address public constant OFFICIAL_AEVUM_TUSD8 = 0x456569838f1d43009A91ebA4263147Afd7233483;

    function run() external returns (PayeeRegistry registry, TUSD8PayGuard payGuard) {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address tusd8Addr = vm.envOr("TUSD8_ADDRESS", OFFICIAL_AEVUM_TUSD8);
        address arbiter = vm.envOr("ARBITER_ADDRESS", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT_ADDRESS", deployer);
        uint256 feeBpsRaw = vm.envOr("FEE_BPS", uint256(0));
        require(feeBpsRaw <= 100, "FEE_BPS > 100");

        vm.startBroadcast(pk);
        registry = new PayeeRegistry(deployer);
        payGuard = new TUSD8PayGuard(
            tusd8Addr,
            address(registry),
            deployer,
            arbiter,
            feeRecipient,
            uint16(feeBpsRaw)
        );
        vm.stopBroadcast();

        console2.log("Chain ID:", block.chainid);
        console2.log("Deployer:", deployer);
        console2.log("tUSD8:", tusd8Addr);
        console2.log("PayeeRegistry:", address(registry));
        console2.log("TUSD8PayGuard:", address(payGuard));

        string memory obj = "deployment";
        vm.serializeUint(obj, "chainId", block.chainid);
        vm.serializeAddress(obj, "deployer", deployer);
        vm.serializeAddress(obj, "tusd8", tusd8Addr);
        vm.serializeAddress(obj, "payeeRegistry", address(registry));
        string memory json = vm.serializeAddress(obj, "tusd8PayGuard", address(payGuard));

        string memory path = string.concat("../deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
