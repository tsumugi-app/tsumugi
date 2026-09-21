/**
 * DATA_MODEL.md に定義された型のうち、Milestone 1（話すだけで記憶が保存される）に
 * 必要な範囲を実装したもの。
 *
 * Entity（Theme/Person/Emotion/Goal/Idea/Event）と Link の実体生成は
 * MEMORY_ENGINE.md 2.3 Connect / ROADMAP.md Phase 2 のスコープであり、
 * ここでは型としての参照（ID配列）のみを持つ。Phase 1 では常に空配列になる。
 */

/** ULID。ソート可能かつ衝突しにくく、Obsidianのファイル名にも使える文字種。 */
export type ID = string;

/** ISO 8601（タイムゾーン付き）。 */
export type ISODateString = string;

export interface Identifiable {
  id: ID;
}

export interface Timestamped {
  createdAt: ISODateString;
  updatedAt: ISODateString;
}

export type MemorySource =
  | "ai-capture"
  | "user-authored"
  | "import"
  | "system-generated";

export type SeedStage = "dormant" | "germinated" | "growing" | "fruited";

/** MEMORY_ENGINE.md 8章。Phase 1 では生成しない（Connect/Inspirationの前提が無いため）が、型は先に用意する。 */
export interface Seed {
  stage: SeedStage;
  plantedAt: ISODateString;
  germinatedAt?: ISODateString;
  germinatedByLinkId?: ID;
  revisitCount: number;
  lastSurfacedAt?: ISODateString;
}

export interface ObsidianMeta {
  /** 直近の書き込み時点でのvault内相対パス。正はindex.json側。 */
  vaultPath: string;
  aliases?: string[];
  tags?: string[];
}

/** MVPでは常に未使用。将来のクラウド同期・マルチデバイス対応用（frontmatterには書き出さない）。 */
export interface SyncMeta {
  deviceId?: string;
  lastSyncedAt?: ISODateString;
  dirty?: boolean;
}

/**
 * 将来の外部データ取り込み（Gmail/写真/PDF/URL等）に備えた、素材の種類を表す軸。
 * 既存の`MemorySource`（Tsumugiのどの仕組みがこのレコードを生成したか）とは意味が異なり、
 * 置き換えるものでもない。今回はこの型と`Metadata`への追加のみを行い、実際に
 * "gmail"等を代入するImporter自体は実装しない（既存パイプラインはsourceTypeを一切設定しない）。
 * `aiProvider`と同じく列挙+`string`の逃げ道を持たせ、新しい取り込み元を追加するたびに
 * この型定義を変更しなくてよいようにする。
 */
export type SourceType =
  | "chat"
  | "manual"
  | "obsidian-import"
  | "gmail"
  | "photo"
  | "pdf"
  | "url"
  | "system"
  | string;

export interface Metadata extends Timestamped {
  id: ID;
  schemaVersion: string;
  aiProvider?: "claude" | "gemini" | "openai" | "local" | string;
  source: MemorySource;
  /** 元の素材が何だったか（Gmail/写真/PDF/URL等）。未設定の場合はMarkdown読み込み時に`source`から推測される（markdown.tsのinferSourceType参照）。 */
  sourceType?: SourceType;
  /** sourceTypeごとの由来情報（messageId・fileName・url等）を自由に持たせるための最小限のbag。 */
  sourceDetail?: Record<string, string>;
  confidence?: number;
  seed?: Seed;
  obsidian?: ObsidianMeta;
  sync?: SyncMeta;
}

export type Persona = "companion" | "coach" | "analyst";

export interface ConversationTurn {
  role: "user" | "ai";
  content: string;
  timestamp: ISODateString;
  /**
   * このAIターンを生成するリクエストで、Web検索が有効化されていたか（`needsWebSearch()`の
   * 判定結果）。実際に検索結果が取得できた・groundingが発生したことを意味するものではない
   * （そのためwebSearchUsedという名前にはしない）。role: "user"のturnには設定しない。
   * 既存Conversationとの後方互換性のためoptional（未設定＝不明として扱う）。
   */
  webSearchRequested?: boolean;
  /**
   * このAIターンを生成した直前のユーザー発言が、明示的な記録依頼だったか
   * （`looksLikeRecordRequest()`の判定結果）。Test 27で判明した通り、AI出力の見た目
   * だけを見る`looksLikeRecordFormat()`は短い記録本文を検出し損ねることがあるため、
   * 生成時点でこの事実を確定させ、後続ターンでの記録形式保護に利用する（Test 31）。
   * role: "user"のturnには設定しない。既存Conversationとの後方互換性のためoptional。
   */
  isRecordTurn?: boolean;
}

