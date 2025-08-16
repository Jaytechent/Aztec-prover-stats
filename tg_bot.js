require('dotenv').config();
const { Telegraf } = require('telegraf');
const { ethers } = require('ethers');
const axios = require('axios');
const express = require("express");
const app = express();

const PORT = process.env.PORT || 3000;


// Config
const {
  BOT_TOKEN,
  SERVER_URL,
  ALERT_IF_IDLE_EPOCHS = "6",
  CHECK_INTERVAL_SEC = "1800",
} = process.env;

if (!BOT_TOKEN) {
  console.error("❌ Missing BOT_TOKEN in .env file");
  process.exit(1);
}

// Helper functions
function normAddr(a) {
  try { 
    return ethers.getAddress(a); 
  } catch { 
    return null; 
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchProverStatus(address) {
  try {
    const response = await axios.get(`${SERVER_URL}/scan-text`, {
      params: { prover: address },
      timeout: 10000
    });
    return response.data;
  } catch (error) {
    console.error("API Error:", error.message);
    throw new Error("Failed to fetch prover status");
  }
}

// Convert to numbers
const THRESH_IDLE = parseInt(ALERT_IF_IDLE_EPOCHS, 10);
const CHECK_MS = parseInt(CHECK_INTERVAL_SEC, 10) * 1000;

const bot = new Telegraf(BOT_TOKEN);
const watchlist = new Map();

// Debug logging
console.log("🤖 Initializing bot with:");
console.log(`- Server URL: ${SERVER_URL}`);
console.log(`- Alert Threshold: ${THRESH_IDLE} idle epochs`);
console.log(`- Check Interval: ${CHECK_MS/1000} seconds`);

// Health check command
bot.command('ping', async (ctx) => {
  try {
    await ctx.reply("🏓 Pong! Bot is alive");
    console.log("✅ Responded to ping");
  } catch (err) {
    console.error("Ping failed:", err);
  }
});

// Status command
bot.command('status', async (ctx) => {
  try {
    const address = ctx.message.text.split(' ')[1];
    if (!address) return await ctx.reply("Usage: /status <proverAddress>");

    console.log(`🔍 Fetching status for: ${address}`);
    const statusText = await fetchProverStatus(address);

    await ctx.reply(statusText, {
      parse_mode: 'Markdown',
      reply_to_message_id: ctx.message.message_id
    });
    console.log("📤 Sent prover status to Telegram");

  } catch (err) {
    console.error("Status command error:", err.message);
    await ctx.reply(`Error: ${err.message}`);
  }
});

// Watch command
bot.command('watch', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Usage: /watch <proverAddress>");
  
  const addr = normAddr(parts[1]);
  if (!addr) return ctx.reply("Invalid address");

  try {
    if (!watchlist.has(ctx.chat.id)) {
      watchlist.set(ctx.chat.id, new Set());
    }
    watchlist.get(ctx.chat.id).add(addr);
    await ctx.reply(`✅ Watching ${addr}. I'll alert if no participation for ${THRESH_IDLE} epochs.`);
    console.log(`➕ Watch added for ${addr} in chat ${ctx.chat.id}`);
  } catch (e) {
    console.error("Watch command failed:", e);
    await ctx.reply(`Error: ${e.message}`);
  }
});

// Unwatch command
bot.command('unwatch', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply("Usage: /unwatch <proverAddress>");
  
  const addr = normAddr(parts[1]);
  if (!addr) return ctx.reply("Invalid address");

  try {
    if (watchlist.has(ctx.chat.id)) {
      const removed = watchlist.get(ctx.chat.id).delete(addr);
      if (watchlist.get(ctx.chat.id).size === 0) {
        watchlist.delete(ctx.chat.id);
      }
      await ctx.reply(removed ? `🛑 Stopped watching ${addr}` : "⚠️ No active watch found");
      console.log(`➖ Watch removed for ${addr} in chat ${ctx.chat.id}`);
    } else {
      await ctx.reply("⚠️ No active watches found");
    }
  } catch (e) {
    console.error("Unwatch command failed:", e);
    await ctx.reply(`Error: ${e.message}`);
  }
});

