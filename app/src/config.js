import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(__dirname, "../..");

export const AEVUM = {
  chainId: 44005,
  chainIdHex: "0xABE5",
  chainName: "QDay Aevum",
  rpcUrl: process.env.AEVUM_RPC_URL || "https://rpc-test.qday.info",
  wsUrl: process.env.AEVUM_WS_URL || "wss://rpc-test.qday.info",
  explorerUrl: process.env.AEVUM_EXPLORER_URL || "https://explorer-test.qday.info",
  nativeCurrency: { name: "Test QDay", symbol: "tQDAY", decimals: 18 },
  tusd8Address: "0x456569838f1d43009A91ebA4263147Afd7233483",
  tusd8Decimals: 6,
  tusd8FaucetAddress: "0x4551B2a3dE4F43e6613E23edf798Ab4FB0211564",
};

export const ERC20_MIN_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function transfer(address to, uint256 value) returns (bool)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

export function loadContractArtifact(name) {
  const artifactPath = path.join(ROOT_DIR, "contracts", "out", `${name}.sol`, `${name}.json`);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(`Missing Foundry artifact at ${artifactPath}. Run 'cd contracts && forge build'.`);
  }
  const raw = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  return { abi: raw.abi, bytecode: raw.bytecode.object };
}

export function loadDeployment(chainId = AEVUM.chainId) {
  const candidates = [
    path.join(ROOT_DIR, "deployments", `${chainId}.json`),
    path.join(ROOT_DIR, "deployments", "fork-44005.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      return { path: p, data: JSON.parse(fs.readFileSync(p, "utf8")) };
    }
  }
  return null;
}
