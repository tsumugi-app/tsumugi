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
  date: ISODateString;
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
}

export const SCHEMA_VERSION = "0.1";
