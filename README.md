# cc-discord-bot

Claude Code を Discord ボット化するスキルです。パーソナルエージェントとしての運用を想定しており、DM 経由での応答のみに対応しています。

> [!NOTE]
> このREADMEは、Claude Code 向けのエージェントスキルとして `.claude/skills/cc-discord-bot` に配置されている前提で書かれています。

## 動作環境

- OS: macOS / Linux
- ランタイム: [Bun](https://bun.sh/)
- コンテナ: Docker Desktop（Docker Sandbox を使用）
- 常駐運用: `tmux` 推奨

この Bot は `docker sandbox run --detached claude` で Sandbox を確保し、`docker exec ... claude` で Claude を実行します。起動前に `docker sandbox version` が通ることを確認してください。

## セットアップ

### 1. Discord Bot を作成する

1. [Discord Developer Portal](https://discord.com/developers/applications) でアプリケーションを作成
2. 左メニューの `Bot` → `Add Bot`
3. Bot トークンをコピー（`Reset Token` で再生成も可能）
4. `MESSAGE CONTENT INTENT` は OFF のままで OK（DM には不要）

### 2. Bot をサーバーに招待する

1. 左メニューの `OAuth2` → `URL Generator`
2. Scopes: `bot`
3. Bot Permissions: `Send Messages`
4. 生成された URL を使ってサーバーに招待

### 3. 環境変数を設定する

プロジェクトルートの `.env` に以下を記載します。

```dotenv
DISCORD_BOT_TOKEN=<Botトークン>
DISCORD_ALLOWED_USER_IDS=<許可するDiscordユーザーID>
```

複数ユーザーを許可する場合はカンマ区切りで指定します。

```dotenv
DISCORD_ALLOWED_USER_IDS=123456789,987654321
```

Discord ユーザー ID の確認方法:
- Discord の設定 → 詳細設定 → 開発者モードを ON にする
- 自分のアイコンを右クリック → `IDをコピー`

### 4. 依存パッケージのインストールと型チェック

```bash
bun install --cwd .claude/skills/cc-discord-bot/scripts
bun run --cwd .claude/skills/cc-discord-bot/scripts typecheck
bun run --cwd .claude/skills/cc-discord-bot/scripts check
```

### 5. Docker Sandbox の初期化（初回のみ）

```bash
# Sandbox CLI の動作確認
docker sandbox version

# ログインが必要な場合は対話モードで起動して /login を実行
docker sandbox run --workspace "$(pwd)" claude
```

`Not logged in · Please run /login` と表示された場合は、上記コマンドでログインしてください。

### 6. 起動する

```bash
# フォアグラウンドで起動
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts

# tmux でバックグラウンド起動
tmux new -d -s cc-discord-bot "bun run .claude/skills/cc-discord-bot/scripts/src/main.ts"

# セッションの確認・接続・停止
tmux ls
tmux attach -t cc-discord-bot
tmux kill-session -t cc-discord-bot
```

## 実行モード

### 常駐モード（デフォルト）

```bash
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts
```

DM の受信と Claude への転送を行います。`.claude/settings.bot.json` に定義したスケジュールも自動で実行されます。

### 単発 DM 送信

```bash
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts send <userId> "message"
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts send <userId> --file <path>
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts send <userId> --file <path1> --file <path2> "message"
```

`--file` は複数指定できます。メッセージ本文は任意です。  
添付ファイルはプロジェクトルート配下の実ファイルのみ送信可能で、1ファイルあたり 25MB を超える場合は送信前にエラーになります。

### スケジュールの手動実行

```bash
bun run .claude/skills/cc-discord-bot/scripts/src/main.ts schedule <name>
```

## スケジューラー

常駐モードでは `.claude/settings.bot.json` の `schedules` に定義した内容が cron で定期実行されます。

設定例:

```json
{
  "bypass-mode": true,
  "claude_timeout_seconds": 1800,
  "discord_connection_heartbeat_interval_seconds": 60,
  "discord_connection_stale_threshold_seconds": 180,
  "discord_connection_reconnect_grace_seconds": 20,
  "env": {
    "YOUR_ENV": "value"
  },
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
| `bypass-mode` | `true` にすると Claude CLI に `--dangerously-skip-permissions` を付与する（任意） |
| `claude_timeout_seconds` | Claude 実行のタイムアウト秒数（10〜7200）。未指定時は 1800 秒（30 分） |
| `discord_connection_heartbeat_interval_seconds` | 接続heartbeat間隔（10〜300秒）。未指定時は60秒 |
| `discord_connection_stale_threshold_seconds` | Gatewayイベントが来ない状態を異常とみなす閾値（30〜900秒）。未指定時は180秒 |
| `discord_connection_reconnect_grace_seconds` | 再接続後に `ready` になるまでの待機時間（5〜120秒）。未指定時は20秒 |
| `env` | `docker exec` で Claude 実行時に追加する環境変数（文字列キー/文字列値）。`FORCE_COLOR` `CLAUDECODE` は予約済みで上書き不可 |
| `schedules[].name` | スケジュールの識別名。ログや手動実行時に使う |
| `schedules[].cron` | cron 式（分 時 日 月 曜日） |
| `schedules[].timezone` | タイムゾーン |
| `schedules[].prompt` | Claude に送るプロンプト。`{{datetime}}` で現在日時に置換される |
| `schedules[].discord_notify` | 結果を Discord DM で通知するかどうか（接続済みかつ非空応答の場合のみ送信） |
| `schedules[].prompt_file` | ファイルの内容を `prompt` の前に結合して送る。プロジェクトルートからの相対パス（任意） |
| `schedules[].skippable` | Claude の応答が `[SKIP]` で始まる、または終わる場合に DM 通知を省略する（任意） |
| `schedules[].session_mode` | `"main"`(デフォルト) または `"isolated"`。隔離セッションの詳細は後述 |

スケジュール実行では、空応答や実行エラー時に Discord へ通知しません（ログのみ出力）。また、通知前に接続状態を確認し、未接続なら短時間待機して回復しない場合は通知をスキップします。
接続維持は scheduler ではなく専用タイマーで行われ、1分ごと（設定可能）に接続ヘルスを監視して異常時は強制再接続します。

### セッションモードとプロンプト構築

スケジュールタスクには `session_mode` を設定できます。未指定時は `"main"` です。

| モード | セッションファイル | 用途 |
|--------|-------------------|------|
| `main` | `tmp/cc-discord-bot/session_id.txt` | DM応答や朝プラン等と同じセッション。対話文脈を共有する |
| `isolated` | `tmp/cc-discord-bot/sessions/{name}.txt` | タスクごとに独立したセッション。メインのコンテキストを圧迫しない |

#### プロンプトの構築順序

スケジューラがClaude CLIに送るプロンプトは、以下の順序で結合されます(各パート間は `---` 区切り):

```
1. AGENT_LESSONS.md          ... 教訓ファイル(存在すれば)
2. DM対話ログ                ... isolated のみ。直近20件(user+assistant)
3. 申し送り指示              ... isolated のみ
4. 自動実行タスクの報告      ... main のみ。同日の申し送りファイルを読み込み
5. prompt_file の内容        ... 設定されていれば
6. prompt フィールドの値
```

mainモードでは 1, 4, 5, 6。isolatedモードでは 1, 2, 3, 5, 6 が含まれます。

構築されたプロンプトは `prompt-template.md` のテンプレートに埋め込まれ、`append-system-prompt.md` がシステムプロンプトとして付与された状態で `claude -p` に渡されます。

#### DM対話ログの注入(isolatedモードのみ)

隔離セッションはメインセッションの対話文脈を持たないため、直近のDiscord DMやり取りをプロンプトに含めます。

- イベントバス(SQLite)から直近20件の会話を取得
- `dm.incoming`(status=done, messageTextあり)からユーザー発言を、`outbound.dm.request`(status=done, source=dm_reply)からアシスタント発言を抽出
- 各メッセージは500文字で切り詰め、タイムスタンプ付きマークダウンとして整形
- 実測値: 20件で約4,000文字程度

注入されるフォーマット:

```markdown
## 最近のDiscord DM会話(参考コンテキスト)

### user (2026-02-23 10:30)
今日の予定教えて

### assistant (2026-02-23 10:31)
今日は14時からMTGがあります。午前中はフリーです。
```

#### 申し送り(isolated → main)

隔離セッションのタスク完了後、結果をメインセッションに共有するための仕組みです。

**保存先**: `tmp/cc-discord-bot/handoffs/YYYY/MM/DD/{schedule.name}.md`

隔離セッションのプロンプトに以下の指示が自動的に含まれ、タスク完了後に上記パスへ作業内容を書き込みます。同日に同じタスクが複数回実行された場合は上書きされます。

```markdown
## 申し送り事項の書き方

タスク完了後、今日の作業内容を以下のファイルに書き込んでください(上書き):
  tmp/cc-discord-bot/handoffs/YYYY/MM/DD/{schedule.name}.md

今日日付で実際にやったことを正確に記録してください。全体で5000文字以内に収めてください。
具体的にどのファイルに何を書いたか、何を変更したかが分かるように書いてください。
```

メインセッション側では、プロンプト構築時に同日の `handoffs/YYYY/MM/DD/` 内の `.md` ファイルを読み込み、「自動実行タスクの報告」セクションとして注入します。ファイルは削除されないため、同日中はメインセッションが何度でも参照可能です。

### HEARTBEAT の運用例

このリポジトリで実際に使っている構成に近い例です。
プロジェクトルートに `HEARTBEAT.md` を置き、`06:00〜22:59（Asia/Tokyo）` の間、10分ごとに DM を送るかどうかを Claude に判断させます。

`.claude/settings.bot.json`:

```json
{
  "bypass-mode": true,
  "claude_timeout_seconds": 1800,
  "schedules": [
    {
      "name": "morning-plan",
      "cron": "0 6 * * *",
      "timezone": "Asia/Tokyo",
      "prompt": "/daily-planner を実行してください。\n\n完了後、今日のTODOをDiscord DM向けに要約してください:\n- 2週間逆算チェックの警告があれば最初に記載\n- 今日のゴール(1-3個)\n- タイムラインの概要\n- 優先タスク一覧(各1行)",
      "discord_notify": true
    },
    {
      "name": "heartbeat",
      "cron": "*/10 6-22 * * *",
      "timezone": "Asia/Tokyo",
      "prompt_file": "HEARTBEAT.md",
      "prompt": "現在時刻: {{datetime}}\n\n上記のハートビート設定に従い、マスターにDMを送るかどうか判断してください。\n送る場合はメッセージ本文のみを返してください。送らない場合は返答の先頭または末尾に必ず[SKIP]を付けてください。",
      "discord_notify": true,
      "skippable": true
    }
  ]
}
```

Claude に渡す固定プロンプトは `scripts/src/prompts/` に配置します（`append-system-prompt.md`, `prompt-template.md`）。

`HEARTBEAT.md` の例:

```md
# Heartbeat 設定

10分ごとにこのプロンプトが実行されます。マスターにDMを送るかどうか、あなたが判断してください。

## DMを送る場合

以下のような場面ではDMを送ってください:

- マスターが取り組んでいるタスクについて「そろそろ終わりました?」と軽く聞きたいとき(ただし前回聞いてから十分時間が経っていること)
- 今日のTODOファイルを確認して、期限が近いものや忘れていそうなものがあるとき
- 会議の15-30分前のリマインダー(カレンダーを確認してください)
- 長時間作業が続いていそうなときの息抜きの声かけ
- 共有したい気づきや提案があるとき

## DMを送らない場合

以下の場合は、返答の先頭または末尾に必ず `[SKIP]` を付けてください:

- 特に伝えることがないとき
- 前回のハートビートで既にDMを送っていて、状況が変わっていないとき
- 直近のDM会話でやり取りしたばかりのとき(30分以内)
- 判断に迷ったとき(迷うくらいなら送らない)

## トーンとスタイル

- 短く(1-3文)
- 具体的な内容に触れる(「お疲れ様です」だけのような中身のない声かけはNG)
- 押し付けがましくない、自然な感じ
- 「〜ですか?」「〜どうです?」のような軽い問いかけ
- マスターのペースを尊重する

## 最重要ルール

送る必要がないと判断したら、迷わず返答の先頭または末尾に `[SKIP]` を付けてください。
```

## DM の使い方

許可されたユーザーからの DM だけを処理します。メッセージは FIFO キューで 1 件ずつ直列処理され、処理中に送ったメッセージはキューに積まれて順次実行されます。Claude の応答が長い場合は自動的に分割して送信し、DM経由の空応答の場合は内部で最大3回リトライしても空のときに限り `（エージェントが応答できませんでした）` を返します。

| コマンド | 説明 |
|----------|------|
| `!reset` | セッションをクリアする |
| `!session` | 現在のセッション ID を表示する |

長時間処理になる場合、Claude Codeは処理中に途中経過DMを先に送ることがあります。  

### 添付ファイル

DM にファイルを添付して送ることができます。

対応する添付ファイル形式:
- 画像: `image/*`
- PDF: `application/pdf`
- テキスト: `text/*`

サイズ上限:
- 1 ファイルあたり最大 25MB、1 メッセージあたり合計 50MB

保存先と保持期間:
- `tmp/cc-discord-bot/attachments/<messageId>/` に保存され、24 時間経過後に自動削除されます

テキストなしで添付だけ送っても、テキストと添付を混在させても処理されます。未対応の添付ファイル形式やサイズ超過の場合は DM でエラーが返ります。

## トラブルシューティング

| 症状 | 対処 |
|------|------|
| Bot がオフラインのまま | `.env` の `DISCORD_BOT_TOKEN` が正しいか、Bot が有効になっているか確認 |
| DM に反応しない | `DISCORD_ALLOWED_USER_IDS` の値を確認 |
| `Expected token to be set for this request, but none was present` | Docker Sandbox 内の Claude Code が未認証。**Bot が Discord DM でも通知します**。下記「Claude Code 認証エラーの復旧」を参照 |
| Bot 起動直後にプロセスが終了する | `.env` の `DISCORD_BOT_TOKEN` が未設定。`.env` を確認して Bot を再起動 |
| スケジュールが動かない | `.claude/settings.bot.json` の JSON 構文・cron 式・timezone を確認 |
| セッションの挙動がおかしい | `!reset` でセッションを初期化 |

### Claude Code 認証エラーの復旧

ログや Discord DM に `⚠️ Claude Code の認証が切れています` または
`Expected token to be set for this request, but none was present` が表示された場合、
Docker Sandbox 内の Claude Code（Anthropic API）の認証切れが原因です。
Discord Bot Token とは別の問題です。

#### 復旧手順

```bash
# 1. Bot を停止する（tmux で起動している場合）
tmux kill-session -t cc-discord-bot

# 2. Docker Sandbox に対話モードで入る
docker sandbox run --workspace "$(pwd)" claude

# 3. Claude Code の対話シェルが開いたら /login を実行
/login
# → ブラウザが開くので Anthropic アカウントでログイン
# → 「Login successful」と表示されたら Ctrl+C で終了

# 4. Bot を再起動する
tmux new -d -s cc-discord-bot "bun run .claude/skills/cc-discord-bot/scripts/src/main.ts"

# 5. ログで接続成功を確認する
tmux attach -t cc-discord-bot
# [discord-connection] event=connected が出れば正常
# Ctrl+B → D でデタッチ（セッションは維持）
```

#### 通知の仕組み

このエラーが発生すると、Bot は自動的に Discord DM で通知と復旧手順を送ります。

- **DM への返信時**: ❌ リアクション + 日本語で復旧手順を送信
- **スケジューラー実行時**: エラーをログに記録したうえで、Discord DM で通知

Discord接続切れに対しては、自動再接続（指数バックオフ: 1秒→2秒→4秒…最大60秒）を継続します。さらに専用heartbeatが `not_ready` / `stale gateway` / 連続高ping を検知した場合は強制再接続を実行します。`[discord-connection]` / `[scheduler]` ログを確認してください。
