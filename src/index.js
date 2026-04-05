if (process.argv.includes("--mock")) {
  process.env.MOCK_MODE = "true";
}

const { loadConfig } = require("./config");
const { createLogger } = require("./utils/logger");
const { StateStore } = require("./modules/state-store");
const { TwitchClient } = require("./modules/twitch");
const { MockTwitchClient } = require("./modules/mock-twitch");
const { TelegramNotifier } = require("./modules/telegram");
const { DiscordNotifier } = require("./modules/discord");
const { NotificationDispatcher } = require("./modules/notifier");
const { StreamMonitor } = require("./modules/monitor");

async function main() {
  const config = loadConfig();
  const logger = createLogger({
    level: config.app.logLevel,
    filePath: config.app.logFile
  });

  logger.info("Starting Twitch notifier.", {
    appName: config.app.name,
    mockMode: config.app.mockMode,
    pollIntervalMs: config.app.pollIntervalMs,
    streamersConfigPath: config.app.streamersConfigPath,
    envFilePath: config.app.envFilePath
  });

  if (process.argv.includes("--validate")) {
    logger.info("Configuration is valid.", {
      streamers: config.streamers.map((streamer) => streamer.login),
      telegramEnabled: config.telegram.enabled,
      discordEnabled: config.discord.enabled,
      discordTestEnabled: config.discordTest.enabled
    });
    return;
  }

  const twitchClient = config.app.mockMode
    ? new MockTwitchClient(logger)
    : new TwitchClient(
        {
          clientId: config.twitch.clientId,
          clientSecret: config.twitch.clientSecret,
          requestTimeoutMs: config.app.requestTimeoutMs,
          maxRetries: config.app.maxRetries
        },
        logger
      );

  const telegramNotifier = new TelegramNotifier(
    {
      ...config.telegram,
      requestTimeoutMs: config.app.requestTimeoutMs,
      maxRetries: config.app.maxRetries
    },
    logger
  );

  const discordNotifier = new DiscordNotifier(
    {
      ...config.discord,
      name: "discord",
      requestTimeoutMs: config.app.requestTimeoutMs,
      maxRetries: config.app.maxRetries
    },
    logger
  );

  const discordTestNotifier = new DiscordNotifier(
    {
      ...config.discordTest,
      name: "discord_test",
      requestTimeoutMs: config.app.requestTimeoutMs,
      maxRetries: config.app.maxRetries
    },
    logger
  );

  const notifier = new NotificationDispatcher([telegramNotifier, discordNotifier, discordTestNotifier], logger);
  const stateStore = new StateStore(config.app.stateFile, logger);
  const monitor = new StreamMonitor({
    config,
    twitchClient,
    notifier,
    stateStore,
    logger
  });

  const shutdown = async (signal) => {
    logger.info(`Received ${signal}, shutting down.`);
    await monitor.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await monitor.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
