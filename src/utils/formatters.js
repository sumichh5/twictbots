function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function truncate(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function buildTwitchUrl(login) {
  return `https://www.twitch.tv/${login}`;
}

function withCacheBuster(url, seed = Date.now()) {
  if (!url) {
    return "";
  }

  return `${url}${url.includes("?") ? "&" : "?"}v=${seed}`;
}

function buildThumbnailUrl(template, width = 1280, height = 720) {
  if (!template) {
    return "";
  }

  const resolved = template.replace("{width}", width).replace("{height}", height);
  return withCacheBuster(resolved);
}

function formatLocalDateTime(value, timeZone) {
  if (!value) {
    return "неизвестно";
  }

  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone
  }).format(new Date(value));
}

function toDiscordColor(hexColor, fallback = 0x9146ff) {
  const raw = String(hexColor || "").trim().replace("#", "");
  if (!/^[0-9a-fA-F]{6}$/.test(raw)) {
    return fallback;
  }

  return Number.parseInt(raw, 16);
}

module.exports = {
  escapeHtml,
  truncate,
  buildTwitchUrl,
  buildThumbnailUrl,
  formatLocalDateTime,
  toDiscordColor
};
