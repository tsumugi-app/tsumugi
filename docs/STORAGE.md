# Tsumugi Storage

Version 1.0

---

# この文書について

これはTsumugiにおける**実装可能な保存設計書**である。

`MEMORY_ENGINE.md` が記憶の思想を定義し、
`DATA_MODEL.md` がその思想を型（Interface）へ落とし込んだのに対し、
本書は「その型が、実際にどこへ、どんな形式で、どう書き込まれ、どう読み出されるか」を定義する。

対応関係は以下の通り。

| 上位文書 | 本書での対応 |
|---|---|
| `README.md` の Principles（Local First / Markdown First） | §1 Storage Philosophy |
| `PROJECT.md` 原則1・2（User owns the memory / Local first） | §1, §7 |
| `ARCHITECTURE.md` の Storage Layer（Markdown / JSON / IndexedDB） | §2 Storage Layer |
| `ARCHITECTURE.md` の Markdown Structure | §4 Markdown Format |
| `MEMORY_ENGINE.md` 8章 Seed Concept | §4.2（frontmatterへの反映） |
| `DATA_MODEL.md` §0.3 ID戦略 / §8 Markdown⇄TypeScriptマッピング / §9 Import/Export | §3, §4, §6 |
| `REQUIREMENTS.md` 3.2 / 3.4 / 7 Privacy / 8 Out of Scope | §7 Backup, §8 Future Extension |
| `ROADMAP.md` Phase 2「やらないこと：Import/Export」／Phase 3「Markdown First」 | §6, §8 の実装時期の前提 |

本書は思想書ではない。**実装者がこのファイルだけを見て、保存レイヤーを実装できること**を目的とする。
迷ったときの判断基準は、`MEMORY_ENGINE.md` / `DATA_MODEL.md` と同じ問いを保存設計向けに言い換えたものを、末尾に置く。

---

# 1. Storage Philosophy

Tsumugiの保存設計は、次の4つの原則の上に成り立つ。

## 1.1 Local First

**まずローカルに保存し、サーバーを前提にしない。**

- アプリを閉じても、ネットワークが無くても、記憶は手元に存在する。
- `REQUIREMENTS.md` 7章で Privacy が最優先度（Highest）とされているのは、
  外部にデータを送らないことがデフォルトであるべきだという要求であり、
  本書ではこれを「サーバーサイドのデータベースを持たない」という設計上の制約として実装する。
- Local Firstは「オフラインでも動く」という機能要件ではなく、
  **「Tsumugiという会社・サービスが無くなっても、記憶は残る」という生存保証**である
  （`VISION.md`「AI is replaceable. Your memories are not.」の保存レイヤーでの解釈）。

## 1.2 Markdown First

**記憶の正はMarkdownファイルであり、それ以外（IndexedDB、JSON索引）はすべて派生物である。**

- `DATA_MODEL.md` §0.1 の通り、Markdownが source of truth、JSON/IndexedDBはindex/cache。
- Markdownを選ぶ理由は「読みやすいから」ではない。
  **プレーンテキストは、特定のアプリ・特定のパーサー・特定のバージョンに依存しない**からである。
  バイナリ形式やアプリ固有のDB形式は、そのアプリが無くなった瞬間に読めなくなる。
  UTF-8のテキストファイルは、10年後、どんなエディタでも開ける。
- この原則の実装上の帰結：**IndexedDBを消しても、記憶は一切失われてはならない。**
  IndexedDBはいつでもMarkdownから再構築できる状態を保つ（§2.4 Rebuildability Guarantee）。

## 1.3 AI Replaceable

**保存形式は、特定のAIプロバイダに依存する構造を持たない。**

- `Metadata.aiProvider`（`DATA_MODEL.md` §2）はあくまで「どのAIが生成したか」という記録であり、
  保存構造やファイル形式がAIプロバイダごとに変わることはない。
- AIが変わっても（Claude → Gemini → 未来のAI）、Markdownファイルの構造・frontmatterのスキーマは変わらない。
  変わるのは中身の生成元だけである。
