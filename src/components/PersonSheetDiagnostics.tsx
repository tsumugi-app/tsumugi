"use client";

/**
 * Memory Graph P0（試作）：人物シートの閲覧画面。読み込みはボタンを押したときだけ（READ ONLY）。
 * 各行に「本人の発言／AIの要約／Connectの推測」の区別と、根拠のMemory（末尾6桁のid）を出す。idを押すと、そのMemoryの保存内容を表示する。
 * 件数・文字数の上限は設けない（長い節は折りたたむ）。
 */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { buildPersonSheet, listSheetPersons, PERSON_RELATION_LABEL_JA, renderPersonSheetText, SHEET_SOURCE_LABEL, type PersonListEntry, type SheetText } from "@/lib/personSheet";
import { readMemoriesForPersonSheet } from "@/lib/personSheetRead";
import type { MemoryObject } from "@/lib/types";

const shortId = (id: string) => `#${id.slice(-6)}`;
const day = (iso?: string) => (iso ? iso.slice(0, 10) : "");
const KIND_CLASS: Record<SheetText["kind"], string> = {
  user: "border-emerald-500/60 text-emerald-700 dark:text-emerald-300",
  summary: "border-stone-400/60 text-stone-500 dark:text-stone-400",
  connect: "border-amber-500/60 text-amber-700 dark:text-amber-300",
};

/** the Memory id buttons open the stored record of that Memory */
const OpenMemoryContext = createContext<(id: string) => void>(() => {});

function Id({ id }: { id: string }) {
  const open = useContext(OpenMemoryContext);
  return (
    <button type="button" onClick={() => open(id)} className="font-mono text-[11px] text-sky-700 underline dark:text-sky-300">
      {shortId(id)}
    </button>
  );
}

function Text({ t, note }: { t: SheetText; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-sm">
      <span className={`rounded-full border px-1.5 text-[10px] ${KIND_CLASS[t.kind]}`}>{SHEET_SOURCE_LABEL[t.kind]}</span>
      <span className="text-[11px] text-stone-400">{day(t.saidAt)}</span>
      <Id id={t.memoryId} />
      <span className="text-stone-800 dark:text-stone-100">{t.kind === "user" ? `「${t.text}」` : t.text}</span>
      {note && <span className="text-[11px] text-rose-600 dark:text-rose-300">{note}</span>}
    </div>
  );
}

function Section({ title, note, children, open = true }: { title: string; note?: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open} className="rounded-2xl border border-black/10 p-3 dark:border-white/10">
      <summary className="cursor-pointer text-sm font-medium text-stone-700 dark:text-stone-200">{title}</summary>
      {note && <p className="mt-1 text-[11px] text-stone-400">{note}</p>}
      <div className="mt-2 flex flex-col gap-2">{children}</div>
    </details>
  );
}

function None() {
  return <p className="text-sm text-stone-400">（なし）</p>;
}

