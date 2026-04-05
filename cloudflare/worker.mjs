const DEFAULT_STREAMERS_JSON = JSON.stringify({
  streamers: [
    {
      url: "https://www.twitch.tv/Wooflyaa",
      label: "Wooflyaa",
      accentColor: "#E11D48"
    }
  ]
});

const STATE_KEY = "state:v1";
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

let warnedNoChannels = false;
let twitchTokenCache = {
  accessToken: null,
  expiresAt: 0
};
let streamerCache = {
  key: "",
  expiresAt: 0,
  streamers: []
};

export default {
  async fetch(request, env) {
    const summary = summarizeConfiguration(env);
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: summary.ready,
        mode: "cloudflare-workers-cron",
        schedule: "* * * * *",
        ...summary
      });
    }

    return jsonResponse({
      ok: summary.ready,
      message: summary.ready
        ? "Twitch notifier is deployed. Cron checks run every minute."
        : "Worker is deployed, but some configuration is still missing.",
      schedule: "* * * * *",
      ...summary
    });
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runMonitor(env, createLogger(env)));
  }
};

async function runMonitor(env, logger) {
  const config = loadConfig(env, { strict: true });
  logger.info("Starting scheduled Twitch check.", {
    appName: config.app.name,
    streamers: config.streamers.map((streamer) => streamer.login),
    telegramEnabled: config.telegram.enabled,
    discordEnabled: config.discord.enabled
  });

  const state = await loadState(env);
  const resolvedStreamers = await resolveStreamers(config, logger);
  const liveByUserId = await getLiveStreams(config, resolvedStreamers, logger);

  let dirty = false;
  let delivered = 0;

  for (const streamer of resolvedStreamers) {
    const liveStream = liveByUserId.get(streamer.userId);

    if (!liveStream) {
      const offline = markOffline(state, streamer.login);
      dirty = dirty || offline.changed;
      if (offline.changed) {
        logger.info("Streamer went offline.", {
          streamer: streamer.login
        });
      }
      continue;
    }

    const live = markLive(state, streamer.login, liveStream);
    dirty = dirty || live.changed;
    if (live.changed) {
      logger.info("Live stream detected.", {
        streamer: streamer.login,
        streamId: liveStream.id,
        title: liveStream.title
      });
    }

    const payload = createPayload(config, streamer, liveStream);
    const results = await dispatchLiveAlert(payload, state, config, logger);

    for (const result of results) {
      if (result.delivered) {
        markNotified(state, streamer.login, result.channel, liveStream.id);
        dirty = true;
        delivered += 1;
        logger.info("Live alert sent.", {
          streamer: streamer.login,
          channel: result.channel,
          streamId: liveStream.id
        });
      }
    }
  }

  if (dirty) {
    await saveState(env, state);
  }

  logger.info("Scheduled Twitch check finished.", {
    checked: resolvedStreamers.length,
    delivered
  });
}

function summarizeConfiguration(env) {
  try {
    const config = loadConfig(env, { strict: false });

    return {
      ready: config.missing.length === 0 && (config.telegram.enabled || config.discord.enabled),
      appName: config.app.name,
      streamers: config.streamers.map((streamer) => streamer.login),
      channels: {
        telegram: config.telegram.enabled,
        discord: config.discord.enabled
      },
      stateKvBound: Boolean(env.STATE_KV),
      missing: config.missing
    };
  } catch (error) {
    return {
      ready: false,
      appName: readString(env.APP_NAME, "Wooflyaa Live Notifier"),
      streamers: [],
      channels: {
        telegram: false,
        discord: false
      },
      stateKvBound: Boolean(env.STATE_KV),
      missing: [error.message]
    };
  }
}

