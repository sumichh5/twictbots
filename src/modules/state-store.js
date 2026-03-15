const fs = require("fs");
const path = require("path");

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

class StateStore {
  constructor(filePath, logger) {
    this.filePath = filePath;
    this.logger = logger;
    this.state = createDefaultState();
    this.dirty = false;
  }

  load() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });

    if (!fs.existsSync(this.filePath)) {
      this.save();
      return;
    }

    const raw = fs.readFileSync(this.filePath, "utf8");
    if (!raw.trim()) {
      this.state = createDefaultState();
      this.dirty = true;
      this.save();
      return;
    }

    this.state = JSON.parse(raw);
    if (!this.state.streamers || typeof this.state.streamers !== "object") {
      this.state.streamers = {};
      this.dirty = true;
      this.save();
    }
  }

  save() {
    if (!this.dirty && fs.existsSync(this.filePath)) {
      return;
    }

    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.state, null, 2)}\n`, "utf8");
    this.dirty = false;
  }

  getStreamer(login) {
    if (!this.state.streamers[login]) {
      this.state.streamers[login] = createDefaultStreamerState(login);
      this.dirty = true;
    }

    return this.state.streamers[login];
  }

  markLive(login, stream) {
    const entry = this.getStreamer(login);
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
    this.dirty = this.dirty || changed;

    return { entry, changed };
  }

  markOffline(login) {
    const entry = this.getStreamer(login);
    if (!entry.isLive && !entry.currentStreamId) {
      return { entry, changed: false };
    }

    entry.isLive = false;
    entry.currentStreamId = null;
    entry.currentStreamStartedAt = null;
    entry.lastOfflineAt = new Date().toISOString();
    this.dirty = true;

    return { entry, changed: true };
  }

  wasNotified(login, channelName, streamId) {
    const entry = this.getStreamer(login);
    return entry.notifications[channelName] && entry.notifications[channelName].lastNotifiedStreamId === streamId;
  }

  markNotified(login, channelName, streamId) {
    const entry = this.getStreamer(login);
    entry.notifications[channelName] = {
      lastNotifiedStreamId: streamId,
      lastNotifiedAt: new Date().toISOString()
    };
    this.dirty = true;
  }
}

module.exports = {
  StateStore
};
