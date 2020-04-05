import { clamp } from "alcalzone-shared/math";
import type { Driver } from "../driver/Driver";
import { ZWaveError, ZWaveErrorCodes } from "../error/ZWaveError";
import log from "../log";
import type { ValueID } from "../node/ValueDB";
import { JSONObject, keysOf, pick, validatePayload } from "../util/misc";
import { Duration } from "../values/Duration";
import { ValueMetadata } from "../values/Metadata";
import type { Maybe } from "../values/Primitive";
import {
	CCAPI,
	SetValueImplementation,
	SET_VALUE,
	throwUnsupportedProperty,
	throwUnsupportedPropertyKey,
	throwWrongValueType,
} from "./API";
import {
	API,
	CCCommand,
	CCCommandOptions,
	CCResponsePredicate,
	commandClass,
	CommandClass,
	CommandClassDeserializationOptions,
	expectedCCResponse,
	gotDeserializationOptions,
	implementedVersion,
} from "./CommandClass";
import { CommandClasses } from "./CommandClasses";

// All the supported commands
export enum ColorSwitchCommand {
	SupportedGet = 0x01,
	SupportedReport = 0x02,
	Get = 0x03,
	Report = 0x04,
	Set = 0x05,
	StartLevelChange = 0x06,
	StopLevelChange = 0x07,
}

export enum ColorComponent {
	WarmWhite = 0,
	ColdWhite = 1,
	Red = 2,
	Green = 3,
	Blue = 4,
	Amber = 5,
	Cyan = 6,
	Purple = 7,
	Index = 8,
}

export interface ColorTable {
	warmWhite?: number;
	coldWhite?: number;
	red?: number;
	green?: number;
	blue?: number;
	amber?: number;
	cyan?: number;
	purple?: number;
	index?: number;
}
type ColorKey = keyof ColorTable;

export interface SupportedColorTable {
	supportsWarmWhite: boolean;
	supportsColdWhite: boolean;
	supportsRed: boolean;
	supportsGreen: boolean;
	supportsBlue: boolean;
	supportsAmber: boolean;
	supportsCyan: boolean;
	supportsPurple: boolean;
	supportsIndex: boolean;
}
type SupportedColorKey = keyof SupportedColorTable;
function supportedColorTableKey(key: ColorKey): SupportedColorKey {
	return `supports${key[0].toUpperCase}${key.slice(1)}` as SupportedColorKey;
}
const DefaultSupportedColorTable: Readonly<SupportedColorTable> = Object.freeze(
	{
		supportsWarmWhite: false,
		supportsColdWhite: false,
		supportsRed: false,
		supportsGreen: false,
		supportsBlue: false,
		supportsAmber: false,
		supportsCyan: false,
		supportsPurple: false,
		supportsIndex: false,
	},
);

const ColorComponentMap: Record<ColorKey, ColorComponent> = {
	warmWhite: ColorComponent.WarmWhite,
	coldWhite: ColorComponent.ColdWhite,
	red: ColorComponent.Red,
	green: ColorComponent.Green,
	blue: ColorComponent.Blue,
	amber: ColorComponent.Amber,
	cyan: ColorComponent.Cyan,
	purple: ColorComponent.Purple,
	index: ColorComponent.Index,
};
const ColorKeys = keysOf(ColorComponentMap);
const SupportedColorKeys = ColorKeys.map(supportedColorTableKey);
function isColorKey(key: string): key is ColorKey {
	// Note: indexing ColorComponentMap would be faster, but
	//	the linter will not allow it.
	return ColorKeys.includes(key as ColorKey);
}
function getColorKeyFromComponent(component: ColorComponent): ColorKey | null {
	for (const key of ColorKeys) {
		if (ColorComponentMap[key] === component) {
			return key;
		}
	}
	return null;
}
function getColorComponentFromKey(key: ColorKey): ColorComponent | null {
	const component = ColorComponentMap[key];
	return component ?? null;
}

function getSupportedColorValueID(
	endpointIndex: number,
	supportedColorKey: SupportedColorKey,
): ValueID {
	return {
		commandClass: CommandClasses["Color Switch"],
		endpoint: endpointIndex,
		property: "supportedColor",
		propertyKey: supportedColorKey,
	};
}

function getCurrentColorValueID(
	endpointIndex: number,
	colorKey: ColorKey,
): ValueID {
	return {
		commandClass: CommandClasses["Color Switch"],
		property: "currentColor",
		endpoint: endpointIndex,
		propertyKey: colorKey,
	};
}

