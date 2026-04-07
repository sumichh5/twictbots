const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const rootDir = path.resolve(__dirname, "..");
const primaryEnvPath = path.resolve(rootDir, ".env");
const fallbackEnvPath = path.resolve(rootDir, ".env.example");

if (fs.existsSync(primaryEnvPath)) {
  dotenv.config({ path: primaryEnvPath });
} else if (fs.existsSync(fallbackEnvPath)) {
  dotenv.config({ path: fallbackEnvPath });
}

function readString(name, fallback = "") {
  const value = process.env[name];
  return value === undefined ? fallback : value.trim();
}

function readNumber(name, fallback) {
  const value = Number.parseInt(readString(name), 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBoolean(name, fallback = false) {
  const value = readString(name).toLowerCase();
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(value);
}

function extractTwitchLogin(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }

  const urlPattern = /^https?:\/\/(?:www\.)?twitch\.tv\/([a-zA-Z0-9_]+)\/?$/i;
  const match = value.match(urlPattern);
  if (match) {
    return match[1].toLowerCase();
  }

  return value.toLowerCase();
}

function normalizeStreamer(entry, index) {
  if (typeof entry === "string") {
    const login = extractTwitchLogin(entry);
    if (!login) {
      throw new Error(`Empty streamer login at index ${index}.`);
    }

    return {
      login,
      label: login,
      accentColor: "#9146FF"
    };
  }

  if (!entry || typeof entry !== "object") {
    throw new Error(`Invalid streamer config at index ${index}.`);
  }

  const login = extractTwitchLogin(entry.login || entry.url);
  if (!login) {
    throw new Error(`Streamer config at index ${index} is missing "login" or "url".`);
  }

  return {
    login,
    label: String(entry.label || entry.displayName || login).trim(),
    accentColor: String(entry.accentColor || "#9146FF").trim(),
    profileImageUrl: String(entry.profileImageUrl || "").trim()
  };
}

function loadStreamers(streamersConfigPath) {
  if (!fs.existsSync(streamersConfigPath)) {
    throw new Error(
      `Streamers config not found at ${streamersConfigPath}. Copy config/streamers.example.json to config/streamers.json and update the list.`
    );
  }

  const raw = fs.readFileSync(streamersConfigPath, "utf8");
  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.streamers;

  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`No streamers configured in ${streamersConfigPath}.`);
  }

  const seen = new Set();
  return list.map(normalizeStreamer).filter((streamer) => {
    if (seen.has(streamer.login)) {
      return false;
    }

    seen.add(streamer.login);
    return true;
  });
}

const streamersConfigPath = path.resolve(
  rootDir,
  readString("STREAMERS_CONFIG_PATH", "./config/streamers.json")
);

