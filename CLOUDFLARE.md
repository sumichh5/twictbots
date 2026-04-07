# Cloudflare Worker deploy

This repository now includes a Cloudflare Workers version of the Twitch notifier.

What changed:

- `cloudflare/worker.mjs` runs the Twitch check on a cron trigger.
- `wrangler.toml` schedules the check every minute.
- `STATE_KV` stores notification state instead of `data/state.json`.

## Recommended deploy path

1. Open Cloudflare `Workers & Pages`.
2. Select `Create application`.
3. Select `Import a repository`.
4. Pick this GitHub repository.
5. Save and deploy.

Cloudflare Workers Builds can deploy from GitHub and the `[[kv_namespaces]]` binding in `wrangler.toml` can be auto-provisioned during deploy.

## Secrets to add

Add these as Worker secrets:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DISCORD_WEBHOOK_URL`
- `DISCORD_BOT_TOKEN`
- `TEST_TRIGGER_TOKEN`

Optional Worker vars:

- `DISCORD_MENTION_EVERYONE=true` to ping `@everyone` in Discord alerts.
- `DISCORD_CHANNEL_ID=<discord text channel id>` to send main alerts as your bot.
- `DISCORD_TEST_CHANNEL_ID=<discord text channel id>` to send test alerts as your bot.
- `DISCORD_TEST_GIF_URL=<gif url>` to keep the test preview image.

Discord delivery now supports two modes:

- `DISCORD_WEBHOOK_URL` for classic webhook delivery.
- `DISCORD_BOT_TOKEN` + channel ID for sending as your real Discord bot.

If both are present, the Worker prefers bot mode.

If you only want one channel, either:

- keep only Telegram secrets, or
- keep only Discord secrets.

The Worker will enable a channel only when all required values are present.

## Local test

Install Wrangler and test locally:

```bash
npx wrangler dev --test-scheduled
```

Then trigger the cron handler locally:

```bash
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*+*+*+*+*"
```

## Health check

After deployment, open:

```text
https://<your-worker>.workers.dev/health
```

The Worker returns JSON showing whether the configuration is complete.
