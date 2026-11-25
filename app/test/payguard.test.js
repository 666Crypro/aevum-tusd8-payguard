import test from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import {
  parseTUSD8,
  formatTUSD8,
  computeLabelHash,
  canonicalReasonHash,
  buildErc681TransferUri,
  parseAndValidateErc681TransferUri,
} from "../src/erc681.js";
import { HonestChainWatcher } from "../src/watcher.js";
import { AEVUM, ERC20_MIN_ABI } from "../src/config.js";

test("parseTUSD8 uses strict 6-decimal integer arithmetic", () => {
  assert.equal(parseTUSD8("25"), 25_000_000n);
  assert.equal(parseTUSD8("0.000001"), 1n);
  assert.equal(formatTUSD8(12_500_000n), "12.5");
  assert.throws(() => parseTUSD8("1.1234567"));
  assert.throws(() => parseTUSD8("0"));
  assert.throws(() => parseTUSD8("-5"));
  assert.throws(() => parseTUSD8(25));
});

test("ERC-681 builder pins chainId 44005 and official tUSD8", () => {
  const recipient = "0x1111111111111111111111111111111111111111";
  const uri = buildErc681TransferUri({ recipient, amountUnits: 25_000_000n });
  assert.equal(
    uri,
    `ethereum:${AEVUM.tusd8Address}@44005/transfer?address=${recipient}&uint256=25000000`
  );
  const parsed = parseAndValidateErc681TransferUri(uri);
  assert.equal(parsed.chainId, 44005);
  assert.equal(parsed.amountUnits, 25_000_000n);

  // Reject wrong chain ID
  assert.throws(() =>
    parseAndValidateErc681TransferUri(
      `ethereum:${AEVUM.tusd8Address}@1/transfer?address=${recipient}&uint256=25000000`
    )
  );
  // Reject spoofed token contract
  assert.throws(() =>
    parseAndValidateErc681TransferUri(
      `ethereum:0x2222222222222222222222222222222222222222@44005/transfer?address=${recipient}&uint256=25000000`
    )
  );
});

test("computeLabelHash and canonicalReasonHash are deterministic", () => {
  const h1 = computeLabelHash("Aevum Cloud Node #1");
  const h2 = ethers.keccak256(ethers.toUtf8Bytes("Aevum Cloud Node #1"));
  assert.equal(h1, h2);

  const r1 = canonicalReasonHash({ b: 2, a: 1 });
  const r2 = canonicalReasonHash({ a: 1, b: 2 });
  assert.equal(r1, r2);
});

test("HonestChainWatcher ignores zero-value transfers and foreign tokens", () => {
  const iface = new ethers.Interface(ERC20_MIN_ABI);
  const transferTopic = iface.getEvent("Transfer").topicHash;
  const fromTopic = ethers.zeroPadValue("0x1111111111111111111111111111111111111111", 32);
  const toTopic = ethers.zeroPadValue("0x2222222222222222222222222222222222222222", 32);
  const coder = ethers.AbiCoder.defaultAbiCoder();

  const watcher = new HonestChainWatcher({ provider: null });
  const res = watcher.inspectReceipt({
    hash: "0x" + "aa".repeat(32),
    blockNumber: 4102800,
    logs: [
      // 1. Zero-value transfer on official tUSD8 -> MUST be skipped
      {
        address: AEVUM.tusd8Address,
        topics: [transferTopic, fromTopic, toTopic],
        data: coder.encode(["uint256"], [0n]),
      },
      // 2. Spoofed token contract -> MUST be skipped
      {
        address: "0x3333333333333333333333333333333333333333",
        topics: [transferTopic, fromTopic, toTopic],
        data: coder.encode(["uint256"], [99_000_000n]),
      },
      // 3. Genuine tUSD8 transfer -> MUST be recorded
      {
        address: AEVUM.tusd8Address,
        topics: [transferTopic, fromTopic, toTopic],
        data: coder.encode(["uint256"], [25_000_000n]),
      },
    ],
  });

  assert.equal(res.skippedZero, 1);
  assert.equal(res.skippedForeign, 1);
  assert.equal(res.transfers.length, 1);
  assert.equal(res.transfers[0].valueUnits, "25000000");
});
