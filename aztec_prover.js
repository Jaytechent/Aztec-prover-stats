const express = require("express");
const { ethers } = require("ethers");
const NodeCache = require("node-cache");
const axios = require("axios");

// Config
const CACHE_TTL = 60; // 1 minute cache
const RPC_TIMEOUT = 15000; // 15 seconds per RPC call
const BATCH_SIZE = 50; // Process epochs in batches
const EPOCH_DELAY = 50; // ms between batches
const WATCHLIST_CHECK_INTERVAL = 60 * 60 * 1000; // 1 hour

// Improved cache
const cache = new NodeCache({ 
  stdTTL: CACHE_TTL,
  checkperiod: 30,
  useClones: false
});

// Watchlist store
const watchlist = new Map();

// Helper functions
function sleep(ms) { 
  return new Promise(r => setTimeout(r, ms)); 
}

function sel(fn) { 
  return ethers.id(fn).substring(0, 10); 
}

class OptimizedRpcPool {
  constructor(urls) {
    this.urls = urls?.length ? urls : [
      "https://1rpc.io/sepolia",
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://sepolia.mztacat.xyz/geth/"
    ];
    this.currentIndex = 0;
    this.provider = this.createProvider();
  }

  createProvider() {
    return new ethers.JsonRpcProvider(this.urls[this.currentIndex], undefined, {
      staticNetwork: ethers.Network.from("sepolia"),
      timeout: RPC_TIMEOUT
    });
  }

  async rotate() {
    this.currentIndex = (this.currentIndex + 1) % this.urls.length;
    this.provider = this.createProvider();
    await this.provider.ready;
  }

  async callWithRetry(req, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await Promise.race([
          this.provider.call(req),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error("RPC timeout")), RPC_TIMEOUT)
          )
        ]);
      } catch (err) {
        if (i < retries - 1) {
          await this.rotate();
          await sleep(1000);
          continue;
        }
        throw err;
      }
    }
  }
}

class OptimizedProverClient {
  constructor(rpcPool, rollup) {
    this.rpc = rpcPool;
    this.rollup = ethers.getAddress(rollup);
    this.selector = {
      currentEpoch: sel("getCurrentEpoch()"),
      rewards: sel("getSpecificProverRewardsForEpoch(uint256,address)"),
      shares: sel("getSharesFor(address)")
    };
  }

  async getCurrentEpoch() {
    const hex = await this.rpc.callWithRetry({
      to: this.rollup, 
      data: this.selector.currentEpoch
    });
    return Number(BigInt(hex));
  }

  async getBatchRewards(epochs, prover) {
    const batches = [];
    for (let i = 0; i < epochs.length; i += BATCH_SIZE) {
      batches.push(epochs.slice(i, i + BATCH_SIZE));
      if (i + BATCH_SIZE < epochs.length) await sleep(EPOCH_DELAY);
    }

    const results = [];
    for (const batch of batches) {
      const calls = batch.map(e => ({
        to: this.rollup,
        data: this.selector.rewards + 
          ethers.zeroPadValue(ethers.toBeHex(e), 32).substring(2) +
          ethers.zeroPadValue(prover, 32).substring(2)
      }));

      const batchResults = await Promise.all(
        calls.map(call => this.rpc.callWithRetry(call).catch(() => "0x0"))
      );
      results.push(...batchResults.map(r => BigInt(r || "0x0")));
    }
    return results;
  }

