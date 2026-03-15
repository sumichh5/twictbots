const { withRetry } = require("./retry");

class HttpError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.status = details.status;
    this.body = details.body;
    this.headers = details.headers;
    this.retryAfterMs = details.retryAfterMs;
  }
}

function getRetryAfterMs(headers) {
  if (!headers || typeof headers.get !== "function") {
    return undefined;
  }

  const retryAfter = headers.get("retry-after");
  if (!retryAfter) {
    return undefined;
  }

  const seconds = Number.parseInt(retryAfter, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }

  const parsedDate = Date.parse(retryAfter);
  if (Number.isFinite(parsedDate)) {
    return Math.max(0, parsedDate - Date.now());
  }

  return undefined;
}

async function parseBody(response) {
  const contentType = response.headers.get("content-type") || "";
  const raw = await response.text();

  if (!raw) {
    return null;
  }

  if (contentType.includes("application/json")) {
    return JSON.parse(raw);
  }

  return raw;
}

function isRetriable(error) {
  if (!error) {
    return false;
  }

  if (error.name === "AbortError" || error.name === "TypeError") {
    return true;
  }

  if (error instanceof HttpError) {
    return [408, 409, 425, 429, 500, 502, 503, 504].includes(error.status);
  }

  return false;
}

async function request(url, options = {}) {
  const {
    method = "GET",
    headers = {},
    body,
    timeoutMs = 10000,
    retries = 3,
    retryLabel = url,
    logger
  } = options;

  const normalizedHeaders = { ...headers };
  let payload = body;

  if (payload && typeof payload === "object" && !(payload instanceof URLSearchParams) && !Buffer.isBuffer(payload)) {
    if (!normalizedHeaders["Content-Type"]) {
      normalizedHeaders["Content-Type"] = "application/json";
    }

    payload = JSON.stringify(payload);
  }

  return withRetry(
    async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(url, {
          method,
          headers: normalizedHeaders,
          body: payload,
          signal: controller.signal
        });

        const parsedBody = await parseBody(response);
        if (!response.ok) {
          throw new HttpError(`${method} ${url} failed with status ${response.status}.`, {
            status: response.status,
            body: parsedBody,
            headers: response.headers,
            retryAfterMs: getRetryAfterMs(response.headers)
          });
        }

        return parsedBody;
      } finally {
        clearTimeout(timeout);
      }
    },
    {
      retries,
      label: retryLabel,
      shouldRetry: isRetriable,
      onRetry: ({ attempt, delayMs, error, label }) => {
        if (logger) {
          logger.warn(`Retrying ${label}.`, {
            attempt,
            delayMs,
            error: error.message,
            status: error.status
          });
        }
      }
    }
  );
}

module.exports = {
  HttpError,
  request
};
