require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { Client, GatewayIntentBits } = require("discord.js");
const Anthropic = require("@anthropic-ai/sdk");

const discord = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

const anthropic = new Anthropic();

// Optional filters
const CHANNEL_IDS = process.env.CHANNEL_IDS
  ? process.env.CHANNEL_IDS.split(",").map((id) => id.trim())
  : null;

const TOURPLAY_WEBHOOK_NAME = process.env.TOURPLAY_WEBHOOK_NAME || null;

const ALLOWED_USER_IDS = process.env.ALLOWED_USER_IDS
  ? process.env.ALLOWED_USER_IDS.split(",").map((id) => id.trim())
  : null;

// --- Game memory store ---
const GAMES_DIR = path.join(__dirname, "games");
if (!fs.existsSync(GAMES_DIR)) fs.mkdirSync(GAMES_DIR);

// Index: gameId -> { filename, data }
const games = new Map();

// Load all existing game files on startup
for (const file of fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith(".json"))) {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(GAMES_DIR, file), "utf-8"));
    if (data.gameId) {
      games.set(data.gameId, { filename: file, data });
      console.log(`[GAME] Loaded game ${data.gameId} from ${file}`);
    }
  } catch {
    console.warn(`[GAME] Failed to load ${file}`);
  }
}

function saveGame(gameId) {
  const entry = games.get(gameId);
  if (!entry) return;
  fs.writeFileSync(path.join(GAMES_DIR, entry.filename), JSON.stringify(entry.data, null, 2));
}

function sanitizeName(name) {
  return name.replace(/[^a-zA-Z0-9]/g, "");
}

function extractGameId(text) {
  const match = text.match(/https?:\/\/tourplay\.net\/[^\s]*?\/(\d+)/);
  return match ? match[1] : null;
}

function extractPlayerNames(text) {
  // Flag emojis like :flag_us: or :pirate_flag: followed by the player name
  const names = [];
  const lines = text.split("\n");
  for (const line of lines) {
    const match = line.match(/:[a-z_]+:\s+(.+)/);
    if (match) {
      const name = match[1].trim();
      // Filter out lines that are clearly not player names (scores, team names, etc.)
      if (name && !/^\d+$/.test(name) && !/^\d+\s/.test(name)) {
        names.push(name);
      }
    }
  }
  return names.length >= 2 ? [names[0], names[1]] : null;
}

function getOrCreateGame(gameId, channelId, text) {
  if (!games.has(gameId)) {
    const players = extractPlayerNames(text);
    const suffix = players
      ? `${sanitizeName(players[0])}_${sanitizeName(players[1])}`
      : "unknown";
    const filename = `${gameId}_${suffix}.json`;
    const data = {
      gameId,
      channelId,
      players: players || [],
      startedAt: new Date().toISOString(),
      endedAt: null,
      history: [],
    };
    games.set(gameId, { filename, data });
    console.log(`[GAME] Created new game ${filename}`);
  }
  return games.get(gameId).data;
}

