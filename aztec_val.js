// server.js
// Run: node server.js
// Env (optional):
//   PORT=3000
//   ROLLUP=0x216f071653a82ced3ef9d29f3f0c0ed7829c8f81
//   SEPOLIA_RPCS=https://1rpc.io/sepolia,https://ethereum-sepolia-rpc.publicnode.com

const express = require("express");
const { ethers } = require("ethers");

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

class RpcPool {
  constructor(urls) {
    this.urls = (urls || []).filter(Boolean);
    if (this.urls.length === 0) {
      this.urls = [
        
        "https://1rpc.io/sepolia",
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://sepolia.mztacat.xyz/geth/",
      ];
    }
    this.index = 0;
    this.provider = new ethers.JsonRpcProvider(this.urls[this.index]);
  }
  rotate() {
    this.index = (this.index + 1) % this.urls.length;
    this.provider = new ethers.JsonRpcProvider(this.urls[this.index]);
  }
  async safeCall(req, attempt = 0) {
    try {
      return await this.provider.call(req);
    } catch (e) {
      if (attempt < this.urls.length - 1) {
        this.rotate();
        await sleep(200);
        return this.safeCall(req, attempt + 1);
      }
      throw e;
    }
  }
}


// Cache store: { proverAddress: { data, timestamp } }
const cache = {};
const CACHE_TTL = 15 * 1000; // 15 s
const sel = (fn) => ethers.id(fn).substring(0, 10);

class ProverClient {
  constructor({ rpcPool, rollup }) {
    this.rpc = rpcPool;
    this.rollup = ethers.getAddress(rollup); // checksum
  }

  async getCurrentEpoch() {
    const hex = await this.rpc.safeCall({ to: this.rollup, data: sel("getCurrentEpoch()") });
    return Number(BigInt(hex));
  }

  async getRewardForEpoch(epoch, prover) {
    const data =
      sel("getSpecificProverRewardsForEpoch(uint256,address)") +
      ethers.zeroPadValue(ethers.toBeHex(epoch), 32).substring(2) +
      ethers.zeroPadValue(prover, 32).substring(2);
    const hex = await this.rpc.safeCall({ to: this.rollup, data });
    return BigInt(hex || "0x0");
  }

  async getSharesFor(prover) {
    const data = sel("getSharesFor(address)") + ethers.zeroPadValue(prover, 32).substring(2);
    const hex = await this.rpc.safeCall({ to: this.rollup, data });
    return BigInt(hex || "0x0");
  }

  /**
   * Brute-force a window of epochs backwards from current to (current - lookback).
   * Returns participation count, last epoch with non-zero reward, and total rewards in window.
   */
  async scanParticipation(prover, lookback, delayMs = 120) {
    const currentEpoch = await this.getCurrentEpoch();
    const start = Math.max(0, currentEpoch - lookback);
    let totalRewards = 0n;
    let participatedCount = 0;
    let lastEpochParticipated = null;

    for (let e = currentEpoch; e >= start; e--) {
      const r = await this.getRewardForEpoch(e, prover);
      if (r > 0n) {
        participatedCount++;
        totalRewards += r;
        if (lastEpochParticipated === null) lastEpochParticipated = e;
      }
      if (delayMs) await sleep(delayMs);
    }

    const isActiveNow = currentEpoch - lastEpochParticipated < 6;

    return {
      prover: ethers.getAddress(prover),
      currentEpoch,
      lastEpochParticipated,
      participatedCountWindow: participatedCount,
      totalRewardsWindow: totalRewards,
      isActiveNow,
      window: lookback,
       fetchedAt: new Date().toISOString()
    };
  }
}

