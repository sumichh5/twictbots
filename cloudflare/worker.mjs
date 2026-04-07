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
const DISCORD_TEST_CONFIG_PREFIX = "discord-test-config:v1:";
const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};
const EPHEMERAL_FLAG = 64;
const BUTTON_STYLE_PRIMARY = 1;
const BUTTON_STYLE_SECONDARY = 2;
const BUTTON_STYLE_DANGER = 4;
const COMPONENT_TYPE_ACTION_ROW = 1;
const COMPONENT_TYPE_BUTTON = 2;
const COMPONENT_TYPE_TEXT_INPUT = 4;
const INTERACTION_TYPE_PING = 1;
const INTERACTION_TYPE_APPLICATION_COMMAND = 2;
const INTERACTION_TYPE_MESSAGE_COMPONENT = 3;
const INTERACTION_TYPE_MODAL_SUBMIT = 5;
const INTERACTION_RESPONSE_PONG = 1;
const INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE = 4;
const INTERACTION_RESPONSE_UPDATE_MESSAGE = 7;
const INTERACTION_RESPONSE_MODAL = 9;
const ADMINISTRATOR_PERMISSION = 8n;
const MANAGE_GUILD_PERMISSION = 32n;

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

    if (url.pathname === "/discord/interactions" && request.method === "POST") {
      return handleDiscordInteractionRequest(request, env);
    }

    if (url.pathname === "/health") {
      return jsonResponse({
        ok: summary.ready,
        mode: "cloudflare-workers-cron",
        schedule: "* * * * *",
        ...summary
      });
    }

    if (url.pathname === "/test/discord") {
      return handleDiscordTestRequest(request, env);
    }

    if (url.pathname === "/test/discord/register-commands") {
      return handleDiscordCommandRegistrationRequest(request, env);
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
  const testSubscriptions = await loadDiscordTestSubscriptions(env);
  const monitorStreamers = mergeConfiguredStreamers(config.streamers, testSubscriptions);
  const resolutionConfig = {
    ...config,
    streamers: monitorStreamers
  };

  logger.info("Starting scheduled Twitch check.", {
    appName: config.app.name,
    streamers: config.streamers.map((streamer) => streamer.login),
    testSubscriptions: testSubscriptions.length,
    telegramEnabled: config.telegram.enabled,
    discordEnabled: config.discord.enabled,
    discordTestEnabled: config.discordTest.enabled
  });

  const state = await loadState(env);
  const resolvedStreamers = await resolveStreamers(resolutionConfig, logger);
  const resolvedStreamersByLogin = new Map(resolvedStreamers.map((streamer) => [streamer.login, streamer]));
  const liveByUserId = await getLiveStreams(resolutionConfig, resolvedStreamers, logger);

  let dirty = false;
  let delivered = 0;

  for (const configuredStreamer of config.streamers) {
    const streamer = resolvedStreamersByLogin.get(configuredStreamer.login);
    if (!streamer) {
      continue;
    }

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

  if (testSubscriptions.length > 0) {
    const subscriptionResult = await processDiscordTestSubscriptions(
      state,
      config,
      resolvedStreamersByLogin,
      liveByUserId,
      testSubscriptions,
      logger
    );

    dirty = dirty || subscriptionResult.dirty;
    delivered += subscriptionResult.delivered;
  }

  if (dirty) {
    await saveState(env, state);
  }

  logger.info("Scheduled Twitch check finished.", {
    checked: resolvedStreamers.length,
    delivered
  });
}

async function handleDiscordTestRequest(request, env) {
  const auth = authorizeTestRequest(request, env);
  if (!auth.ok) {
    return jsonResponse(
      {
        ok: false,
        message: auth.message
      },
      { status: auth.status }
    );
  }

  const logger = createLogger(env);
  const config = loadConfig(env, { strict: false });
  const url = new URL(request.url);
  const target = normalizeDiscordTestTarget(url.searchParams.get("channel"));

  if (!target) {
    return jsonResponse(
      {
        ok: false,
        message: "Invalid channel. Use main, test, or both."
      },
      { status: 400 }
    );
  }

  const payload = createManualDiscordTestPayload(config, {
    title: url.searchParams.get("title")
  });
  const results = await dispatchManualDiscordTest(target, payload, config, logger);

  return jsonResponse({
    ok: results.some((result) => result.delivered),
    target,
    results
  });
}

async function handleDiscordCommandRegistrationRequest(incomingRequest, env) {
  const auth = authorizeTestRequest(incomingRequest, env);
  if (!auth.ok) {
    return jsonResponse(
      {
        ok: false,
        message: auth.message
      },
      { status: auth.status }
    );
  }

  const logger = createLogger(env);
  const config = loadConfig(env, { strict: false });
  if (!isDiscordBotTestModeReady(config)) {
    return jsonResponse(
      {
        ok: false,
        message: "Discord bot test mode is not ready. Configure DISCORD_BOT_TOKEN, DISCORD_TEST_CHANNEL_ID, DISCORD_APPLICATION_ID, and DISCORD_PUBLIC_KEY."
      },
      { status: 503 }
    );
  }

  const url = new URL(incomingRequest.url);
  const scope = String(url.searchParams.get("scope") || "guild").trim().toLowerCase();
  const guildId = readString(url.searchParams.get("guild_id"), config.discordBotTestMode.testGuildId);
  if (scope !== "guild" && scope !== "global") {
    return jsonResponse(
      {
        ok: false,
        message: "Invalid scope. Use guild or global."
      },
      { status: 400 }
    );
  }

  if (scope === "guild" && !guildId) {
    return jsonResponse(
      {
        ok: false,
        message: "Guild scope requires DISCORD_TEST_GUILD_ID or ?guild_id=..."
      },
      { status: 400 }
    );
  }

  const endpoint =
    scope === "global"
      ? `https://discord.com/api/v10/applications/${config.discordBotTestMode.applicationId}/commands`
      : `https://discord.com/api/v10/applications/${config.discordBotTestMode.applicationId}/guilds/${guildId}/commands`;

  let commands;
  try {
    commands = await request(endpoint, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${config.discordTest.botToken}`
      },
      body: buildDiscordTestCommands(),
      timeoutMs: config.app.requestTimeoutMs,
      retries: config.app.maxRetries,
      retryLabel: "Discord command registration",
      logger
    });
  } catch (error) {
    logger.error("Discord command registration failed.", error);
    return jsonErrorResponse(error);
  }

  return jsonResponse({
    ok: true,
    scope,
    guildId: scope === "guild" ? guildId : null,
    commands: Array.isArray(commands)
      ? commands.map((command) => ({
          id: command.id,
          name: command.name,
          description: command.description
        }))
      : []
  });
}

async function handleDiscordInteractionRequest(request, env) {
  const logger = createLogger(env);
  const config = loadConfig(env, { strict: false });

  if (!config.discordBotTestMode.enabled) {
    return jsonResponse(
      {
        ok: false,
        message: "Discord bot test mode is disabled."
      },
      { status: 404 }
    );
  }

  const signature = request.headers.get("x-signature-ed25519");
  const timestamp = request.headers.get("x-signature-timestamp");
  const rawBody = await request.text();
  const isValid = await verifyDiscordInteractionSignature(
    rawBody,
    signature,
    timestamp,
    config.discordBotTestMode.publicKey
  );

  if (!isValid) {
    return new Response("Invalid Discord signature.", { status: 401 });
  }

  let interaction;
  try {
    interaction = JSON.parse(rawBody);
  } catch (error) {
    logger.error("Failed to parse Discord interaction payload.", error);
    return new Response("Invalid JSON payload.", { status: 400 });
  }

  try {
    if (interaction.type === INTERACTION_TYPE_PING) {
      return interactionResponse({
        type: INTERACTION_RESPONSE_PONG
      });
    }

    if (interaction.type === INTERACTION_TYPE_APPLICATION_COMMAND) {
      return handleDiscordApplicationCommand(interaction, env, config);
    }

    if (interaction.type === INTERACTION_TYPE_MESSAGE_COMPONENT) {
      return handleDiscordMessageComponent(interaction, env, config);
    }

    if (interaction.type === INTERACTION_TYPE_MODAL_SUBMIT) {
      return handleDiscordModalSubmit(interaction, env, config, logger);
    }

    return interactionMessage("Этот тип взаимодействия пока не поддерживается.");
  } catch (error) {
    logger.error("Discord interaction handling failed.", error);
    return interactionMessage("Не получилось обработать запрос. Попробуй ещё раз через пару секунд.");
  }
}

async function handleDiscordApplicationCommand(interaction, env, config) {
  if (interaction.data && interaction.data.name !== "testbot") {
    return interactionMessage("Неизвестная тестовая команда.");
  }

  if (!interaction.guild_id) {
    return interactionMessage("Тестовое меню доступно только внутри сервера Discord.");
  }

  if (!memberHasGuildSetupPermission(interaction)) {
    return interactionMessage("Для настройки нужен доступ Manage Server или Administrator.");
  }

  const existingConfig = await loadDiscordTestGuildConfig(env, interaction.guild_id);
  return interactionResponse({
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: EPHEMERAL_FLAG,
      ...buildDiscordTestMenuData(existingConfig, interaction.channel_id, "Тестовый режим настройки открыт.")
    }
  });
}

async function handleDiscordMessageComponent(interaction, env, config) {
  if (!interaction.guild_id) {
    return interactionMessage("Тестовое меню доступно только внутри сервера Discord.");
  }

  if (!memberHasGuildSetupPermission(interaction)) {
    return interactionMessage("Для настройки нужен доступ Manage Server или Administrator.");
  }

  const customId = String(interaction.data && interaction.data.custom_id ? interaction.data.custom_id : "");
  const existingConfig = await loadDiscordTestGuildConfig(env, interaction.guild_id);

  if (customId === "testbot:open_setup") {
    return interactionResponse({
      type: INTERACTION_RESPONSE_MODAL,
      data: buildDiscordSetupModal(existingConfig, interaction.channel_id)
    });
  }

  if (customId === "testbot:show_status") {
    return interactionResponse({
      type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
      data: buildDiscordTestMenuData(existingConfig, interaction.channel_id, "Статус обновлён.")
    });
  }

  if (customId === "testbot:disable") {
    await deleteDiscordTestGuildConfig(env, interaction.guild_id);
    return interactionResponse({
      type: INTERACTION_RESPONSE_UPDATE_MESSAGE,
      data: buildDiscordTestMenuData(null, interaction.channel_id, "Тестовая настройка для этого сервера отключена.")
    });
  }

  return interactionMessage("Неизвестная кнопка в тестовом меню.");
}

async function handleDiscordModalSubmit(interaction, env, config, logger) {
  if (!interaction.guild_id) {
    return interactionMessage("Тестовая настройка доступна только внутри сервера Discord.");
  }

  if (!memberHasGuildSetupPermission(interaction)) {
    return interactionMessage("Для настройки нужен доступ Manage Server или Administrator.");
  }

  const customId = String(interaction.data && interaction.data.custom_id ? interaction.data.custom_id : "");
  if (customId !== "testbot:setup_modal") {
    return interactionMessage("Неизвестная форма настройки.");
  }

  const values = readDiscordModalValues(interaction);
  const streamerInput = extractTwitchLogin(values.streamer_login);
  const mentionEveryone = parseYesNo(values.mention_everyone, config.discordTest.mentionEveryone);
  const channelId = normalizeDiscordChannelId(values.channel_id) || interaction.channel_id;

  if (!streamerInput) {
    return interactionMessage("Нужно указать Twitch login или ссылку на канал.");
  }

  if (!normalizeDiscordChannelId(channelId)) {
    return interactionMessage("ID Discord-канала выглядит неверно.");
  }

  const resolvedStreamer = await resolveSingleStreamer(streamerInput, config, logger);
  if (!resolvedStreamer) {
    return interactionMessage("Не смог найти такой Twitch-канал. Проверь login и попробуй снова.");
  }

  const savedConfig = {
    guildId: interaction.guild_id,
    guildName: interaction.guild && interaction.guild.name ? interaction.guild.name : "",
    channelId,
    streamerLogin: resolvedStreamer.login,
    streamerDisplayName: resolvedStreamer.displayName,
    mentionEveryone,
    updatedAt: new Date().toISOString(),
    updatedByUserId: getInteractionUserId(interaction)
  };

  await saveDiscordTestGuildConfig(env, interaction.guild_id, savedConfig);

  return interactionResponse({
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: EPHEMERAL_FLAG,
      ...buildDiscordTestMenuData(
        savedConfig,
        channelId,
        `Сохранено: отслеживаем ${resolvedStreamer.displayName} и шлём уведомления в <#${channelId}>.`
      )
    }
  });
}