function getTargetColorValueID(
	endpointIndex: number,
	colorKey: ColorKey,
): ValueID {
	return {
		commandClass: CommandClasses["Color Switch"],
		property: "targetColor",
		endpoint: endpointIndex,
		propertyKey: colorKey,
	};
}

export interface ColorSwitchGetResult {
	colorComponent: ColorComponent;
	currentValue: number;
	targetValue?: number;
	duration?: Duration;
}

export interface StartLevelChangeOptions {
	duration?: Duration;
	startLevel?: number;
}

export type StartLevelChangeDirection = "down" | "up";

@API(CommandClasses["Color Switch"])
export class ColorSwitchCCAPI extends CCAPI {
	public supportsCommand(cmd: ColorSwitchCommand): Maybe<boolean> {
		switch (cmd) {
			case ColorSwitchCommand.SupportedGet:
			case ColorSwitchCommand.Get:
			case ColorSwitchCommand.Set:
			case ColorSwitchCommand.StartLevelChange:
			case ColorSwitchCommand.StopLevelChange:
				return true; // This is mandatory
		}
		return super.supportsCommand(cmd);
	}

	public async getSupported(): Promise<SupportedColorTable> {
		this.assertSupportsCommand(
			ColorSwitchCommand,
			ColorSwitchCommand.SupportedGet,
		);

		const cc = new ColorSwitchCCSupportedGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
		});
		const response = (await this.driver.sendCommand<
			ColorSwitchCCSupportedReport
		>(cc))!;
		return pick(response, SupportedColorKeys);
	}

	public async get(colorKey: ColorKey): Promise<ColorSwitchGetResult> {
		this.assertSupportsCommand(ColorSwitchCommand, ColorSwitchCommand.Get);

		const colorComponent = getColorComponentFromKey(colorKey);
		if (colorComponent == undefined) {
			throw new Error(`Unsupported color "${colorKey}".`);
		}

		const cc = new ColorSwitchCCGet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			colorComponent: colorComponent,
		});
		const response = (await this.driver.sendCommand<ColorSwitchCCReport>(
			cc,
		))!;
		return {
			colorComponent: response.colorComponent,
			currentValue: response.currentValue,
			targetValue: response.targetValue,
			duration: response.duration,
		};
	}

	public async set(colorTable: ColorTable): Promise<void> {
		this.assertSupportsCommand(ColorSwitchCommand, ColorSwitchCommand.Set);

		const cc = new ColorSwitchCCSet(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			...colorTable,
		});

		await this.driver.sendCommand(cc);
	}

	public async startLevelChange(
		colorKey: ColorKey,
		direction: StartLevelChangeDirection,
		options: StartLevelChangeOptions = {},
	): Promise<void> {
		this.assertSupportsCommand(
			ColorSwitchCommand,
			ColorSwitchCommand.StartLevelChange,
		);

		const colorComponent = getColorComponentFromKey(colorKey);
		if (colorComponent == undefined) {
			throw new Error(`Unknown color "${colorKey}".`);
		}

		const cc = new ColorSwitchCCStartLevelChange(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			colorComponent,
			down: direction === "down",
			startLevel: options.startLevel,
		});

		await this.driver.sendCommand(cc);
	}

	public async stopLevelChange(colorKey: ColorKey): Promise<void> {
		this.assertSupportsCommand(
			ColorSwitchCommand,
			ColorSwitchCommand.StopLevelChange,
		);

		const colorComponent = getColorComponentFromKey(colorKey);
		if (colorComponent == undefined) {
			throw new Error(`Unknown color "${colorKey}".`);
		}

		const cc = new ColorSwitchCCStopLevelChange(this.driver, {
			nodeId: this.endpoint.nodeId,
			endpoint: this.endpoint.index,
			colorComponent,
		});

		await this.driver.sendCommand(cc);
	}

	protected [SET_VALUE]: SetValueImplementation = async (
		{ property, propertyKey },
		value,
	) => {
		if (property !== "targetColor") {
			throwUnsupportedProperty(this.ccId, property);
		}
		if (typeof value !== "number") {
			throwWrongValueType(this.ccId, property, "number", typeof value);
		}

		if (!propertyKey) {
			// No error throw util for this?
			// Might want to treat keyless value as hex "#wwccrrggbb"
			throw new Error("propertyKey required.");
		}

		if (typeof propertyKey != "string" || !isColorKey(propertyKey)) {
			throwUnsupportedPropertyKey(this.ccId, property, propertyKey);
		}

		await this.set({ [propertyKey]: value });

		// Refresh the current value
		await this.get(propertyKey);
	};
}

