/**
 * 「つむぎの木」の成長段階を判定するロジック（Beta最小実装）。
 *
 * 添付されたデザイン（01 芽生え／02 育つ／03 葉が茂る／04 色づく／05 実がなる／
 * 06 脳の形へ、の6段階）を仕様として扱う。このファイルはその段階を「今、どこまで
 * 満たしているか」を判定するだけの、副作用の無い純粋関数群であり、Memory schema・
 * Capture・Connect・Vault・IndexedDBのいずれにも変更を加えない（新しいDB構造も無い）。
 *
 * 設計方針（Memory件数だけに密結合させない）：
 * 「木の成長段階を決める関数」（computeTreeStage）は、生のMemoryObject配列を直接見る
 * のではなく、抽象化された`TreeSignals`（記憶の量・つながりの量・気づきの有無）だけを
 * 受け取る。「MemoryObject配列からTreeSignalsを作る関数」（computeTreeSignals）を別に
 * 分離しておくことで、将来「過去の記憶が更新された回数」のような新しい信号を追加したく
 * なった場合も、computeTreeStage自体（しきい値判定のロジック）を書き換えずに、
 * TreeSignalsの生成側だけを差し替えられるようにする。
 *
 * 成長条件（添付デザインの説明文をそのまま踏襲）：
 *   01 芽生え：Memoryが1件以上
 *   02 育つ：01を満たし、Memoryが一定数以上
 *   03 葉が茂る：02を満たし、Memoryがさらに一定数以上
 *   04 色づく：03を満たし、ConnectによるLinkが一定数以上（線としては表示しない）
 *   05 実がなる：04を満たし、Insight Memory（types.includes("insight")）が1件以上
 *   06 脳の形へ：05を満たし、MemoryとLinkがさらに十分に蓄積している
 * 各段階は独立判定ではなく、前段階の条件を満たした上での累積型。
 */

import type { MemoryObject } from "./types";

/** 0＝まだ最初のMemoryも無い状態（01より前）。1〜6が添付デザインの01〜06に対応する。 */
export type TreeStage = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 木の成長判定に使う、抽象化された信号。
 * - memoryCount：Memoryの総数（「葉の物理的な量」に対応。ただしMemory数そのものを
 *   木の段階＝レベルとして直接使うわけではない。01〜03の判定材料に限定して使う）。
 * - linkCount：Connectで生成されたLinkの総数（重複無し）。Linkは生成時、source側・
 *   target側それぞれのMemoryObject.linksへ同じLink（同じid）が複製されるため
 *   （src/lib/connect.ts参照）、Link.idで重複排除してから数える。
 * - insightCount：type:"insight"を持つMemoryObjectの数（Reflectionが生成したInsight）。
 *   05の判定は「1件以上あるか」の有無のみを見る（件数そのものは使わない）。
 */
export interface TreeSignals {
  memoryCount: number;
  linkCount: number;
  insightCount: number;
}

/**
 * IndexedDBから読み取り済みのMemoryObject配列から、TreeSignalsを計算する。
 * 新しいDB読み取りは行わない（呼び出し元が既存のgetAllMemoryObjects()で取得した
 * 配列をそのまま渡す想定。TreePanel.tsx参照）。
 */
export function computeTreeSignals(memoryObjects: MemoryObject[]): TreeSignals {
  const memoryCount = memoryObjects.length;

  let insightCount = 0;
  const linkIds = new Set<string>();
  for (const memory of memoryObjects) {
    if (memory.types.includes("insight")) {
      insightCount += 1;
    }
    for (const link of memory.links) {
      linkIds.add(link.id);
    }
  }

  return { memoryCount, linkCount: linkIds.size, insightCount };
}

/**
 * 各段階のしきい値（仮）。
 *
 * 重要：この場（コード調査）からは、公開Betaの実ユーザーのIndexedDB（各ユーザーの
 * ブラウザ内にのみ存在する）を直接集計する手段が無いため、「実際の分布」そのものは
 * 確認できていない。以下は、これまでの調査で判明している構造的な事実だけを根拠にした
 * 仮の値であり、実際の利用データが得られ次第、この定数だけを調整すればよい設計にしてある。
 *
 * 根拠にした事実：
 * - Capture（会話の終了1回）で生成されるMemoryは、通常1〜3件程度
 *   （MEMORY_ENGINE.md/capture.tsの「意味のある単位でまとめる」という粒度方針より）。
 * - Linkは、Connect候補5件中・strength 0.5以上・1 Memoryあたり最大2件、という
 *   狭い条件を通過したものだけが生成されるため、構造的にMemory件数よりずっと
 *   少なくなる（src/lib/connect.ts CANDIDATE_LIMIT/MAX_LINKS_PER_MEMORY/
 *   STRENGTH_THRESHOLD参照）。
 * - 過去の調査で確認した、蓄積のある実機ログでは「Conversation＋MemoryObject＋
 *   Source」の合計が172〜176件程度だった（Memory単体の件数ではなく、3種類の合計）。
 * これらを踏まえ、「既に大量のMemoryを持つ既存ユーザーが、木を開いた瞬間に
 * 06まで到達してしまう」ことを避ける方向で、安全側の暫定値を置いている。
 */