- 実装上の禁止事項：特定AIのレスポンス形式（例：特定ベンダーのfunction calling結果の生JSON）を
  そのまま保存フォーマットとして採用しない。必ず`DATA_MODEL.md`の型を経由してから保存する。

## 1.4 User Owns Memory

**ユーザーは、いつでも、アプリを介さずに、自分の記憶へアクセス・複製・削除・持ち出しができる。**

- Vault（§3）はOS上の通常のディレクトリであり、Finder/Explorerで開ける。特殊な権限もロックもかけない。
- アプリ側は「エクスポート機能」を提供する主体ではなく、
  **「そもそもユーザーの記憶が常にファイルシステム上にある」という前提を守る**主体である。
  エクスポートは追加機能ではなく、Vaultという設計そのものの帰結である（§6）。

---

# 2. Storage Layer

Tsumugiは4つの保存レイヤーを持つ。それぞれ役割が異なり、互いに代替できない。

| レイヤー | 役割 | 保存されるデータ | 正本か派生か |
|---|---|---|---|
| Markdown Files | 人間可読な記憶そのもの | Conversation本文、MemoryObject本文、Entity（People/Themes/…）ノート | **正本（source of truth）** |
| `.tsumugi/`（JSON） | 構造化された補助情報 | `index.json`（id→path）、`links.json`（Link全量）、`schema-version.json` | 正本に準ずる（§2.3参照） |
| IndexedDB | 高速検索・結合のための実行時キャッシュ | 全Record/Entity/Linkのミラー、全文検索インデックス | **完全な派生（いつでも再構築可）** |
| Attachments | バイナリの原本 | 画像・PDF・音声・動画ファイル | **正本** |
| Settings | アプリ・端末固有の設定 | テーマ、既定Persona、AIプロバイダ選択、APIキー | Vaultの外（§2.5） |

## 2.1 Markdown Files

- `DATA_MODEL.md` の全Record（`Conversation`, `MemoryObject`）・全Entity（`Theme`/`Person`/`Emotion`/`Goal`/`Idea`/`Event`）は、
  必ず1オブジェクト=1Markdownファイルとして書き出される。
- ユーザーが日常的に開くのは主に `Memories/` と各Entityフォルダであり、
  `Conversations/` はAI向けの生ログとして扱う（`DATA_MODEL.md` §8.1）が、
  隠しファイルにはしない。**「普段は開かないが、開けば読める」**状態を維持する。

## 2.2 `.tsumugi/`（構造化JSON）

Markdown単体では表現しづらい情報を、Vault内の隠しディレクトリにプレーンJSONとして持つ。

| ファイル | 内容 | 再構築可能性 |
|---|---|---|
| `index.json` | `id → 現在のvault相対パス` の対応表（`DATA_MODEL.md` §0.3） | Vault全体をスキャンし、各frontmatterの`id`を読めば再構築できる |
| `links.json` | 全`Link`オブジェクト（`sourceId`/`targetId`/`axis`/`reason`/`contrast`/`strength`/`createdBy`） | **再構築不可（正本）**。理由は§4.3で述べる |
| `schema-version.json` | Vault全体が現在従う`schemaVersion` | アプリのバージョンから導出可能だが、明示保存する |

`index.json` と `schema-version.json` は「失っても再生成できるキャッシュ」だが、
**`links.json` だけは正本である**。なぜなら `Link.reason`（なぜ2つの記憶がつながるかの言語化）こそが
`MEMORY_ENGINE.md` 6章が定義するTsumugi最大の差別化価値であり、これを失うことは記憶そのものの劣化に等しいためである。
（frontmatterへの部分的な反映は§4.3で扱うが、完全な形は`links.json`にのみ存在する。）

## 2.3 IndexedDB