const SYSTEM_PROMPT = `You are two Blood Bowl commentators providing live match commentary in a Discord channel.

**Bob Bifford** 
an ex-Blood Bowl player turned commentator. 
Big, enthusiastic, loves violence and big hits. 
Not the sharpest tool in the shed. 
Easily excited by touchdowns and casualties. 
Be creative about his personality, model him after existing football personalities who used to be players, but remember this is Bloodbowl.
As an Ogre, Bob Bifford stood out more for his intelligence and charisma not normally designated to his race. This has helped not only his career as a player of Blood Bowl, but as a world-renowned commentator of the sport. His knowledge of the game is nearly unsurpassed by anyone, save Jim Johnson, his partner at Network 7

**Jim Johnson**
the more professional, smooth-talking play-by-play commentator.
Tries to keep things on track but often gets dragged into Bob's nonsense. 
Dry wit, occasionally exasperated by Bob. Knows the rules but conveniently forgets them when it's funnier.


Rules:
- You receive match event messages from Tourplay.net (a Blood Bowl league management site). These describe what happened on the pitch — touchdowns, casualties, turnovers, fouls, completions, etc.
- When a match begins, you don't need to mention the score. 
- Respond with a SHORT, funny back-and-forth commentary exchange between Bob and Jim (1-3 lines total).
- The stars in the event are the star player points that player earns. There's no reason to mention them.
- Format each line as **Bob:** or **Jim:** followed by their comment.
- Keep it punchy. No more than 2-3 sentences per commentator per exchange.
- A touchdown is worth 1 point, this is not American football.
- Event types are important. Casualty means the player caused a casualty. Injury means that player is injured. 
- If there's no event name, and SPP is 0, treat it as stalling.
- Other events are: touchdown, completion (player passed the ball successfully), interception, foul, sent-off (after a foul)
- Stalling is the worst thing someone can do, Bob should be seeing red when this happens, and Jim should get just as angry, but remain professional.
- Reference Blood Bowl lore, Nuffle (the god of Blood Bowl), and the general chaos of the sport.
- React appropriately: touchdowns get excitement, casualties get gleeful horror, turnovers get mockery, fouls get winking approval or fake disapproval.
- If the message doesn't look like a game event, Bob and Jim can comment on it briefly anyway (they're easily distracted).
- Try not to repeat jokes within the same match. 
- If within the same match, the same player is doing a lot, get excited about that player.
- Never break character. You ARE Bob and Jim, sitting in the commentary box at the Cabalvision studio
- Remember that these characters are based on existing sports personalities, get creative in your jokes, make puns on Bloodbowl and existing sports in real life`;

async function generateCommentary(messages) {
  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages,
  });

  return response.content[0].text;
}

function isTourplayMessage(msg) {
  // Webhook messages show up as bot messages from the webhook's configured name
  if (!msg.author.bot && !msg.webhookId) return false;

  // If a specific webhook name filter is set, check it
  if (TOURPLAY_WEBHOOK_NAME) {
    return msg.author.username
      .toLowerCase()
      .includes(TOURPLAY_WEBHOOK_NAME.toLowerCase());
  }

  // If no name filter, accept all webhook/bot messages in the target channel(s)
  return true;
}

// Debounce buffer: per-channel collection of Tourplay events
// Key: channelId, Value: { events: [{content, msg}], timer: timeout }
const DEBOUNCE_MS = 15_000;
const channelBuffers = new Map();

// Events that trigger commentary (all others are silently recorded)
function shouldCommentOn(text) {
  return /start of match|end of the match|touchdown|dead!/i.test(text);
}

async function flushBuffer(channelId) {
  const buffer = channelBuffers.get(channelId);
  if (!buffer || buffer.events.length === 0) return;

  const events = buffer.events;
  channelBuffers.delete(channelId);

  const combined = events.map((e) => e.content).join("\n");
  const lastMsg = events[events.length - 1].msg;

  console.log(`[DEBOUNCE] Flushing ${events.length} event(s) for channel ${channelId}: "${combined.substring(0, 150)}"`);

  try {
    // Extract game ID and record event
    const gameId = extractGameId(combined);

    if (gameId) {
      const game = getOrCreateGame(gameId, channelId, combined);

      // Detect match start/end
      if (/start of match/i.test(combined)) {
        game.startedAt = new Date().toISOString();
        game.endedAt = null;
        console.log(`[GAME] Match started: ${gameId}`);
      }

      // Always save event to history
      game.history.push({ role: "user", content: combined });

      if (/end of the match/i.test(combined)) {
        game.endedAt = new Date().toISOString();
        console.log(`[GAME] Match ended: ${gameId}`);
      }

      saveGame(gameId);
    }

    // Only generate commentary for key events
    if (!shouldCommentOn(combined)) {
      console.log(`[SKIP] Silent event recorded, no commentary`);
      return;
    }

    await lastMsg.channel.sendTyping();

    let messages;
    if (gameId && games.has(gameId)) {
      // Build messages from full history
      messages = [...games.get(gameId).data.history];
    } else {
      messages = [{ role: "user", content: combined }];
    }

    const commentary = await generateCommentary(messages);
    console.log(`[REPLY] Sending ${commentary.length} chars`);

    // Persist assistant response to game history
    if (gameId && games.has(gameId)) {
      games.get(gameId).data.history.push({ role: "assistant", content: commentary });
      saveGame(gameId);
    }

    await lastMsg.reply(commentary);
  } catch (err) {
    console.error("[ERROR] Failed to generate commentary:", err.message);
  }
}