export const TREE_THRESHOLDS = {
  /** 01 芽生え：最初のMemory。 */
  stage01MinMemories: 1,
  /** 02 育つ。 */
  stage02MinMemories: 5,
  /** 03 葉が茂る。 */
  stage03MinMemories: 20,
  /** 04 色づく：Connectによるつながり。 */
  stage04MinLinks: 5,
  /** 05 実がなる：Insightの存在（有無のみ）。 */
  stage05MinInsights: 1,
  /** 06 脳の形へ：記憶・つながり双方が十分に蓄積した状態（複合条件）。 */
  stage06MinMemories: 100,
  stage06MinLinks: 20,
} as const;

/**
 * 累積型の判定：前段階の条件を満たさない限り、次の段階には進まない。
 * 条件を満たさなくなった時点で判定を止め、その時点の段階を返す。
 */
export function computeTreeStage(signals: TreeSignals): TreeStage {
  let stage: TreeStage = 0;

  if (signals.memoryCount < TREE_THRESHOLDS.stage01MinMemories) return stage;
  stage = 1;

  if (signals.memoryCount < TREE_THRESHOLDS.stage02MinMemories) return stage;
  stage = 2;

  if (signals.memoryCount < TREE_THRESHOLDS.stage03MinMemories) return stage;
  stage = 3;

  if (signals.linkCount < TREE_THRESHOLDS.stage04MinLinks) return stage;
  stage = 4;

  if (signals.insightCount < TREE_THRESHOLDS.stage05MinInsights) return stage;
  stage = 5;

  if (
    signals.memoryCount < TREE_THRESHOLDS.stage06MinMemories ||
    signals.linkCount < TREE_THRESHOLDS.stage06MinLinks
  ) {
    return stage;
  }
  stage = 6;

  return stage;
}

/**
 * 各段階の画像ファイル名（想定・仮）。
 * 画像アセット自体は、この実装時点ではまだリポジトリに存在しない（別途デザイン側からの
 * 納品が必要）。ここではpublic/tree/配下に、この名前で配置される前提のパスだけを定義する。
 * TreePanel.tsx側は、画像の読み込みに失敗した場合（onError）に一文だけの表示へ
 * フォールバックする。
 */
export const TREE_STAGE_IMAGE_PATH: Record<Exclude<TreeStage, 0>, string> = {
  1: "/tree/stage-01-mebae.png",
  2: "/tree/stage-02-sodatsu.png",
  3: "/tree/stage-03-happa.png",
  4: "/tree/stage-04-irozuku.png",
  5: "/tree/stage-05-mi.png",
  6: "/tree/stage-06-nou.png",
};

/**
 * 各段階で画面に表示する、静かな一文。Memory件数・Link件数等の数字は一切含めない
 * （「Memory 172件」のようなダッシュボード表示を禁止する、という設計方針に対応）。
 */
export const TREE_STAGE_MESSAGE: Record<TreeStage, string> = {
  0: "まだ何も話していないようです。話しかけると、最初の記憶が芽吹きます。",
  1: "最初の記憶が、そっと芽を出しました。",
  2: "少しずつ、あなたの世界が育っています。",
  3: "葉が茂り、木らしい姿になってきました。",
  4: "記憶がつながり合い、世界に色がつき始めています。",
  5: "つながりの中から、新しい気づきが生まれました。",
  6: "記憶とつながりが重なり合い、あなただけの世界が育っています。",
};