function loadConfig(env, options = {}) {
  const strict = options.strict !== false;
  const streamers = parseStreamers(readString(env.STREAMERS_JSON, DEFAULT_STREAMERS_JSON));
  const app = {
    name: readString(env.APP_NAME, "Wooflyaa Live Notifier"),
    requestTimeoutMs: readNumber(env.REQUEST_TIMEOUT_MS, 10000),
    maxRetries: readNumber(env.MAX_RETRIES, 2),
    timeZone: readString(env.TIME_ZONE, "Europe/Kiev"),
    logLevel: readString(env.LOG_LEVEL, "info")
  };

  const twitch = {
    clientId: readString(env.TWITCH_CLIENT_ID),
    clientSecret: readString(env.TWITCH_CLIENT_SECRET)
  };

  const telegramRequested = readBoolean(env.ENABLE_TELEGRAM, true);
  const discordRequested = readBoolean(env.ENABLE_DISCORD, true);

  const telegram = {
    enabled: telegramRequested && Boolean(readString(env.TELEGRAM_BOT_TOKEN) && readString(env.TELEGRAM_CHAT_ID)),
    botToken: readString(env.TELEGRAM_BOT_TOKEN),
    chatId: readString(env.TELEGRAM_CHAT_ID)
  };

  const discord = {
    enabled: discordRequested && Boolean(readString(env.DISCORD_WEBHOOK_URL)),
    webhookUrl: readString(env.DISCORD_WEBHOOK_URL),
    username: readString(env.DISCORD_USERNAME, "Wooflyaa Live Alerts"),
    avatarUrl: readString(
      env.DISCORD_AVATAR_URL,
      "https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png"
    )
  };

  const missing = [];
  if (!env.STATE_KV) {
    missing.push("STATE_KV binding");
  }
  if (!twitch.clientId) {
    missing.push("TWITCH_CLIENT_ID");
  }
  if (!twitch.clientSecret) {
    missing.push("TWITCH_CLIENT_SECRET");
  }
  if (streamers.length === 0) {
    missing.push("STREAMERS_JSON");
  }

  if (strict && missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  return {
    app,
    twitch,
    telegram,
    discord,
    streamers,
    missing
  };
}

function parseStreamers(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) {
    return [];
  }

  const parsed = JSON.parse(raw);
  const list = Array.isArray(parsed) ? parsed : parsed.streamers;
  if (!Array.isArray(list)) {
    throw new Error("STREAMERS_JSON must be a JSON array or an object with a streamers array.");
  }

  const seen = new Set();
  const result = [];

  for (let index = 0; index < list.length; index += 1) {
    const streamer = normalizeStreamer(list[index], index);
    if (seen.has(streamer.login)) {
      continue;
    }

    seen.add(streamer.login);
    result.push(streamer);
  }

  return result;
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
      accentColor: "#9146FF",
      profileImageUrl: ""
    };
  }

  if (!entry || typeof entry !== "object") {
    throw new Error(`Invalid streamer config at index ${index}.`);
  }

  const login = extractTwitchLogin(entry.login || entry.url);
  if (!login) {
    throw new Error(`Streamer config at index ${index} is missing login or url.`);
  }

  return {
    login,
    label: String(entry.label || entry.displayName || login).trim(),
    accentColor: String(entry.accentColor || "#9146FF").trim(),
    profileImageUrl: String(entry.profileImageUrl || "").trim()
  };
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

function readString(value, fallback = "") {
  return value === undefined || value === null ? fallback : String(value).trim();
}

function readNumber(value, fallback) {
  const parsed = Number.parseInt(readString(value), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readBoolean(value, fallback = false) {
  const raw = readString(value).toLowerCase();
  if (!raw) {
    return fallback;
  }

  return ["1", "true", "yes", "on"].includes(raw);
}

function createLogger(env) {
  const activeLevel = readString(env.LOG_LEVEL, "info").toLowerCase();

  function write(level, message, extra) {
    if ((LEVELS[level] || LEVELS.info) < (LEVELS[activeLevel] || LEVELS.info)) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      extra: extra === undefined ? null : serializeExtra(extra)
    };

    const line = JSON.stringify(entry);
    if (level === "error") {
      console.error(line);
      return;
    }
    if (level === "warn") {
      console.warn(line);
      return;
    }
    console.log(line);
  }

  return {
    debug(message, extra) {
      write("debug", message, extra);
    },
    info(message, extra) {
      write("info", message, extra);
    },
    warn(message, extra) {
      write("warn", message, extra);
    },
    error(message, extra) {
      write("error", message, extra);
    }
  };
}

function serializeExtra(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }

  return value;
}

class HttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.status = details.status;
    this.body = details.body;
    this.retryAfterMs = details.retryAfterMs;
  }
}

