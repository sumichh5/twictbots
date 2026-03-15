const { request } = require("../utils/http");
const { escapeHtml, formatLocalDateTime, truncate } = require("../utils/formatters");

class TelegramNotifier {
  constructor(config, logger) {
    this.name = "telegram";
    this.config = config;
    this.logger = logger;
  }

  isEnabled() {
    return this.config.enabled;
  }

  buildCaption(payload) {
    const startedAt = formatLocalDateTime(payload.stream.startedAt, payload.app.timeZone);

    return [
      `🔴 <b>${escapeHtml(payload.streamer.displayName)} вышел в эфир</b>`,
      "",
      `📝 <b>${escapeHtml(truncate(payload.stream.title, 220))}</b>`,
      `🎮 <b>Категория:</b> ${escapeHtml(payload.stream.gameName)}`,
      `🕒 <b>Старт:</b> ${escapeHtml(startedAt)}`,
      "",
      "Открывай стрим по кнопке ниже."
    ].join("\n");
  }

  async callApi(method, body) {
    const data = await request(`https://api.telegram.org/bot${this.config.botToken}/${method}`, {
      method: "POST",
      body,
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.maxRetries,
      retryLabel: `Telegram ${method}`,
      logger: this.logger
    });

    if (!data || data.ok !== true) {
      const error = new Error(`Telegram ${method} returned a non-ok response.`);
      if (data && data.parameters && Number.isFinite(data.parameters.retry_after)) {
        error.retryAfterMs = data.parameters.retry_after * 1000;
      }
      throw error;
    }

    return data.result;
  }

  async sendLiveAlert(payload) {
    const caption = this.buildCaption(payload);
    const replyMarkup = {
      inline_keyboard: [
        [
          {
            text: "Смотреть на Twitch",
            url: payload.stream.channelUrl
          }
        ]
      ]
    };

    if (payload.stream.thumbnailUrl) {
      try {
        await this.callApi("sendPhoto", {
          chat_id: this.config.chatId,
          photo: payload.stream.thumbnailUrl,
          caption,
          parse_mode: "HTML",
          reply_markup: replyMarkup
        });

        return;
      } catch (error) {
        this.logger.warn("Telegram sendPhoto failed, falling back to text message.", {
          error: error.message,
          streamer: payload.streamer.login
        });
      }
    }

    await this.callApi("sendMessage", {
      chat_id: this.config.chatId,
      text: caption,
      parse_mode: "HTML",
      disable_web_page_preview: false,
      reply_markup: replyMarkup
    });
  }
}

module.exports = {
  TelegramNotifier
};
