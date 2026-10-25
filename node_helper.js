/* node_helper for MMM-Globe.
 * All image fetching runs here (server-side). The frontend only receives
 * a local file path and handles display.
 *
 * Two polling modes:
 * - pollSlider (SLIDER styles: geoColorEurope/USA/Pacific/Asia, alias "meteosat"):
 *   polls CIRA SLIDER API at configured sliderPollInterval (10 min default,
 *   60s minimum), detects new images by comparing timestamps.
 *   Supports four satellites: Meteosat-0deg, GOES-19, GOES-18, Himawari.
 * - pollStatic (all other styles + ownImagePath): polls at configured
 *   updateInterval.
 *
 * Grid sync (syncDelay > 0, SLIDER styles only): the publication phase of the
 * service is unknown at startup, so the module titrates it. The first list
 * fetch is a reference only; from there the list is polled every syncDelay
 * until the newest entry changes. That moment plus syncDelay is the grid
 * origin, and every further poll happens at origin + n * cadence. The cadence
 * is the user's sliderPollInterval; the gaps in the list are measured only to
 * verify it. An empty grid point is followed up to three times at syncDelay
 * and then skipped — neither follow-ups nor interface errors move the grid.
 *
 * Both modes call downloadAndServe() which downloads the image and writes
 * current.png for the frontend. When enableImageSaving is true, a
 * timestamped copy is also saved to the images/ subfolder.
 *
 * Stale fallback (switchToStaticIfStale): When the live image has not been
 * updated for 90 minutes (via Last-Modified header), the module serves
 * pre-rendered static images from the static/ subfolder, matched to the
 * current UTC time. A configurable dot or text marker indicates archive mode.
 */
// Modified: 2026-06-04 - Validate PNG/JPEG/GIF magic bytes, retry on validation failure (PSC-aware)
// Modified: 2026-06-04 - Lazy-load static fallback index (only when first stale event triggers)
// Modified: 2026-10-22 12:46 - Add sliderPollInterval config option, clamped to 60s minimum (issue #2)
// Modified: 2026-10-22 23:40 - Single SLIDER poll timer; keep slot open when the image download fails (issue #2)
// Modified: 2026-10-25 14:10 - Add syncDelay grid sync, raise sliderPollInterval default to 10 min, retry all interface errors

const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const SunCalc = require("suncalc");

const SLIDER_BASE_URL = "https://slider.cira.colostate.edu";
const SLIDER_PRODUCT = "full_disk/geocolor";
const SLIDER_SATELLITES = {
  geoColorEurope:  "meteosat-0deg",
  geoColorUSA:     "goes-19",
  geoColorPacific: "goes-18",
  geoColorAsia:    "himawari"
};
const SLIDER_POLL_INTERVAL = 10 * 60 * 1000;  // default for config.sliderPollInterval
const SLIDER_MIN_INTERVAL = 60 * 1000;        // no two SLIDER requests are ever closer than this
const SYNC_FOLLOWUP_STEPS = 3;                // follow-up attempts at syncDelay when a grid point is empty
const HTTP_TIMEOUT = 15 * 1000;       // timeout for JSON/small requests
const HTTP_TIMEOUT_IMAGE = 30 * 1000; // timeout for image downloads
const STALE_THRESHOLD_MS = 90 * 60 * 1000;  // 90 min — image older than this triggers fallback (Last-Modified)
const STALE_HASH_COUNT = 9;                  // 9 identical polls — hash-based fallback when no Last-Modified (9 × 10min = 90min)
const RETRY_DELAYS_MS = [30 * 1000, 90 * 1000];  // Backoff sequence for retries after validation failure
const RETRY_MAX = RETRY_DELAYS_MS.length;

// Log levels: ERROR (default) < WARN < INFO < DEBUG
const LOG_LEVELS = { ERROR: 0, WARN: 1, INFO: 2, DEBUG: 3 };

