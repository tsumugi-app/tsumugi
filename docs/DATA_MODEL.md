# Tsumugi Data Model

Version 0.1

---

# この文書について

`MEMORY_ENGINE.md` が定義した思想（記憶とは何か、どう循環し、どうつながるか）を、
実装可能な **データモデル** へ落とし込んだものが本書である。

対応関係は以下の通り。

| 上位文書 | 本書での対応 |
|---|---|
| `ARCHITECTURE.md` の Memory Object 共通構造 | §5 `MemoryObject` |
| `ARCHITECTURE.md` の Markdown / JSON Structure | §9 Markdown ⇄ TypeScript マッピング |
| `MEMORY_ENGINE.md` 3章 Memory Types | `MemoryObject.types` |
| `MEMORY_ENGINE.md` 4章 Linking | §7 `Link` |
| `MEMORY_ENGINE.md` 6-7章 Editing / Inspiration | `Link.reason` |
| `MEMORY_ENGINE.md` 8章 Seed Concept | §8 `Seed` |

本書はAPI仕様書ではない。**型（Interface）としての正しさ**を定義するものであり、
実際のストレージ実装・UI実装はこの型に従うこと。

迷ったときの判断基準は `MEMORY_ENGINE.md` と同じ。

> それは、記録の正確さのためか。それとも、未来の創造につながるためか。

型設計においても、後者を優先する（例：`Link.reason` を必須にし、単なる関連IDの羅列にしない）。

---

# 0. 設計方針

## 0.1 Local First

- **Markdownが正（source of truth）、JSON/IndexedDBは派生（index/cache）である。**
  `ARCHITECTURE.md` の「Markdown Storage / Metadata(JSON)」は同じ記憶の二つの表現だが、
  本書ではMarkdownを一次情報、TypeScript型でシリアライズされたJSONを
  検索・関連付けを高速化するための **インデックス** として位置づける。
- アプリを一切使わなくても、Markdownファイル単体で人間が読めて意味が通ることを保証する
  （`VISION.md` の「どんなAIになっても、あなたの人生は失われない」に対応）。

## 0.2 Record と Entity の区別

型を二種類に分ける。

- **Record（記録）**：ある一時点の記憶そのもの。`Conversation` / `MemoryObject` / `Event` が該当。
  時間の中の「点」。
- **Entity（対象）**：複数のRecordを横断して繰り返し登場する対象。
  `Theme` / `Person` / `Emotion` / `Goal` / `Idea` が該当。
  時間の中で育っていく「線」であり、Obsidianにおいては1対象=1ノートとして永続する。

この区別が `MEMORY_ENGINE.md` 原則2「記憶の価値は接続によって生まれる」を型レベルで支える。
Entityが「ハブ」になることで、複数のRecordが自然に集約される。

## 0.3 ID戦略（Obsidian互換の要）

Obsidianの `[[wikilink]]` はファイル名（≒ノートタイトル）で解決される。
しかしファイル名はユーザーがいつでもリネームできるため、**ファイル名をシステムの一次キーにしてはならない。**

そこで、

- すべてのRecord/Entityは frontmatter に安定した `id`（ULID）を持つ。
- `id → 現在のvault相対パス` の対応表（`index.json`、非表示・アプリ管理領域）を別途持ち、
  リンク解決・再構築の一次情報として使う。
- 人間向けの `[[wikilink]]` はあくまで**表示・Obsidianグラフ用の副産物**であり、
  リネームで壊れても `index.json` から再生成できるようにする。

## 0.4 共通ベース型

すべての型が共有する最小単位。

```typescript
/** ULID。ソート可能かつ衝突しにくく、Obsidianのファイル名にも使える文字種のため採用。 */
type ID = string;

/** ISO 8601。タイムゾーン付きで保存し、周年判定（MEMORY_ENGINE.md 4.2）の誤差を防ぐ。 */
type ISODateString = string;

interface Identifiable {
  id: ID;
}

interface Timestamped {
  /** レコードがシステムに作られた日時。編集履歴・同期の基準になる。 */
  createdAt: ISODateString;
  /** 最後に内容が変更された日時。Reflection/Inspirationの新鮮さ判定に使う。 */
  updatedAt: ISODateString;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `id` | すべてのオブジェクトを一意に識別する不変キー | ファイル名やタイトルは変わりうるため、リンク・インデックスの基盤には変わらない識別子が要る | Retrieval Engine、`Link`、`index.json`、Import/Export |
| `createdAt` | 生成日時 | 記憶の生成順序・監査、Seedの`plantedAt`算出の既定値 | Memory List画面のソート、Capture処理 |
| `updatedAt` | 最終更新日時 | 編集（Editing章）が起きたことを検知し、再インデックスの要否を判断する | Retrieval Engineのキャッシュ無効化 |

---

# 1. 型の全体像

```
                       Conversation
                            │ Capture
                            ▼
                      MemoryObject ──────── metadata: Metadata
                       │  │  │  │  │              │
        themeIds ──────┘  │  │  │  └── eventIds    └── seed?: Seed
        personIds ────────┘  │  └── ideaIds
        emotionIds ──────────┘
        goalIds
                            │
                            ▼
              Theme / Person / Emotion / Goal / Idea / Event
                     (Entity: memoryObjectIds[] で逆参照)
                            │
                            ▼
                          Link
              (source/targetを問わず、上記どの型同士も結べる)