- ブラウザ内で完結する実行時データベース。役割は**検索・結合・フィルタリングの高速化のみ**。
- 起動時、Vault（Markdown + `.tsumugi/`）から全量を読み込み、IndexedDBへ展開する。
- オブジェクトストア構成（例）

```
conversations      (keyPath: id)
memoryObjects       (keyPath: id, index: date, types*, themeIds*, personIds*, keywords*)
people / themes /
emotions / goals /
ideas / events       (keyPath: id, index: name, aliases*)
links               (keyPath: id, index: sourceId, targetId, axis)
attachments         (keyPath: id, index: sourceId)
fulltext            (全文検索用の転置インデックス。MemoryObject.content由来)

  * = multiEntry index
```

- **書き込みは常にMarkdown/`.tsumugi/`が先、IndexedDBが後**。
  逆方向（IndexedDBにだけ先に書いてMarkdownへの反映が後回しになる）は禁止する。
  これはMarkdown Firstを実装レベルで担保する唯一のルールである。

## 2.4 Rebuildability Guarantee（再構築可能性の保証）

> IndexedDBを含む `.tsumugi/index.json` / `.tsumugi/schema-version.json` を全て消しても、
> `vault/**/*.md` と `vault/.tsumugi/links.json` と `vault/Attachments/**` さえ残っていれば、
> Tsumugiは記憶を一切失わずに動作を再開できる。

これがLocal First（§1.1）とMarkdown First（§1.2）を、実装として検証可能な形にしたものである。
実装時のテスト項目として明示する：「IndexedDBを空にしてアプリを再起動し、全記憶・全リンクが復元されること」。

## 2.5 Settings

設定は2種類に分け、**意図的にVaultの外へ置く**。

| 種類 | 例 | 保存場所 | Export/Backupに含むか |
|---|---|---|---|
| Vault非依存のポータブルな環境設定 | 既定Persona、テーマ、日付表示形式 | `vault/.tsumugi/settings.json` | 含む |
| 端末固有・機密性のある設定 | AIプロバイダAPIキー、認証トークン、同期先アカウント情報 | IndexedDB専用ストア（`secrets`）、または将来Native化した場合はOSキーチェーン | **含まない（常に除外）** |

理由：VaultはUser Owns Memory（§1.4）の帰結として、
ユーザーがDropboxに置いたり、Gitに入れたり、他人に見せたりすることを前提に設計している。
APIキーのような機密情報がVault内のプレーンテキストに存在すると、
「記憶を持ち出す」という行為が「秘密鍵を漏らす」行為と同義になってしまう。
これはUser Owns Memoryの精神（自分のものを自由に扱える）と真っ向から矛盾するため、
機密設定は構造的にVaultへ混入できないようにする。

---

# 3. Vault Structure

```
vault/
├── Conversations/          # Conversation（生ログ）
├── Memories/               # MemoryObject（中心となる閲覧対象）
├── Sources/                 # 外部から持ち込まれた原資料・テキスト（§6.2、DATA_MODEL.md §9.2）
├── People/                 # Person Entity（1人1ノート）
├── Themes/                 # Theme Entity
├── Emotions/                # Emotion Entity
├── Goals/                  # Goal Entity
├── Ideas/                  # Idea Entity
├── Events/                  # Event Entity
├── Attachments/             # 画像・PDF・音声・動画の原本。Sourceに属する（§5）
└── .tsumugi/                # アプリ管理領域（隠しディレクトリ）
    ├── index.json
    ├── links.json
    ├── schema-version.json
    └── settings.json        # ポータブルな環境設定のみ（機密情報は含まない）
```

- `DATA_MODEL.md` §8.1 のフォルダ構成をベースに採用する。ユーザーが提案した
  `conversations/ memories/ people/ themes/ attachments/ settings/` というフラットな構成との違いは2点：
  **`settings/` をVault直下の可視フォルダにしない**（理由は§2.5の通り、設定と記憶資産を構造的に分離するため。
  ポータブルな設定だけは `.tsumugi/settings.json` として残すため、体験としての「設定画面」は変わらない）、
  および**`Sources/` を追加する**（`DATA_MODEL.md` §8.1にはまだ反映されていない、外部データ取り込み§9.2に伴う追加）。
