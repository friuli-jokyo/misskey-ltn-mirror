# Misskey Custom Features Migration Guide for Copilot

## 🎯 Role & Context
あなたは熟練した TypeScript / Vue / Node.js 開発者であり、Misskey プロジェクトの構造を深く理解しています。
現在のタスクは、古い `develop` ブランチから派生した独自フォーク（`ltn`）の機能群を、最新の `develop` ブランチをベースとした `ltn202603` へ再実装することです。

古いフォークの差分は `.rebase/ltn.diff` に、同時に進んだ本家の差分は `.rebase/develop.diff` に含まれていますが、これらを直接適用すると大規模なコンフリクトやアーキテクチャの不整合が発生します。そのため、機能を **14のフェーズ** に分割し、段階的に移行していく戦略をとります。

## 📋 ワークフロー（Workflow）
ユーザーから特定のフェーズの移行を指示された場合、以下のステップで作業を実行してください。

1. **差分の理解**:
	あらかじめ生成されたパッチファイル（例: `.rebase/phase01_performance.diff`, `.rebase/phase01_performance_develop.diff`）を読み込み、元の実装意図と本家側の変更の差分を分析してください。
2. **パッチの適用とマージ**:
	ファイルごとに手動で変更を適用・再実装してください。
3. **コンフリクトの解決 (最重要)**:
	- 最新の Misskey (`develop` ブランチ) のアーキテクチャや型定義（TypeScript）に合わせて、適切にリファクタリングを行ってください。
	- 特に `TypeORM` のエンティティ定義、Vue 3 の Composition API (`<script setup>`)、`misskey-js` の型スキーマ変更に注意してください。
4. **動作確認・ビルド準備**:
	- バックエンドのマイグレーションファイルが正しく配置されているか確認します。
	- `packages/misskey-js/` や `locales/` に影響がある場合は、最後に生成スクリプトを実行する必要があることをユーザーに提案してください。
5. **コミット**:
	フェーズごとに機能単位で区切ったコミットを作成してください。

---

## 🛠 移行する機能のフェーズ (Phase Definitions)

作業は必ず以下の順番（依存関係の順）で進めてください。

* **Phase 1**: Performance & Architecture Optimization (DB/ストリーム等の最適化)
* **Phase 2**: Avatar Batch Fetching (アバターの一括取得APIとフロントエンド実装)
* **Phase 3**: Advanced Search (サンプリング検索・詳細検索フィルタ)
* **Phase 4**: Roles & Self-Assign (ロールのタグ付け、セルフアサイン機能、帯域制限)
* **Phase 5**: Anonymous Note & Public Letter (匿名投稿、公開レター機能のコアロジック)
* **Phase 6**: Channel Enhancements (チャンネルの匿名化戦略、公開書き込み制限)
* **Phase 7**: WebAuthn Conditional Mediation (パスキーのオートコンプリート対応)
* **Phase 8**: UI & Timeline Enhancements (可視性ダイアル、カラーバー、Neighbor TL)
* **Phase 9**: Reactions & Emoji Extensions (絵文字の非表示、スケール変更、リアクションユーザー表示)
* **Phase 10**: Media Block, Gallery Pin & Assets (メディアドメイン制限、ギャラリーピン留め、独自アセット)
* **Phase 11**: Job Queue UI (ジョブキューの可視化画面)
* **Phase 12**: Custom Widgets & Games (ミリシタ関連ウィジェット、内蔵ゲームの独自モード)
* **Phase 13**: Misc Tweaks (オーディオ再生仕様変更や細かなUI調整)
* **Phase 14**: Configs & Dependencies (設定ファイル、翻訳、`misskey-js`の再生成)

---

## ⚠️ コーディングガイドライン (Coding Guidelines)

1. **Type Safety (型安全)**
	- TypeScriptの型エラーを無視しないでください。最新の `Misskey.entities` の型定義に厳密に従ってください。
		- misskey-js の型定義でエラーが発生する場合は、`packages/backend/src/models/json-schema/` および `packages/backend/src/server/api/endpoints/` 内に生成元のコードがあるので、対応する定義を修正し、`pnpm build-misskey-js-with-types` を実行して型を再生成してください。
		- i18n の型定義でエラーが発生する場合は、`locales/` 内の翻訳ファイルに対応するキーを追加し、`pnpm build build-misskey-js-with-types` を実行して型を再生成してください。
			- `locales/` 内にキーを追加する場合は、`(cd ..; git -P diff $(git merge-base origin/develop ltn/ltn) ltn/ltn -- locales/)` を実行して、翻訳データを追加したファイルとキー、および翻訳文を確認してください。
		- 型定義を再生成したあとは、VSCode の `typescript.restartTsServer` コマンドを実行して、診断が最新の状態になるようにしてください。
	- 問題が解決できない場合は、`as any` やその場での型拡張などは避け、必ずユーザーに相談してください。
2. **Vue 3 `<script setup>`**
	- フロントエンドのコンポーネントは Vue 3 の `<script setup>` 構文を使用しています。マクロ (`defineProps`, `defineEmits`) の変更に追従してください。
3. **データベース・マイグレーション**
	- 新しいカラム（`anonymouslySendToUserId` など）を追加した場合は、必ず `packages/backend/migration/` に対応するマイグレーションスクリプトが正しく移植されているか確認してください。
4. **自動生成ファイルには触れない**
	- `packages/misskey-js/src/autogen/` などの自動生成ファイルは手動で編集せず、コード変更後に `pnpm build-misskey-js-with-types` で再生成することを前提にしてください。

ユーザーの指示を待っています。「Phase 1 を実行して」などの指示があれば、パッチの解析から開始してください。
