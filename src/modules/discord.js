const { request } = require("../utils/http");
const { formatLocalDateTime, toDiscordColor, truncate } = require("../utils/formatters");

class DiscordNotifier {
  constructor(config, logger) {
    this.name = "discord";
    this.config = config;
    this.logger = logger;
  }

  isEnabled() {
    return this.config.enabled;
  }

  buildEmbed(payload) {
    const startedAtLabel = formatLocalDateTime(payload.stream.startedAt, payload.app.timeZone);

    return {
      color: toDiscordColor(payload.streamer.accentColor),
      author: {
        name: `${payload.streamer.displayName} on Twitch`,
        url: payload.stream.channelUrl,
        icon_url: payload.streamer.profileImageUrl || this.config.avatarUrl
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
          name: "Старт",
          value: startedAtLabel,
          inline: true
        },
        {
          name: "Канал",
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
        text: `${payload.app.name} • live alert`
      },
      timestamp: payload.stream.startedAt
    };
  }

  async sendLiveAlert(payload) {
    await request(this.config.webhookUrl, {
      method: "POST",
      body: {
        username: this.config.username,
        avatar_url: this.config.avatarUrl,
        allowed_mentions: {
          parse: []
        },
        embeds: [this.buildEmbed(payload)]
      },
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.maxRetries,
      retryLabel: "Discord webhook",
      logger: this.logger
    });
  }
}

module.exports = {
  DiscordNotifier
};
