import type { MetadataRoute } from "next";

/**
 * Next.js App Router標準のファイル規約（このファイル自体がSpecial Route Handlerとして
 * `/manifest.webmanifest`を生成する）。既存のlayout.tsxのmetadata（title/description）と
 * 矛盾しないよう、descriptionは同じ文言を使う。
 *
 * Service Workerはここでは追加しない（別タスク）。Chromeは現在、メニューからの
 * 手動インストールについてはService Worker無しでもManifest＋HTTPSのみで許可する
 * （Chrome 108/モバイル・112/デスクトップ以降。自動のインストールバナー＝
 * beforeinstallpromptは現時点でもfetchハンドラを持つService Workerを条件にしている）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Tsumugi",
    short_name: "Tsumugi",
    description: "話すたびに、人生がつながる。Personal Memory OS.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
  };
}
