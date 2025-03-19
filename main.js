"use strict";

/*
 * Created with @iobroker/create-adapter v2.6.5
 */

const utils = require("@iobroker/adapter-core");
const axios = require("axios");

class WetterCom extends utils.Adapter {
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "wetter_com",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));

		this.on("unload", this.onUnload.bind(this));

		this.pre_url = "https://forecast.meteonomiqs.com/v3_1/forecast/";
		this.post_url = "/hourly";

		this.summaryMap = new Map();
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		if (this.config.key.length < 40) {
			this.log.error("Please save your API-Key in instance settings and start adapter again.");

			this.terminate
				? this.terminate(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG)
				: process.exit(utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);

			return;
		}

		const requestClient = axios.create({
			headers: {
				Accept: "*/*",
				"Accept-Encoding": "gzip, deflate, br",
				Connection: "keep-alive",
				"x-api-key": this.config.key,
			},
			timeout: 300000, //Global timeout 5 min
		});

		this.longitude = this.config.longitude;
		this.latitude = this.config.latitude;
		if (this.config.useSystemLocation) {
			const config = await this.getForeignObjectAsync("system.config");
			this.longitude = config?.common.longitude;
			this.latitude = config?.common.latitude;
		}

		this.url = this.pre_url + this.latitude + "/" + this.longitude + this.post_url;
		const response = await requestClient
			.get(this.url, { responseType: "json" })
			.then((res) => {
				return res.data;
			})
			.catch((error) => {
				this.log.error(JSON.stringify(error.response.data));
			});

		if (response.items) {
			//Remove old Datapoints
			await this.delObjectAsync("", { recursive: true });

			//Create Datapoints
			let date = "";
			let dayCounter = 0;
			for (let i = 0; i < response.items.length; i++) {
				const item = response.items[i];
				const curDate = new Date(item.date);

				if (date !== curDate.toLocaleDateString()) {
					dayCounter++;
					date = curDate.toLocaleDateString();
				}

				const dayChannelName = "Day_" + this.pad(dayCounter, 2);
				await this.setObjectNotExistsAsync(dayChannelName, {
					type: "channel",
					common: {
						name: date,
					},
					native: {},
				});

				const channelName = dayChannelName + ".Hour_" + this.pad(curDate.getHours(), 2);
				await this.setObjectNotExistsAsync(channelName, {
					type: "channel",
					common: {
						name: curDate.toLocaleTimeString(),
					},
					native: {},
				});

				await this.createDpWithState(channelName, item);

				//Tageszusammenfassungen
				this.calculateSummary(dayChannelName, item);
			}
			await this.createSummaryDP();
		}
	}

	async createDpWithState(channelName, item) {
		const keys = Object.keys(item);
		for (const key of keys) {
			if (typeof item[key] === "object" && item[key] !== null) {
				const newChannelName = (channelName + "." + key).replace(this.FORBIDDEN_CHARS, "_");
				await this.setObjectNotExistsAsync(newChannelName, {
					type: "channel",
					common: {
						name: key,
					},
					native: {},
				});

				//Windicons hinzufügen
				if (key === "wind") {
					const windName = channelName + "." + key + ".icon";
					await this.setObjectNotExistsAsync(windName, {
						type: "state",
						common: {
							name: "icon",
							type: "string",
							role: "indicator",
							write: false,
							read: true,
						},
						native: {},
					});
					this.setState(
						windName,
						"/adapter/" + this.name + "/icons/wind/" + this.getWindIconName(item.wind.avg, item.wind.text),
						true,
					);
				}

				this.createDpWithState(newChannelName, item[key]);
			} else {
				let value = item[key];
				// @ts-ignore
				await this.setObjectNotExistsAsync(channelName + "." + key, {
					type: "state",
					common: {
						name: key,
						type: typeof value === "object" ? "string" : typeof value,
						role: "indicator",
						write: false,
						read: true,
					},
					native: {},
				});
				if (key === "icon") {
					value = "/adapter/" + this.name + "/icons/weather/svg/" + value;
				}

				this.setState(channelName + "." + key, value, true);
			}
		}
	}

	async createSummaryDP() {
		for (const pair of this.summaryMap) {
			const [key, value] = pair;
			//date
			await this.setObjectNotExistsAsync(key + ".date", {
				type: "state",
				common: {
					name: "date",
					type: "string",
					role: "indicator",
					write: false,
					read: true,
				},
				native: {},
			});
			this.setState(key + ".date", value.date.toLocaleDateString(), true);

			//Name des Tages
			await this.setObjectNotExistsAsync(key + ".day", {
				type: "state",
				common: {
					name: "day name",
					type: "string",
					role: "indicator",
					write: false,
					read: true,
				},
				native: {},
			});
			this.setState(key + ".day", value.date.toLocaleDateString("de-DE", { weekday: "long" }), true);

			//Temp min
			await this.createNumberObjectNotExists(key, "tempMin", 100, "°C");
			this.setState(key + ".tempMin", value.tempMin, true);

			//Temp max
			await this.createNumberObjectNotExists(key, "tempMax", -100, "°C");
			this.setState(key + ".tempMax", value.tempMax, true);

			//Humidity
			await this.createNumberObjectNotExists(key, "humidity", 0, "%");
			this.setState(key + ".humidity", this.avg(value.humidityHours), true);

			//Luftdruck
			await this.createNumberObjectNotExists(key, "pressure", 0, "mb");
			this.setState(key + ".pressure", this.avg(value.pressureHours), true);

			//Regenmenge
			await this.createNumberObjectNotExists(key, "rain", 0, "mm");
			this.setState(key + ".rain", this.avg(value.rainHours), true);

			//Regenwahrscheinlichkeit
			await this.createNumberObjectNotExists(key, "rainProbability", 0, "%");
			this.setState(key + ".rainProbability", this.avg(value.rainProbHours), true);

			//max Windböen
			await this.createNumberObjectNotExists(key, "maxWindGusts", -1, "km/h");
			this.setState(key + ".maxWindGusts", value.windGusts, true);

			//Wind
			await this.createNumberObjectNotExists(key, "windSpeed", -1, "km/h");
			this.setState(key + ".windSpeed", this.avg(value.windSpeedHours), true);
		}
	}

	/**
	 * Tageszusammenfassungen
	 * @param {*} dayChannelName
	 * @param {*} item
	 */
	calculateSummary(dayChannelName, item) {
		if (!this.summaryMap.has(dayChannelName)) {
			this.summaryMap.set(dayChannelName, {
				date: new Date(item.date),
				tempMin: 100,
				tempMax: -100,
				windGusts: -1,
				humidityHours: [],
				pressureHours: [],
				rainHours: [],
				rainProbHours: [],
				windSpeedHours: [],
			});
		}
		const entry = this.summaryMap.get(dayChannelName);

		//Temp min
		entry.tempMin = Math.min(entry.tempMin, item.temperature.avg);
		//Temp max
		entry.tempMax = Math.max(entry.tempMax, item.temperature.avg);
		//Humidity
		entry.humidityHours.push(item.relativeHumidity);
		//Pressure
		entry.pressureHours.push(item.pressure);
		//Regenmenge
		entry.rainHours.push(item.prec.sum);
		//Regenwahrscheinlichkeit
		entry.rainProbHours.push(item.prec.probability);
		//max Windböen
		entry.windGusts = Math.max(entry.windGusts, item.wind.gusts.value);
		//Windgeschwindigkeit
		entry.windSpeedHours.push(item.wind.avg);
	}

	async createNumberObjectNotExists(id, name, def, unit) {
		await this.setObjectNotExistsAsync(id + "." + name, {
			type: "state",
			common: {
				name: name,
				type: "number",
				role: "indicator",
				write: false,
				read: true,
				def: def,
				unit: unit,
			},
			native: {},
		});
	}

	getWindIconName(kmh, direction) {
		switch (true) {
			case kmh === 0:
				return "0_" + direction + ".png";
			case kmh >= 1 && kmh <= 5:
				return "1_" + direction + ".png";
			case kmh >= 6 && kmh <= 11:
				return "2_" + direction + ".png";
			case kmh >= 12 && kmh <= 19:
				return "3_" + direction + ".png";
			case kmh >= 20 && kmh <= 28:
				return "4_" + direction + ".png";
			case kmh >= 29 && kmh <= 38:
				return "5_" + direction + ".png";
			case kmh >= 39 && kmh <= 49:
				return "6_" + direction + ".png";
			case kmh >= 50 && kmh <= 61:
				return "7_" + direction + ".png";
			case kmh >= 62 && kmh <= 74:
				return "8_" + direction + ".png";
			case kmh >= 75 && kmh <= 88:
				return "9_" + direction + ".png";
			case kmh >= 89 && kmh <= 102:
				return "10_" + direction + ".png";
			case kmh >= 103 && kmh <= 117:
				return "11_" + direction + ".png";
			case kmh >= 118:
				return "12_" + direction + ".png";
			default:
				break;
		}
	}

	pad(num, size) {
		num = num.toString();
		while (num.length < size) {
			num = "0" + num;
		}
		return num;
	}

	avg(numArr) {
		const sum = numArr.reduce((a, b) => a + b, 0);
		return Math.round(sum / numArr.length);
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			callback();
		} catch (e) {
			this.log.debug("Exception while unload: " + e);
			callback();
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}
}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new WetterCom(options);
} else {
	// otherwise start the instance directly
	new WetterCom();
}