function buildDiscordTestCommands() {
  return [
    {
      name: "testbot",
      description: "Открыть тестовое меню настройки Twitch-уведомлений",
      type: 1
    }
  ];
}

function buildDiscordTestMenuData(savedConfig, currentChannelId, notice = "") {
  const activeChannelId = savedConfig && savedConfig.channelId ? savedConfig.channelId : currentChannelId;
  const isConfigured = Boolean(savedConfig);

  return {
    embeds: [
      {
        color: 0xe11d48,
        title: "Тестовое меню Twitch-бота",
        description: notice || "Через это меню можно сохранить тестовую настройку сервера без влияния на основной прод-поток.",
        fields: [
          {
            name: "Режим",
            value: "Только TEST",
            inline: true
          },
          {
            name: "Twitch",
            value: isConfigured ? `\`${savedConfig.streamerLogin}\`` : "ещё не настроен",
            inline: true
          },
          {
            name: "Канал Discord",
            value: activeChannelId ? `<#${activeChannelId}>` : "текущий канал",
            inline: true
          },
          {
            name: "Пинг",
            value: isConfigured ? (savedConfig.mentionEveryone ? "@everyone" : "без пинга") : "по умолчанию",
            inline: true
          }
        ],
        footer: {
          text: isConfigured ? `Обновлено: ${formatLocalDateTime(savedConfig.updatedAt, "Europe/Kiev")}` : "Конфиг для сервера ещё не сохранён"
        }
      }
    ],
    components: [
      {
        type: COMPONENT_TYPE_ACTION_ROW,
        components: [
          buildButton("testbot:open_setup", "Настроить", BUTTON_STYLE_PRIMARY),
          buildButton("testbot:show_status", "Статус", BUTTON_STYLE_SECONDARY),
          buildButton("testbot:disable", "Отключить", BUTTON_STYLE_DANGER)
        ]
      }
    ]
  };
}

