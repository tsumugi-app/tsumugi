/**
 * ARCHITECTURE.md Markdown Structure / STORAGE.md §4 Markdown Format に対応する
 * frontmatter + 本文のシリアライズ、および復元用のパース。
 *
 * gray-matter 等の汎用ライブラリは内部で `fs` を要求しブラウザバンドルと相性が悪いため、
 * 本アプリのfrontmatterは値の種類（文字列・数値・真偽値・文字列配列）が限定されていることを
 * 利用し、最小限のYAMLシリアライザ／パーサーを自前で持つ（汎用YAMLではなく、
 * このファイル自身が書き出す形式の逆変換ができれば十分という前提）。
 */
import { ulid } from "ulid";
import { SCHEMA_VERSION } from "./types";
import type {
  Conversation,
  ConversationTurn,
  EventTimePrecision,
  Link,
  MemoryObject,
  MemorySource,
  MemoryType,
  Persona,
  Source,
  SourceType,
} from "./types";
import { isValidEventTimePrecision, isValidEventTimeValue } from "./eventTimeResolver";
import { sanitizeStoredProfileClaims } from "./profile";
import { sanitizeStoredPersonMentions } from "./person";
import { sanitizeStoredTopicEvents } from "./topicEvent";

function yamlScalar(value: string): string {
  const looksSpecial =
    value === "" ||
    /^[\s]|[\s]$/.test(value) ||
    /[:#\[\]{},&*!|>'"%@`\n]/.test(value) ||
    /^(true|false|null|yes|no)$/i.test(value) ||
    /^-?\d+(\.\d+)?$/.test(value);
  return looksSpecial ? JSON.stringify(value) : value;
}

function yamlValue(value: unknown): string {
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") return yamlScalar(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    return `[${value.map((v) => (typeof v === "string" ? yamlScalar(v) : String(v))).join(", ")}]`;
  }
  return JSON.stringify(value);
}

function toFrontmatter(fields: Record<string, unknown>): string {
  const lines = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([key, value]) => `${key}: ${yamlValue(value)}`);
  return `---\n${lines.join("\n")}\n---\n`;
}

/** `links`と同じパターン：構造を持つ値はここでJSON文字列化してから渡し、frontmatter上は単なる文字列として扱う。 */
function stringifySourceDetail(detail: Record<string, string> | undefined): string | undefined {
  return detail && Object.keys(detail).length > 0 ? JSON.stringify(detail) : undefined;
}

export function memoryObjectToMarkdown(memoryObject: MemoryObject): string {
  const datePart = memoryObject.date.slice(0, 10);
  const frontmatter = toFrontmatter({
    id: memoryObject.id,
    tsumugi: true,
    date: datePart,
    types: memoryObject.types,
    keywords: memoryObject.keywords.length > 0 ? memoryObject.keywords : undefined,
    conversationId: memoryObject.conversationId,
    topicId: memoryObject.topicId,
    eventTime: memoryObject.eventTime,
    eventTimePrecision: memoryObject.eventTimePrecision,
    summary: memoryObject.summary,
    links: memoryObject.links.length > 0 ? JSON.stringify(memoryObject.links) : undefined,
    // Personal Profile v1：`links`と同じパターン（JSON文字列）。claimが無いMemoryには、キー自体を書かない。
    profile: memoryObject.profileClaims && memoryObject.profileClaims.length > 0 ? JSON.stringify(memoryObject.profileClaims) : undefined,
    // Person Memory v1：`profile`と同じパターン（JSON文字列）。mentionが無いMemoryには、キー自体を書かない。
    person: memoryObject.personMentions && memoryObject.personMentions.length > 0 ? JSON.stringify(memoryObject.personMentions) : undefined,
    // Topic / Current State v1：`person`と同じパターン（JSON文字列）。eventが無いMemoryには、キー自体を書かない。
    topicEvents: memoryObject.topicEvents && memoryObject.topicEvents.length > 0 ? JSON.stringify(memoryObject.topicEvents) : undefined,
    source: memoryObject.metadata.source,
    sourceType: memoryObject.metadata.sourceType,
    sourceDetail: stringifySourceDetail(memoryObject.metadata.sourceDetail),
    aiProvider: memoryObject.metadata.aiProvider,
    confidence: memoryObject.metadata.confidence,
    schemaVersion: memoryObject.metadata.schemaVersion,
    createdAt: memoryObject.createdAt,
    updatedAt: memoryObject.updatedAt,
  });

  const body = `# ${datePart}\n\n## Summary\n${memoryObject.content}\n`;

  return `${frontmatter}\n${body}`;
}

