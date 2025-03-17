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
			for (let i = 0; i < response.items.length; i++) {
				const item = response.items[i];

				const channelName = item.date.replace(this.FORBIDDEN_CHARS, "_");
				await this.setObjectNotExistsAsync(channelName, {
					type: "channel",
					common: {
						name: item.date,
					},
					native: {},
				});

				this.createDpWithState(channelName, item);
			}
		}
	}

	async createDpWithState(channelName, item) {
		const keys = Object.keys(item).filter((key) => key !== "date");
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
					value = "/adapter/" + this.name + "/icons/svg/" + value;
				}
				this.setState(channelName + "." + key, value, true);
			}
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			callback();
		} catch (e) {
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