@commandClass(CommandClasses["Color Switch"])
@implementedVersion(3)
export class ColorSwitchCC extends CommandClass {
	declare ccCommand: ColorSwitchCommand;

	public async interview(complete: boolean = true): Promise<void> {
		const node = this.getNode()!;
		const endpoint = this.getEndpoint()!;
		const api = endpoint.commandClasses["Color Switch"];
		const valueDB = this.getValueDB();

		if (complete) {
			for (const colorKey of ColorKeys) {
				const supportsColorKey = supportedColorTableKey(colorKey);

				const currentValueId = getCurrentColorValueID(
					this.endpointIndex,
					colorKey,
				);
				if (!valueDB.hasMetadata(currentValueId)) {
					valueDB.setMetadata(currentValueId, {
						...ValueMetadata.ReadOnlyNumber,
						label: `Color ${colorKey}`,
						description: `The current level of the ${colorKey} color.`,
						min: 0,
						max: 255,
					});
				}

				const targetValueId = getTargetColorValueID(
					this.endpointIndex,
					colorKey,
				);
				if (!valueDB.hasMetadata(targetValueId)) {
					valueDB.setMetadata(targetValueId, {
						...ValueMetadata.Number,
						label: `Color ${colorKey}`,
						description: `The target level of the ${colorKey} color.`,
						min: 0,
						max: 255,
					});
				}

				const supportedValueId = getSupportedColorValueID(
					this.endpointIndex,
					supportsColorKey,
				);
				if (!valueDB.hasMetadata(supportedValueId)) {
					valueDB.setMetadata(supportedValueId, {
						...ValueMetadata.ReadOnly,
						label: `Supports ${colorKey}`,
						description: `Whether the endpoint supports setting the ${colorKey} color.`,
					});
				}
			}
		}

		log.controller.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: `${this.constructor.name}: doing a ${
				complete ? "complete" : "partial"
			} interview...`,
			direction: "none",
		});

		let supportedColors: SupportedColorTable;
		if (complete) {
			//	the previously discovered colors?
			log.controller.logNode(node.id, {
				endpoint: this.endpointIndex,
				message: "querying Color Switch CC supported colors...",
				direction: "outbound",
			});

			const colorsResponse = await api.getSupported();
			supportedColors = colorsResponse;
		} else {
			supportedColors = { ...DefaultSupportedColorTable };
			for (const key of SupportedColorKeys) {
				const valueId = getSupportedColorValueID(
					this.endpointIndex,
					key,
				);
				const isSupported = valueDB.getValue<boolean>(valueId);
				supportedColors[key] = isSupported ?? false;
			}
		}

		log.controller.logNode(node.id, {
			endpoint: this.endpointIndex,
			message: "querying Color Switch CC color states...",
			direction: "outbound",
		});
		for (const key of ColorKeys) {
			const supportsKey = supportedColorTableKey(key);
			if (!supportedColors[supportsKey]) {
				continue;
			}

			await api.get(key);
		}
	}
}

