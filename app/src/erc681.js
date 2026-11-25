import { ethers } from "ethers";
import { AEVUM } from "./config.js";

/**
 * Parse a decimal tUSD8 string (e.g. "25.50") into exact 6-decimal integer base units (bigint).
 * Rejects negative numbers, NaN, scientific notation, and > 6 fractional digits.
 */
export function parseTUSD8(amountStr) {
  if (typeof amountStr === "number") {
    throw new Error("Pass tUSD8 amounts as strings or bigint to avoid IEEE-754 precision loss");
  }
  const s = String(amountStr).trim();
  if (!/^\d+(\.\d{1,6})?$/.test(s)) {
    throw new Error(`Invalid tUSD8 amount "${amountStr}": expected positive decimal with up to 6 places`);
  }
  const units = ethers.parseUnits(s, AEVUM.tusd8Decimals);
  if (units <= 0n) {
    throw new Error("tUSD8 amount must be strictly greater than zero");
  }
  return units;
}

export function formatTUSD8(units) {
  const bi = BigInt(units);
  return ethers.formatUnits(bi, AEVUM.tusd8Decimals);
}

export function computeLabelHash(label) {
  const s = String(label || "");
  if (!s.length) throw new Error("Payee label cannot be empty");
  return ethers.keccak256(ethers.toUtf8Bytes(s));
}

export function canonicalReasonHash(payload) {
  const keys = Object.keys(payload).sort();
  const ordered = {};
  for (const k of keys) ordered[k] = payload[k];
  return ethers.keccak256(ethers.toUtf8Bytes(JSON.stringify(ordered)));
}

/**
 * Build an ERC-681 payment request URI pinned to QDay Aevum (chainId 44005) and official tUSD8.
 */
export function buildErc681TransferUri({
  recipient,
  amountUnits,
  tokenAddress = AEVUM.tusd8Address,
  chainId = AEVUM.chainId,
}) {
  const to = ethers.getAddress(recipient);
  const token = ethers.getAddress(tokenAddress);
  const units = BigInt(amountUnits);
  if (units <= 0n) throw new Error("amountUnits must be > 0");
  return `ethereum:${token}@${chainId}/transfer?address=${to}&uint256=${units.toString()}`;
}

/**
 * Build an ERC-681 contract-call URI for settling an invoice via TUSD8PayGuard.fundInvoice.
 */
export function buildPayGuardFundUri({
  payGuardAddress,
  invoiceId,
  expectedPayee,
  expectedLabelHash = ethers.ZeroHash,
  chainId = AEVUM.chainId,
}) {
  const target = ethers.getAddress(payGuardAddress);
  const payee = ethers.getAddress(expectedPayee);
  return `ethereum:${target}@${chainId}/fundInvoice?uint256=${BigInt(invoiceId)}&address=${payee}&bytes32=${expectedLabelHash}`;
}

/**
 * Strict ERC-681 validator: rejects wrong chain ID or spoofed token addresses.
 */
export function parseAndValidateErc681TransferUri(uri) {
  const m = /^ethereum:(0x[a-fA-F0-9]{40})@(\d+)\/transfer\?(.+)$/.exec(String(uri).trim());
  if (!m) {
    throw new Error("Malformed ERC-681 tUSD8 transfer URI (missing @chainId or /transfer)");
  }
  const tokenAddress = ethers.getAddress(m[1]);
  const chainId = Number(m[2]);
  if (chainId !== AEVUM.chainId) {
    throw new Error(`Wrong chain ID ${chainId}: expected QDay Aevum Testnet (${AEVUM.chainId})`);
  }
  if (tokenAddress.toLowerCase() !== AEVUM.tusd8Address.toLowerCase()) {
    throw new Error(`Untrusted token ${tokenAddress}: expected official tUSD8 (${AEVUM.tusd8Address})`);
  }
  const params = new URLSearchParams(m[3]);
  const recipient = ethers.getAddress(params.get("address") || "");
  const uintStr = params.get("uint256") || "";
  if (!/^\d+$/.test(uintStr) || BigInt(uintStr) <= 0n) {
    throw new Error("Invalid uint256 base-unit amount in ERC-681 URI");
  }
  return {
    tokenAddress,
    chainId,
    recipient,
    amountUnits: BigInt(uintStr),
    amountFormatted: formatTUSD8(BigInt(uintStr)),
  };
}