async function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10000,
    retries = 2,
    retryLabel = url,
    logger
  } = options;

  const normalizedHeaders = { ...headers };
  let payload = body;

  if (payload && typeof payload === "object" && !(payload instanceof URLSearchParams)) {
    if (!normalizedHeaders["Content-Type"]) {
      normalizedHeaders["Content-Type"] = "application/json";
    }
    payload = JSON.stringify(payload);
  }

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers: normalizedHeaders,
          body: payload,
          signal: controller.signal
        });

        const parsedBody = await parseResponseBody(response);
        if (!response.ok) {
          throw new HttpError(`${method} ${url} failed with status ${response.status}.`, {
            status: response.status,
            body: parsedBody,
            retryAfterMs: getRetryAfterMs(response.headers)
          });
        }

        return parsedBody;
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      retries,
      label: retryLabel,
      shouldRetry(error) {
        if (!error) {
          return false;
        }

        if (error.name === "AbortError" || error.name === "TypeError") {
          return true;
        }

        if (error instanceof HttpError) {
          return [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
        }

        return false;
      },
      onRetry({ attempt, delayMs, error, label }) {
        if (logger) {
          logger.warn(`Retrying ${label}.`, {
            attempt,
            delayMs,
            error: error.message,
            status: error.status
          });
        }
      }
    }
  );
}

async function parseResponseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(raw);
  }

  return raw;
}

function getRetryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const parsedDate = Date.parse(retryAfter);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return undefined;
}

async function withRetry(task, options = {}) {
  const {
    retries = 2,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    label = "operation",
    shouldRetry = () => true,
    onRetry
  } = options;

  let attempt = 0;

  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = Math.min(
        error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : baseDelayMs * 2 ** attempt,
        maxDelayMs
      );

      if (typeof onRetry === "function") {
        onRetry({
          label,
          attempt: attempt + 1,
          delayMs,
          error
        });
      }

      await sleep(delayMs);
      attempt += 1;
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureAccessToken(config, logger, forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && twitchTokenCache.accessToken && now < twitchTokenCache.expiresAt - 60_000) {
    return twitchTokenCache.accessToken;
  }

  const url = new URL("https://id.twitch.tv/oauth2/token");
  url.searchParams.set("client_id", config.twitch.clientId);
  url.searchParams.set("client_secret", config.twitch.clientSecret);
  url.searchParams.set("grant_type", "client_credentials");

  const data = await request(url.toString(), {
    method: "POST",
    timeoutMs: config.app.requestTimeoutMs,
    retries: config.app.maxRetries,
    retryLabel: "Twitch OAuth token",
    logger
  });

  twitchTokenCache = {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000
  };

  logger.info("Twitch app token refreshed.");
  return twitchTokenCache.accessToken;
}

async function helixRequest(config, resourcePath, params, logger) {
  const execute = async () => {
    const token = await ensureAccessToken(config, logger);
    const url = new URL(`https://api.twitch.tv/helix/${resourcePath}`);

    if (params instanceof URLSearchParams) {
      url.search = params.toString();
    } else if (Array.isArray(params)) {
      for (const [key, value] of params) {
        url.searchParams.append(key, value);
      }
    }

    return request(url.toString(), {
      method: "GET",
      headers: {
        "Client-Id": config.twitch.clientId,
        Authorization: `Bearer ${token}`
      },
      timeoutMs: config.app.requestTimeoutMs,
      retries: config.app.maxRetries,
      retryLabel: `Twitch ${resourcePath}`,
      logger
    });
  };

  try {
    return await execute();
  } catch (error) {
    if (error instanceof HttpError && error.status === 401) {
      logger.warn("Twitch token rejected, forcing refresh.");
      await ensureAccessToken(config, logger, true);
      return execute();
    }

    throw error;
  }
}

async function resolveStreamers(config, logger) {
  const cacheKey = JSON.stringify(config.streamers.map((streamer) => streamer.login));
  if (streamerCache.key === cacheKey && Date.now() < streamerCache.expiresAt) {
    return streamerCache.streamers;
  }

  const users = [];
  for (const batch of chunk(config.streamers.map((streamer) => streamer.login), 100)) {
    const params = new URLSearchParams();
    for (const login of batch) {
      params.append("login", login);
    }

    const response = await helixRequest(config, "users", params, logger);
    users.push(...response.data);
  }

  const usersByLogin = new Map(users.map((user) => [String(user.login).toLowerCase(), user]));
  const missing = config.streamers.filter((streamer) => !usersByLogin.has(streamer.login));
  if (missing.length > 0) {
    throw new Error(`Twitch users not found: ${missing.map((streamer) => streamer.login).join(", ")}`);
  }

  const resolved = config.streamers.map((streamer) => {
    const user = usersByLogin.get(streamer.login);

    return {
      ...streamer,
      userId: user.id,
      displayName: user.display_name || streamer.label,
      profileImageUrl: streamer.profileImageUrl || user.profile_image_url || "",
      channelUrl: buildTwitchUrl(user.login)
    };
  });

  streamerCache = {
    key: cacheKey,
    expiresAt: Date.now() + 6 * 60 * 60 * 1000,
    streamers: resolved
  };

  return resolved;
}

