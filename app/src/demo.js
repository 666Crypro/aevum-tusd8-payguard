import { AEVUM } from "./config.js";
import { AevumSandbox } from "./forkEngine.js";
import { computeLabelHash } from "./erc681.js";

async function main() {
  const port = Number(process.env.DEMO_ANVIL_PORT || 8547);
  const sandbox = new AevumSandbox({ port });

  console.log("== 1. Fork QDay Aevum Testnet (Chain ID 44005) ==");
  await sandbox.start();
  const snap0 = await sandbox.getSnapshot();
  console.log(`Forked ${AEVUM.rpcUrl} at block #${snap0.forkBlock} (chainId=${snap0.chainId})`);
  console.log(`Pinned tUSD8: ${snap0.tusd8Address} (${snap0.tusd8Decimals} decimals)`);
  console.log(`PayeeRegistry: ${snap0.payeeRegistryAddress}`);
  console.log(`TUSD8PayGuard: ${snap0.payGuardAddress}`);
  console.log(`Treasury funded from fork tUSD8Faucet: ${snap0.balances.treasury} tUSD8`);

  console.log("\n== 2. Confirmation-of-Payee & ERC-681 Invoice Creation ==");
  const inv1 = await sandbox.createAndOptionalFund({
    label: "Aevum Cloud Node #1",
    amountStr: "40.00",
    mode: "Escrow",
    ref: "INV-2026-0042",
    autoFund: true,
  });
  console.log(`Invoice #${inv1.invoiceId} created (${inv1.createTxHash.slice(0, 14)}...) & funded (${inv1.fundTxHash.slice(0, 14)}...)`);
  console.log(`ERC-681 URI: ${inv1.erc681Transfer}`);

  console.log("\n== 3. Confirmation-of-Payee Wrong-Label Protection ==");
  try {
    const invBad = await sandbox.createAndOptionalFund({
      label: "Aevum Cloud Node #1",
      amountStr: "10.00",
      mode: "Instant",
      ref: "INV-BAD-COP",
      autoFund: false,
    });
    await sandbox.payGuard
      .connect(sandbox.wallets.treasury)
      .fundInvoice(invBad.invoiceId, sandbox.wallets.merchant.address, computeLabelHash("Lookalike Spoof Co"));
    throw new Error("Expected CoP revert");
  } catch (err) {
    console.log(`REVERTED as expected: ${sandbox.decodeCustomError(err)}`);
  }

  console.log("\n== 4. Milestone Escrow Release (15.00 + 25.00 tUSD8) ==");
  const r1 = await sandbox.releaseEscrow(inv1.invoiceId, "15.00");
  console.log(`Milestone 1 released (15.00 tUSD8): tx ${r1.txHash.slice(0, 14)}...`);
  const r2 = await sandbox.releaseEscrow(inv1.invoiceId, "25.00");
  console.log(`Milestone 2 released (25.00 tUSD8): tx ${r2.txHash.slice(0, 14)}...`);

  console.log("\n== 5. Scoped AI Agent Session Key & Security Guardrails ==");
  const g1 = await sandbox.grantSession({ maxPerTx: "20", dailyCap: "30", durationHours: 24, requireVerifiedPayee: true });
  console.log(`Granted session key (maxPerTx=20, dailyCap=30 tUSD8): tx ${g1.txHash.slice(0, 14)}...`);

  const okPay = await sandbox.runAgentPayment({ amountStr: "18.50", target: "merchant", reason: "GPU node renewal" });
  console.log(`Agent payment 18.50 tUSD8 -> ${okPay.ok ? "SETTLED tx " + okPay.txHash.slice(0, 14) + "..." : okPay.error}`);

  const injPay = await sandbox.runAgentPayment({ amountStr: "5.00", target: "attacker", expectedLabel: "", reason: "Prompt-injected transfer" });
  console.log(`Prompt-injected unverified payee (5.00 tUSD8) -> REFUSED: ${injPay.error}`);

  const capPay = await sandbox.runAgentPayment({ amountStr: "25.00", target: "merchant", reason: "Over per-tx cap" });
  console.log(`Over per-tx cap (25.00 tUSD8 > 20.00) -> REFUSED: ${capPay.error}`);

  const rev = await sandbox.revokeSession();
  console.log(`Session revoked in 1 tx (${rev.txHash.slice(0, 14)}...)`);
  const postRev = await sandbox.runAgentPayment({ amountStr: "5.00", target: "merchant", reason: "After revocation" });
  console.log(`Post-revocation attempt -> REFUSED: ${postRev.error}`);

  console.log("\n== 6. Honest tUSD8 Chain Watcher (Zero-Value Transfer Immunity) ==");
  const zeroProbe = await sandbox.sendZeroTransferProbe();
  console.log(`0 tUSD8 Transfer tx ${zeroProbe.txHash.slice(0, 14)}... -> skippedZero=${zeroProbe.skippedZero} (total skipped=${zeroProbe.totalSkippedZero})`);

  const finalSnap = await sandbox.getSnapshot();
  console.log("\n== Demo Summary ==");
  console.log(`Balances -> Treasury: ${finalSnap.balances.treasury} tUSD8 | Merchant: ${finalSnap.balances.merchant} tUSD8 | Escrow: ${finalSnap.balances.escrowGuard} tUSD8`);
  console.log(`Watcher -> Verified tUSD8 transfers: ${finalSnap.watcher.verifiedTransfers.length} | Zero-value skipped: ${finalSnap.watcher.skippedZeroTransfers}`);
  console.log("Demo complete.");

  await sandbox.stop();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
