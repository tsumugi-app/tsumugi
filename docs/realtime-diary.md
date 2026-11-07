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

## Later steps

- PR-B: 「終了して日記を生成する」: end, Capture with the existing path, write the diary text with the chosen AI, save it to the conversation, retry either step safely. No separate Reflection for this diary. No regeneration in the first version.
- PR-C: after 4:00, an open diary of an earlier day is finished automatically only when the automatic run is allowed and the chosen AI's own key is available; otherwise it waits and home offers 「昨日の日記を仕上げる」. Nothing moves to another diary by itself at 4:00; a reply in progress stays in its conversation.