export function conversationToMarkdown(conversation: Conversation): string {
  const frontmatter = toFrontmatter({
    id: conversation.id,
    tsumugi: true,
    persona: conversation.persona,
    status: conversation.status,
    startedAt: conversation.startedAt,
    endedAt: conversation.endedAt,
    memoryObjectIds: conversation.memoryObjectIds.length > 0 ? conversation.memoryObjectIds : undefined,
    // JST日付モデル Phase 2（Message Time）：`links`/`profile`と同じパターン（JSON文字列）。
    // 各turnの実発言時刻（`ConversationTurn.timestamp`）を、turns配列と同じ順序・同じ件数の
    // 配列として保存する。本文（`**User:**`/`**Tsumugi:**`によるtranscript形式）は一切変更
    // しない——このfrontmatterフィールドだけが、restore時にturn単位のMessage Timeを
    // 取り戻すための追加情報（`parseTranscript`参照）。turnが無いConversationにはキー自体を
    // 書かない（`links`/`profile`と同じ、既存の空値省略ルール）。
    turnTimes: conversation.turns.length > 0 ? JSON.stringify(conversation.turns.map((turn) => turn.timestamp)) : undefined,
    source: conversation.metadata.source,
    sourceType: conversation.metadata.sourceType,
    sourceDetail: stringifySourceDetail(conversation.metadata.sourceDetail),
    schemaVersion: conversation.metadata.schemaVersion,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
  });

  const transcript = conversation.turns
    .map((turn) => `**${turn.role === "user" ? "User" : "Tsumugi"}:** ${turn.content}`)
    .join("\n\n");

  const body = `# Conversation ${conversation.startedAt.slice(0, 10)}\n\n## Transcript\n\n${transcript}\n`;

  return `${frontmatter}\n${body}`;
}

/**
 * Source基盤（最小構成）のMarkdownシリアライズ。1 Source = 1 Markdown（STORAGE.md §3）。
 * MemoryObject/Conversationと異なりSourceは`metadata: Metadata`を持たないため、
 * `schemaVersion`/`aiProvider`/`confidence`等はfrontmatterへ出力しない。
 */
export function sourceToMarkdown(source: Source): string {
  const frontmatter = toFrontmatter({
    id: source.id,
    tsumugi: true,
    sourceType: source.sourceType,
    title: source.title,
    sourceDetail: stringifySourceDetail(source.sourceDetail),
    attachmentId: source.attachmentId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  });

  const body = `# ${source.title}\n\n## Content\n${source.content}\n`;

  return `${frontmatter}\n${body}`;
}

// ---------------------------------------------------------------------------
// 復元用パース（STORAGE.md §2.4 Rebuildability Guarantee）
// このファイルが書き出す形式のみを対象とした最小限のパーサー。汎用YAMLパーサーではない。
// ---------------------------------------------------------------------------

function parseYamlScalar(raw: string): string | number | boolean {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed;
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  return trimmed;
}

/** `[a, "b, c", d]` のようなbracket内をカンマで分割する。引用符内のカンマは分割しない。 */
function splitArrayItems(inner: string): string[] {
  const items: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === '"' && inner[i - 1] !== "\\") {
      inQuotes = !inQuotes;
      current += ch;
    } else if (ch === "," && !inQuotes) {
      items.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1);
    if (!inner.trim()) return [];
    return splitArrayItems(inner).map((item) => parseYamlScalar(item));
  }
  return parseYamlScalar(trimmed);
}

/** Importer（src/lib/importers/）が外部Markdownのfrontmatterを読む際にも再利用する。 */
export interface ParsedNote {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * `writeFileInDir`が書き出す `---\n...\n---\n\n本文` の形式のみを対象とする。
 * Importer側（外部の任意のMarkdown）にもそのまま使えるよう`export`しているが、
 * パース仕様自体はこのファイルが書き出す形式を前提としたままで変更しない
 * （新しいMarkdown仕様を発明しない。Tsumugi独自の`---`区切りfrontmatterの読み取りだけを共通化する）。
 */
export function parseFrontmatter(raw: string): ParsedNote | null {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!match) return null;
  const [, frontmatterText, body] = match;