  async scanParticipation(prover, lookback) {
    const cacheKey = `scan-${prover}-${lookback}`;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const startTime = Date.now();
    const currentEpoch = await this.getCurrentEpoch();
    const epochs = Array.from(
      { length: Math.min(lookback, currentEpoch) },
      (_, i) => currentEpoch - i
    );

    const rewards = await this.getBatchRewards(epochs, prover);
    
    let totalRewards = 0n;
    let participatedCount = 0;
    let lastEpochParticipated = null;

    rewards.forEach((r, i) => {
      if (r > 0n) {
        participatedCount++;
        totalRewards += r;
        lastEpochParticipated ??= epochs[i];
      }
    });

    const result = {
      prover: ethers.getAddress(prover),
      currentEpoch,
      lastEpochParticipated,
      participatedCountWindow: participatedCount,
      totalRewardsWindow: totalRewards,
      isActiveNow: lastEpochParticipated !== null && 
                 (currentEpoch - lastEpochParticipated < 6),
      window: lookback,
      fetchTime: Date.now() - startTime
    };

    cache.set(cacheKey, result);
    return result;
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
  lines.push("🔷 PROVER NODE DETAILS ADVERSARIA TESTNET🔷");
  lines.push("");
  lines.push(`${isActiveNow ? "🟢" : "🔴"} Status: ${isActiveNow ? "Actively proving" : "Idle"}`);
  lines.push("");
  lines.push("📋 PROVER DETAILS");
  lines.push(`🔑 Prover: \`${prover}\``);
  lines.push(`🔢 Current Epoch: ${currentEpoch}`);
  lines.push(`🔢 Last Epoch Participated: ${lastEpochParticipated ?? "—"}`);
  lines.push(`🪪 Look-back Window: last ${window} epochs`);
  if (shares !== null) lines.push(`🧩 Current Shares: ${shares.toString()}`);
  lines.push("");
  lines.push("📊 PARTICIPATION");
  lines.push(`✅ Epochs Participated: ${participatedCountWindow}`);
  lines.push(`💰 Rewards : ${ethers.formatEther(totalRewardsWindow)} ETH`);
  lines.push(`⏱️ Time Since Last Proof: ${idleEpochs == null ? "N/A" : `${idleHours}h (~${idleEpochs} epoch${idleEpochs===1?"":"s"})`}`);
  return lines.join("\n");


}


async function checkWatchlist(client) {
  if (watchlist.size === 0) return;

  const currentEpoch = await client.getCurrentEpoch();
  
  for (const [chatId, entry] of watchlist.entries()) {
    try {
      const stats = await client.scanParticipation(entry.prover, 600);
      const idleEpochs = stats.lastEpochParticipated === null ? 
        currentEpoch : 
        (currentEpoch - stats.lastEpochParticipated);
      
      if (idleEpochs >= 6 && entry.lastNotifiedEpoch !== currentEpoch) {
        console.log(`[ALERT] Prover ${entry.prover} is idle for ${idleEpochs} epochs. Chat ID: ${chatId}`);
        watchlist.set(chatId, {
          ...entry,
          lastNotifiedEpoch: currentEpoch
        });
      }
    } catch (err) {
      console.error(`Watchlist error for ${entry.prover}:`, err.message);
    }
    await sleep(1000);
  }
}

// Initialize server
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const rpcUrls = (process.env.SEPOLIA_RPCS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const rollup = process.env.ROLLUP || "0x216f071653a82ced3ef9d29f3f0c0ed7829c8f81";

const rpcPool = new OptimizedRpcPool(rpcUrls);
const client = new OptimizedProverClient(rpcPool, rollup);

// API Endpoints
app.get("/health", (_req, res) => {
  res.json({ 
    ok: true, 
    rpcCount: rpcPool.urls.length, 
    rollup,
    cacheStats: cache.getStats(),
    watchlistSize: watchlist.size
  });
});

app.get("/scan", async (req, res) => {
  try {
    const { prover, lookback = 600 } = req.query;
    if (!prover) return res.status(400).json({ error: "Missing prover address" });

    const stats = await client.scanParticipation(prover, Number(lookback));
    const shares = await client.rpc.callWithRetry({
      to: client.rollup,
      data: client.selector.shares + ethers.zeroPadValue(prover, 32).substring(2)
    }).then(r => BigInt(r || "0x0")).catch(() => null);

    res.json({ ...stats, shares: shares?.toString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/scan-text", async (req, res) => {
  try {
    const { prover, lookback = 600, epochHours = 5 } = req.query;
    if (!prover) return res.status(400).send("Missing prover address");

    const cacheKey = `scan-text-${prover}-${lookback}`;
    const cached = cache.get(cacheKey);
    if (cached) return res.type("text/plain").send(cached);

    const stats = await client.scanParticipation(prover, Number(lookback));
    const shares = await client.rpc.callWithRetry({
      to: client.rollup,
      data: client.selector.shares + ethers.zeroPadValue(prover, 32).substring(2)
    }).then(r => BigInt(r || "0x0")).catch(() => null);

    const text = formatProverMessage(stats, { 
      epochHours: Number(epochHours), 
      shares 
    });
    
    cache.set(cacheKey, text);
    res.type("text/plain").send(text);
  } catch (err) {
    res.status(500).send(err.message);
  }
});

// Watchlist Endpoints
app.post("/watchlist/add", (req, res) => {
  try {
    const { chatId, prover } = req.body;
    if (!chatId || !prover) throw new Error("Missing chatId or prover");

    const address = ethers.getAddress(prover);
    watchlist.set(String(chatId), {
      prover: address,
      lastNotifiedEpoch: null
    });
    
    res.json({ success: true, watchlistSize: watchlist.size });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/watchlist/remove", (req, res) => {
  const { chatId } = req.body;
  if (!chatId) return res.status(400).json({ error: "Missing chatId" });

  const existed = watchlist.delete(String(chatId));
  res.json({ success: existed, watchlistSize: watchlist.size });
});

app.get("/watchlist/status", (req, res) => {
  const { chatId } = req.query;
  if (!chatId) return res.status(400).json({ error: "Missing chatId" });

  const entry = watchlist.get(String(chatId));
  res.json({ 
    watching: !!entry,
    prover: entry?.prover,
    lastNotifiedEpoch: entry?.lastNotifiedEpoch 
  });
});

// Start server
setInterval(() => checkWatchlist(client), WATCHLIST_CHECK_INTERVAL);
checkWatchlist(client); // Initial check

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`RPC endpoints: ${rpcPool.urls.join(", ")}`);
  console.log(`Rollup contract: ${rollup}`);
});