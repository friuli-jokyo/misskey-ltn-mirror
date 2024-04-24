import { shallowReadonly, shallowRef, watch } from 'vue';

const initial = new Date();
const localDateRef = shallowRef({ year: initial.getFullYear(), month: initial.getMonth() + 1, day: initial.getDate() });

function updateDate() {
	const now = new Date();
	localDateRef.value = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
	setTimeout(updateDate, (new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).valueOf() - now.valueOf()) / 2);
}

updateDate();

export const localDate = shallowReadonly(localDateRef);

export const a1on2024enabled = shallowRef(false);

watch(localDate, (newDate) => {
	if (a1on2024enabled.value) {
		if (newDate.year !== 2024 || newDate.month !== 4 || newDate.day !== 1) {
			a1on2024enabled.value = false;
		}
	}
});

globalThis.__MK_REFS__ = {
	a1on2024enabled,
};
