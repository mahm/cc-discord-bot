---
name: cc-discord-bot
description: Claude CodeをDiscord Bot化するスキル。Discord DM経由でユーザーにメッセージを送信できる。「DMしておいて」「Discordで連絡して」などユーザーへのDiscord DM送信が必要な場面や、Discord Botの起動・管理が必要な場面で使用する。
---

# Discord Bot スキル

## DM送信

送信先のDiscord ユーザーIDが必要。CLAUDE.mdに記載があればそちらを参照し、なければユーザーに確認する。

```bash
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts send <ユーザーID> "メッセージ内容"
```

## Bot常駐

Botをバックグラウンドで常駐させる場合は、tmuxセッション `cc-discord-bot` での起動を推奨。

```bash
# 起動
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts

# バックグラウンド起動
tmux new -d -s cc-discord-bot "bun run .claude/skills/cc-discord-bot/scripts/src/main.ts"
```

## スケジュール手動実行

`.claude/settings.bot.json` に定義されたスケジュールを名前指定で手動実行する。Bot常駐モードではcron設定に従い自動実行される。

```bash
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts schedule <スケジュール名>
```

例: `bun run .claude/skills/cc-discord-bot/scripts/src/main.ts schedule morning-plan`

詳細なセットアップ手順・トラブルシューティングは `README.md` を参照。