function formatProverMessage(stats, { epochHours = 5, shares = null } = {}) {
  const {
    prover,
    currentEpoch,
    lastEpochParticipated,
    participatedCountWindow,
    totalRewardsWindow,
    isActiveNow,
    window,
  } = stats;

  const idleEpochs = lastEpochParticipated == null ? null : (currentEpoch - lastEpochParticipated);
  const idleHours = idleEpochs == null ? "N/A" : (idleEpochs * epochHours);

  const lines = [];
  lines.push("🔷 PROVER NODE DETAILS 🔷");
  lines.push("");
  lines.push(`${isActiveNow ? "🟢" : "🔴"} Status: ${isActiveNow ? "Actively proving" : "Idle"}`);
  lines.push("");
  lines.push("📋 BASIC INFO");
  lines.push(`🔑 Prover: ${prover}`);
  lines.push(`🔢 Current Epoch: ${currentEpoch}`);
  lines.push(`🔢 Last Epoch Participated: ${lastEpochParticipated ?? "—"}`);
  lines.push(`🪪 Look-back Window: last ${window} epochs`);
  if (shares !== null) lines.push(`🧩 Current Shares: ${shares.toString()}`);
  lines.push("");
  lines.push("📊 PARTICIPATION");
  lines.push(`✅ Epochs Participated : ${participatedCountWindow}`);
  lines.push(`💰 Rewards (window): ${totalRewardsWindow.toString()}`);
  lines.push(`⏱️ Time Since Last Proof: ${idleEpochs == null ? "N/A" : `${idleHours}h (~${idleEpochs} epoch${idleEpochs===1?"":"s"})`}`);
  return lines.join("\n");
}

// --------------------- Server ---------------------
const app = express();
const PORT = process.env.PORT || 3000;

const rpcUrls = (process.env.SEPOLIA_RPCS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const rollup = process.env.ROLLUP || "0x216f071653a82ced3ef9d29f3f0c0ed7829c8f81";

const rpcPool = new RpcPool(rpcUrls);
const client = new ProverClient({ rpcPool, rollup });

app.get("/health", (_req, res) => {
  res.json({ ok: true, rpcCount: rpcPool.urls.length, rollup });
});


// Check cache
  if (
    cache[prover] &&
    Date.now() - cache[prover].timestamp < CACHE_TTL
  ) {
    console.log(`Serving from cache: ${prover}`);
    return res.json(cache[prover].data);
  }


   try {
    console.log(`Fetching from Geth: ${prover}`);
    const data = await getProverStatus(prover);

    // Save to cache
    cache[prover] = {
      data,
      timestamp: Date.now()
    };

    res.json(data);
  } catch (err) {
    console.error("Error:", err.message);
    res.status(500).json({ error: err.message });
  }


app.get("/scan", async (req, res) => {
  try {
    const prover = req.query.prover;
    if (!prover) return res.status(400).json({ error: "Missing ?prover=0x..." });

    const lookback = Number(req.query.lookback || 600);
    const delayMs  = Number(req.query.delayMs  || 120);
    const epochHours = Number(req.query.epochHours || 5);

    const stats = await client.scanParticipation(prover, lookback, delayMs);

    // Try shares (non-fatal)
    let shares = null;
    try { shares = await client.getSharesFor(prover); } catch {}

    const payload = { ...stats, shares: shares ? shares.toString() : null };

    // Log to console, as requested
    console.log("==== PROVER SCAN (JSON) ====");
    console.log(payload);
    console.log("==== PROVER SCAN (TEXT) ====");
    console.log(formatProverMessage(stats, { epochHours, shares }));

    res.json(payload);
  } catch (e) {
    console.error("SCAN ERROR:", e);
    res.status(500).json({ error: e?.message || String(e) });
  }
});

app.get("/scan-text", async (req, res) => {
  try {
    const prover = req.query.prover;
    if (!prover) return res.status(400).send("Missing ?prover=0x...");

    const lookback = Number(req.query.lookback || 600);
    const delayMs  = Number(req.query.delayMs  || 120);
    const epochHours = Number(req.query.epochHours || 5);

    const stats = await client.scanParticipation(prover, lookback, delayMs);

    let shares = null;
    try { shares = await client.getSharesFor(prover); } catch {}

    const text = formatProverMessage(stats, { epochHours, shares });
    console.log("==== PROVER SCAN (TEXT) ====\n" + text);
    res.type("text/plain").send(text);
  } catch (e) {
    console.error("SCAN-TEXT ERROR:", e);
    res.status(500).send(e?.message || String(e));
  }
});

app.listen(PORT, () => {
  console.log(`Prover stats server listening on http://localhost:${PORT}`);
  console.log(`Rollup: ${rollup}`);
  console.log(`RPCs: ${rpcPool.urls.join(", ")}`);
});