  const frontmatter: Record<string, unknown> = {};
  for (const line of frontmatterText.split("\n")) {
    if (!line.trim()) continue;
    const separatorIndex = line.indexOf(": ");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    const rawValue = line.slice(separatorIndex + 2);
    frontmatter[key] = parseYamlValue(rawValue);
  }

  return { frontmatter, body };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function extractAfterHeading(body: string, heading: string): string {
  const marker = `## ${heading}\n`;
  const index = body.indexOf(marker);
  if (index === -1) return "";
  return body.slice(index + marker.length).trim();
}

/**
 * `Memories/*.md` を復元する。`tsumugi: true` が無い、または `id` が読めないファイルは
 * Tsumugi管理外・壊れたファイルとして `null` を返す（呼び出し側で件数カウントしてスキップする）。
 *
 * 既知の制約：
 * - `summary` を書き出すようになる前の古いファイルには `summary` が無いため、`content` を代用する
 * - `date` はfrontmatterに日付部分のみが保存されているため、時刻情報（T以降）は失われている
 * - `themeIds`等のEntity参照はPhase 2（Memory-to-Memory Linkのみ）でも常に空配列にする
 *   （Entity自体を実装しないため）
 * - `links`はPhase 2で追加したフィールド。古い（Phase 1で書かれた）ファイルには無いため、
 *   その場合は空配列にフォールバックする
 * - `topicId`はTopic Continuity Phase 1で追加したoptionalフィールド。古いファイルには
 *   無いため、その場合は`undefined`（Topic未分類）にフォールバックする
 * - `metadata.id`（Metadataレコード自身のID）はMarkdownに保存されていないため新規に振り直す
 */
function parseLinks(raw: unknown): Link[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as Link[]) : [];
  } catch {
    return [];
  }
}

/**
 * Personal Profile v1：`profile`は`links`と同じパターン（JSON文字列）。fail-soft：JSONが壊れている・形が違うclaimは、
 * そのclaimだけ捨てる。Memory本体の読み込みは、この値の状態に関わらず必ず成功させる（例外を投げない）。
 * 古いMemory Markdownにはこのキー自体が無いため、その場合は空配列（＝従来どおり）になる。
 */
