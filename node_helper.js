/* node_helper for MMM-Globe.
 * All image fetching runs here (server-side). The frontend only receives
 * a local file path and handles display.
 *
 * Two polling modes:
 * - pollSlider (SLIDER styles: geoColorEurope/USA/Pacific/Asia, alias "meteosat"):
 *   polls CIRA SLIDER API every 60s, detects new images by comparing timestamps.
 *   Supports four satellites: Meteosat-0deg, GOES-19, GOES-18, Himawari.
 * - pollStatic (all other styles + ownImagePath): polls at configured
 *   updateInterval.
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
const SLIDER_POLL_INTERVAL = 60 * 1000;
const HTTP_TIMEOUT = 15 * 1000;       // timeout for JSON/small requests
const HTTP_TIMEOUT_IMAGE = 30 * 1000; // timeout for image downloads
const STALE_THRESHOLD_MS = 90 * 60 * 1000;  // 90 min — image older than this triggers fallback (Last-Modified)
const STALE_HASH_COUNT = 9;                  // 9 identical polls — hash-based fallback when no Last-Modified (9 × 10min = 90min)

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
  logLevel: 0,
  imagesDir: null,
  staleFallbackActive: false,
  staticFallbackImages: [],
  staleCount: 0,

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
      this.log("DEBUG", "SLIDER poll interval: " + (SLIDER_POLL_INTERVAL / 1000) + "s");
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

    // Load static fallback images if feature is enabled
    if (config.switchToStaticIfStale) {
      this.loadStaticFallbackImages();
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
  // Polls latest_times.json every 60s, detects new images by timestamp comparison.

  pollSlider: function() {
    var self = this;
    var satPath = this.sliderSatPath;
    var timesUrl = SLIDER_BASE_URL + "/data/json/" + satPath + "/" + SLIDER_PRODUCT + "/latest_times.json";

    var req = https.get(timesUrl, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        if (res.statusCode === 200) {
          try {
            var json = JSON.parse(data);
            var ts = json.timestamps_int[0].toString();

            if (ts === self.lastTimestamp) {
              self.log("DEBUG", "SLIDER poll: no new image (latest: " + ts + ")");
              setTimeout(function() { self.pollSlider(); }, SLIDER_POLL_INTERVAL);
              return;
            }

            self.lastTimestamp = ts;
            var dateStr = ts.substring(0, 4) + "/" + ts.substring(4, 6) + "/" + ts.substring(6, 8);
            var imageUrl = SLIDER_BASE_URL + "/data/imagery/"
              + dateStr + "/" + satPath + "---" + SLIDER_PRODUCT + "/" + ts + "/00/000_000.png";

            self.log("INFO", "New SLIDER image: " + ts);
            self.downloadAndServe(imageUrl, "globe_" + ts + ".png");
          } catch (e) {
            self.log("ERROR", "SLIDER JSON parse error: " + e.message);
          }
        } else {
          self.log("WARN", "SLIDER timestamp fetch failed (HTTP " + res.statusCode + ")");
        }
        setTimeout(function() { self.pollSlider(); }, SLIDER_POLL_INTERVAL);
      });
    });
    req.on("error", function(e) {
      self.log("ERROR", "SLIDER fetch error: " + e.message);
      setTimeout(function() { self.pollSlider(); }, self.config.retryDelay);
    });
    req.setTimeout(HTTP_TIMEOUT, function() {
      req.destroy();
      self.log("WARN", "SLIDER timestamp fetch timeout");
      setTimeout(function() { self.pollSlider(); }, self.config.retryDelay);
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

  downloadAndServe: function(imageUrl, filename) {
    var self = this;
    var saveDir = this.ensureImagesDir();
    var currentFile = path.join(saveDir, "current.png");

    var client = imageUrl.startsWith("https") ? https : http;
    var req = client.get(imageUrl, function(res) {
      if (res.statusCode === 200) {
        // Stale detection via Last-Modified header (only for static styles)
        var staleHandledByHeader = false;
        if (!filename && self.config.switchToStaticIfStale && self.staticFallbackImages.length > 0) {
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

          // Compute content hash for static paths (used for dedup and hash-based stale detection)
          var hash = null;
          if (!filename) {
            hash = crypto.createHash("md5").update(buffer).digest("hex").substring(0, 12);
          }

          // Hash-based stale detection (fallback when no Last-Modified header)
          if (hash && self.config.switchToStaticIfStale && !staleHandledByHeader && self.staticFallbackImages.length > 0) {
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
            }
          });
        });
      } else {
        self.log("WARN", "Image fetch failed (HTTP " + res.statusCode + ")");
      }
    });
    req.on("error", function(e) {
      self.log("ERROR", "Image fetch error: " + e.message);
    });
    req.setTimeout(HTTP_TIMEOUT_IMAGE, function() {
      req.destroy();
      self.log("WARN", "Image fetch timeout");
    });
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