export interface Conversation extends Identifiable, Timestamped {
  id: ID;
  persona: Persona;
  startedAt: ISODateString;
  endedAt?: ISODateString;
  turns: ConversationTurn[];
  status: "active" | "captured" | "archived";
  memoryObjectIds: ID[];
  /**
   * Beta「過去からの問いかけ」。この会話が、どのMemoryをきっかけに始まったかの追跡用。
   * 通常のConversationでは常にundefined。Vault Markdownへは書き出さない
   * （実行時・IndexedDBの補助情報にとどめ、既存のfrontmatterスキーマは変更しない）。
   */
  promptedMemoryId?: ID;
  metadata: Metadata;
}

export type MemoryType =
  | "conversation"
  | "diary"
  | "idea"
  | "emotion"
  | "goal"
  | "person"
  | "event"
  | "insight";

/**
 * Time Axis Phase 2（Event Time, v1）。day/month/yearの3段階のみを許可する
 * （「unknown」等のsentinel値は作らない。不明な場合はMemoryObject側の2フィールドとも
 * 未設定にすることで表現する）。
 */
export type EventTimePrecision = "day" | "month" | "year";

/** MEMORY_ENGINE.md 4章 / DATA_MODEL.md §7。Phase 1（Capture）では生成されず、常に空配列。 */
export type LinkAxis = "person" | "time" | "theme" | "emotion" | "place";

export type LinkSource =
  | "auto-exact"
  | "auto-linked"
  | "auto-semantic"
  | "ai-inference"
  | "user";

export interface Link extends Identifiable {
  id: ID;
  sourceId: ID;
  targetId: ID;
  axis: LinkAxis;
  reason: string;
  contrast: boolean;
  strength: number;
  createdBy: LinkSource;
  createdAt: ISODateString;
}

/**
 * Personal Profile v1（Personal Modelの最初の層）。ユーザー自身の明示的な発言だけを根拠にした、
 * 「会話の前提として使う価値が高い安定情報」の候補（claim）。MemoryObjectに付随して保存され
 * （`MemoryObject.profileClaims`、追加のみのoptionalフィールド。IndexedDBバージョンアップ・Vault migration不要）、
 * ProfileFact（現在有効か・過去か・予定か）は、全Memoryのclaimから決定的に計算する派生ビューであり、保存しない
 * （src/lib/profile.ts）。AIの推測（性格・価値観・感情等）は保存しない：`stated`は"explicit"のみ。
 */
export const PROFILE_CATEGORIES_V1 = ["residence", "occupation", "household", "project", "goal", "preference"] as const;
export type ProfileCategoryV1 = (typeof PROFILE_CATEGORIES_V1)[number];
/**
 * 将来のcategory（大切にしていること・長期的な方針・自己認識など、ユーザー自身が明示したもの）を、データ移行なしで
 * 足せるよう文字列として保持する。未知のcategoryは読み込み時に保持するが、v1のviewでは使わない。
 */
export type ProfileCategory = ProfileCategoryV1 | (string & {});
export type ProfileTense = "current" | "former" | "planned";
/** none：通常の言明／began：「〜した・〜になった」という変化の完了／ended：「〜をやめた・辞めた」という終了。 */
export type ProfileChange = "none" | "began" | "ended";
export type HouseholdRelation = "partner" | "child" | "parent" | "sibling" | "pet" | "other";

export interface ProfileClaim {
  /** ULID。Tsumugiが採番する（LLMは採番しない）。 */
  id: ID;
  category: ProfileCategory;
  /** Tsumugiが決定的に作る、同一対象の識別キー（例："residence:primary"、"household:child"、"project:レンタカー事業"）。 */
  slot: string;
  /** 比較用の短い値（residence:"千葉"、occupation:"A社 営業"）。 */
  value?: string;
  /** ユーザー視点の、時間に依存しない短い言明（「千葉に住んでいる」）。 */
  statement: string;
  tense: ProfileTense;
  change: ProfileChange;
  /** v1は常に"explicit"（ユーザーが明示した内容）のみ。推測（inferred）の値は作らない。 */
  stated: "explicit";
  /** ユーザー発言からの逐語の抜粋（根拠）。 */
  quote: string;
  /** quoteを含むユーザーturnのtimestamp（Recorded Time。事実が成立した時期＝validFromとは別）。 */
  statedAt: ISODateString;
  /** 由来の会話。Capture UPDATEは別Conversationの関連Memoryも更新しうるため、claim自身が持つ。 */
  sourceConversationId: ID;
  /** この事実（または予定）が成立する（した）時期。Event Timeと同じ形式。会話に明示されている場合のみ。 */
  validFrom?: string;
  validFromPrecision?: EventTimePrecision;
  /** Tsumugiがclaimを保存した時刻。 */
  recordedAt: ISODateString;
  confidence?: number;
  /** 将来"user-authored"（ユーザーが直接追加・修正）を足せる。 */
  origin: "ai-extracted";
  schemaVersion: 1;
}

