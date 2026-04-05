class NotificationDispatcher {
  constructor(notifiers, logger) {
    this.notifiers = notifiers;
    this.logger = logger;
    this.warnedNoChannels = false;
  }

  getEnabledNotifiers() {
    return this.notifiers.filter((notifier) => notifier.isEnabled());
  }

  async dispatchLiveAlert(payload, stateStore) {
    const enabled = this.getEnabledNotifiers();
    if (enabled.length === 0) {
      if (!this.warnedNoChannels) {
        this.logger.warn(
          "No delivery channels enabled. Configure Telegram, Discord, or DISCORD_TEST_WEBHOOK_URL."
        );
        this.warnedNoChannels = true;
      }
      return [];
    }

    this.warnedNoChannels = false;

    const pending = enabled.map(async (notifier) => {
      if (stateStore.wasNotified(payload.streamer.login, notifier.name, payload.stream.id)) {
        return {
          channel: notifier.name,
          delivered: false,
          skipped: true
        };
      }

      await notifier.sendLiveAlert(payload);

      return {
        channel: notifier.name,
        delivered: true,
        skipped: false
      };
    });

    const settled = await Promise.allSettled(pending);
    return settled.map((result, index) => {
      const notifier = enabled[index];
      if (result.status === "fulfilled") {
        return result.value;
      }

      this.logger.error(`Failed to deliver ${notifier.name} alert.`, result.reason);

      return {
        channel: notifier.name,
        delivered: false,
        skipped: false,
        error: result.reason
      };
    });
  }
}

module.exports = {
  NotificationDispatcher
};
