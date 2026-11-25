import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { AEVUM } from "./config.js";
import { AevumSandbox } from "./forkEngine.js";
import { buildErc681TransferUri, parseTUSD8 } from "./erc681.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const PORT = Number(process.env.PORT || 8788);
const ANVIL_PORT = Number(process.env.SANDBOX_ANVIL_PORT || 8548);

const sandbox = new AevumSandbox({ port: ANVIL_PORT });

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const txt = Buffer.concat(chunks).toString("utf8").trim();
  return txt ? JSON.parse(txt) : {};
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

    if (req.method === "GET" && url.pathname === "/api/health") {
      return sendJson(res, 200, { ok: true, chainId: AEVUM.chainId, tusd8: AEVUM.tusd8Address, ready: sandbox.ready });
    }

    if (req.method === "GET" && url.pathname === "/api/state") {
      await sandbox.start();
      const snap = await sandbox.getSnapshot();
      return sendJson(res, 200, snap);
    }

    if (req.method === "POST" && url.pathname === "/api/invoice") {
      await sandbox.start();
      const body = await readBody(req);
      const out = await sandbox.createAndOptionalFund({
        label: body.label || "Aevum Cloud Node #1",
        amountStr: String(body.amount || "25.00"),
        mode: body.mode || "Escrow",
        ref: body.ref || `INV-${Date.now()}`,
        autoFund: body.autoFund !== false,
      });
      const qrSvg = await QRCode.toString(out.erc681Transfer, {
        type: "svg",
        margin: 1,
        width: 190,
        color: { dark: "#0B0F17", light: "#FFFFFF" },
      });
      return sendJson(res, 200, { ...out, qrSvg });
    }

    if (req.method === "GET" && url.pathname === "/api/qr") {
      await sandbox.start();
      const amount = url.searchParams.get("amount") || "25.00";
      const recipient = url.searchParams.get("recipient") || sandbox.wallets.merchant.address;
      const units = parseTUSD8(amount);
      const uri = buildErc681TransferUri({ recipient, amountUnits: units });
      const qrSvg = await QRCode.toString(uri, {
        type: "svg",
        margin: 1,
        width: 190,
        color: { dark: "#0B0F17", light: "#FFFFFF" },
      });
      return sendJson(res, 200, { uri, units: units.toString(), qrSvg });
    }

    if (req.method === "POST" && url.pathname === "/api/release") {
      await sandbox.start();
      const body = await readBody(req);
      const out = await sandbox.releaseEscrow(Number(body.invoiceId), String(body.amount));
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && url.pathname === "/api/session/grant") {
      await sandbox.start();
      const body = await readBody(req);
      const out = await sandbox.grantSession({
        maxPerTx: String(body.maxPerTx || "20"),
        dailyCap: String(body.dailyCap || "35"),
        durationHours: Number(body.durationHours || 24),
        requireVerifiedPayee: body.requireVerifiedPayee !== false,
      });
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && url.pathname === "/api/session/revoke") {
      await sandbox.start();
      const out = await sandbox.revokeSession();
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && url.pathname === "/api/agent/pay") {
      await sandbox.start();
      const body = await readBody(req);
      const out = await sandbox.runAgentPayment({
        amountStr: String(body.amount || "15.00"),
        target: body.target || "merchant",
        expectedLabel: body.expectedLabel ?? "Aevum Cloud Node #1",
        reason: body.reason || "Autonomous compute settlement",
      });
      return sendJson(res, 200, out);
    }

    if (req.method === "POST" && url.pathname === "/api/watcher/zero-probe") {
      await sandbox.start();
      const out = await sandbox.sendZeroTransferProbe();
      return sendJson(res, 200, out);
    }

    // Static files
    const safeRel = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = path.join(PUBLIC_DIR, safeRel);
    if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  } catch (err) {
    sendJson(res, 400, { error: err?.message || "Bad request" });
  }
});

async function boot() {
  console.log("Starting Aevum tUSD8 PayGuard Fork Sandbox...");
  await sandbox.start();
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`PayGuard UI + API listening at http://127.0.0.1:${PORT}`);
  });
}

process.on("SIGINT", async () => {
  await sandbox.stop();
  process.exit(0);
});
process.on("SIGTERM", async () => {
  await sandbox.stop();
  process.exit(0);
});

boot().catch((err) => {
  console.error(err);
  process.exit(1);
});
