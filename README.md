# 指導せんナビ

薬剤師本人1人が、調剤・投薬時に患者への服薬指導資料(指導せん)を素早く見つけるための個人用Webアプリ。
Firebase(Firestore)にデータを保存し、GitHub Pagesで静的サイトとして公開する構成。

- 認証:あなた自身のGoogleアカウントでのサインイン(Firebase Auth)。指定した1つのメールアドレスのみアクセス許可。
- データ:Firestore(drugs / resources / sites / paperFromHistory)
- ホスティング:GitHub Pages(GitHub Actionsで自動ビルド・デプロイ)
- 料金:Firestore無料枠(Sparkプラン)の範囲で運用できます。Cloud Storageは使用していないため、Blazeプランへの登録は不要です。

## セットアップ手順(初回のみ)

### 1. Firebaseプロジェクトを作成する

1. https://console.firebase.google.com/ を開き、Googleアカウント(`fs.23ys@gmail.com`)でログイン
2. 「プロジェクトを追加」→ プロジェクト名を入力(例:`shidousen-navi`)→ 作成
   - Google アナリティクスは不要なら無効のままでOK
3. 左メニュー「構築」→「Firestore Database」→「データベースを作成」
   - ロケーションは `asia-northeast1`(東京)を推奨
   - セキュリティルールは「本番環境モード」を選択(あとで本リポジトリの `firestore.rules` を反映します)
4. 左メニュー「構築」→「Authentication」→「始める」
   - 「Sign-in method」タブ →「Google」を選び、有効にする→保存
5. 左メニュー「プロジェクトの概要」の歯車アイコン →「プロジェクトの設定」→「全般」タブ
   - 「マイアプリ」→ Webアプリのアイコン(`</>`)をクリックしてアプリを登録(アプリ名は任意、Firebase Hostingは不要なのでチェックしなくてOK)
   - 表示された `firebaseConfig` の値(`apiKey` `authDomain` `projectId` `storageBucket` `messagingSenderId` `appId`)を控えておく

### 2. ローカルで動作確認する

```powershell
copy .env.example .env.local
```

`.env.local` を開き、手順1で控えた値を貼り付ける(`VITE_OWNER_EMAIL` は既定で `fs.23ys@gmail.com` になっています)。

```powershell
npm install
npm run dev
```

表示されたURLをブラウザで開き、「Googleでログイン」できることを確認してください。

### 3. Firestoreセキュリティルールを反映する

`firestore.rules` は「認証済みかつメールアドレスが本人のものである場合のみ読み書き許可」というルールになっています。反映するには:

```powershell
npm install -g firebase-tools   # 未導入の場合のみ
firebase login
```

`.firebaserc` の `REPLACE_WITH_YOUR_FIREBASE_PROJECT_ID` を、手順1で作成したFirebaseプロジェクトのプロジェクトID(プロジェクト設定の「全般」タブで確認できます)に書き換えてから:

```powershell
firebase deploy --only firestore:rules
```

### 4. GitHubリポジトリのSecretsを設定する

GitHubの対象リポジトリ →「Settings」→「Secrets and variables」→「Actions」→「New repository secret」で、以下をそれぞれ登録する(値は`.env.local`と同じもの):

- `VITE_FIREBASE_API_KEY`
- `VITE_FIREBASE_AUTH_DOMAIN`
- `VITE_FIREBASE_PROJECT_ID`
- `VITE_FIREBASE_STORAGE_BUCKET`
- `VITE_FIREBASE_MESSAGING_SENDER_ID`
- `VITE_FIREBASE_APP_ID`
- `VITE_OWNER_EMAIL`

### 5. GitHub Pagesを有効にする

リポジトリ →「Settings」→「Pages」→「Build and deployment」の「Source」を **GitHub Actions** に設定する。

`main` ブランチにpushすると `.github/workflows/deploy.yml` が自動でビルド・公開します(公開URL: `https://<GitHubユーザー名>.github.io/shidousen-navi/`)。

### 6. FirebaseのAuthorized domainsにGitHub PagesのURLを追加する

Firebase Console →「Authentication」→「Settings」タブ →「承認済みドメイン」→ `<GitHubユーザー名>.github.io` を追加する(これがないとGitHub Pages上でGoogleサインインが失敗します)。

## 動作確認のポイント

- GitHub Pages公開後、実際のドメイン上で以下を必ず確認してください:
  - Googleサインイン(許可したアカウント以外だとログインが拒否されること)
  - くすりのしおりの直リンク化(非公式API。失敗時に静かにGoogle検索へフォールバックすること)
  - Excel取込・JSON書き出し/読み込み(マージの重複判定)

## ディレクトリ構成

- `src/main.js` … 画面のイベント処理・描画(モックアップの挙動を踏襲)
- `src/store.js` … Firestoreの読み書き
- `src/firebase.js` … Firebase初期化・Googleサインイン
- `src/lib/` … 検索キー正規化、くすりのしおりAPI連携、Google site:検索URL組み立て、Excel列マッピング、バックアップのマージロジック
- `firestore.rules` … Firestoreセキュリティルール
- `.github/workflows/deploy.yml` … GitHub Pagesへの自動デプロイ