discord.on("ready", () => {
  console.log(`Logged in as ${discord.user.tag}`);
  console.log(
    CHANNEL_IDS
      ? `Watching channels: ${CHANNEL_IDS.join(", ")}`
      : "Watching all channels (set CHANNEL_IDS to restrict)"
  );
});

discord.on("messageCreate", async (msg) => {
  // Don't respond to ourselves
  if (msg.author.id === discord.user.id) return;

  console.log(`[MSG] author="${msg.author.username}" id=${msg.author.id} bot=${msg.author.bot} webhookId=${msg.webhookId || "none"} channel=${msg.channel.id}`);
  console.log(`[MSG] content="${msg.content}" embeds=${msg.embeds.length} mentions_bot=${msg.mentions.has(discord.user)}`);

  // Check if this is a direct mention from an allowed user
  const isMention =
    msg.mentions.has(discord.user) &&
    !msg.author.bot &&
    ALLOWED_USER_IDS &&
    ALLOWED_USER_IDS.includes(msg.author.id);

  // Check if this is a Tourplay webhook in a watched channel
  const isTourplay =
    (!CHANNEL_IDS || CHANNEL_IDS.includes(msg.channel.id)) &&
    isTourplayMessage(msg);

  console.log(`[FILTER] isMention=${isMention} isTourplay=${isTourplay} allowedIds=${JSON.stringify(ALLOWED_USER_IDS)} channelMatch=${!CHANNEL_IDS || CHANNEL_IDS.includes(msg.channel.id)}`);

  if (!isMention && !isTourplay) {
    console.log(`[SKIP] Message ignored`);
    return;
  }

  // Build content — strip the bot mention from direct messages
  let content;
  if (isMention) {
    content = msg.content.replace(/<@!?\d+>/g, "").trim();
    if (!content) { console.log(`[SKIP] Empty mention`); return; }
  } else {
    // Build content from message text and/or embeds
    const parts = [];
    if (msg.content) parts.push(msg.content);
    for (const embed of msg.embeds) {
      if (embed.url) parts.push(embed.url);
      if (embed.title) parts.push(embed.title);
      if (embed.description) parts.push(embed.description);
      const team = embed.footer?.text;
      if (embed.fields?.length) {
        for (const field of embed.fields) {
          const line = team
            ? `[${team}] ${field.name} — ${field.value}`
            : `${field.name} — ${field.value}`;
          parts.push(line);
        }
      }
    }
    content = parts.join("\n");
    console.log(`[CONTENT] Parsed: "${content.substring(0, 300)}"`);
    
    if (!content || !content.trim()) { console.log(`[SKIP] Empty content`); return; }
  }

  // Direct mentions get an immediate response
  if (isMention) {
    console.log(`[REPLY] Generating commentary for mention: "${content.substring(0, 100)}"`);
    try {
      await msg.channel.sendTyping();
      const commentary = await generateCommentary([{ role: "user", content }]);
      console.log(`[REPLY] Sending ${commentary.length} chars`);
      await msg.reply(commentary);
    } catch (err) {
      console.error("[ERROR] Failed to generate commentary:", err.message);
    }
    return;
  }

  // Tourplay events get debounced per channel
  const channelId = msg.channel.id;
  if (!channelBuffers.has(channelId)) {
    channelBuffers.set(channelId, { events: [], timer: null });
  }
  const buffer = channelBuffers.get(channelId);

  buffer.events.push({ content, msg });
  console.log(`[DEBOUNCE] Buffered event #${buffer.events.length} in channel ${channelId}: "${content.substring(0, 100)}"`);

  // Reset the debounce timer
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => flushBuffer(channelId), DEBOUNCE_MS);
});

discord.login(process.env.DISCORD_BOT_TOKEN);