/* ------------------------------------------------------------------------
 * 段階内リーフ成長（Beta最小実装、stage 01〜03のみ）
 *
 * 「6段階の完成イラストを切り替えるだけ」ではなく、Memoryが増えるたびに、その段階の
 * ベース画像の上へ、あらかじめ決めた位置へ葉を1枚ずつ静かに増やしていく。
 * computeTreeSignals()／computeTreeStage()の契約は変更しない（TreeSignalsに
 * leafCountのようなフィールドは追加しない）。ここに置く関数群は、既存の2関数の
 * 「外側」に独立して追加するだけで、既存の判定ロジックには一切触れない。
 *
 * 04（色付き葉）・05（実）・06（追加要素なし、最終形として静止）は今回のスコープ外。
 * ------------------------------------------------------------------------ */

/**
 * 葉1枚の固定配置。位置は木画像を表示している正方形コンテナを基準にした%座標
 * （レスポンシブでもズレない）。rotate/scale/flipは、少ない葉素材からでも
 * 「判子を押したような」繰り返しに見えないようにするための、あらかじめ決めた
 * 個別の見た目調整（実行時にランダム生成はしない＝配置も見た目も完全に固定）。
 */
export interface LeafAnchor {
  xPercent: number;
  yPercent: number;
  /** LEAF_SPRITE_PATHのキー。どの葉素材を使うか。 */
  spriteId: string;
  rotateDeg?: number;
  scale?: number;
  flip?: boolean;
}

/**
 * 葉素材（透過PNG想定）のパス一覧。既存6段階のイラストと同じ水彩の質感で、
 * 新規に描き起こす小さな「1枚だけの葉」を4種類、01〜03で使い回す前提。
 *
 * 重要：この実装時点では、これらのファイルはまだリポジトリに存在しない
 * （public/tree/leaves/配下に、この名前で配置される想定のパスのみを定義する）。
 * 仮画像はここでは一切作成していない。読み込みに失敗した場合は、その葉1枚だけを
 * 静かに諦める（LaunchTreeScreen側のonErrorで個別に制御する）。
 */
export const LEAF_SPRITE_PATH: Record<string, string> = {
  "leaf-a": "/tree/leaves/leaf-a.png",
  "leaf-b": "/tree/leaves/leaf-b.png",
  "leaf-c": "/tree/leaves/leaf-c.png",
  "leaf-d": "/tree/leaves/leaf-d.png",
};

/**
 * stage 01〜03専用の、段階ごとに独立した固定配置リスト。
 *
 * 納品された実画像（public/tree/stage-0{1,2,3}-*.png、全て1205×1054px）を、
 * アルファチャンネルに基づいて実測して決めた値（スクリプトでbounding boxを検出し、
 * その中の空白＝既存の葉が薄い箇所に新しい葉が乗るよう、目視で調整）。
 * xPercent/yPercentは、画像そのものを含む箱（aspect-[1205/1054]、
 * ChatScreen.tsxのLaunchTreeScreen参照）を基準にした%であり、画像の実際の
 * 縦横比と箱の縦横比が一致しているため、画像上の見た目の位置とズレない。
 *
 * 各stageの座標は完全に独立している（前stageの配置を引き継がない）。
 * 段階が進むほど配置数（＝上限枠）を増やし、「01は少なく、02は徐々に、
 * 03はかなり茂る」という密度の違いを表現する。
 *
 * 実機（375×812のスマホ幅）で表示確認済み。追加調整が必要な場合はこの配列の
 * 数値だけを変更すればよい（他のロジックには影響しない）。
 */
