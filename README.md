# Tsumugi Beta

Tsumugiは、AIとの会話を通じて、自分の記憶・考え・気づきをつないでいくためのローカルファーストなAI会話アプリです。

## セットアップ

```bash
npm install
npm run dev
```

その後、[http://localhost:3000](http://localhost:3000) をブラウザで開いてください。

## API Key

Tsumugiを使うには、あなた自身のAPIキーが必要です。現在のBetaでは以下のプロバイダを利用できます。

- Gemini
- OpenAI

APIキーはアプリ起動後の画面から入力します。ブラウザ（お使いの端末）にのみ保存され、Tsumugiのサーバーには送信・保存されません。

## Memory / Vault

**TsumugiのMemory / Vaultデータは、このGitリポジトリには含まれません。**

Vaultは、あなた自身のPC上の任意のフォルダを選択して接続する方式です。Tsumugiはあなた自身の記憶データをGitリポジトリに同梱しません。これは、記憶はあなた自身のものであるべきだという思想に基づいています。