async function getLiveStreams(config, streamers, logger) {
  const liveByUserId = new Map();

  for (const batch of chunk(streamers.map((streamer) => streamer.userId), 100)) {
    const params = new URLSearchParams();
    for (const userId of batch) {
      params.append("user_id", userId);
    }

    const response = await helixRequest(config, "streams", params, logger);
    for (const stream of response.data) {
      liveByUserId.set(stream.user_id, {
        id: stream.id,
        title: stream.title || "Untitled stream",
        gameName: stream.game_name || "No category",
        startedAt: stream.started_at,
        thumbnailUrl: buildThumbnailUrl(stream.thumbnail_url),
        viewerCount: stream.viewer_count || 0,
        language: stream.language || "unknown"
      });
    }
  }

  return liveByUserId;
}

async function loadState(env) {
  const raw = await env.STATE_KV.get(STATE_KEY, { type: "json" });
  if (!raw || typeof raw !== "object") {
    return createDefaultState();
  }

  if (!raw.streamers || typeof raw.streamers !== "object") {
    raw.streamers = {};
  }

  return raw;
}

async function saveState(env, state) {
  await env.STATE_KV.put(STATE_KEY, JSON.stringify(state));
}

function createDefaultState() {
  return {
    version: 1,
    streamers: {}
  };
}

function createDefaultStreamerState(login) {
  return {
    login,
    isLive: false,
    currentStreamId: null,
    currentStreamStartedAt: null,
    lastOfflineAt: null,
    lastSeenTitle: null,
    lastSeenGame: null,
    notifications: {}
  };
}

function getStreamerEntry(state, login) {
  if (!state.streamers[login]) {
    state.streamers[login] = createDefaultStreamerState(login);
  }

  return state.streamers[login];
}

function markLive(state, login, stream) {
  const entry = getStreamerEntry(state, login);
  const changed =
    !entry.isLive ||
    entry.currentStreamId !== stream.id ||
    entry.lastSeenTitle !== stream.title ||
    entry.lastSeenGame !== stream.gameName;

  entry.isLive = true;
  entry.currentStreamId = stream.id;
  entry.currentStreamStartedAt = stream.startedAt;
  entry.lastSeenTitle = stream.title;
  entry.lastSeenGame = stream.gameName;

  return { entry, changed };
}

function markOffline(state, login) {
  const entry = getStreamerEntry(state, login);
  if (!entry.isLive && !entry.currentStreamId) {
    return { entry, changed: false };
  }

  entry.isLive = false;
  entry.currentStreamId = null;
  entry.currentStreamStartedAt = null;
  entry.lastOfflineAt = new Date().toISOString();

  return { entry, changed: true };
}

function wasNotified(state, login, channelName, streamId) {
  const entry = getStreamerEntry(state, login);
  return entry.notifications[channelName] && entry.notifications[channelName].lastNotifiedStreamId === streamId;
}

function markNotified(state, login, channelName, streamId) {
  const entry = getStreamerEntry(state, login);
  entry.notifications[channelName] = {
    lastNotifiedStreamId: streamId,
    lastNotifiedAt: new Date().toISOString()
  };
}

function createPayload(config, streamer, stream) {
  return {
    app: {
      name: config.app.name,
      timeZone: config.app.timeZone
    },
    streamer,
    stream: {
      ...stream,
      channelUrl: streamer.channelUrl
    }
  };
}

async function dispatchLiveAlert(payload, state, config, logger) {
  const channels = [];
  if (config.telegram.enabled) {
    channels.push({
      name: "telegram",
      send: () => sendTelegramAlert(payload, config, logger)
    });
  }
  if (config.discord.enabled) {
    channels.push({
      name: "discord",
      send: () => sendDiscordAlert(payload, config, logger)
    });
  }

  if (channels.length === 0) {
    if (!warnedNoChannels) {
      warnedNoChannels = true;
      logger.warn("No delivery channels enabled. Configure Telegram or Discord secrets.");
    }
    return [];
  }

  warnedNoChannels = false;

  const settled = await Promise.allSettled(
    channels.map(async (channel) => {
      if (wasNotified(state, payload.streamer.login, channel.name, payload.stream.id)) {
        return {
          channel: channel.name,
          delivered: false,
          skipped: true
        };
      }

      await channel.send();
      return {
        channel: channel.name,
        delivered: true,
        skipped: false
      };
    })
  );

  return settled.map((result, index) => {
    const channel = channels[index];
    if (result.status === "fulfilled") {
      return result.value;
    }

    logger.error(`Failed to deliver ${channel.name} alert.`, result.reason);
    return {
      channel: channel.name,
      delivered: false,
      skipped: false,
      error: result.reason
    };
  });
}

