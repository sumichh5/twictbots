const { request, HttpError } = require("../utils/http");
const { buildThumbnailUrl, buildTwitchUrl } = require("../utils/formatters");

function chunk(items, size) {
  const result = [];
  for (let index = 0; index < items.length; index += size) {
    result.push(items.slice(index, index + size));
  }
  return result;
}

class TwitchClient {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.accessToken = null;
    this.expiresAt = 0;
  }

  async ensureAccessToken(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && this.accessToken && now < this.expiresAt - 60_000) {
      return this.accessToken;
    }

    const url = new URL("https://id.twitch.tv/oauth2/token");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("client_secret", this.config.clientSecret);
    url.searchParams.set("grant_type", "client_credentials");

    const data = await request(url.toString(), {
      method: "POST",
      timeoutMs: this.config.requestTimeoutMs,
      retries: this.config.maxRetries,
      retryLabel: "Twitch OAuth token",
      logger: this.logger
    });

    this.accessToken = data.access_token;
    this.expiresAt = Date.now() + data.expires_in * 1000;
    this.logger.info("Twitch app token refreshed.");

    return this.accessToken;
  }

  async helixRequest(resourcePath, params) {
    await this.ensureAccessToken();
    const url = new URL(`https://api.twitch.tv/helix/${resourcePath}`);

    if (params instanceof URLSearchParams) {
      url.search = params.toString();
    } else if (Array.isArray(params)) {
      params.forEach(([key, value]) => url.searchParams.append(key, value));
    }

    try {
      return await request(url.toString(), {
        method: "GET",
        headers: {
          "Client-Id": this.config.clientId,
          Authorization: `Bearer ${this.accessToken}`
        },
        timeoutMs: this.config.requestTimeoutMs,
        retries: this.config.maxRetries,
        retryLabel: `Twitch ${resourcePath}`,
        logger: this.logger
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401) {
        this.logger.warn("Twitch token rejected, forcing refresh.");
        await this.ensureAccessToken(true);

        return request(url.toString(), {
          method: "GET",
          headers: {
            "Client-Id": this.config.clientId,
            Authorization: `Bearer ${this.accessToken}`
          },
          timeoutMs: this.config.requestTimeoutMs,
          retries: this.config.maxRetries,
          retryLabel: `Twitch ${resourcePath} refresh`,
          logger: this.logger
        });
      }

      throw error;
    }
  }

  async resolveStreamers(streamers) {
    const logins = streamers.map((streamer) => streamer.login);
    const users = [];

    for (const batch of chunk(logins, 100)) {
      const params = new URLSearchParams();
      batch.forEach((login) => params.append("login", login));

      const response = await this.helixRequest("users", params);
      users.push(...response.data);
    }

    const usersByLogin = new Map(users.map((user) => [String(user.login).toLowerCase(), user]));
    const missing = logins.filter((login) => !usersByLogin.has(login));
    if (missing.length > 0) {
      throw new Error(`Twitch users not found: ${missing.join(", ")}`);
    }

    return streamers.map((streamer) => {
      const user = usersByLogin.get(streamer.login);

      return {
        ...streamer,
        userId: user.id,
        displayName: user.display_name || streamer.label,
        profileImageUrl: streamer.profileImageUrl || user.profile_image_url || "",
        channelUrl: buildTwitchUrl(user.login)
      };
    });
  }

  async getLiveStreams(streamers) {
    const liveByUserId = new Map();

    for (const batch of chunk(streamers.map((streamer) => streamer.userId), 100)) {
      const params = new URLSearchParams();
      batch.forEach((userId) => params.append("user_id", userId));

      const response = await this.helixRequest("streams", params);
      response.data.forEach((stream) => {
        liveByUserId.set(stream.user_id, {
          id: stream.id,
          title: stream.title || "Без названия",
          gameName: stream.game_name || "Без категории",
          startedAt: stream.started_at,
          thumbnailUrl: buildThumbnailUrl(stream.thumbnail_url),
          viewerCount: stream.viewer_count || 0,
          language: stream.language || "unknown"
        });
      });
    }

    return liveByUserId;
  }
}

module.exports = {
  TwitchClient
};
