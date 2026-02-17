# Discord Bot

Discord DMを受信すると Claude Code CLI を呼び出し、応答をDMで返すBotです。

このREADMEで説明する内容は、Claude Code専用のエージェントスキルを前提にしています。
スキルは `.claude/skills/cc-discord-bot` というディレクトリ名で配置されていることを前提にしています。

## 対応環境・前提条件

- OS: macOS / Linux
- ランタイム: [Bun](https://bun.sh/)
- コンテナ実行基盤: Docker Desktop (Docker Sandbox 利用前提)
- 常駐運用: `tmux` (推奨)

運用前提:
- このBotは `docker sandbox run --detached claude` でSandboxを確保し、`docker exec ... claude` で実行します。
- 起動前に `docker sandbox version` が通ることを確認してください。

## セットアップ手順

### 1. Discord Botの作成

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成
2. 左メニュー `Bot` → `Add Bot`
3. Botトークンをコピー（必要なら `Reset Token` で再生成）
4. `MESSAGE CONTENT INTENT` はOFFでOK（DM利用では不要）

### 2. Botをサーバーに招待

1. 左メニュー `OAuth2` → `URL Generator`
2. Scopes: `bot`
3. Bot Permissions: `Send Messages`
4. 生成URLでサーバーに招待

### 3. 環境変数の設定

プロジェクトルートの `.env` に設定:

```dotenv
DISCORD_BOT_TOKEN=<Botトークン>
DISCORD_ALLOWED_USER_IDS=<許可するDiscordユーザーID>
```

複数ユーザーを許可する場合:

```dotenv
DISCORD_ALLOWED_USER_IDS=123456789,987654321
```

DiscordユーザーID確認:
- Discord設定 → 詳細設定 → 開発者モードをON
- 自分のアイコンを右クリック → `IDをコピー`

### 4. 依存インストールと型チェック

```bash
bun install --cwd .claude/skills/cc-discord-bot/scripts
bun run --cwd .claude/skills/cc-discord-bot/scripts typecheck
```

### 5. Docker Sandbox 初期化（初回のみ）

```bash
# Sandbox CLIが使えることを確認
docker sandbox version

# 初回ログインが必要な場合は対話で起動して /login を実行
docker sandbox run --workspace "$(pwd)" claude
```

`Not logged in · Please run /login` が返る場合は、上記コマンドでログインを完了してください。

### 6. 起動

```bash
# 常駐モード（フォアグラウンド）
bun run .claude/skills/cc-discord-bot/scripts/main.ts

# 常駐モード（tmuxバックグラウンド）
tmux new -d -s cc-discord-bot "bun run .claude/skills/cc-discord-bot/scripts/main.ts"

# セッション確認 / 接続 / 停止
tmux ls
tmux attach -t cc-discord-bot
tmux kill-session -t cc-discord-bot
```

## 実行モード

### 常駐モード（デフォルト）

```bash
bun run .claude/skills/cc-discord-bot/scripts/main.ts
```

- Discord DMを受信してClaudeへ転送
- `.claude/settings.bot.json` のスケジュールを自動実行

### 単発DM送信モード

```bash
bun run .claude/skills/cc-discord-bot/scripts/main.ts send <userId> "message"
```

### スケジュール手動実行モード

```bash
bun run .claude/skills/cc-discord-bot/scripts/main.ts schedule <name>
```

## 定期実行（スケジューラー）

常駐モードでは `.claude/settings.bot.json` の `schedules` が cron で実行されます。

設定例:

```json
{
  "bypass-mode": true,
  "schedules": [
    {
      "name": "morning-plan",
      "cron": "0 6 * * *",
      "timezone": "Asia/Tokyo",
      "prompt": "/daily-planner を実行してください。",
      "discord_notify": true
    }
  ]
}
```

| フィールド | 説明 |
|-----------|------|
| `bypass-mode` | 任意。`true` で Claude CLI に `--dangerously-skip-permissions` を付与 |
| `schedules[].name` | スケジュール識別名（ログ・手動実行用） |
| `schedules[].cron` | cron式（分 時 日 月 曜日） |
| `schedules[].timezone` | タイムゾーン |
| `schedules[].prompt` | Claudeへ送るプロンプト（`{{datetime}}` 置換対応） |
| `schedules[].discord_notify` | 結果をDiscord DMで通知するか |
| `schedules[].prompt_file` | 任意。ファイル内容を `prompt` 前に結合（プロジェクトルート相対） |
| `schedules[].skippable` | 任意。応答が `[SKIP]` で始まる場合にDM通知をスキップ |

## DMでの使い方

- 許可ユーザーからのDMのみ処理します
- メッセージは1件ずつ直列処理します（処理中は待機メッセージを返します）
- Claude応答が長い場合は自動分割して送信します

コマンド:

| コマンド | 説明 |
|----------|------|
| `!reset` | セッションをクリア |
| `!session` | 現在のセッションIDを表示 |

## トラブルシューティング

| 問題 | 対処 |
|------|------|
| Botがオフライン | `.env` の `DISCORD_BOT_TOKEN` と Bot有効状態を確認 |
| DMに反応しない | `DISCORD_ALLOWED_USER_IDS` の値を確認 |
| Claude実行エラー | `docker sandbox ls` でSandbox状態を確認。`Not logged in` の場合は `docker sandbox run --workspace \"$(pwd)\" claude` で `/login` 実行 |
| スケジュールが動かない | `.claude/settings.bot.json` のJSON/cron/timezoneを確認 |
| セッション不整合 | `!reset` でセッションを初期化 |
