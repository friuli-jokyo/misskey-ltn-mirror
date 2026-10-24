/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const BASE36 = '0123456789abcdefghijklmnopqrstuvwxyz';
const RADIX = BASE36.length;
export const PARTITION_PREFIX_LENGTH = 2;
export const PARTITION_COUNT = RADIX ** PARTITION_PREFIX_LENGTH;

export function prefixOf(key: string): string {
	return key.slice(0, PARTITION_PREFIX_LENGTH);
}

export function isPartitionPrefix(prefix: string): boolean {
	return prefix.length === PARTITION_PREFIX_LENGTH && Array.from(prefix).every(ch => BASE36.includes(ch));
}

export function prefixToOrdinal(prefix: string): number {
	if (prefix.length !== PARTITION_PREFIX_LENGTH) throw new Error(`invalid prefix length: ${prefix}`);
	let ord = 0;
	for (const ch of prefix) {
		const d = BASE36.indexOf(ch);
		if (d < 0) throw new Error(`invalid base36 char in prefix: ${prefix}`);
		ord = ord * RADIX + d;
	}
	return ord;
}

export function ordinalToPrefix(ord: number): string {
	if (!Number.isInteger(ord) || ord < 0 || ord >= PARTITION_COUNT) throw new Error(`ordinal out of range: ${ord}`);
	return BASE36[Math.floor(ord / RADIX)] + BASE36[ord % RADIX];
}

export function nextPrefix(prefix: string): string | null {
	const ord = prefixToOrdinal(prefix);
	return ord + 1 >= PARTITION_COUNT ? null : ordinalToPrefix(ord + 1);
}

export function childTableName(parent: string, prefix: string): string {
	return `${parent}_p_${prefix}`;
}

export function groupByPrefix<T extends string>(keys: Iterable<T>): Map<string, T[]> {
	const groups = new Map<string, T[]>();
	for (const key of keys) {
		const prefix = prefixOf(key);
		const group = groups.get(prefix);
		if (group != null) {
			group.push(key);
		} else {
			groups.set(prefix, [key]);
		}
	}
	return groups;
}

export function* prefixesDescending(fromPrefix?: string, toPrefix?: string): Generator<string> {
	let ord = fromPrefix != null ? prefixToOrdinal(fromPrefix) : PARTITION_COUNT - 1;
	const end = toPrefix != null ? prefixToOrdinal(toPrefix) : 0;
	for (; ord >= end; ord--) {
		yield ordinalToPrefix(ord);
	}
}

export function* prefixesAscending(fromPrefix?: string, toPrefix?: string): Generator<string> {
	let ord = fromPrefix != null ? prefixToOrdinal(fromPrefix) : 0;
	const end = toPrefix != null ? prefixToOrdinal(toPrefix) : PARTITION_COUNT - 1;
	for (; ord <= end; ord++) {
		yield ordinalToPrefix(ord);
	}
}
