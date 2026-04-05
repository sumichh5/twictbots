# Инструкция Для Заказчика

Этот файл нужен владельцу проекта, который будет запускать Twitch-бота у себя.

Секретные данные не нужно передавать разработчику. Достаточно самостоятельно вставить их в файл `.env`.

## Что Нужно Подготовить

Перед запуском понадобятся:

- `TWITCH_CLIENT_ID`
- `TWITCH_CLIENT_SECRET`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_CHAT_ID`
- `DISCORD_WEBHOOK_URL`
- список Twitch-каналов в `config/streamers.json`

Если нужен только Telegram, Discord можно не настраивать.
Если нужен только Discord, Telegram можно не настраивать.

## 1. Twitch: Client ID И Client Secret

Бот проверяет статус стримов через официальный Twitch API.
Для этого Twitch требует данные вашего собственного приложения.

Важно:

- это не пароль от Twitch-аккаунта
- это не доступ к аккаунту стримера
- это не логин и не почта
- это данные приложения, созданного в Twitch Developer Console

### Пошагово

1. Войдите в свой Twitch-аккаунт.
2. Откройте Twitch Developer Console:
   [https://dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
3. Если Twitch попросит, подтвердите email и включите 2FA.
4. Нажмите `Register Your Application`.
5. Заполните поля:
   - `Name`: любое удобное имя, например `My Twitch Live Notifier`
   - `OAuth Redirect URLs`: `http://localhost`
   - `Category`: `Application Integration`
6. Создайте приложение.
7. Откройте его и скопируйте `Client ID`.
8. Нажмите `New Secret` и скопируйте `Client Secret`.

### Что вставить в `.env`

```env
TWITCH_CLIENT_ID=your_client_id_here
TWITCH_CLIENT_SECRET=your_client_secret_here
```

### Важно

- `TWITCH_CLIENT_SECRET` нужно хранить как пароль
- не публикуйте его
- не отправляйте его в открытом виде
- не загружайте его в GitHub

## 2. Telegram: Bot Token

Если нужны уведомления в Telegram, нужно создать Telegram-бота.

### Пошагово

1. Откройте Telegram.
2. Найдите `@BotFather`.
3. Отправьте команду `/newbot`.
4. Укажите:
   - имя бота
   - username бота, который оканчивается на `bot`
5. BotFather пришлет токен бота.

### Что вставить в `.env`

```env
ENABLE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
```

## 3. Telegram: Chat ID Группы Или Канала

Боту нужно знать, куда именно отправлять уведомления.

### Вариант A: группа или супергруппа

1. Добавьте бота в нужную группу.
2. Убедитесь, что у него есть право отправлять сообщения.
3. Отправьте любое сообщение в эту группу.
4. Откройте в браузере:

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

5. Найдите в ответе объект `chat`.
6. Скопируйте значение `chat.id`.

Обычно:

- у личных чатов ID положительный
- у групп и супергрупп ID отрицательный
- у супергрупп и каналов ID часто начинается с `-100`

### Вариант B: канал

1. Добавьте бота в канал как администратора.
2. Опубликуйте любой пост в канале.
3. Откройте:

```text
https://api.telegram.org/botYOUR_BOT_TOKEN/getUpdates
```

4. Найдите `chat.id` канала.
5. Вставьте его в `.env`.

### Что вставить в `.env`

```env
TELEGRAM_CHAT_ID=-1001234567890
```

## 4. Discord: Webhook URL

Если нужны уведомления в Discord, самый практичный вариант - использовать webhook.

### Пошагово

1. Откройте нужный Discord-сервер.
2. Перейдите в настройки нужного текстового канала.
3. Откройте `Integrations`.
4. Откройте `Webhooks`.
5. Нажмите `Create Webhook`.
6. Укажите:
   - имя webhook
   - канал, куда будут приходить уведомления
   - при желании аватар
7. Скопируйте webhook URL.

