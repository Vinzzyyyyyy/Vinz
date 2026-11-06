const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const mineflayer = require('mineflayer');
const path = require('path');
const fs = require('fs');

process.on('uncaughtException', (err) => {
  if (err.name === 'PartialReadError' || err.code === 'ERR_OUT_OF_RANGE' || (err.message && err.message.includes('ECONNRESET'))) {
    return;
  }
});

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Snapdeploy membutuhkan process.env.PORT dan host 0.0.0.0
const PORT = process.env.PORT || 3000;
const BOTS_FILE = path.join(__dirname, 'bots.json');

app.use(express.json());
// Melayani index.html dari root folder langsung
app.use(express.static(__dirname));

const activeBots = {};
const reconnectTimers = {};
const lastKickTimes = {};
const attackIntervals = {};

let botQueue = [];
let isProcessingQueue = false;

function readBotsConfig() {
  if (!fs.existsSync(BOTS_FILE)) fs.writeFileSync(BOTS_FILE, '[]');
  try {
    return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf-8'));
  } catch (e) {
    return [];
  }
}

function saveBotsConfig(bots) {
  fs.writeFileSync(BOTS_FILE, JSON.stringify(bots, null, 2));
}

// Chat sekarang HANYA dikirim ke frontend, TIDAK disimpan di Node.js
function addChatLog(username, sender, text, rawJson = null) {
  io.emit('chat_msg', { username, sender, text, rawJson });
}

function parseMinecraftJsonText(reason) {
  if (!reason) return 'Kicked dari server';
  if (typeof reason !== 'string') {
    try { 
      reason = JSON.stringify(reason); 
    } catch(e) { 
      return 'Kicked dari server'; 
    }
  }

  if (reason.trim().startsWith('{') || reason.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(reason);
      if (parsed.type !== undefined && Object.keys(parsed).length === 1) {
        return `Anti-Bot Packet (Type ${parsed.type})`;
      }

      let extracted = '';
      function extractText(obj) {
        if (!obj) return;
        if (typeof obj === 'string') { extracted += obj; return; }
        if (obj.text) extracted += obj.text;
        if (Array.isArray(obj.extra)) obj.extra.forEach(extractText);
        if (Array.isArray(obj.with)) obj.with.forEach(extractText);
      }
      extractText(parsed);
      return extracted.replace(/\n/g, ' ').trim() || reason;
    } catch(e) {
      return reason.replace(/"text"\s*:\s*"([^"]+)"/g, '$1 ').replace(/[{}[\]]/g, '').trim();
    }
  }
  return reason;
}

function enqueueBot(botData, isNewRegistration = false) {
  botQueue.push({ ...botData, isNewRegistration });
  processQueue();
}

async function processQueue() {
  if (isProcessingQueue || botQueue.length === 0) return;
  isProcessingQueue = true;

  const item = botQueue.shift();
  await startBot(item, item.isNewRegistration);

  const queueDelay = Math.floor(Math.random() * 5000) + 10000;
  setTimeout(() => {
    isProcessingQueue = false;
    processQueue();
  }, queueDelay);
}

const ARMOR_MATERIAL_SCORE = { leather: 1, golden: 2, chainmail: 3, iron: 4, diamond: 5, netherite: 6, turtle: 2 };
const HARMFUL_FOOD = new Set([
  'rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish',
  'chorus_fruit', 'suspicious_stew'
]);

function getFoodPoints(bot, item) {
  if (!item) return 0;
  if (typeof item.foodPoints === 'number') return item.foodPoints;
  const food = bot.registry && bot.registry.foodsByName && bot.registry.foodsByName[item.name];
  return food && typeof food.foodPoints === 'number' ? food.foodPoints : 0;
}

function getArmorScore(item, part) {
  if (!item || !item.name || !item.name.endsWith(`_${part}`)) return -1;
  const material = Object.keys(ARMOR_MATERIAL_SCORE).find(name => item.name.startsWith(`${name}_`));
  if (!material) return -1;
  const protection = (item.enchants || []).find(e => e.name === 'protection');
  return ARMOR_MATERIAL_SCORE[material] * 100 + (protection ? protection.lvl : 0);
}

