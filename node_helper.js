/* node_helper for MMM-Globe.
 * - CIRA SLIDER integration: fetches latest timestamp from SLIDER API
 *   (server-side, no CORS restrictions) and sends image URL to frontend.
 * - Optional image saving: downloads and saves satellite images locally
 *   when enableImageSaving is true in config.
 */

const NodeHelper = require("node_helper");
const https = require("https");
const fs = require("fs");
const path = require("path");

const SLIDER_TIMES_URL = "https://slider.cira.colostate.edu/data/json/meteosat-0deg/full_disk/geocolor/latest_times.json";

module.exports = NodeHelper.create({
  socketNotificationReceived: function(notification, payload) {
    if (notification === "GET_SLIDER_URL") {
      this.enableImageSaving = payload && payload.enableImageSaving;
      this.fetchSliderTimestamp();
    }
  },

  fetchSliderTimestamp: function() {
    var self = this;
    https.get(SLIDER_TIMES_URL, function(res) {
      var data = "";
      res.on("data", function(chunk) { data += chunk; });
      res.on("end", function() {
        if (res.statusCode === 200) {
          try {
            var json = JSON.parse(data);
            var ts = json.timestamps_int[0].toString();
            var dateStr = ts.substring(0, 4) + "/" + ts.substring(4, 6) + "/" + ts.substring(6, 8);
            var imageUrl = "https://slider.cira.colostate.edu/data/imagery/"
              + dateStr + "/meteosat-0deg---full_disk/geocolor/" + ts + "/00/000_000.png";
            self.sendSocketNotification("SLIDER_IMAGE_URL", imageUrl);

            if (self.enableImageSaving) {
              self.saveImage(imageUrl, ts);
            }
          } catch (e) {
            self.sendSocketNotification("SLIDER_ERROR", "SLIDER JSON parse error: " + e.message);
          }
        } else {
          self.sendSocketNotification("SLIDER_ERROR", "SLIDER timestamp fetch failed (HTTP " + res.statusCode + ")");
        }
      });
    }).on("error", function(e) {
      self.sendSocketNotification("SLIDER_ERROR", "SLIDER timestamp fetch error: " + e.message);
    });
  },

  saveImage: function(imageUrl, timestamp) {
    var saveDir = path.join(__dirname, "images");
    if (!fs.existsSync(saveDir)) {
      fs.mkdirSync(saveDir);
    }

    var filename = "globe_" + timestamp + ".png";
    var filePath = path.join(saveDir, filename);

    // Skip if already saved (same SLIDER timestamp = same image)
    if (fs.existsSync(filePath)) {
      return;
    }

    https.get(imageUrl, function(res) {
      if (res.statusCode === 200) {
        var file = fs.createWriteStream(filePath);
        res.pipe(file);
        file.on("finish", function() {
          file.close();
          console.log("[MMM-Globe] Image saved: " + filename);
        });
      }
    }).on("error", function(e) {
      console.error("[MMM-Globe] Image save error: " + e.message);
    });
  }
});
