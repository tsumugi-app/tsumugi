/**
 * 構造化出力（JSON Schema）のprovider非依存な最小表現。
 * Gemini（`@google/genai`のType列挙型）・OpenAI・Claudeいずれの構造化出力も
 * JSON Schemaのサブセットとして表現できるため、これを共通の中間形式とする。
 * 実際のSDK形式への変換は各 providers/*.ts が担当する（このファイルはGeminiを一切知らない）。
 */

export interface AISchemaObject {
  type: "object";
  description?: string;
  properties: Record<string, AISchema>;
  required?: string[];
}

export interface AISchemaArray {
  type: "array";
  description?: string;
  items: AISchema;
}

export interface AISchemaString {
  type: "string";
  description?: string;
  enum?: string[];
}

export interface AISchemaNumber {
  type: "number";
  description?: string;
}

export interface AISchemaBoolean {
  type: "boolean";
  description?: string;
}

export type AISchema =
  | AISchemaObject
  | AISchemaArray
  | AISchemaString
  | AISchemaNumber
  | AISchemaBoolean;
