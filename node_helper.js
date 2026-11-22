/* MMM-Globe — Backend
 *
 * One cycle for both modes: determine the current state, fetch the image if it is new,
 * show it, schedule the next run. Everything else is a helper for that. The frontend
 * checks and decides nothing.
 *
 * The module knows the publication rhythm only for the sources in sources.js; there it
 * determines it by titration. An own URL is unknown to it, and it does not try to learn
 * about it: it is polled at the configured updateInterval.
 *
 * Stored state: lastId, anchor, since, lastPoll, imagePath, stale, payload.
 *
 * Modified: [2026-11-02 21:17] - Created
 * Modified: [2026-11-11 14:38] - Recreated as MMM-Globus-Neu2 after QA: titration and
 *                                grid for the own URL as well, archive mode by age of the
 *                                live image instead of a miss counter (works without an
 *                                anchor too), re-anchor after archive mode, anchor at poll
 *                                start, only newer register ids, atomic write, config
 *                                check, payload only on change, paths from the module
 *                                name, stop()
 * Modified: [2026-11-11 16:05] - Own URL back to a fixed interval without titration;
 *                                archive choice by day phase instead of sun altitude; log
 *                                per level via the matching console method, logLevel
 *                                case-insensitive, single attempts at debug, fetch failure
 *                                as warn; image check inside the retry loop; empty archive
 *                                reported once at start; stalled source as warn
 * Modified: [2026-11-11 16:09] - Dot marker in archive image pixels with defaults for size
 *                                and colour, free text label instead of "text", coastlines
 *                                only with own URL, start line in the log
 * Modified: [2026-11-11 16:25] - updateInterval null, "" or 0 gives the default instead of
 *                                the minimum
 * Modified: [2026-11-12 10:38] - Fetch errors in the log with the cause from error.cause
 * Modified: [2026-11-12 10:46] - staleFallbackMarker "off" in any case
 * Modified: [2026-11-12 11:01] - All comments and log messages in English
 * Modified: [2026-11-12 11:29] - Payload without imageSize and clipRadius, the frontend
 *                                reads them from its config; comment on the re-anchor
 *                                after an outage restored
 * Modified: [2026-11-12 11:33] - check() stores the config itself and returns true/false
 * Modified: [2026-11-22 11:05] - v3 transition: a v3 entry gets new_globe_config.js and the
 *                                notice image instead of the globe; createHash imported
 *                                directly, "crypto" collides with the browser global in lint
 * Modified: [2026-11-22 11:42] - Start warning on an unusable archive names v3-named images
 *                                and the v3 example
 * Modified: [2026-11-22 11:57] - The v3 transition logs the archive check as well
 * Modified: [2026-11-22 12:07] - switchToStaticIfStale default false, as in v3
 * Modified: [2026-11-22 12:11] - new_globe_config.js removed after the first valid v4 start
 * Modified: [2026-11-22 14:17] - v3 transition: clipRadius null means the same as in v3 again
 */

const NodeHelper = require("node_helper");
const SunCalc = require("suncalc");
const { createHash } = require("crypto");
const fs = require("fs");
const path = require("path");

const { SOURCES, SYNC_INTERVAL, BUFFER, registerUrl, readId, imageUrl, fileStamp } = require("./sources");

const DAY = 24 * 60 * 60 * 1000;
const STALE_LIMIT = 6;          // missed publications until archive mode
const REQUEST_TIMEOUT = 30000;  // per attempt
const ATTEMPTS = 3;
const RETRY_DELAY = 10000;
const MIN_UPDATE_INTERVAL = 5 * 60 * 1000;
const DEFAULT_UPDATE_INTERVAL = 15 * 60 * 1000;

const LEVELS = ["error", "warn", "info", "debug"];
const COASTLINES = ["europe", "americas", "pacific", "asia"];
const ARCHIVE_FILE = /^\d{8}-\d{4}\.(jpg|png|gif)$/;
const MARKER_DOT = /^(\d+):(\d+)(?::(\d+))?(?::(\S+))?$/;
const IMAGE_DIR = path.join(__dirname, "images");
const STATIC_DIR = path.join(__dirname, "static");
const CURRENT = path.join(IMAGE_DIR, "current.png");
const TRANSITION_FILE = path.join(__dirname, "new_globe_config.js");