```

- `Conversation` は Capture を経て 1つ以上の `MemoryObject` を生む（`MEMORY_ENGINE.md` 3章：1会話→複数Type）。
- `MemoryObject` は複数の Entity（`Theme`/`Person`/…）を **ID参照** する。Entity側も `memoryObjectIds` で逆参照を持ち、双方向にたどれる。
- `Link` は `MemoryObject` 同士だけでなく、Entity同士（例：Person↔Person）も結べる汎用エッジ。
- `Seed` は独立したストレージ実体ではなく、`Metadata.seed` として `MemoryObject` に付随する状態。

---

# 2. Metadata

`ARCHITECTURE.md` が定義する共通構造の「metadata」を具体化したもの。
**意味的内容（何を覚えているか）と技術的付随情報（いつ・誰が・どう生成したか）を分離する**ための型。

```typescript
type MemorySource = "ai-capture" | "user-authored" | "import" | "system-generated";

/**
 * 元の素材が何だったか（Gmail/写真/PDF/URL/Obsidianノート等）を表す軸。
 * `source`（このレコードがTsumugiのどの仕組みで生まれたか）とは意味が異なり、置き換えるものでもない。
 * Source（§9.2）にも同じ語彙を使うが、Sourceでは「資料そのものの種類」を表す一次情報として、
 * Metadataでは「このレコードが最終的にどの種類の材料に由来するかを示す、参照用のラベル」として扱う
 * （詳細な由来はMemoryObjectの`sourceId`経由でSourceを辿ることで得られる。§5参照）。
 */
type SourceType =
  | "chat"            // Conversation（AIとの対話）起点
  | "manual"          // ユーザーが直接記述
  | "obsidian-import" // 外部Obsidianノートの取り込み（Source経由。§9.2）
  | "gmail"
  | "photo"
  | "pdf"
  | "url"
  | "system"          // Reflection等、システムが生成
  | string;           // 将来の種類を型定義の変更無しで追加できる逃げ道

interface Metadata extends Timestamped {
  id: ID;
  /** このレコードが従うデータモデルのバージョン。将来のマイグレーションに使う。 */
  schemaVersion: string;
  /** 生成に使われたAIプロバイダ。ユーザー手書きの場合は undefined。 */
  aiProvider?: "claude" | "gemini" | "openai" | "local" | string;
  /** このレコードがどう生まれたか。 */
  source: MemorySource;
  /** 元の素材が何だったか。未設定の場合はMarkdown読み込み時に`source`から推測される。 */
  sourceType?: SourceType;
  /** sourceTypeごとの由来情報（messageId・fileName・url等）を自由に持たせる最小限のbag。 */
  sourceDetail?: Record<string, string>;
  /** AI抽出の確信度（0-1）。低い場合はReflection/Inspirationで断定を避ける根拠になる。 */
  confidence?: number;
  /** Seed Concept（MEMORY_ENGINE.md 8章）。種として扱うMemoryObjectのみ値を持つ。 */
  seed?: Seed;
  obsidian?: ObsidianMeta;
  sync?: SyncMeta;
}

interface ObsidianMeta {
  /** 直近の書き込み時点でのvault内相対パス。表示・デバッグ用のヒント。正はindex.json側。 */
  vaultPath: string;
  /** Obsidianの複数名検索・エイリアス機能に対応する別名。 */
  aliases?: string[];
  /** Obsidianタグ（例: "theme/career"）。Themeとの二重管理にせず、Themeから導出して書き込む。 */
  tags?: string[];
}

