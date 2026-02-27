/* global Module */

/* Magic Mirror
 * Module: MMM-Globe
 *
 * By Luke Scheffler https://github.com/LukeSkywalker92
 * Fork maintainer: Dr. Ralf Korell https://github.com/rkorell
 * MIT Licensed.
 */

// Promise based image loader with error handling
const loadImage = src =>
  new Promise(resolve => {
    const image = new Image();
    image.onload = () => resolve({ image, isError: false });
    image.onerror = () => resolve({ image, isError: true });
    image.src = src;
  });

Module.register("MMM-Globe", {
  defaults: {
    style: "geoColor",
    imageSize: 600,
    ownImagePath: "",
    updateInterval: 10 * 60 * 1000,  // 10 minutes
    retryDelay: 30 * 1000,           // retry delay on load failure (30 seconds)
    enableImageSaving: false          // save satellite images locally (images/ subfolder)
  },

  start: function() {
    this.url = "";
    this.loadedImage = null;
    this.imageUrls = {
      natColor:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_natural_color.jpg",
      geoColor:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_true_color.jpg",
      airMass:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/full_disk_ahi_rgb_airmass.jpg",
      fullBand:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/himawari-8_band_03_sector_02.gif",
      europeDiscNat:
        "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBNatColourEnhncd_LowResolution.jpg",
      europeDiscSnow:
        "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBSolarDay_LowResolution.jpg",
      centralAmericaDiscNat:
        "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/678x678.jpg"
    };
    this.hiResImageUrls = {
      natColor:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_natural_color.jpg",
      geoColor:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_true_color.jpg",
      airMass:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest_hi_res/himawari-8/full_disk_ahi_rgb_airmass.jpg",
      fullBand:
        "https://rammb.cira.colostate.edu/ramsdis/online/images/latest/himawari-8/himawari-8_band_03_sector_02.gif",
      europeDiscNat:
        "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBNatColourEnhncd_LowResolution.jpg",
      europeDiscSnow:
        "https://eumetview.eumetsat.int/static-images/latestImages/EUMETSAT_MSG_RGBSolarDay_LowResolution.jpg",
      centralAmericaDiscNat:
        "https://cdn.star.nesdis.noaa.gov/GOES16/ABI/FD/GEOCOLOR/1808x1808.jpg"
    };
    if (this.config.ownImagePath !== "") {
      this.url = this.config.ownImagePath;
    } else if (this.config.style !== "meteosat") {
      if (this.config.imageSize > 800) {
        this.url = this.hiResImageUrls[this.config.style];
      } else {
        this.url = this.imageUrls[this.config.style];
      }
    }

    // Fetch image in start() instead of getDom() to avoid blank display
    // when network is not ready at boot time
    this.fetchImage();

    // Periodic refresh
    if (this.config.updateInterval > 0) {
      var self = this;
      setInterval(function () {
        self.fetchImage();
      }, this.config.updateInterval);
    }
  },

  // Handle SLIDER image URL from node_helper
  socketNotificationReceived: function(notification, payload) {
    var self = this;
    if (notification === "SLIDER_IMAGE_URL") {
      loadImage(payload).then(function(result) {
        if (!result.isError) {
          self.loadedImage = result.image;
          self.updateDom(1000);
        } else {
          Log.warn("MMM-Globe: SLIDER image load failed, retrying in " + (self.config.retryDelay / 1000) + "s");
          setTimeout(function() { self.fetchImage(); }, self.config.retryDelay);
        }
      });
    } else if (notification === "SLIDER_ERROR") {
      Log.warn("MMM-Globe: " + payload);
      setTimeout(function() { self.fetchImage(); }, self.config.retryDelay);
    }
  },

  // Fetch image asynchronously, retry on failure, update DOM when done
  fetchImage: function() {
    var self = this;

    // CIRA SLIDER requires two-step fetch (timestamp lookup + image load)
    // via node_helper to avoid CORS restrictions in Electron.
    // Source: https://slider.cira.colostate.edu (NOAA/RAMMB, Colorado State University)
    if (this.config.style === "meteosat") {
      this.sendSocketNotification("GET_SLIDER_URL", { enableImageSaving: this.config.enableImageSaving });
      return;
    }

    // Static URL styles: load with cache-buster
    loadImage(this.url + "?" + new Date().getTime()).then(function(result) {
      if (!result.isError) {
        self.loadedImage = result.image;
        self.updateDom(1000);
      } else {
        Log.warn("MMM-Globe: Image load failed, retrying in " + (self.config.retryDelay / 1000) + "s");
        setTimeout(function() {
          self.fetchImage();
        }, self.config.retryDelay);
      }
    });
  },

  getStyles: function() {
    return ["MMM-Globe.css"];
  },

  // getDom is synchronous — just renders the stored image
  getDom: function() {
    var wrapper = document.createElement("div");

    if (this.loadedImage) {
      if (this.config.style === "europeDiscNat") {
        wrapper.style.height = 0.98 * this.config.imageSize - 1 + "px";
        wrapper.style.overflow = "hidden";
      }

      var image = this.loadedImage.cloneNode();
      if (this.config.style === "centralAmericaDiscNat") {
        image.className = "MMM-Globe-image-centralAmericaDiscNat";
      } else {
        image.className = "MMM-Globe-image";
      }
      image.width = this.config.imageSize.toString();
      image.height = this.config.imageSize.toString();
      wrapper.appendChild(image);
    }

    return wrapper;
  }
});