async function equipBestArmor(bot, username) {
  if (!bot || !bot.inventory) return;
  const armorSlots = [
    { destination: 'head', part: 'helmet' },
    { destination: 'torso', part: 'chestplate' },
    { destination: 'legs', part: 'leggings' },
    { destination: 'feet', part: 'boots' }
  ];

  for (const slot of armorSlots) {
    const armorItem = bot.inventory.items()
      .filter(item => getArmorScore(item, slot.part) >= 0)
      .sort((a, b) => getArmorScore(b, slot.part) - getArmorScore(a, slot.part))[0];
    if (armorItem) {
      try { await bot.equip(armorItem.type, slot.destination); } catch (e) {}
    }
  }
}

// BUG INVENTORY FIXED: Mapping index agar sinkron antara UI dan Mineflayer
function sendInventoryUpdate(bot, username) {
  if (!bot || !bot.inventory) return;
  try {
    const slots = Array(36).fill(null);
    
    for (let i = 9; i <= 44; i++) {
      const item = bot.inventory.slots[i];
      if (item) {
        // Main inventory (9-35) -> UI 0-26 | Hotbar (36-44) -> UI 27-35
        const displayIndex = i >= 36 ? (i - 36 + 27) : (i - 9);
        slots[displayIndex] = {
          name: item.name,
          displayName: item.displayName || item.name,
          count: item.count,
          slot: i, // ID slot asli Mineflayer (penting untuk drop/move)
          typeId: item.type,
          enchantments: item.enchants ? item.enchants.map(e => `${e.name} ${e.lvl}`) : []
        };
      }
    }
    io.emit('inventory_data', { username, slots });
  } catch(e) {}
}

function cleanGuiTitle(titleObj) {
  if (!titleObj) return 'Shop / Container GUI';
  if (typeof titleObj === 'string') {
    if (titleObj.startsWith('{') || titleObj.startsWith('[')) {
      try {
        const parsed = JSON.parse(titleObj);
        return cleanGuiTitle(parsed);
      } catch (e) {
        return titleObj.replace(/"text"\s*:\s*"([^"]+)"/g, '$1 ').replace(/[{}[\]]/g, '').trim();
      }
    }
    return titleObj;
  }
  let result = '';
  if (titleObj.text) result += titleObj.text;
  if (titleObj.value) {
    if (typeof titleObj.value === 'string') result += titleObj.value;
    else if (titleObj.value.text) result += cleanGuiTitle(titleObj.value.text);
  }
  if (Array.isArray(titleObj.extra)) {
    titleObj.extra.forEach(ex => { result += cleanGuiTitle(ex); });
  }
  return result || 'Shop / Container GUI';
}

function sendWindowContainerUpdate(bot, username, window) {
  if (!window || !window.slots) return;
  try {
    const totalSlots = window.inventoryStart || window.slots.length;
    const slots = Array(totalSlots).fill(null);

    window.slots.forEach((item, slotIndex) => {
      if (item && slotIndex < totalSlots) {
        const enchantments = item.enchants ? item.enchants.map(e => `${e.name} ${e.lvl}`) : [];
        slots[slotIndex] = {
          slot: slotIndex,
          name: item.name,
          displayName: item.displayName || item.name,
          count: item.count,
          enchantments: enchantments
        };
      }
    });

    const cleanTitle = cleanGuiTitle(window.title);

    io.emit('window_open', {
      username,
      windowId: window.id !== undefined ? window.id : 1,
      title: cleanTitle,
      slotsCount: slots.length,
      slots: slots
    });
  } catch(e) {}
}

function updateActivityStatus(bot, username, activity) {
  if (!bot) return;
  bot.currentActivity = activity;
  io.emit('bot_activity', { username, activity });
}

