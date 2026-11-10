"use client";

/**
 * Memory Graph P0（試作）：人物シートの閲覧画面。読み込みはボタンを押したときだけ（READ ONLY）。
 * 各行に「本人の発言／AIの要約／Connectの推測」の区別と、根拠のMemory（末尾6桁のid）を出す。idを押すと、そのMemoryの保存内容を表示する。
 * 件数・文字数の上限は設けない（長い節は折りたたむ）。
 * 別名の候補は「この画面だけ一緒に見る」で一時的にまとめて表示できる（保存しない。ページを開き直すと戻る）。
 * 「記憶を探す」は、言葉を含むMemoryについて、このシートに出ているか・出ていないならなぜかを示す。
 */
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { buildPersonSheet, findInPersonSheet, listSheetPersons, type PersonSheet, PERSON_RELATION_LABEL_JA, renderPersonSheetText, SHEET_MATCH_LABEL, SHEET_SOURCE_LABEL, type PersonListEntry, type SheetPlan, type SheetText } from "@/lib/personSheet";
import { STATEMENT_ROLE_LABEL } from "@/lib/personStatement";
import { readMemoriesForPersonSheet } from "@/lib/personSheetRead";
import { buildPersonContext } from "@/lib/personContext";
import { buildPersonContextSection } from "@/lib/personContextPrompt";
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
  /** other names shown together with the selected one, on this page only (never stored) */
  const [withKeys, setWithKeys] = useState<string[]>([]);
  const [findWords, setFindWords] = useState("");

  async function load() {
    setStatus("読み込んでいます…");
    try {
      const result = await readMemoriesForPersonSheet();
      setMemories(result.memories);
      setSelected(null);
      setWithKeys([]);
      setOpenMemoryId(null);
      setStatus(result.missing ? "この端末に保存データがありません。" : `記憶 ${result.memories.length}件を読み込みました${result.skipped > 0 ? `（形が想定外のため除外した記憶：${result.skipped}件）` : ""}${result.droppedItems > 0 ? `（形が想定外のため除外した項目：${result.droppedItems}件）` : ""}。`);
    } catch (error) {
      setStatus(`読み込めませんでした：${String(error)}`);
    }
  }

  const persons: PersonListEntry[] = useMemo(() => (memories ? listSheetPersons(memories) : []), [memories]);
  // building the sheet must never take the page down: an unexpected record shows an error instead
  const built = useMemo((): { sheet: PersonSheet | null; error?: string } => {
    if (!memories || !selected) return { sheet: null };
    try {
      return { sheet: buildPersonSheet(memories, selected, { withKeys }) };
    } catch (error) {
      return { sheet: null, error: String(error) };
    }
  }, [memories, selected, withKeys]);
  const sheet = built.sheet;
  // Memory Graph P1-A: the background the chat would receive for this person (flag ON), with the names shown together on this page as confirmed aliases
  const chatPreview = useMemo((): string | null => {
    if (!memories || !selected) return null;
    try {
      const context = buildPersonContext(memories, selected, { aliases: withKeys.length > 0 ? [[selected, ...withKeys]] : [] });
      return buildPersonContextSection([context]) || "（会話に渡す背景はありません）";
    } catch (error) {
      return `作れませんでした：${String(error)}`;
    }
  }, [memories, selected, withKeys]);
  const byId = useMemo(() => new Map((memories ?? []).map((m) => [m.id, m] as const)), [memories]);
  const found = useMemo(() => {
    if (!memories || !sheet || !findWords.trim()) return null;
    try {
      return { hits: findInPersonSheet(memories, sheet, findWords) };
    } catch (error) {
      return { hits: [], error: String(error) };
    }
  }, [memories, sheet, findWords]);
  const toggleWith = (key: string) => setWithKeys((list) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]));
  // plans grouped by their topic (a plan without a topic stands alone)
  const planGroups = useMemo(() => {
    const groups = new Map<string, SheetPlan[]>();
    for (const p of sheet?.plans ?? []) {
      const g = p.record.topicId ?? `record:${p.record.memoryId}`;
      groups.set(g, [...(groups.get(g) ?? []), p]);
    }
    return [...groups.entries()];
  }, [sheet]);

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
  // the stored record opens above the sheet: bring it into view once it is rendered (an id may be pressed far down the page)
  const [scrollRequest, setScrollRequest] = useState(0);
  useEffect(() => {
    if (scrollRequest > 0) document.getElementById("person-sheet-memory")?.scrollIntoView({ block: "start" });
  }, [scrollRequest]);
  function showMemory(id: string) {
    setOpenMemoryId(id);
    setScrollRequest((n) => n + 1);
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
              <button key={p.key} type="button" onClick={() => { setSelected(p.key); setWithKeys([]); setOpenMemoryId(null); }}
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

      {built.error && <p className="rounded-xl border border-rose-400/60 p-2 text-xs text-rose-700 dark:text-rose-300">この人物のシートを組み立てられませんでした：{built.error}</p>}
      {sheet && (
        <div className="flex flex-col gap-3">
          {sheet.similarNames.length > 0 && (
            <p className="rounded-xl border border-rose-400/60 p-2 text-xs text-rose-700 dark:text-rose-300">
              似た名前があります（別人として扱っています。取り違えに注意）：{sheet.similarNames.join("、")}
            </p>
          )}
          <Section title={`同じ人かもしれない別の名前（${sheet.aliasCandidates.length}）`} note="同じ話題・Connectのつながりなどがある別の名前。推測で、まとめてはいない。「この画面だけ一緒に見る」は保存せず、ページを開き直すと戻る。同じ人かどうかは本人が判断する。">
            {sheet.keys.length > 1 && (
              <p className="rounded-xl border border-amber-500/60 p-2 text-xs text-amber-700 dark:text-amber-300">
                この画面だけ一緒に表示中（同じ人とは確定していない）：{sheet.keys.join("、")}
                <button type="button" onClick={() => setWithKeys([])} className="ml-2 underline">元に戻す</button>
              </p>
            )}
            {sheet.aliasCandidates.length === 0 && <None />}
            {sheet.aliasCandidates.map((c) => (
              <label key={c.key} className="flex flex-wrap items-baseline gap-2 text-sm">
                <input type="checkbox" checked={withKeys.includes(c.key)} onChange={() => toggleWith(c.key)} />
                <span>{c.names.join(" / ")}（記録 {c.records}）</span>
                <span className="text-[11px] text-stone-500">
                  同じ話題 {c.sharedTopics}・Connectのつながり {c.links}
                  {c.sharedCoPersons.length > 0 && `・共通して出てくる人 ${c.sharedCoPersons.join("、")}`}
                  {c.similarName && "・名前が似ている"}
                  {c.bothInOneRecord > 0 && <span className="text-rose-600 dark:text-rose-300">・同じ記録に両方の名前 {c.bothInOneRecord}件（別人の可能性）</span>}
                </span>
                <span className="text-[11px] text-stone-400">この画面だけ一緒に見る</span>
              </label>
            ))}
            <label className="flex flex-wrap items-center gap-2 text-xs text-stone-500">
              ほかの名前を一緒に見る：
              <select value="" onChange={(e) => { if (e.target.value) toggleWith(e.target.value); }} className="rounded border border-stone-300 bg-transparent px-1 py-0.5 dark:border-stone-600">
                <option value="">選ぶ</option>
                {persons.filter((p) => p.key !== selected && !withKeys.includes(p.key)).map((p) => <option key={p.key} value={p.key}>{p.names.join(" / ")}</option>)}
              </select>
            </label>
          </Section>

          <Section title="記憶を探す（このシートに出ない理由を確かめる）" note="すべての記憶から言葉を探し、このシートに出ているか、出ていないならなぜか、文がどう扱われたかを示す。">
            <input type="search" value={findWords} onChange={(e) => setFindWords(e.target.value)} placeholder="例：探したい言葉"
              className="w-full rounded-xl border border-stone-300 bg-transparent px-3 py-1.5 text-sm dark:border-stone-600" />
            {found?.error && <p className="text-xs text-rose-600">探せませんでした：{found.error}</p>}
            {found && !found.error && <p className="text-xs text-stone-500">見つかった記憶：{found.hits.length}件</p>}
            {found?.hits.map((h) => (
              <div key={h.memoryId} className="flex flex-col gap-1 border-l-2 border-stone-300 pl-2 text-xs dark:border-stone-600">
                <p>
                  {day(h.saidAt)} <Id id={h.memoryId} />{" "}
                  {h.onSheet ? <span className="text-emerald-700 dark:text-emerald-300">このシートに出ている（{SHEET_MATCH_LABEL[h.onSheet]}）</span> : <span className="text-rose-600 dark:text-rose-300">このシートに出ていない</span>}
                  {h.persons.length > 0 && <span className="text-stone-500">　この記録の人物：{h.persons.join("、")}</span>}
                </p>
                <p className="text-stone-500">ある場所：{h.where.join("、")}</p>
                {h.whyNotOnSheet && <p className="text-rose-600 dark:text-rose-300">理由：{h.whyNotOnSheet}</p>}
                {h.sentences.map((x, i) => (
                  <div key={i} className="pl-2">
                    <span className="text-stone-500">{x.source}：</span>「{x.text}」
                    <div className="text-stone-500">
                      {x.role && <>文の形：{STATEMENT_ROLE_LABEL[x.role]}（{x.reason}）／</>}扱い：{x.fateNote}
                    </div>
                  </div>
                ))}
              </div>
            ))}
          </Section>

          <Section title="関係の概要">
            <p className="text-sm">
              記録 {sheet.overview.records}件（人物として記録 {sheet.overview.mentionRecords}件・名前がキーワードにあるだけ {sheet.overview.keywordOnlyRecords}件・本文での言及だけ {sheet.overview.textOnlyRecords}件）
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
                  {r.match !== "mention" && <span className="text-rose-600 dark:text-rose-300">{SHEET_MATCH_LABEL[r.match]}</span>}
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

          <Section title={`過去の考え・結論（${sheet.views.length}）`} note="本人の発言を文ごとに、文の形で分けたもの（言い切り・決めたことは「判断・結論」、推量・気持ち・望みは「考え・気持ち」）。古い順で、同じ文は1回。記録した時点のもので、今も同じとは限らない。本人の発言に考えの文が無い記録だけAIの要約から出す。">
            {sheet.views.length === 0 && <None />}
            {sheet.views.map((v, i) => (
              <div key={i} className="flex flex-col gap-0.5">
                <span className="text-[10px] text-stone-500">{STATEMENT_ROLE_LABEL[v.role]}（{v.reason}）</span>
                <Text t={v.text} note={v.aboutOther ? "別の人についての考えかもしれない" : undefined} />
                {v.alsoIn.length > 0 && <p className="text-[11px] text-stone-400">同じ文がある記録：{v.alsoIn.map((id) => <Id key={id} id={id} />)}</p>}
              </div>
            ))}
          </Section>

          <Section title={`質問・依頼（${sheet.asked.length}）`} note="相手（AI）に尋ねた・確かめた・頼んだ文。本人の考えとは分けて示す。" open={false}>
            {sheet.asked.length === 0 && <None />}
            {sheet.asked.map((a, i) => <Text key={i} t={a.text} note={STATEMENT_ROLE_LABEL[a.role]} />)}
          </Section>

          <Section title="最後に確認できた記録" note="今の状態ではなく、最後に記録された内容とその日付。">
            {!sheet.last.said && <None />}
            {sheet.last.said && <div><p className="text-xs text-stone-500">最後に話した記録</p><Text t={sheet.last.said.summary} /></div>}
            {sheet.last.status && (
              <div>
                <p className="text-xs text-stone-500">状態の言葉（「{sheet.last.status.status}」）がある最後の記録</p>
                <Text t={sheet.last.status.summary} />
                {(sheet.last.statusLater ?? []).map((l) => <p key={l.memoryId} className="text-xs text-rose-600 dark:text-rose-300">同じ話題で共通の言葉（{l.sharedTerms.join("、")}）がある後の記録（この人の記録とは限らない）：{day(l.saidAt)} <Id id={l.memoryId} /> 「{l.status}」 {l.summary}</p>)}
              </div>
            )}
            {sheet.last.relation && <div><p className="text-xs text-stone-500">最後に述べた関係（{PERSON_RELATION_LABEL_JA[sheet.last.relation.relation]}）</p><Text t={sheet.last.relation} /></div>}
            {sheet.last.judgment && <div><p className="text-xs text-stone-500">本人の言葉での最後の判断・結論</p><Text t={sheet.last.judgment.text} /></div>}
            {sheet.last.ownView && <div><p className="text-xs text-stone-500">本人の言葉での最後の考え</p><Text t={sheet.last.ownView.text} /></div>}
          </Section>

          <Section title={`予定とその後（${sheet.plans.length}）`} note="結果の候補は、後の記録のうち「中止・保留・実施済み」の言葉があり、予定と共通の言葉（名前以外）があるものだけ。同じ話題というだけの記録は結果としない（件数だけ示す）。">
            {sheet.plans.length === 0 && <None />}
            {planGroups.map(([group, plans]) => (
              <div key={group} className="flex flex-col gap-2 border-l-2 border-stone-300 pl-2 dark:border-stone-600">
                <p className="font-mono text-[11px] text-stone-500">{plans[0].record.topicId ? `話題 ${shortId(plans[0].record.topicId)}` : "話題番号なし"}</p>
                {plans.map((p) => (
                  <div key={p.record.memoryId} className="flex flex-col gap-1">
                    <Text t={p.record.summary} note={p.why === "status" ? `記録の言葉「${p.record.status}」` : `出来事 ${p.record.eventTime} が話した日より後`} />
                    {p.outcome
                      ? <p className="text-xs">結果の候補：{day(p.outcome.saidAt)} <Id id={p.outcome.memoryId} /> 「{p.outcome.status}」（共通の言葉：{p.outcome.sharedTerms.join("、")}{p.outcome.sameTopic ? "・同じ話題" : "・別の話題"}） {p.outcome.summary}</p>
                      : <p className="text-xs text-stone-500">結果の候補なし（結果は不明）</p>}
                    {p.laterSameTopic.length > 0 && (
                      <details className="text-xs text-stone-500">
                        <summary>同じ話題の後の記録 {p.laterSameTopic.length}件（結果とはしていない）</summary>
                        {p.laterSameTopic.map((l) => <p key={l.memoryId}>{day(l.saidAt)} <Id id={l.memoryId} />{l.status ? ` 「${l.status}」` : ""}{l.sharedTerms.length ? `（共通：${l.sharedTerms.join("、")}）` : ""} {l.summary}</p>)}
                      </details>
                    )}
                  </div>
                ))}
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

          <Section title="会話に渡す背景（Memory Graph・試験）" note="?memoryGraph=1 で会話をONにしたとき、この人が話題になると会話AIに渡す内容。いっしょに表示している名前は、確定した別名として扱う（この画面だけ・保存しない）。" open={false}>
            <pre className="whitespace-pre-wrap break-words text-xs">{chatPreview}</pre>
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
