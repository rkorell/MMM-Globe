/* node_helper for MMM-Globe.
 * All image fetching runs here (server-side). The frontend only receives
 * a local file path and handles display.
 *
 * Two polling modes:
 * - pollSlider (style: "meteosat"): polls CIRA SLIDER API every 60s,
 *   detects new images by comparing timestamps.
 * - pollStatic (all other styles + ownImagePath): polls at configured
 *   updateInterval.
 *
 * Both modes call downloadAndServe() which downloads the image and writes
 * current.png for the frontend. When enableImageSaving is true, a
 * timestamped copy is also saved to the images/ subfolder.
 */

const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const SLIDER_TIMES_URL = "https://slider.cira.colostate.edu/data/json/meteosat-0deg/full_disk/geocolor/latest_times.json";
const SLIDER_POLL_INTERVAL = 60 * 1000;
const HTTP_TIMEOUT = 15 * 1000;       // timeout for JSON/small requests
const HTTP_TIMEOUT_IMAGE = 30 * 1000; // timeout for image downloads

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
  logLevel: 0,
  imagesDir: null,

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
    var mode = config.style === "meteosat" ? "SLIDER" : (config.ownImagePath ? "ownImagePath" : config.style);
    console.log("Started (mode: " + mode + ", logLevel: " + config.logLevel + ")");

    if (config.style === "meteosat") {
      this.log("DEBUG", "SLIDER poll interval: " + (SLIDER_POLL_INTERVAL / 1000) + "s");
      this.pollSlider();
      return;
    }

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

  // --- SLIDER (meteosat) polling ---
  // Polls latest_times.json every 60s, detects new images by timestamp comparison.

  pollSlider: function() {
    var self = this;
    var req = https.get(SLIDER_TIMES_URL, function(res) {
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
            var imageUrl = "https://slider.cira.colostate.edu/data/imagery/"
              + dateStr + "/meteosat-0deg---full_disk/geocolor/" + ts + "/00/000_000.png";

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
        var chunks = [];
        res.on("data", function(chunk) { chunks.push(chunk); });
        res.on("end", function() {
          var buffer = Buffer.concat(chunks);

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
            } else {
              // Static path: dedup by content hash
              var hash = crypto.createHash("md5").update(buffer).digest("hex").substring(0, 12);
              if (hash !== self.lastImageHash) {
                self.lastImageHash = hash;
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
          }

          // Write current.png and send local path to frontend
          fs.writeFile(currentFile, buffer, function(err) {
            if (err) {
              self.log("ERROR", "Failed to write current.png: " + err.message);
            } else {
              self.sendSocketNotification("IMAGE_READY", {
                url: "/modules/MMM-Globe/images/current.png?t=" + Date.now()
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