function broadcastHealth(bot, username) {
  if (!bot) return;
  io.emit('bot_health', {
    username,
    health: Math.round(bot.health !== undefined ? bot.health : 20),
    food: Math.round(bot.food !== undefined ? bot.food : 20)
  });
}

function broadcastCoordsAndPing(bot, username) {
  if (!bot || !bot.entity || !bot.entity.position) return;
  const pos = bot.entity.position;
  const x = Math.floor(pos.x);
  const y = Math.floor(pos.y);
  const z = Math.floor(pos.z);
  
  let ping = 0;
  if (bot.player) ping = bot.player.ping || 0;

  io.emit('bot_coords', {
    username,
    x,
    y,
    z,
    ping,
    isSpawn: (x === 0 && z === 0)
  });
}

function checkAutoHomeOnSpawn(bot, username) {
  if (!bot || !bot.entity || !bot.entity.position) return;
  const x = Math.floor(bot.entity.position.x);
  const z = Math.floor(bot.entity.position.z);

  if (x === 0 && z === 0) {
    addChatLog(username, 'SYSTEM', 'Terdeteksi berada di SPAWN (0,0). Mengeksekusi auto /home...');
    setTimeout(() => {
      if (activeBots[username]) {
        bot.chat('/home');
      }
    }, 2000);
  }
}

async function triggerAutoEat(bot, username) {
  if (bot.isEating || !bot.inventory) return;

  const foodItem = bot.inventory.items()
    .filter(item => item && !HARMFUL_FOOD.has(item.name) && getFoodPoints(bot, item) > 0)
    .sort((a, b) => getFoodPoints(bot, b) - getFoodPoints(bot, a))[0];

  if (foodItem) {
    bot.isEating = true;
    const wasAttacking = bot.autoAttackStatus;
    
    if (wasAttacking && attackIntervals[username]) {
      clearInterval(attackIntervals[username]);
      delete attackIntervals[username];
    }

    updateActivityStatus(bot, username, 'Eating');
    addChatLog(username, 'SYSTEM', `Auto Eat: Memakan ${foodItem.displayName || foodItem.name}...`);

    if (bot.fishingStatus) {
      try { await bot.activateItem(); } catch (e) {}
    }
    bot.clearControlStates();

    try {
      await bot.equip(foodItem.type, 'hand');
      await bot.consume();
      addChatLog(username, 'SYSTEM', 'Auto Eat: Selesai makan.');
    } catch (e) {
      addChatLog(username, 'SYSTEM', `Gagal makan: ${e.message}`);
    } finally {
      bot.isEating = false;
      
      if (wasAttacking && activeBots[username]) {
        startAutoAttackInterval(bot, username);
      } else {
        updateActivityStatus(bot, username, bot.fishingStatus ? 'Fishing' : 'Idle');
      }
    }
  }
}

function startAutoAttackInterval(bot, username) {
  if (attackIntervals[username]) clearInterval(attackIntervals[username]);
  
  bot.autoAttackStatus = true;
  updateActivityStatus(bot, username, 'Attacking');

  attackIntervals[username] = setInterval(async () => {
    if (!bot || !bot.autoAttackStatus || !activeBots[username]) {
      if (attackIntervals[username]) {
        clearInterval(attackIntervals[username]);
        delete attackIntervals[username];
      }
      return;
    }

    if (bot.isEating || !bot.entity) return;

    const target = bot.nearestEntity(e => 
	  e &&
	  e.type === 'hostile' &&
	  e.isValid &&
	  e.position &&
	  bot.entity.position.distanceTo(e.position) <= 4.5
	);

    if (target) {
      try {
        const weapon = bot.inventory.items().find(i => i && (i.name.includes('sword') || i.name.includes('axe')));
        if (weapon && (!bot.heldItem || bot.heldItem.type !== weapon.type)) {
          await bot.equip(weapon.type, 'hand');
        }
      } catch (e) {}

      try {
        const targetPos = target.position.offset(0, target.height * 0.5, 0);
        await bot.lookAt(targetPos, true);
        bot.attack(target);
      } catch(err) {}
    }
  }, 550);
}

