import { ethers } from "ethers";
import { AEVUM, ERC20_MIN_ABI } from "./config.js";
import { formatTUSD8 } from "./erc681.js";

/**
 * Honest tUSD8 Chain Watcher:
 * 1) Pins official tUSD8 contract address (ignores lookalike ERC-20s claiming symbol "tUSD8").
 * 2) Explicitly drops zero-value Transfer events (prevents zero-transfer invoice spoofing).
 * 3) Decodes TUSD8PayGuard & PayeeRegistry events into a unified audit feed.
 */
export class HonestChainWatcher {
  constructor({ provider, tusd8Address = AEVUM.tusd8Address, registryAbi = [], payGuardAbi = [] }) {
    this.provider = provider;
    this.tusd8Address = ethers.getAddress(tusd8Address);
    this.erc20Iface = new ethers.Interface(ERC20_MIN_ABI);
    this.registryIface = registryAbi.length ? new ethers.Interface(registryAbi) : null;
    this.payGuardIface = payGuardAbi.length ? new ethers.Interface(payGuardAbi) : null;
    this.skippedZeroTransfers = 0;
    this.skippedForeignTokens = 0;
    this.verifiedTransfers = [];
    this.guardEvents = [];
  }

  inspectReceipt(receipt, { payGuardAddress = null, registryAddress = null } = {}) {
    const out = { transfers: [], guardEvents: [], skippedZero: 0, skippedForeign: 0 };
    if (!receipt || !receipt.logs) return out;

    for (const log of receipt.logs) {
      const addr = ethers.getAddress(log.address);

      // Check ERC-20 Transfer signature
      if (log.topics && log.topics[0] === this.erc20Iface.getEvent("Transfer").topicHash) {
        if (addr.toLowerCase() !== this.tusd8Address.toLowerCase()) {
          this.skippedForeignTokens += 1;
          out.skippedForeign += 1;
          continue;
        }
        const parsed = this.erc20Iface.parseLog(log);
        const value = parsed.args.value;
        if (value === 0n) {
          this.skippedZeroTransfers += 1;
          out.skippedZero += 1;
          continue;
        }
        const item = {
          txHash: receipt.hash || log.transactionHash,
          blockNumber: Number(receipt.blockNumber ?? log.blockNumber ?? 0),
          from: parsed.args.from,
          to: parsed.args.to,
          valueUnits: value.toString(),
          valueFormatted: `${formatTUSD8(value)} tUSD8`,
        };
        this.verifiedTransfers.unshift(item);
        out.transfers.push(item);
        continue;
      }

      if (payGuardAddress && this.payGuardIface && addr.toLowerCase() === payGuardAddress.toLowerCase()) {
        try {
          const parsed = this.payGuardIface.parseLog(log);
          const ev = {
            txHash: receipt.hash || log.transactionHash,
            blockNumber: Number(receipt.blockNumber ?? log.blockNumber ?? 0),
            contract: "TUSD8PayGuard",
            name: parsed.name,
            args: sanitizeArgs(parsed.args),
          };
          this.guardEvents.unshift(ev);
          out.guardEvents.push(ev);
        } catch {
          // ignore unknown log
        }
      }

      if (registryAddress && this.registryIface && addr.toLowerCase() === registryAddress.toLowerCase()) {
        try {
          const parsed = this.registryIface.parseLog(log);
          const ev = {
            txHash: receipt.hash || log.transactionHash,
            blockNumber: Number(receipt.blockNumber ?? log.blockNumber ?? 0),
            contract: "PayeeRegistry",
            name: parsed.name,
            args: sanitizeArgs(parsed.args),
          };
          this.guardEvents.unshift(ev);
          out.guardEvents.push(ev);
        } catch {
          // ignore unknown log
        }
      }
    }

    this.verifiedTransfers = this.verifiedTransfers.slice(0, 100);
    this.guardEvents = this.guardEvents.slice(0, 100);
    return out;
  }
}

function sanitizeArgs(resultObj) {
  const out = {};
  for (const [k, v] of Object.entries(resultObj.toObject ? resultObj.toObject() : resultObj)) {
    if (/^\d+$/.test(k)) continue;
    out[k] = typeof v === "bigint" ? v.toString() : v;
  }
  return out;
}