// List command
bot.command('list', async (ctx) => {
  try {
    if (!watchlist.has(ctx.chat.id) || watchlist.get(ctx.chat.id).size === 0) {
      return await ctx.reply("No active watches. Use /watch <prover> to add one.");
    }
    
    const addresses = Array.from(watchlist.get(ctx.chat.id));
    const text = `Your watched provers:\n${addresses.map(addr => `• ${addr}`).join("\n")}`;
    await ctx.reply(text);
    console.log(`📋 Listed watches for chat ${ctx.chat.id}`);
  } catch (e) {
    console.error("List command failed:", e);
    await ctx.reply(`Error: ${e.message}`);
  }
});

// Monitoring loop
async function monitorOnce() {
  if (watchlist.size === 0) {
    console.log("⏭️ No watches to monitor");
    return;
  }

  try {
    console.log(`\n🔍 Starting monitoring check at ${new Date().toISOString()}`);
    const sampleProver = Array.from(watchlist.values())[0].values().next().value;
    
    const { data } = await axios.get(`${SERVER_URL}/scan`, {
      params: { prover: sampleProver },
      timeout: 20000
    });

    if (!data?.currentEpoch) {
      throw new Error("Invalid server response");
    }

    const currentEpoch = data.currentEpoch;
    console.log(`ℹ️ Current epoch: ${currentEpoch}`);

    for (const [chatId, proverAddresses] of watchlist.entries()) {
      for (const addr of proverAddresses) {
        try {
          const statusText = await fetchProverStatus(addr);
          const lastEpochMatch = statusText.match(/Last Epoch Participated: (\d+)/);
          const lastEpoch = lastEpochMatch ? parseInt(lastEpochMatch[1]) : null;
          
          if (lastEpoch === null) {
            console.log(`⚠️ No participation for ${addr}`);
            await bot.telegram.sendMessage(
              chatId,
              `⚠️ ${addr}\nNo participation detected in scan window.`
            );
            continue;
          }
          
          const idleEpochs = currentEpoch - lastEpoch;
          console.log(`↗️ Prover ${addr}: ${idleEpochs} idle epochs`);
          
          if (idleEpochs >= THRESH_IDLE) {
            console.log(`🚨 Alerting for ${addr} (${idleEpochs} >= ${THRESH_IDLE} idle epochs)`);
            await bot.telegram.sendMessage(
              chatId,
              `🚨 Prover idle alert: ${addr}\n` +
              `No participation for ${idleEpochs} epochs.\n\n` +
              `Full status:\n${statusText}`
            );
          }
          
          await sleep(500); // Rate limiting
        } catch (e) {
          console.error(`Monitoring failed for ${addr}:`, e.message);
        }
      }
    }
  } catch (e) {
    console.error("Monitoring error:", e.message);
  }
}


app.get("/", (req, res) => {
  res.send("Bot is running 🚀");
});

app.listen(PORT, () => {
  console.log(`🌐 Express server running on port ${PORT}`);
});

// Error handling
bot.catch((err, ctx) => {
  console.error('⚠️ Bot Error:', err);
  ctx.reply("Bot encountered an error").catch(console.error);
});

// Start bot
(async () => {
  try {
    console.log("🚀 Starting bot...");
    await bot.launch();
    console.log("✅ Bot is now running");
    
    // Start monitoring
    setInterval(monitorOnce, CHECK_MS);
    console.log(`⏰ Monitoring active (every ${CHECK_MS/1000}s)`);
    monitorOnce(); // Initial check
    
    // Graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
  } catch (err) {
    console.error("❌ Failed to start bot:", err);
    process.exit(1);
  }
})();

// bot.command('status', async (ctx) => {
//   const parts = ctx.message.text.trim().split(/\s+/);
//   if (parts.length < 2) return ctx.reply("Usage: /status <proverAddress>");
//   const addr = normAddr(parts[1]);
//   if (!addr) return ctx.reply("Invalid address");

//   try {
//     const statusText = await fetchProverStatus(addr);
//     await ctx.reply(statusText);
//   } catch (e) {
//     await ctx.reply(`Error: ${e.message || e}`);
//   }
// });


