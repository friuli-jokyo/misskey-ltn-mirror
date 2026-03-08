#!/bin/bash

WORKDIR=$(pwd)
cd ..

# ==========================================
# 1. 独自実装 (ltn) 側の diff を抽出するコマンド
# ==========================================
LTN_CMD="git -P diff $(git merge-base origin/develop ltn/ltn) ltn/ltn"

echo "Generating LTN diffs..."

$LTN_CMD -- \
  packages/backend/src/postgres.ts \
  packages/backend/src/GlobalModule.ts \
  packages/backend/src/queue/processors/ExportNotesProcessorService.ts \
  packages/backend/src/queue/processors/ExportBlockingProcessorService.ts \
  packages/backend/src/queue/processors/ExportClipsProcessorService.ts \
  packages/backend/src/queue/processors/ExportFavoritesProcessorService.ts \
  packages/backend/src/queue/processors/ExportMutingProcessorService.ts \
  packages/backend/src/queue/processors/ImportFollowingProcessorService.ts \
  packages/backend/src/queue/types.ts \
  packages/backend/src/core/UserSuspendService.ts \
  packages/backend/src/core/QueueModule.ts \
  packages/backend/src/core/QueueService.ts \
  packages/backend/src/server/ServerService.ts \
  packages/backend/src/server/HealthServerService.ts \
  packages/backend/src/core/activitypub/ApInboxService.ts \
  packages/backend/src/boot/entry.ts \
  packages/backend/src/boot/master.ts \
  packages/backend/src/boot/worker.ts \
  packages/frontend/vite.config.ts \
  > $WORKDIR/phase01_performance.diff

$LTN_CMD -- \
  packages/backend/src/server/api/endpoints/users/avatars.ts \
  packages/frontend/src/scripts/avatars.ts \
  packages/frontend/src/components/MkAccountMoved.vue \
  packages/frontend/src/components/MkMention.vue \
  packages/frontend/src/components/MkSubNoteContent.vue \
  packages/frontend/src/components/global/MkMfm.ts \
  > $WORKDIR/phase02_avatars.diff

$LTN_CMD -- \
  packages/backend/src/config.ts \
  packages/backend/src/core/SearchService.ts \
  packages/backend/src/core/QueryService.ts \
  packages/backend/src/core/IdService.ts \
  packages/backend/src/misc/id/aid.ts \
  packages/backend/src/misc/id/aidx.ts \
  packages/backend/src/misc/id/meid.ts \
  packages/backend/src/misc/id/meidg.ts \
  packages/backend/src/misc/id/object-id.ts \
  packages/backend/src/server/api/endpoints/notes/search.ts \
  packages/frontend/src/pages/search.note.vue \
  > $WORKDIR/phase03_search.diff

$LTN_CMD -- \
  packages/backend/src/models/Role.ts \
  packages/backend/src/models/json-schema/role.ts \
  packages/backend/src/core/entities/DriveFileEntityService.ts \
  packages/backend/src/core/entities/RoleEntityService.ts \
  packages/backend/src/core/DriveService.ts \
  packages/backend/src/core/RoleService.ts \
  packages/backend/src/server/api/endpoints/admin/roles/assign.ts \
  packages/backend/src/server/api/endpoints/admin/roles/list.ts \
  packages/backend/src/server/api/endpoints/admin/roles/show.ts \
  packages/backend/src/server/api/endpoints/admin/roles/unassign.ts \
  packages/backend/src/server/api/endpoints/admin/roles/users.ts \
  packages/backend/src/server/api/endpoints/drive.ts \
  packages/frontend/src/pages/admin/RolesEditorFormula.vue \
  packages/frontend/src/pages/admin/roles.editor.vue \
  packages/frontend/src/pages/admin/roles.role.vue \
  packages/frontend/src/pages/admin/roles.vue \
  packages/frontend/src/pages/role.vue \
  packages/frontend/src/pages/settings/drive.vue \
  packages/frontend/src/components/MkRolePreview.vue \
  packages/frontend-shared/js/const.ts \
  packages/backend/migration/1740325734247-RoleTags.js \
  > $WORKDIR/phase04_roles.diff