// Image URL maps (standard resolution / hi-res)
const IMAGE_URLS = {
  natColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_natural_color.jpg",
  geoColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_true_color.jpg",
  airMass: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_rgb_airmass.jpg",
  fullBand: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/himawari-8_band_03_sector_02.gif",
  europeDiscNat: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBNatColourEnhncd_LowResolution.jpg",
  europeDiscSnow: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBSolarDay_LowResolution.jpg",
  centralAmericaDiscNat: "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/678x678.jpg"
};
// Validate that a buffer starts with a known image signature (PNG/JPEG/GIF).
// Rejects XML/HTML error bodies, empty responses, and plain text — the kinds
// of payload some upstream APIs (notably the EUMETSAT WMS) return with HTTP
// 200 under load.
function isValidImageBuffer(buffer) {
  if (!buffer || buffer.length < 4) return false;
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47) return true;
  // JPEG: FF D8 FF
  if (buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return true;
  // GIF: 47 49 46 38 ("GIF8" — both 87a and 89a)
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46 && buffer[3] === 0x38) return true;
  return false;
}

const HIRES_IMAGE_URLS = {
  natColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_natural_color.jpg",
  geoColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_true_color.jpg",
  airMass: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_rgb_airmass.jpg",
  fullBand: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/himawari-8_band_03_sector_02.gif",
  europeDiscNat: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBNatColourEnhncd_LowResolution.jpg",
  europeDiscSnow: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBSolarDay_LowResolution.jpg",
  centralAmericaDiscNat: "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/1808x1808.jpg"
};