// v3 transition. v3 style names and their v4 successor: the frozen Himawari-8 styles and
// the broken GOES-16 style map to the live SLIDER view of the same region, the discontinued
// EUMETSAT styles to the WMS default.
const V3_STYLES = {
	geoColorEurope: "europe", meteosat: "europe", geoColorUSA: "americas",
	geoColorPacific: "pacific", geoColorAsia: "asia",
	geoColor: "asia", natColor: "asia", airMass: "asia", fullBand: "asia",
	centralAmericaDiscNat: "americas", europeDiscNat: "", europeDiscSnow: ""
};
const V3_SLIDER = ["geoColorEurope", "meteosat", "geoColorUSA", "geoColorPacific", "geoColorAsia"];  // ignored ownImagePath
const V3_REMOVED = ["sliderPollInterval", "syncDelay", "retryDelay", "archiveSunPhase", "ownImagePath"];
const V3_DEFAULTS = {  // where they differ from v4
	updateInterval: "10 min",
	staleFallbackMarker: "\"330:75:4:cornflowerblue\"", logLevel: "\"ERROR\""
};
const V3_EXAMPLE = "773ba5d25b3c8e3537e52d7cb8c06a00e66f2434";  // sha1 of the shipped static/1200.jpg
const V4_STYLES = ["europe", "americas", "pacific", "asia", ""];
const V4_OPTIONS = ["style", "imageUrl", "updateInterval", "imageSize", "clipRadius", "coastlines",
	"switchToStaticIfStale", "staleFallbackMarker", "lat", "lon", "enableImageSaving", "logLevel"];