- フォルダ名は大文字始まり（`Memories/` 等）で統一し、Obsidianの標準的なVault運用（フォルダ名がそのままサイドバーに出る）と揃える。
- ファイル命名規則

| 対象 | 命名規則 | 例 | 理由 |
|---|---|---|---|
| Conversation / MemoryObject | `{date}-{shortId}.md`（`shortId`はULID末尾6文字） | `2026-07-25-x7f2q1.md` | 同日に複数のMemoryObjectが生まれても衝突しない。ファイル名だけで概ね時系列ソートできる |
| Source | `{date}-{shortId}.md`（Conversation/MemoryObjectと同じ規則） | `2026-07-25-k3f9a1.md` | **1 Source = 1 Markdown**を原則とする。Sourceは「1件の資料」という単位で保持する方が自然であり、Memoryのように1日に多数生まれる細片ではないため、実装上Memoryにのみ適用されている「1日1ファイル」への統合（`Memories/`配下の日別ファイル）は適用しない |
| Entity（Person/Theme/…） | `{name}.md` | `山田太郎.md` | Obsidianの`[[wikilink]]`表示に直結する（`DATA_MODEL.md` §0.3） |
| Entity名の衝突時 | `{name} ({shortId}).md` | `田中 (k9x2z0).md` | 同名の別人物・別テーマが存在する稀なケースの回避策。正はfrontmatterの`id`であり、ファイル名はあくまで表示用 |

- `id → path` の対応は常に `.tsumugi/index.json` が持つため、**ファイル名のリネームは記憶の同一性を壊さない**
  （`DATA_MODEL.md` §0.3 のID戦略をそのまま踏襲）。

---

# 4. Markdown Format

## 4.1 Frontmatter

すべてのTsumugi管理ノートは、以下のfrontmatterを持つ。

| フィールド | 必須 | 意味 |
|---|---|---|
| `id` | ✅ | ULID。リンク解決・再構築の一次キー（`DATA_MODEL.md` §0.3） |
| `tsumugi` | ✅ | 常に`true`。Tsumugi管理ノートであることの目印（Import判定に使用、`DATA_MODEL.md` §9.2） |
| `schemaVersion` | ✅ | このノートが従うデータモデルのバージョン |
| `createdAt` / `updatedAt` | ✅ | ISO 8601（タイムゾーン付き） |
| `date`（MemoryObjectのみ） | ✅ | この記憶が指す時点 |
| `types`（MemoryObjectのみ） | ✅ | `MemoryType[]` |
| `keywords` | 任意 | キーワード配列 |
| `themes` / `people` / `emotions` / `goals` / `ideas` / `events` | 任意 | 該当Entityへの`"[[wikilink]]"`配列。表示・Obsidianグラフ用（正はIDだが、人間可読性のため名前で持つ） |
| `aiProvider` | 任意 | 生成に使われたAIプロバイダ |
| `source` | ✅ | `"ai-capture" \| "user-authored" \| "import" \| "system-generated"` |
| `sourceType` | 任意 | 元の素材の種類（`"chat" \| "manual" \| "obsidian-import" \| "gmail" \| "photo" \| "pdf" \| "url" \| "system" \| string`）。未設定時は`source`から推測される（`DATA_MODEL.md` §2）。Sourceノートでは「資料そのものの種類」、Conversation/MemoryObjectノートでは「由来の参照ラベル」として同じ語彙を使う |
| `sourceDetail` | 任意 | `sourceType`ごとの由来情報（messageId・fileName・url等）をJSON文字列として保持する自由記述bag（`links`と同じ、JSON文字列化してfrontmatterへ格納する形式） |
| `confidence` | 任意 | AI抽出の確信度（0-1） |
| `seed` | 任意 | `{ stage, plantedAt, germinatedAt?, revisitCount }`（`MEMORY_ENGINE.md` 8章、`DATA_MODEL.md` §3） |
| `aliases`（Entityのみ） | 任意 | 表記ゆれ |