async function startBot(botData, isNewRegistration = false) {
  const { username, password, host, port, active } = botData;
  if (!active || activeBots[username]) return;

  if (reconnectTimers[username]) {
    clearTimeout(reconnectTimers[username]);
    delete reconnectTimers[username];
  }

  if (attackIntervals[username]) {
    clearInterval(attackIntervals[username]);
    delete attackIntervals[username];
  }

  const botOptions = {
    host: host || 'localhost',
    port: port ? parseInt(port) : 25565,
    username: username,
    auth: 'offline',
    version: '1.21.11',
    hideErrors: true,
    checkTimeoutInterval: 60 * 1000
  };

  const bot = mineflayer.createBot(botOptions);
  bot.fishingStatus = false;
  bot.autoAttackStatus = false;
  bot.isEating = false;
  bot.isIntentionalDisconnect = false;
  bot.currentActivity = 'Connecting';
  activeBots[username] = bot;

  io.emit('bot_added', botData);

  const setupInventorySync = () => {
    sendInventoryUpdate(bot, username);
    if (bot.inventory) {
      bot.inventory.on('updateSlot', () => sendInventoryUpdate(bot, username));
    }
  };

  bot.on('spawn', () => {
    io.emit('bot_status', { username, status: 'Online' });
    updateActivityStatus(bot, username, 'Idle');
    addChatLog(username, 'SYSTEM', 'Bot berhasil masuk!');

    broadcastCoordsAndPing(bot, username);
    broadcastHealth(bot, username);
    setupInventorySync();
    checkAutoHomeOnSpawn(bot, username);

    if (bot.autoAttackStatus) {
      startAutoAttackInterval(bot, username);
    }

    const randomAuthDelay = Math.floor(Math.random() * 2500) + 3500;
    setTimeout(() => {
      if (!activeBots[username]) return;

      if (password) {
        if (isNewRegistration) {
          addChatLog(username, 'SYSTEM', 'Mengeksekusi /register untuk bot baru...');
          bot.chat(`/register ${password} ${password}`);
        } else {
          bot.chat(`/login ${password}`);
        }
      }

      const randomServerDelay = Math.floor(Math.random() * 3000) + 4000;
      setTimeout(() => {
        if (!activeBots[username]) return;
        bot.chat('/survival');

        setTimeout(() => {
          if (!activeBots[username]) return;
          equipBestArmor(bot, username);
          sendInventoryUpdate(bot, username);
          broadcastCoordsAndPing(bot, username);
          checkAutoHomeOnSpawn(bot, username);
        }, 3000);
      }, randomServerDelay);
    }, randomAuthDelay);
  });

  bot.on('death', () => {
    addChatLog(username, 'SYSTEM', 'Bot mati! Mengirim auto /home dalam 3 detik...');
    updateActivityStatus(bot, username, 'Died');

    const hadAttackActive = bot.autoAttackStatus;
    if (hadAttackActive && attackIntervals[username]) {
      clearInterval(attackIntervals[username]);
      delete attackIntervals[username];
    }

    setTimeout(() => {
      if (activeBots[username]) {
        bot.chat('/home');
        if (hadAttackActive) {
          startAutoAttackInterval(bot, username);
        }
      }
    }, 3000);
  });

  bot.on('move', () => {
    broadcastCoordsAndPing(bot, username);
    if (!bot.isEating && !bot.fishingStatus && !bot.autoAttackStatus) {
      if (bot.entity && bot.entity.velocity && (bot.entity.velocity.x !== 0 || bot.entity.velocity.z !== 0)) {
        updateActivityStatus(bot, username, 'Moving');
      } else {
        updateActivityStatus(bot, username, 'Idle');
      }
    }
  });

  bot.on('health', async () => {
    broadcastHealth(bot, username);
    if (bot.food <= 19 && !bot.isEating) {
      triggerAutoEat(bot, username);
    }
  });

  bot.on('windowOpen', (window) => {
    if (!window) return;
    sendInventoryUpdate(bot, username);
    sendWindowContainerUpdate(bot, username, window);

    setTimeout(() => {
      if (bot.currentWindow && bot.currentWindow.id === window.id) {
        sendWindowContainerUpdate(bot, username, bot.currentWindow);
      }
    }, 300);

    setTimeout(() => {
      if (bot.currentWindow && bot.currentWindow.id === window.id) {
        sendWindowContainerUpdate(bot, username, bot.currentWindow);
      }
    }, 800);

    window.on('updateSlot', () => {
      if (bot.currentWindow) {
        sendWindowContainerUpdate(bot, username, bot.currentWindow);
      }
    });
  });

  bot.on('windowClose', (window) => {
    io.emit('window_close', { username, windowId: window ? window.id : 0 });
  });

  bot.on('playerCollect', () => {
    sendInventoryUpdate(bot, username);
    setTimeout(() => equipBestArmor(bot, username), 1000);
  });

  bot.on('message', (jsonMsg) => {
    try {
      const rawText = jsonMsg.toString();
      if (rawText && rawText.trim() !== '') {
        addChatLog(username, 'SERVER', rawText, jsonMsg);
      }
    } catch (e) {
      if (jsonMsg && jsonMsg.toString()) {
        addChatLog(username, 'SERVER', jsonMsg.toString());
      }
    }
  });

  const handleReconnect = (reason) => {
    if (bot.isIntentionalDisconnect) return;

    if (attackIntervals[username]) {
      clearInterval(attackIntervals[username]);
      delete attackIntervals[username];
    }

    delete activeBots[username];
    io.emit('bot_status', { username, status: 'Disconnected' });

    const currentList = readBotsConfig();
    const target = currentList.find(b => b.username === username);

    if (target && target.active) {
      const now = Date.now();
      const lastKick = lastKickTimes[username] || 0;
      lastKickTimes[username] = now;

      let delayMs = Math.floor(Math.random() * 5000) + 15000;
      const delaySec = Math.round(delayMs / 1000);
      addChatLog(username, 'SYSTEM', `Terputus (${reason}). Reconnect dalam ${delaySec} detik...`);

      if (reconnectTimers[username]) clearTimeout(reconnectTimers[username]);

      reconnectTimers[username] = setTimeout(() => {
        enqueueBot(target, false);
      }, delayMs);
    }
  };

  bot.on('kicked', (reason) => {
    const cleanReason = parseMinecraftJsonText(reason);
    handleReconnect(`Kicked: ${cleanReason}`);
  });

  bot.on('error', (err) => handleReconnect(`Error: ${err.message}`));
  bot.on('end', (reason) => handleReconnect(`Disconnected (${reason || 'Socket Closed'})`));
}