module.exports = NodeHelper.create({

	start () {
		this.running = false;
	},

	stop () {
		clearTimeout(this.timer);
	},

	socketNotificationReceived (notification, { config, data, defaults }) {
		if (notification !== "GLOBE_CONFIG") return;

		// A reload sends the config again. The cycle starts exactly once; after that the
		// frontend only gets the last payload sent.
		if (this.running) {
			if (this.payload) this.sendSocketNotification("GLOBE_IMAGE", this.payload);
			return;
		}
		this.running = true;

		this.web = `/modules/${this.name}`;
		if (this.isV3(data.config)) {
			this.transition(data, defaults);
			return;
		}
		if (!this.check(config)) return;
		this.removeTransitionFile();

		this.lastId = null;        // id or checksum of the live image shown
		this.anchor = null;        // time of an observed change; null = titration
		this.since = Date.now();   // last new live image, initially the start
		this.lastPoll = null;      // start of the previous poll
		this.imagePath = null;
		this.stale = false;
		this.payload = null;

		try {
			fs.mkdirSync(IMAGE_DIR, { recursive: true });
		} catch (error) {
			this.log("error", `Cannot create image directory: ${error.message}`);
			return;
		}
		this.log("info", this.source
			? `Start: style ${this.config.style} (${this.source.sat}), cadence ${this.cadence / 60000} min, grid by titration.`
			: `Start: own URL, fixed interval ${this.cadence / 60000} min.`);
		const problem = this.config.switchToStaticIfStale ? this.archiveProblem() : null;
		if (problem) this.log("warn", problem);
		this.tick();
	},

	/* Archive mode is enabled: why static/ holds nothing v4 can use, or null if it does. */
	archiveProblem () {
		if (this.archiveFiles().length) return null;
		const v3 = this.v3ArchiveFiles();
		if (v3.length) {
			const one = v3.length === 1;
			return `Archive mode is enabled, but the ${v3.length} archive image${one ? "" : "s"} in static/ ${one ? "uses" : "use"} the v3 naming (HHMM.jpg), which v4 does not use. `
				+ "Rename each to YYYYMMDD-HHMM.jpg with the UTC date and time it was taken, or build a new archive with enableImageSaving — see README, \"Archive mode\".";
		}
		const example = fs.existsSync(path.join(STATIC_DIR, "1200.jpg")) ? " static/1200.jpg is the v3 example, which v4 does not use." : "";
		return `Archive mode is enabled, but static/ contains no archive images — if the source stalls, the last live image stays.${example}`;
	},

	/* ---------- v3 transition ---------- */

	isV3 (raw = {}) {
		return Object.hasOwn(V3_STYLES, raw.style) || V3_REMOVED.some((key) => key in raw);
	},

	/* Archive images in the v3 naming HHMM.jpg, without the unchanged v3 example 1200.jpg. */
	v3ArchiveFiles () {
		try {
			return fs.readdirSync(STATIC_DIR).filter((f) => /^\d{4}\.jpg$/.test(f)
				&& !(f === "1200.jpg" && createHash("sha1").update(fs.readFileSync(path.join(STATIC_DIR, f))).digest("hex") === V3_EXAMPLE));
		} catch {
			return [];
		}
	},

	/* Write a complete v4 entry next to the module and show the notice image instead of the
	 * globe. Logged regardless of logLevel. */
	transition (data, defaults) {
		try {
			fs.writeFileSync(TRANSITION_FILE, this.v4Config(data, defaults));
			console.warn(`Your configuration is written for v3. A complete v4 configuration is in ${TRANSITION_FILE}.`);
		} catch (error) {
			console.error(`Your configuration is written for v3; writing ${TRANSITION_FILE} failed: ${error.message}. See the README, section "Upgrading from v3".`);
		}
		const problem = data.config.switchToStaticIfStale ? this.archiveProblem() : null;
		if (problem) console.warn(problem);
		this.payload = { notice: `${this.web}/MMM-Globe-Configuration-Has-Changed.png` };
		this.sendSocketNotification("GLOBE_IMAGE", this.payload);
	},

	/* After a valid v4 start the file of the transition has served its purpose. Only then:
	 * with a mistyped config it is still there to compare. */
	removeTransitionFile () {
		if (!fs.existsSync(TRANSITION_FILE)) return;
		try {
			fs.rmSync(TRANSITION_FILE);
			console.info(`${TRANSITION_FILE} removed — the move to v4 is complete.`);
		} catch (error) {
			this.log("warn", `Cannot remove ${TRANSITION_FILE}: ${error.message}`);
		}
	},

	/* The complete v4 entry as JavaScript text, with the changes listed on top. Only
	 * unambiguous values are carried over; everything else gets the v4 default and a
	 * comment. data is the module entry as written in config.js. */
	v4Config (data, defaults) {
		const raw = data.config || {};
		const notes = [];
		const value = {};
		const comment = {};

		for (const key of V4_OPTIONS) {
			if (key in raw) {
				value[key] = raw[key];
				comment[key] = "from your v3 config";
			} else {
				value[key] = defaults[key];
				comment[key] = V3_DEFAULTS[key] ? `v4 default — v3 default was ${V3_DEFAULTS[key]}` : "v4 default";
			}
		}

		const old = raw.style;
		if (V3_SLIDER.includes(old)) {
			value.style = V3_STYLES[old];
			comment.style = `v4: was "${old}"`;
			if (raw.ownImagePath) notes.push("ownImagePath was ignored by v3 with your style and is left out.");
		} else if (raw.ownImagePath) {
			value.style = "";
			value.imageUrl = raw.ownImagePath;
			comment.style = "v4: \"\" uses imageUrl";
			comment.imageUrl = "v4: was ownImagePath";
		} else if (V4_STYLES.includes(old)) {
			// already a v4 name
		} else if (Object.hasOwn(V3_STYLES, old ?? "geoColor")) {
			const name = old ?? "geoColor";
			value.style = V3_STYLES[name];
			comment.style = `CHECK — v4: was "${name}"${old ? "" : " (v3 default)"}, which no longer works`;
			if (value.style === "") {
				comment.imageUrl = `v4: EUMETSAT WMS, replaces "${name}"`;
				if (!raw.coastlines) {
					value.coastlines = "europe";
					comment.coastlines = `v4: the WMS has no coastlines, "${name}" had`;
				}
			}
		} else {
			comment.style = `CHECK — your value "${old}" is unknown, v4 default`;
			value.style = defaults.style;
		}
		if (value.style && raw.coastlines) comment.coastlines = "CHECK — applies only with style \"\" (own URL)";

		for (const key of V3_REMOVED) {
			if (key in raw && key !== "ownImagePath") notes.push(`${key}: no longer used, left out.`);
		}
		for (const key of Object.keys(raw)) {
			if (!V4_OPTIONS.includes(key) && !V3_REMOVED.includes(key)) notes.push(`${key}: unknown option, left out.`);
		}
		// v3 archive images are named HHMM.jpg. Only the user knows the date of each, so the
		// note names the ways and renames nothing.
		const archive = raw.switchToStaticIfStale ? this.v3ArchiveFiles() : [];
		if (archive.length) {
			notes.push(`Archive: static/ holds ${archive.length} archive image${archive.length === 1 ? "" : "s"} in the v3 naming (HHMM.jpg). v4 does not use\n`
				+ " *     them: it names archive images YYYYMMDD-HHMM.jpg, with the UTC date and time each image\n"
				+ " *     was taken, and uses the date to match day and night. Two ways:\n"
				+ " *     1. Rename your images yourself, each with the date and time it was taken.\n"
				+ " *     2. Build a new archive: with enableImageSaving: true the module saves every live image\n"
				+ " *        under images/, already named correctly; copy the ones you want to static/.");
		}

		// Whole minutes are written as in the README, e.g. 15 * 60 * 1000.
		const text = (key, val) => (key === "updateInterval" && Number.isInteger(val / 60000) ? `${val / 60000} * 60 * 1000` : JSON.stringify(val));
		const line = (indent, key, val, note, last) => `${`${indent}${key}: ${text(key, val)}${last ? "" : ","}`.padEnd(47)} // ${note}`;
		const entries = [];
		for (const key of ["position", "header", "animateIn", "animateOut", "hiddenOnStartup"]) {
			if (data[key] !== undefined) entries.push(line("\t", key, data[key], "from your v3 config"));
		}
		if (data.order) entries.push(line("\t", "order", data.order, "from your v3 config"));
		const classes = String(data.classes || "").replace(/\s*\bMMM-Globe$/, "");
		if (classes) entries.push(line("\t", "classes", classes, "from your v3 config"));
		const options = V4_OPTIONS.map((key, i) => line("\t\t", key, value[key], comment[key], i === V4_OPTIONS.length - 1));

		return [
			"/* MMM-Globe v4 — complete configuration, ready to copy into config.js.",
			" *",
			" * Your config.js has NOT been changed, and your own comments in it are not included here.",
			" * Replace your MMM-Globe entry with the block below and check the lines marked CHECK.",
			...(notes.length ? [" * Further changes compared with your v3 configuration:", ...notes.map((n) => ` *   - ${n}`)] : []),
			" * All options: README, section \"Configuration\"; the move: section \"Upgrading from v3\".",
			" */",
			"{",
			"\tmodule: \"MMM-Globe\",",
			...entries,
			"\tconfig: {",
			...options,
			"\t}",
			"},",
			""
		].join("\n");
	},

	/* ---------- Configuration ---------- */

	/* Checks only what would otherwise lead to misbehaviour and stores the cleaned config
	 * in this.config. Returns false if the module cannot work with it. */
	check (raw) {
		const config = { ...raw, logLevel: String(raw.logLevel || "").toLowerCase() };
		this.config = config;   // set first, so that log() works already here
		if (!LEVELS.includes(config.logLevel)) {
			config.logLevel = "info";
			this.log("warn", `logLevel "${raw.logLevel}" is unknown — using "info".`);
		}

		if (config.style) {
			if (!Object.hasOwn(SOURCES, config.style)) {
				this.log("error", `style "${config.style}" is unknown — allowed are ${Object.keys(SOURCES).join(", ")} or "" for imageUrl. The module stays empty.`);
				return false;
			}
			this.source = SOURCES[config.style];
			this.cadence = this.source.cadence;
		} else {
			if (!config.imageUrl) {
				this.log("error", "Neither style nor imageUrl is set — the module stays empty.");
				return false;
			}
			const interval = Number(config.updateInterval);
			this.source = null;
			// Number(null) and Number("") are 0 — only a number above 0 is a value.
			this.cadence = interval > 0 ? Math.max(interval, MIN_UPDATE_INTERVAL) : DEFAULT_UPDATE_INTERVAL;
			if (this.cadence !== interval) {
				this.log("warn", `updateInterval "${config.updateInterval}" is invalid or too small — using ${this.cadence / 60000} min.`);
			}
		}

		// The coastline overlays belong to the own URL; the SLIDER images do not need them.
		if (config.coastlines && config.style) {
			this.log("warn", "coastlines only applies to imageUrl — ignored with a style.");
			config.coastlines = false;
		} else if (config.coastlines && !COASTLINES.includes(config.coastlines)) {
			this.log("warn", `coastlines "${config.coastlines}" is unknown — allowed are ${COASTLINES.join(", ")}. No coastlines.`);
			config.coastlines = false;
		}

		config.marker = this.marker(config.staleFallbackMarker);
		return true;
	},

	/* "off" | "X:Y[:Px[:Colour]]" for a dot | any other text as a label.
	 * X, Y and Px are pixels in the archive image, from the top left. */
	marker (raw) {
		const value = String(raw || "off");
		if (value.toLowerCase() === "off") return null;

		const dot = value.match(MARKER_DOT);
		if (!dot) return { type: "text", text: value };
		return {
			type: "dot", x: Number(dot[1]), y: Number(dot[2]),
			size: dot[3] ? Number(dot[3]) : 4, color: dot[4] || "cornflowerblue"
		};
	},

	/* ---------- Cycle ---------- */

	async tick () {
		const started = Date.now();
		const before = this.lastId;
		let fresh = false;
		try {
			fresh = this.source ? await this.pollRegister() : await this.pollPlain();
		} catch (error) {
			this.log("error", `Unexpected error in poll cycle: ${error.message}`);
		}

		if (this.source) this.titrate(fresh, before, started);
		if (fresh) this.since = Date.now();
		this.lastPoll = started;

		try {
			this.send();
		} catch (error) {
			this.log("error", `Unexpected error while sending: ${error.message}`);
		}
		this.schedule(started);
	},

	/* Keep the grid of a known source: set the anchor, release it after an outage. */
	titrate (fresh, before, started) {
		if (fresh) {
			if (this.stale && this.anchor !== null) {
				// After an outage of days or weeks the source may return with a different grid.
				this.anchor = null;
				this.log("info", "Source delivers again — determining the grid anew.");
			} else if (this.anchor === null && before !== null && this.lastPoll !== null
				&& started - this.lastPoll <= 2 * SYNC_INTERVAL) {
				// The anchor is only set on a closely observed change. The first image after
				// start only shows what was already there; a change after a long pause does
				// not reveal when it happened.
				this.anchor = started;
				this.log("info", `Anchor set: ${new Date(this.anchor).toISOString()}`);
			}
		} else if (this.anchor !== null) {
			// A publication is missing. It will not come later; the gap stays, the next
			// image comes on the grid.
			this.log("info", "No new image — gap, staying on the grid.");
		}
	},

	/* Source with a register: first the id, the image only for a newer one. An older id
	 * would come from a lagging cache and bring back a replaced image. */
	async pollRegister () {
		const json = await this.fetchJson(registerUrl(this.source));
		if (!json) return false;

		const id = readId(json);
		if (!id) {
			this.log("warn", "Register without a readable id.");
			return false;
		}
		const fresh = this.lastId === null || id > this.lastId;
		this.log("debug", `Register: ${id}${fresh ? " (new)" : " (unchanged)"}`);
		if (!fresh) return false;

		const image = await this.fetchImage(imageUrl(this.source, id));
		if (!image) return false;

		this.show(image, fileStamp(id));
		this.lastId = id;
		return true;
	},

	/* Own URL: no register, a checksum instead of an id. */
	async pollPlain () {
		const image = await this.fetchImage(this.config.imageUrl);
		if (!image) return false;

		const hash = createHash("sha1").update(image).digest("hex");
		const fresh = hash !== this.lastId;
		this.log("debug", `Own URL: ${hash.slice(0, 12)}${fresh ? " (new)" : " (unchanged)"}`);
		if (!fresh) return false;

		this.show(image, this.utcStamp(new Date()));
		this.lastId = hash;
		return true;
	},

	/* Determine the next run and start the cycle again then. */
	schedule (started) {
		const now = Date.now();
		let next;

		if (!this.source) {
			next = started + this.cadence;  // own URL: fixed interval from the start of the poll
		} else if (this.anchor !== null) {
			// Next grid point after the anchor that still lies ahead.
			const k = Math.max(1, Math.floor((now - this.anchor - BUFFER) / this.cadence) + 1);
			next = this.anchor + k * this.cadence + BUFFER;
		} else if (now - this.since <= this.cadence + SYNC_INTERVAL) {
			next = now + SYNC_INTERVAL;     // titration: a change is due within one cadence
		} else {
			next = now + this.cadence;      // source is not delivering: once per cadence
		}

		const wait = Math.max(next - now, 1000);
		this.log("debug", `Next poll in ${Math.round(wait / 1000)} s.`);
		this.timer = setTimeout(() => this.tick(), wait);
	},

	/* ---------- Image ---------- */

	/* Take over a live image: write it atomically so the browser never reads half a file;
	 * save a copy if enabled. Throws if writing fails. */
	show (image, stamp) {
		const temp = `${CURRENT}.tmp`;
		fs.writeFileSync(temp, image);
		fs.renameSync(temp, CURRENT);
		this.imagePath = `${this.web}/images/current.png?t=${Date.now()}`;
		this.log("info", `Image ${stamp} shown.`);
		if (this.config.enableImageSaving) this.save(image, stamp);
	},

	/* Save under the name the archive expects as well. */
	save (image, stamp) {
		const file = path.join(IMAGE_DIR, `${stamp}.${this.imageType(image)}`);
		try {
			if (fs.existsSync(file)) return;
			fs.writeFileSync(file, image);
			this.log("debug", `Saved: ${path.basename(file)}`);
		} catch (error) {
			this.log("warn", `Saving failed: ${error.message}`);
		}
	},

	archiveFiles () {
		try {
			return fs.readdirSync(STATIC_DIR).filter((f) => ARCHIVE_FILE.test(f));
		} catch {
			return [];
		}
	},

	/* Archive image: the file whose day phase at the location is closest to the current
	 * one. Sunrise meets sunrise, noon meets noon and night meets night, even if the
	 * archive comes from another season. null without archive images. */
	archiveImage () {
		const files = this.archiveFiles();
		if (!files.length) return null;

		// Without sunrise or sunset today (polar regions), UTC time of day applies to all.
		const now = Date.now();
		const polar = this.phase(now) === null;
		const key = (time) => (polar ? null : this.phase(time)) ?? 2 * (time % DAY) / DAY;
		const ref = key(now);

		let best = null;
		let bestDiff = Infinity;
		for (const file of files) {
			const diff = Math.abs(key(this.stampDate(file).getTime()) - ref);
			const circular = Math.min(diff, 2 - diff);
			if (circular < bestDiff) {
				bestDiff = circular;
				best = file;
			}
		}
		this.log("debug", `Archive image: ${best}`);
		return `${this.web}/static/${best}`;
	},

	/* Day phase at the location: 0 to 1 from sunrise to sunset, 1 to 2 through the night
	 * to the next sunrise. null without sunrise or sunset. */
	phase (time) {
		const times = (t) => SunCalc.getTimes(new Date(t), this.config.lat, this.config.lon);
		const { sunrise, sunset } = times(time);
		const rise = sunrise.getTime();
		const set = sunset.getTime();
		let phase;
		if (time < rise) {
			const before = times(time - DAY).sunset.getTime();
			phase = 1 + (time - before) / (rise - before);
		} else if (time > set) {
			const after = times(time + DAY).sunrise.getTime();
			phase = 1 + (time - set) / (after - set);
		} else {
			phase = (time - rise) / (set - rise);
		}
		return Number.isFinite(phase) && phase >= 0 && phase <= 2 ? phase : null;
	},

	/* ---------- Payload ---------- */

	/* Live image while the source delivers; otherwise an archive image. Only sent if it
	 * differs from the last payload. */
	send () {
		// Six missed publications; the half cadence absorbs the duration of the poll.
		const stale = Date.now() - this.since > (STALE_LIMIT - 0.5) * this.cadence;
		if (stale !== this.stale) {
			if (stale) this.log("warn", `No new image for ${STALE_LIMIT} publications.`);
			else this.log("info", "Live image current again.");
			this.stale = stale;
		}

		const archive = stale && this.config.switchToStaticIfStale ? this.archiveImage() : null;
		const url = archive || this.imagePath;
		if (!url) return;

		const payload = {
			url,
			// Archive images carry their lines in the image already.
			overlay: !archive && this.config.coastlines ? `${this.web}/coastlines_${this.config.coastlines}.png` : null,
			marker: archive ? this.config.marker : null
		};
		if (this.payload && JSON.stringify(payload) === JSON.stringify(this.payload)) return;

		this.payload = payload;
		this.sendSocketNotification("GLOBE_IMAGE", payload);
	},

	/* ---------- Fetch ---------- */

	async fetchJson (url) {
		const body = await this.fetch(url, false);
		if (!body) return null;
		try {
			return JSON.parse(body.toString("utf8"));
		} catch (error) {
			this.log("warn", `Register unreadable: ${error.message}`);
			return null;
		}
	},

	async fetchImage (url) {
		return this.fetch(url, true);
	},

	/* Three attempts, timeout per attempt. With image, a response without image data
	 * (an error page with HTTP 200) counts as a failed attempt. Returns the body or null.
	 * A failed fetch is a gap in the source, not an error of the module. */
	async fetch (url, image) {
		for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
			try {
				const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
				if (!response.ok) throw new Error(`HTTP ${response.status}`);
				const body = Buffer.from(await response.arrayBuffer());
				if (image && !this.imageType(body)) throw new Error(`no image data (${body.length} bytes)`);
				return body;
			} catch (error) {
				// For network errors message only says "fetch failed"; the reason is in cause.
				const reason = error.cause ? `${error.message} (${error.cause.code || error.cause.message})` : error.message;
				if (attempt === ATTEMPTS) {
					this.log("warn", `Fetch failed after ${ATTEMPTS} attempts: ${reason} — ${url}`);
					return null;
				}
				this.log("debug", `Fetch failed (${attempt}/${ATTEMPTS}): ${reason}`);
				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
			}
		}
		return null;
	},

	/* Magic bytes instead of a minimum size: also detects an error page with HTTP 200.
	 * Returns the file extension or null. */
	imageType (body) {
		if (body.length < 8) return null;
		if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
		if (body[0] === 0xff && body[1] === 0xd8) return "jpg";
		if (body.subarray(0, 3).toString("latin1") === "GIF") return "gif";
		return null;
	},

	/* ---------- Small helpers ---------- */

	utcStamp (date) {
		return date.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
	},

	stampDate (file) {
		return new Date(Date.UTC(
			Number(file.slice(0, 4)), Number(file.slice(4, 6)) - 1, Number(file.slice(6, 8)),
			Number(file.slice(9, 11)), Number(file.slice(11, 13))
		));
	},

	/* MagicMirror prefixes every line with the module name itself. One console method per
	 * level, so that the mirror's label applies and errors go to stderr. */
	log (level, message) {
		if (LEVELS.indexOf(level) <= LEVELS.indexOf(this.config.logLevel)) {
			console[level](message);
		}
	}
});