$LTN_CMD -- \
  packages/backend/src/models/Note.ts \
  packages/backend/src/models/json-schema/note.ts \
  packages/backend/src/core/NoteCreateService.ts \
  packages/backend/src/core/NoteDeleteService.ts \
  packages/backend/src/core/NotePiningService.ts \
  packages/backend/src/core/NoteReadService.ts \
  packages/backend/src/core/ReactionService.ts \
  packages/backend/src/core/InstanceActorService.ts \
  packages/backend/src/core/entities/NoteEntityService.ts \
  packages/backend/src/misc/is-user-related.ts \
  packages/backend/src/server/api/endpoints/notes/create.ts \
  packages/backend/src/server/api/endpoints/notes/delete.ts \
  packages/backend/src/server/api/endpoints/notes/global-timeline.ts \
  packages/backend/src/server/api/endpoints/notes/hybrid-timeline.ts \
  packages/backend/src/server/api/endpoints/notes/local-timeline.ts \
  packages/backend/src/server/api/endpoints/notes/mentions.ts \
  packages/backend/src/server/api/endpoints/notes/timeline.ts \
  packages/backend/src/server/api/endpoints/notes/user-list-timeline.ts \
  packages/backend/src/server/api/endpoints/users/get-frequently-replied-users.ts \
  packages/backend/src/server/api/endpoints/users/notes.ts \
  packages/backend/src/server/api/endpoints/users/report-abuse.ts \
  packages/backend/src/server/api/stream/channels/global-timeline.ts \
  packages/backend/src/server/api/stream/channels/hashtag.ts \
  packages/backend/src/server/api/stream/channels/home-timeline.ts \
  packages/backend/src/server/api/stream/channels/hybrid-timeline.ts \
  packages/backend/src/server/api/stream/channels/local-timeline.ts \
  packages/backend/src/server/api/stream/channels/user-list.ts \
  packages/frontend/src/components/MkPostForm.vue \
  packages/frontend/src/components/MkNote.vue \
  packages/frontend/src/components/MkNoteDetailed.vue \
  packages/frontend/src/components/MkNoteHeader.vue \
  packages/frontend/src/components/MkNoteSimple.vue \
  packages/frontend/src/components/MkNoteSub.vue \
  packages/frontend/src/components/MkAbuseReportWindow.vue \
  packages/frontend/src/components/MkUserPopup.vue \
  packages/frontend/src/types/post-form.ts \
  packages/frontend/src/scripts/get-appear-note.ts \
  packages/frontend/src/scripts/get-note-menu.ts \
  packages/frontend/src/scripts/get-user-menu.ts \
  packages/frontend-embed/src/components/EmNote.vue \
  packages/frontend-embed/src/components/EmNoteSub.vue \
  packages/backend/migration/1700526757415-anonymous-note.js \
  > $WORKDIR/phase05_anonymous_note.diff

$LTN_CMD -- \
  packages/backend/src/models/Channel.ts \
  packages/backend/src/models/ChannelAnonymousSalt.ts \
  packages/backend/src/models/json-schema/channel.ts \
  packages/backend/src/core/entities/ChannelEntityService.ts \
  packages/backend/src/server/api/endpoints/channels/create.ts \
  packages/backend/src/server/api/endpoints/channels/update.ts \
  packages/backend/src/core/AntennaService.ts \
  packages/backend/src/core/FanoutTimelineEndpointService.ts \
  packages/backend/src/server/api/stream/channel.ts \
  packages/frontend/src/pages/channel-editor.vue \
  packages/frontend/src/pages/channel.vue \
  packages/frontend/src/pages/channels.vue \
  packages/frontend/src/components/MkChannelFollowButton.vue \
  packages/frontend/src/components/MkReactionsViewer.reaction.vue \
  packages/frontend/src/components/MkTimeline.vue \
  packages/frontend/src/types/menu.ts \
  packages/frontend/src/cache.ts \
  packages/frontend/src/local-storage.ts \
  packages/backend/migration/1715618371464-anonymousChannel.js \
  > $WORKDIR/phase06_channels.diff

