function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(task, options = {}) {
  const {
    retries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 15000,
    label = "operation",
    shouldRetry = () => true,
    onRetry
  } = options;

  let attempt = 0;

  while (true) {
    try {
      return await task(attempt);
    } catch (error) {
      if (attempt >= retries || !shouldRetry(error)) {
        throw error;
      }

      const delayMs = Math.min(
        error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : baseDelayMs * 2 ** attempt,
        maxDelayMs
      );

      if (typeof onRetry === "function") {
        onRetry({
          label,
          attempt: attempt + 1,
          delayMs,
          error
        });
      }

      await sleep(delayMs);
      attempt += 1;
    }
  }
}

module.exports = {
  sleep,
  withRetry
};