// bot.command('watch', async (ctx) => {
//   const parts = ctx.message.text.trim().split(/\s+/);
//   if (parts.length < 2) return ctx.reply("Usage: /watch <proverAddress>");
//   const addr = normAddr(parts[1]);
//   if (!addr) return ctx.reply("Invalid address");

//   try {
//     if (!watchlist.has(ctx.chat.id)) {
//       watchlist.set(ctx.chat.id, new Set());
//     }
//     watchlist.get(ctx.chat.id).add(addr);
//     await ctx.reply(`✅ Watching ${addr}. I'll alert if no participation for ${ALERT_IF_IDLE_EPOCHS} epoch(s).`);
//   } catch (e) {
//     await ctx.reply(`Error: ${e.message || e}`);
//   }
// });

// bot.command('unwatch', async (ctx) => {
//   const parts = ctx.message.text.trim().split(/\s+/);
//   if (parts.length < 2) return ctx.reply("Usage: /unwatch <proverAddress>");
//   const addr = normAddr(parts[1]);
//   if (!addr) return ctx.reply("Invalid address");

//   if (watchlist.has(ctx.chat.id)) {
//     watchlist.get(ctx.chat.id).delete(addr);
//     if (watchlist.get(ctx.chat.id).size === 0) {
//       watchlist.delete(ctx.chat.id);
//     }
//   }
//   await ctx.reply(`🛑 Stopped watching ${addr}.`);
// });

// bot.command('list', async (ctx) => {
//   if (!watchlist.has(ctx.chat.id) || watchlist.get(ctx.chat.id).size === 0) {
//     return ctx.reply("No watches yet. Use /watch <prover>.");
//   }
  
//   const addresses = Array.from(watchlist.get(ctx.chat.id));
//   const text = addresses.map(addr => `• ${addr}`).join("\n");
//   await ctx.reply(`Your watches:\n${text}`);
// });

// // Monitoring loop
// const THRESH_IDLE = parseInt(ALERT_IF_IDLE_EPOCHS, 10);
// const CHECK_MS = parseInt(CHECK_INTERVAL_SEC, 10) * 1000;

// async function monitorOnce() {
//   if (watchlist.size === 0) return;

//   try {
//     // First get current epoch from server
//     const { data: { currentEpoch } } = await axios.get(`${SERVER_URL}/scan`, {
//       params: { prover: Array.from(watchlist.values())[0].values().next().value },
//       timeout: 5000
//     });

//     for (const [chatId, proverAddresses] of watchlist.entries()) {
//       for (const addr of proverAddresses) {
//         try {
//           const statusText = await fetchProverStatus(addr);
          
//           // Extract last participated epoch from text (or better from JSON endpoint)
//           const lastEpochMatch = statusText.match(/Last Epoch Participated: (\d+)/);
//           const lastEpoch = lastEpochMatch ? parseInt(lastEpochMatch[1]) : null;
          
//           if (lastEpoch === null) {
//             await bot.telegram.sendMessage(
//               chatId,
//               `⚠️ ${addr}\nNo participation detected in scan window.`
//             );
//             continue;
//           }
          
//           const idleEpochs = currentEpoch - lastEpoch;
//           if (idleEpochs >= THRESH_IDLE) {
//             await bot.telegram.sendMessage(
//               chatId,
//               `⚠️ Prover idle: ${addr}\n` +
//               `No participation for ${idleEpochs} epochs.\n\n` +
//               `Full status:\n${statusText}`
//             );
//           }
          
//           await sleep(500); // Rate limiting
//         } catch (e) {
//           console.error(`Error monitoring ${addr} for chat ${chatId}:`, e.message);
//         }
//       }
//     }
//   } catch (e) {
//     console.error("Monitoring error:", e.message);
//   }
// }

// // Start bot
// bot.launch().then(() => {
//   console.log(`Bot launched, using server at ${SERVER_URL}`);
//   setInterval(monitorOnce, CHECK_MS);
// });

// process.once('SIGINT', () => bot.stop('SIGINT'));
// process.once('SIGTERM', () => bot.stop('SIGTERM'));