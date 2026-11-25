// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ITUSD8} from "../interfaces/ITUSD8.sol";

library SafeERC20Lite {
    error SafeTransferFailed();
    error SafeTransferFromFailed();

    function safeTransfer(ITUSD8 token, address to, uint256 value) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(ITUSD8.transfer.selector, to, value)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFailed();
        }
    }

    function safeTransferFrom(ITUSD8 token, address from, address to, uint256 value) internal {
        (bool ok, bytes memory data) = address(token).call(
            abi.encodeWithSelector(ITUSD8.transferFrom.selector, from, to, value)
        );
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) {
            revert SafeTransferFromFailed();
        }
    }
}