export interface MemoryObject extends Identifiable, Timestamped {
  id: ID;
  date: ISODateString;
  types: MemoryType[];
  /**
   * 由来元の会話。ユーザーが直接書いた記憶、Source起点の記憶ならundefined。
   * `sourceId`とは現時点では排他的：Conversation起点のMemoryは`conversationId`のみ、
   * Source起点のMemoryは`sourceId`のみを持つ。両方を同時に持つケースは今回のスコープでは想定しない。
   */
  conversationId?: ID;
  /**
   * 由来元のSource（下記）。Conversationを経由しないMemory（Gmail/PDF/写真/URL/
   * Obsidian Import等の外部データから抽出された記憶）が持つ。`conversationId`とは排他的。
   * Source基盤（今回追加）のみで使う。既存のCapture（会話由来）は一切設定しない。
   */
  sourceId?: ID;
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
  /**
   * Beta「過去からの問いかけ」。このMemoryを材料に生成済みの、再訪用の短い問いかけ文。
   * Capture直後に一度だけ生成する（トップ画面表示のたびには生成しない）。
   * 既存Memoryには存在しない可能性があり、その場合はトップ画面の問いかけ候補にしない。
   */
  revisitPrompt?: string;
  /**
   * Topic Continuity Phase 1（基礎のみ、Retrievalへの本格接続はまだ行わない）。
   * 「今後も同じ話の続きとして扱うべきテーマ」をCapture時に軽く判定し、sameTopicと
   * 判定された場合にのみ既存のtopicIdを継承する（無ければ新規発行）。単なる共通語の
   * 一致では設定しない。既存Memoryには存在しない可能性があり（Phase 1では過去Memoryへの
   * 一括backfillを行わないため）、undefinedの場合は「まだTopic未分類」として扱う。
   * `revisitPrompt`と同じ、追加のみのoptionalフィールド（IndexedDBバージョンアップ・
   * Vault migration不要）。
   */
  topicId?: ID;
  /**
   * Time Axis Phase 2（Event Time, v1）。「いつ話したか」（Message Time／Conversation
   * Time Awareness、Phase 1）とは別に、「話している出来事が実際に起きた（起きる）時間」を
   * 持つ。精度に応じた可変長のcalendar date文字列（day: "YYYY-MM-DD"、month: "YYYY-MM"、
   * year: "YYYY"）で、時刻は一切含まない。存在しない時間精度を作らないという原則のため、
   * 出来事の時間が不明・曖昧な場合はeventTime/eventTimePrecisionとも未設定のままにする
   * （`topicId`と同じ、追加のみのoptionalフィールド。IndexedDBバージョンアップ・
   * Vault migration不要）。
   */
  eventTime?: string;
  eventTimePrecision?: EventTimePrecision;
  /**
   * Personal Profile v1。この記憶の元になった会話で、ユーザー自身が明示した「安定した前提」の候補
   * （追加のみ。Capture UPDATEでも既存のclaimは削除しない）。Profile候補が無い会話では未設定（キー自体を持たない）。
   * `eventTime`と同じ、追加のみのoptionalフィールド（IndexedDBバージョンアップ・Vault migration不要）。
   */
  profileClaims?: ProfileClaim[];
  metadata: Metadata;
}

/**
 * Source基盤（最小構成）。ユーザーが外部から持ち込んだ原資料そのものを保持するレコードで、
 * MemoryObject（Tsumugiが「覚えている」と判断した抽出済みの断片）とは明確に分離する。
 * Importしたものを自動的にすべてMemory化はしない、という設計方針の境界にあたる型
 * （DATA_MODEL.md §9.2 / STORAGE.md §5 参照）。
 *
 * 今回のスコープは「Tsumugi Coreが保存できる状態」までであり、MemoryObject/Conversationのような
 * `metadata: Metadata`は持たせない最小構成にとどめる（schemaVersion/aiProvider/confidence等は
 * 今回追加しない）。Importer・Vault保存・Source検索・Memory自動抽出は本型の実装対象外。
 */
