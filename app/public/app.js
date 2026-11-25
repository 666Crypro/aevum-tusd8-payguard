const AEVUM_CHAIN = {
  chainId: "0xABE5",
  chainName: "QDay Aevum",
  nativeCurrency: { name: "Test QDay", symbol: "tQDAY", decimals: 18 },
  rpcUrls: ["https://rpc-test.qday.info"],
  blockExplorerUrls: ["https://explorer-test.qday.info"],
};

const $ = (id) => document.getElementById(id);

function showBanner(msg, isErr = false) {
  const b = $("status-banner");
  b.textContent = msg;
  b.className = isErr ? "banner error" : "banner";
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function updateUnitsPreview() {
  const val = $("inv-amount").value.trim();
  const m = /^(\d+)(?:\.(\d{1,6}))?$/.exec(val);
  if (!m) {
    $("inv-units-preview").textContent = "Invalid decimal (max 6 decimal places)";
    return;
  }
  const whole = BigInt(m[1]) * 1_000_000n;
  const frac = BigInt((m[2] || "").padEnd(6, "0"));
  $("inv-units-preview").textContent = `${(whole + frac).toLocaleString()} base units (6 decimals)`;
}

async function refreshQr() {
  try {
    const amount = $("inv-amount").value.trim() || "25.00";
    const data = await api(`/api/qr?amount=${encodeURIComponent(amount)}`);
    $("qr-box").innerHTML = data.qrSvg;
    $("erc681-uri").textContent = data.uri;
  } catch (e) {
    $("erc681-uri").textContent = e.message;
  }
}

async function refreshState() {
  const s = await api("/api/state");
  $("net-pill").textContent = `Chain ID ${s.chainId} · Fork Block #${s.currentBlock}`;
  $("bal-treasury").textContent = `${s.balances.treasury} tUSD8`;
  $("bal-merchant").textContent = `${s.balances.merchant} tUSD8`;
  $("bal-escrow").textContent = `${s.balances.escrowGuard} tUSD8`;
  $("watcher-stats").textContent = `${s.watcher.verifiedTransfers.length} valid / ${s.watcher.skippedZeroTransfers} zero-dropped`;
  $("cop-badge").textContent = `CoP: "${s.merchantProfile.label}" (${s.merchantProfile.attested ? "Attested" : "Active"})`;
  $("addr-registry").textContent = s.payeeRegistryAddress;
  $("addr-guard").textContent = s.payGuardAddress;

  // Session box
  const sess = s.session;
  if (sess.active && !sess.revoked) {
    $("session-status-box").innerHTML =
      `<strong>ACTIVE</strong> · maxPerTx: <code>${sess.maxPerTx} tUSD8</code> · dailyCap: <code>${sess.dailyCap} tUSD8</code> · remainingToday: <code>${sess.remainingDaily} tUSD8</code> · CoP Required: <code>${sess.requireVerifiedPayee}</code>`;
  } else if (sess.revoked) {
    $("session-status-box").innerHTML = `<strong style="color:#f87171">REVOKED</strong> — All agent calls blocked on-chain.`;
  } else {
    $("session-status-box").textContent = "No active agent session key granted yet.";
  }

  // Invoices table
  const tbody = $("invoices-tbody");
  tbody.innerHTML = "";
  if (!s.invoices.length) {
    tbody.innerHTML = `<tr><td colspan="7" style="color:#93a3b8">No invoices yet. Create one above to test Escrow or Instant settlement.</td></tr>`;
  }
  for (const inv of s.invoices) {
    const remaining = (BigInt(inv.totalUnits) - BigInt(inv.releasedUnits));
    const remStr = (Number(remaining) / 1e6).toFixed(2);
    const origin = inv.agent !== "0x0000000000000000000000000000000000000000" ? "AI Agent" : "Merchant UI";
    const statusCls = inv.status === "Settled" ? "settled" : inv.status === "Funded" ? "funded" : "";
    const actions =
      inv.status === "Funded"
        ? `<button class="btn btn-primary btn-sm" onclick="releaseInv(${inv.id}, '${remStr}')">Release ${remStr} tUSD8</button>`
        : `<span style="color:#93a3b8">—</span>`;
    tbody.insertAdjacentHTML(
      "beforeend",
      `<tr>
        <td>#${inv.id}</td>
        <td>${inv.mode}</td>
        <td><span class="badge ${statusCls}">${inv.status}</span></td>
        <td>${inv.totalAmount}</td>
        <td>${inv.releasedAmount}</td>
        <td>${origin}</td>
        <td>${actions}</td>
      </tr>`
    );
  }

  // Watcher feeds
  $("transfers-feed").innerHTML = s.watcher.verifiedTransfers
    .map(
      (t) => `<div class="feed-item">
        <strong>${t.valueFormatted}</strong> · Block #${t.blockNumber}<br/>
        <code>${t.from.slice(0, 10)}… → ${t.to.slice(0, 10)}…</code><br/>
        <span class="micro">tx ${t.txHash.slice(0, 18)}…</span>
      </div>`
    )
    .join("");

  $("events-feed").innerHTML = s.watcher.guardEvents
    .map(
      (e) => `<div class="feed-item">
        <strong>${e.contract}.${e.name}</strong> · Block #${e.blockNumber}<br/>
        <span class="micro">${JSON.stringify(e.args).slice(0, 140)}…</span>
      </div>`
    )
    .join("");
}

window.releaseInv = async (invoiceId, amount) => {
  try {
    const out = await api("/api/release", {
      method: "POST",
      body: JSON.stringify({ invoiceId, amount }),
    });
    showBanner(`Escrow released for Invoice #${invoiceId} (${amount} tUSD8) · tx ${out.txHash.slice(0, 16)}…`);
    await refreshState();
  } catch (e) {
    showBanner(e.message, true);
  }
};

// Tabs
document.querySelectorAll(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $(`tab-${btn.dataset.tab}`).classList.add("active");
  });
});