function stopBot(username) {
  if (reconnectTimers[username]) {
    clearTimeout(reconnectTimers[username]);
    delete reconnectTimers[username];
  }

  if (attackIntervals[username]) {
    clearInterval(attackIntervals[username]);
    delete attackIntervals[username];
  }

  if (activeBots[username]) {
    activeBots[username].isIntentionalDisconnect = true;
    activeBots[username].quit();
    delete activeBots[username];
    io.emit('bot_status', { username, status: 'Offline' });
  }
}

app.get('/api/bots', (req, res) => {
  const bots = readBotsConfig();
  res.json(bots);
});

app.post('/api/bots', (req, res) => {
  const { username, password, host, port } = req.body;
  if (!username) return res.status(400).json({ error: 'Username wajib diisi' });

  const bots = readBotsConfig();
  if (bots.some(b => b.username === username)) {
    return res.status(400).json({ error: 'Username sudah terdaftar' });
  }

  const newBot = { 
    username, 
    password: password || '', 
    host: host || 'localhost', 
    port: port || 25565, 
    active: true 
  };
  
  bots.push(newBot);
  saveBotsConfig(bots);

  enqueueBot(newBot, true);
  res.json({ success: true, bot: newBot });
});

app.post('/api/bots/toggle', (req, res) => {
  const { username, active } = req.body;
  const bots = readBotsConfig();
  const bot = bots.find(b => b.username === username);

  if (!bot) return res.status(404).json({ error: 'Bot tidak ditemukan' });

  bot.active = active;
  saveBotsConfig(bots);

  if (active) enqueueBot(bot, false);
  else stopBot(username);

  res.json({ success: true });
});