export interface Source extends Identifiable, Timestamped {
  id: ID;
  /** 原資料の種類。既存の`SourceType`をそのまま使う（Metadata.sourceTypeと同じ語彙）。 */
  sourceType: SourceType;
  title: string;
  /** 原資料から抽出済みのプレーンテキスト（メール本文・PDF抽出テキスト・OCR結果等）。 */
  content: string;
  /** sourceTypeごとの由来情報（messageId・fileName・url等）を自由に持たせる最小限のbag。 */
  sourceDetail?: Record<string, string>;
  /** 実体ファイル（PDF・写真等）がある場合のみ設定。Attachment本体は今回のスコープ外。 */
  attachmentId?: ID;
}

/**
 * Importerが用意すべき最小入力。`id`/`createdAt`/`updatedAt`はTsumugi側の記帳情報であり、
 * Importerの関知することではない（`createSource()`が一元的に生成する。src/lib/source.ts参照）。
 * SourceDraft専用のフィールドは追加せず、`Source`からこの3つを除いただけの形にとどめる。
 */
export type SourceDraft = Omit<Source, "id" | "createdAt" | "updatedAt">;

/**
 * Importer共通の最小インターフェース。外部データ（Input）を受け取りSourceDraftを返すだけの
 * 関数型で、Gmail/PDF/URL/Obsidian/Photo等どのImporterもこの形に載る。id生成・永続化・
 * File System Access API操作にはImporter自身は一切関与しない（createSource()/persistSource()の
 * 責務。src/lib/source.ts参照）。
 */
export type Importer<Input> = (input: Input) => Promise<SourceDraft>;

/**
 * Retrieval Engine（ARCHITECTURE.md）がAIへ渡す軽量な記憶の形。
 * トークン節約のため content は含めない（summary で十分という DATA_MODEL.md の設計意図通り）。
 */
export interface RetrievedMemory {
  id: ID;
  /** Conversation／記録日時。出来事日時とは区別する。 */
  date: ISODateString;
  eventTime?: string;
  eventTimePrecision?: EventTimePrecision;
  summary: string;
  keywords: string[];
  /**
   * Connect（Phase 2, ROADMAP.md）が生成したLinkを経由してこの記憶が追加された場合のみ設定される
   * `Link.reason`。Tsumugiが過去に、別の2つの記憶を照合して見出した仮説であり、事実ではない。
   * 直接一致（キーワード/bigram）で見つかった記憶には付かない。
   */
  linkReason?: string;
  /**
   * Beta「過去からの問いかけ」起点Memory連携。この会話が`Conversation.promptedMemoryId`を
   * きっかけに始まった場合、そのMemoryにだけtrueが付く（検索スコアとは無関係に含まれる）。
   * `linkReason`（Connectの仮説）とは意味が異なるため流用しない。
   */
  isOriginMemory?: boolean;
  /**
   * 元MemoryObjectの`metadata.source`。このMemoryが「ユーザー自身の発言由来」「AIが会話から
   * 抽出・要約したもの」「Import由来」等のどれかをGemini側まで運ぶための最小限の由来情報。
   * `source`の値自体は、その内容が現在の外部事実として検証済みであることを意味しない
   * （特に"ai-capture"はAIによる要約であり、外部事実の検証ではない）。既存Memoryとの
   * 後方互換性のためoptional（未設定＝由来不明として扱う）。
   */
  source?: MemorySource;
  /**
   * Retrievalのノイズ抑制（analyst向け）。このMemoryが今回のクエリとの関連度で選ばれた
   * "direct"（scoreMemoryベースの直接一致）か、関連度とは無関係に「あえて遠いMemory」として
   * 選ばれた"divergent"（retrieval.tsのselectDivergentMemories、既定では自動投入しない）か。
   * companion/coach（retrieveRelevantMemories本体）が返すMemoryには常にdirectしか無いため、
   * 後方互換性のためoptional（未設定＝direct相当として扱ってよい）。Gemini向けのprompt本文
   * （buildRetrievedMemoriesSection）には現時点では渡していない、調査・表示用の内部情報。
   */
  matchType?: "direct" | "divergent";
}

export const SCHEMA_VERSION = "0.1";