export default function PersonSheetDiagnostics() {
  const [memories, setMemories] = useState<MemoryObject[] | null>(null);
  const [status, setStatus] = useState<string>("");
  const [selected, setSelected] = useState<string | null>(null);
  const [openMemoryId, setOpenMemoryId] = useState<string | null>(null);

  async function load() {
    setStatus("読み込んでいます…");
    try {
      const result = await readMemoriesForPersonSheet();
      setMemories(result.memories);
      setSelected(null);
      setOpenMemoryId(null);
      setStatus(result.missing ? "この端末に保存データがありません。" : `記憶 ${result.memories.length}件を読み込みました${result.skipped > 0 ? `（形が想定外のため除外：${result.skipped}件）` : ""}。`);
    } catch (error) {
      setStatus(`読み込めませんでした：${String(error)}`);
    }
  }

  const persons: PersonListEntry[] = useMemo(() => (memories ? listSheetPersons(memories) : []), [memories]);
  const sheet = useMemo(() => (memories && selected ? buildPersonSheet(memories, selected) : null), [memories, selected]);
  const byId = useMemo(() => new Map((memories ?? []).map((m) => [m.id, m] as const)), [memories]);

  async function copySheet() {
    if (!sheet) return;
    try {
      await navigator.clipboard.writeText(renderPersonSheetText(sheet));
      setStatus("人物シートをコピーしました（会話や記憶の本文を含みます）。");
    } catch {
      setStatus("コピーに失敗しました。");
    }
  }

  const openMemory = openMemoryId ? byId.get(openMemoryId) : undefined;
  // the stored record opens above the sheet: bring it into view (an id may be pressed far down the page)
  function showMemory(id: string) {
    setOpenMemoryId(id);
    window.requestAnimationFrame(() => document.getElementById("person-sheet-memory")?.scrollIntoView({ block: "start" }));
  }

  return (
    <OpenMemoryContext.Provider value={showMemory}>
    <main className="mx-auto flex min-h-screen max-w-3xl flex-col gap-4 bg-stone-50 px-4 py-6 text-stone-800 dark:bg-stone-950 dark:text-stone-100">
      <h1 className="text-lg">人物シート（試作）</h1>
      <p className="text-xs leading-relaxed text-stone-500 dark:text-stone-400">
        この端末に保存された記憶から、人物ごとの情報をその場で組み立てます。読み取りだけで、保存・変更・AIの呼び出しはしません。会話の返答には使われません。
        「本人の発言」は保存された逐語、「AIの要約」は記憶を作ったAIの文、「Connectの推測」はAIが判定したつながりです。現在の状態や因果関係は断定しません。
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => void load()} className="rounded-full border border-stone-300 px-4 py-1.5 text-sm dark:border-stone-600">
          この端末の記憶を読み込む
        </button>
        {sheet && (
          <button type="button" onClick={() => void copySheet()} className="rounded-full border border-stone-300 px-4 py-1.5 text-sm dark:border-stone-600">
            このシートをテキストでコピー
          </button>
        )}
        <span className="text-xs text-stone-500">{status}</span>
      </div>

      {memories && (
        <Section title={`人物（${persons.length}）`} note="名前ごと。敬称の違いだけはまとめ、別の呼び方（例：名前と続柄）はまとめない。">
          {persons.length === 0 && <None />}
          <div className="flex flex-wrap gap-2">
            {persons.map((p) => (
              <button key={p.key} type="button" onClick={() => { setSelected(p.key); setOpenMemoryId(null); }}
                className={`rounded-full border px-3 py-1 text-sm ${selected === p.key ? "border-sky-500 bg-sky-500/10" : "border-stone-300 dark:border-stone-600"}`}>
                {p.names.join(" / ")}（記録 {p.mentionRecords}{p.keywordOnlyRecords > 0 ? `＋キーワードのみ ${p.keywordOnlyRecords}` : ""}）
              </button>
            ))}
          </div>
        </Section>
      )}

      {openMemory && (
        <div id="person-sheet-memory" className="rounded-2xl border border-sky-500/50 p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs">根拠のMemory {shortId(openMemory.id)}（{day(openMemory.statedAt ?? openMemory.date)}）</span>
            <button type="button" onClick={() => setOpenMemoryId(null)} className="text-xs underline">閉じる</button>
          </div>
          <dl className="mt-2 grid grid-cols-[7rem_1fr] gap-x-2 gap-y-1 text-xs">
            <dt className="text-stone-400">AIの要約</dt><dd>{openMemory.summary}</dd>
            <dt className="text-stone-400">本文（AI）</dt><dd className="whitespace-pre-wrap">{openMemory.content}</dd>
            <dt className="text-stone-400">キーワード</dt><dd>{openMemory.keywords.join("、")}</dd>
            <dt className="text-stone-400">本人の発言</dt><dd>{(openMemory.evidenceQuotes ?? []).map((q) => `「${q}」`).join(" ") || "（なし）"}</dd>
            <dt className="text-stone-400">人物</dt><dd>{(openMemory.personMentions ?? []).map((p) => `${p.displayName}${p.relation ? `（${PERSON_RELATION_LABEL_JA[p.relation]}）` : ""}：「${p.quote}」`).join(" ") || "（なし）"}</dd>
            <dt className="text-stone-400">話題の発言</dt><dd>{(openMemory.topicEvents ?? []).map((e) => `「${e.quote}」`).join(" ") || "（なし）"}</dd>
            <dt className="text-stone-400">日付</dt><dd>記録 {day(openMemory.date)}{openMemory.statedAt ? ` / 話した日 ${day(openMemory.statedAt)}` : ""}{openMemory.eventTime ? ` / 出来事 ${openMemory.eventTime}` : ""}</dd>
            <dt className="text-stone-400">話題・会話</dt><dd className="font-mono">{openMemory.topicId ? shortId(openMemory.topicId) : "-"} / {openMemory.conversationId ? shortId(openMemory.conversationId) : "-"}</dd>
            <dt className="text-stone-400">つながり</dt><dd>{openMemory.links.length}件</dd>
          </dl>
        </div>
      )}

      {sheet && (
        <div className="flex flex-col gap-3">
          {sheet.similarNames.length > 0 && (
            <p className="rounded-xl border border-rose-400/60 p-2 text-xs text-rose-700 dark:text-rose-300">
              似た名前があります（別人として扱っています。取り違えに注意）：{sheet.similarNames.join("、")}
            </p>
          )}
          <Section title="関係の概要">
            <p className="text-sm">
              記録 {sheet.overview.records}件（人物として記録 {sheet.overview.mentionRecords}件・名前がキーワードにあるだけ {sheet.overview.keywordOnlyRecords}件）
              {sheet.overview.firstSaidAt && `　${day(sheet.overview.firstSaidAt)}〜${day(sheet.overview.lastSaidAt)}`}
            </p>
            {sheet.overview.relation && (
              <div className="flex flex-col gap-1">
                <p className="text-sm">関係（記憶を作ったAIの分類）：{sheet.overview.relation.label}</p>
                {sheet.overview.relation.basis.map((b, i) => <Text key={i} t={b} note={`分類：${PERSON_RELATION_LABEL_JA[b.relation]}${b.correction ? "・訂正" : ""}`} />)}
              </div>
            )}
            {sheet.overview.coPersons.length > 0 && (
              <p className="text-xs text-stone-500">同じ記録に出てくる人：{sheet.overview.coPersons.map((p) => `${p.name}（${p.records}件）`).join("、")}</p>
            )}
          </Section>

          <Section title={`出来事（${sheet.records.length}件・話した日の順）`} note="「記録の言葉」は要約に出てくる状態の語で、この人についての状態とは限らない。">
            {sheet.records.length === 0 && <None />}
            {sheet.records.map((r) => (
              <div key={r.memoryId} className="flex flex-col gap-1 border-l-2 border-stone-300 pl-2 dark:border-stone-600">
                <div className="flex flex-wrap gap-1.5 text-[11px] text-stone-500">
                  <span>{day(r.saidAt)}（{r.saidAtIsRecordDate ? "記録日" : "話した日"}）</span>
                  {r.match === "keyword" && <span className="text-rose-600 dark:text-rose-300">名前がキーワードにあるだけ</span>}
                  {r.eventTime && <span>出来事 {r.eventTime}</span>}
                  {r.status && <span>記録の言葉「{r.status}」</span>}
                  {r.retrospective && <span>以前の出来事を後から話した</span>}
                  {r.otherPersons.length > 0 && <span>他の人：{r.otherPersons.join("、")}</span>}
                  {r.topicId && <span className="font-mono">話題 {shortId(r.topicId)}</span>}
                  {r.linkCount > 0 && <span>つながり {r.linkCount}</span>}
                </div>
                <Text t={r.summary} />
                {r.mentionQuotes.map((q, i) => <Text key={`m${i}`} t={q} />)}
                {r.evidence.map((q, i) => <Text key={`e${i}`} t={q} note={q.aboutOther ? "別の人の話かもしれない" : undefined} />)}
              </div>
            ))}
          </Section>

          <Section title={`過去の考え・結論（${sheet.views.length}）`} note="考え・気持ち・判断の言葉を含む文。記録した時点のもので、今も同じとは限らない。本人の発言が無い記録だけAIの要約から出す。">
            {sheet.views.length === 0 && <None />}
            {sheet.views.map((v, i) => <Text key={i} t={v.text} note={v.aboutOther ? "別の人についての考えかもしれない" : undefined} />)}
          </Section>

          <Section title="最後に確認できた記録" note="今の状態ではなく、最後に記録された内容とその日付。">
            {!sheet.last.said && <None />}
            {sheet.last.said && <div><p className="text-xs text-stone-500">最後に話した記録</p><Text t={sheet.last.said.summary} /></div>}
            {sheet.last.status && (
              <div>
                <p className="text-xs text-stone-500">状態の言葉（「{sheet.last.status.status}」）がある最後の記録</p>
                <Text t={sheet.last.status.summary} />
                {(sheet.last.statusLater ?? []).map((l) => <p key={l.memoryId} className="text-xs text-rose-600 dark:text-rose-300">同じ話題の後の記録（この人の記録とは限らない）：{day(l.saidAt)} <Id id={l.memoryId} /> 「{l.status}」 {l.summary}</p>)}
              </div>
            )}
            {sheet.last.relation && <div><p className="text-xs text-stone-500">最後に述べた関係（{PERSON_RELATION_LABEL_JA[sheet.last.relation.relation]}）</p><Text t={sheet.last.relation} /></div>}
            {sheet.last.ownView && <div><p className="text-xs text-stone-500">本人の言葉での最後の考え</p><Text t={sheet.last.ownView.text} /></div>}
          </Section>

          <Section title={`予定とその後（${sheet.plans.length}）`} note="同じ話題（話題番号が同じ）の後の記録だけを「その後」とする。キーワードが同じだけの記録は候補で、結果かどうかは未確認。">
            {sheet.plans.length === 0 && <None />}
            {sheet.plans.map((p) => (
              <div key={p.record.memoryId} className="flex flex-col gap-1 border-l-2 border-stone-300 pl-2 dark:border-stone-600">
                <Text t={p.record.summary} note={p.why === "status" ? `記録の言葉「${p.record.status}」` : `出来事 ${p.record.eventTime} が話した日より後`} />
                {p.sameTopicLater.length === 0 && p.keywordLater.length === 0 && <p className="text-xs text-stone-500">その後の記録なし（結果は不明）</p>}
                {p.sameTopicLater.map((l) => <p key={l.memoryId} className="text-xs">同じ話題の後の記録：{day(l.saidAt)} <Id id={l.memoryId} />{l.status ? ` 「${l.status}」` : ""} {l.summary}</p>)}
                {p.keywordLater.map((l) => <p key={l.memoryId} className="text-xs text-stone-500">候補（同じキーワード：{l.sharedKeywords.join("、")}）：{day(l.saidAt)} <Id id={l.memoryId} />{l.status ? ` 「${l.status}」` : ""} {l.summary}</p>)}
              </div>
            ))}
          </Section>

          <Section title={`話題の発言（Topic Timeline・${sheet.topics.length}話題）`} note="この人の記録が属する話題の、本人の発言すべて。同じ話題でも、この人の記録ではないものは別に示す。" open={false}>
            {sheet.topics.length === 0 && <None />}
            {sheet.topics.map((tp) => (
              <div key={tp.topicId} className="flex flex-col gap-1">
                <p className="font-mono text-xs text-stone-500">話題 {shortId(tp.topicId)}</p>
                {tp.events.map((e, i) => <Text key={i} t={{ kind: "user", text: e.quote, memoryId: e.memoryId, saidAt: e.saidAt }} note={e.otherPersons.length ? `他の人：${e.otherPersons.join("、")}` : undefined} />)}
                {tp.otherRecords.map((o) => <p key={o.memoryId} className="text-xs text-rose-600 dark:text-rose-300">この話題の、この人の記録ではないもの：{day(o.saidAt)} <Id id={o.memoryId} />{o.persons.length ? `（${o.persons.join("、")}）` : ""}</p>)}
              </div>
            ))}
          </Section>

          <Section title={`Connectの推測（${sheet.links.length}）`} note="AIが判定したつながり。事実ではない。" open={false}>
            {sheet.links.length === 0 && <None />}
            {sheet.links.map((l, i) => (
              <div key={i} className="text-xs">
                <span className={`mr-1 rounded-full border px-1.5 text-[10px] ${KIND_CLASS.connect}`}>{SHEET_SOURCE_LABEL.connect}</span>
                <Id id={l.fromId} /> → <Id id={l.toId} /> 軸：{l.axis} 強さ：{l.strength}{l.contrast ? " 対比" : ""}
                {!l.otherEndAboutPerson && <span className="text-rose-600 dark:text-rose-300">（相手側はこの人の記録ではない）</span>}
                <div className="text-stone-600 dark:text-stone-300">理由：{l.reason}</div>
              </div>
            ))}
          </Section>

          <Section title={`テーマ（Memory Timeline・${sheet.themes.length}）`} note="この人の記録のキーワードが、Memory Timelineのテーマ（3回以上・14日以上）になっているもの。テーマには他の人の記録も含まれる。" open={false}>
            {sheet.themes.length === 0 && <None />}
            {sheet.themes.map((th) => (
              <div key={th.theme} className="flex flex-col gap-1">
                <p className="text-sm">「{th.theme}」 状態（記録の言葉から）：{th.state}{th.stateBasisId && <> 根拠 {day(th.stateBasisSaidAt)} <Id id={th.stateBasisId} /></>}</p>
                {th.points.map((p) => <p key={p.memoryId} className="text-xs">{day(p.saidAt)} <Id id={p.memoryId} />{p.status ? ` 「${p.status}」` : ""}{!p.aboutPerson && <span className="text-rose-600 dark:text-rose-300">（この人の記録ではない）</span>} {p.summary}</p>)}
              </div>
            ))}
          </Section>
        </div>
      )}
    </main>
    </OpenMemoryContext.Provider>
  );
}
