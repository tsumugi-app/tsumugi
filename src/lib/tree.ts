/**
 * 「つむぎの木」の成長段階を判定するロジック（Beta実装・v2）。
 *
 * 添付されたデザイン（01 芽生え／02 育つ／03 葉が茂る／04 色づく／05 実がなる／
 * 06 脳の形へ、の6段階）を仕様として扱う。このファイルはその段階を「今、どこまで
 * 満たしているか」を判定するだけの、副作用の無い純粋関数群であり、Memory schema・
 * Capture・Connect・Vault・IndexedDBのいずれにも変更を加えない（新しいDB構造も無い）。
 *
 * 設計思想（v2で明文化）：
 * つむぎの木は「レベル表示」ではない。長期間Tsumugiを使い続けることで、自分の記憶・
 * つながり・気づきが少しずつ育っていくのを感じるためのビジュアルであり、完成（06）を
 * 急がせない。そのため大きなStage変化そのものはゆっくりにし（v1比で大幅に緩やかな
 * Memory数へ変更）、その代わりStageの途中でも葉が少しずつ増える／色づくことで、
 * 「毎回開くたびに何かが動いている」という小さな手応えを絶やさない設計にしている。
 *
 * 設計方針（Memory件数だけに密結合させない）：
 * 「木の成長段階を決める関数」（computeTreeStage）は、生のMemoryObject配列を直接見る
 * のではなく、抽象化された`TreeSignals`（記憶の量・つながりの量・気づきの有無）だけを
 * 受け取る。「MemoryObject配列からTreeSignalsを作る関数」（computeTreeSignals）を別に
 * 分離しておくことで、将来「過去の記憶が更新された回数」のような新しい信号を追加したく
 * なった場合も、computeTreeStage自体（しきい値判定のロジック）を書き換えずに、
 * TreeSignalsの生成側だけを差し替えられるようにする。
 *
 * 成長条件（v2）：
 *   Stage 01〜06のどこにいるかは、Memory数の範囲だけで決める（下記TREE_THRESHOLDS参照）。
 *   Link／Insightは今回、Stageの遷移条件には使わない（無理に複雑なスコアリングを
 *   作らず、まずはMemoryによる長期成長を基本軸として安定させる方針のため）。
 *   ただし将来「Link＝色づく」「Insight＝実がなる」というStage内の細かな成長表現に
 *   使えるよう、TreeSignals自体からはlinkCount／insightCountを削除しない
 *   （computeTreeSignalsは引き続き両方を計算する。詳細は下記TreeSignalsの説明を参照）。
 */

import type { MemoryObject } from "./types";

/** 0＝まだ最初のMemoryも無い状態（01より前）。1〜6が添付デザインの01〜06に対応する。 */
export type TreeStage = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/**
 * 木の成長判定に使う、抽象化された信号。
 * - memoryCount：Memoryの総数。v2では、Stageそのものを決める唯一の材料として使う
 *   （下記computeTreeStage参照）。UIには数字として一切表示しない。
 * - linkCount：Connectで生成されたLinkの総数（重複無し）。Linkは生成時、source側・
 *   target側それぞれのMemoryObject.linksへ同じLink（同じid）が複製されるため
 *   （src/lib/connect.ts参照）、Link.idで重複排除してから数える。
 *   v2時点ではStage判定にもStage内の葉の増加にも使っていないが、将来
 *   「Link＝色づく」というStage04以降の細かな成長表現に使える構造として維持する。
 * - insightCount：type:"insight"を持つMemoryObjectの数（Reflectionが生成したInsight）。
 *   linkCountと同様、v2時点では未使用。将来「Insight＝実がなる」というStage05の
 *   細かな成長表現に使える構造として維持する。
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
 * 各段階のしきい値（v2：長期成長版）。
 *
 * v1（Memory 1/5/20 ＋ Link/Insight複合条件）は、実際に動かしてみると成長が速すぎた
 * ため廃止し、Memory数の範囲だけによる、大幅に緩やかな暫定基準へ置き換えた。
 * 「長期間使い続けることで少しずつ育つ」という設計思想（ファイル冒頭コメント参照）を
 * 優先し、Stageそのものの遷移は意図的に単純なMemory数の階段にとどめている
 * （Link/Insightによる複合条件は今回付けない。将来Stage内の細かな成長表現＝
 * computeLeafColorProgress等で使う想定。下記参照）。
 *
 * 実際の利用データに基づく調整ではなく、依然として暫定値。この定数だけを
 * 変更すれば全Stageの遷移点を調整できる（computeTreeStage自体は書き換え不要）。
 */