**意図的にfrontmatterへ含めないもの**：`Metadata.sync.*`（`deviceId`, `lastSyncedAt`, `dirty`）。
これらは人間にとって意味を持たない機械状態であり、Markdown Firstの「人間が読んで意味が通る」という目的に寄与しない。
IndexedDB側にのみ保持する。

## 4.2 本文（Body）

型ごとに最小限の構造を定める。自由記述部分（本文の主要部）は決して定型化しない
（AIが書いた要約であれ、ユーザーが加筆した内容であれ、自然な日本語の文章のままにする）。

MemoryObject:

```markdown
---
id: 01J9X...
tsumugi: true
date: 2026-07-25
types: [event, person, emotion]
keywords: [転職, 相談, 不安]
themes: ["[[転職]]"]
people: ["[[山田太郎]]"]
emotions: ["[[不安]]", "[[期待]]"]
source: ai-capture
aiProvider: claude
confidence: 0.82
schemaVersion: "1.0"
createdAt: 2026-07-25T21:03:00+09:00
updatedAt: 2026-07-25T21:03:00+09:00
---

# 2026-07-25

## Summary
友人の山田太郎と転職について相談した。不安もあるが期待もある。

## Connections
<!-- 以下はlinks.jsonから自動生成される。手で編集しても構わないが、再生成時に上書きされる -->
- [[山田太郎]] *(person)* — 転職の相談相手として登場 — strength: 0.9
- [[不安]] ↔ [[期待]] *(emotion, contrast)* — 同じ会話の中で相反する感情が語られた — strength: 0.7
```

Entity（Person）:

```markdown
---
id: 01J9Y...
tsumugi: true
aliases: [山田さん]
firstMentionedAt: 2024-03-10
lastMentionedAt: 2026-07-25
relationship: 友人
source: ai-capture
schemaVersion: "1.0"
createdAt: 2024-03-10T10:00:00+09:00
updatedAt: 2026-07-25T21:03:00+09:00
---

# 山田太郎

大学時代からの友人。キャリアの話をよくする。

## 登場する記憶
- [[2026-07-25-x7f2q1]]（転職相談）
- [[2024-03-10-a1b2c3]]（転職相談の初出）
```

## 4.3 Links（`## Connections` セクションと `links.json` の関係）

`Link`（`DATA_MODEL.md` §7）は `reason` / `axis` / `strength` / `contrast` / `createdBy` を持つ
リッチなオブジェクトであり、単なる`[[wikilink]]`では表現しきれない。

- **正本は `.tsumugi/links.json`**（全Linkの配列。プレーンJSON、UTF-8、人間にも読める）。
- 各ノートの `## Connections` セクションは、そのノートに関係するLinkだけを抜き出した**派生表示**であり、
  アプリが書き込むたびに再生成される（`DATA_MODEL.md` §8.3 の「登場する記憶」セクションと同じ扱い）。
- ユーザーが `## Connections` を手で編集しても構わないが、次回の自動更新で上書きされうることを
  UI上で明示する（Obsidianの「Dataviewの自動生成ブロック」と同種の期待値調整）。

この二重化（JSON＋Markdown内表示）により、
- 機械的な正確さ・再計算のしやすさは `links.json` が担い、
- 人間がアプリを介さずMarkdownだけを読んだときの理解しやすさは `## Connections` が担う。

両者は矛盾しない。矛盾したら `links.json` を正とし、`## Connections` を再生成して解消する。

---

# 5. Attachments

画像・PDF・音声・動画は、Markdown内に埋め込めないため、独立したバイナリファイルとして扱う。
Attachmentは**Sourceに属する**（Memoryには直接属さない）。原本ファイルはユーザーが持ち込んだ
原資料そのものであり、Sourceが表す「原資料」の一部だからである（`DATA_MODEL.md` §9.2）。

