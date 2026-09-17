import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Tsumugi",
  description: "話すたびに、人生がつながる。Personal Memory OS.",
  manifest: "/manifest.webmanifest",
  // iOS/iPadOS Safariのホーム画面追加をstandalone表示にするための最小限の設定。
  // Next.js（このバージョン）のappleWebAppは`mobile-web-app-capable`のみを出力し、
  // Safariが実際に見る`apple-mobile-web-app-capable`（apple-プレフィックス付き）は
  // 出力しないため、`other`で明示的に追加する（iOS対応を壊さないための最小限の補完）。
  appleWebApp: {
    capable: true,
    title: "Tsumugi",
  },
  other: {
    "apple-mobile-web-app-capable": "yes",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="ja"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col font-sans">{children}</body>
    </html>
  );
}
