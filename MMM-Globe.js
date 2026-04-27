/* global Module */

/* Magic Mirror
 * Module: MMM-Globe
 *
 * By Luke Scheffler https://github.com/LukeSkywalker92
 * Fork maintainer: Dr. Ralf Korell https://github.com/rkorell
 * MIT Licensed.
 */

Module.register("MMM-Globe", {
  defaults: {
    style: "geoColor",
    imageSize: 600,
    ownImagePath: "",
    updateInterval: 10 * 60 * 1000,  // 10 minutes
    retryDelay: 30 * 1000,           // retry delay on load failure (30 seconds)
    enableImageSaving: false,         // save satellite images locally (images/ subfolder)
    coastlines: false,                // false, "europe", "americas", "asia"
    logLevel: "ERROR",                  // "ERROR", "WARN", "INFO", "DEBUG"
    switchToStaticIfStale: false,      // true: show static fallback images when live feed is stale (>90min unchanged)
    staleFallbackMarker: "330:75:4:cornflowerblue",  // "off", "X:Y:Px:Color" for dot, or any text for label
    archiveSunPhase: "",               // "HHMM:HHMM" sunrise:sunset UTC of archive images, e.g. "0730:1830"
    lat: 50.24127,                     // Mirror location latitude (for seasonal sun phase mapping)
    lon: 6.6174403                     // Mirror location longitude
  },

  // SLIDER style names (must match keys in node_helper SLIDER_SATELLITES + alias)
  SLIDER_STYLES: ["geoColorEurope", "geoColorUSA", "geoColorPacific", "geoColorAsia", "meteosat"],

  start: function() {
    this.loadedImage = null;
    this.fallbackText = null;  // Text marker for stale fallback mode

    // All fetching runs in node_helper — send config once
    this.sendSocketNotification("START_POLL", {
      style: this.config.style,
      imageSize: this.config.imageSize,
      ownImagePath: this.config.ownImagePath,
      updateInterval: this.config.updateInterval,
      retryDelay: this.config.retryDelay,
      enableImageSaving: this.config.enableImageSaving,
      logLevel: this.config.logLevel,
      switchToStaticIfStale: this.config.switchToStaticIfStale,
      staleFallbackMarker: this.config.staleFallbackMarker,
      archiveSunPhase: this.config.archiveSunPhase,
      lat: this.config.lat,
      lon: this.config.lon
    });

    // Self-recovery: load current.png immediately if it exists (e.g. after browser refresh)
    var self = this;
    var currentUrl = "/modules/MMM-Globe/images/current.png?t=" + Date.now();
    this._loadImage(currentUrl).then(function(result) {
      if (!result.isError && !self.loadedImage) {
        self.loadedImage = result.image;
        self.updateDom(1000);
      }
    });
  },

  // Handle image URL from node_helper
  socketNotificationReceived: function(notification, payload) {
    if (notification === "IMAGE_READY") {
      var self = this;
      this.fallbackText = payload.fallbackText || null;
      this._loadImage(payload.url).then(function(result) {
        if (!result.isError) {
          self.loadedImage = result.image;
          self.updateDom(1000);
        } else {
          Log.warn("MMM-Globe: Failed to load image from " + payload.url);
        }
      });
    }
  },

  // Promise based image loader with error handling (module-scoped to avoid global conflicts)
  _loadImage: function(src) {
    return new Promise(function(resolve) {
      var image = new Image();
      image.onload = function() { resolve({ image: image, isError: false }); };
      image.onerror = function() { resolve({ image: image, isError: true }); };
      image.src = src;
    });
  },

  getStyles: function() {
    return ["MMM-Globe.css"];
  },

  getDom: function() {
    var wrapper = document.createElement("div");

    if (this.loadedImage) {
      // Coastlines only for static styles — SLIDER images have natural coastlines
      var isSliderStyle = this.SLIDER_STYLES.indexOf(this.config.style) !== -1;
      var useCoastlines = !isSliderStyle && this.config.coastlines &&
        ["europe", "americas", "asia"].indexOf(this.config.coastlines) !== -1;

      if (useCoastlines) {
        var container = document.createElement("div");
        container.className = "MMM-Globe-container";

        var coastlines = document.createElement("img");
        coastlines.className = "MMM-Globe-coastlines";
        coastlines.src = this.file("coastlines_" + this.config.coastlines + ".png");
        coastlines.width = this.config.imageSize.toString();
        coastlines.height = this.config.imageSize.toString();
        container.appendChild(coastlines);

        var image = this.loadedImage.cloneNode();
        if (this.config.style === "centralAmericaDiscNat") {
          image.className = "MMM-Globe-image-centralAmericaDiscNat-blended";
        } else {
          image.className = "MMM-Globe-image-blended";
        }
        image.width = this.config.imageSize.toString();
        image.height = this.config.imageSize.toString();
        container.appendChild(image);

        wrapper.appendChild(container);
      } else {
        var image = this.loadedImage.cloneNode();
        if (this.config.style === "centralAmericaDiscNat") {
          image.className = "MMM-Globe-image-centralAmericaDiscNat";
        } else {
          image.className = "MMM-Globe-image";
        }
        image.width = this.config.imageSize.toString();
        image.height = this.config.imageSize.toString();
        var container = document.createElement("div");
        container.className = "MMM-Globe-container";
        container.appendChild(image);
        wrapper.appendChild(container);
      }

      // Show text marker for stale fallback mode
      if (this.fallbackText) {
        var fallbackLabel = document.createElement("div");
        fallbackLabel.className = "MMM-Globe-fallback-text dimmed";
        fallbackLabel.textContent = this.fallbackText;
        wrapper.appendChild(fallbackLabel);
      }
    }

    return wrapper;
  }
});
