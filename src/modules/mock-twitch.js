const { buildTwitchUrl } = require("../utils/formatters");

const MOCK_GAMES = [
  "Just Chatting",
  "VALORANT",
  "Counter-Strike 2",
  "League of Legends",
  "Escape from Tarkov"
];

const MOCK_TITLES = [
  "Вечерний стрим и живое общение",
  "Рейтинговые катки без остановки",
  "Разбор обновления и новые билды",
  "Играем, тестируем, общаемся",
  "Лайв с чатом и быстрыми катками"
];

class MockTwitchClient {
  constructor(logger) {
    this.logger = logger;
    this.tick = 0;
    this.runtime = new Map();
  }

  async resolveStreamers(streamers) {
    return streamers.map((streamer, index) => ({
      ...streamer,
      userId: `mock-user-${index + 1}`,
      displayName: streamer.label || streamer.login,
      profileImageUrl:
        streamer.profileImageUrl ||
        "https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png",
      channelUrl: buildTwitchUrl(streamer.login)
    }));
  }

  async getLiveStreams(streamers) {
    this.tick += 1;
    const liveByUserId = new Map();

    streamers.forEach((streamer, index) => {
      const runtime = this.runtime.get(streamer.userId) || {
        isLive: false,
        generation: 0,
        streamId: null,
        title: null,
        gameName: null,
        startedAt: null
      };

      const phase = (this.tick + index) % 6;
      const shouldBeLive = phase >= 1 && phase <= 3;

      if (shouldBeLive && !runtime.isLive) {
        runtime.generation += 1;
        runtime.streamId = `mock-${streamer.login}-${runtime.generation}`;
        runtime.title = MOCK_TITLES[(runtime.generation + index) % MOCK_TITLES.length];
        runtime.gameName = MOCK_GAMES[(runtime.generation + index) % MOCK_GAMES.length];
        runtime.startedAt = new Date().toISOString();
      }

      if (!shouldBeLive) {
        runtime.streamId = null;
        runtime.title = null;
        runtime.gameName = null;
        runtime.startedAt = null;
      }

      runtime.isLive = shouldBeLive;
      this.runtime.set(streamer.userId, runtime);

      if (shouldBeLive) {
        liveByUserId.set(streamer.userId, {
          id: runtime.streamId,
          title: runtime.title,
          gameName: runtime.gameName,
          startedAt: runtime.startedAt,
          thumbnailUrl: "https://static-cdn.jtvnw.net/ttv-static/404_preview-640x360.jpg",
          viewerCount: 100 + runtime.generation * 17 + index * 8,
          language: "ru"
        });
      }
    });

    return liveByUserId;
  }
}

module.exports = {
  MockTwitchClient
};
