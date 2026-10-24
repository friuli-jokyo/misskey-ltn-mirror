/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { describe, expect, test } from 'vitest';
import {
	PARTITION_COUNT,
	prefixOf,
	prefixToOrdinal,
	ordinalToPrefix,
	nextPrefix,
	childTableName,
	prefixesDescending,
	prefixesAscending,
	groupByPrefix,
} from '@/misc/partition.js';

describe('misc:partition', () => {
	test('prefixOf takes the first 2 chars', () => {
		expect(prefixOf('aoxxxxxxxx')).toBe('ao');
		expect(prefixOf('6f0011223344')).toBe('6f');
	});

	test('ordinal round-trips with prefix', () => {
		for (const p of ['00', '0a', '5m', 'ao', 'zz']) {
			expect(ordinalToPrefix(prefixToOrdinal(p))).toBe(p);
		}
		expect(prefixToOrdinal('00')).toBe(0);
		expect(prefixToOrdinal('zz')).toBe(PARTITION_COUNT - 1);
		expect(PARTITION_COUNT).toBe(1296);
	});

	test('nextPrefix increments in base36; zz has no next', () => {
		expect(nextPrefix('am')).toBe('an');
		expect(nextPrefix('az')).toBe('b0');
		expect(nextPrefix('09')).toBe('0a');
		expect(nextPrefix('zz')).toBeNull();
	});

	test('child table name derivation', () => {
		expect(childTableName('note', 'ao')).toBe('note_p_ao');
	});

	test('nextPrefix bound matches partition upper bound (no z-padding needed)', () => {
		expect('am' < 'amzzzzzzzz').toBe(true);
		expect('amzzzzzzzz' < 'an').toBe(true);
		expect(nextPrefix('am')).toBe('an');
	});

	test('prefixesDescending yields newest-first, inclusive bounds', () => {
		expect(Array.from(prefixesDescending('05', '00'))).toEqual(['05', '04', '03', '02', '01', '00']);

		const all = Array.from(prefixesDescending());
		expect(all.length).toBe(PARTITION_COUNT);
		expect(all[0]).toBe('zz');
		expect(all.at(-1)).toBe('00');

		expect(Array.from(prefixesDescending('ao', 'ao'))).toEqual(['ao']);
	});

	test('prefixesAscending yields oldest-first, inclusive bounds', () => {
		expect(Array.from(prefixesAscending('00', '05'))).toEqual(['00', '01', '02', '03', '04', '05']);

		const all = Array.from(prefixesAscending());
		expect(all.length).toBe(PARTITION_COUNT);
		expect(all[0]).toBe('00');
		expect(all.at(-1)).toBe('zz');

		expect(Array.from(prefixesAscending('ao', 'ao'))).toEqual(['ao']);
		expect(Array.from(prefixesAscending('zy'))).toEqual(['zy', 'zz']);
	});

	test('groupByPrefix groups keys by partition prefix, preserving order', () => {
		const groups = groupByPrefix(['ao0001', 'an0001', 'ao0002', 'ap0001', 'an0002']);
		expect(Array.from(groups.entries())).toEqual([
			['ao', ['ao0001', 'ao0002']],
			['an', ['an0001', 'an0002']],
			['ap', ['ap0001']],
		]);
		expect(groupByPrefix([]).size).toBe(0);
	});
});