export const LEAF_ANCHORS_BY_STAGE: Record<1 | 2 | 3, LeafAnchor[]> = {
  1: [
    { xPercent: 52, yPercent: 47, spriteId: "leaf-c", rotateDeg: 4, scale: 0.85 },
    { xPercent: 36, yPercent: 54, spriteId: "leaf-a", rotateDeg: -10, scale: 0.85 },
    { xPercent: 58, yPercent: 53, spriteId: "leaf-b", rotateDeg: 8, scale: 0.85, flip: true },
    { xPercent: 52, yPercent: 68, spriteId: "leaf-d", rotateDeg: -6, scale: 0.8, flip: true },
    { xPercent: 45, yPercent: 59, spriteId: "leaf-a", rotateDeg: 5, scale: 0.8 },
  ],
  2: [
    { xPercent: 48, yPercent: 39, spriteId: "leaf-b", rotateDeg: 0, scale: 0.9 },
    { xPercent: 37, yPercent: 50, spriteId: "leaf-a", rotateDeg: -9, scale: 0.85 },
    { xPercent: 59, yPercent: 48, spriteId: "leaf-c", rotateDeg: 8, scale: 0.85, flip: true },
    { xPercent: 33, yPercent: 59, spriteId: "leaf-d", rotateDeg: -7, scale: 0.85, flip: true },
    { xPercent: 64, yPercent: 58, spriteId: "leaf-b", rotateDeg: 6, scale: 0.85 },
    { xPercent: 42, yPercent: 68, spriteId: "leaf-c", rotateDeg: -4, scale: 0.8 },
    { xPercent: 55, yPercent: 66, spriteId: "leaf-a", rotateDeg: 5, scale: 0.8, flip: true },
  ],
  3: [
    { xPercent: 47, yPercent: 23, spriteId: "leaf-d", rotateDeg: 0, scale: 0.85 },
    { xPercent: 29, yPercent: 28, spriteId: "leaf-a", rotateDeg: -8, scale: 0.8 },
    { xPercent: 66, yPercent: 28, spriteId: "leaf-b", rotateDeg: 7, scale: 0.8, flip: true },
    { xPercent: 19, yPercent: 43, spriteId: "leaf-c", rotateDeg: -10, scale: 0.8 },
    { xPercent: 75, yPercent: 43, spriteId: "leaf-d", rotateDeg: 9, scale: 0.8, flip: true },
    { xPercent: 24, yPercent: 61, spriteId: "leaf-b", rotateDeg: -5, scale: 0.75 },
    { xPercent: 71, yPercent: 61, spriteId: "leaf-a", rotateDeg: 6, scale: 0.75, flip: true },
    { xPercent: 54, yPercent: 67, spriteId: "leaf-c", rotateDeg: -3, scale: 0.75 },
  ],
};

/**
 * stage 03の葉が「満タン」になる目安のMemory数（仮）。stage04への実際の遷移条件
 * （Link数、TREE_THRESHOLDS.stage04MinLinks）とは意図的に切り離している。
 * Link数がなかなか増えず03に長く留まるユーザーがいても、葉はここで静かに
 * 止まり続け、無限に増え続けることはない。
 */
const STAGE_03_LEAF_FULL_AT_MEMORIES = 40;

/**
 * memoryCountが[rangeStart, rangeEnd)のどこにいるかを、0〜anchorCountの
 * 整数段階に変換する（下限未満は0、上限以上はanchorCountで頭打ち）。
 */
function leafCountFromRange(memoryCount: number, rangeStart: number, rangeEnd: number, anchorCount: number): number {
  if (anchorCount <= 0) return 0;
  if (memoryCount <= rangeStart) return 0;
  if (rangeEnd <= rangeStart) return anchorCount;
  const ratio = (memoryCount - rangeStart) / (rangeEnd - rangeStart);
  return Math.max(0, Math.min(anchorCount, Math.floor(ratio * anchorCount)));
}

/**
 * 現在のstageの中で、あといくつ葉を見せてよいか（0〜そのstageの配置数）を返す。
 * TreeSignals／computeTreeStageの契約は変更せず、その結果を材料として使うだけの
 * 独立した関数。stage 01〜03以外（0・4・5・6）は今回のスコープ外のため常に0を返す
 * （04以降の色付き葉・実は今回実装しない）。
 *
 * 01・02は、既存のTREE_THRESHOLDS（次stageへの実際の遷移しきい値）をそのまま
 * 「葉が満タンになる目安」としても再利用する（新しい定数を増やさない）。
 * 03だけは次stageへの遷移条件がMemory数ではなくLink数のため、専用の
 * STAGE_03_LEAF_FULL_AT_MEMORIESを別途持つ。
 */
export function computeLeafProgress(signals: TreeSignals, stage: TreeStage): number {
  if (stage === 1) {
    return leafCountFromRange(
      signals.memoryCount,
      TREE_THRESHOLDS.stage01MinMemories,
      TREE_THRESHOLDS.stage02MinMemories,
      LEAF_ANCHORS_BY_STAGE[1].length
    );
  }
  if (stage === 2) {
    return leafCountFromRange(
      signals.memoryCount,
      TREE_THRESHOLDS.stage02MinMemories,
      TREE_THRESHOLDS.stage03MinMemories,
      LEAF_ANCHORS_BY_STAGE[2].length
    );
  }
  if (stage === 3) {
    return leafCountFromRange(
      signals.memoryCount,
      TREE_THRESHOLDS.stage03MinMemories,
      STAGE_03_LEAF_FULL_AT_MEMORIES,
      LEAF_ANCHORS_BY_STAGE[3].length
    );
  }
  return 0;
}