export const TREE_THRESHOLDS = {
  /** 01 芽生え：最初のMemory。 */
  stage01MinMemories: 1,
  /** 02 育つ。 */
  stage02MinMemories: 100,
  /** 03 葉が茂る。 */
  stage03MinMemories: 300,
  /** 04 色づく。 */
  stage04MinMemories: 700,
  /** 05 実がなる。 */
  stage05MinMemories: 1200,
  /** 06 脳の形へ。 */
  stage06MinMemories: 2000,
} as const;

/**
 * Stageの判定：Memory数がどの範囲に入っているかだけを見る、単純な階段状の判定
 * （v1のような「前段階の条件を満たした上での累積」という複合ロジックは今回廃止）。
 * linkCount／insightCountはここでは参照しない（TreeSignals自体には残す。理由は
 * ファイル冒頭・TreeSignalsの説明を参照）。
 */
export function computeTreeStage(signals: TreeSignals): TreeStage {
  const { memoryCount } = signals;

  if (memoryCount < TREE_THRESHOLDS.stage01MinMemories) return 0;
  if (memoryCount < TREE_THRESHOLDS.stage02MinMemories) return 1;
  if (memoryCount < TREE_THRESHOLDS.stage03MinMemories) return 2;
  if (memoryCount < TREE_THRESHOLDS.stage04MinMemories) return 3;
  if (memoryCount < TREE_THRESHOLDS.stage05MinMemories) return 4;
  if (memoryCount < TREE_THRESHOLDS.stage06MinMemories) return 5;
  return 6;
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
 * 段階内リーフ成長（stage 01〜03）
 *
 * 「6段階の完成イラストを切り替えるだけ」ではなく、Memoryが増えるたびに、その段階の
 * ベース画像の上へ、あらかじめ決めた位置へ葉を1枚ずつ静かに増やしていく。
 * computeTreeSignals()／computeTreeStage()の契約は変更しない（TreeSignalsに
 * leafCountのようなフィールドは追加しない）。ここに置く関数群は、既存の2関数の
 * 「外側」に独立して追加するだけで、既存の判定ロジックには一切触れない。
 *
 * v2では、大きなStage変化そのものを長期化した代わりに、Stageの途中で「気づいたら
 * 少し葉が増えている」という小さな手応えを絶やさない役割をこの仕組みが担う
 * （設計思想はファイル冒頭コメント参照）。01〜02の追加葉はモノトーンのまま、
 * 03の追加葉だけがStage内の進捗に応じてゆっくり色づく（computeLeafColorProgress
 * 参照）。04（完成イラスト自体が色づいた木）・05（実）・06（追加要素なし、最終形
 * として静止）は今回のスコープ外。
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
 * 03はかなり茂る」という密度の違いを表現する（01:18箇所、02:23箇所、03:28箇所）。
 *
 * 生成方法（v2で密度を大幅増加した際に採用。乱数は一切使っていない）：
 * 納品された実画像（1205×1054px）のアルファチャンネル＋輝度を解析し、各候補点の
 * 半径3%圏内に「葉らしい明るい画素（アルファ>80かつ輝度>140、＝暗い幹・枝の線画では
 * ない）」が2点以上存在する場所だけを配置候補として採用（＝既存の葉群のすぐそば、
 * または枝先の葉が茂っている位置にしか置かれない。何も描かれていない余白や、幹だけが
 * 見えている場所には置かれない）。そこから、既に選ばれた点との最小距離が最大になる点を
 * 順に選ぶ「Farthest Point Sampling」で必要数を選出（中心・外周・内側の隙間へ均等に
 * 埋まっていき、1箇所に固まったり隣同士が重なったりしない。選出順＝配列の並び順＝葉が
 * 増えていく表示順のため、Memoryが増えるにつれて木の外周から内側まで均等に埋まっていく
 * ように見える）。回転・スケール・spriteId・flipは配列内インデックスから決まる固定式
 * （`((i*37)%41)-20`等）で機械的に割り当てており、実行時の乱数要素は無い
 * （同じインデックス＝同じ見た目が常に再現される）。
 *
 * 実機（375×812のスマホ幅／1440×900のデスクトップ幅）で表示確認済み。追加調整が
 * 必要な場合はこの配列の数値だけを変更すればよい（他のロジックには影響しない）。
 */
export const LEAF_ANCHORS_BY_STAGE: Record<1 | 2 | 3, LeafAnchor[]> = {
  1: [
    { xPercent: 57.8, yPercent: 78.7, spriteId: "leaf-c", rotateDeg: -20, scale: 0.72, flip: true },
    { xPercent: 36.2, yPercent: 66.7, spriteId: "leaf-a", rotateDeg: 17, scale: 0.85 },
    { xPercent: 60.2, yPercent: 60.7, spriteId: "leaf-b", rotateDeg: 13, scale: 0.75 },
    { xPercent: 47.0, yPercent: 59.5, spriteId: "leaf-d", rotateDeg: 9, scale: 0.88, flip: true },
    { xPercent: 47.0, yPercent: 72.7, spriteId: "leaf-c", rotateDeg: 5, scale: 0.78 },
    { xPercent: 37.4, yPercent: 55.9, spriteId: "leaf-a", rotateDeg: 1, scale: 0.91 },
    { xPercent: 55.4, yPercent: 69.1, spriteId: "leaf-b", rotateDeg: -3, scale: 0.81, flip: true },
    { xPercent: 56.6, yPercent: 52.3, spriteId: "leaf-d", rotateDeg: -7, scale: 0.94 },
    { xPercent: 41.0, yPercent: 48.7, spriteId: "leaf-c", rotateDeg: -11, scale: 0.84 },
    { xPercent: 49.4, yPercent: 79.9, spriteId: "leaf-a", rotateDeg: -15, scale: 0.74, flip: true },
    { xPercent: 39.8, yPercent: 73.9, spriteId: "leaf-b", rotateDeg: -19, scale: 0.87 },
    { xPercent: 43.4, yPercent: 65.5, spriteId: "leaf-d", rotateDeg: 18, scale: 0.77 },
    { xPercent: 49.4, yPercent: 53.5, spriteId: "leaf-c", rotateDeg: 14, scale: 0.9, flip: true },
    { xPercent: 53.0, yPercent: 61.9, spriteId: "leaf-a", rotateDeg: 10, scale: 0.8 },
    { xPercent: 33.8, yPercent: 60.7, spriteId: "leaf-b", rotateDeg: 6, scale: 0.93 },
    { xPercent: 43.4, yPercent: 54.7, spriteId: "leaf-d", rotateDeg: 2, scale: 0.83, flip: true },
    { xPercent: 53.0, yPercent: 75.1, spriteId: "leaf-c", rotateDeg: -2, scale: 0.73 },
    { xPercent: 39.8, yPercent: 60.7, spriteId: "leaf-a", rotateDeg: -6, scale: 0.86 },
  ],
  2: [
    { xPercent: 47.6, yPercent: 79.0, spriteId: "leaf-c", rotateDeg: -20, scale: 0.72, flip: true },
    { xPercent: 69.2, yPercent: 56.2, spriteId: "leaf-a", rotateDeg: 17, scale: 0.85 },
    { xPercent: 28.4, yPercent: 55.0, spriteId: "leaf-b", rotateDeg: 13, scale: 0.75 },
    { xPercent: 48.8, yPercent: 53.8, spriteId: "leaf-d", rotateDeg: 9, scale: 0.88, flip: true },
    { xPercent: 69.2, yPercent: 38.2, spriteId: "leaf-c", rotateDeg: 5, scale: 0.78 },
    { xPercent: 63.2, yPercent: 73.0, spriteId: "leaf-a", rotateDeg: 1, scale: 0.91 },
    { xPercent: 33.2, yPercent: 38.2, spriteId: "leaf-b", rotateDeg: -3, scale: 0.81, flip: true },
    { xPercent: 35.6, yPercent: 69.4, spriteId: "leaf-d", rotateDeg: -7, scale: 0.94 },
    { xPercent: 57.2, yPercent: 43.0, spriteId: "leaf-c", rotateDeg: -11, scale: 0.84 },
    { xPercent: 51.2, yPercent: 67.0, spriteId: "leaf-a", rotateDeg: -15, scale: 0.74, flip: true },
    { xPercent: 39.2, yPercent: 47.8, spriteId: "leaf-b", rotateDeg: -19, scale: 0.87 },
    { xPercent: 39.2, yPercent: 58.6, spriteId: "leaf-d", rotateDeg: 18, scale: 0.77 },
    { xPercent: 58.4, yPercent: 58.6, spriteId: "leaf-c", rotateDeg: 14, scale: 0.9, flip: true },
    { xPercent: 60.8, yPercent: 33.4, spriteId: "leaf-a", rotateDeg: 10, scale: 0.8 },
    { xPercent: 47.6, yPercent: 43.0, spriteId: "leaf-b", rotateDeg: 6, scale: 0.93 },
    { xPercent: 65.6, yPercent: 47.8, spriteId: "leaf-d", rotateDeg: 2, scale: 0.83, flip: true },
    { xPercent: 65.6, yPercent: 64.6, spriteId: "leaf-c", rotateDeg: -2, scale: 0.73 },
    { xPercent: 28.4, yPercent: 45.4, spriteId: "leaf-a", rotateDeg: -6, scale: 0.86 },
    { xPercent: 40.4, yPercent: 32.2, spriteId: "leaf-b", rotateDeg: -10, scale: 0.76, flip: true },
    { xPercent: 29.6, yPercent: 63.4, spriteId: "leaf-d", rotateDeg: -14, scale: 0.89 },
    { xPercent: 42.8, yPercent: 65.8, spriteId: "leaf-c", rotateDeg: -18, scale: 0.79 },
    { xPercent: 56.0, yPercent: 51.4, spriteId: "leaf-a", rotateDeg: 19, scale: 0.92, flip: true },
    { xPercent: 40.4, yPercent: 40.6, spriteId: "leaf-b", rotateDeg: 15, scale: 0.82 },
  ],
  3: [
    { xPercent: 63.0, yPercent: 79.2, spriteId: "leaf-c", rotateDeg: -20, scale: 0.72, flip: true },
    { xPercent: 18.6, yPercent: 62.4, spriteId: "leaf-a", rotateDeg: 17, scale: 0.85 },
    { xPercent: 73.8, yPercent: 45.6, spriteId: "leaf-b", rotateDeg: 13, scale: 0.75 },
    { xPercent: 46.2, yPercent: 54.0, spriteId: "leaf-d", rotateDeg: 9, scale: 0.88, flip: true },
    { xPercent: 18.6, yPercent: 33.6, spriteId: "leaf-c", rotateDeg: 5, scale: 0.78 },
    { xPercent: 67.8, yPercent: 25.2, spriteId: "leaf-a", rotateDeg: 1, scale: 0.91 },
    { xPercent: 37.8, yPercent: 73.2, spriteId: "leaf-b", rotateDeg: -3, scale: 0.81, flip: true },
    { xPercent: 72.6, yPercent: 63.6, spriteId: "leaf-d", rotateDeg: -7, scale: 0.94 },
    { xPercent: 57.0, yPercent: 39.6, spriteId: "leaf-c", rotateDeg: -11, scale: 0.84 },
    { xPercent: 29.4, yPercent: 48.0, spriteId: "leaf-a", rotateDeg: -15, scale: 0.74, flip: true },
    { xPercent: 41.4, yPercent: 38.4, spriteId: "leaf-b", rotateDeg: -19, scale: 0.87 },
    { xPercent: 31.8, yPercent: 26.4, spriteId: "leaf-d", rotateDeg: 18, scale: 0.77 },
    { xPercent: 54.6, yPercent: 67.2, spriteId: "leaf-c", rotateDeg: 14, scale: 0.9, flip: true },
    { xPercent: 61.8, yPercent: 54.0, spriteId: "leaf-a", rotateDeg: 10, scale: 0.8 },
    { xPercent: 31.8, yPercent: 61.2, spriteId: "leaf-b", rotateDeg: 6, scale: 0.93 },
    { xPercent: 47.4, yPercent: 80.4, spriteId: "leaf-d", rotateDeg: 2, scale: 0.83, flip: true },
    { xPercent: 18.6, yPercent: 45.6, spriteId: "leaf-c", rotateDeg: -2, scale: 0.73 },
    { xPercent: 57.0, yPercent: 27.6, spriteId: "leaf-a", rotateDeg: -6, scale: 0.86 },
    { xPercent: 30.6, yPercent: 37.2, spriteId: "leaf-b", rotateDeg: -10, scale: 0.76, flip: true },
    { xPercent: 73.8, yPercent: 34.8, spriteId: "leaf-d", rotateDeg: -14, scale: 0.89 },
    { xPercent: 25.8, yPercent: 69.6, spriteId: "leaf-c", rotateDeg: -18, scale: 0.79 },
    { xPercent: 64.2, yPercent: 69.6, spriteId: "leaf-a", rotateDeg: 19, scale: 0.92, flip: true },
    { xPercent: 41.4, yPercent: 62.4, spriteId: "leaf-b", rotateDeg: 15, scale: 0.82 },
    { xPercent: 39.0, yPercent: 48.0, spriteId: "leaf-d", rotateDeg: 11, scale: 0.72 },
    { xPercent: 48.6, yPercent: 44.4, spriteId: "leaf-c", rotateDeg: 7, scale: 0.85, flip: true },
    { xPercent: 49.8, yPercent: 33.6, spriteId: "leaf-a", rotateDeg: 3, scale: 0.75 },
    { xPercent: 22.2, yPercent: 54.0, spriteId: "leaf-b", rotateDeg: -1, scale: 0.88 },
    { xPercent: 29.4, yPercent: 78.0, spriteId: "leaf-d", rotateDeg: -5, scale: 0.78, flip: true },
  ],
};

/**
 * memoryCountが、そのStageの中でどこまで進んでいるかを0〜1の比率に変換する。
 *
 * rangeEndは「次のStageへ遷移するしきい値」（例：Stage01なら
 * TREE_THRESHOLDS.stage02MinMemories＝100）であり、そのStageに実際に存在する
 * 最後のMemory数は`rangeEnd - 1`（例：99）。そのStageのビジュアル（葉の枚数・
 * 色づき）は「次Stageへ切り替わる直前（rangeEnd - 1）」で完成していてほしいため、
 * 進捗の分母は`rangeEnd - rangeStart`ではなく`(rangeEnd - 1) - rangeStart`を使う
 * （そうしないと、Stage内で一度も進捗1.0＝満タンに到達しないまま次Stageへ切り替わって
 * しまう。leafCountFromRange／computeLeafColorProgressの両方が、この同じ
 * 「進捗の測り方」を共有する）。
 */
function progressFromRange(memoryCount: number, rangeStart: number, rangeEnd: number): number {
  const lastMemoryInStage = rangeEnd - 1;
  if (memoryCount <= rangeStart) return 0;
  if (lastMemoryInStage <= rangeStart) return 1;
  const ratio = (memoryCount - rangeStart) / (lastMemoryInStage - rangeStart);
  return Math.max(0, Math.min(1, ratio));
}

/**
 * 0〜1の進捗を、0〜anchorCountの整数段階（＝実際に表示してよい葉の枚数）に変換する。
 */
function leafCountFromProgress(progress: number, anchorCount: number): number {
  if (anchorCount <= 0) return 0;
  return Math.max(0, Math.min(anchorCount, Math.floor(progress * anchorCount)));
}

/**
 * 現在のstageの中で、あといくつ葉を見せてよいか（0〜そのstageの配置数）を返す。
 * TreeSignals／computeTreeStageの契約は変更せず、その結果を材料として使うだけの
 * 独立した関数。stage 01〜03以外（0・4・5・6）は今回のスコープ外のため常に0を返す
 * （04以降の色付き葉・実は今回実装しない）。
 *
 * 01・02・03いずれも、そのStageの開始しきい値から次Stageへの遷移しきい値までを
 * そのまま「葉が増えていく範囲」として再利用する（新しい独立した定数は増やさない。
 * v1では03だけ次Stageの遷移条件がLink数だったため専用の定数が必要だったが、v2は
 * 全Stage共通でMemory数の階段になったため、この単純な再利用が可能になった）。
 * progressFromRangeの仕様により、そのStage最後のMemory数（次Stageへの遷移しきい値
 * −1）でちょうど満タン（配置数と同じ枚数）になる。
 */
export function computeLeafProgress(signals: TreeSignals, stage: TreeStage): number {
  if (stage === 1) {
    const progress = progressFromRange(signals.memoryCount, TREE_THRESHOLDS.stage01MinMemories, TREE_THRESHOLDS.stage02MinMemories);
    return leafCountFromProgress(progress, LEAF_ANCHORS_BY_STAGE[1].length);
  }
  if (stage === 2) {
    const progress = progressFromRange(signals.memoryCount, TREE_THRESHOLDS.stage02MinMemories, TREE_THRESHOLDS.stage03MinMemories);
    return leafCountFromProgress(progress, LEAF_ANCHORS_BY_STAGE[2].length);
  }
  if (stage === 3) {
    const progress = progressFromRange(signals.memoryCount, TREE_THRESHOLDS.stage03MinMemories, TREE_THRESHOLDS.stage04MinMemories);
    return leafCountFromProgress(progress, LEAF_ANCHORS_BY_STAGE[3].length);
  }
  return 0;
}

/**
 * Stage内で「追加葉がどれだけ色づいているか」を0（完全にモノトーン）〜1（葉素材
 * 本来のフルカラー）で返す。LaunchTreeScreen側はこれを`grayscale(${(1-progress)*100}%)`
 * のようなCSS filterへ変換し、葉<img>にだけ適用する（木の完成イラスト本体には
 * 適用しない。新しい画像素材は作らない、という制約への対応）。
 *
 * - Stage 01・02：常に0（モノトーンのまま。色づきはまだ始めない）。
 * - Stage 03：Stage内の進捗（03の開始〜04への遷移までの間のどこにいるか）に比例して
 *   0→1へ線形に戻す。progressFromRangeの仕様により、Memory 300でちょうど0
 *   （完全にモノトーン）、Memory 699（04へ切り替わる直前＝03最後のMemory数）で
 *   ちょうど1（フルカラー）になる。途中で急に色づく瞬間が無いようにするため、
 *   あえて単純な線形補間のみを使う（閾値のように見える段差を作らない）。
 * - Stage 0・4・5・6：computeLeafProgressと同様、今回のスコープ外のため0を返す
 *   （04は完成イラスト自体が既に色づいているため、この関数を使う必要が無い）。
 */
export function computeLeafColorProgress(signals: TreeSignals, stage: TreeStage): number {
  if (stage === 3) {
    return progressFromRange(signals.memoryCount, TREE_THRESHOLDS.stage03MinMemories, TREE_THRESHOLDS.stage04MinMemories);
  }
  return 0;
}
