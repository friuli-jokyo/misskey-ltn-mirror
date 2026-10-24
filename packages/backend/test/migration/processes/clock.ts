/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

const offset = Number(process.env.MK_E2E_CLOCK_OFFSET_MS ?? '0');

if (offset !== 0) {
	const RealDate = Date;
	const ShiftedDate = function (this: unknown, ...args: unknown[]) {
		if (new.target == null) return new RealDate(RealDate.now() + offset).toString();
		return args.length === 0 ? new RealDate(RealDate.now() + offset) : Reflect.construct(RealDate, args, new.target);
	} as unknown as DateConstructor;
	Object.setPrototypeOf(ShiftedDate, RealDate);
	(ShiftedDate as { prototype: Date }).prototype = RealDate.prototype;
	ShiftedDate.now = () => RealDate.now() + offset;
	globalThis.Date = ShiftedDate;
}

export const clockOffsetMs = offset;