function buildDiscordSetupModal(savedConfig, currentChannelId) {
  return {
    custom_id: "testbot:setup_modal",
    title: "Настройка Twitch TEST",
    components: [
      buildTextInputRow("streamer_login", "Twitch login или ссылка", savedConfig ? savedConfig.streamerLogin : "wooflyaa"),
      buildTextInputRow(
        "channel_id",
        "ID канала Discord (пусто = текущий)",
        savedConfig && savedConfig.channelId ? savedConfig.channelId : currentChannelId,
        false
      ),
      buildTextInputRow(
        "mention_everyone",
        "Пинг everyone? yes / no",
        savedConfig && savedConfig.mentionEveryone ? "yes" : "no"
      )
    ]
  };
}

function buildButton(customId, label, style) {
  return {
    type: COMPONENT_TYPE_BUTTON,
    custom_id: customId,
    label,
    style
  };
}

function buildTextInputRow(customId, label, value, required = true) {
  return {
    type: COMPONENT_TYPE_ACTION_ROW,
    components: [
      {
        type: COMPONENT_TYPE_TEXT_INPUT,
        custom_id: customId,
        label,
        style: 1,
        required,
        value: String(value || "").slice(0, 100),
        max_length: 100
      }
    ]
  };
}

function interactionMessage(content) {
  return interactionResponse({
    type: INTERACTION_RESPONSE_CHANNEL_MESSAGE_WITH_SOURCE,
    data: {
      flags: EPHEMERAL_FLAG,
      content
    }
  });
}

function interactionResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

function memberHasGuildSetupPermission(interaction) {
  const permissions = BigInt(readString(interaction.member && interaction.member.permissions, "0"));
  return (permissions & ADMINISTRATOR_PERMISSION) !== 0n || (permissions & MANAGE_GUILD_PERMISSION) !== 0n;
}

function readDiscordModalValues(interaction) {
  const values = {};
  const rows = Array.isArray(interaction.data && interaction.data.components) ? interaction.data.components : [];

  for (const row of rows) {
    const components = Array.isArray(row.components) ? row.components : [];
    for (const component of components) {
      if (component && component.custom_id) {
        values[component.custom_id] = readString(component.value);
      }
    }
  }

  return values;
}

function normalizeDiscordChannelId(value) {
  const raw = readString(value);
  return /^\d{16,20}$/.test(raw) ? raw : "";
}

function parseYesNo(value, fallback = false) {
  const raw = readString(value).toLowerCase();
  if (!raw) {
    return fallback;
  }

  if (["1", "true", "yes", "y", "да", "on"].includes(raw)) {
    return true;
  }

  if (["0", "false", "no", "n", "нет", "off"].includes(raw)) {
    return false;
  }

  return fallback;
}

function getInteractionUserId(interaction) {
  return readString(
    interaction.member && interaction.member.user && interaction.member.user.id
      ? interaction.member.user.id
      : interaction.user && interaction.user.id
        ? interaction.user.id
        : ""
  );
}

async function verifyDiscordInteractionSignature(rawBody, signature, timestamp, publicKey) {
  const signatureHex = readString(signature);
  const timestampValue = readString(timestamp);
  const publicKeyHex = readString(publicKey);
  if (!signatureHex || !timestampValue || !publicKeyHex) {
    return false;
  }

  try {
    const encoder = new TextEncoder();
    const message = encoder.encode(`${timestampValue}${rawBody}`);
    const keyBytes = hexToBytes(publicKeyHex);
    const signatureBytes = hexToBytes(signatureHex);
    const cryptoKey = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);

    return crypto.subtle.verify({ name: "Ed25519" }, cryptoKey, signatureBytes, message);
  } catch (_error) {
    return false;
  }
}

function hexToBytes(value) {
  const normalized = readString(value).toLowerCase();
  const bytes = new Uint8Array(normalized.length / 2);

  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }

  return bytes;
}

function getDiscordTestGuildConfigKey(guildId) {
  return `${DISCORD_TEST_CONFIG_PREFIX}${guildId}`;
}

async function loadDiscordTestGuildConfig(env, guildId) {
  if (!env.STATE_KV || !guildId) {
    return null;
  }

  const stored = await env.STATE_KV.get(getDiscordTestGuildConfigKey(guildId), { type: "json" });
  return normalizeDiscordTestSubscriptionRecord(stored);
}

async function saveDiscordTestGuildConfig(env, guildId, config) {
  await env.STATE_KV.put(getDiscordTestGuildConfigKey(guildId), JSON.stringify(config));
}

async function deleteDiscordTestGuildConfig(env, guildId) {
  if (!env.STATE_KV || !guildId) {
    return;
  }

  await env.STATE_KV.delete(getDiscordTestGuildConfigKey(guildId));
}

async function loadDiscordTestSubscriptions(env) {
  if (!env.STATE_KV) {
    return [];
  }

  const result = [];
  let cursor;

  do {
    const page = await env.STATE_KV.list({
      prefix: DISCORD_TEST_CONFIG_PREFIX,
      cursor
    });

    for (const entry of page.keys) {
      const config = await env.STATE_KV.get(entry.name, { type: "json" });
      const normalized = normalizeDiscordTestSubscriptionRecord(config);
      if (normalized) {
        result.push(normalized);
      }
    }

    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);

  return result;
}

function normalizeDiscordTestSubscriptionRecord(value) {
  if (!value || typeof value !== "object") {
    return null;
  }

  const guildId = readString(value.guildId);
  const channelId = normalizeDiscordChannelId(value.channelId);
  const streamerLogin = extractTwitchLogin(value.streamerLogin);
  if (!guildId || !channelId || !streamerLogin) {
    return null;
  }

  return {
    guildId,
    guildName: readString(value.guildName),
    channelId,
    streamerLogin,
    streamerDisplayName: readString(value.streamerDisplayName, streamerLogin),
    mentionEveryone: Boolean(value.mentionEveryone),
    updatedAt: readString(value.updatedAt),
    updatedByUserId: readString(value.updatedByUserId)
  };
}

