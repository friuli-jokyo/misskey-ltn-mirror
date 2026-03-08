# Misskey 独自機能 移行・再実装ガイド

本ドキュメントは、古い \`develop\` に適用されていた独自機能（\`ltn.diff\`）を、最新の \`develop\` に対して安全かつ確実に移行・再実装するためのフェーズごとのガイドです。

---

## 📌 フェーズ別 実装機能概要と実装手段

### Phase 1: Performance & Architecture Optimization (パフォーマンス最適化・ストリーム化)
* **概要**: エクスポート等の長時間実行されるDBクエリによるタイムアウト防止、アカウント凍結・解除時のActivityPub配信によるメモリ圧迫防止、ジョブキュー管理の強化。
* **実装手段**:
  * \`postgres.ts\`, \`GlobalModule.ts\` 等: 長時間実行用の \`dbLong\` DataSourceを定義し注入。
  * \`ExportNotesProcessorService.ts\` 等: エクスポート処理を \`dbLong\` を使ったストリーム (\`TransformStream\`) に変更し、省メモリ化。
  * \`UserSuspendService.ts\`: フォロー関係からの Inbox 抽出を Cursor ベースのチャンク処理に改修。
  * \`boot/master.ts\`, \`server/ServerService.ts\`: サーバの起動タイミング調整 (\`ready()\` の分離)。

### Phase 2: Avatar Batch Fetching (アバター一括取得エンドポイント)
* **概要**: 多数のユーザーのアバターを効率的に取得するためのバッチ処理エンドポイントの追加。
* **実装手段**:
  * バックエンド: \`users/avatars.ts\` を新設し、ユーザーIDまたは \`username\` + \`host\` のリストを受け取り一括取得。
  * フロントエンド: \`avatars.ts\` でキュー管理し、\`MkMention.vue\` や \`MkAccountMoved.vue\` などのコンポーネントで利用。

### Phase 3: Advanced Search (検索機能の拡張)
* **概要**: サンプリングによる全文検索の負荷軽減と、リプライ数・リアクション数などの詳細な検索フィルタの追加。
* **実装手段**:
  * \`config.ts\`: \`tableSample\`, \`commonTermThreshold\` の設定値を追加。
  * \`SearchService.ts\`: DBの \`TABLESAMPLE\` を用いてヒット数を概算し、閾値を超えればMeiliSearchにフォールバックするロジックを実装。
  * \`misc/id/*\`: ID生成ロジックに \`immutable\` フラグを追加し、日時指定検索で活用。
  * フロントエンド: \`search.note.vue\` に詳細検索UIを追加。

### Phase 4: Roles & Self-Assign (ロール機能と帯域設定の拡張)
* **概要**: ロールへの「タグ」付与、特定タグロールのセルフアサイン（ユーザー自身での着脱）機能、ロールごとのドライブ帯域制限や広告管理権限。
* **実装手段**:
  * DB変更: \`Role\` に \`tags\` 追加。
  * \`RoleService.ts\`: セルフアサインの権限判定メソッドや、\`selfAssignability\`, \`driveUploadBandwidthDurationHrCapacityMbPairs\` ポリシーの追加。
  * \`DriveService.ts\`: Redisを用いたアップロード量の計算と制限ロジックの適用。
  * フロントエンド: ロール編集画面 (\`roles.editor.vue\`) とユーザー向けロール一覧画面 (\`role.vue\`) の改修。

### Phase 5: Anonymous Note & Public Letter (匿名投稿・パブリックレター)
* **概要**: 指定したユーザーへの「公開レター」機能と、後述のチャンネル内での完全匿名投稿のための基盤実装。
* **実装手段**:
  * DB変更: \`Note\` に \`anonymouslySendToUserId\`, \`anonymousChannelUsername\` 追加。
  * \`NoteCreateService.ts\`: 匿名投稿時のバリデーション（ファイル添付不可等）追加。\`InstanceActorService.ts\` の \`instance.actor\` (システムアカウント) を仮の投稿者として扱う。
  * 各種 \`Note\` 系サービス: 匿名時の既読やピン留め、削除などの権限を制限。
  * フロントエンド: \`MkPostForm.vue\` にパブリックレターモードを追加し、各種Noteコンポーネントでの匿名ユーザー名の表示出し分け。

### Phase 6: Channel Enhancements (チャンネルの高度な設定・匿名化戦略)
* **概要**: 日次・週次などで切り替わるソルトを用いたチャンネル内専用の「匿名化戦略」機能、および公開書き込み権限の要求。
* **実装手段**:
  * DB変更: \`Channel\` に \`anonymousStrategy\`, \`requirePublicWriteAccess\` 追加。新規テーブル \`ChannelAnonymousSalt\` を追加。
  * API: \`channels/create.ts\` 等で匿名ソルトの生成・再生成を実装。
  * フロントエンド: チャンネル設定画面 (\`channel-editor.vue\`) の改修と、匿名チャンネルでのリアクション時の警告ダイアログ (\`MkReactionsViewer.reaction.vue\`) 追加。

### Phase 7: WebAuthn Conditional Mediation (パスキー対応強化)
* **概要**: オートコンプリートUIを利用したシームレスなパスワードレスログイン (Conditional Mediation) のサポート。
* **実装手段**:
  * \`WebAuthnService.ts\`: 登録・認証のオプション生成の改修。
  * API: \`SigninApiService.ts\` などで、Conditional Mediation を考慮したログインフローへの統合。
  * フロントエンド: \`MkSignin.vue\` などで \`@github/webauthn-json\` を呼び出し、UI表示とパスキー認証を連動。\`MkSettingSuggestion.vue\` での2FA警告ウィジェット追加。

### Phase 8: UI & Timeline Enhancements (UI・タイムライン拡張、可視性ダイアル)
* **概要**: 公開範囲を直感的に切り替えるダイアルUIや、ノートの公開範囲を示すボーダー表示、Neighbor（近隣）ノート機能の追加。
* **実装手段**:
  * フロントエンド: \`MkVisibilityDial.vue\` を新規作成し \`universal.vue\` に組み込み。
  * \`MkNote.vue\`, \`MkNoteSub.vue\`: 公開範囲に応じたカラーバー (\`followersBar\`, \`specifiedBar\`) のスタイル適用と翻訳ボタン追加。
  * \`os.postButtonTriggered\` を追加し、チャンネル閲覧中の投稿動作を改善。

### Phase 9: Reactions & Emoji Extensions (絵文字・リアクション拡張)
* **概要**: 特定のカスタム絵文字を目立たせる（スケール変更）、ピッカーから隠す機能、リアクションしたユーザーのアイコン一覧表示。
* **実装手段**:
  * DB変更: \`Emoji\` に \`hidden\`, \`conspicuousScale\` 追加。
  * バックエンド: \`CustomEmojiService.ts\` などで隠し絵文字の除外処理。
  * フロントエンド: \`MkReactionsViewer.vue\` でリアクションのスケールを適用し、\`reactedUsers\` を取得して \`MkAvatar\` (small) で重ねて表示。

### Phase 10: Media Block, Gallery Pin & Branding Assets (メディア制限・ギャラリーピン・アセット)
* **概要**: サーバー全体での特定メディアドメインのプロキシ拒否設定と、ユーザーのギャラリー投稿ピン留め、およびロゴ・アセット群の差し替え。
* **実装手段**:
  * DB変更: \`Meta\` に \`bannedMediaDomains\`、\`UserProfile\` に \`pinnedGalleryPostId\` を追加。
  * \`FileServerService.ts\`: メディアプロキシ時にドメインブロックリストを評価。
  * フロントエンド: プロフィール画面や \`gallery/post.vue\` でのピン留め操作。\`favicon\` や \`splash\` などのアセット画像の変更。

### Phase 11: Job Queue UI (ジョブキューUI)
* **概要**: エクスポート等のバックグラウンドジョブの進行状況を確認できる画面の提供。
* **実装手段**:
  * API: \`i/jobs.ts\` エンドポイントを新設。
  * フロントエンド: \`jobs.vue\` 画面の作成と \`router/definition.ts\` へのルーティング追加。

### Phase 12: Custom Widgets & Games (カスタムウィジェット、ゲーム拡張)
* **概要**: MLTDのイベントボーダー・情報表示用ウィジェットや、内蔵ゲームの独自モード追加等。
* **実装手段**:
  * フロントエンド: \`WidgetMltdEventInfo.vue\`, \`WidgetMltdEventBorder.vue\` の実装と \`widgets/index.ts\` への登録。
  * \`misskey-bubble-game\`: \`monos.ts\` 等への独自アセット追加。
  * \`timeline.vue\`: \`Matter.js\` を使ったタイムラインでの絵文字落下ギミック。

### Phase 13: Misc Tweaks (Bug Fixes, Minor UI)
* **概要**: 通報メール機能の無効化、自分自身のブロック・ミュート解除の許可、メディアのオーディオ再生仕様変更などの細かな修正。
* **実装手段**:
  * \`AbuseReportNotificationService.ts\`, \`blocking/delete.ts\`, \`media-has-audio.ts\` 等での個別ロジック修正。
  * 既存コンポーネント（\`MkUrlPreview.vue\`、\`MkInstanceTicker.vue\`等）の微細な調整。

### Phase 14: Migrations, Locales, Config, misskey-js, dependencies
* **概要**: \`locales\` の言語ファイル更新、\`misskey-js\` の型定義、パッケージ依存関係の更新。
* **実装手段**:
  * これらはコンフリクトしやすいため、1〜13のフェーズを終えた後に適用し、\`pnpm build\` や \`pnpm run api\` 等で再生成させる。
