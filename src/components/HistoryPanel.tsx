"use client";

import { useEffect, useState } from "react";
import { getAllConversations, getAllMemoryObjects } from "@/lib/db";
import type { Conversation, ConversationTurn, MemoryObject, MemoryType, Persona } from "@/lib/types";

type HistoryTab = "diary" | "memory" | "conversation";
type SubView = "list" | "detail";

/** MemoryType（英語の列挙値）をUI表示用の日本語ラベルへ変換する。既存のtypes.tsの語彙のみを使う。 */
const MEMORY_TYPE_LABEL: Record<MemoryType, string> = {
  conversation: "会話",
  diary: "日記",
  idea: "アイデア",
  emotion: "感情",
  goal: "目標",
  person: "人物",
  event: "出来事",
  insight: "気づき",
};

/** ChatScreen.tsxのPERSONASと同じラベル（値の重複は許容し、循環import・新規ファイルを避ける）。 */
const PERSONA_LABEL: Record<Persona, string> = {
  companion: "日記",
  coach: "探究",
  analyst: "相談・創造",
};

/**
 * 「Tsumugiに話したことが、ちゃんと残っていて、あとから自分で見返せる」という
 * MVPの体験を最小限で成立させるための一覧・詳細UI。SettingsPanel/ImportPanelと
 * 同じfixed inset-0のフルスクリーンオーバーレイパターンを踏襲する。
 *
 * 読み取り専用（Vaultへの書き込みは一切行わない）のため、vaultHandleは受け取らず
 * onCloseだけで完結する。データ取得はgetAllMemoryObjects()/getAllConversations()
 * （どちらもIndexedDBのみを見る、既存のdb.ts関数）をそのまま使い、新しい取得基盤・
 * 検索基盤は作らない。Vault/OPFS/File System Accessには一切触れないため、
 * PC/Android/iPhone/iPadのどのストレージ方式でも同じUIがそのまま動く。
 *
 * 履歴マーク（↺）の入口を「日記／Memory／会話」の3タブへ拡張する：
 *   - 日記：既存のMemoryObject一覧（date日付グルーピング＋タップで詳細）を無変更のまま維持。
 *     デフォルト表示（既存ユーザーへの影響を最小にするため）。
 *   - Memory：同じMemoryObjectデータを、日付グルーピングせず新しい順のフラット一覧にし、
 *     summary・Memory type（types）・日時を表示する別の切り口。詳細ではcontentを
 *     省略せず全文表示し、conversationIdがあれば由来の会話（日時・ペルソナ）を一言添える
 *     （「元の会話へ戻る」ボタン等のドリルダウンは今回のスコープ外）。
 *   - 会話：実際のConversation一覧→タップでturns（ユーザー/AI）を時系列表示する詳細。
 *
 * 全文検索・キーワード検索・AI検索・Connect結果表示・Source一覧・Memory編集/削除・
 * 会話削除・タグ機能は対象外のまま。
 *
 * 日付順のソート・グルーピングは`date`（この記憶が指す時点）を基準にする。
 * `createdAt`/`updatedAt`（Tsumugiがレコードを作成・更新した時刻）とは混同しない。
 */