function parseProfileClaims(raw: unknown) {
  if (typeof raw !== "string") return [];
  try {
    return sanitizeStoredProfileClaims(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Person Memory v1：`person`は`profile`と同じパターン（JSON文字列）。fail-soft：JSONが壊れている・
 * 形が違うmention（Correction情報を含む）は、そのmentionだけ捨てる。Memory本体の読み込みは、
 * この値の状態に関わらず必ず成功させる（例外を投げない）。古いMemory Markdownにはこのキー
 * 自体が無いため、その場合は空配列（＝従来どおり）になる。
 */
function parsePersonMentions(raw: unknown) {
  if (typeof raw !== "string") return [];
  try {
    return sanitizeStoredPersonMentions(JSON.parse(raw));
  } catch {
    return [];
  }
}

/**
 * Topic / Current State v1：`topicEvents`は`person`と同じパターン（JSON文字列）。fail-soft：
 * JSONが壊れている・形が違うeventは、そのeventだけ捨てる。Memory本体の読み込みは、この値の
 * 状態に関わらず必ず成功させる（例外を投げない）。古いMemory Markdownにはこのキー自体が
 * 無いため、その場合は空配列（＝従来どおり）になる。
 */
function parseTopicEvents(raw: unknown) {
  if (typeof raw !== "string") return [];
  try {
    return sanitizeStoredTopicEvents(JSON.parse(raw));
  } catch {
    return [];
  }
}

/** `parseLinks`と同じパターン：`stringifySourceDetail`で文字列化された値をJSON.parseし直す。 */
function parseSourceDetail(raw: unknown): Record<string, string> | undefined {
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 後方互換性：`sourceType`を持たない既存Markdown（今回の変更前に書かれた全ファイル）を
 * 読み込んだ際、`source`の値から妥当な初期値を推測する。書き込み側は一切変更しないため、
 * 既存パイプライン（Capture/Reflection）が生成するファイルには実際には書き込まれず、
 * 読み込み時にその場で補完されるだけである。
 *
 * vault.ts（semantic equality判定）からも再利用する：Markdown round-trip後は
 * 必ずこの推測値が補完されるため、IndexedDB側の`sourceType`が`undefined`のまま
 * （この推測ロジック導入前に作られたrecord等）でも、同じ推測を両側に適用してから
 * 比較しないと、内容が同一のrecordを誤って不一致と判定してしまうため。
 */
export function inferSourceType(source: MemorySource): SourceType {
  switch (source) {
    case "ai-capture":
      return "chat";
    case "system-generated":
      return "system";
    case "user-authored":
      return "manual";
    case "import":
      return "obsidian-import";
    default:
      return "chat";
  }
}

/**
 * 「1日1Markdown」（Memories/YYYY-MM-DD.md）用。1ファイルに複数MemoryObjectの
 * frontmatter+bodyブロックを、このセパレータで連結して持たせる。
 * AIが生成する本文に偶然含まれる可能性が極めて低い明示的なマーカーを使うことで、
 * body内の「---」行と、エントリの境界とを確実に区別する（本文側の解析ロジックには一切依存しない）。
 * 旧形式（1ファイル1エントリ、このマーカーを含まない）をsplitしても要素数1の配列になるだけなので、
 * 下記のparse関数は新旧どちらの形式にもそのまま使える。
 */
const MEMORY_ENTRY_SEPARATOR = "\n<!-- tsumugi:entry -->\n\n";

export function serializeMemoryDayFile(memoryObjects: MemoryObject[]): string {
  return memoryObjects.map((memory) => memoryObjectToMarkdown(memory)).join(MEMORY_ENTRY_SEPARATOR);
}

/**
 * 日別ファイル（新形式・複数エントリ）・旧形式（1ファイル1エントリ）のどちらも読める。
 * tsumugi:trueが無い・idが読めないエントリは呼び出し側でスキップできるよう、単純に除外して返す
 * （件数を数えたい場合は呼び出し側でsplit数と結果件数の差を見る）。
 */
export function parseMemoryDayFile(raw: string): MemoryObject[] {
  return raw
    .split(MEMORY_ENTRY_SEPARATOR)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => parseMemoryObjectMarkdown(entry))
    .filter((memory): memory is MemoryObject => memory !== null);
}

export function parseMemoryObjectMarkdown(raw: string): MemoryObject | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const { frontmatter, body } = parsed;

  if (frontmatter.tsumugi !== true) return null;
  const id = asString(frontmatter.id);
  if (!id) return null;

  const datePart = asString(frontmatter.date) ?? "";
  const date = datePart.includes("T") ? datePart : `${datePart}T00:00:00.000Z`;
  const createdAt = asString(frontmatter.createdAt) ?? date;
  const updatedAt = asString(frontmatter.updatedAt) ?? createdAt;

  const content = extractAfterHeading(body, "Summary");
  const summary = asString(frontmatter.summary) || content;

  const types = asStringArray(frontmatter.types) as MemoryType[];
  const source = (asString(frontmatter.source) ?? "import") as MemorySource;
  const sourceType = asString(frontmatter.sourceType) ?? inferSourceType(source);

  // Time Axis Phase 2（Event Time, v1）：precisionが"day"|"month"|"year"のいずれかで、
  // かつeventTimeの形式がそのprecisionと矛盾しない場合のみ採用する（無条件castしない）。
  // 古いMemory Markdownにはこのキー自体が無いため、その場合は両方ともundefinedになる
  // （topicIdと同じ後方互換の扱い）。
  const rawEventTimePrecision = asString(frontmatter.eventTimePrecision);
  const rawEventTime = asString(frontmatter.eventTime);
  const eventTimePrecision: EventTimePrecision | undefined =
    isValidEventTimePrecision(rawEventTimePrecision) &&
    rawEventTime !== undefined &&
    isValidEventTimeValue(rawEventTime, rawEventTimePrecision)
      ? rawEventTimePrecision
      : undefined;
  const eventTime = eventTimePrecision ? rawEventTime : undefined;
  const profileClaims = parseProfileClaims(frontmatter.profile);
  const personMentions = parsePersonMentions(frontmatter.person);
  const topicEvents = parseTopicEvents(frontmatter.topicEvents);

  return {
    id,
    date,
    types,
    conversationId: asString(frontmatter.conversationId),
    topicId: asString(frontmatter.topicId),
    eventTime,
    eventTimePrecision,
    content,
    summary,
    keywords: asStringArray(frontmatter.keywords),
    themeIds: [],
    personIds: [],
    emotionIds: [],
    goalIds: [],
    ideaIds: [],
    eventIds: [],
    links: parseLinks(frontmatter.links),
    ...(profileClaims.length > 0 ? { profileClaims } : {}),
    ...(personMentions.length > 0 ? { personMentions } : {}),
    ...(topicEvents.length > 0 ? { topicEvents } : {}),
    createdAt,
    updatedAt,
    metadata: {
      id: ulid(),
      schemaVersion: asString(frontmatter.schemaVersion) ?? SCHEMA_VERSION,
      aiProvider: asString(frontmatter.aiProvider),
      source,
      sourceType,
      sourceDetail: parseSourceDetail(frontmatter.sourceDetail),
      confidence: typeof frontmatter.confidence === "number" ? frontmatter.confidence : undefined,
      createdAt,
      updatedAt,
      obsidian: undefined,
    },
  };
}

/**
 * JST日付モデル Phase 2（Message Time）：`turnTimes`frontmatterの値をturn単位の
 * timestamp配列へ復元する。`links`/`profile`と同じfail-softパターンで、以下のいずれの
 * 異常でもConversation全体の読み込みを失敗させない（`null`を返さない）——異常な要素・
 * 配列そのものは単に「使えない」ものとして扱い、呼び出し元（`parseTranscript`）が
 * turnごとに個別フォールバックする：
 * - キー自体が無い（旧Conversation）→ 空配列（全turnがfallback）
 * - 値が文字列でない・JSONとして壊れている → 空配列（全turnがfallback）
 * - 配列でない → 空配列（全turnがfallback）
 * - 要素が文字列でない（個別の壊れた要素） → その位置だけ`undefined`にする
 *   （配列内の他要素とturnとのindex対応を保つため、フィルタで詰めない）
 *
 * 個数不一致（turns配列より長い／短い）はここでは判定しない。`parseTranscript`側が
 * index単位で存在確認するため、自然に「無い位置はfallback」になる。
 */
function parseTurnTimes(raw: unknown): (string | undefined)[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((value) => (typeof value === "string" ? value : undefined));
  } catch {
    return [];
  }
}

/** `Date.parse`で解釈できる文字列かどうか（実在暦日までの厳密な検証はしない。turn timestampは
 *  表示・並び替え用途のみのため、Event Time同等の厳密なcalendar検証は過剰）。 */
function isValidIsoTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value));
}