interface SyncMeta {
  /** 将来のクラウド同期・マルチデバイス対応用。MVPでは常にundefined。 */
  deviceId?: string;
  lastSyncedAt?: ISODateString;
  /** ローカル変更が未同期であることを示すフラグ。 */
  dirty?: boolean;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `schemaVersion` | データモデルのバージョン番号 | 将来フィールドを追加・変更した際、旧データを安全に移行するため | Import時のマイグレーション処理 |
| `aiProvider` | どのAIが生成したか | `VISION.md`「AI is replaceable」を型で保証する。AIを差し替えても過去のMetadataは残り、AI依存のロジックを書かないよう戒める | デバッグ、AI切替時の互換性確認 |
| `source` | 生成経路 | AI生成／ユーザー手書き／インポートを区別しないと、Reflectionで「事実・解釈・提案の区別」（MEMORY_ENGINE.md 5.3）ができない | Reflection、信頼度表示 |
| `sourceType` | 元の素材の種類 | `source`だけでは「Gmail由来」「PDF由来」等の区別ができないため、外部データ取り込み（§9.2）に備えて追加する。列挙+`string`で将来の種類追加に型変更を要らなくする | Source基盤、UI表示（将来） |
| `sourceDetail` | 由来の自由記述情報 | messageId・fileName・url等、sourceTypeごとに異なる由来情報を型を増やさず保持するため | Source基盤（将来） |
| `confidence` | AI抽出の確信度 | `AI_DESIGN.md`「確信のない解釈を断定してはならない」を数値として持たせ、UI側で表現を変える | Reflection/Inspirationの文言選択 |
| `seed` | 種としての状態 | 8章Seed Conceptを型として表現する。すべての記憶が種ではないため、MemoryObject本体ではなくMetadataに付随させ、オプショナルにする | Inspiration素材選定、Remember Moments |
| `obsidian.vaultPath` | 最終書き込みパス | index.json破損時の復旧手がかり。人間がFinderで探す際の手助け | Import/Export、障害復旧 |
| `obsidian.aliases` | 別名 | 同じ人物・テーマが別の呼び方で言及されることがある（例：「田中さん」「タナカ」） | Connect（同一Entity判定）、Obsidianのクイックスイッチャー |
| `sync.*` | 将来の同期用フィールド | `PROJECT.md`/`README.md`のRoadmapにある将来のクラウド同期・複数端末対応に備えるが、MVPでは未使用であることを明示 | 将来のsync実装（現状は未使用） |

---

# 3. Seed

`MEMORY_ENGINE.md` 8章の「種」を型にしたもの。**独立したストレージエンティティではなく**、
`Metadata.seed` として既存の `MemoryObject` に付随する状態である
（8.2「通常のMemory Objectに対して『未発芽』という状態を持つ特殊な記憶として扱う」に対応）。

```typescript
type SeedStage =
  | "dormant"     // 未発芽：まだ十分な接続を持たない
  | "germinated"  // 発芽：初めて意味のあるリンクを獲得した
  // 以下2つは MEMORY_ENGINE.md 8.5「将来構想（非公式）」に対応する予約値。
  // 正式仕様ではないため、v0.1時点ではUI/AIロジックの分岐対象にしない。
  | "growing"     // 成長
  | "fruited";    // 実

interface Seed {
  stage: SeedStage;
  /** 種として蒔かれた日時。通常はMemoryObject.dateと同じだが、明示的に独立させる。 */
  plantedAt: ISODateString;
  /** 発芽が起きた日時。dormantのままならundefined。 */
  germinatedAt?: ISODateString;
  /** 発芽のきっかけになったLink。「何が引き金だったか」を後から辿れるようにする。 */
  germinatedByLinkId?: ID;
  /** Remember Momentsなどで低頻度に再提示された回数。押しつけを防ぐ頻度制御に使う。 */
  revisitCount: number;
  lastSurfacedAt?: ISODateString;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `stage` | 種の発育段階 | 8章の「未発芽→発芽」という状態遷移を型で表現しないと、Inspirationが種を優先素材にできない | Inspiration素材選定（8.4-2） |
| `plantedAt` | 種を蒔いた日 | 発芽までの期間を可視化し、「ずっと気になっていたことがついに芽吹いた」という体験を作る | Reflection、Remember Moments |
| `germinatedAt` | 発芽日 | 8.3「発芽はLifecycleの気づきの中でも特に価値が高いイベント」を記録し、後から振り返れるようにする | 成功指標の計測（PROJECT.md 14章）、通知文言生成 |
| `germinatedByLinkId` | 発芽の引き金となったLink | 「なぜ今つながったか」を遡れることが、Editing（6章）の説明責任を果たす前提になる | Reflectionでの説明文生成 |
| `revisitCount` / `lastSurfedAt` | 再提示の履歴 | `UI_UX.md`「驚きはあってよいが、押しつけてはならない」を頻度制御として実装するため必須 | Remember Momentsの表示頻度制御 |

---

# 4. Conversation

`AI_DESIGN.md` Memory Pipeline の起点。ユーザーとAIの生の会話ログであり、
**この段階ではまだ他の記憶と接続されていない**（`MEMORY_ENGINE.md` 2.1-2.2）。

```typescript
type Persona = "companion" | "coach" | "analyst";

interface ConversationTurn {
  role: "user" | "ai";
  content: string;
  timestamp: ISODateString;
}

interface Conversation extends Identifiable, Timestamped {
  id: ID;
  persona: Persona;
  startedAt: ISODateString;
  endedAt?: ISODateString;
  turns: ConversationTurn[];
  /** Captureがまだ走っていない/走った/アーカイブ済みかの状態機械。 */
  status: "active" | "captured" | "archived";
  /** Captureで生成されたMemoryObjectへの参照。1会話→複数Typeのため配列。 */
  memoryObjectIds: ID[];
  metadata: Metadata;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `persona` | 会話時に選ばれていたAI人格 | `REQUIREMENTS.md` 6章のPersona要件。同じ内容でもCompanion/Coach/Analystで抽出されるTypeや感情の重みが変わりうる | Capture時のプロンプト分岐、Reflectionでの文脈提示 |
| `turns` | 発話の時系列配列 | Conversation Layer（`ARCHITECTURE.md`）の責務である「送受信・ストリーミング」を保存し、後からMemoryObjectの根拠原文に戻れるようにする | Chat画面の再現、Capture処理の入力 |
| `status` | Captureの進行状態 | `MEMORY_ENGINE.md` 2.1-2.2「会話が終わるとMemory Objectへ変換される」という非同期処理の途中状態を管理するため | バックグラウンドCaptureジョブのキュー管理 |
| `memoryObjectIds` | 抽出されたMemoryObject群 | 1つの会話から複数Type（Event+Person+Emotion+Goal等）が同時抽出される（3章）ため、1対多にする | MemoryObject詳細画面からの原文遡り |

---

# 5. MemoryObject

`ARCHITECTURE.md` の共通構造 + `MEMORY_ENGINE.md` 3章のTypeを統合した、**このシステムの中心となる型**。

```typescript
type MemoryType =
  | "conversation" // 日々のやり取りそのもの（既定Type）
  | "diary"        // 一日の振り返り、独白的な内容
  | "idea"         // 思いつき、構想、仮説
  | "emotion"      // 気分・心理状態の記録
  | "goal"         // 達成したいこと、意図
  | "person"       // 特定の人物についての情報の蓄積
  | "event"        // 実際に起きた事実
  | "insight";     // Lifecycleの「創造」から生まれた記憶

interface MemoryObject extends Identifiable, Timestamped {
  id: ID;
  /** この記憶が指す時点。Eventなら発生日、それ以外は基本的に会話日と同じ。 */
  date: ISODateString;
  /** 排他的ではない（3章）。1つの記憶が複数Typeを同時に持ってよい。 */
  types: MemoryType[];
  /**
   * 由来元の会話。ユーザーが直接書いた記憶、Source起点の記憶ならundefined。
   * `sourceId`とは現時点では排他的：Conversation起点のMemoryは`conversationId`のみ、
   * Source起点のMemoryは`sourceId`のみを持つ。両方を同時に持つケースは今回のスコープでは想定しない。
   */
  conversationId?: ID;
  /**
   * 由来元のSource（§9.2）。Conversationを経由しないMemory（Gmail/PDF/写真/URL/
   * Obsidian Import等の外部データから抽出された記憶）が持つ。`conversationId`とは排他的。
   * 今回のSource基盤の設計に伴い追加予定のフィールドであり、現時点の実装（`src/lib/types.ts`）には
   * まだ存在しない（型としてはこの文書に先に記載するのみ）。
   */
  sourceId?: ID;
  /** Markdown本文。原文、または後から編集（Editing）された内容。 */
  content: string;
  summary: string;
  keywords: string[];
  themeIds: ID[];
  personIds: ID[];
  emotionIds: ID[];
  goalIds: ID[];
  ideaIds: ID[];
  eventIds: ID[];
  links: Link[];
  metadata: Metadata;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `date` | 記憶の指す時点 | 「一年前の今日」（4.2 時間リンク）の判定はこの日付が基準になる。作成日時（`createdAt`）と分離しないと、後から追記されたEventの日付がずれる | Remember Moments、Reflectionの周年判定 |
| `types` | この記憶が何についてのものか | 3章「1つの会話から複数Typeの記憶が同時に抽出されてよい」を型として保証する。単一の `type: string` にすると複数Type抽出を表現できない | Reflection/Inspirationでの扱われ方の分岐、Memory List画面のフィルタ |
| `conversationId` | 原文へのリンク | Reflectionが「事実」を語る際、実際に何と発言されたかへ遡れることが5.3「事実・解釈・提案の区別」の前提になる | Memory Detail画面の「原文を見る」 |
| `sourceId` | 原資料（Source）へのリンク（追加予定） | Conversationを経由しないMemory（外部データ取り込み由来）が、どのSourceから抽出されたかを追跡するため。`conversationId`と対称的な参照だが、両者は排他的に扱う（§9.2） | Memory Detail画面の「原資料を見る」（将来） |
| `content` | Markdown本文 | Markdown Firstの原則（`VISION.md`）を満たすには、要約だけでなく本文そのものをMarkdownとして持つ必要がある | Obsidianでの直接閲覧・編集 |
| `summary` | 短い要約 | 検索結果一覧・Retrieval Engineへの軽量なコンテキスト提供に必要（全文を毎回AIに渡さないため） | Memory List、Retrieval Engineの一次候補提示 |
| `keywords` | キーワード配列 | Linkingの最優先軸「完全一致キーワード」（4.6）の元データ | 検索、Link生成の一次判定 |
| `themeIds`〜`eventIds` | 各Entityへの参照 | `MEMORY_ENGINE.md` 4章のリンク軸（人物・テーマ・感情）をID参照として型に落とし込む。文字列の重複保持を避け、Entity側の`memoryObjectIds`との整合を保つ | Connect処理、Entity詳細画面での逆引き一覧 |
| `links` | この記憶が持つLink一覧 | 記憶単体からその接続関係を即座に読めるようにする非正規化（Link自体はグローバルにも保持されるが、表示・編集の利便性のためここにも持つ） | Memory Detail画面のReflection表示 |
| `metadata` | 技術的付随情報 | §2参照 | 全レイヤー |

---

# 6. Entity 共通基盤

`Theme` / `Person` / `Emotion` / `Goal` / `Idea` / `Event` はすべて、
複数の `MemoryObject` を横断して繰り返し登場する対象という共通の性質を持つ。
重複を避けるため共通基盤 `EntityBase` を定義し、各型はこれを拡張する。

```typescript
interface EntityBase extends Identifiable, Timestamped {
  id: ID;
  /** Obsidianのノートタイトルにもなる正式名称。 */
  name: string;
  /** 表記ゆれ・別名。Connect処理での同一Entity判定に使う。 */
  aliases: string[];
  firstMentionedAt: ISODateString;
  lastMentionedAt: ISODateString;
  /** このEntityが登場するMemoryObjectへの逆参照。 */
  memoryObjectIds: ID[];
  metadata: Metadata;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `name` | 正式名称 | Obsidianではノート＝ファイル名がタイトルになるため、Entityの実体はこの`name`のノートとして永続化される | ファイル名生成、`[[wikilink]]`表示 |
| `aliases` | 別名一覧 | 同一人物・テーマが異なる表現で言及されたとき、誤って新規Entityを作らないための同一性判定に必須 | Connect処理（4章）の名寄せ |
| `firstMentionedAt` / `lastMentionedAt` | 初出・最終言及日 | 「その人との関係の変化」（4.1）という物語を成立させるには、Entity自体が時間の幅を持つ必要がある | Person/Theme詳細画面のタイムライン表示 |
| `memoryObjectIds` | 逆参照 | `MemoryObject.themeIds`等からの片方向参照だけでは、「このテーマについて過去に何を話したか」を高速に引けない | Retrieval Engineの候補抽出、Entity詳細画面 |

---

## 6.1 Theme

```typescript
interface Theme extends EntityBase {
  description?: string;
  /** 類似テーマ・上位下位テーマへの参照（例：「転職」⇄「キャリア」）。 */
  relatedThemeIds: ID[];
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `description` | テーマの補足説明 | AIまたはユーザーが「このテーマが何を指すか」を明文化しておくと、Inspirationでの編集材料として使いやすくなる | Inspiration文脈生成 |
| `relatedThemeIds` | 類義・関連テーマ | 4.3「最も汎用的なリンク軸」であるテーマ同士にも階層・類似関係があり、それを無視すると同義語で記憶が分断される | Connect処理、Theme詳細画面 |

## 6.2 Person

```typescript
interface Person extends EntityBase {
  /** 自由記述の関係性（例：「友人」「家族」「同僚」）。カテゴリ固定にせず表現の幅を残す。 */
  relationship?: string;
  relatedPersonIds: ID[];
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `relationship` | ユーザーとの関係性 | 4.1「時間を超えた最も強いリンクの軸」である人物リンクの質を上げるため、単なる名前以上の文脈を持たせる | Reflectionでの人物言及時の文脈補完 |
| `relatedPersonIds` | 人物同士のつながり | 「AさんはBさんの同僚」のような関係網は、それ自体がInspirationの編集材料になりうる | Inspiration、Person詳細画面 |

## 6.3 Emotion

```typescript
type EmotionValence = "positive" | "negative" | "neutral" | "mixed";

interface Emotion extends EntityBase {
  valence: EmotionValence;
  /** 出現時点の平均的な強度（0-1）。 */
  intensity: number;
  occurrenceCount: number;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `valence` | 感情の方向性 | 4.4「対照的な感情でもつながる」を型で判定可能にする。対照は一致と同じくらい価値がある（`Link.contrast`と対応） | Connect処理での対照リンク検出 |
| `intensity` | 強度 | 「あのときは絶望していたが、今は希望を感じている」という変化の大きさを定量的に扱うため | Reflectionでの変化の言語化 |
| `occurrenceCount` | 出現回数 | 繰り返し現れる感情パターン（例：慢性的な不安）を検出するための最小限の集計値 | Reflection「最近このテーマで悩むことが多いようです」の根拠 |

## 6.4 Goal

```typescript
type GoalStatus = "active" | "achieved" | "abandoned" | "paused";

interface Goal extends EntityBase {
  status: GoalStatus;
  targetDate?: ISODateString;
  relatedIdeaIds: ID[];
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `status` | 目標の進行状態 | 「同じ目標について再び言及されたとき」（5.1想起のタイミング）を検知するには、目標が生きているか終わっているかの状態が要る | Reflectionの想起トリガー判定 |
| `targetDate` | 目標期限（任意） | 期限つきの目標は周年・締切近接での想起価値が高い | Remember Moments |
| `relatedIdeaIds` | 関連するアイデア | 目標とアイデアは相互に生成しあう関係にあるため（目標→アイデア、アイデア→目標） | Inspirationでの編集材料の連鎖探索 |

## 6.5 Idea

```typescript
type IdeaStage = "spark" | "exploring" | "acting" | "realized" | "discarded";
// 思いつき / 検討中 / 実行中 / 実現 / 破棄

interface Idea extends EntityBase {
  stage: IdeaStage;
  originMemoryObjectId?: ID;
  relatedGoalIds: ID[];
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `stage` | アイデアの成熟度 | Ideaは`Seed`との親和性が最も高いType（8.4-2「Inspirationの目的が潜在的な材料の組み合わせである以上、最も相性が良い」）であり、まだ育っていない段階を明示する必要がある | Inspiration素材の優先度付け |
| `originMemoryObjectId` | 生まれた瞬間の記憶 | 7章Inspirationの「創造の結果は新しいMemory Objectとして保存される」というループを、逆方向にも遡れるようにする | Idea詳細画面での起源表示 |
| `relatedGoalIds` | 関連する目標 | Goal同様、双方向の連鎖を辿れるようにする | Inspiration |

## 6.6 Event

```typescript
interface Event extends EntityBase {
  /** 記録された日ではなく、実際にその出来事が起きた日。 */
  occurredAt: ISODateString;
  /**
   * 場所。MEMORY_ENGINE.md 4.5により、専用Entityとして独立させるか
   * テーマの一種として扱うかは未確定のため、v0.1では自由記述文字列に留める。
   */
  place?: string;
  participantIds: ID[];
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `occurredAt` | 実際の発生日 | Eventは3章の表で「実際に起きた事実」と定義されており、記録日とのズレ（後日談として語られた過去の出来事）を保持する必要がある | Reflectionの時系列整合性チェック |
| `place` | 場所 | `MEMORY_ENGINE.md` 4.5で「専用フィールドとして独立させるかは未確定」と明記されている事項。本書でも同様に**未確定のまま**、最小実装として文字列に留める | 将来、場所リンク軸を実装する際の移行元データ |
| `participantIds` | 参加した人物 | Person Entityとの接続を型で保証し、「あの出来事に誰がいたか」からPersonリンクを生成できるようにする | Connect処理（人物リンクの発見） |

---

# 7. Link

`MEMORY_ENGINE.md` 4章のリンクと、6章Editingの核心（「なぜつながるかを言語化する」）を型にしたもの。
**単なる関連ID配列ではなく、関係そのものを表す独立したオブジェクト**として設計する。

```typescript
type LinkAxis = "person" | "time" | "theme" | "emotion" | "place";

type LinkSource =
  | "auto-exact"      // 完全一致キーワード（4.6 優先度1）
  | "auto-linked"     // 既存のリンク経由（優先度2）
  | "auto-semantic"   // 意味的類似性（優先度3）
  | "ai-inference"    // AI推論（優先度4、明示的な一致がない場合のみ）
  | "user";           // ユーザーが手動で作成

interface Link extends Identifiable {
  id: ID;
  /** MemoryObject同士に限らず、Entity同士（Person↔Personなど）も結べる。 */
  sourceId: ID;
  targetId: ID;
  axis: LinkAxis;
  /**
   * なぜこの2つが今つながるのか、を編集者としてのAIが言語化した説明。
   * 6章「編集とは、複数の記憶から一本のストーリーを見つけること」の核であり、必須項目とする。
   */
  reason: string;
  /** 4.4「対照的な感情でもつながる」ように、一致ではなく対照によるリンクかどうか。 */
  contrast: boolean;
  /** リンクの確からしさ（0-1）。4.6「リンクの質は量より優先される」の判定に使う。 */
  strength: number;
  createdBy: LinkSource;
  createdAt: ISODateString;
}
```

| フィールド | 意味 | 必要な理由 | 利用箇所 |
|---|---|---|---|
| `sourceId` / `targetId` | 結ばれる2つのオブジェクト | 5つのリンク軸すべてが「何かと何かの間」の関係であるため、方向を持つペアとして表現する | Connect処理、グラフ表示 |
| `axis` | どの軸でつながったか | 4章で定義された人物/時間/テーマ/感情/場所という異なる性質のリンクを、後から軸ごとに重み付け・表示分けするために区別が要る | Reflection文言の出し分け（「同じ人物が」「同じ時期に」等） |
| `reason` | 接続の理由の言語化 | 6章「Tsumugiは、リンクの先にある意味まで踏み込む」がプロダクトの最大の差別化点であるため、**理由を持たないLinkを許容しない**。ここを省略できる型にすると、単なるObsidianの`[[wikilink]]`と変わらなくなる | Inspiration出力（7.2「なぜそれらが今つながるのか」）、Reflection |
| `contrast` | 対照によるリンクか | 4.4「対照は一致と同じくらい価値がある」を、UIやAIロジックが分岐できるよう明示的なフラグにする | Reflectionの変化検出ロジック |
| `strength` | 確からしさ | 4.6の優先順位（完全一致→既存リンク→意味的類似→AI推論）を数値化し、弱い根拠のリンクを乱発しないための閾値判定に使う | Link生成時のフィルタリング |
| `createdBy` | 生成経路 | どの優先順位で生成されたリンクかを追跡できないと、後から「なぜこのリンクができたか」を検証できない | デバッグ、Reflectionでの確信度表現 |

---

# 8. Markdown ⇄ TypeScript マッピング（Obsidian互換）

## 8.1 フォルダ構成（提案）

```
vault/
├── Conversations/        # Conversation（原則、AI向けの生ログ。ユーザーは普段開かない）
├── Memories/             # MemoryObject（日々の記憶。中心となる閲覧対象）
├── People/               # Person Entity（1人1ノート）
├── Themes/               # Theme Entity（1テーマ1ノート）
├── Emotions/             # Emotion Entity
├── Goals/                # Goal Entity
├── Ideas/                # Idea Entity
├── Events/               # Event Entity
└── .tsumugi/
    ├── index.json         # id → 現在のvault相対パス の対応表（§0.3）
    └── schema-version.json
```

Recordは日付ベース、Entityは名前ベースのファイル名にする
（`ARCHITECTURE.md` のMarkdown Structure例 `# 2026-07-25` を踏襲しつつ、Entityは`Person/山田太郎.md`のように命名）。

## 8.2 MemoryObject の書き出し例

```markdown
---
id: 01J9X...           # ULID。wikilinkが壊れてもこのidで復旧できる
tsumugi: true           # Tsumugiが管理するノートであることの目印（Import時の判定に使用）
date: 2026-07-25
types: [event, person, emotion]
keywords: [転職, 相談, 不安]
themes: ["[[転職]]"]
people: ["[[山田太郎]]"]
emotions: ["[[不安]]", "[[期待]]"]
aiProvider: claude
schemaVersion: "0.1"
---

# 2026-07-25

## Summary
友人の山田太郎と転職について相談した。不安もあるが期待もある。

## Related
[[転職]] [[山田太郎]] [[不安]] [[期待]]
```

`ARCHITECTURE.md` のMarkdown Structure例をそのまま踏襲しつつ、
`id` と `tsumugi: true` をfrontmatterに追加している。この2つが本書での唯一の必須拡張であり、
それ以外はObsidianの一般的なfrontmatter運用と変わらない（＝既存vaultとの親和性を壊さない）。

## 8.3 Entity（Person）の書き出し例

```markdown
---
id: 01J9Y...
tsumugi: true
aliases: [山田さん, タナカではなく山田]
firstMentionedAt: 2024-03-10
lastMentionedAt: 2026-07-25
relationship: 友人
---

# 山田太郎

大学時代からの友人。キャリアの話をよくする。

## 登場する記憶
- [[2026-07-25]]（転職相談）
- [[2024-03-10]]（転職相談の初出）
```

Entityノートの本文（`## 登場する記憶`）はアプリが自動生成・更新する派生セクションであり、
`memoryObjectIds` のMarkdown上の表現にあたる。**正はfrontmatter/JSON側であり、本文は表示用の再構築物**とする。

---

# 9. Import / Export 設計

## 9.1 Export

- **完全な形はvault全体そのもの**（Markdownファイル群）。追加でJSONを出す必要すらないのが理想形。
- 機械可読なバックアップ・移行用に、`.tsumugi/index.json` を含む全型のJSONスナップショット
  （`{ conversations: Conversation[], memoryObjects: MemoryObject[], people: Person[], ... }`）を
  1ファイルとしても書き出せるようにする（`REQUIREMENTS.md` 3.4/8「データエクスポート」対応）。
- どちらの形式でエクスポートしても、`id` を軸に再インポート可能であること。

## 9.2 Import

2つのケースを区別する。

1. **自分のエクスポートを再インポート**：`id` が一致するため機械的にマージできる。
2. **外部データの取り込み**（既存の（Tsumugi管理外の）Obsidian vault、および将来のGmail/PDF/写真/URL等）：
   取り込んだ内容から**AIがMemoryObjectの下書きを直接生成することはしない**。
   まず**Source**（原資料そのもの。詳細な保存構造は`STORAGE.md`で定義する）として保存し、
   ユーザーが後から参照できる形で保持する。Sourceの内容は、必要になった時点でAIが選択的に解析し、
   Tsumugiが「覚えておく価値がある」と判断した情報だけを`MemoryObject`として抽出する
   （抽出されたMemoryObjectは`sourceId`でどのSourceから生まれたかを参照する。§5参照）。
   抽出されなかった部分もSourceにはそのまま残り続けるため、後から読み返すことができる。