## 5.1 保存場所とファイル名

- すべて `vault/Attachments/` 配下に置く。ファイル数が増えた場合は `Attachments/2026/07/` のように
  年月でサブフォルダを切ってよいが、これは実装上の最適化でありパスの意味は持たない（正は`index.json`のid→path）。
- ファイル名は `{shortId}-{元のファイル名}` とし、元のファイル名を保持する（人間がFinderで見たときに何のファイルか分かるようにするため）。
  例：`k3f9a1-旅行の写真.jpg`

## 5.2 参照方法

**Source**のMarkdown本文から、Obsidian互換の埋め込み構文で参照する。

```markdown
## Attachments
![[k3f9a1-旅行の写真.jpg]]
```

Sourceのfrontmatterにも `attachments: [k3f9a1-旅行の写真.jpg]` のように相対参照を持たせ、
IndexedDBの`attachments`ストア（`sourceId`で逆引き可能）と整合させる。

MemoryObjectのMarkdown本文からAttachmentを直接参照することはしない。あるMemoryが特定の
Attachmentの内容（例：写真の中身）に基づいている場合でも、そのMemoryは`sourceId`経由で
Sourceを辿り、Source側の`## Attachments`セクションから原本へアクセスする
（`DATA_MODEL.md` §5/§9.2「Source → Memory」の関係を参照）。

## 5.3 原本の非改変

- Tsumugiはアップロードされたバイナリを**無断で再エンコード・圧縮・リサイズしない**。
  「10年後も残る」ためには、原本の忠実性が最優先であり、アプリ都合の最適化で画質・音質を落としてはならない。
- サムネイルや低解像度プレビューが必要な場合は、`.tsumugi/cache/`（Vaultに含めるがGit管理や同期の対象からは除外を推奨）に
  **派生物として**生成する。これは失われても原本から再生成できるため、Rebuildability Guarantee（§2.4）の対象に含める。

## 5.4 音声・動画の文字起こし

AIが生成した文字起こしは、添付ファイル（Attachment）のプロパティとしてではなく、
まず**Source**の本文として保存する（`sourceType`は素材の種類に応じた値を持つ）。
文字起こしの中からTsumugiが「覚えておく価値がある」と判断した情報だけを、必要に応じて
後から`MemoryObject`として抽出する。抽出されたMemoryは`sourceId`でどのSourceから
生まれたかを参照し、`metadata.source = "ai-capture"`・`confidence`を伴わせる
（`MEMORY_ENGINE.md` 5.3「事実・解釈・提案の区別」に従い、文字起こしは「事実」寄りだが
機械生成である旨を常に明示する）。

**Attachment（バイナリ原本）→ Source（文字起こし本文）→ 必要な場合のみMemory**、
という`DATA_MODEL.md` §9.2と一貫した流れに従う。文字起こし結果をAttachmentから
直接MemoryObjectへ変換することはしない。

## 5.5 将来の検討事項

大容量の動画・音声ファイルが蓄積した場合、Gitベースの同期（§8）ではリポジトリ肥大化の問題が出る。
その場合はGit LFSの採用、あるいはAttachmentsのみ別の同期経路（クラウドストレージ直リンク）にする選択肢がある。
本書ではMVP時点でこの最適化を行わないことを明記するに留める（§9 未確定事項）。

---

# 6. Import / Export

`DATA_MODEL.md` §9 の設計方針を、ファイル操作として具体化する。

## 6.1 Export

| 形式 | 内容 | 用途 |
|---|---|---|
| Vault Export | `vault/` ディレクトリ全体のコピー（`.tsumugi/settings.json`の機密部分は含まない。§2.5参照） | 最も完全な形。追加のアプリ不要でそのまま可搬 |
| JSON Snapshot Export | `.tsumugi/links.json` を含む全型の単一JSONファイル（`{ conversations, memoryObjects, people, themes, ... }`） | 機械的なフルバックアップ・移行・デバッグ用（`REQUIREMENTS.md` 3.4） |