@CCCommand(ColorSwitchCommand.SupportedReport)
export class ColorSwitchCCSupportedReport extends ColorSwitchCC
	implements SupportedColorTable {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		// Docs say 'variable length', but the table shows 2 bytes.
		validatePayload(this.payload.length >= 2);

		this._supportedColors = {
			supportsWarmWhite: Boolean(this.payload[0] & 1),
			supportsColdWhite: Boolean(this.payload[0] & 2),
			supportsRed: Boolean(this.payload[0] & 4),
			supportsGreen: Boolean(this.payload[0] & 8),
			supportsBlue: Boolean(this.payload[0] & 16),
			supportsAmber: Boolean(this.payload[0] & 32),
			supportsCyan: Boolean(this.payload[0] & 64),
			supportsPurple: Boolean(this.payload[0] & 128),
			supportsIndex: Boolean(this.payload[1] & 1),
		};

		const valueDB = this.getValueDB();
		for (const key of ColorKeys) {
			const supportsColorKey = supportedColorTableKey(key);

			const valueId = getSupportedColorValueID(
				this.endpointIndex,
				supportsColorKey,
			);

			valueDB.setValue(
				valueId,
				this._supportedColors[supportsColorKey] ?? false,
			);
		}
	}

	private _supportedColors: SupportedColorTable;

	public get supportsWarmWhite(): boolean {
		return this._supportedColors.supportsWarmWhite;
	}

	public get supportsColdWhite(): boolean {
		return this._supportedColors.supportsColdWhite;
	}

	public get supportsRed(): boolean {
		return this._supportedColors.supportsRed;
	}

	public get supportsGreen(): boolean {
		return this._supportedColors.supportsGreen;
	}

	public get supportsBlue(): boolean {
		return this._supportedColors.supportsBlue;
	}

	public get supportsAmber(): boolean {
		return this._supportedColors.supportsAmber;
	}

	public get supportsCyan(): boolean {
		return this._supportedColors.supportsCyan;
	}

	public get supportsPurple(): boolean {
		return this._supportedColors.supportsPurple;
	}

	public get supportsIndex(): boolean {
		return this._supportedColors.supportsIndex;
	}

	public toJSON(): JSONObject {
		return super.toJSONInherited({
			...this._supportedColors,
		});
	}
}

@CCCommand(ColorSwitchCommand.SupportedGet)
@expectedCCResponse(ColorSwitchCCSupportedReport)
export class ColorSwitchCCSupportedGet extends ColorSwitchCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | CCCommandOptions,
	) {
		super(driver, options);
	}
}

@CCCommand(ColorSwitchCommand.Report)
export class ColorSwitchCCReport extends ColorSwitchCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions,
	) {
		super(driver, options);

		validatePayload(this.payload.length >= 2);
		this._colorComponent = this.payload[0];
		this._currentValue = this.payload[1];

		if (this.version >= 3) {
			validatePayload(this.payload.length >= 4);
			this._targetValue = this.payload[2];
			this._duration = Duration.parseReport(this.payload[3]);
		}

		const colorKey = getColorKeyFromComponent(this._colorComponent);
		if (!colorKey) {
			return;
		}

		const valueDB = this.getValueDB();

		const valueId = getCurrentColorValueID(this.endpointIndex, colorKey);
		valueDB.setValue(valueId, this._currentValue);

		if (this._targetValue != undefined) {
			const targetValueId = getTargetColorValueID(
				this.endpointIndex,
				colorKey,
			);
			valueDB.setValue(targetValueId, this._targetValue);
		}
	}

	private _colorComponent: ColorComponent;
	public get colorComponent(): ColorComponent {
		return this._colorComponent;
	}

	private _currentValue: number;
	public get currentValue(): number {
		return this._currentValue;
	}

	private _targetValue: number | undefined;
	public get targetValue(): number | undefined {
		return this._targetValue;
	}

	private _duration: Duration | undefined;
	public get duration(): Duration | undefined {
		return this._duration;
	}
}

interface ColorSwitchCCGetOptions extends CCCommandOptions {
	colorComponent: ColorComponent;
}

const testResponseForColorSwitchGet: CCResponsePredicate = (
	sent: ColorSwitchCCGet,
	received,
	isPositiveTransmitReport,
) => {
	return received instanceof ColorSwitchCCReport &&
		sent.colorComponent === received.colorComponent
		? "final"
		: isPositiveTransmitReport
		? "confirmation"
		: "unexpected";
};

@CCCommand(ColorSwitchCommand.Get)
@expectedCCResponse(testResponseForColorSwitchGet)
export class ColorSwitchCCGet extends ColorSwitchCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | ColorSwitchCCGetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			// Populate properties from options object
			this._colorComponent = options.colorComponent;
		}
	}

	private _colorComponent: ColorComponent;
	public get colorComponent(): ColorComponent {
		return this._colorComponent;
	}
	public set colorComponent(value: ColorComponent) {
		if (!ColorComponent[value]) {
			throw new Error(
				"colorComponent must be a valid color component index.",
			);
		}
		this._colorComponent = value;
	}

	public serialize(): Buffer {
		this.payload = Buffer.allocUnsafe(1);
		this.payload[0] = this._colorComponent;
		return super.serialize();
	}
}

export interface ColorSwitchCCSetOptions extends CCCommandOptions, ColorTable {
	duration?: Duration;
}