app.delete('/api/bots/:username', (req, res) => {
  const { username } = req.params;
  let bots = readBotsConfig();
  const botExists = bots.some(b => b.username === username);

  if (!botExists) return res.status(404).json({ error: 'Bot tidak ditemukan' });

  stopBot(username);
  bots = bots.filter(b => b.username !== username);
  saveBotsConfig(bots);

  io.emit('bot_removed', { username });
  res.json({ success: true });
});

app.post('/api/broadcast', (req, res) => {
  const { message } = req.body;
  Object.values(activeBots).forEach(bot => {
    try { bot.chat(message); } catch(e) {}
  });
  res.json({ success: true });
});

app.get('/api/tablist', (req, res) => {
  const activeBotUsernames = Object.keys(activeBots);
  if (activeBotUsernames.length === 0) return res.json({ players: [] });

  const firstBot = activeBots[activeBotUsernames[0]];
  if (!firstBot || !firstBot.players) return res.json({ players: [] });

  const playerList = Object.keys(firstBot.players).map(pName => {
    const p = firstBot.players[pName];
    return {
      username: p.username,
      ping: p.ping || 0,
      displayName: p.displayName ? p.displayName.toString() : p.username
    };
  });

  res.json({ players: playerList, count: playerList.length });
});

io.on('connection', (socket) => {
  Object.keys(activeBots).forEach(username => {
    const bot = activeBots[username];
    broadcastCoordsAndPing(bot, username);
    broadcastHealth(bot, username);
    sendInventoryUpdate(bot, username);
    updateActivityStatus(bot, username, bot.currentActivity || 'Idle');
  });

  socket.on('send_command', ({ username, message }) => {
    const bot = activeBots[username];
    if (bot) {
      bot.chat(message);
      addChatLog(username, 'YOU', message);
    }
  });

  socket.on('set_hotbar_slot', ({ username, slot }) => {
    const bot = activeBots[username];
    if (!bot) return;
    try {
      bot.setQuickBarSlot(slot);
      addChatLog(username, 'SYSTEM', `Hotbar diganti ke Slot ${slot + 1}`);
      setTimeout(() => sendInventoryUpdate(bot, username), 200);
    } catch(e) {
      addChatLog(username, 'SYSTEM', `Gagal mengganti hotbar slot: ${e.message}`);
    }
  });

  socket.on('get_inventory', (username) => {
    const bot = activeBots[username];
    if (bot) sendInventoryUpdate(bot, username);
  });

  socket.on('click_window_slot', ({ username, slot }) => {
    const bot = activeBots[username];
    if (bot && bot.currentWindow) {
      try {
        bot.clickWindow(slot, 0, 0);
        addChatLog(username, 'SYSTEM', `Klik GUI Slot ${slot} terkirim.`);
      } catch (err) {
        addChatLog(username, 'SYSTEM', `Gagal klik slot GUI: ${err.message}`);
      }
    }
  });

  socket.on('close_window', ({ username }) => {
    const bot = activeBots[username];
    if (bot && bot.currentWindow) {
      try {
        bot.closeWindow(bot.currentWindow);
      } catch (e) {}
    }
  });

  socket.on('drop_item_count', async ({ username, slot, count }) => {
    const bot = activeBots[username];
    if (!bot || !bot.inventory) return;

    const item = bot.inventory.slots[slot];
    if (item) {
      try {
        const amountToDrop = Math.min(count || item.count, item.count);
        await bot.toss(item.type, null, amountToDrop);
        addChatLog(username, 'SYSTEM', `Berhasil drop ${amountToDrop}x ${item.displayName || item.name}`);
        setTimeout(() => sendInventoryUpdate(bot, username), 500);
      } catch (err) {
        addChatLog(username, 'SYSTEM', `Gagal drop item: ${err.message}`);
      }
    }
  });

  socket.on('move_to_hotbar', async ({ username, sourceSlot, hotbarSlot }) => {
    const bot = activeBots[username];
    if (!bot || !bot.inventory || !Number.isInteger(sourceSlot) || hotbarSlot < 0 || hotbarSlot > 8) return;
    const targetSlot = 36 + hotbarSlot;
    if (sourceSlot === targetSlot || !bot.inventory.slots[sourceSlot]) return;

    try {
      await bot.clickWindow(sourceSlot, 0, 0);
      await bot.clickWindow(targetSlot, 0, 0);
      await bot.clickWindow(sourceSlot, 0, 0);
      addChatLog(username, 'SYSTEM', `Item dipindahkan ke hotbar ${hotbarSlot + 1}.`);
      setTimeout(() => sendInventoryUpdate(bot, username), 250);
    } catch (err) {
      addChatLog(username, 'SYSTEM', `Gagal memindahkan item: ${err.message}`);
    }
  });

  socket.on('equip_best_armor', async (username) => {
    const bot = activeBots[username];
    if (!bot) return;
    await equipBestArmor(bot, username);
    sendInventoryUpdate(bot, username);
    addChatLog(username, 'SYSTEM', 'Armor terbaik telah dipakai.');
  });

  socket.on('toggle_fishing', async (username) => {
    const bot = activeBots[username];
    if (!bot) return;

    bot.fishingStatus = !bot.fishingStatus;

    if (bot.fishingStatus) {
      updateActivityStatus(bot, username, 'Fishing');
      addChatLog(username, 'SYSTEM', 'Fitur Mancing Otomatis DIAKTIFKAN.');
      
      const startFish = async () => {
        if (!bot.fishingStatus) return;
        try {
          const rod = bot.inventory.items().find(i => i && i.name.includes('fishing_rod'));
          if (!rod) {
            addChatLog(username, 'SYSTEM', 'Gagal Mancing: Pancingan tidak ditemukan!');
            bot.fishingStatus = false;
            updateActivityStatus(bot, username, 'Idle');
            return;
          }
          await bot.equip(rod.type, 'hand');
          await bot.fish();
          if (bot.fishingStatus) setTimeout(startFish, 1000);
        } catch (err) {
          addChatLog(username, 'SYSTEM', `Mancing berhenti: ${err.message}`);
          bot.fishingStatus = false;
          updateActivityStatus(bot, username, 'Idle');
        }
      };
      startFish();
    } else {
      try { await bot.activateItem(); } catch (e) {}
      updateActivityStatus(bot, username, 'Idle');
      addChatLog(username, 'SYSTEM', 'Fitur Mancing Otomatis DIMATIKAN.');
    }
  });

  socket.on('toggle_attack', (username) => {
    const bot = activeBots[username];
    if (!bot) return;

    bot.autoAttackStatus = !bot.autoAttackStatus;

    if (bot.autoAttackStatus) {
      addChatLog(username, 'SYSTEM', 'Auto Attack mob hostile DIAKTIFKAN (player tidak akan ditarget).');
      startAutoAttackInterval(bot, username);
    } else {
      if (attackIntervals[username]) {
        clearInterval(attackIntervals[username]);
        delete attackIntervals[username];
      }
      updateActivityStatus(bot, username, 'Idle');
      addChatLog(username, 'SYSTEM', 'Fitur Auto Attack DIMATIKAN.');
    }
  });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Listener host diset ke 0.0.0.0 untuk Snapdeploy
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  readBotsConfig().forEach(b => { 
    if (b.active) enqueueBot(b, false); 
  });
});