- どちらの形式も `id` を軸にすれば再インポート可能（idはエクスポートしても変わらない）。
- Vault Exportは「Zip化したフォルダ」を基本形とする。特殊な圧縮形式やアプリ専用拡張子は使わない。

## 6.2 Import

`DATA_MODEL.md` §9.2 の2ケースをそのまま踏襲する。

1. **自分のエクスポートの再インポート**：`id`一致で機械的にマージ（upsert）。
2. **Tsumugi管理外のObsidian Vaultの取り込み**：`tsumugi: true` の無いノートは「未知のノート」として扱い、
   AIがMemoryObjectの下書きを直接生成することはしない。ユーザーの確認後、まず`Sources/`へ
   **Source**として保存する（`sourceType: "obsidian-import"`）。ユーザーが後から参照でき、
   必要になった時点でAIが選択的に解析し、価値があると判断した情報だけを`MemoryObject`として
   抽出する（`sourceId`でSourceを参照する）。
   このとき、**元のノートファイルは直接書き換えず、Tsumugi側のコピーに対して処理を行う**
   （`ARCHITECTURE.md`「新機能追加より先にユーザーの記憶を守る」に対応する、ファイル操作レベルでの安全策）。

## 6.3 互換性

- 一次互換対象はObsidian（`DATA_MODEL.md`が前提とする`[[wikilink]]`・YAML frontmatter）。
- ただし必須拡張は `id` と `tsumugi: true` の2つのみに絞っているため、
  Logseq・その他のMarkdown+frontmatter系ツール、あるいは将来登場する未知のツールに対しても、
  「frontmatterとwikilinkさえ解釈できれば」互換性を失わない設計になっている。
- 将来の他サービス対応（`README.md` Phase 3）は、**新しいImporterを1つ追加するだけ**で済むようにする。
  Vault自体のフォーマットを他サービスに合わせて変更することはしない。

---

# 7. Backup

## 7.1 バックアップの単位はVaultそのもの

Tsumugiは独自のバックアップ機能・独自のバックアップファイル形式を持たない。
**Vaultディレクトリ自体が、すでにバックアップ可能な単位である。**

- OS標準のバックアップ（Time Machine、ファイル履歴等）や、ユーザー自身のコピー操作がそのまま機能する。
- MVPとしては、`.tsumugi/backups/` へ定期的にJSON Snapshot Export（§6.1）を自動生成し、
  「うっかりVault全体を壊した」場合の直近ロールバック手段を最小限用意する（保持世代数は実装時に決定、§9）。

## 7.2 同期しない理由

`REQUIREMENTS.md` 8章でクラウド同期はMVPスコープ外と明記されており、
`ROADMAP.md` Phase 1/2でも「まだ手を出さないもの」として一貫している。本書もこれに従う。

同期しない理由は「技術的に難しいから」ではなく、**優先順位の問題**である。

1. Privacyが最優先度（`REQUIREMENTS.md` 7章）である以上、ユーザーの記憶を外部サーバーに送る仕組みは、
   単一端末での体験（Phase 1/2の核）が固まる前に導入すべきではない。
2. 複数端末間の競合解決（同じMemoryObjectが2端末で同時に編集された場合の扱い）は、
   それ自体が独立した設計課題であり、Local Firstの検証が済んでいない段階で持ち込むと、
   「記憶が壊れるかもしれない」という不安がLocal Firstの安心感を損なう。
3. `ROADMAP.md`の基本方針「順番を間違えると壊れる体験がある」に従い、
   資産化（Phase 3）より前に同期を持ち込まない。

## 7.3 同期する場合の考え方（ユーザー自身が行う場合）

Tsumugiが同期機能を提供しなくても、ユーザーがVaultフォルダをDropbox/iCloud Drive等の
同期フォルダの中に置くこと自体は止めない。これは「ユーザー自身の選択」であり、Tsumugiが関知する同期ではない。

