/* MMM-Globe — Frontend
 *
 * Pure display. No timers, no fetches, no checks: it draws the payload the backend
 * sends, and nothing else. The elements are created once and afterwards only get new
 * values — so the old image stays until the new one has loaded, and the globe does not
 * flash empty on a change.
 *
 * Modified: [2026-11-02 21:17] - Created
 * Modified: [2026-11-11 14:38] - Recreated as MMM-Globus-Neu2 after QA: fixed elements
 *                                instead of rebuilding, module name instead of fixed names,
 *                                updateInterval default 15 min (cadence of the WMS)
 * Modified: [2026-11-11 16:09] - Dot in archive image pixels, placed after loading; label
 *                                from the config
 * Modified: [2026-11-12 11:01] - All comments in English
 * Modified: [2026-11-12 11:29] - imageSize and clipRadius from the own config instead of
 *                                the payload
 * Modified: [2026-11-22 11:05] - v3 transition: sends the module data as written in
 *                                config.js, shows the notice image instead of the globe
 * Modified: [2026-11-22 12:07] - switchToStaticIfStale default false: no archive is shipped
 */

Module.register("MMM-Globe", {

	defaults: {
		style: "europe",
		imageUrl: "https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.3.0&request=GetMap"
			+ "&layers=msg_fes:rgb_naturalenhncd&bbox=-6500000,-6500000,6500000,6500000"
			+ "&width=600&height=600&CRS=AUTO:42003,9001,0,0&styles=&format=image/png&BGCOLOR=0x000000",
		updateInterval: 15 * 60 * 1000,
		imageSize: 600,
		clipRadius: 48.55,
		coastlines: false,
		switchToStaticIfStale: false,
		staleFallbackMarker: "off",
		lat: 52.52,
		lon: 13.405,
		enableImageSaving: false,
		logLevel: "info"
	},

	getStyles () {
		return [`${this.name}.css`];
	},

	start () {
		this.payload = null;
		this.dom = null;
		// data (the entry as written in config.js) and defaults serve the v3 transition.
		this.sendSocketNotification("GLOBE_CONFIG", { config: this.config, data: this.data, defaults: this.defaults });
	},

	socketNotificationReceived (notification, payload) {
		if (notification !== "GLOBE_IMAGE") return;
		this.payload = payload;
		this.updateDom();
	},

	getDom () {
		if (!this.dom) this.dom = this.build();
		const { wrapper, globe, lines, image, note, notice } = this.dom;
		const payload = this.payload;
		const { imageSize, clipRadius } = this.config;

		globe.style.display = payload && !payload.notice ? "" : "none";
		notice.style.display = payload && payload.notice ? "" : "none";
		note.style.display = "none";
		if (!payload) return wrapper;

		if (payload.notice) {
			// v3 config found: the notice replaces the globe, at most at its own 400 px.
			notice.style.width = `${Math.min(imageSize, 400)}px`;
			this.setSource(notice, payload.notice);
			return wrapper;
		}

		globe.style.width = `${imageSize}px`;
		globe.style.height = `${imageSize}px`;
		globe.style.clipPath = clipRadius === null ? "" : `circle(${clipRadius}% at 50% 50%)`;

		lines.style.display = payload.overlay ? "" : "none";
		if (payload.overlay) this.setSource(lines, payload.overlay);
		this.setSource(image, payload.url);

		const marker = payload.marker;
		if (marker && marker.type === "text") {
			note.textContent = marker.text;
			note.style.display = "";
		}
		this.placeDot();

		return wrapper;
	},

	/* Dot in pixels of the archive image, converted to the display. Only once the image it
	 * belongs to has loaded — before that the browser does not know its size, and the dot
	 * would sit on the predecessor still visible. */
	placeDot () {
		const { image, dot } = this.dom;
		const marker = this.payload && this.payload.marker;
		const ready = image.complete && image.naturalWidth > 0;
		if (!marker || marker.type !== "dot" || !ready) {
			dot.style.display = "none";
			return;
		}
		const scale = this.config.imageSize / image.naturalWidth;
		dot.style.left = `${marker.x * 100 / image.naturalWidth}%`;
		dot.style.top = `${marker.y * 100 / image.naturalHeight}%`;
		dot.style.width = `${marker.size * scale}px`;
		dot.style.height = `${marker.size * scale}px`;
		dot.style.background = marker.color;
		dot.style.display = "";
	},

	/* The elements in their fixed order: lines below the image, dot above it. */
	build () {
		const create = (tag, className, parent) => {
			const element = document.createElement(tag);
			element.className = className;
			parent.appendChild(element);
			return element;
		};
		const wrapper = document.createElement("div");
		wrapper.className = "mmm-globe";
		const globe = create("div", "globe", wrapper);
		const lines = create("img", "coastlines", globe);
		const image = create("img", "satellite", globe);
		const dot = create("div", "marker-dot", globe);
		const note = create("div", "marker-text dimmed", wrapper);
		const notice = create("img", "notice", wrapper);
		image.addEventListener("load", () => this.placeDot());
		return { wrapper, globe, lines, image, dot, note, notice };
	},

	/* Set only a new address; setting the same one again would start a new load. */
	setSource (element, url) {
		if (element.getAttribute("src") !== url) element.src = url;
	}
});
