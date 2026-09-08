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
 * 生成方法（v3：配置・向き・大きさを「枝から生えて見える」ことを目的に再設計。
 * 乱数は一切使っていない）：
 *
 * 1. 配置候補の抽出（v3で二段階に強化。「幹の上に葉が乗る」問題への直接対策）：
 *    実画像（1205×1054px）のアルファチャンネル＋輝度を解析し、
 *    (a) 候補点そのものの直近（半径0.9%）が幹・枝の線画（暗い色）に支配されている
 *        場合は除外する（＝葉の中心を幹・枝そのものの上に置かない）。
 *    (b) その上で、周囲（半径2.4%）に「葉らしい明るい画素（アルファ>80かつ輝度>140）」
 *        が3点以上ある場所だけを候補として採用する（＝既存の葉群のすぐそば、または
 *        枝先の葉が茂っている位置にしか置かれない。何も描かれていない余白にも
 *        置かれない）。
 * 2. 選出：候補群から「Farthest Point Sampling」で必要数（01:18／02:23／03:28）を選出し、
 *    木全体（外周〜内側）へ均等に配置する（座標そのものへの補正・吸着は行わない。
 *    実測で「枝へ寄せる」補正を試したところ、かえって幹寄りへ引っ張られて1で除外した
 *    はずの重なりが再発したため、v3ではこの吸着ステップを廃止した）。
 * 3. 向き（rotateDeg）：各点の周囲半径5%以内にある幹・枝の暗い画素についてPCA
 *    （主成分分析）を行い、その場所の枝が実際にどの角度を向いているか（＝枝の軸）を
 *    検出する。木の中心から見た放射方向（外向き）でこの180度の向きの曖昧さを解消し、
 *    「外向きの放射方向」と65:35でブレンドすることで、ノイズに強く、かつ「左の枝は
 *    左外側へ、右の枝は右外側へ、上部は上方向へ」という自然な流れになるようにしている。
 *    周囲に幹・枝の画素が十分見つからない場合（密な葉群の内部など）は、放射方向のみを
 *    使う。
 * 4. spriteId固有の「根元→先端」方向：leaf-a〜dそれぞれの実画像をPCA解析し、各素材が
 *    画像内でどちら向きに描かれているか（根元＝葉の幅が広い側、先端＝細く尖った側）を
 *    実測（leaf-a:-75.6°／leaf-b:-118.0°／leaf-c:-48.2°／leaf-d:-63.9°、
 *    0°=右向き・90°=下向きの座標系）。rotateDegは、上記3で求めた「その場所で葉が
 *    向くべき方向」に、この素材固有の向きを差し引くことで、常に葉の先端が正しい方向へ
 *    向くように機械的に計算している（見た目の勘や固定パターンでは決めていない）。
 * 5. flip：葉の先端の向きはrotateDegだけで360度どこへでも向けられるため、flipは
 *    「木の中心より左側か右側か」だけで機械的に決める（左側の点は`flip: true`）。
 *    これにより、素材が持つ左右非対称な曲がり（完全な左右対称の卵形ではない）が、
 *    木の左右それぞれの自然な向きに合わせて反転される。
 * 6. scale：0.55〜0.75の範囲（v2の0.72〜0.94より縮小）。既存の木本体に描かれている
 *   1枚1枚の葉より追加葉が明らかに大きく見えないよう、全体的に小さくした上で、
 *   配列インデックスから決まる固定式でわずかな大小差を付けている（規則的に同じ
 *   大きさが並んで見えないようにするため。極端な大小差は付けていない）。
 * 7. 出現順（配列順）：各点を「上/中/下」×「左/右」×「外周/内側」で分類し、
 *   上→中→下の各段で外周→内側、左→右を交互に一巡させる固定した巡回順で
 *   並べている（ランダムではない）。これにより、Memoryが増えるにつれて左右どちらかに
 *   偏らず、木全体が少しずつ均等に茂っていくように見える。
 *
 * 実機（375×812のスマホ幅／1440×900のデスクトップ幅）で、各Stageの序盤・中盤・終盤
 * の見た目を確認済み。追加調整が必要な場合はこの配列の数値だけを変更すればよい
 * （他のロジックには影響しない）。
 */