@CCCommand(ColorSwitchCommand.Set)
export class ColorSwitchCCSet extends ColorSwitchCC {
	public constructor(
		driver: Driver,
		options: CommandClassDeserializationOptions | ColorSwitchCCSetOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			// Populate properties from options object
			this._colorTable = pick(options, ColorKeys);
			this.duration = options.duration ?? new Duration(1, "seconds");
		}
	}

	private _colorTable: ColorTable;
	public get colorTable(): ColorTable {
		return this._colorTable;
	}
	public set colorTable(value: ColorTable) {
		this._colorTable = {
			warmWhite: value.warmWhite,
			coldWhite: value.coldWhite,
			red: value.red,
			green: value.green,
			blue: value.blue,
			cyan: value.cyan,
			purple: value.purple,
			index: value.index,
		};
	}

	private _duration: Duration = new Duration(0, "default");
	public get duration(): Duration {
		return this._duration;
	}
	public set duration(value: Duration) {
		this._duration = value;
	}

	public serialize(): Buffer {
		const populatedColorKeys = ColorKeys.filter(
			(x) => !isNaN(this._colorTable[x] as any),
		);
		const populatedColorCount = populatedColorKeys.length;
		this.payload = Buffer.allocUnsafe(
			1 + populatedColorCount * 2 + (this.version >= 2 ? 1 : 0),
		);
		this.payload[0] = populatedColorCount & 0b11111;
		let i = 1;
		for (const key of populatedColorKeys) {
			const value = this._colorTable[key];
			const component = ColorComponentMap[key];
			this.payload[i] = component;
			this.payload[i + 1] = clamp(value!, 0, 0xff);
			i += 2;
		}
		if (this.version >= 2) {
			this.payload[i] = this._duration.serializeSet();
		}
		return super.serialize();
	}
}

export interface ColorSwitchCCStartLevelChangeOptions extends CCCommandOptions {
	colorComponent: ColorComponent;
	down?: boolean;
	startLevel?: number;
	duration?: Duration;
}

@CCCommand(ColorSwitchCommand.StartLevelChange)
export class ColorSwitchCCStartLevelChange extends ColorSwitchCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| ColorSwitchCCStartLevelChangeOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this._down = options.down ?? false;
			this._startLevel = options.startLevel;
			this._colorComponent = options.colorComponent;
			this._duration = options.duration ?? new Duration(0, "default");
		}
	}

	private _down: boolean;
	public get down(): boolean {
		return this._down;
	}

	private _startLevel: number | undefined;
	public get startLevel(): number | undefined {
		return this._startLevel;
	}

	private _colorComponent: ColorComponent;
	public get colorComponent(): ColorComponent {
		return this._colorComponent;
	}

	private _duration: Duration = new Duration(0, "default");
	public get duration(): Duration {
		return this._duration;
	}

	public serialize(): Buffer {
		const payload: number[] = [
			// up/down
			(Number(this._down) << 6) |
				// ignoreStartLevel
				(Number(this._startLevel == undefined) << 5),
			this.colorComponent,
			// Spec does not way what this should be in regards to ignoreStartLevel
			this.startLevel ?? 0,
		];

		if (this.version >= 3) {
			payload.push(this._duration.serializeSet());
		}

		this.payload = Buffer.from(payload);
		return super.serialize();
	}
}

export interface ColorSwitchCCStopLevelChangeOptions extends CCCommandOptions {
	colorComponent: ColorComponent;
}

@CCCommand(ColorSwitchCommand.StopLevelChange)
export class ColorSwitchCCStopLevelChange extends ColorSwitchCC {
	public constructor(
		driver: Driver,
		options:
			| CommandClassDeserializationOptions
			| ColorSwitchCCStopLevelChangeOptions,
	) {
		super(driver, options);
		if (gotDeserializationOptions(options)) {
			// TODO: Deserialize payload
			throw new ZWaveError(
				`${this.constructor.name}: deserialization not implemented`,
				ZWaveErrorCodes.Deserialization_NotImplemented,
			);
		} else {
			this._colorComponent = options.colorComponent;
		}
	}

	private _colorComponent: ColorComponent;
	public get colorComponent(): ColorComponent {
		return this._colorComponent;
	}

	public serialize(): Buffer {
		this.payload = Buffer.allocUnsafe(1);
		this.payload[0] = this._colorComponent;
		return super.serialize();
	}
}