   Obsidian vaultの場合、frontmatterに `tsumugi: true` が無いノートは「未知のノート」として扱い、
   MemoryObject化を**強制しない**。ユーザーに「取り込みますか」を確認してから、
   Sourceとして保存する（`metadata.sourceType = "obsidian-import"`）。ここでの`sourceType`は
   「Sourceという原資料そのものの種類」を表す一次情報であり、そこから後にMemoryObjectが
   抽出された場合は、そのMemoryObjectの`metadata.sourceType`にも同じ値が付く
   （「このMemoryが最終的にどの種類の材料に由来するか」を示す参照用ラベルとして。§2参照）。

この非対称な扱いが重要である。**Tsumugiが管理していないノートを勝手に書き換えてはならない**
（`ARCHITECTURE.md` Guiding Rule「新機能追加より先にユーザーの記憶を守る」に対応）。

---

# 10. 未確定事項

`MEMORY_ENGINE.md` の姿勢に倣い、矛盾ではなく**未確定事項として明記**する。

1. **Place（場所）の独立Entity化**：4.5と同様、本書でも `Event.place` を暫定的に文字列のままにしている。
   専用Entity（`Place`）として`Theme`同様の構造を持たせるかは、アーキテクチャ側の正式決定を待つ。
2. **Seedの`growing`/`fruited`ステージ**：8.5の将来構想に対応する予約値。v0.1のAIロジック・UIは
   `dormant`/`germinated`の2値のみを正式に扱い、残り2値は型としてのみ先に用意する。
3. **Link生成時の重複・マージ規則**：同じ2オブジェクト間に複数の軸でLinkが生まれた場合
   （例：person軸とtheme軸で同時に一致）、1つのLinkに軸を複数持たせるか、Linkを複数生成するかは未決定。
   本書は後者（Link:軸=1:1）を採用しているが、実装時の再検討を妨げない。
4. **EmotionのTaxonomy**：`Emotion.name`（EntityBase由来）が自由文字列か、Plutchikの感情の輪のような
   固定語彙かは未確定。自由文字列を採用する場合、表記ゆれの吸収は`aliases`に委ねる。

---

# Guiding Principle

型を追加・変更するときに迷ったら、`MEMORY_ENGINE.md` の問いをそのまま使う。

> それは、記録の正確さのためか。それとも、未来の創造につながるためか。

後者を優先する。`Link.reason` を必須フィールドにしたのはその判断の具体例である。
