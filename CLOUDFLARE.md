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
- `ENABLE_DISCORD_BOT_TEST_MODE=true` to enable the public bot setup flow in TEST mode only.
- `DISCORD_APPLICATION_ID=<discord app id>` for slash-command registration.
- `DISCORD_PUBLIC_KEY=<discord public key>` for interaction signature verification.
- `DISCORD_TEST_GUILD_ID=<discord guild id>` for instant guild command registration while testing.

Discord delivery now supports two modes:

- `DISCORD_WEBHOOK_URL` for classic webhook delivery.
- `DISCORD_BOT_TOKEN` + channel ID for sending as your real Discord bot.

If both are present, the Worker prefers bot mode.

## Public bot test mode

There is now a test-only Discord setup flow for a public bot:

- `POST /discord/interactions` handles the Discord interactions endpoint.
- `/testbot` opens an ephemeral setup menu inside Discord.
- Server configs are stored in `STATE_KV` per guild, separate from the main prod flow.
- Cron will monitor those saved Twitch logins and send alerts back through the bot in TEST mode.

Recommended rollout while testing:

1. Set `ENABLE_DISCORD_BOT_TEST_MODE=true`.
2. Add `DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`.
3. Keep `DISCORD_BOT_TOKEN` as a Worker secret.
4. Register commands to a single test guild first with:

```bash
curl -H "x-test-token: <TEST_TRIGGER_TOKEN>" "https://<your-worker>.workers.dev/test/discord/register-commands?scope=guild"
```

5. In the Discord Developer Portal, set the Interactions Endpoint URL to:

```text
https://<your-worker>.workers.dev/discord/interactions
```

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
