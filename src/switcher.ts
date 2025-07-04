import { CrosspointControlBusSelection, CrosspointControlSourceSelection } from './enums.js'

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isBusType(test: any): test is CrosspointControlBusSelection {
	return Object.values(CrosspointControlBusSelection).indexOf(test) !== -1
}

// eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
export function isSourceType(test: any): test is CrosspointControlSourceSelection {
	return Object.values(CrosspointControlSourceSelection).indexOf(test) !== -1
}

export class SwitcherState {
	#BusSource: Map<CrosspointControlBusSelection, CrosspointControlSourceSelection> = new Map<
		CrosspointControlBusSelection,
		CrosspointControlSourceSelection
	>()

	constructor() {}

	public setBusSource(bus: string, source: string): boolean {
		if (isBusType(bus) && isSourceType(source)) {
			this.#BusSource.set(bus, source)
			return true
		}
		return false
	}

	public getBusSource(bus: string): string | undefined {
		if (isBusType(bus)) {
			return this.#BusSource.get(bus)
		}
		return undefined
	}

	public resetBusSources(): void {
		this.#BusSource.clear()
	}
}