/**
 * `Conversations/*.md` を復元する。トランスクリプトは `**User:** ` / `**Tsumugi:** `
 * という行頭マーカーで区切って各turnへ分解する（空行ではなくマーカー行で区切るため、
 * 複数段落にまたがる発言も1つのturnとして正しく復元できる）。
 *
 * JST日付モデル Phase 2：turn単位の`timestamp`は、`turnTimes`frontmatter（本ファイルが
 * 書き出したもの、`parseTurnTimes`参照）から、turnと同じ順序のindexで復元する。
 * `turnTimes`が無い・使えない古いConversation、またはindexに対応する要素が無い／不正な
 * turnについては、従来どおり会話全体の`startedAt`をそのturnへ暫定的に割り当てる
 * （fail-soft、turn単位。1件の異常が他のturn・Conversation全体の復元を妨げない）。
 */
export function parseConversationMarkdown(raw: string): Conversation | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const { frontmatter, body } = parsed;

  if (frontmatter.tsumugi !== true) return null;
  const id = asString(frontmatter.id);
  if (!id) return null;

  const startedAt = asString(frontmatter.startedAt) ?? asString(frontmatter.createdAt) ?? "";
  const createdAt = asString(frontmatter.createdAt) ?? startedAt;
  const updatedAt = asString(frontmatter.updatedAt) ?? createdAt;
  const persona = (asString(frontmatter.persona) ?? "companion") as Persona;
  const status = (asString(frontmatter.status) ?? "captured") as Conversation["status"];
  const source = (asString(frontmatter.source) ?? "import") as MemorySource;
  const sourceType = asString(frontmatter.sourceType) ?? inferSourceType(source);
  const turnTimes = parseTurnTimes(frontmatter.turnTimes);

  return {
    id,
    persona,
    startedAt,
    endedAt: asString(frontmatter.endedAt),
    turns: parseTranscript(body, startedAt, turnTimes),
    status,
    memoryObjectIds: asStringArray(frontmatter.memoryObjectIds),
    createdAt,
    updatedAt,
    metadata: {
      id: ulid(),
      schemaVersion: asString(frontmatter.schemaVersion) ?? SCHEMA_VERSION,
      source,
      sourceType,
      sourceDetail: parseSourceDetail(frontmatter.sourceDetail),
      createdAt,
      updatedAt,
    },
  };
}

