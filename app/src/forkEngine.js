import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { AEVUM, ERC20_MIN_ABI, ROOT_DIR, loadContractArtifact } from "./config.js";
import {
  buildErc681TransferUri,
  buildPayGuardFundUri,
  canonicalReasonHash,
  computeLabelHash,
  formatTUSD8,
  parseTUSD8,
} from "./erc681.js";
import { HonestChainWatcher } from "./watcher.js";

const ANVIL_BIN = process.env.ANVIL_BIN || `${process.env.HOME}/.foundry/bin/anvil`;

// Generate clean ephemeral fork-only wallets per sandbox run (zero nonce collision with public testnet)

export class AevumSandbox {
  constructor({ port = 8546 } = {}) {
    this.port = port;
    this.anvilProc = null;
    this.provider = null;
    this.wallets = {};
    this.tusd8 = null;
    this.registry = null;
    this.payGuard = null;
    this.watcher = null;
    this.forkBlock = 0;
    this.ready = false;
  }

  async start() {
    if (this.ready) return;
    const rpcUrl = `http://127.0.0.1:${this.port}`;

    this.anvilProc = spawn(
      ANVIL_BIN,
      ["--fork-url", AEVUM.rpcUrl, "--chain-id", String(AEVUM.chainId), "--port", String(this.port), "--silent"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    await waitForRpc(rpcUrl);
    this.provider = new ethers.JsonRpcProvider(rpcUrl, AEVUM.chainId, { staticNetwork: true, cacheTimeout: -1 });
    this.forkBlock = await this.provider.getBlockNumber();

    const [owner, merchant, treasury, agent, attacker] = Array.from({ length: 5 }, () =>
      ethers.Wallet.createRandom().connect(this.provider)
    );
    for (const w of [owner, merchant, treasury, agent, attacker]) {
      await this.provider.send("anvil_setBalance", [w.address, "0x56BC75E2D63100000"]); // 100 tQDAY on fork
    }
    this.wallets = { owner, merchant, treasury, agent, attacker };

    const regArt = loadContractArtifact("PayeeRegistry");
    const guardArt = loadContractArtifact("TUSD8PayGuard");

    this.watcher = new HonestChainWatcher({
      provider: this.provider,
      tusd8Address: AEVUM.tusd8Address,
      registryAbi: regArt.abi,
      payGuardAbi: guardArt.abi,
    });

    // Fund treasury & attacker on fork from real Aevum tUSD8Faucet
    await this.provider.send("anvil_impersonateAccount", [AEVUM.tusd8FaucetAddress]);
    await this.provider.send("anvil_setBalance", [AEVUM.tusd8FaucetAddress, "0x56BC75E2D63100000"]);
    const faucetSigner = await this.provider.getSigner(AEVUM.tusd8FaucetAddress);
    const tusd8AsFaucet = new ethers.Contract(AEVUM.tusd8Address, ERC20_MIN_ABI, faucetSigner);
    const txFund = await tusd8AsFaucet.transfer(treasury.address, 200_000_000n); // 200 tUSD8
    const rcFund = await txFund.wait();
    this.watcher.inspectReceipt(rcFund);
    await this.provider.send("anvil_stopImpersonatingAccount", [AEVUM.tusd8FaucetAddress]);

    this.tusd8 = new ethers.Contract(AEVUM.tusd8Address, ERC20_MIN_ABI, owner);

    // Deploy PayeeRegistry & TUSD8PayGuard
    const regFactory = new ethers.ContractFactory(regArt.abi, regArt.bytecode, owner);
    this.registry = await regFactory.deploy(owner.address);
    await this.registry.waitForDeployment();

    const guardFactory = new ethers.ContractFactory(guardArt.abi, guardArt.bytecode, owner);
    this.payGuard = await guardFactory.deploy(
      AEVUM.tusd8Address,
      await this.registry.getAddress(),
      owner.address,
      owner.address,
      owner.address,
      0
    );
    await this.payGuard.waitForDeployment();

    // Treasury approves TUSD8PayGuard
    const txApp = await this.tusd8.connect(treasury).approve(await this.payGuard.getAddress(), ethers.MaxUint256);
    await txApp.wait();

    // Register & attest default merchant
    const regTx = await this.registry
      .connect(merchant)
      .registerPayee("Aevum Cloud Node #1", 0, "https://aevum-node.example.invalid/profile.json");
    this.watcher.inspectReceipt(await regTx.wait(), await this.addrOpts());
    const attTx = await this.registry.connect(owner).setAttested(merchant.address, true);
    this.watcher.inspectReceipt(await attTx.wait(), await this.addrOpts());

    this.ready = true;
  }

  async addrOpts() {
    return {
      payGuardAddress: await this.payGuard.getAddress(),
      registryAddress: await this.registry.getAddress(),
    };
  }

  async stop() {
    if (this.anvilProc) {
      this.anvilProc.kill("SIGTERM");
      this.anvilProc = null;
    }
    this.ready = false;
  }

  async getSnapshot() {
    const regAddr = await this.registry.getAddress();
    const guardAddr = await this.payGuard.getAddress();
    const blockNumber = await this.provider.getBlockNumber();
    const [balTreasury, balMerchant, balGuard, balAttacker] = await Promise.all([
      this.tusd8.balanceOf(this.wallets.treasury.address),
      this.tusd8.balanceOf(this.wallets.merchant.address),
      this.tusd8.balanceOf(guardAddr),
      this.tusd8.balanceOf(this.wallets.attacker.address),
    ]);

    const nextId = Number(await this.payGuard.nextInvoiceId());
    const invoices = [];
    for (let id = Math.max(1, nextId - 12); id < nextId; id++) {
      const inv = await this.payGuard.getInvoice(id);
      invoices.push({
        id: Number(inv.id),
        creator: inv.creator,
        payer: inv.payer,
        payee: inv.payee,
        agent: inv.agent,
        totalAmount: formatTUSD8(inv.totalAmount),
        totalUnits: inv.totalAmount.toString(),
        releasedAmount: formatTUSD8(inv.releasedAmount),
        releasedUnits: inv.releasedAmount.toString(),
        mode: ["Instant", "Escrow"][Number(inv.mode)],
        status: ["None", "Open", "Funded", "Disputed", "Settled", "Refunded", "Cancelled"][Number(inv.status)],
        deadline: Number(inv.deadline),
        expectedLabelHash: inv.expectedLabelHash,
        externalRef: inv.externalRef,
        reasonHash: inv.reasonHash,
      });
    }

    const sess = await this.payGuard.getSession(this.wallets.treasury.address, this.wallets.agent.address);
    const remainingDaily = await this.payGuard.remainingDailyAllowance(
      this.wallets.treasury.address,
      this.wallets.agent.address
    );
    const merchantProfile = await this.registry.getPayee(this.wallets.merchant.address);

    return {
      mode: "Aevum Testnet Fork (Chain ID 44005)",
      chainId: AEVUM.chainId,
      forkBlock: this.forkBlock,
      currentBlock: blockNumber,
      tusd8Address: AEVUM.tusd8Address,
      tusd8Decimals: AEVUM.tusd8Decimals,
      payeeRegistryAddress: regAddr,
      payGuardAddress: guardAddr,
      accounts: {
        owner: this.wallets.owner.address,
        merchant: this.wallets.merchant.address,
        treasury: this.wallets.treasury.address,
        agent: this.wallets.agent.address,
        attacker: this.wallets.attacker.address,
      },
      balances: {
        treasury: formatTUSD8(balTreasury),
        merchant: formatTUSD8(balMerchant),
        escrowGuard: formatTUSD8(balGuard),
        attacker: formatTUSD8(balAttacker),
      },
      merchantProfile: {
        label: merchantProfile.label,
        labelHash: merchantProfile.labelHash,
        active: merchantProfile.active,
        attested: merchantProfile.attested,
      },
      session: {
        active: sess.active,
        revoked: sess.revoked,
        requireVerifiedPayee: sess.requireVerifiedPayee,
        maxPerTx: formatTUSD8(sess.maxPerTx),
        dailyCap: formatTUSD8(sess.dailyCap),
        spentToday: formatTUSD8(sess.spentToday),
        totalSpent: formatTUSD8(sess.totalSpent),
        remainingDaily: formatTUSD8(remainingDaily),
        expiresAt: Number(sess.expiresAt),
        allowedPayee: sess.allowedPayee,
      },
      invoices: invoices.reverse(),
      watcher: {
        skippedZeroTransfers: this.watcher.skippedZeroTransfers,
        skippedForeignTokens: this.watcher.skippedForeignTokens,
        verifiedTransfers: this.watcher.verifiedTransfers.slice(0, 20),
        guardEvents: this.watcher.guardEvents.slice(0, 25),
      },
    };
  }

  async createAndOptionalFund({ label = "Aevum Cloud Node #1", amountStr, mode = "Escrow", ref = "INV-001", autoFund = true }) {
    const units = parseTUSD8(amountStr);
    const labelHash = computeLabelHash(label);
    const modeIdx = mode === "Instant" ? 0 : 1;
    const latestBlock = await this.provider.getBlock("latest");
    const deadline = modeIdx === 1 ? Number(latestBlock.timestamp) + 86400 * 3 : 0;
    const extRef = ethers.keccak256(ethers.toUtf8Bytes(ref));
    const memoHash = ethers.keccak256(ethers.toUtf8Bytes(`${ref}:${amountStr} tUSD8`));

    const txCreate = await this.payGuard
      .connect(this.wallets.merchant)
      .createInvoice(this.wallets.merchant.address, units, modeIdx, deadline, labelHash, extRef, memoHash, true);
    const rcCreate = await txCreate.wait();
    this.watcher.inspectReceipt(rcCreate, await this.addrOpts());

    const createdLog = rcCreate.logs
      .map((l) => {
        try { return this.payGuard.interface.parseLog(l); } catch { return null; }
      })
      .find((x) => x && x.name === "InvoiceCreated");
    const invoiceId = Number(createdLog.args.invoiceId);

    let fundTxHash = null;
    if (autoFund) {
      const txFund = await this.payGuard
        .connect(this.wallets.treasury)
        .fundInvoice(invoiceId, this.wallets.merchant.address, labelHash);
      const rcFund = await txFund.wait();
      fundTxHash = rcFund.hash;
      this.watcher.inspectReceipt(rcFund, await this.addrOpts());
    }

    const erc681Transfer = buildErc681TransferUri({
      recipient: this.wallets.merchant.address,
      amountUnits: units,
    });
    const erc681PayGuard = buildPayGuardFundUri({
      payGuardAddress: await this.payGuard.getAddress(),
      invoiceId,
      expectedPayee: this.wallets.merchant.address,
      expectedLabelHash: labelHash,
    });

    return {
      invoiceId,
      createTxHash: rcCreate.hash,
      fundTxHash,
      erc681Transfer,
      erc681PayGuard,
      amountUnits: units.toString(),
    };
  }

  async releaseEscrow(invoiceId, amountStr) {
    const units = parseTUSD8(amountStr);
    const tx = await this.payGuard.connect(this.wallets.treasury).releaseEscrow(invoiceId, units);
    const rc = await tx.wait();
    this.watcher.inspectReceipt(rc, await this.addrOpts());
    return { txHash: rc.hash };
  }

  async grantSession({ maxPerTx = "20", dailyCap = "35", durationHours = 24, requireVerifiedPayee = true }) {
    const latest = await this.provider.getBlock("latest");
    const exp = Number(latest.timestamp) + Number(durationHours) * 3600;
    const tx = await this.payGuard
      .connect(this.wallets.treasury)
      .grantSession(
        this.wallets.agent.address,
        parseTUSD8(maxPerTx),
        parseTUSD8(dailyCap),
        exp,
        Boolean(requireVerifiedPayee),
        ethers.ZeroAddress
      );
    const rc = await tx.wait();
    this.watcher.inspectReceipt(rc, await this.addrOpts());
    return { txHash: rc.hash, expiresAt: exp };
  }

  async revokeSession() {
    const tx = await this.payGuard.connect(this.wallets.treasury).revokeSession(this.wallets.agent.address);
    const rc = await tx.wait();
    this.watcher.inspectReceipt(rc, await this.addrOpts());
    return { txHash: rc.hash };
  }

  async runAgentPayment({ amountStr, target = "merchant", expectedLabel = "Aevum Cloud Node #1", reason = "Auto-renew API node" }) {
    const payee = target === "attacker" ? this.wallets.attacker.address : this.wallets.merchant.address;
    const cop = expectedLabel ? computeLabelHash(expectedLabel) : ethers.ZeroHash;
    const units = parseTUSD8(amountStr);
    const reasonHash = canonicalReasonHash({
      action: "payWithSession",
      payee,
      amountUnits: units.toString(),
      reason,
    });
    const extRef = ethers.keccak256(ethers.toUtf8Bytes(`AGENT-${Date.now()}`));
    const memoHash = ethers.keccak256(ethers.toUtf8Bytes(reason));

    try {
      const tx = await this.payGuard
        .connect(this.wallets.agent)
        .payWithSession(this.wallets.treasury.address, payee, cop, units, extRef, memoHash, reasonHash);
      const rc = await tx.wait();
      this.watcher.inspectReceipt(rc, await this.addrOpts());
      return { ok: true, txHash: rc.hash, reasonHash };
    } catch (err) {
      const decoded = this.decodeCustomError(err);
      return { ok: false, error: decoded };
    }
  }

  async sendZeroTransferProbe() {
    const tx = await this.tusd8.connect(this.wallets.treasury).transfer(this.wallets.merchant.address, 0n);
    const rc = await tx.wait();
    const res = this.watcher.inspectReceipt(rc, await this.addrOpts());
    return { txHash: rc.hash, skippedZero: res.skippedZero, totalSkippedZero: this.watcher.skippedZeroTransfers };
  }

  decodeCustomError(err) {
    const data = err?.data || err?.info?.error?.data || err?.error?.data;
    if (data && typeof data === "string" && data.startsWith("0x")) {
      try {
        const parsed = this.payGuard.interface.parseError(data);
        if (parsed) return `${parsed.name}() — blocked by TUSD8PayGuard on-chain policy`;
      } catch {
        // ignore
      }
    }
    return err?.shortMessage || err?.message || "Transaction reverted";
  }

  writeForkDeployment(extra = {}) {
    const outPath = path.join(ROOT_DIR, "deployments", "fork-44005.json");
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          mode: "anvil-fork-aevum-44005",
          chainId: AEVUM.chainId,
          forkBlock: this.forkBlock,
          tusd8: AEVUM.tusd8Address,
          ...extra,
        },
        null,
        2
      )
    );
  }
}

async function waitForRpc(url, timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      });
      if (res.ok) return;
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for Anvil RPC at ${url}`);
}
