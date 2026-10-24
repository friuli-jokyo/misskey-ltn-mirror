/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as mfm from 'mfm-js';
import { createMfmRenderer } from '@@/js/mfm-renderer.js';
import type { SetupContext } from 'vue';
import type { MfmBaseProps, MfmEvents } from '@@/js/mfm-renderer.js';
import type { MkABehavior } from '@/components/global/MkA.vue';
import MkUrl from '@/components/global/MkUrl.vue';
import MkTime from '@/components/global/MkTime.vue';
import MkLink from '@/components/MkLink.vue';
import MkMention from '@/components/MkMention.vue';
import MkEmoji from '@/components/global/MkEmoji.vue';
import MkCustomEmoji from '@/components/global/MkCustomEmoji.vue';
import MkCode from '@/components/MkCode.vue';
import MkCodeInline from '@/components/MkCodeInline.vue';
import MkGoogle from '@/components/MkGoogle.vue';
import MkSparkle from '@/components/MkSparkle.vue';
import MkA from '@/components/global/MkA.vue';
import { prefer } from '@/preferences.js';
import { loadUsers } from '@/utility/avatars.js';

type MfmProps = MfmBaseProps & {
	enableEmojiMenu?: boolean;
	enableEmojiMenuReaction?: boolean;
	linkNavigationBehavior?: MkABehavior;
};

function getMentionNodeProps(ast: readonly mfm.MfmNode[]): {
	username: string;
	host: string | null;
}[] {
	return ast.flatMap((node) => node.children ? getMentionNodeProps(node.children) : node.type === 'mention' ? [node.props] : []);
}

const mfmRenderer = createMfmRenderer<MfmProps>({
	components: () => ({
		Url: MkUrl,
		Link: MkLink,
		Mention: MkMention,
		A: MkA,
		Time: MkTime,
		Emoji: MkEmoji,
		CustomEmoji: MkCustomEmoji,
		Code: MkCode,
		CodeInline: MkCodeInline,
		Search: MkGoogle,
		Sparkle: MkSparkle,
	}),
	getOptions: () => ({
		advancedMfm: prefer.s.advancedMfm,
		animatedMfm: prefer.s.animatedMfm,
	}),
	supports: {
		navigationBehavior: true,
		emojiMenu: true,
	},
});

// eslint-disable-next-line import/no-default-export
export default function (props: MfmProps, context: { emit: SetupContext<MfmEvents>['emit'] }) {
	if (!props.text) return mfmRenderer(props, context);

	const parsedNodes = props.parsedNodes ?? (props.plain ? mfm.parseSimple : mfm.parse)(props.text);

	loadUsers(...getMentionNodeProps(parsedNodes));

	return mfmRenderer({ ...props, parsedNodes }, context);
}
