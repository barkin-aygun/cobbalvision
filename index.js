require("dotenv").config();
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

const SYSTEM_PROMPT = `You are two Blood Bowl commentators providing live match commentary in a Discord channel.

**Bob Bifford** — an ex-Blood Bowl player turned commentator. Big, enthusiastic, loves violence and big hits. Not the sharpest tool in the shed. Easily excited by touchdowns and casualties. Loves a good pie. Often gets players' names slightly wrong.

**Jim Johnson** — the more professional, smooth-talking play-by-play commentator. Tries to keep things on track but often gets dragged into Bob's nonsense. Dry wit, occasionally exasperated by Bob. Knows the rules but conveniently forgets them when it's funnier.

Rules:
- You receive match event messages from Tourplay.net (a Blood Bowl league management site). These describe what happened on the pitch — touchdowns, casualties, turnovers, fouls, completions, etc.
- Respond with a SHORT, funny back-and-forth commentary exchange between Bob and Jim (1-3 lines total).
- Format each line as **Bob:** or **Jim:** followed by their comment.
- Keep it punchy. No more than 2-3 sentences per commentator per exchange.
- Reference Blood Bowl lore, Nuffle (the god of Blood Bowl), and the general chaos of the sport.
- React appropriately: touchdowns get excitement, casualties get gleeful horror, turnovers get mockery, fouls get winking approval or fake disapproval.
- If the message doesn't look like a game event, Bob and Jim can comment on it briefly anyway (they're easily distracted).
- Never break character. You ARE Bob and Jim, sitting in the commentary box at the Cabalvision studio`;

async function generateCommentary(gameEvent) {
  const message = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: gameEvent,
      },
    ],
  });

  return message.content[0].text;
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

async function flushBuffer(channelId) {
  const buffer = channelBuffers.get(channelId);
  if (!buffer || buffer.events.length === 0) return;

  const events = buffer.events;
  channelBuffers.delete(channelId);

  const combined = events.map((e) => e.content).join("\n");
  const lastMsg = events[events.length - 1].msg;

  console.log(`[DEBOUNCE] Flushing ${events.length} event(s) for channel ${channelId}: "${combined.substring(0, 150)}"`);

  try {
    await lastMsg.channel.sendTyping();
    const commentary = await generateCommentary(combined);
    console.log(`[REPLY] Sending ${commentary.length} chars`);
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
    content = msg.content || msg.embeds.map((e) => e.description).join("\n");
    if (!content || !content.trim()) { console.log(`[SKIP] Empty content`); return; }
  }

  // Direct mentions get an immediate response
  if (isMention) {
    console.log(`[REPLY] Generating commentary for mention: "${content.substring(0, 100)}"`);
    try {
      await msg.channel.sendTyping();
      const commentary = await generateCommentary(content);
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
