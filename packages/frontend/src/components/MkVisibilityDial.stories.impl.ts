/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { StoryObj } from '@storybook/vue3';
import MkVisibilityDial from './MkVisibilityDial.vue';
export const Default = {
	render(args) {
		return {
			components: {
				MkVisibilityDial,
			},
			setup() {
				return {
					args,
				};
			},
			computed: {
				props() {
					return {
						...this.args,
					};
				},
			},
			template: '<MkVisibilityDial v-bind="props" />',
		};
	},
	args: {
	},
	parameters: {
		layout: 'centered',
	},
} satisfies StoryObj<typeof MkVisibilityDial>;
