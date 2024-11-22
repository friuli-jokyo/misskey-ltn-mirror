import { Ref, readonly, ref } from 'vue';
import { misskeyApi } from './misskey-api.js';
import type * as Misskey from 'misskey-js';
import { hostname } from '@@/js/config.js';

export type AvatarsMap = Map<Misskey.entities.User['id'], Pick<Misskey.entities.User, 'id' | 'name' | 'username' | 'host' | 'avatarBlurhash'> & { [T in keyof Misskey.entities.User & 'avatarUrl']: NonNullable<Misskey.entities.User[T]> } | null | undefined>;

const usernameAndHostToIdMapRaw: Ref<Map<string, Misskey.entities.User['id'] | null | undefined>> = ref(new Map());
const avatarsMapRaw: Ref<AvatarsMap> = ref(new Map());

export const usernameAndHostToIdMap = readonly(usernameAndHostToIdMapRaw);
export const avatarsMap = readonly(avatarsMapRaw);

export function usernameAndHostToKey(username: string, host: string | null) {
	if (host === hostname) {
		host = null;
	}
	return `${username}@${host ?? '.'}`;
}

export function loadUsers(...specifiers: readonly Readonly<Pick<Misskey.entities.User, 'id'> | Pick<Misskey.entities.User, 'username' | 'host'>>[]) {
	const users = specifiers.map(user => ('id' in user ? user : {
		username: user.username,
		host: user.host === hostname ? null : user.host,
	})).filter(user => {
		if ('id' in user) {
			return !avatarsMapRaw.value.has(user.id);
		} else {
			const key = usernameAndHostToKey(user.username, user.host);
			const value = !usernameAndHostToIdMapRaw.value.has(key);
			usernameAndHostToIdMapRaw.value.set(key, undefined);
			return value;
		}
	});
	if (users.length) {
		misskeyApi('users/avatars', { users }).then(avatars => {
			for (const user of users) {
				if ('id' in user) {
					avatarsMapRaw.value.set(user.id, null);
				} else {
					usernameAndHostToIdMapRaw.value.set(usernameAndHostToKey(user.username, user.host), null);
				}
			}
			for (const avatar of avatars) {
				const key = usernameAndHostToKey(avatar.username, avatar.host);
				usernameAndHostToIdMapRaw.value.set(key, avatar.id);
				avatarsMapRaw.value.set(avatar.id, avatar);
			}
		});
	}
}