そのため、アプリ側は以下の点でこの利用法に対して破壊的にならないよう設計する。

- **アトミック書き込み**：ファイルへの書き込みは常に一時ファイルへ書いてからrenameする
  （書き込み途中の不完全なファイルが同期されて壊れることを防ぐ）。
- **長時間のファイルロックを避ける**：外部同期ツールの書き込みをブロックしない。
- **競合時はデータを消さない**：同じファイルが外部で書き換えられていた場合、上書きせず
  `{name} (conflicted copy).md` のような形で両方残す（Obsidianの一般的な同期ツールと同じ振る舞い）。

---

# 8. Future Extension

将来のクラウド同期は、`ROADMAP.md` Phase 3以降のスコープとする。本書では候補と設計上の制約のみ定める。

| 候補 | 方式 | メリット | 留意点 |
|---|---|---|---|
| iCloud Drive / Google Drive / Dropbox | Vaultフォルダをユーザー自身が同期フォルダ内に置く（アプリ側は§7.3の耐性のみ提供） | 実装コストがほぼゼロ。既存のファイル同期基盤に乗るだけ | 大容量Attachments（§5.5）でのパフォーマンス劣化 |
| Git | Vault全体をGitリポジトリとして管理 | Markdownとの相性が良い。**変更履歴そのものが記憶の記憶になる**（10年後、いつ何を書いたかまで残る） | バイナリAttachmentsにはGit LFSが必要。ユーザーにGitの知識を要求しない工夫が要る |
| 専用Tsumugi Sync Service | Tsumugiが提供するE2E暗号化された複数端末同期 | UXが最も滑らか | **最もリスクが高い選択肢。** サーバーを前提にする以上、Local Firstの原則と最も緊張関係にある。導入する場合も「無くてもVaultは完全に機能する」という前提を絶対に崩してはならない |

すべての将来拡張に共通する制約：

> Tsumugiというアプリ・会社が無くなっても、Vault（Markdown + `.tsumugi/links.json` + Attachments）だけで
> 記憶は完全な形で存在し続けなければならない。

同期はこの前提の**上に**乗る機能であり、この前提を**満たすための必須要件**にしてはならない。

---

# 9. 未確定事項

`MEMORY_ENGINE.md` / `DATA_MODEL.md` の姿勢に倣い、矛盾ではなく未確定事項として明記する。

1. **`.tsumugi/backups/` の保持世代数・生成頻度**：実装時にストレージ容量とのバランスで決定する。
2. **Attachments の年月サブフォルダ化のタイミング**：何ファイル/何MBを閾値にフラット構成からサブフォルダ構成へ切り替えるかは未決定。
3. **大容量Attachmentsの同期戦略（Git LFS等）**：§5.5, §8で候補のみ提示。採用の可否はPhase 3以降の実装時に決定する。
4. **`.tsumugi/cache/`（サムネイル等）のGit管理除外を強制するか**：`.gitignore`相当のルールをアプリが自動生成するか、ユーザー判断に委ねるかは未決定。
5. **`## Connections` セクションの再生成頻度**：Linkが追加されるたびに即時書き換えるか、バッチ処理にするかは実装時のパフォーマンス次第。

---

# Guiding Principle

保存設計の判断に迷ったら、`MEMORY_ENGINE.md` / `DATA_MODEL.md` と同じ構造の問いを、保存設計向けに使う。

> それは、AIにとって扱いやすいか。

ではなく、

> それは、10年後、ユーザー自身の手で読み出せるか。

後者を優先する。

Markdownを選んだのも、`links.json`をプレーンJSONにしたのも、
APIキーをVaultの外に出したのも、独自バックアップ形式を作らなかったのも、
すべてこの一つの問いから導かれた結論である。

Storageは、単なる保存機能ではない。

**Tsumugiというアプリが消えても、ユーザーの人生が消えないことを保証する仕組み**である。

それが、この文書の存在理由である。