export default function HistoryPanel({
  onClose,
  initialMemoryId,
}: {
  onClose: () => void;
  /**
   * 「記憶しました」カード（ChatScreen.tsx）の「詳細を見る」から開かれた場合のみ渡される。
   * 渡された場合はMemoryタブを初期状態にし、該当するMemoryObjectの詳細を直接開く。
   * 渡されない通常の履歴表示（↺ボタン）では、これまでどおり日記タブの一覧から始まる
   * （このprop追加以外、日記／Memory／会話タブ・Memory詳細・会話詳細の既存ロジックは
   * 一切変更していない）。
   */
  initialMemoryId?: string;
}) {
  const [tab, setTab] = useState<HistoryTab>("diary");
  const [memoryObjects, setMemoryObjects] = useState<MemoryObject[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(true);

  // 日記タブ：既存のview/selectedをそのまま維持（挙動は無変更）。
  const [diaryView, setDiaryView] = useState<SubView>("list");
  const [diarySelected, setDiarySelected] = useState<MemoryObject | null>(null);

  // Memoryタブ：同じMemoryObjectデータを別の切り口で見るための、独立したナビゲーション状態。
  const [memoryView, setMemoryView] = useState<SubView>("list");
  const [memorySelected, setMemorySelected] = useState<MemoryObject | null>(null);

  // 会話タブ：Conversation用の独立したナビゲーション状態。
  const [conversationView, setConversationView] = useState<SubView>("list");
  const [conversationSelected, setConversationSelected] = useState<Conversation | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getAllMemoryObjects(), getAllConversations()]).then(([allMemory, allConversations]) => {
      if (cancelled) return;
      // dateの新しい順。createdAt/updatedAtではなくdate（記憶が指す時点）で並べる。
      const sortedMemory = [...allMemory].sort((a, b) => b.date.localeCompare(a.date));
      setMemoryObjects(sortedMemory);
      // startedAtの新しい順。
      setConversations([...allConversations].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
      setLoading(false);

      // initialMemoryIdが渡されていれば、Memoryタブの該当詳細を直接開く。
      // データ読み込み完了直後（sortedMemoryが確定した時点）にだけ行う一度きりの処理。
      if (initialMemoryId) {
        const target = sortedMemory.find((memory) => memory.id === initialMemoryId);
        if (target) {
          setTab("memory");
          setMemorySelected(target);
          setMemoryView("detail");
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, [initialMemoryId]);

  // MemoryのconversationIdから、由来会話（日時・ペルソナ）を引くための索引。
  // 追加のDB呼び出しはせず、既に読み込み済みのconversationsから作るだけ。
  const conversationById = new Map(conversations.map((c) => [c.id, c]));

  function openDiaryDetail(memory: MemoryObject) {
    setDiarySelected(memory);
    setDiaryView("detail");
  }
  function backToDiaryList() {
    setDiarySelected(null);
    setDiaryView("list");
  }

  function openMemoryDetail(memory: MemoryObject) {
    setMemorySelected(memory);
    setMemoryView("detail");
  }
  function backToMemoryList() {
    setMemorySelected(null);
    setMemoryView("list");
  }

  function openConversationDetail(conversation: Conversation) {
    setConversationSelected(conversation);
    setConversationView("detail");
  }
  function backToConversationList() {
    setConversationSelected(null);
    setConversationView("list");
  }

  // 日記タブ用：日付（YYYY-MM-DD）ごとにグルーピングする。既にdate降順なので同じ日付は隣り合っている。
  // markdown.ts/vault.tsが日別ファイル名等に使うdate.slice(0, 10)と同じ切り出し方を踏襲する。
  const diaryGroups: { dateLabel: string; items: MemoryObject[] }[] = [];
  for (const memory of memoryObjects) {
    const dateLabel = memory.date.slice(0, 10);
    const lastGroup = diaryGroups[diaryGroups.length - 1];
    if (lastGroup && lastGroup.dateLabel === dateLabel) {
      lastGroup.items.push(memory);
    } else {
      diaryGroups.push({ dateLabel, items: [memory] });
    }
  }

  return (
    <div className="flex h-dvh flex-col items-center justify-center bg-[var(--background)] px-5 py-8 text-[var(--foreground)]">
      <div className="flex max-h-[85dvh] w-full max-w-md flex-col gap-5 overflow-y-auto">
        <div className="flex items-center justify-between">
          <p className="text-lg text-stone-800 dark:text-stone-100">これまでの記憶</p>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full border border-stone-300/70 px-4 py-1.5 text-xs text-stone-600 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-300 dark:hover:bg-white/5"
          >
            閉じる
          </button>
        </div>

        {/*
          新しいアイコンは追加せず、既存の履歴マーク（↺）を入口として、この中だけで
          日記／Memory／会話を切り替える。既存の他のトグル（SettingsPanelのAI選択等）と
          同じpill button見た目に揃える。タブを切り替えても各タブのview/selectedは
          独立して保持する（タブを行き来しても、開いていた詳細が消えない）。
        */}
        <div className="flex gap-2">
          {(
            [
              { value: "diary", label: "日記" },
              { value: "memory", label: "Memory" },
              { value: "conversation", label: "会話" },
            ] as const
          ).map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => setTab(t.value)}
              className={`rounded-full border px-3 py-1 text-xs transition ${
                tab === t.value
                  ? "border-stone-800 bg-stone-800 text-stone-50 dark:border-stone-200 dark:bg-stone-200 dark:text-stone-900"
                  : "border-stone-300/60 text-stone-500 hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading && <p className="text-sm text-stone-400 dark:text-stone-500">読み込んでいます…</p>}

        {/* 日記タブ：既存の一覧・詳細ロジックをそのまま維持（見た目・挙動は無変更）。 */}
        {!loading && tab === "diary" && diaryView === "list" && (
          <div className="flex flex-col gap-5">
            {diaryGroups.length === 0 && (
              <p className="text-sm text-stone-400 dark:text-stone-500">まだ記憶がありません。</p>
            )}
            {diaryGroups.map((group) => (
              <div key={group.dateLabel} className="flex flex-col gap-2">
                <p className="text-xs text-stone-400 dark:text-stone-500">{group.dateLabel}</p>
                <div className="flex flex-col gap-2">
                  {group.items.map((memory) => (
                    <button
                      key={memory.id}
                      type="button"
                      onClick={() => openDiaryDetail(memory)}
                      className="rounded-2xl border border-stone-300/70 px-4 py-3 text-left text-sm text-stone-700 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-300 dark:hover:border-stone-400 dark:hover:bg-stone-900"
                    >
                      {memory.summary}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {!loading && tab === "diary" && diaryView === "detail" && diarySelected && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={backToDiaryList}
              className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
            >
              戻る
            </button>
            <p className="text-xs text-stone-400 dark:text-stone-500">{diarySelected.date.slice(0, 10)}</p>
            <p className="text-base text-stone-800 dark:text-stone-100">{diarySelected.summary}</p>
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
              {diarySelected.content}
            </p>
            {diarySelected.keywords.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {diarySelected.keywords.map((keyword) => (
                  <span
                    key={keyword}
                    className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 dark:border-stone-600/60 dark:text-stone-400"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}

        {/*
          Memoryタブ：日付グルーピングせず新しい順のフラット一覧にし、summary・Memory type・
          日時を1行ずつ表示する（日記タブと同じMemoryObjectデータを別の切り口で見せるだけ）。
        */}
        {!loading && tab === "memory" && memoryView === "list" && (
          <div className="flex flex-col gap-2">
            {memoryObjects.length === 0 && (
              <p className="text-sm text-stone-400 dark:text-stone-500">まだMemoryがありません。</p>
            )}
            {memoryObjects.map((memory) => (
              <button
                key={memory.id}
                type="button"
                onClick={() => openMemoryDetail(memory)}
                className="flex flex-col gap-1 rounded-2xl border border-stone-300/70 px-4 py-3 text-left transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:hover:border-stone-400 dark:hover:bg-stone-900"
              >
                <span className="text-sm text-stone-700 dark:text-stone-300">{memory.summary}</span>
                <span className="flex flex-wrap items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
                  <span>{memory.date.slice(0, 10)}</span>
                  {memory.types.map((type) => (
                    <span
                      key={type}
                      className="rounded-full border border-stone-300/60 px-2 py-0.5 dark:border-stone-600/60"
                    >
                      {MEMORY_TYPE_LABEL[type] ?? type}
                    </span>
                  ))}
                </span>
              </button>
            ))}
          </div>
        )}

        {!loading && tab === "memory" && memoryView === "detail" && memorySelected && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={backToMemoryList}
              className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
            >
              戻る
            </button>
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-stone-400 dark:text-stone-500">
              <span>{memorySelected.date.slice(0, 10)}</span>
              {memorySelected.types.map((type) => (
                <span
                  key={type}
                  className="rounded-full border border-stone-300/60 px-2 py-0.5 dark:border-stone-600/60"
                >
                  {MEMORY_TYPE_LABEL[type] ?? type}
                </span>
              ))}
            </div>
            <p className="text-base text-stone-800 dark:text-stone-100">{memorySelected.summary}</p>
            {/*
              保存されている実データ（content）を省略せず、全文をそのまま表示する
              （文字数制限・truncate・「続きを読む」等は付けない）。
            */}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
              {memorySelected.content}
            </p>
            {memorySelected.keywords.length > 0 && (
              <div className="flex flex-wrap gap-2 pt-2">
                {memorySelected.keywords.map((keyword) => (
                  <span
                    key={keyword}
                    className="rounded-full border border-stone-300/60 px-3 py-1 text-xs text-stone-500 dark:border-stone-600/60 dark:text-stone-400"
                  >
                    {keyword}
                  </span>
                ))}
              </div>
            )}
            {/*
              このMemoryがどの会話から生まれたかの追跡（既存のconversationIdをそのまま使う）。
              「元の会話へ戻る」ボタン等のドリルダウンは今回のスコープ外のため、
              日時・ペルソナだけを一言添える表示にとどめる。
            */}
            {memorySelected.conversationId &&
              (() => {
                const origin = conversationById.get(memorySelected.conversationId);
                if (!origin) return null;
                return (
                  <p className="border-t border-black/5 pt-3 text-xs text-stone-400 dark:border-white/10 dark:text-stone-500">
                    由来：{origin.startedAt.slice(0, 10)}の{PERSONA_LABEL[origin.persona]}の会話
                  </p>
                );
              })()}
          </div>
        )}

        {/* 会話タブ：既存のConversation保存データをそのまま使う。新しい保存方式は作らない。 */}
        {!loading && tab === "conversation" && conversationView === "list" && (
          <div className="flex flex-col gap-2">
            {conversations.length === 0 && (
              <p className="text-sm text-stone-400 dark:text-stone-500">まだ会話がありません。</p>
            )}
            {conversations.map((conversation) => (
              <button
                key={conversation.id}
                type="button"
                onClick={() => openConversationDetail(conversation)}
                className="flex items-center justify-between gap-4 rounded-2xl border border-stone-300/70 px-4 py-3 text-left text-sm text-stone-700 transition hover:border-stone-500 hover:bg-stone-100 dark:border-stone-700/70 dark:text-stone-300 dark:hover:border-stone-400 dark:hover:bg-stone-900"
              >
                <span className="flex flex-col gap-1">
                  <span>{PERSONA_LABEL[conversation.persona]}</span>
                  <span className="text-[11px] text-stone-400 dark:text-stone-500">
                    {conversation.startedAt.slice(0, 10)}
                  </span>
                </span>
                <span className="shrink-0 text-[11px] text-stone-400 dark:text-stone-500">
                  {conversation.turns.length}件のメッセージ
                </span>
              </button>
            ))}
          </div>
        )}

        {!loading && tab === "conversation" && conversationView === "detail" && conversationSelected && (
          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={backToConversationList}
              className="self-start rounded-full border border-stone-300/60 px-4 py-1.5 text-xs text-stone-500 transition hover:bg-stone-900/5 dark:border-stone-600/60 dark:text-stone-400 dark:hover:bg-white/5"
            >
              戻る
            </button>
            <p className="text-xs text-stone-400 dark:text-stone-500">
              {conversationSelected.startedAt.slice(0, 10)}・{PERSONA_LABEL[conversationSelected.persona]}
            </p>
            <div className="flex flex-col gap-3">
              {conversationSelected.turns.map((turn, index) => (
                <HistoryTurnBubble key={index} turn={turn} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * ChatScreen.tsxのTurnBubbleと同じ見た目の吹き出し。ChatScreen.tsxはHistoryPanelを
 * importしているため、循環importを避けるためにここでは同じ見た目を再実装する
 * （ロジックを持たない純粋な表示コンポーネントで、双方の見た目は意図的に揃えている）。
 */
function HistoryTurnBubble({ turn }: { turn: ConversationTurn }) {
  if (turn.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] rounded-2xl bg-stone-800 px-4 py-2 text-sm text-stone-50 dark:bg-stone-200 dark:text-stone-900">
          {turn.content}
        </div>
      </div>
    );
  }
  return (
    <div className="max-w-[85%] whitespace-pre-wrap text-sm leading-relaxed text-stone-700 dark:text-stone-300">
      {turn.content}
    </div>
  );
}