async function resolveSingleStreamer(login, config, logger) {
  try {
    const resolved = await resolveStreamers(
      {
        ...config,
        streamers: [
          {
            login,
            label: login,
            accentColor: "#E11D48",
            profileImageUrl: ""
          }
        ]
      },
      logger
    );

    return resolved[0] || null;
  } catch (error) {
    if (error && typeof error.message === "string" && error.message.startsWith("Twitch users not found:")) {
      return null;
    }

    throw error;
  }
}

function summarizeConfiguration(env) {
  try {
    const config = loadConfig(env, { strict: false });

    return {
      ready:
        config.missing.length === 0 &&
        (config.telegram.enabled || config.discord.enabled || config.discordTest.enabled),
      appName: config.app.name,
      streamers: config.streamers.map((streamer) => streamer.login),
      channels: {
        telegram: config.telegram.enabled,
        discord: config.discord.enabled,
        discordTest: config.discordTest.enabled
      },
      transports: {
        discord: config.discord.enabled ? config.discord.transport : "disabled",
        discordTest: config.discordTest.enabled ? config.discordTest.transport : "disabled"
      },
      features: {
        discordBotTestMode: config.discordBotTestMode.enabled,
        discordBotTestModeReady: isDiscordBotTestModeReady(config)
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
        discord: false,
        discordTest: false
      },
      transports: {
        discord: "disabled",
        discordTest: "disabled"
      },
      features: {
        discordBotTestMode: false,
        discordBotTestModeReady: false
      },
      stateKvBound: Boolean(env.STATE_KV),
      missing: [error.message]
    };
  }
}

