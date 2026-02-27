/* node_helper for MMM-Globe.
 * All image fetching runs here (server-side) for consistent logging
 * and optional image saving across all styles.
 *
 * - CIRA SLIDER (style: "meteosat"): polls latest_times.json every 60s,
 *   sends new image URL to frontend only when timestamp changes.
 * - Static URLs (all other styles + ownImagePath): sends image URL to
 *   frontend at configured updateInterval with cache-buster.
 * - Optional image saving for all styles.
 */

const NodeHelper = require("node_helper");
const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");

const SLIDER_TIMES_URL = "https://slider.cira.colostate.edu/data/json/meteosat-0deg/full_disk/geocolor/latest_times.json";
const SLIDER_POLL_INTERVAL = 60 * 1000;   // poll SLIDER JSON every 60s
const RETRY_DELAY = 30 * 1000;            // retry on error after 30s

module.exports = NodeHelper.create({
  lastTimestamp: null,
  polling: false,
  config: null,
  staticUrl: null,

  socketNotificationReceived: function(notification, payload) {
    if (notification === "START_POLL") {
      if (this.polling) {
        return;  // already running
      }
      this.polling = true;
      this.config = payload;
      this.setupAndPoll();
    }
  },

  setupAndPoll: function() {
    var config = this.config;

    if (config.style === "meteosat") {
      console.log("[MMM-Globe] Starting SLIDER poll (every " + (SLIDER_POLL_INTERVAL / 1000) + "s)");
      this.pollSlider();
      return;
    }

    // Determine static URL
    var imageUrls = {
      natColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_natural_color.jpg",
      geoColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_true_color.jpg",
      airMass: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_rgb_airmass.jpg",
      fullBand: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/himawari-8_band_03_sector_02.gif",
      europeDiscNat: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBNatColourEnhncd_LowResolution.jpg",
      europeDiscSnow: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBSolarDay_LowResolution.jpg",
      centralAmericaDiscNat: "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/678x678.jpg"
    };
    var hiResImageUrls = {
      natColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_natural_color.jpg",
      geoColor: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_true_color.jpg",
      airMass: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_rgb_airmass.jpg",
      fullBand: "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/himawari-8_band_03_sector_02.gif",
      europeDiscNat: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBNatColourEnhncd_LowResolution.jpg",
      europeDiscSnow: "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBSolarDay_LowResolution.jpg",
      centralAmericaDiscNat: "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/1808x1808.jpg"
    };

    if (config.ownImagePath) {
      this.staticUrl = config.ownImagePath;
    } else if (config.imageSize > 800) {
      this.staticUrl = hiResImageUrls[config.style];
    } else {
      this.staticUrl = imageUrls[config.style];
    }

    console.log("[MMM-Globe] Starting static poll (every " + (config.updateInterval / 1000) + "s): " + this.staticUrl);
    this.pollStaticUrl();
  },

  // --- SLIDER (meteosat) polling ---

  pollSlider: function() {
    var self = this;
    https.get(SLIDER_TIMES_URL, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        if (res.statusCode === 200) {
          try {
            var json = JSON.parse(data);
            var ts = json.timestamps_int[0].toString();

            if (ts === self.lastTimestamp) {
              setTimeout(function() { self.pollSlider(); }, SLIDER_POLL_INTERVAL);
              return;
            }

            self.lastTimestamp = ts;
            var dateStr = ts.substring(0, 4) + "/" + ts.substring(4, 6) + "/" + ts.substring(6, 8);
            var imageUrl = "https://slider.cira.colostate.edu/data/imagery/"
              + dateStr + "/meteosat-0deg---full_disk/geocolor/" + ts + "/00/000_000.png";

            console.log("[MMM-Globe] New SLIDER image: " + ts);
            self.sendSocketNotification("IMAGE_READY", { url: imageUrl });

            if (self.config.enableImageSaving) {
              self.saveImageFromUrl(imageUrl, "globe_" + ts + ".png");
            }
          } catch (e) {
            console.error("[MMM-Globe] SLIDER JSON parse error: " + e.message);
          }
        } else {
          console.warn("[MMM-Globe] SLIDER timestamp fetch failed (HTTP " + res.statusCode + ")");
        }
        setTimeout(function() { self.pollSlider(); }, SLIDER_POLL_INTERVAL);
      });
    }).on("error", function(e) {
      console.error("[MMM-Globe] SLIDER fetch error: " + e.message);
      setTimeout(function() { self.pollSlider(); }, RETRY_DELAY);
    });
  },

  // --- Static URL polling (all non-meteosat styles) ---

  pollStaticUrl: function() {
    var self = this;
    var url = this.staticUrl;
    var sep = url.indexOf("?") === -1 ? "?" : "&";
    var fetchUrl = url + sep + "t=" + Date.now();

    console.log("[MMM-Globe] Fetching image...");
    self.sendSocketNotification("IMAGE_READY", { url: fetchUrl });

    if (self.config.enableImageSaving) {
      var now = new Date();
      var ts = now.getFullYear()
        + ("0" + (now.getMonth() + 1)).slice(-2)
        + ("0" + now.getDate()).slice(-2)
        + ("0" + now.getHours()).slice(-2)
        + ("0" + now.getMinutes()).slice(-2)
        + ("0" + now.getSeconds()).slice(-2);
      var ext = url.match(/\.(png|jpg|gif)/i);
      ext = ext ? ext[0] : ".jpg";
      self.saveImageFromUrl(fetchUrl, "globe_" + ts + ext);
    }

    setTimeout(function() { self.pollStaticUrl(); }, self.config.updateInterval);
  },

  // --- Image saving (shared by all styles) ---

  saveImageFromUrl: function(imageUrl, filename) {
    var saveDir = path.join(__dirname, "images");
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir);
    }

    var filePath = path.join(saveDir, filename);

    // Skip if already saved (same filename = same image, relevant for SLIDER timestamps)
    if (fs.existsSync(filePath)) {
      return;
    }

    var client = imageUrl.startsWith("https") ? https : http;
    client.get(imageUrl, function(res) {
      if (res.statusCode === 200) {
        var file = fs.createWriteStream(filePath);
        res.pipe(file);
        file.on("finish", function() {
          file.close();
          console.log("[MMM-Globe] Image saved: " + filename);
        });
      } else {
        console.warn("[MMM-Globe] Image save failed (HTTP " + res.statusCode + "): " + filename);
      }
    }).on("error", function(e) {
      console.error("[MMM-Globe] Image save error: " + e.message);
    });
  }
});
