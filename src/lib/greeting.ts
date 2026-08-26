/**
 * UI_UX.md Launch Experience「こんばんは。今日はどんな一日でしたか？」に対応する。
 * ホーム画面・ダッシュボードは持たず、会話の最初の一言として表示する。
 */
export function getGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour >= 5 && hour < 10) return "おはようございます。";
  if (hour >= 10 && hour < 18) return "こんにちは。";
  return "こんばんは。";
}
