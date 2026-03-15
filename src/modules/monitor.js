class StreamMonitor {
  constructor({ config, twitchClient, notifier, stateStore, logger }) {
    this.config = config;
    this.twitchClient = twitchClient;
    this.notifier = notifier;
    this.stateStore = stateStore;
    this.logger = logger;
    this.streamers = [];
    this.timer = null;
    this.isRunning = false;
  }

  async init() {
    this.streamers = await this.twitchClient.resolveStreamers(this.config.streamers);
    this.logger.info("Loaded streamers.", {
      count: this.streamers.length,
      streamers: this.streamers.map((streamer) => streamer.login),
      mockMode: this.config.app.mockMode
    });
  }

  createPayload(streamer, stream) {
    return {
      app: {
        name: this.config.app.name,
        timeZone: this.config.app.timeZone
      },
      streamer,
      stream: {
        ...stream,
        channelUrl: streamer.channelUrl
      }
    };
  }

  async runCycle() {
    const liveByUserId = await this.twitchClient.getLiveStreams(this.streamers);

    for (const streamer of this.streamers) {
      const liveStream = liveByUserId.get(streamer.userId);

      if (!liveStream) {
        const { changed } = this.stateStore.markOffline(streamer.login);
        if (changed) {
          this.logger.info("Streamer went offline.", {
            streamer: streamer.login
          });
        }
        continue;
      }

      const { changed } = this.stateStore.markLive(streamer.login, liveStream);
      if (changed) {
        this.logger.info("Live stream detected.", {
          streamer: streamer.login,
          streamId: liveStream.id,
          title: liveStream.title
        });
      }

      const payload = this.createPayload(streamer, liveStream);
      const results = await this.notifier.dispatchLiveAlert(payload, this.stateStore);

      results.forEach((result) => {
        if (result.delivered) {
          this.stateStore.markNotified(streamer.login, result.channel, liveStream.id);
          this.stateStore.save();
          this.logger.info("Live alert sent.", {
            streamer: streamer.login,
            channel: result.channel,
            streamId: liveStream.id
          });
        }
      });
    }

    this.stateStore.save();
  }

  scheduleNextCycle() {
    if (!this.isRunning) {
      return;
    }

    this.timer = setTimeout(async () => {
      try {
        await this.runCycle();
      } catch (error) {
        this.logger.error("Polling cycle failed.", error);
      } finally {
        this.scheduleNextCycle();
      }
    }, this.config.app.pollIntervalMs);
  }

  async start() {
    this.stateStore.load();
    await this.init();
    this.isRunning = true;
    await this.runCycle();
    this.scheduleNextCycle();
  }

  async stop() {
    this.isRunning = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.stateStore.save();
  }
}

module.exports = {
  StreamMonitor
};
