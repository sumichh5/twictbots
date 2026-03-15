const fs = require("fs");
const path = require("path");

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function safeSerialize(extra) {
  if (extra === undefined) {
    return undefined;
  }

  if (extra instanceof Error) {
    return {
      name: extra.name,
      message: extra.message,
      stack: extra.stack
    };
  }

  return extra;
}

function createLogger({ level = "info", filePath }) {
  const activeLevel = LEVELS[level] ? level : "info";
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  function write(logLevel, message, extra) {
    if (LEVELS[logLevel] < LEVELS[activeLevel]) {
      return;
    }

    const entry = {
      timestamp: new Date().toISOString(),
      level: logLevel,
      message,
      extra: safeSerialize(extra)
    };

    fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");

    const line = `[${entry.timestamp}] ${logLevel.toUpperCase()} ${message}`;
    if (logLevel === "error") {
      console.error(line, entry.extra || "");
      return;
    }

    if (logLevel === "warn") {
      console.warn(line, entry.extra || "");
      return;
    }

    console.log(line, entry.extra || "");
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

module.exports = {
  createLogger
};
