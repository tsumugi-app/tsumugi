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
- A screen that is behind (another tab or device ended the diary) never writes the diary back as open: a save of an open diary over an ended one is refused inside its transaction (`RealtimeDiaryEndedError`), and words sent from that screen start a new diary instead.
- Steps 2 and 3 are independent: when one fails the other still runs, and 「もう一度仕上げる」 (screen) or 「日記を仕上げる」 (home, for any ended diary missing its Memory or text) retries only what is missing. Another tab finishing the same diary at the same time is told so (a per-diary lock).
- No separate Reflection is made for a realtime diary. The normal diary and conversations are unchanged.
- Markdown: the text is a `## Diary` section before `## Transcript` (lines starting with `#` or `\` get a leading `\`, removed when read), plus `diaryWrittenAt`. Which AI wrote it stays on the device.
- A save that lacks the text never replaces a file that has it (`takesBackFinishedConversation`); taking in a Vault version keeps the text.
- History lists a realtime diary on its diary day (History index field `diaryDate`; the day view also reads the next day's bucket, and the next month's index for the last day of a month), and the detail shows the text.

## PR-C: the 4:00 day change and finishing past diaries

- A diary whose day has ended (its `date` is before today's diary day, 4:00 local time) and that is still open is waiting to be finished. Nothing is moved and nothing is sent at 4:00 by itself; the times of the words are never changed. A diary dated after today (the clock moved back, or a move west) is written on as it is.
- Writing across 4:00: a reply in progress finishes in its diary. New words sent after 4:00 to the old diary are not sent: a notice explains the day change, the typed text stays in the input, and 「M月D日の日記へ切り替える」 closes the old diary (the same atomic end as PR-B, so a diary ended elsewhere is taken as it is) and opens today's diary (the open one, or a new one); the user sends the text. An empty diary opened before 4:00 takes the day of its first words (nothing of it was saved yet).
- Home lists the diaries waiting to be finished: ended diaries missing their Memory or text, and open diaries of a past day. The button says 「昨日の日記を仕上げる」 for yesterday, 「M月D日の日記を仕上げる」 for an older day. It runs the PR-B steps. A new diary for today can be started while yesterday's is waiting.
- Automatic finishing (`realtimeDiaryAuto.ts`, Settings 「リアルタイム日記の仕上げ」, off by default): only on a device where the user turned it on, at the next start (so also after the app was closed over 4:00), and right after the switch on the screen. One diary per start, oldest day first, three tries per diary (then by hand from home). Only to the AI the user chose with the user's own key for it (`requireUserKey`; no key, offline or another AI chosen meanwhile: nothing is sent, or the run stops, and the diary waits). The usual permission for a diary held with another AI applies. It never takes an open diary written on in the last 30 minutes, a diary open in a tab, a diary being finished or captured, or one whose Vault file was edited. The steps are PR-B's (`advanceRealtimeDiary`), so nothing is made twice and the words are always kept. No server is added; it runs in the app.
- The automatic Memory run for conversations (startup-memory-capture) no longer takes any realtime diary: an open one waits for its writer, an ended or past one for the diary's own finishing. One diary is never handled by both.

## Before the integration (owner 2026-11-08)

- Reply style: a realtime diary conversation sends `conversationVoiceMode: "realtime-diary"` to /api/chat, and only then (companion persona) the prompt uses `REALTIME_DIARY_PERSONA_PROMPT` and adds `REALTIME_DIARY_VOICE_SECTION` (conversationVoice.ts): about 3–5 sentences as a guide, not counted; few questions, not ending every reply with one; no rephrasing, forced empathy or excessive praise; own impressions and views welcome; full answers when asked for advice; the day's earlier words in mind; the user's pace first. The normal diary, conversations and 探究 keep their prompts unchanged. No extra AI call, no change to retrieval or the thinking budget.
- History and the calendar in any time zone: a realtime diary is listed and dotted on its diary day (the device's local date, 4:00 boundary), as before; its card time and its detail date and time are now shown in the device's local time, like the day itself. Normal conversations and Memories keep their Japan-time dates, and History still opens on today in Japan.
