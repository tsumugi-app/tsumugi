# Realtime diary

One conversation per day, paused and resumed during the day, from which a diary is written at the end of the day. Owner decisions of 2026-11-07.

## The diary day

- Device local time. A new diary day starts at 4:00 (8 Nov 3:59 belongs to 7 Nov; 8 Nov 4:00 starts 8 Nov).
- The day is fixed when the diary starts and is stored as `realtimeDiary.date` (Markdown frontmatter `diaryDate`). It is never derived again from the times of the words, and those times are never rewritten.

## PR-A (this step)

- Home has a separate entry next to 日記 and 会話: 「リアルタイム日記を始める」, or 「今日の続きを書く」 when today's diary is open.
- Opening it resumes today's open diary with every word and reply, or starts a new one. The conversation is saved after every message by the existing save path.
- 「一時保存して閉じる」 (and any way home) pauses the diary: it is not captured, nothing is sent to an AI, no Reflection is made. While a reply is coming the button cannot be pressed.
- An open diary (no `endedAt`) is never captured at a conversation boundary and never selected or counted by the automatic Memory run.
- A time is shown before the first words and before words written 30 minutes or more after the previous message. Words on another calendar day than the diary day also show the date.
- The normal diary (本日はここまで, Reflection) and conversations are unchanged.

## PR-B: 「終了して日記を生成する」

Each press moves on only the steps still missing, judged from the stored record, so pressing twice, closing the app midway or a failure never loses the words or makes anything twice:

1. End: `endedAt` is added to the conversation as stored, in one IndexedDB transaction (`endRealtimeDiaryWithOutbox`); a screen that is behind never writes its old copy over it, and a diary already ended by another tab is taken as it is. Nothing is added to this diary afterwards. The words were already saved message by message.
2. Memory: the existing Capture at a conversation boundary (nothing if already captured; one run per conversation through the existing lock). The usual permission for a conversation held with another AI applies.
3. Diary text: `/api/diary` asks the AI the user chose (PR #27 headers; the Beta Gemini key only when Gemini is chosen) to write the day's diary from the whole conversation, with local times, without inventing anything not said. The text is added to the conversation as stored, in one IndexedDB transaction with its Outbox entry (`addRealtimeDiaryTextWithOutbox`); an existing text is never replaced. It is not a Memory.

- When the Vault file's words were edited outside the app, neither the Memory nor the text is made from the words before the edit (the same file check as Capture, before the AI call and again before saving, and the text is added only when the stored words are still the ones it was written from); the words and the file stay, and the diary can be finished after the edit is taken in.
- Steps 2 and 3 are independent: when one fails the other still runs, and 「もう一度仕上げる」 (screen) or 「日記を仕上げる」 (home, for any ended diary missing its Memory or text) retries only what is missing. Another tab finishing the same diary at the same time is told so (a per-diary lock).
- No separate Reflection is made for a realtime diary. The normal diary and conversations are unchanged.
- Markdown: the text is a `## Diary` section before `## Transcript` (lines starting with `#` or `\` get a leading `\`, removed when read), plus `diaryWrittenAt`. Which AI wrote it stays on the device.
- A save that lacks the text never replaces a file that has it (`takesBackFinishedConversation`); taking in a Vault version keeps the text.
- History lists a realtime diary on its diary day (History index field `diaryDate`; the day view also reads the next day's bucket, and the next month's index for the last day of a month), and the detail shows the text.

## Later steps

- PR-C: after 4:00, an open diary of an earlier day is finished automatically only when the automatic run is allowed and the chosen AI's own key is available; otherwise it waits and home offers 「昨日の日記を仕上げる」. Nothing moves to another diary by itself at 4:00; a reply in progress stays in its conversation.
