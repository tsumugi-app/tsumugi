import test from "node:test";
import assert from "node:assert/strict";
import { latestShownTooEarly, runLabel, renderTimingText, LATEST_TEXT, NOT_LATEST_TEXTS } from "./startupTiming";

test("startupTiming: 「最新」は、確認中・要確認・修復中・確認失敗の表示と同時に出ていたら早すぎると判定する", () => {
  assert.equal(latestShownTooEarly(`保存先\n✓ ${LATEST_TEXT}`), false);
  for (const t of NOT_LATEST_TEXTS) assert.equal(latestShownTooEarly(`${t}\n✓ ${LATEST_TEXT}`), true);
  for (const t of NOT_LATEST_TEXTS) assert.equal(latestShownTooEarly(t), false);
});

test("startupTiming: 実行回数のラベルと、コピー用テキスト", () => {
  assert.equal(runLabel(1), "初回起動");
  assert.equal(runLabel(3), "3回目の起動");
  const text = renderTimingText([{ run: 2, build: "abc", latestSec: 3.456, settingsOpenedSec: 1, sawChecking: false, latestTooEarly: false, timedOut: false, mainThreadOps: null }], { userAgent: "UA", build: "abc" });
  assert.ok(text.includes("2回目の起動") && text.includes("3.5秒") && text.includes("確認未完了での「最新」表示 なし"));
});