$("inv-amount").addEventListener("input", () => {
  updateUnitsPreview();
  refreshQr();
});
$("btn-gen-qr").addEventListener("click", refreshQr);

$("form-invoice").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const out = await api("/api/invoice", {
      method: "POST",
      body: JSON.stringify({
        label: $("inv-label").value.trim(),
        amount: $("inv-amount").value.trim(),
        mode: $("inv-mode").value,
        ref: $("inv-ref").value.trim(),
        autoFund: true,
      }),
    });
    $("qr-box").innerHTML = out.qrSvg;
    $("erc681-uri").textContent = out.erc681Transfer;
    showBanner(`Invoice #${out.invoiceId} created & funded on Aevum fork · tx ${out.fundTxHash.slice(0, 16)}…`);
    await refreshState();
  } catch (err) {
    showBanner(err.message, true);
  }
});

$("form-session").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const out = await api("/api/session/grant", {
      method: "POST",
      body: JSON.stringify({
        maxPerTx: $("sess-max-tx").value.trim(),
        dailyCap: $("sess-daily").value.trim(),
        durationHours: Number($("sess-hours").value),
        requireVerifiedPayee: true,
      }),
    });
    $("agent-log").textContent = `Session key granted (tx ${out.txHash}).`;
    showBanner("Scoped AI Agent Session Key granted on-chain.");
    await refreshState();
  } catch (err) {
    showBanner(err.message, true);
  }
});

$("btn-revoke-session").addEventListener("click", async () => {
  try {
    const out = await api("/api/session/revoke", { method: "POST", body: "{}" });
    $("agent-log").textContent = `Session REVOKED immediately (tx ${out.txHash}).`;
    showBanner("Agent session key revoked.");
    await refreshState();
  } catch (err) {
    showBanner(err.message, true);
  }
});

async function triggerAgent(payload, label) {
  try {
    const out = await api("/api/agent/pay", { method: "POST", body: JSON.stringify(payload) });
    if (out.ok) {
      $("agent-log").textContent = `[ALLOWED] ${label}\ntxHash: ${out.txHash}\nreasonHash: ${out.reasonHash}`;
      showBanner(`${label} settled on-chain!`);
    } else {
      $("agent-log").textContent = `[BLOCKED ON-CHAIN] ${label}\nRevert: ${out.error}`;
      showBanner(`Safety guard blocked transaction: ${out.error}`, true);
    }
    await refreshState();
  } catch (err) {
    showBanner(err.message, true);
  }
}

$("btn-agent-valid").addEventListener("click", () =>
  triggerAgent({ amount: "15.00", target: "merchant", expectedLabel: "Aevum Cloud Node #1", reason: "Auto-renew node" }, "Valid 15.00 tUSD8 Payment")
);
$("btn-agent-inj").addEventListener("click", () =>
  triggerAgent({ amount: "5.00", target: "attacker", expectedLabel: "", reason: "Prompt-injected target" }, "Prompt Injection Attack")
);
$("btn-agent-cap").addEventListener("click", () =>
  triggerAgent({ amount: "25.00", target: "merchant", expectedLabel: "Aevum Cloud Node #1", reason: "Exceeds maxPerTx" }, "Over-Cap 25.00 tUSD8 Probe")
);

$("btn-zero-probe").addEventListener("click", async () => {
  try {
    const out = await api("/api/watcher/zero-probe", { method: "POST", body: "{}" });
    showBanner(`0 tUSD8 Transfer sent (${out.txHash.slice(0, 14)}…) — Watcher skipped it (total dropped: ${out.totalSkippedZero}).`);
    await refreshState();
  } catch (err) {
    showBanner(err.message, true);
  }
});

$("btn-add-network").addEventListener("click", async () => {
  if (!window.ethereum) return showBanner("No browser wallet detected — running in built-in Aevum Fork Sandbox mode.", true);
  try {
    await window.ethereum.request({ method: "wallet_addEthereumChain", params: [AEVUM_CHAIN] });
    showBanner("QDay Aevum Testnet (44005) added to your wallet!");
  } catch (err) {
    showBanner(err.message, true);
  }
});

$("btn-connect-wallet").addEventListener("click", async () => {
  if (!window.ethereum) return showBanner("No browser wallet detected — built-in Aevum Fork Sandbox is active.", true);
  try {
    const [acct] = await window.ethereum.request({ method: "eth_requestAccounts" });
    $("btn-connect-wallet").textContent = `${acct.slice(0, 6)}…${acct.slice(-4)}`;
    showBanner(`Wallet connected: ${acct}`);
  } catch (err) {
    showBanner(err.message, true);
  }
});

updateUnitsPreview();
refreshQr();
refreshState().catch((e) => showBanner(e.message, true));