module.exports = NodeHelper.create({
  lastTimestamp: null,
  lastImageHash: null,
  polling: false,
  config: null,
  staticUrl: null,
  sliderSatPath: null,
  sliderTimer: null,   // the one pending SLIDER poll (see rescheduleSlider)
  syncDelay: 0,             // 0 = grid sync off (default)
  syncEnabled: false,       // sync armed and cadence verified
  syncRefTimestamp: null,   // newest list entry seen at the previous fetch
  syncOrigin: 0,            // grid origin (epoch ms); 0 = still titrating
  syncFollowUps: 0,         // follow-up attempts spent on the current grid point
  logLevel: 0,
  imagesDir: null,
  staleFallbackActive: false,
  staticFallbackImages: [],
  staleCount: 0,
  screenOn: true,   // Optimistic default — overridden via SET_SCREEN_STATE if PSC is present
  staticFallbackIndexed: false,   // Lazy: static/ folder is scanned on first stale event, not at startup

  log: function(level, msg) {
    if (LOG_LEVELS[level] > this.logLevel) {
      return;
    }
    if (level === "ERROR") {
      console.error(msg);
    } else if (level === "WARN") {
      console.warn(msg);
    } else {
      console.log(msg);
    }
  },

  ensureImagesDir: function() {
    if (!this.imagesDir) {
      this.imagesDir = path.join(__dirname, "images");
    }
    if (!fs.existsSync(this.imagesDir)) {
      fs.mkdirSync(this.imagesDir);
    }
    return this.imagesDir;
  },

  socketNotificationReceived: function(notification, payload) {
    if (notification === "START_POLL") {
      if (this.polling) {
        return;
      }
      this.polling = true;
      this.config = payload;
      this.logLevel = LOG_LEVELS[payload.logLevel] !== undefined
        ? LOG_LEVELS[payload.logLevel] : LOG_LEVELS.ERROR;
      this.setupAndPoll();
    } else if (notification === "SET_SCREEN_STATE") {
      if (typeof payload === "boolean") {
        this.screenOn = payload;
        this.log("DEBUG", "Screen state updated via PSC: " + payload);
      }
    }
  },

  setupAndPoll: function() {
    var config = this.config;

    // Backwards compatibility: "meteosat" is an alias for "geoColorEurope"
    var style = config.style === "meteosat" ? "geoColorEurope" : config.style;

    // SLIDER styles: all geoColor* satellites
    var satPath = SLIDER_SATELLITES[style];
    if (satPath) {
      this.sliderSatPath = satPath;
      console.log("Started (mode: SLIDER/" + satPath + ", logLevel: " + config.logLevel + ")");

      // Poll interval is configurable, but never below 60s — the SLIDER API is a
      // third-party service and publishes a new image only every 10-15 minutes.
      var pollInterval = Number(config.sliderPollInterval) || SLIDER_POLL_INTERVAL;
      if (pollInterval < SLIDER_MIN_INTERVAL) {
        this.log("WARN", "sliderPollInterval " + pollInterval + "ms is below the minimum, using "
          + SLIDER_MIN_INTERVAL + "ms");
        pollInterval = SLIDER_MIN_INTERVAL;
      }
      this.sliderPollInterval = pollInterval;

      // Grid sync: syncDelay is both the titration step and the follow-up step.
      // It never falls below the 60s floor that applies to every SLIDER request,
      // and a value at or above the cadence would skip whole slots.
      var syncDelay = Number(config.syncDelay) || 0;
      if (syncDelay > 0 && syncDelay < SLIDER_MIN_INTERVAL) {
        this.log("WARN", "syncDelay " + syncDelay + "ms is below the minimum, using "
          + SLIDER_MIN_INTERVAL + "ms");
        syncDelay = SLIDER_MIN_INTERVAL;
      }
      if (syncDelay >= pollInterval) {
        if (syncDelay > 0) {
          this.log("ERROR", "syncDelay " + (syncDelay / 1000) + "s must be smaller than"
            + " sliderPollInterval " + (pollInterval / 1000) + "s — sync disabled,"
            + " polling at the configured interval");
        }
        syncDelay = 0;
      }
      this.syncDelay = syncDelay;
      this.syncEnabled = syncDelay > 0;

      this.log("DEBUG", "SLIDER poll interval: " + (this.sliderPollInterval / 1000) + "s"
        + (this.syncEnabled ? ", grid sync with " + (this.syncDelay / 1000) + "s steps" : ""));
      this.pollSlider();
      return;
    }

    var mode = config.ownImagePath ? "ownImagePath" : config.style;
    console.log("Started (mode: " + mode + ", logLevel: " + config.logLevel + ")");

    // Determine static URL for all non-SLIDER styles
    if (config.ownImagePath) {
      this.staticUrl = config.ownImagePath;
    } else if (config.imageSize > 800) {
      this.staticUrl = HIRES_IMAGE_URLS[config.style];
    } else {
      this.staticUrl = IMAGE_URLS[config.style];
    }

    this.log("DEBUG", "Static poll interval: " + (config.updateInterval / 1000) + "s, URL: " + this.staticUrl);
    this.pollStatic();
  },

  // --- Static fallback for stale images ---

  loadStaticFallbackImages: function() {
    var staticDir = path.join(__dirname, "static");
    try {
      var files = fs.readdirSync(staticDir);
      this.staticFallbackImages = files
        .filter(function(f) { return /^\d{4}\.jpg$/.test(f); })
        .map(function(f) { return f.replace(".jpg", ""); })
        .sort();
      this.log("INFO", "Loaded " + this.staticFallbackImages.length + " static fallback images");
    } catch (e) {
      this.staticFallbackImages = [];
      this.log("WARN", "No static fallback images found: " + e.message);
    }
  },

  // Map current UTC time to archive time using three-segment interpolation
  // Adjusts for seasonal daylight differences between archive date and today
  mapToArchiveTime: function(now) {
    var config = this.config;
    var parts = config.archiveSunPhase.split(":");
    if (parts.length !== 2) return null;

    var archiveSunrise = parseInt(parts[0].substring(0, 2), 10) * 60 + parseInt(parts[0].substring(2, 4), 10);
    var archiveSunset = parseInt(parts[1].substring(0, 2), 10) * 60 + parseInt(parts[1].substring(2, 4), 10);

    var sunTimes = SunCalc.getTimes(now, config.lat, config.lon);
    var currentSunrise = sunTimes.sunrise.getUTCHours() * 60 + sunTimes.sunrise.getUTCMinutes();
    var currentSunset = sunTimes.sunset.getUTCHours() * 60 + sunTimes.sunset.getUTCMinutes();

    var currentMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    var mappedMinutes;

    if (currentMinutes <= currentSunrise) {
      // Segment 1: Night before sunrise
      var factor = currentSunrise > 0 ? currentMinutes / currentSunrise : 0;
      mappedMinutes = Math.round(factor * archiveSunrise);
    } else if (currentMinutes <= currentSunset) {
      // Segment 2: Daytime
      var factor = (currentMinutes - currentSunrise) / (currentSunset - currentSunrise);
      mappedMinutes = Math.round(archiveSunrise + factor * (archiveSunset - archiveSunrise));
    } else {
      // Segment 3: Night after sunset
      var nightLength = 1440 - currentSunset;
      var factor = nightLength > 0 ? (currentMinutes - currentSunset) / nightLength : 0;
      mappedMinutes = Math.round(archiveSunset + factor * (1440 - archiveSunset));
    }

    mappedMinutes = Math.max(0, Math.min(1439, mappedMinutes));
    var hh = ("0" + Math.floor(mappedMinutes / 60)).slice(-2);
    var mm = ("0" + (mappedMinutes % 60)).slice(-2);
    return hh + mm;
  },

  serveStaticFallback: function() {
    if (!this.staticFallbackIndexed) {
      this.loadStaticFallbackImages();
      this.staticFallbackIndexed = true;
    }
    if (this.staticFallbackImages.length === 0) return;

    var now = new Date();
    var currentHHMM;

    // Apply seasonal sun phase mapping if configured
    if (this.config.archiveSunPhase) {
      var mapped = this.mapToArchiveTime(now);
      if (mapped) {
        currentHHMM = mapped;
        this.log("DEBUG", "Archive time mapping: UTC " +
          ("0" + now.getUTCHours()).slice(-2) + ":" + ("0" + now.getUTCMinutes()).slice(-2) +
          " → archive " + mapped.substring(0, 2) + ":" + mapped.substring(2, 4) +
          " (archiveSunPhase: " + this.config.archiveSunPhase + ")");
      } else {
        currentHHMM = ("0" + now.getUTCHours()).slice(-2) + ("0" + now.getUTCMinutes()).slice(-2);
      }
    } else {
      currentHHMM = ("0" + now.getUTCHours()).slice(-2) + ("0" + now.getUTCMinutes()).slice(-2);
    }

    var chosen = this.staticFallbackImages[0]; // default: first image

    if (this.staticFallbackImages.length > 1) {
      // Find nearest image to target time
      for (var i = 0; i < this.staticFallbackImages.length; i++) {
        if (this.staticFallbackImages[i] <= currentHHMM) {
          chosen = this.staticFallbackImages[i];
        } else {
          break;
        }
      }
    }

    var self = this;
    var srcFile = path.join(__dirname, "static", chosen + ".jpg");
    var saveDir = this.ensureImagesDir();
    var currentFile = path.join(saveDir, "current.png");
    var marker = this.config.staleFallbackMarker || "off";

    try {
      // Apply dot marker via Python/Pillow, or just copy
      var dotCmd = (marker !== "off") ? this.buildDotCommand(srcFile, currentFile, marker) : null;
      if (dotCmd) {
        try {
          execSync(dotCmd);
        } catch (pyErr) {
          self.log("WARN", "Dot marker failed (Pillow installed?), serving without marker: " + pyErr.message);
          fs.copyFileSync(srcFile, currentFile);
        }
      } else {
        fs.copyFileSync(srcFile, currentFile);
      }

      // Determine text marker for frontend (non-dot, non-off markers)
      var textMarker = null;
      if (marker !== "off" && !dotCmd) {
        textMarker = marker;
      }

      self.sendSocketNotification("IMAGE_READY", {
        url: "/modules/MMM-Globe/images/current.png?t=" + Date.now(),
        isFallback: true,
        fallbackText: textMarker
      });
      if (!self.staleFallbackActive) {
        self.log("INFO", "Stale image detected (90min unchanged), showing static fallback " + chosen + ".jpg");
        self.staleFallbackActive = true;
      }
    } catch (err) {
      self.log("ERROR", "Failed to serve static fallback: " + err.message);
    }
  },

  // Build Python one-liner to draw a dot marker on image
  // Format: "X:Y:Px:Color" — returns null if marker is not a dot format
  buildDotCommand: function(srcFile, outFile, marker) {
    var dotMatch = marker.match(/^(\d+):(\d+)(?::(\d+))?(?::(.+))?$/);
    if (!dotMatch) return null;
    var x = parseInt(dotMatch[1], 10);
    var y = parseInt(dotMatch[2], 10);
    var px = dotMatch[3] ? parseInt(dotMatch[3], 10) : 4;
    var color = (dotMatch[4] || "cornflowerblue").replace(/[^a-zA-Z0-9#]/g, "");
    var r = Math.floor(px / 2);
    return "python3 -c \"from PIL import Image,ImageDraw; "
      + "img=Image.open('" + srcFile + "').convert('RGB'); "
      + "ImageDraw.Draw(img).ellipse([" + (x - r) + "," + (y - r) + "," + (x + r) + "," + (y + r) + "],fill='" + color + "'); "
      + "img.save('" + outFile + "')\"";
  },

  // --- SLIDER polling (geoColorEurope/USA/Pacific/Asia) ---
  // Polls latest_times.json at sliderPollInterval, detects new images by timestamp comparison.

  // Every SLIDER path plans its successor through here, and the previous timer is
  // cleared first, so exactly one poll is ever pending. Needed because the timeout
  // handler calls req.destroy(), which emits an additional error event: without
  // this, the timeout path and the error path it triggers would each plan a
  // successor and the poll chain would double with every timeout. Already doubled
  // chains collapse back to one at their next reschedule, without a restart.
  rescheduleSlider: function(delay) {
    var self = this;
    clearTimeout(this.sliderTimer);
    this.sliderTimer = setTimeout(function() { self.pollSlider(); }, delay);
  },

  // A SLIDER timestamp (YYYYMMDDHHMMSS) as epoch milliseconds, NaN if malformed.
  // Used for measuring gaps only — the grid itself is built from arrival times,
  // never from the capture time an entry carries.
  parseSliderTimestamp: function(ts) {
    var s = String(ts);
    if (!/^\d{14}$/.test(s)) return NaN;
    return Date.UTC(
      Number(s.substring(0, 4)), Number(s.substring(4, 6)) - 1, Number(s.substring(6, 8)),
      Number(s.substring(8, 10)), Number(s.substring(10, 12)), Number(s.substring(12, 14))
    );
  },

  // Most frequent gap between consecutive list entries, in milliseconds.
  // Not the minimum and not the median: single missing slots show up as double
  // gaps and would skew both. Returns 0 when the list is too short to judge.
  measureCadence: function(timestamps) {
    if (!Array.isArray(timestamps) || timestamps.length < 3) return 0;
    var counts = {};
    var best = 0;
    var bestCount = 0;
    for (var i = 0; i < timestamps.length - 1; i++) {
      var gap = this.parseSliderTimestamp(timestamps[i]) - this.parseSliderTimestamp(timestamps[i + 1]);
      if (!(gap > 0)) continue;
      counts[gap] = (counts[gap] || 0) + 1;
      if (counts[gap] > bestCount) {
        bestCount = counts[gap];
        best = gap;
      }
    }
    return best;
  },

  // The cadence comes from the user via sliderPollInterval; the list is only
  // consulted to verify it. A mismatch means the configured value is wrong or
  // the operator changed the publishing rate — either way the grid would be
  // wrong, so sync is dropped and the module falls back to fixed polling.
  // Runs on every successful list fetch while sync is on, which makes the
  // error appear exactly once.
  verifyCadence: function(timestamps) {
    var cadence = this.measureCadence(timestamps);
    if (cadence === 0 || cadence === this.sliderPollInterval) return;
    this.log("ERROR", "SLIDER sync: measured cadence " + (cadence / 1000) + "s does not match"
      + " sliderPollInterval " + (this.sliderPollInterval / 1000) + "s — sync disabled, polling at"
      + " the configured interval. Set sliderPollInterval: " + (cadence / 1000) + " * 1000 to sync.");
    this.syncEnabled = false;
    this.syncOrigin = 0;
  },

  // Next grid point strictly after now: origin + n * cadence, n >= 1. Computed
  // absolutely rather than by adding up delays, so timer drift, load spikes and
  // suspend cannot accumulate.
  scheduleSyncedPoll: function() {
    this.rescheduleSlider(this.msToNextGridPoint());
  },

  // Milliseconds until the next regular poll: the next grid point while the
  // grid is locked, one plain interval otherwise.
  msToNextGridPoint: function() {
    if (!this.syncEnabled || this.syncOrigin === 0) return this.sliderPollInterval;
    var now = Date.now();
    var n = Math.floor((now - this.syncOrigin) / this.sliderPollInterval) + 1;
    if (n < 1) n = 1;
    return this.syncOrigin + n * this.sliderPollInterval - now;
  },

  // Plan the successor of a completed poll. changed tells whether the newest
  // list entry differs from the one seen at the previous fetch.
  scheduleNextSliderPoll: function(changed) {
    if (!this.syncEnabled) {
      this.rescheduleSlider(this.sliderPollInterval);
      return;
    }
    if (this.syncOrigin === 0) {
      // Titrating: step forward until the first change shows up.
      if (!changed) {
        this.rescheduleSlider(this.syncDelay);
        return;
      }
      this.syncOrigin = Date.now() + this.syncDelay;
      this.log("DEBUG", "SLIDER sync: grid locked, cadence " + (this.sliderPollInterval / 1000)
        + "s, buffer " + (this.syncDelay / 1000) + "s");
      this.scheduleSyncedPoll();
      return;
    }
    if (changed || this.syncFollowUps >= SYNC_FOLLOWUP_STEPS) {
      // Found it, or the slot stays empty: either way on to the next grid point.
      // The follow-ups are error handling, they never move the grid.
      this.syncFollowUps = 0;
      this.scheduleSyncedPoll();
      return;
    }
    this.syncFollowUps++;
    this.rescheduleSlider(this.syncDelay);
  },

  // An interface error says nothing about whether a new image exists: it costs
  // no follow-up step and never moves the grid. Retried after retryDelay, but
  // never later than the next regular poll — when the grid point is closer than
  // the retry, the grid wins. Stateless on purpose: the timeout handler calls
  // req.destroy(), which emits an additional error event, and both compute the
  // same delay, so the single timer of rescheduleSlider absorbs the duplicate.
  scheduleAfterSliderError: function() {
    this.rescheduleSlider(Math.min(this.config.retryDelay, this.msToNextGridPoint()));
  },

  pollSlider: function() {
    var self = this;
    var satPath = this.sliderSatPath;
    var timesUrl = SLIDER_BASE_URL + "/data/json/" + satPath + "/" + SLIDER_PRODUCT + "/latest_times.json";

    var req = https.get(timesUrl, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        var json;
        var ts;
        if (res.statusCode !== 200) {
          self.log("WARN", "SLIDER timestamp fetch failed (HTTP " + res.statusCode + ")");
          self.scheduleAfterSliderError();
          return;
        }
        try {
          json = JSON.parse(data);
          ts = json.timestamps_int[0].toString();
        } catch (e) {
          self.log("ERROR", "SLIDER JSON parse error: " + e.message);
          self.scheduleAfterSliderError();
          return;
        }
        if (self.syncEnabled) {
          self.verifyCadence(json.timestamps_int);
        }

        // Did something new appear since the previous fetch? The very first
        // fetch only sets the reference — when its entry showed up is unknown,
        // so it is no event. Tracked separately from lastTimestamp so that a
        // failed image download leaves the slot open without moving the grid.
        var changed = false;
        if (self.syncRefTimestamp === null) {
          self.syncRefTimestamp = ts;
        } else if (ts !== self.syncRefTimestamp) {
          self.syncRefTimestamp = ts;
          changed = true;
        }

        // Plan the next poll before the download, so the chain never depends
        // on it finishing. The timestamp is only marked as done once the image
        // has actually arrived — a failed download therefore leaves the slot
        // open and the next poll fetches it again instead of skipping it.
        self.scheduleNextSliderPoll(changed);

        if (ts === self.lastTimestamp) {
          self.log("DEBUG", "SLIDER poll: no new image (latest: " + ts + ")");
          return;
        }

        var dateStr = ts.substring(0, 4) + "/" + ts.substring(4, 6) + "/" + ts.substring(6, 8);
        var imageUrl = SLIDER_BASE_URL + "/data/imagery/"
          + dateStr + "/" + satPath + "---" + SLIDER_PRODUCT + "/" + ts + "/00/000_000.png";

        self.log("INFO", "New SLIDER image: " + ts);
        self.downloadAndServe(imageUrl, "globe_" + ts + ".png", 0, function() {
          self.lastTimestamp = ts;
        });
      });
    });
    req.on("error", function(e) {
      self.log("ERROR", "SLIDER fetch error: " + e.message);
      self.scheduleAfterSliderError();
    });
    req.setTimeout(HTTP_TIMEOUT, function() {
      req.destroy();
      self.log("WARN", "SLIDER timestamp fetch timeout");
      self.scheduleAfterSliderError();
    });
  },

  // --- Static URL polling (all styles except meteosat, including ownImagePath) ---

  pollStatic: function() {
    var self = this;
    var sep = this.staticUrl.indexOf("?") === -1 ? "?" : "&";
    var imageUrl = this.staticUrl + sep + "t=" + Date.now();

    self.log("DEBUG", "Fetching image...");
    self.downloadAndServe(imageUrl);

    setTimeout(function() { self.pollStatic(); }, self.config.updateInterval);
  },

  // --- Download image, write current.png for frontend, optionally save copy ---
  // Always downloads the image and serves it via current.png.
  // When enableImageSaving is true, also saves a timestamped copy.
  //
  // filename provided (SLIDER): save with that name, dedup by file existence.
  // filename omitted (static):  generate timestamped name, dedup by content hash.

  // onSuccess (optional) is called exactly once, and only when the image has been
  // written and handed to the frontend. Every other outcome — validation failure,
  // exhausted retries, screen off, HTTP error, socket error, timeout, unwritable
  // file — stays silent by design, so the SLIDER caller does not mark the slot as
  // done and fetches it again on the next poll. pollStatic passes no callback and
  // is unaffected.
  downloadAndServe: function(imageUrl, filename, retryAttempt, onSuccess) {
    var self = this;
    if (typeof retryAttempt !== "number") retryAttempt = 0;
    var saveDir = this.ensureImagesDir();
    var currentFile = path.join(saveDir, "current.png");

    var client = imageUrl.startsWith("https") ? https : http;
    var req = client.get(imageUrl, function(res) {
      if (res.statusCode === 200) {
        // Stale detection via Last-Modified header (only for static styles)
        var staleHandledByHeader = false;
        if (!filename && self.config.switchToStaticIfStale) {
          var lastModified = res.headers["last-modified"];
          if (lastModified) {
            var imageAge = Date.now() - new Date(lastModified).getTime();
            if (imageAge > STALE_THRESHOLD_MS) {
              self.log("DEBUG", "Image stale (Last-Modified: " + lastModified + ", age: " + Math.round(imageAge / 60000) + "min)");
              res.resume(); // Drain response to free socket
              self.serveStaticFallback();
              return;
            } else if (self.staleFallbackActive) {
              self.log("INFO", "Live image recovered, resuming normal operation");
              self.staleFallbackActive = false;
              self.staleCount = 0;
            }
            staleHandledByHeader = true;
          }
        }

        var chunks = [];
        res.on("data", function(chunk) { chunks.push(chunk); });
        res.on("end", function() {
          var buffer = Buffer.concat(chunks);

          if (!isValidImageBuffer(buffer)) {
            var preview = buffer.toString("hex", 0, Math.min(16, buffer.length));
            self.log("DEBUG",
              "Validation failed for " + imageUrl
              + " (size: " + buffer.length + " bytes, first 16 hex: " + preview + ")");
            self.retryImage(imageUrl, filename, retryAttempt, onSuccess);
            return;
          }

          // Compute content hash for static paths (used for dedup and hash-based stale detection)
          var hash = null;
          if (!filename) {
            hash = crypto.createHash("md5").update(buffer).digest("hex").substring(0, 12);
          }

          // Hash-based stale detection (fallback when no Last-Modified header)
          if (hash && self.config.switchToStaticIfStale && !staleHandledByHeader) {
            if (hash === self.lastImageHash) {
              self.staleCount = Math.min(self.staleCount + 1, STALE_HASH_COUNT);
              if (self.staleCount >= STALE_HASH_COUNT) {
                self.log("DEBUG", "Image stale (hash unchanged for " + self.staleCount + " polls)");
                self.serveStaticFallback();
                return;
              }
            } else {
              if (self.staleFallbackActive) {
                self.log("INFO", "Live image recovered, resuming normal operation");
                self.staleFallbackActive = false;
              }
              self.staleCount = 0;
            }
          }

          // Save timestamped copy (only when enableImageSaving is on)
          if (self.config.enableImageSaving) {
            if (filename) {
              // SLIDER path: dedup by filename (timestamp-based)
              if (!fs.existsSync(path.join(saveDir, filename))) {
                fs.writeFile(path.join(saveDir, filename), buffer, function(err) {
                  if (err) {
                    self.log("ERROR", "Image save error: " + err.message);
                  } else {
                    self.log("INFO", "Image saved: " + filename);
                  }
                });
              } else {
                self.log("DEBUG", "Image already saved: " + filename);
              }
            } else if (hash !== self.lastImageHash) {
              // Static path: dedup by content hash (hash already computed above)
              self.log("INFO", "New image (hash " + hash + ")");
              var now = new Date();
              var ts = now.getFullYear()
                + ("0" + (now.getMonth() + 1)).slice(-2)
                + ("0" + now.getDate()).slice(-2)
                + ("0" + now.getHours()).slice(-2)
                + ("0" + now.getMinutes()).slice(-2)
                + ("0" + now.getSeconds()).slice(-2);
              var saveName = "globe_" + ts + self.getImageExtension(imageUrl);
              fs.writeFile(path.join(saveDir, saveName), buffer, function(err) {
                if (err) {
                  self.log("ERROR", "Image save error: " + err.message);
                } else {
                  self.log("INFO", "Image saved: " + saveName);
                }
              });
            } else {
              self.log("DEBUG", "Image unchanged (hash " + hash + ")");
            }
          }

          // Update lastImageHash after dedup check
          if (hash) {
            self.lastImageHash = hash;
          }

          // Write current.png and send local path to frontend
          fs.writeFile(currentFile, buffer, function(err) {
            if (err) {
              self.log("ERROR", "Failed to write current.png: " + err.message);
            } else {
              self.sendSocketNotification("IMAGE_READY", {
                url: "/modules/MMM-Globe/images/current.png?t=" + Date.now(),
                isFallback: false,
                fallbackText: null
              });
              if (typeof onSuccess === "function") {
                onSuccess();
              }
            }
          });
        });
      } else {
        self.log("WARN", "Image fetch failed (HTTP " + res.statusCode + ")");
        res.resume(); // Drain response to free socket
        self.retryImage(imageUrl, filename, retryAttempt, onSuccess);
      }
    });
    req.on("error", function(e) {
      self.log("ERROR", "Image fetch error: " + e.message);
      self.retryImage(imageUrl, filename, retryAttempt, onSuccess);
    });
    req.setTimeout(HTTP_TIMEOUT_IMAGE, function() {
      req.destroy();
      self.log("WARN", "Image fetch timeout");
      self.retryImage(imageUrl, filename, retryAttempt, onSuccess);
    });
  },

  // Retry chain for a failed image download: 30s, then 90s, then give up and
  // leave the slot to the next poll. Suppressed while the screen is off (PSC).
  // Used for every kind of failure — invalid content as well as HTTP, socket
  // and timeout errors; before v3.5.0 only invalid content was retried, which
  // cost a whole slot once the poll interval grew beyond a minute.
  retryImage: function(imageUrl, filename, retryAttempt, onSuccess) {
    var self = this;
    if (!this.screenOn) {
      this.log("DEBUG", "Skipping retry: screen off");
      return;
    }
    if (retryAttempt >= RETRY_MAX) {
      this.log("WARN", "Failed to get valid image from " + imageUrl
        + " after " + RETRY_MAX + " retries");
      return;
    }
    var delay = RETRY_DELAYS_MS[retryAttempt];
    this.log("DEBUG", "Retrying in " + (delay / 1000) + "s (" + (retryAttempt + 1) + "/" + RETRY_MAX + ")");
    setTimeout(function() {
      self.downloadAndServe(imageUrl, filename, retryAttempt + 1, onSuccess);
    }, delay);
  },

  // Determine file extension from URL (supports both direct URLs and WMS format= parameter)
  getImageExtension: function(url) {
    var wmsFormat = url.match(/format=image\/(png|jpeg|gif)/i);
    if (wmsFormat) {
      return wmsFormat[1].toLowerCase() === "jpeg" ? ".jpg" : "." + wmsFormat[1].toLowerCase();
    }
    var directExt = url.match(/\.(png|jpg|jpeg|gif)/i);
    if (directExt) {
      return directExt[0].toLowerCase() === ".jpeg" ? ".jpg" : directExt[0].toLowerCase();
    }
    return ".png";
  }
});