function loadConfig() {
  const defaultDiscordUsername = "Twitch Live Alerts";
  const defaultDiscordAvatarUrl =
    "https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png";
  const discordRequested = readBoolean("ENABLE_DISCORD", false);
  const discordWebhookUrl = readString("DISCORD_WEBHOOK_URL");
  const discordBotToken = readString("DISCORD_BOT_TOKEN");
  const discordChannelId = readString("DISCORD_CHANNEL_ID");
  const discordTransport = discordBotToken && discordChannelId ? "bot" : discordWebhookUrl ? "webhook" : "none";
  const discordTestWebhookUrl = readString("DISCORD_TEST_WEBHOOK_URL");
  const discordTestBotToken = readString("DISCORD_TEST_BOT_TOKEN", discordBotToken);
  const discordTestChannelId = readString("DISCORD_TEST_CHANNEL_ID");
  const discordTestTransport =
    discordTestBotToken && discordTestChannelId ? "bot" : discordTestWebhookUrl ? "webhook" : "none";
  const defaultTestDiscordUsername = `${readString("DISCORD_USERNAME", defaultDiscordUsername)} ТЕСТ`;
  const defaultTestDiscordAvatarUrl = readString("DISCORD_AVATAR_URL", defaultDiscordAvatarUrl);

  const config = {
    rootDir,
    app: {
      name: readString("APP_NAME", "Twitch Stream Notifier"),
      envFilePath: fs.existsSync(primaryEnvPath)
        ? primaryEnvPath
        : fs.existsSync(fallbackEnvPath)
          ? fallbackEnvPath
          : null,
      logLevel: readString("LOG_LEVEL", "info") || "info",
      logFile: path.resolve(rootDir, readString("LOG_FILE", "./logs/twitch-notifier.log")),
      stateFile: path.resolve(rootDir, readString("STATE_FILE", "./data/state.json")),
      streamersConfigPath,
      pollIntervalMs: readNumber("POLL_INTERVAL_SECONDS", 45) * 1000,
      requestTimeoutMs: readNumber("REQUEST_TIMEOUT_MS", 10000),
      maxRetries: readNumber("MAX_RETRIES", 4),
      timeZone: readString("TIME_ZONE", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
      mockMode: readBoolean("MOCK_MODE", true)
    },
    twitch: {
      clientId: readString("TWITCH_CLIENT_ID"),
      clientSecret: readString("TWITCH_CLIENT_SECRET")
    },
    telegram: {
      enabled: readBoolean("ENABLE_TELEGRAM", false),
      botToken: readString("TELEGRAM_BOT_TOKEN"),
      chatId: readString("TELEGRAM_CHAT_ID")
    },
    discord: {
      enabled: discordRequested && discordTransport !== "none",
      transport: discordTransport,
      webhookUrl: discordWebhookUrl,
      botToken: discordBotToken,
      channelId: discordChannelId,
      mentionEveryone: readBoolean("DISCORD_MENTION_EVERYONE", false),
      username: readString("DISCORD_USERNAME", defaultDiscordUsername),
      avatarUrl: readString("DISCORD_AVATAR_URL", defaultDiscordAvatarUrl),
      footerLabel: "live alert",
      variant: "default"
    },
    discordTest: {
      enabled: discordTestTransport !== "none",
      transport: discordTestTransport,
      webhookUrl: discordTestWebhookUrl,
      botToken: discordTestBotToken,
      channelId: discordTestChannelId,
      mentionEveryone: readBoolean("DISCORD_TEST_MENTION_EVERYONE", false),
      username: readString("DISCORD_TEST_USERNAME", defaultTestDiscordUsername),
      avatarUrl: readString("DISCORD_TEST_AVATAR_URL", defaultTestDiscordAvatarUrl),
      gifUrl: readString(
        "DISCORD_TEST_GIF_URL",
        "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExcjRlYWN6aXZsYnZycTdnN2M4bGI3OXd2c2NkNmltNmpvc2F2Y3F4NyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/HSyR7A954pdC4w6PHa/giphy.gif"
      ),
      footerLabel: readString("DISCORD_TEST_FOOTER_LABEL", "тестовое уведомление"),
      variant: "test"
    }
  };

  config.streamers = loadStreamers(config.app.streamersConfigPath);
  validateConfig(config);

  return config;
}

function validateConfig(config) {
  const discordRequested = readBoolean("ENABLE_DISCORD", false);
  const discordTestRequested = Boolean(
    readString("DISCORD_TEST_WEBHOOK_URL") || readString("DISCORD_TEST_BOT_TOKEN") || readString("DISCORD_TEST_CHANNEL_ID")
  );

  if (!config.app.mockMode && (!config.twitch.clientId || !config.twitch.clientSecret)) {
    throw new Error("TWITCH_CLIENT_ID and TWITCH_CLIENT_SECRET are required when MOCK_MODE=false.");
  }

  if (config.telegram.enabled && (!config.telegram.botToken || !config.telegram.chatId)) {
    throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required when ENABLE_TELEGRAM=true.");
  }

  if (discordRequested && !config.discord.enabled) {
    throw new Error("DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID is required when ENABLE_DISCORD=true.");
  }

  if (discordTestRequested && !config.discordTest.enabled) {
    throw new Error(
      "DISCORD_TEST_WEBHOOK_URL or DISCORD_TEST_BOT_TOKEN/DISCORD_BOT_TOKEN + DISCORD_TEST_CHANNEL_ID is required when the test Discord mirror is enabled."
    );
  }

  fs.mkdirSync(path.dirname(config.app.logFile), { recursive: true });
  fs.mkdirSync(path.dirname(config.app.stateFile), { recursive: true });
}

module.exports = {
  loadConfig
};
