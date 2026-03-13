# ローカルでバッグ方法

## ローカル実行

以下のコマンドを使って、プログラムをローカルで実行します。

```bash
npm run debug
```

**注意**
VCRの環境が異なる場合は、`package.json`内にかかれているスクリプトの`--config-file`を適宜修正してください。

## ngrokで外部公開

ローカルでプログラムを実行したのち、ngrokで外部公開をします。

## FileMakerのカスタム関数の変更

- FileMaker でアプリを開きます。
- [ファイル]-[管理]-[カスタム関数]を開きます。
- 以下の内容を変更します。

|変数名|変更前|変更後|
|:---|:---|:---|
|cf_smsAPIKey|"28abca1c"|"[デバッグ用APIKey]"|
|cf_ sms_APISecret|"a7t446hoic0AEu9O"|"[デバッグ用APISecret]"|
|cf_callingURL|"https://neru-28abca1c-claris-call-center-dev.apse1.runtime.vonage.cloud/"|"[デバッグ用ngrok.url]/"