export const LEAF_ANCHORS_BY_STAGE: Record<1 | 2 | 3, LeafAnchor[]> = {
  1: [
    { xPercent: 37.4, yPercent: 55.9, spriteId: "leaf-c", rotateDeg: -3, scale: 0.55, flip: true },
    { xPercent: 61.4, yPercent: 62.3, spriteId: "leaf-a", rotateDeg: 57, scale: 0.66 },
    { xPercent: 46.2, yPercent: 58.3, spriteId: "leaf-b", rotateDeg: -34, scale: 0.56, flip: true },
    { xPercent: 53.4, yPercent: 59.9, spriteId: "leaf-d", rotateDeg: -44, scale: 0.67 },
    { xPercent: 36.6, yPercent: 68.7, spriteId: "leaf-c", rotateDeg: -54, scale: 0.57, flip: true },
    { xPercent: 43.8, yPercent: 68.7, spriteId: "leaf-a", rotateDeg: -46, scale: 0.68, flip: true },
    { xPercent: 50.2, yPercent: 66.3, spriteId: "leaf-b", rotateDeg: 47, scale: 0.58 },
    { xPercent: 56.6, yPercent: 79.1, spriteId: "leaf-d", rotateDeg: 121, scale: 0.69 },
    { xPercent: 45.4, yPercent: 75.9, spriteId: "leaf-c", rotateDeg: -132, scale: 0.59, flip: true },
    { xPercent: 49.4, yPercent: 79.9, spriteId: "leaf-a", rotateDeg: 166, scale: 0.7 },
    { xPercent: 41.4, yPercent: 47.9, spriteId: "leaf-b", rotateDeg: -49, scale: 0.6, flip: true },
    { xPercent: 57.4, yPercent: 53.5, spriteId: "leaf-d", rotateDeg: 5, scale: 0.71 },
    { xPercent: 40.6, yPercent: 62.3, spriteId: "leaf-c", rotateDeg: -18, scale: 0.61, flip: true },
    { xPercent: 51.0, yPercent: 54.3, spriteId: "leaf-a", rotateDeg: -1, scale: 0.72 },
    { xPercent: 57.4, yPercent: 69.5, spriteId: "leaf-b", rotateDeg: 132, scale: 0.62 },
    { xPercent: 39.0, yPercent: 74.3, spriteId: "leaf-d", rotateDeg: -99, scale: 0.73, flip: true },
    { xPercent: 33.4, yPercent: 61.5, spriteId: "leaf-c", rotateDeg: -27, scale: 0.63, flip: true },
    { xPercent: 44.6, yPercent: 52.7, spriteId: "leaf-a", rotateDeg: 9, scale: 0.74, flip: true },
  ],
  2: [
    { xPercent: 28.4, yPercent: 42.6, spriteId: "leaf-c", rotateDeg: -10, scale: 0.55, flip: true },
    { xPercent: 69.2, yPercent: 51.4, spriteId: "leaf-a", rotateDeg: 23, scale: 0.66 },
    { xPercent: 40.4, yPercent: 46.6, spriteId: "leaf-b", rotateDeg: -27, scale: 0.56, flip: true },
    { xPercent: 54.8, yPercent: 46.6, spriteId: "leaf-d", rotateDeg: -5, scale: 0.67 },
    { xPercent: 67.6, yPercent: 58.6, spriteId: "leaf-c", rotateDeg: 43, scale: 0.57 },
    { xPercent: 48.4, yPercent: 57.0, spriteId: "leaf-a", rotateDeg: -24, scale: 0.68, flip: true },
    { xPercent: 54.8, yPercent: 61.0, spriteId: "leaf-b", rotateDeg: 156, scale: 0.58 },
    { xPercent: 28.4, yPercent: 64.2, spriteId: "leaf-d", rotateDeg: -79, scale: 0.69, flip: true },
    { xPercent: 60.4, yPercent: 77.0, spriteId: "leaf-c", rotateDeg: 106, scale: 0.59 },
    { xPercent: 42.0, yPercent: 70.6, spriteId: "leaf-a", rotateDeg: -93, scale: 0.7, flip: true },
    { xPercent: 62.0, yPercent: 63.4, spriteId: "leaf-b", rotateDeg: 135, scale: 0.6 },
    { xPercent: 37.2, yPercent: 35.4, spriteId: "leaf-d", rotateDeg: -1, scale: 0.71, flip: true },
    { xPercent: 63.6, yPercent: 37.8, spriteId: "leaf-c", rotateDeg: 47, scale: 0.61 },
    { xPercent: 47.6, yPercent: 43.4, spriteId: "leaf-a", rotateDeg: 30, scale: 0.72, flip: true },
    { xPercent: 59.6, yPercent: 54.6, spriteId: "leaf-b", rotateDeg: 50, scale: 0.62 },
    { xPercent: 37.2, yPercent: 57.8, spriteId: "leaf-d", rotateDeg: -53, scale: 0.73, flip: true },
    { xPercent: 35.6, yPercent: 66.6, spriteId: "leaf-c", rotateDeg: -122, scale: 0.63, flip: true },
    { xPercent: 45.2, yPercent: 63.4, spriteId: "leaf-a", rotateDeg: -127, scale: 0.74, flip: true },
    { xPercent: 53.2, yPercent: 68.2, spriteId: "leaf-b", rotateDeg: -128, scale: 0.64 },
    { xPercent: 28.4, yPercent: 53.0, spriteId: "leaf-d", rotateDeg: -17, scale: 0.75, flip: true },
    { xPercent: 57.2, yPercent: 32.2, spriteId: "leaf-c", rotateDeg: -34, scale: 0.65 },
    { xPercent: 62.8, yPercent: 45.8, spriteId: "leaf-a", rotateDeg: 54, scale: 0.55 },
    { xPercent: 55.6, yPercent: 39.4, spriteId: "leaf-b", rotateDeg: 24, scale: 0.66 },
  ],
  3: [
    { xPercent: 23.4, yPercent: 32.0, spriteId: "leaf-c", rotateDeg: -3, scale: 0.55, flip: true },
    { xPercent: 69.8, yPercent: 33.6, spriteId: "leaf-a", rotateDeg: 32, scale: 0.66 },
    { xPercent: 37.0, yPercent: 42.4, spriteId: "leaf-b", rotateDeg: -108, scale: 0.56, flip: true },
    { xPercent: 56.2, yPercent: 42.4, spriteId: "leaf-d", rotateDeg: 5, scale: 0.67 },
    { xPercent: 18.6, yPercent: 54.4, spriteId: "leaf-c", rotateDeg: -47, scale: 0.57, flip: true },
    { xPercent: 74.6, yPercent: 56.8, spriteId: "leaf-a", rotateDeg: 30, scale: 0.68 },
    { xPercent: 33.0, yPercent: 56.8, spriteId: "leaf-b", rotateDeg: -110, scale: 0.58, flip: true },
    { xPercent: 47.4, yPercent: 56.0, spriteId: "leaf-d", rotateDeg: 91, scale: 0.69 },
    { xPercent: 44.2, yPercent: 82.4, spriteId: "leaf-c", rotateDeg: -134, scale: 0.59, flip: true },
    { xPercent: 65.0, yPercent: 76.8, spriteId: "leaf-a", rotateDeg: 125, scale: 0.7 },
    { xPercent: 41.0, yPercent: 68.0, spriteId: "leaf-b", rotateDeg: 119, scale: 0.6, flip: true },
    { xPercent: 61.0, yPercent: 62.4, spriteId: "leaf-d", rotateDeg: 110, scale: 0.71 },
    { xPercent: 33.8, yPercent: 24.0, spriteId: "leaf-c", rotateDeg: 15, scale: 0.61, flip: true },
    { xPercent: 59.4, yPercent: 24.0, spriteId: "leaf-a", rotateDeg: 8, scale: 0.72 },
    { xPercent: 46.6, yPercent: 38.4, spriteId: "leaf-b", rotateDeg: 10, scale: 0.62, flip: true },
    { xPercent: 48.2, yPercent: 47.2, spriteId: "leaf-d", rotateDeg: -15, scale: 0.73 },
    { xPercent: 57.0, yPercent: 52.8, spriteId: "leaf-c", rotateDeg: 19, scale: 0.63 },
    { xPercent: 28.2, yPercent: 71.2, spriteId: "leaf-a", rotateDeg: -163, scale: 0.74, flip: true },
    { xPercent: 73.0, yPercent: 68.8, spriteId: "leaf-b", rotateDeg: 110, scale: 0.64 },
    { xPercent: 53.0, yPercent: 70.4, spriteId: "leaf-d", rotateDeg: 180, scale: 0.75 },
    { xPercent: 25.0, yPercent: 44.0, spriteId: "leaf-c", rotateDeg: -23, scale: 0.65, flip: true },
    { xPercent: 68.2, yPercent: 46.4, spriteId: "leaf-a", rotateDeg: -6, scale: 0.55 },
    { xPercent: 40.2, yPercent: 50.4, spriteId: "leaf-b", rotateDeg: -76, scale: 0.66, flip: true },
    { xPercent: 65.8, yPercent: 55.2, spriteId: "leaf-d", rotateDeg: 99, scale: 0.56 },
    { xPercent: 21.0, yPercent: 64.0, spriteId: "leaf-c", rotateDeg: -70, scale: 0.67, flip: true },
    { xPercent: 33.0, yPercent: 33.6, spriteId: "leaf-a", rotateDeg: -13, scale: 0.57, flip: true },
    { xPercent: 55.4, yPercent: 32.8, spriteId: "leaf-b", rotateDeg: 68, scale: 0.68 },
    { xPercent: 33.0, yPercent: 78.4, spriteId: "leaf-d", rotateDeg: -121, scale: 0.58, flip: true },
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
