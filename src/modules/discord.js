const { request } = require("../utils/http");
const { formatLocalDateTime, toDiscordColor, truncate } = require("../utils/formatters");

class DiscordNotifier {
  constructor(config, logger) {
    this.name = config.name || "discord";
    this.config = config;
    this.logger = logger;
  }

  isEnabled() {
    return this.config.enabled;
  }

  isTestVariant() {
    return this.config.variant === "test";
  }

  buildEmbeds(payload) {
    const startedAtLabel = formatLocalDateTime(payload.stream.startedAt, payload.app.timeZone);

    if (this.isTestVariant()) {
      return [this.buildTestEmbed(payload, startedAtLabel)];
    }

    return [this.buildDefaultEmbed(payload, startedAtLabel)];
  }

  buildDefaultEmbed(payload, startedAtLabel) {
    return {
      color: toDiscordColor(payload.streamer.accentColor),
      author: {
        name: `${payload.streamer.displayName} • Twitch`,
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

  buildTestEmbed(payload, startedAtLabel) {
    const previewImageUrl = payload.stream.thumbnailUrl || this.config.gifUrl;

    return {
      color: toDiscordColor(payload.streamer.accentColor, 0xe11d48),
      author: {
        name: `${payload.streamer.displayName} • тестовый канал`,
        url: payload.stream.channelUrl,
        icon_url: payload.streamer.profileImageUrl || this.config.avatarUrl
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
    };
  }

  buildMessageContent(mentionEveryone) {
    return mentionEveryone ? "@everyone" : undefined;
  }

  buildMessage(payload, mentionEveryone) {
    return {
      content: this.buildMessageContent(mentionEveryone),
      allowed_mentions: {
        parse: mentionEveryone ? ["everyone"] : []
      },
      embeds: this.buildEmbeds(payload)
    };
  }

  async sendViaWebhook(message) {
    await request(this.config.webhookUrl, {
      method: "POST",
      body: {
        username: this.config.username,
        avatar_url: this.config.avatarUrl,
        ...message
      },
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.maxRetries,
      retryLabel: "Discord webhook",
      logger: this.logger
    });
  }

  async sendViaBot(message) {
    await request(`https://discord.com/api/v10/channels/${this.config.channelId}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bot ${this.config.botToken}`
      },
      body: message,
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.maxRetries,
      retryLabel: "Discord bot API",
      logger: this.logger
    });
  }

  async sendLiveAlert(payload) {
    const mentionEveryone = this.config.mentionEveryone === true;
    const message = this.buildMessage(payload, mentionEveryone);

    if (this.config.transport === "bot") {
      await this.sendViaBot(message);
      return;
    }

    await this.sendViaWebhook(message);
  }
}

module.exports = {
  DiscordNotifier
};