$LTN_CMD -- \
  packages/backend/src/core/WebAuthnService.ts \
  packages/backend/src/server/api/SigninApiService.ts \
  packages/backend/src/server/api/SigninService.ts \
  packages/backend/src/server/api/SigninWithPasskeyApiService.ts \
  packages/backend/src/server/api/SignupApiService.ts \
  packages/backend/src/server/api/endpoints/i/2fa/key-done.ts \
  packages/backend/src/server/api/endpoints/i/2fa/register-key.ts \
  packages/backend/src/server/api/endpoints/i/2fa/unregister.ts \
  packages/frontend/src/components/MkSignin.input.vue \
  packages/frontend/src/components/MkSignin.password.vue \
  packages/frontend/src/components/MkSignin.vue \
  packages/frontend/src/components/MkSignupDialog.form.vue \
  packages/frontend/src/components/MkSettingSuggestion.vue \
  packages/frontend/src/pages/settings/2fa.vue \
  packages/frontend/src/pages/settings/security.vue \
  packages/frontend/src/scripts/client-name.ts \
  > $WORKDIR/phase07_webauthn.diff

$LTN_CMD -- \
  packages/frontend/src/components/MkVisibilityDial.vue \
  packages/frontend/src/components/MkVisibilityDial.stories.impl.ts \
  packages/frontend/src/ui/_common_/common.vue \
  packages/frontend/src/ui/_common_/navbar-for-mobile.vue \
  packages/frontend/src/ui/_common_/navbar.vue \
  packages/frontend/src/ui/classic.header.vue \
  packages/frontend/src/ui/classic.sidebar.vue \
  packages/frontend/src/ui/deck.vue \
  packages/frontend/src/ui/universal.vue \
  packages/frontend/src/pages/settings/general.vue \
  packages/frontend/src/pages/settings/privacy.vue \
  packages/frontend/src/pages/note.vue \
  packages/frontend/src/os.ts \
  packages/frontend/src/store.ts \
  > $WORKDIR/phase08_ui_timeline.diff

$LTN_CMD -- \
  packages/backend/src/models/Emoji.ts \
  packages/backend/src/core/CustomEmojiService.ts \
  packages/backend/src/core/entities/EmojiEntityService.ts \
  packages/backend/src/queue/processors/ImportCustomEmojisProcessorService.ts \
  packages/backend/src/server/api/endpoints/admin/emoji/add.ts \
  packages/backend/src/server/api/endpoints/admin/emoji/update.ts \
  packages/backend/src/server/api/endpoints/emojis.ts \
  packages/frontend/src/pages/emoji-edit-dialog.vue \
  packages/frontend/src/components/MkReactionsViewer.vue \
  packages/frontend/src/components/MkReactionsViewer.details.vue \
  packages/frontend/src/components/global/MkCustomEmoji.vue \
  packages/frontend/src/components/global/MkAvatar.vue \
  packages/frontend/src/components/global/MkPageHeader.vue \
  packages/frontend/src/components/MkAvatars.vue \
  packages/frontend/src/components/MkClipPreview.vue \
  packages/frontend/src/components/MkGalleryPostPreview.vue \
  packages/frontend/src/components/MkInviteCode.vue \
  packages/frontend/src/components/MkMenu.vue \
  packages/frontend/src/components/MkNotification.vue \
  packages/frontend/src/components/MkUserCardMini.vue \
  packages/frontend/src/components/MkUsersTooltip.vue \
  packages/backend/migration/1699872192285-hidden-emoji.js \
  packages/backend/migration/1711123547052-conspicuousScale-emoji.js \
  > $WORKDIR/phase09_reactions_emoji.diff

$LTN_CMD -- \
  packages/backend/assets/ \
  packages/backend/src/models/Meta.ts \
  packages/backend/src/models/UserProfile.ts \
  packages/backend/src/core/entities/UserEntityService.ts \
  packages/backend/src/server/FileServerService.ts \
  packages/backend/src/server/api/endpoints/admin/meta.ts \
  packages/backend/src/server/api/endpoints/admin/update-meta.ts \
  packages/backend/src/server/api/endpoints/admin/ad/create.ts \
  packages/backend/src/server/api/endpoints/admin/ad/delete.ts \
  packages/backend/src/server/api/endpoints/admin/ad/list.ts \
  packages/backend/src/server/api/endpoints/admin/ad/update.ts \
  packages/backend/src/server/api/endpoints/i/update.ts \
  packages/backend/src/server/web/ \
  packages/frontend/src/pages/admin/index.vue \
  packages/frontend/src/pages/admin/security.vue \
  packages/frontend/src/pages/gallery/post.vue \
  packages/frontend/src/pages/settings/profile.vue \
  packages/frontend/src/components/MkNoteMediaGrid.vue \
  packages/frontend/src/pages/user/files.vue \
  packages/frontend/src/pages/user/index.files.vue \
  packages/backend/migration/1700823392948-user-pinned-gallery.js \
  packages/backend/migration/1709744820502-bannedMediaDomains.js \
  > $WORKDIR/phase10_media_gallery.diff

