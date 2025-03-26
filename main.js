/* eslint-disable indent */
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
			name: "wettercom",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("unload", this.onUnload.bind(this));

		this.pre_url = "https://forecast.meteonomiqs.com/v3_1/forecast/";
		this.post_url = "/hourly";

		this.summaryMap = new Map();
		this.weatherStateMap = new Map([
			[0, "sonnig"],
			[1, "leicht bewölkt"],
			[2, "wolkig"],
			[3, "bedeckt"],
			[4, "Nebel"],
			[5, "Sprühregen"],
			[6, "Regen"],
			[7, "Schnee"],
			[8, "Schauer"],
			[9, "Gewitter"],
			[10, "teilweise bewölkt"],
			[20, "wolkig"],
			[21, "wolkig"],
			[30, "bedeckt"],
			[40, "Nebel"],
			[45, "Nebel"],
			[48, "Nebel mit Frosterscheinungen"],
			[49, "Nebel mit Frosterscheinungen"],
			[51, "leichter Sprühregen"],
			[55, "starker Sprühregen"],
			[56, "leichter Sprühregen, Frost"],
			[57, "starker Sprühregen, Frost"],
			[60, "leichter Regen"],
			[61, "leichter Regen"],
			[63, "mäßiger Regen"],
			[65, "starker Regen"],
			[66, "leichter gefrierender Regen"],
			[67, "mäßiger bis starker gefrierender Regen"],
			[68, "leichter Schneeregen"],
			[69, "starker Schneeregen"],
			[70, "leichter Schneefall"],
			[71, "leichter Schneefall"],
			[73, "mäßiger Schneefall"],
			[75, "starker Schneefall"],
			[80, "leichter Schauer"],
			[81, "Schauer"],
			[82, "starker Schauer"],
			[83, "leichter Schneeschauer"],
			[84, "starker Schneeschauer"],
			[85, "leichter Schneefall"],
			[86, "mäßiger bis starker Schneefall"],
			[95, "leichtes Gewitter"],
			[96, "schweres Gewitter"],
		]);
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
				this.log.error(
					"Failed to get data. Check your API-key first. Server responsed with " +
						error.response.status +
						": " +
						error.response.statusText,
				);
			});

		//Bei Fehlern, beenden
		if (!response) {
			this.terminate
				? this.terminate(
						"No data to parse so terminating adapter.",
						utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION,
					)
				: process.exit(utils.EXIT_CODES.ADAPTER_REQUESTED_TERMINATION);
			return;
		}

		if (response.items) {
			//Remove old Datapoints
			await this.delObjectAsync("", { recursive: true });
			this.log.debug("Removing old structure... done");

			//Create Datapoints
			let date = "";
			let dayCounter = 0;
			for (let i = 0; i < response.items.length; i++) {
				const item = response.items[i];
				const curDate = new Date(item.date);

				if (date !== curDate.toLocaleDateString()) {
					dayCounter++;
					if (dayCounter > this.config.forecastDays) {
						break;
					}
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
			this.log.debug("Creating new structure... done");

			await this.createSummaryDP();
			this.log.debug("Creating summary... done");
		}

		this.terminate
			? this.terminate("Exit, all done", utils.EXIT_CODES.NO_ERROR)
			: process.exit(utils.EXIT_CODES.NO_ERROR);
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
			await this.setObjectNotExistsAsync(key.replace(this.FORBIDDEN_CHARS, "_") + ".date", {
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
			await this.setObjectNotExistsAsync(key.replace(this.FORBIDDEN_CHARS, "_") + ".day", {
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

			//Wettersymbol
			const summaryState = this.getMostOftenWeatherState(value.iconStateHours)[0];
			await this.setObjectNotExistsAsync(key.replace(this.FORBIDDEN_CHARS, "_") + ".weatherIcon", {
				type: "state",
				common: {
					name: "weathericon",
					type: "string",
					role: "indicator",
					write: false,
					read: true,
				},
				native: {},
			});
			this.setState(
				key + ".weatherIcon",
				"/adapter/" + this.name + "/icons/weather/svg/d_" + summaryState + ".svg",
				true,
			);
			//Wettertext
			await this.setObjectNotExistsAsync(key.replace(this.FORBIDDEN_CHARS, "_") + ".weatherText", {
				type: "state",
				common: {
					name: "weathertext",
					type: "string",
					role: "indicator",
					write: false,
					read: true,
				},
				native: {},
			});
			// @ts-ignore
			this.setState(key + ".weatherText", this.weatherStateMap.get(summaryState), true);
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
				iconStateHours: [],
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
		//Wettersymbol
		entry.iconStateHours.push(item.weather.state);
	}

	async createNumberObjectNotExists(id, name, def, unit) {
		await this.setObjectNotExistsAsync((id + "." + name).replace(this.FORBIDDEN_CHARS, "_"), {
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

	getMostOftenWeatherState(arr) {
		return arr
			.sort((a, b) => a - b)
			.reduce(
				// @ts-ignore
				(acc, cur, i, { [i - 1]: last }) =>
					(cur === last ? acc[acc.length - 1].push(cur) : acc.push([cur])) && acc,
				[],
			)
			.sort((a, b) => b.length - a.length)
			.reduce((a, b, _, [first]) => (first.length === b.length ? [...a, b[0]] : a), []);
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