async function sendTelegramAlert(payload, config, logger) {
  const caption = [
    `<b>${escapeHtml(payload.streamer.displayName)} is live on Twitch</b>`,
    "",
    `<b>${escapeHtml(truncate(payload.stream.title, 220))}</b>`,
    `<b>Category:</b> ${escapeHtml(payload.stream.gameName)}`,
    `<b>Started:</b> ${escapeHtml(formatLocalDateTime(payload.stream.startedAt, payload.app.timeZone))}`,
    "",
    "Open the stream from the button below."
  ].join("\n");

  const replyMarkup = {
    inline_keyboard: [
      [
        {
          text: "Open Twitch",
          url: payload.stream.channelUrl
        }
      ]
    ]
  };

  if (payload.stream.thumbnailUrl) {
    try {
      await callTelegramApi("sendPhoto", {
        chat_id: config.telegram.chatId,
        photo: payload.stream.thumbnailUrl,
        caption,
        parse_mode: "HTML",
        reply_markup: replyMarkup
      }, config, logger);

      return;
    } catch (error) {
      logger.warn("Telegram sendPhoto failed, falling back to text message.", {
        error: error.message,
        streamer: payload.streamer.login
      });
    }
  }

  await callTelegramApi("sendMessage", {
    chat_id: config.telegram.chatId,
    text: caption,
    parse_mode: "HTML",
    disable_web_page_preview: false,
    reply_markup: replyMarkup
  }, config, logger);
}

async function sendDiscordAlert(payload, config, logger) {
  await request(config.discord.webhookUrl, {
    method: "POST",
    body: {
  username: config.discord.username,
  avatar_url: config.discord.avatarUrl,
  content: "@everyone",
  allowed_mentions: {
    parse: ["everyone"]
  },
  embeds: [
        {
          color: toDiscordColor(payload.streamer.accentColor),
          author: {
            name: `${payload.streamer.displayName} on Twitch`,
            url: payload.stream.channelUrl,
            icon_url: payload.streamer.profileImageUrl || config.discord.avatarUrl
          },
          title: `${payload.streamer.displayName} is live`,
          url: payload.stream.channelUrl,
          description: `**${truncate(payload.stream.title, 300)}**`,
          fields: [
            {
              name: "Category",
              value: payload.stream.gameName,
              inline: true
            },
            {
              name: "Started",
              value: formatLocalDateTime(payload.stream.startedAt, payload.app.timeZone),
              inline: true
            },
            {
              name: "Channel",
              value: `[Open Twitch](${payload.stream.channelUrl})`,
              inline: true
            }
          ],
          thumbnail: payload.streamer.profileImageUrl
            ? {
                url: payload.streamer.profileImageUrl
              }
            : undefined,
          image: payload.stream.thumbnailUrl
            ? {
                url: payload.stream.thumbnailUrl
              }
            : undefined,
          footer: {
            text: `${payload.app.name} - live alert`
          },
          timestamp: payload.stream.startedAt
        }
      ]
    },
    timeoutMs: config.app.requestTimeoutMs,
    retries: config.app.maxRetries,
    retryLabel: "Discord webhook",
    logger
  });
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildTwitchUrl(login) {
  return `https://www.twitch.tv/${login}`;
}

function buildThumbnailUrl(template, width = 1280, height = 720) {
  if (!template) {
    return "";
  }

  const resolved = template.replace("{width}", width).replace("{height}", height);
  const separator = resolved.includes("?") ? "&" : "?";
  return `${resolved}${separator}v=${Date.now()}`;
}

function formatLocalDateTime(value, timeZone) {
  if (!value) {
    return "unknown";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone
  }).format(new Date(value));
}

function toDiscordColor(hexColor, fallback = 0x9146ff) {
  const raw = String(hexColor || "").trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    return fallback;
  }

  return Number.parseInt(raw, 16);
}

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload, null, 2), {
    status: init.status || 200,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

async function callTelegramApi(method, body, config, logger) {
  const data = await request(`https://api.telegram.org/bot${config.telegram.botToken}/${method}`, {
    method: "POST",
    body,
    timeoutMs: config.app.requestTimeoutMs,
    retries: config.app.maxRetries,
    retryLabel: `Telegram ${method}`,
    logger
  });

  if (!data || data.ok !== true) {
    throw new Error(`Telegram ${method} returned a non-ok response.`);
  }

  return data.result;
}