$LTN_CMD -- \
  packages/backend/src/server/api/endpoints/i/jobs.ts \
  packages/frontend/src/pages/jobs.vue \
  packages/frontend/src/router/definition.ts \
  > $WORKDIR/phase11_job_queue.diff

$LTN_CMD -- \
  packages/frontend/src/widgets/ \
  packages/misskey-bubble-game/ \
  packages/frontend/src/pages/drop-and-fusion.vue \
  packages/frontend/src/pages/drop-and-fusion.game.vue \
  packages/frontend/src/pages/reversi/game.board.vue \
  packages/frontend/src/pages/timeline.vue \
  packages/frontend/src/ref.ts \
  packages/frontend/src/events.ts \
  packages/frontend/src/style.scss \
  packages/frontend/assets/drop-and-fusion/ \
  packages/frontend/assets/reversi/ \
  > $WORKDIR/phase12_games_widgets.diff

$LTN_CMD -- \
  packages/backend/src/core/AbuseReportNotificationService.ts \
  packages/backend/src/server/api/endpoints/blocking/delete.ts \
  packages/backend/src/server/api/endpoints/mute/delete.ts \
  packages/backend/src/server/api/endpoints/users.ts \
  packages/frontend/src/boot/main-boot.ts \
  packages/frontend/src/boot/common.ts \
  packages/frontend/src/components/MkSelect.vue \
  packages/frontend/src/components/MkUpdated.vue \
  packages/frontend/src/components/MkUrlPreview.vue \
  packages/frontend/src/components/MkUserSetupDialog.Follow.vue \
  packages/frontend/src/components/MkMediaVideo.vue \
  packages/frontend/src/components/MkForgotPassword.vue \
  packages/frontend/src/components/MkInstanceTicker.vue \
  packages/frontend/src/components/MkVisitorDashboard.vue \
  packages/frontend/src/pages/about.overview.vue \
  packages/frontend/src/pages/explore.users.vue \
  packages/frontend/src/pages/follow-requests.vue \
  packages/frontend/src/pages/page.vue \
  packages/frontend/src/pages/settings/custom-css.vue \
  packages/frontend/src/scripts/media-has-audio.ts \
  > $WORKDIR/phase13_misc_tweaks.diff

$LTN_CMD -- \
  .vscode/settings.json \
  packages/backend/src/di-symbols.ts \
  packages/backend/src/models/_.ts \
  packages/backend/src/models/RepositoryModule.ts \
  packages/backend/src/server/api/ApiServerService.ts \
  packages/backend/src/server/api/endpoint-list.ts \
  packages/frontend/src/scripts/misskey-api.ts \
  locales/ \
  packages/misskey-js/ \
  pnpm-lock.yaml \
  package.json \
  packages/backend/package.json \
  > $WORKDIR/phase14_configs_deps.diff

echo "Done! Generated LTN diffs."

# ==========================================
# 2. 本家 (develop) 側の diff を抽出するコマンド
# ==========================================
DEV_CMD="git -P diff $(git merge-base origin/develop ltn/ltn) origin/develop"

echo "Generating develop diffs..."

