# The AI the user chooses

Tsumugi does not depend on one AI. The user chooses one AI in Settings (「利用するAI」), and every feature that uses an AI sends only to that AI, with that AI's key only:
the conversation, Capture (end of a conversation and the startup run), Connect, Reflection (本日はここまで), the question from the past, Memory Synthesis (trial), and the
experimental Fact and meaning routes. Retrieval, Topic Continuity and the Memory Timeline use no AI.

## How a request is routed
- App: `selectedAiHeaders` (`src/lib/selectedAi.ts`) reads the chosen AI and that AI's key just before a request, and builds the headers with `aiRequestHeaders`
  (`src/lib/apiKeyHeader.ts`): `X-AI-Provider` names the AI, and only that AI's key header is added. A process that decided on an AI earlier (the end of a
  conversation, the startup run) passes it, and nothing is sent if the choice has changed since.
- Server: every AI route takes the AI from `X-AI-Provider` (`resolveRequestedProvider`). A request that names no AI, or an AI Tsumugi cannot call, is refused with 400
  and reaches no AI. There is no default AI on the server.
- Keys: `resolveApiKey` reads only the named AI's key header. The Beta key Tsumugi provides exists for Gemini only, and is used only when the request names Gemini,
  carries no user key, and is not an automatic request (`X-Tsumugi-User-Key-Only`). Another AI with no user key: 401, nothing sent, never a fall back to Gemini.
- Removing the chosen AI's key does not switch the choice to another AI; requests stop until a key is given.

## Conversations held with another AI
Each conversation records which AIs answered in it (`chatProviders`, on the device only). The startup run and the end of a conversation send a conversation to the
chosen AI only when every reply on record came from that AI, or when the user has allowed it (Settings, 「閉じた会話の記憶」). A conversation with no record (from before
the record existed, or taken in from the Vault with other words) counts as held with another AI. Such a conversation stays as it is until the user allows it or chooses
that AI again.

## Adding an AI
1. `src/lib/ai/providers/<name>.ts` implementing `AIProvider` (generateText / generateStructured / generateStream with `AISchema`).
2. `src/lib/ai/resolve.ts`: `getProvider`, `resolveRequestedProvider`, the default model.
3. `src/lib/apiKeyHeader.ts`: the key header name.
4. Settings and the key setup screen: the choice and the key.
No feature needs a change.

## Known limits
- `metadata.aiProvider` of a new Memory or Reflection records the AI that made it. Before this change Capture and Reflection always used Gemini, so older records
  say Gemini, which was right. Connect, the question and Synthesis send Memory summaries to the chosen AI, whatever AI made those Memories.
- Prompt lengths and output limits were tuned with Gemini. Quality with OpenAI is not verified with the real service.