### Что вставить в `.env`

```env
ENABLE_DISCORD=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/replace/me
DISCORD_MENTION_EVERYONE=true
```

### Важно

- любой, у кого есть webhook URL, сможет отправлять сообщения в этот канал
- не публикуйте этот URL
- если он утек, удалите webhook и создайте новый

## 5. Список Twitch-Стримеров

Откройте файл `config/streamers.json`.

Пример:

```json
{
  "streamers": [
    "https://www.twitch.tv/Wooflyaa",
    {
      "url": "https://www.twitch.tv/sumichh",
      "label": "Sumichh",
      "accentColor": "#E11D48"
    }
  ]
}
```

Правила:

- можно указывать Twitch login или полную ссылку канала
- простой вариант это строка, например `"wooflyaa"` или `"https://www.twitch.tv/Wooflyaa"`
- если нужен красивый label или свой цвет embed, используйте объект с `login` или `url`

## 6. Готовый Пример `.env`

Если нужны и Telegram, и Discord:

```env
APP_NAME=Twitch Stream Notifier
LOG_LEVEL=info
LOG_FILE=./logs/twitch-notifier.log
STATE_FILE=./data/state.json
STREAMERS_CONFIG_PATH=./config/streamers.json
POLL_INTERVAL_SECONDS=45
REQUEST_TIMEOUT_MS=10000
MAX_RETRIES=4
TIME_ZONE=Europe/Kiev
MOCK_MODE=false

TWITCH_CLIENT_ID=your_client_id_here
TWITCH_CLIENT_SECRET=your_client_secret_here

ENABLE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=-1001234567890

ENABLE_DISCORD=true
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/replace/me
DISCORD_MENTION_EVERYONE=true
DISCORD_USERNAME=Twitch Live Alerts
DISCORD_AVATAR_URL=https://static.twitchcdn.net/assets/favicon-32-e29e246c157142c94346.png
```

## 7. Запуск

Откройте папку проекта и выполните:

```powershell
npm install
npm start
```

Если нужно просто проверить конфиг:

```powershell
npm run validate
```

Если нужно протестировать оформление уведомлений без реального Twitch API:

```powershell
npm run start:mock
```

## 8. Если Пока Нет Twitch Данных

Это нормально до первого запуска.

Проект можно передать без `TWITCH_CLIENT_ID` и `TWITCH_CLIENT_SECRET`, но реальный мониторинг Twitch не заработает, пока вы не создадите свое приложение в Twitch Developer Console и не заполните эти значения.

Если сначала хотите проверить только сам бот и оформление сообщений, используйте:

```env
MOCK_MODE=true
```

## Официальные Ссылки

- Twitch app registration: [https://dev.twitch.tv/docs/authentication/register-app](https://dev.twitch.tv/docs/authentication/register-app)
- Twitch OAuth tokens: [https://dev.twitch.tv/docs/authentication/getting-tokens-oauth](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth)
- Twitch API getting started: [https://dev.twitch.tv/docs/api/get-started](https://dev.twitch.tv/docs/api/get-started)
- Telegram BotFather tutorial: [https://core.telegram.org/bots/tutorial](https://core.telegram.org/bots/tutorial)
- Telegram Bot API `getUpdates`: [https://core.telegram.org/bots/api#getupdates](https://core.telegram.org/bots/api#getupdates)
- Discord server integrations: [https://support.discord.com/hc/en-us/articles/360045093012-Server-Integrations-Page](https://support.discord.com/hc/en-us/articles/360045093012-Server-Integrations-Page)

## Короткий Чеклист Перед Запуском

Убедитесь, что у вас есть:

- Twitch `Client ID`
- Twitch `Client Secret`
- Telegram bot token, если включен Telegram
- Telegram chat ID, если включен Telegram
- Discord webhook URL, если включен Discord
- список Twitch login в `config/streamers.json`
- `MOCK_MODE=false`, если нужен реальный прод-режим