$DEV_CMD -- packages/backend/src/postgres.ts packages/backend/src/GlobalModule.ts packages/backend/src/queue/processors/ExportNotesProcessorService.ts packages/backend/src/queue/processors/ExportBlockingProcessorService.ts packages/backend/src/queue/processors/ExportClipsProcessorService.ts packages/backend/src/queue/processors/ExportFavoritesProcessorService.ts packages/backend/src/queue/processors/ExportMutingProcessorService.ts packages/backend/src/queue/processors/ImportFollowingProcessorService.ts packages/backend/src/queue/types.ts packages/backend/src/core/UserSuspendService.ts packages/backend/src/core/QueueModule.ts packages/backend/src/core/QueueService.ts packages/backend/src/server/ServerService.ts packages/backend/src/server/HealthServerService.ts packages/backend/src/core/activitypub/ApInboxService.ts packages/backend/src/boot/entry.ts packages/backend/src/boot/master.ts packages/backend/src/boot/worker.ts packages/frontend/vite.config.ts > $WORKDIR/phase01_performance_develop.diff
$DEV_CMD -- packages/backend/src/server/api/endpoints/users/avatars.ts packages/frontend/src/scripts/avatars.ts packages/frontend/src/components/MkAccountMoved.vue packages/frontend/src/components/MkMention.vue packages/frontend/src/components/MkSubNoteContent.vue packages/frontend/src/components/global/MkMfm.ts > $WORKDIR/phase02_avatars_develop.diff
$DEV_CMD -- packages/backend/src/config.ts packages/backend/src/core/SearchService.ts packages/backend/src/core/QueryService.ts packages/backend/src/core/IdService.ts packages/backend/src/misc/id/aid.ts packages/backend/src/misc/id/aidx.ts packages/backend/src/misc/id/meid.ts packages/backend/src/misc/id/meidg.ts packages/backend/src/misc/id/object-id.ts packages/backend/src/server/api/endpoints/notes/search.ts packages/frontend/src/pages/search.note.vue > $WORKDIR/phase03_search_develop.diff
$DEV_CMD -- packages/backend/src/models/Role.ts packages/backend/src/models/json-schema/role.ts packages/backend/src/core/RoleService.ts packages/backend/src/core/entities/RoleEntityService.ts packages/backend/src/core/DriveService.ts packages/backend/src/server/api/endpoints/admin/roles/assign.ts packages/backend/src/server/api/endpoints/admin/roles/list.ts packages/backend/src/server/api/endpoints/admin/roles/show.ts packages/backend/src/server/api/endpoints/admin/roles/unassign.ts packages/backend/src/server/api/endpoints/admin/roles/users.ts packages/backend/src/server/api/endpoints/drive.ts packages/frontend/src/pages/admin/RolesEditorFormula.vue packages/frontend/src/pages/admin/roles.editor.vue packages/frontend/src/pages/admin/roles.role.vue packages/frontend/src/pages/admin/roles.vue packages/frontend/src/pages/role.vue packages/frontend/src/pages/settings/drive.vue packages/frontend/src/components/MkRolePreview.vue packages/frontend-shared/js/const.ts packages/backend/migration/1740325734247-RoleTags.js > $WORKDIR/phase04_roles_develop.diff
$DEV_CMD -- packages/backend/src/models/Note.ts packages/backend/src/models/json-schema/note.ts packages/backend/src/core/NoteCreateService.ts packages/backend/src/core/NoteDeleteService.ts packages/backend/src/core/NotePiningService.ts packages/backend/src/core/NoteReadService.ts packages/backend/src/core/ReactionService.ts packages/backend/src/core/InstanceActorService.ts packages/backend/src/core/entities/NoteEntityService.ts packages/backend/src/misc/is-user-related.ts packages/backend/src/server/api/endpoints/notes/create.ts packages/backend/src/server/api/endpoints/notes/delete.ts packages/backend/src/server/api/endpoints/notes/global-timeline.ts packages/backend/src/server/api/endpoints/notes/hybrid-timeline.ts packages/backend/src/server/api/endpoints/notes/local-timeline.ts packages/backend/src/server/api/endpoints/notes/mentions.ts packages/backend/src/server/api/endpoints/notes/timeline.ts packages/backend/src/server/api/endpoints/notes/user-list-timeline.ts packages/backend/src/server/api/endpoints/users/get-frequently-replied-users.ts packages/backend/src/server/api/endpoints/users/notes.ts packages/backend/src/server/api/endpoints/users/report-abuse.ts packages/backend/src/server/api/stream/channels/global-timeline.ts packages/backend/src/server/api/stream/channels/hashtag.ts packages/backend/src/server/api/stream/channels/home-timeline.ts packages/backend/src/server/api/stream/channels/hybrid-timeline.ts packages/backend/src/server/api/stream/channels/local-timeline.ts packages/backend/src/server/api/stream/channels/user-list.ts packages/frontend/src/components/MkPostForm.vue packages/frontend/src/components/MkNote.vue packages/frontend/src/components/MkNoteDetailed.vue packages/frontend/src/components/MkNoteHeader.vue packages/frontend/src/components/MkNoteSimple.vue packages/frontend/src/components/MkNoteSub.vue packages/frontend/src/components/MkAbuseReportWindow.vue packages/frontend/src/components/MkUserPopup.vue packages/frontend/src/types/post-form.ts packages/frontend/src/scripts/get-appear-note.ts packages/frontend/src/scripts/get-note-menu.ts packages/frontend/src/scripts/get-user-menu.ts packages/frontend-embed/src/components/EmNote.vue packages/frontend-embed/src/components/EmNoteSub.vue packages/backend/migration/1700526757415-anonymous-note.js > $WORKDIR/phase05_anonymous_note_develop.diff
$DEV_CMD -- packages/backend/src/models/Channel.ts packages/backend/src/models/ChannelAnonymousSalt.ts packages/backend/src/models/json-schema/channel.ts packages/backend/src/core/entities/ChannelEntityService.ts packages/backend/src/server/api/endpoints/channels/create.ts packages/backend/src/server/api/endpoints/channels/update.ts packages/backend/src/core/AntennaService.ts packages/backend/src/core/FanoutTimelineEndpointService.ts packages/backend/src/server/api/stream/channel.ts packages/frontend/src/pages/channel-editor.vue packages/frontend/src/pages/channel.vue packages/frontend/src/pages/channels.vue packages/frontend/src/components/MkChannelFollowButton.vue packages/frontend/src/components/MkReactionsViewer.reaction.vue packages/frontend/src/types/menu.ts packages/frontend/src/cache.ts packages/frontend/src/local-storage.ts packages/backend/migration/1715618371464-anonymousChannel.js > $WORKDIR/phase06_channels_develop.diff
$DEV_CMD -- packages/backend/src/core/WebAuthnService.ts packages/backend/src/server/api/SigninApiService.ts packages/backend/src/server/api/SigninService.ts packages/backend/src/server/api/SigninWithPasskeyApiService.ts packages/backend/src/server/api/SignupApiService.ts packages/backend/src/server/api/endpoints/i/2fa/key-done.ts packages/backend/src/server/api/endpoints/i/2fa/register-key.ts packages/backend/src/server/api/endpoints/i/2fa/unregister.ts packages/frontend/src/components/MkSignin.input.vue packages/frontend/src/components/MkSignin.password.vue packages/frontend/src/components/MkSignin.vue packages/frontend/src/components/MkSignupDialog.form.vue packages/frontend/src/components/MkSettingSuggestion.vue packages/frontend/src/pages/settings/2fa.vue packages/frontend/src/scripts/client-name.ts > $WORKDIR/phase07_webauthn_develop.diff
$DEV_CMD -- packages/frontend/src/components/MkVisibilityDial.vue packages/frontend/src/components/MkVisibilityDial.stories.impl.ts packages/frontend/src/ui/_common_/common.vue packages/frontend/src/ui/_common_/navbar-for-mobile.vue packages/frontend/src/ui/_common_/navbar.vue packages/frontend/src/ui/classic.header.vue packages/frontend/src/ui/classic.sidebar.vue packages/frontend/src/ui/deck.vue packages/frontend/src/ui/universal.vue packages/frontend/src/pages/settings/general.vue packages/frontend/src/pages/settings/privacy.vue packages/frontend/src/pages/note.vue packages/frontend/src/os.ts packages/frontend/src/store.ts > $WORKDIR/phase08_ui_timeline_develop.diff
$DEV_CMD -- packages/backend/src/models/Emoji.ts packages/backend/src/core/CustomEmojiService.ts packages/backend/src/core/entities/EmojiEntityService.ts packages/backend/src/queue/processors/ImportCustomEmojisProcessorService.ts packages/backend/src/server/api/endpoints/admin/emoji/add.ts packages/backend/src/server/api/endpoints/admin/emoji/update.ts packages/backend/src/server/api/endpoints/emojis.ts packages/frontend/src/pages/emoji-edit-dialog.vue packages/frontend/src/components/MkReactionsViewer.vue packages/frontend/src/components/MkReactionsViewer.details.vue packages/frontend/src/components/global/MkCustomEmoji.vue packages/frontend/src/components/global/MkAvatar.vue packages/frontend/src/components/global/MkPageHeader.vue packages/frontend/src/components/MkAvatars.vue packages/frontend/src/components/MkClipPreview.vue packages/frontend/src/components/MkGalleryPostPreview.vue packages/frontend/src/components/MkInviteCode.vue packages/frontend/src/components/MkMenu.vue packages/frontend/src/components/MkNotification.vue packages/frontend/src/components/MkUserCardMini.vue packages/frontend/src/components/MkUsersTooltip.vue packages/backend/migration/1699872192285-hidden-emoji.js packages/backend/migration/1711123547052-conspicuousScale-emoji.js > $WORKDIR/phase09_reactions_emoji_develop.diff
$DEV_CMD -- packages/backend/assets/ packages/backend/src/models/Meta.ts packages/backend/src/models/UserProfile.ts packages/backend/src/core/entities/UserEntityService.ts packages/backend/src/server/FileServerService.ts packages/backend/src/server/api/endpoints/admin/meta.ts packages/backend/src/server/api/endpoints/admin/update-meta.ts packages/backend/src/server/api/endpoints/admin/ad/create.ts packages/backend/src/server/api/endpoints/admin/ad/delete.ts packages/backend/src/server/api/endpoints/admin/ad/list.ts packages/backend/src/server/api/endpoints/admin/ad/update.ts packages/backend/src/server/api/endpoints/i/update.ts packages/backend/src/server/web/ packages/frontend/src/pages/admin/index.vue packages/frontend/src/pages/admin/security.vue packages/frontend/src/pages/gallery/post.vue packages/frontend/src/pages/settings/profile.vue packages/frontend/src/components/MkNoteMediaGrid.vue packages/frontend/src/pages/user/files.vue packages/frontend/src/pages/user/index.files.vue packages/backend/migration/1700823392948-user-pinned-gallery.js packages/backend/migration/1709744820502-bannedMediaDomains.js > $WORKDIR/phase10_media_gallery_develop.diff
$DEV_CMD -- packages/backend/src/server/api/endpoints/i/jobs.ts packages/frontend/src/pages/jobs.vue packages/frontend/src/router/definition.ts > $WORKDIR/phase11_job_queue_develop.diff
$DEV_CMD -- packages/frontend/src/widgets/ packages/misskey-bubble-game/ packages/frontend/src/pages/drop-and-fusion.vue packages/frontend/src/pages/drop-and-fusion.game.vue packages/frontend/src/pages/reversi/game.board.vue packages/frontend/src/pages/timeline.vue packages/frontend/src/ref.ts packages/frontend/src/events.ts packages/frontend/src/style.scss packages/frontend/assets/drop-and-fusion/ packages/frontend/assets/reversi/ > $WORKDIR/phase12_games_widgets_develop.diff
$DEV_CMD -- packages/backend/src/core/AbuseReportNotificationService.ts packages/backend/src/server/api/endpoints/blocking/delete.ts packages/backend/src/server/api/endpoints/mute/delete.ts packages/backend/src/server/api/endpoints/users.ts packages/frontend/src/boot/main-boot.ts packages/frontend/src/boot/common.ts packages/frontend/src/components/MkSelect.vue packages/frontend/src/components/MkUpdated.vue packages/frontend/src/components/MkUrlPreview.vue packages/frontend/src/components/MkUserSetupDialog.Follow.vue packages/frontend/src/components/MkMediaVideo.vue packages/frontend/src/components/MkForgotPassword.vue packages/frontend/src/components/MkInstanceTicker.vue packages/frontend/src/components/MkVisitorDashboard.vue packages/frontend/src/pages/about.overview.vue packages/frontend/src/pages/explore.users.vue packages/frontend/src/pages/follow-requests.vue packages/frontend/src/pages/page.vue packages/frontend/src/pages/settings/custom-css.vue packages/frontend/src/scripts/media-has-audio.ts > $WORKDIR/phase13_misc_tweaks_develop.diff
$DEV_CMD -- .vscode/settings.json packages/backend/src/di-symbols.ts packages/backend/src/models/_.ts packages/backend/src/models/RepositoryModule.ts packages/backend/src/server/api/ApiServerService.ts packages/backend/src/server/api/endpoint-list.ts packages/backend/src/server/api/endpoints.ts locales/ packages/misskey-js/ pnpm-lock.yaml package.json packages/backend/package.json > $WORKDIR/phase14_configs_deps_develop.diff

echo "Done! Generated develop diffs."

# ==========================================
# 3. 移行ガイドと自動適用スクリプトの出力
# ==========================================
cat << 'EOF' > $WORKDIR/migration_guide.md
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
EOF

echo "migration_guide.md has been generated."

cd $WORKDIR