function parseTranscript(body: string, fallbackTimestamp: string, turnTimes: (string | undefined)[]): ConversationTurn[] {
  const marker = "## Transcript\n\n";
  const markerIndex = body.indexOf(marker);
  const transcriptText = markerIndex === -1 ? "" : body.slice(markerIndex + marker.length);
  if (!transcriptText.trim()) return [];

  const USER_PREFIX = "**User:** ";
  const AI_PREFIX = "**Tsumugi:** ";

  // turnTimesとのindex対応を、本文のparseロジック（役割・改行の扱い等）に一切触れずに
  // 取るため、まずrole/contentだけを順番に集め、turnTimesの適用は最後にまとめて行う。
  const rawTurns: { role: ConversationTurn["role"]; content: string }[] = [];
  let currentRole: ConversationTurn["role"] | null = null;
  let currentLines: string[] = [];

  const flush = () => {
    if (currentRole && currentLines.length > 0) {
      const content = currentLines.join("\n").trim();
      if (content) {
        rawTurns.push({ role: currentRole, content });
      }
    }
    currentLines = [];
  };

  for (const line of transcriptText.split("\n")) {
    if (line.startsWith(USER_PREFIX)) {
      flush();
      currentRole = "user";
      currentLines = [line.slice(USER_PREFIX.length)];
    } else if (line.startsWith(AI_PREFIX)) {
      flush();
      currentRole = "ai";
      currentLines = [line.slice(AI_PREFIX.length)];
    } else {
      currentLines.push(line);
    }
  }
  flush();

  return rawTurns.map((turn, index) => {
    const candidate = turnTimes[index];
    const timestamp = candidate !== undefined && isValidIsoTimestamp(candidate) ? candidate : fallbackTimestamp;
    return { ...turn, timestamp };
  });
}

/**
 * `sourceToMarkdown`が書き出した形式のみを対象とした復元用パーサー。
 * MemoryObject/Conversation用のパーサーと異なり`T | null`ではなく`Source`を直接返す
 * （Source Markdownは今回Vault走査の対象にしないため、未知の外部ノートを許容する必要が無い）。
 * frontmatterが読めない・`tsumugi: true`が無い・`id`が読めない場合はErrorを投げる。
 */
export function parseSourceMarkdown(markdown: string): Source {
  const parsed = parseFrontmatter(markdown);
  if (!parsed) {
    throw new Error("parseSourceMarkdown: invalid Markdown format (frontmatter not found)");
  }
  const { frontmatter, body } = parsed;

  if (frontmatter.tsumugi !== true) {
    throw new Error("parseSourceMarkdown: not a Tsumugi-managed note (missing tsumugi: true)");
  }
  const id = asString(frontmatter.id);
  if (!id) {
    throw new Error("parseSourceMarkdown: missing required 'id' field");
  }
  const sourceType = asString(frontmatter.sourceType);
  if (!sourceType) {
    throw new Error("parseSourceMarkdown: missing required 'sourceType' field");
  }

  const createdAt = asString(frontmatter.createdAt) ?? "";
  const updatedAt = asString(frontmatter.updatedAt) ?? createdAt;

  return {
    id,
    sourceType,
    title: asString(frontmatter.title) ?? "",
    content: extractAfterHeading(body, "Content"),
    sourceDetail: parseSourceDetail(frontmatter.sourceDetail),
    attachmentId: asString(frontmatter.attachmentId),
    createdAt,
    updatedAt,
  };
}
