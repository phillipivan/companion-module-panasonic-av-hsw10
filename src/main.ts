import {
	InstanceBase,
	runEntrypoint,
	InstanceStatus,
	SomeCompanionConfigField,
	SharedUdpSocket,
	TCPHelper,
} from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateVariableDefinitions } from './variables.js'
import { UpgradeScripts } from './upgrades.js'
import { UpdateActions } from './actions.js'
import { FeedbackId, UpdateFeedbacks } from './feedbacks.js'
import { STX, ETX, Messages, MsgSyntax, CrosspointControlBusSelection } from './enums.js'
import { Logger, LoggerLevel } from './logger.js'
import { parseTcpMsg, parseUdpMsg } from './parseMsg.js'
import { StatusManager } from './status.js'
import { SwitcherState } from './switcher.js'
import PQueue from 'p-queue'
import { RemoteInfo } from 'dgram'
import { throttle } from 'lodash'

const MESSAGE_INTERVAL = 16
const CONNECTION_TIMEOUT = 20000
const RECONNECT_INTERVAL = 10000
const THROTTLE_DURATION = 100

export class AvHsw10 extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig // Setup in init()
	private socket!: TCPHelper
	private tcpBuffer = Buffer.from('')
	private udpListener!: SharedUdpSocket
	private keepAliveTimer!: NodeJS.Timeout
	private reconnectTimer!: NodeJS.Timeout
	public logger: Logger = new Logger(this)
	private queue = new PQueue({ concurrency: 1, interval: MESSAGE_INTERVAL, intervalCap: 1 })
	private statusManager = new StatusManager(this, { status: InstanceStatus.Connecting, message: 'Initialising' }, 1000)
	public state = new SwitcherState()
	public feedbacksToCheck: Set<FeedbackId> = new Set<FeedbackId>()
	constructor(internal: unknown) {
		super(internal)
		process.title = `companion_AvHSw10_${this.label}`
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config

		this.statusManager.updateStatus(InstanceStatus.Connecting)

		this.updateActions() // export actions
		this.updateFeedbacks() // export feedbacks
		this.updateVariableDefinitions() // export variable definitions
		this.configUpdated(config).catch(() => {})
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.queue.clear()
		this.config = config
		this.state.resetBusSources()
		process.title = `companion_AvHSw10_${this.label}`
		this.logger = new Logger(this, config.verbose ? LoggerLevel.Console : LoggerLevel.Information)
		this.logger.debug(`Config Updated: ${JSON.stringify(config)}`)
		this.initTcp(config.host, config.port)
		this.initUdp(config.host, config.portRecieve)
	}
	// When module gets deleted
	async destroy(): Promise<void> {
		this.logger.debug(`destroy ${this.id}:${this.label}`)
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer)
		this.queue.clear()
		if (this.socket) this.socket.destroy()
		if (this.udpListener) this.udpListener.close()
		this.statusManager.destroy()
	}

	private startKeepAlive(timeout: number = CONNECTION_TIMEOUT): void {
		if (this.keepAliveTimer) clearTimeout(this.keepAliveTimer)
		this.keepAliveTimer = setTimeout(() => {
			this.sendMessage(Messages.BusStatusQuery, CrosspointControlBusSelection.PGM).catch(() => {})
		}, timeout / 2)
	}

	public async sendMessage(command: Messages, ...args: string[]): Promise<boolean> {
		return this.queue.add(async () => {
			if (this.socket && this.socket.isConnected) {
				let msg = MsgSyntax.Stx + command
				for (const arg of args) {
					msg += MsgSyntax.Sep + arg
				}
				msg += MsgSyntax.Etx
				const sent = await this.socket.send(msg)
				if (sent) {
					this.logger.debug(`Message sent: ${msg}`)
				} else {
					this.logger.warn(`Message send failed: ${msg}`)
				}
				this.startKeepAlive()
				return sent
			}
			this.logger.warn(`Not connected! Could not send ${command}: ${args}`)
			return false
		}) as Promise<boolean>
	}

	private initTcp(host: string, port: number) {
		const errorEvent = (err: Error) => {
			this.logger.error(err)
			this.reconnectTimer = setTimeout(() => {
				this.initTcp(host, port)
			}, RECONNECT_INTERVAL)
		}
		const endEvent = () => {
			this.logger.warn(`Disconnected from ${host}`)
			this.reconnectTimer = setTimeout(() => {
				this.initTcp(host, port)
			}, RECONNECT_INTERVAL)
		}
		const connectEvent = () => {
			this.statusManager.updateStatus(InstanceStatus.Ok)
			this.tcpBuffer = Buffer.from('')
			this.startKeepAlive()
			this.queryEachBus()
		}
		const dataEvent = (d: Buffer<ArrayBufferLike>) => {
			this.logger.console(`Data received: ${d}`)
			this.tcpBuffer = Buffer.concat([this.tcpBuffer, d])
			let i = 0
			let offset = 0
			while ((i = this.tcpBuffer.indexOf(ETX, offset)) !== -1) {
				parseTcpMsg(this.tcpBuffer.subarray(this.tcpBuffer.indexOf(STX, offset), i).toString(), this)
				offset = i + 1
			}
			this.tcpBuffer = this.tcpBuffer.subarray(offset)
		}
		const statusChangeEvent = (status: InstanceStatus, message: string | undefined) => {
			this.statusManager.updateStatus(status, message ?? '')
		}
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
		if (host.trim() == '') {
			this.statusManager.updateStatus(InstanceStatus.BadConfig, `No host`)
			this.logger.error(`No host defined`)
			return
		}
		try {
			if (this.socket) this.socket.destroy()
			this.statusManager.updateStatus(InstanceStatus.Connecting, `Connecting to ${host.trim()}:${port}`)
			this.socket = new TCPHelper(host.trim(), port)
			this.socket.on('error', errorEvent)
			this.socket.on('end', endEvent)
			this.socket.on('connect', connectEvent)
			this.socket.on('data', dataEvent)
			this.socket.on('status_change', statusChangeEvent)
		} catch (e) {
			this.statusManager.updateStatus(InstanceStatus.UnknownError)
			this.logger.error(`Error setting TCP Socket:\n${JSON.stringify(e)}`)
		}
	}

	private initUdp(host: string, port: number): void {
		const errorEvent = (err: Error) => {
			this.logger.error(`Error from UDP Listener: ${JSON.stringify(err)}`)
		}
		const listeningEvent = () => {
			this.logger.debug(`Listening for UDP messages from ${host} on 0.0.0.0:${port}`)
		}
		const dataEvent = (msg: Buffer<ArrayBufferLike>, rInfo: RemoteInfo) => {
			if (rInfo.address == host.trim()) {
				parseUdpMsg(msg, this)
			} else {
				this.logger.console(
					`UDP Message recieved: ${msg.toString()}\n From unrecognised host: ${JSON.stringify(rInfo)}`,
				)
			}
		}
		const closeEvent = () => {
			this.logger.info(`Closed shared udp socket on port ${port}`)
		}
		if (host.trim() == '') {
			this.statusManager.updateStatus(InstanceStatus.BadConfig, `No host`)
			this.logger.error(`No host defined`)
			return
		}
		try {
			if (this.udpListener) this.udpListener.close()
			this.udpListener = this.createSharedUdpSocket('udp4', dataEvent)
			this.udpListener.bind(port, host.trim(), listeningEvent)
			this.udpListener.on('error', errorEvent)
			this.udpListener.on('close', closeEvent)
		} catch (e) {
			this.statusManager.updateStatus(InstanceStatus.UnknownError)
			this.logger.error(`Error setting up UDP Listener:\n${JSON.stringify(e)}`)
		}
	}

	private throttledFeedbackChecks = throttle(
		() => {
			this.checkFeedbacks(...this.feedbacksToCheck)
			this.feedbacksToCheck.clear()
		},
		THROTTLE_DURATION,
		{ leading: false, trailing: true },
	)

	public addFeedbackToCheck(fb: FeedbackId): void {
		this.feedbacksToCheck.add(fb)
		this.throttledFeedbackChecks()
	}

	private queryEachBus(): void {
		Object.values(CrosspointControlBusSelection).forEach((bus) => {
			this.sendMessage(Messages.BusStatusQuery, bus).catch(() => {})
		})
	}

	// Return config fields for web config
	public getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	private updateActions(): void {
		UpdateActions(this)
	}

	private updateFeedbacks(): void {
		UpdateFeedbacks(this)
	}

	private updateVariableDefinitions(): void {
		UpdateVariableDefinitions(this)
	}
}

runEntrypoint(AvHsw10, UpgradeScripts)