function loadConfig(env, options = {}) {
  const strict = options.strict !== false;
  const streamers = parseStreamers(readString(env.STREAMERS_JSON, DEFAULT_STREAMERS_JSON));
  const defaultDiscordUsername = "Wooflyaa Live Alerts";
  const defaultDiscordAvatarUrl = "https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png";
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
  const discordWebhookUrl = readString(env.DISCORD_WEBHOOK_URL);
  const discordBotToken = readString(env.DISCORD_BOT_TOKEN);
  const discordChannelId = readString(env.DISCORD_CHANNEL_ID);
  const discordTransport = discordBotToken && discordChannelId ? "bot" : discordWebhookUrl ? "webhook" : "none";
  const discordTestWebhookUrl = readString(env.DISCORD_TEST_WEBHOOK_URL);
  const discordTestBotToken = readString(env.DISCORD_TEST_BOT_TOKEN, discordBotToken);
  const discordTestChannelId = readString(env.DISCORD_TEST_CHANNEL_ID);
  const discordTestTransport =
    discordTestBotToken && discordTestChannelId ? "bot" : discordTestWebhookUrl ? "webhook" : "none";
  const discordTestRequested = Boolean(
    discordTestWebhookUrl || readString(env.DISCORD_TEST_BOT_TOKEN) || discordTestChannelId
  );
  const discordBotTestMode = {
    enabled: readBoolean(env.ENABLE_DISCORD_BOT_TEST_MODE, false),
    applicationId: readString(env.DISCORD_APPLICATION_ID),
    publicKey: readString(env.DISCORD_PUBLIC_KEY),
    testGuildId: readString(env.DISCORD_TEST_GUILD_ID)
  };

  const telegram = {
    enabled: telegramRequested && Boolean(readString(env.TELEGRAM_BOT_TOKEN) && readString(env.TELEGRAM_CHAT_ID)),
    botToken: readString(env.TELEGRAM_BOT_TOKEN),
    chatId: readString(env.TELEGRAM_CHAT_ID)
  };

  const discord = {
    enabled: discordRequested && discordTransport !== "none",
    transport: discordTransport,
    webhookUrl: discordWebhookUrl,
    botToken: discordBotToken,
    channelId: discordChannelId,
    mentionEveryone: readBoolean(env.DISCORD_MENTION_EVERYONE, false),
    username: readString(env.DISCORD_USERNAME, defaultDiscordUsername),
    avatarUrl: readString(env.DISCORD_AVATAR_URL, defaultDiscordAvatarUrl),
    requestTimeoutMs: app.requestTimeoutMs,
    maxRetries: app.maxRetries,
    footerLabel: "live alert",
    variant: "default"
  };

  const discordTest = {
    enabled: discordTestTransport !== "none",
    transport: discordTestTransport,
    webhookUrl: discordTestWebhookUrl,
    botToken: discordTestBotToken,
    channelId: discordTestChannelId,
    mentionEveryone: readBoolean(env.DISCORD_TEST_MENTION_EVERYONE, false),
    username: readString(
      env.DISCORD_TEST_USERNAME,
      `${readString(env.DISCORD_USERNAME, defaultDiscordUsername)} ТЕСТ`
    ),
    avatarUrl: readString(env.DISCORD_TEST_AVATAR_URL, readString(env.DISCORD_AVATAR_URL, defaultDiscordAvatarUrl)),
    gifUrl: readString(
      env.DISCORD_TEST_GIF_URL,
      "https://media1.giphy.com/media/v1.Y2lkPTc5MGI3NjExcjRlYWN6aXZsYnZycTdnN2M4bGI3OXd2c2NkNmltNmpvc2F2Y3F4NyZlcD12MV9pbnRlcm5hbF9naWZfYnlfaWQmY3Q9Zw/HSyR7A954pdC4w6PHa/giphy.gif"
    ),
    requestTimeoutMs: app.requestTimeoutMs,
    maxRetries: app.maxRetries,
    footerLabel: readString(env.DISCORD_TEST_FOOTER_LABEL, "тестовое уведомление"),
    variant: "test"
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
  if (discordRequested && !discord.enabled) {
    missing.push("DISCORD_WEBHOOK_URL or DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID");
  }
  if (discordTestRequested && !discordTest.enabled) {
    missing.push("DISCORD_TEST_WEBHOOK_URL or DISCORD_TEST_BOT_TOKEN/DISCORD_BOT_TOKEN + DISCORD_TEST_CHANNEL_ID");
  }
  if (strict && missing.length > 0) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  return {
    app,
    twitch,
    telegram,
    discord,
    discordTest,
    discordBotTestMode,
    streamers,
    missing
  };
}

function authorizeTestRequest(request, env) {
  const expectedToken = readString(env.TEST_TRIGGER_TOKEN);
  if (!expectedToken) {
    return {
      ok: false,
      status: 503,
      message: "TEST_TRIGGER_TOKEN is not configured."
    };
  }

  const url = new URL(request.url);
  const bearerToken = readBearerToken(request.headers.get("authorization"));
  const providedToken =
    url.searchParams.get("token") || request.headers.get("x-test-token") || bearerToken || "";

  if (!providedToken) {
    return {
      ok: false,
      status: 401,
      message: "Missing test token."
    };
  }

  if (providedToken !== expectedToken) {
    return {
      ok: false,
      status: 403,
      message: "Invalid test token."
    };
  }

  return {
    ok: true,
    status: 200,
    message: "Authorized."
  };
}

function readBearerToken(value) {
  const raw = String(value || "").trim();
  if (!raw.toLowerCase().startsWith("bearer ")) {
    return "";
  }

  return raw.slice(7).trim();
}

function normalizeDiscordTestTarget(value) {
  const normalized = String(value || "test").trim().toLowerCase();
  if (normalized === "main" || normalized === "discord") {
    return "main";
  }
  if (normalized === "test" || normalized === "discord_test") {
    return "test";
  }
  if (normalized === "both") {
    return "both";
  }

  return "";
}

function createManualDiscordTestPayload(config, options = {}) {
  const sourceStreamer = config.streamers[0];
  const login = sourceStreamer ? sourceStreamer.login : "wooflyaa";
  const displayName = sourceStreamer ? sourceStreamer.label || sourceStreamer.login : "Wooflyaa";
  const channelUrl = buildTwitchUrl(login);
  const startedAt = new Date().toISOString();

  return {
    app: {
      name: config.app.name,
      timeZone: config.app.timeZone
    },
    streamer: {
      login,
      displayName,
      accentColor: sourceStreamer ? sourceStreamer.accentColor : "#E11D48",
      profileImageUrl: sourceStreamer ? sourceStreamer.profileImageUrl || "" : "",
      channelUrl
    },
    stream: {
      id: `manual-test-${Date.now()}`,
      title: String(options.title || "Проверка оформления уведомления").trim(),
      gameName: "Тестовый запуск",
      startedAt,
      thumbnailUrl: "",
      viewerCount: 1,
      language: "ru",
      channelUrl
    }
  };
}

async function dispatchManualDiscordTest(target, payload, config, logger) {
  const channels = [];

  if ((target === "main" || target === "both") && config.discord.enabled) {
    channels.push({
      name: "discord",
      send: () => sendDiscordAlert(payload, config.discord, logger)
    });
  }

  if ((target === "test" || target === "both") && config.discordTest.enabled) {
    channels.push({
      name: "discord_test",
      send: () => sendDiscordAlert(payload, config.discordTest, logger)
    });
  }

  if (channels.length === 0) {
    return [
      {
        channel: target,
        delivered: false,
        message: "Requested Discord channel is not configured."
      }
    ];
  }

  const settled = await Promise.allSettled(
    channels.map(async (channel) => {
      await channel.send();
      return {
        channel: channel.name,
        delivered: true
      };
    })
  );

  return settled.map((result, index) => {
    const channel = channels[index];
    if (result.status === "fulfilled") {
      return result.value;
    }

    logger.error(`Manual test delivery failed for ${channel.name}.`, result.reason);
    return {
      channel: channel.name,
      delivered: false,
      message: result.reason && result.reason.message ? result.reason.message : "Unknown error."
    };
  });
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
  if (!raw.subscriptions || typeof raw.subscriptions !== "object") {
    raw.subscriptions = {};
  }

  return raw;
}

async function saveState(env, state) {
  await env.STATE_KV.put(STATE_KEY, JSON.stringify(state));
}

function createDefaultState() {
  return {
    version: 1,
    streamers: {},
    subscriptions: {}
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

function getSubscriptionEntry(state, subscriptionKey, login) {
  if (!state.subscriptions[subscriptionKey]) {
    state.subscriptions[subscriptionKey] = createDefaultStreamerState(login);
  }

  return state.subscriptions[subscriptionKey];
}

function markSubscriptionLive(state, subscriptionKey, login, stream) {
  const entry = getSubscriptionEntry(state, subscriptionKey, login);
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

function markSubscriptionOffline(state, subscriptionKey, login) {
  const entry = getSubscriptionEntry(state, subscriptionKey, login);
  if (!entry.isLive && !entry.currentStreamId) {
    return { entry, changed: false };
  }

  entry.isLive = false;
  entry.currentStreamId = null;
  entry.currentStreamStartedAt = null;
  entry.lastOfflineAt = new Date().toISOString();

  return { entry, changed: true };
}

function wasSubscriptionNotified(state, subscriptionKey, channelName, streamId) {
  const entry = getSubscriptionEntry(state, subscriptionKey, "");
  return entry.notifications[channelName] && entry.notifications[channelName].lastNotifiedStreamId === streamId;
}

function markSubscriptionNotified(state, subscriptionKey, login, channelName, streamId) {
  const entry = getSubscriptionEntry(state, subscriptionKey, login);
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

function isDiscordBotTestModeReady(config) {
  return Boolean(
    config.discordBotTestMode &&
      config.discordBotTestMode.enabled &&
      config.discordBotTestMode.applicationId &&
      config.discordBotTestMode.publicKey &&
      config.discordTest.botToken
  );
}

function mergeConfiguredStreamers(baseStreamers, subscriptions) {
  const seen = new Set();
  const result = [];

  for (const streamer of baseStreamers) {
    if (seen.has(streamer.login)) {
      continue;
    }

    seen.add(streamer.login);
    result.push(streamer);
  }

  for (const subscription of subscriptions) {
    if (!subscription || seen.has(subscription.streamerLogin)) {
      continue;
    }

    seen.add(subscription.streamerLogin);
    result.push({
      login: subscription.streamerLogin,
      label: subscription.streamerDisplayName || subscription.streamerLogin,
      accentColor: "#E11D48",
      profileImageUrl: ""
    });
  }

  return result;
}

function buildDiscordTestSubscriptionKey(subscription) {
  return `discord-test:${subscription.guildId}:${subscription.streamerLogin}`;
}

function createDiscordTestSubscriptionChannelConfig(config, subscription) {
  return {
    ...config.discordTest,
    enabled: true,
    transport: "bot",
    channelId: subscription.channelId,
    mentionEveryone: subscription.mentionEveryone
  };
}

async function processDiscordTestSubscriptions(
  state,
  config,
  resolvedStreamersByLogin,
  liveByUserId,
  subscriptions,
  logger
) {
  if (!isDiscordBotTestModeReady(config) || subscriptions.length === 0) {
    return {
      dirty: false,
      delivered: 0
    };
  }

  let dirty = false;
  let delivered = 0;

  for (const subscription of subscriptions) {
    const streamer = resolvedStreamersByLogin.get(subscription.streamerLogin);
    if (!streamer) {
      logger.warn("Skipping Discord test subscription because streamer resolution failed.", {
        guildId: subscription.guildId,
        streamer: subscription.streamerLogin
      });
      continue;
    }

    const subscriptionKey = buildDiscordTestSubscriptionKey(subscription);
    const liveStream = liveByUserId.get(streamer.userId);

    if (!liveStream) {
      const offline = markSubscriptionOffline(state, subscriptionKey, subscription.streamerLogin);
      dirty = dirty || offline.changed;
      continue;
    }

    const live = markSubscriptionLive(state, subscriptionKey, subscription.streamerLogin, liveStream);
    dirty = dirty || live.changed;
    if (live.changed) {
      logger.info("Live stream detected for Discord test subscription.", {
        guildId: subscription.guildId,
        channelId: subscription.channelId,
        streamer: subscription.streamerLogin,
        streamId: liveStream.id
      });
    }

    if (wasSubscriptionNotified(state, subscriptionKey, "discord_test_public", liveStream.id)) {
      continue;
    }

    const payload = createPayload(config, streamer, liveStream);

    try {
      await sendDiscordAlert(payload, createDiscordTestSubscriptionChannelConfig(config, subscription), logger);
      markSubscriptionNotified(state, subscriptionKey, subscription.streamerLogin, "discord_test_public", liveStream.id);
      dirty = true;
      delivered += 1;
      logger.info("Discord test subscription alert sent.", {
        guildId: subscription.guildId,
        channelId: subscription.channelId,
        streamer: subscription.streamerLogin,
        streamId: liveStream.id
      });
    } catch (error) {
      logger.error("Failed to deliver Discord test subscription alert.", {
        guildId: subscription.guildId,
        channelId: subscription.channelId,
        streamer: subscription.streamerLogin,
        error: error.message
      });
    }
  }

  return {
    dirty,
    delivered
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
      send: () => sendDiscordAlert(payload, config.discord, logger)
    });
  }
  if (config.discordTest.enabled) {
    channels.push({
      name: "discord_test",
      send: () => sendDiscordAlert(payload, config.discordTest, logger)
    });
  }

  if (channels.length === 0) {
    if (!warnedNoChannels) {
      warnedNoChannels = true;
      logger.warn("No delivery channels enabled. Configure Telegram, Discord webhook/bot, or the test Discord mirror.");
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

async function sendDiscordAlert(payload, channelConfig, logger) {
  const mentionEveryone = channelConfig.mentionEveryone === true;
  const message = buildDiscordMessage(payload, channelConfig, mentionEveryone);

  if (channelConfig.transport === "bot") {
    await request(`https://discord.com/api/v10/channels/${channelConfig.channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${channelConfig.botToken}`
      },
      body: message,
      timeoutMs: channelConfig.requestTimeoutMs,
      retries: channelConfig.maxRetries,
      retryLabel: "Discord bot API",
      logger
    });

    return;
  }

  await request(channelConfig.webhookUrl, {
    method: "POST",
    body: {
      username: channelConfig.username,
      avatar_url: channelConfig.avatarUrl,
      ...message
    },
    timeoutMs: channelConfig.requestTimeoutMs,
    retries: channelConfig.maxRetries,
    retryLabel: "Discord webhook",
    logger
  });
}

function buildDiscordMessage(payload, channelConfig, mentionEveryone) {
  return {
    content: buildDiscordMessageContent(channelConfig, mentionEveryone),
    allowed_mentions: {
      parse: mentionEveryone ? ["everyone"] : []
    },
    embeds: buildDiscordEmbeds(payload, channelConfig)
  };
}

function buildDiscordMessageContent(channelConfig, mentionEveryone) {
  return mentionEveryone ? "@everyone" : undefined;
}

function buildDiscordEmbeds(payload, channelConfig) {
  const startedAtLabel = formatLocalDateTime(payload.stream.startedAt, payload.app.timeZone);

  if (channelConfig.variant === "test") {
    return buildTestDiscordEmbeds(payload, channelConfig, startedAtLabel);
  }

  return [buildDefaultDiscordEmbed(payload, channelConfig, startedAtLabel)];
}

function buildDefaultDiscordEmbed(payload, channelConfig, startedAtLabel) {
  return {
    color: toDiscordColor(payload.streamer.accentColor),
    author: {
      name: `${payload.streamer.displayName} • Twitch`,
      url: payload.stream.channelUrl,
      icon_url: payload.streamer.profileImageUrl || channelConfig.avatarUrl
    },
    title: `🔴 ${payload.streamer.displayName} вышел в эфир`,
    url: payload.stream.channelUrl,
    description: `**${truncate(payload.stream.title, 300)}**`,
    fields: [
      {
        name: "Категория",
        value: payload.stream.gameName,
        inline: true
      },
      {
        name: "Начало",
        value: startedAtLabel,
        inline: true
      },
      {
        name: "Ссылка",
        value: `[Открыть Twitch](${payload.stream.channelUrl})`,
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
      text: `${payload.app.name} • уведомление о стриме`
    },
    timestamp: payload.stream.startedAt
  };
}

function buildTestDiscordEmbeds(payload, channelConfig, startedAtLabel) {
  const previewImageUrl = channelConfig.gifUrl || payload.stream.thumbnailUrl;

  return [
    {
      color: toDiscordColor(payload.streamer.accentColor, 0xe11d48),
      author: {
        name: `${payload.streamer.displayName} • тестовый канал`,
        url: payload.stream.channelUrl,
        icon_url: payload.streamer.profileImageUrl || channelConfig.avatarUrl
      },
      title: `Сейчас в эфире: ${payload.streamer.displayName}`,
      url: payload.stream.channelUrl,
      description: [
        `> ${truncate(payload.stream.title, 220)}`,
        "",
        "Тестовая копия боевого уведомления отправлена в отдельный канал.",
        "",
        `[Смотреть на Twitch](${payload.stream.channelUrl})`
      ].join("\n"),
      fields: [
        {
          name: "Категория",
          value: payload.stream.gameName,
          inline: true
        },
        {
          name: "Начало",
          value: startedAtLabel,
          inline: true
        },
        {
          name: "Статус",
          value: "Тест • @everyone",
          inline: true
        }
      ],
      image: previewImageUrl
        ? {
            url: previewImageUrl
          }
        : undefined,
      footer: {
        text: `${payload.app.name} • тестовый прогон`
      },
      timestamp: payload.stream.startedAt
    }
  ];
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

function jsonErrorResponse(error, fallbackStatus = 500) {
  const status =
    error && Number.isFinite(error.status) && error.status >= 400 && error.status <= 599
      ? error.status
      : fallbackStatus;

  return jsonResponse(
    {
      ok: false,
      error: error && error.message ? error.message : "Unknown error.",
      status,
      details: error && "body" in error ? error.body : null
    },
    { status }
  );
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
