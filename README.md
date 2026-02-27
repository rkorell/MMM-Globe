# MMM-Globe

A module for [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) that displays live satellite imagery of our planet as a beautiful globe on your mirror.

> Fork of [LukeSkywalker92/MMM-Globe](https://github.com/LukeSkywalker92/MMM-Globe), originally created by [Luke Scheffler](https://github.com/LukeSkywalker92). His elegant idea of using CSS `clip-path: circle()` to turn square satellite images into a globe is the heart of this module. Thank you, Luke!

## Preview

![](https://github.com/rkorell/MMM-Globe/blob/master/screenshot.png?raw=true)

## Background: Why this fork?

The original MMM-Globe module has been unmaintained since 2021 but worked perfectly fine for years — until February 2026, when EUMETSAT discontinued their static image server at `eumetview.eumetsat.int`. This broke the European satellite styles (`europeDiscNat`, `europeDiscSnow`) that many European MagicMirror users relied on.

EUMETSAT migrated to a new dynamic platform at `view.eumetsat.int`, but this is a JavaScript web application — there are no static image URLs to point the module at. EUMETSAT does offer a WMS (Web Map Service) endpoint, but it delivers rectangular map projections, not the round full-disk satellite images that make MMM-Globe look like a globe.

After investigating several alternatives, the best fit turned out to be the **CIRA SLIDER** service operated by [NOAA/RAMMB](https://rammb2.cira.colostate.edu/) at Colorado State University. SLIDER provides Meteosat full-disk imagery as individual PNG tiles, including the excellent **GeoColor** product — which shows natural color during the day and city lights on a Blue Marble background at night. This makes for a particularly stunning globe display around sunrise and sunset.

The SLIDER API is a bit unusual: image URLs contain a timestamp that changes every 15 minutes, so a simple static URL won't work. This fork adds a `node_helper.js` that queries the SLIDER API for the latest available timestamp and constructs the correct image URL dynamically.

While working on this, two other issues with the original module were fixed: a startup reliability problem (blank globe after reboot when the network isn't ready yet) and the addition of an optional image saving feature for creating timelapse sequences.

## Installation

Navigate into your MagicMirror's `modules` folder and execute:
```bash
git clone https://github.com/rkorell/MMM-Globe.git
```

No additional dependencies are needed — the module uses only Node.js built-in modules.

## Configuration

Add the following to your `config.js`:
```js
{
    module: "MMM-Globe",
    position: "lower_third",
    config: {
        style: "meteosat",              // Europe/Africa (CIRA SLIDER, recommended)
        //style: "geoColor",            // Asia/Pacific (Himawari-8)
        //style: "centralAmericaDiscNat", // Americas (GOES-16)
        imageSize: 600,
        updateInterval: 15 * 60 * 1000, // 15 min for meteosat, 10 min for other styles
        retryDelay: 30 * 1000,
        enableImageSaving: false
    }
},
```

### Options

| Option | Description |
|--------|-------------|
| `style` | Image style. See [Available styles](#available-styles) below.<br>**Type:** `string` **Default:** `"geoColor"` |
| `imageSize` | Size of the displayed image in pixels.<br>**Type:** `integer` **Default:** `600` |
| `updateInterval` | How often the image is updated (in milliseconds). For the `meteosat` style, CIRA SLIDER updates every 15 minutes, so `15 * 60 * 1000` is a good choice. The original Himawari styles update every 10 minutes.<br>**Default:** `10 * 60 * 1000` (10 minutes) |
| `ownImagePath` | URL to a custom image. Overrides `style` when set.<br>**Default:** `""` |
| `retryDelay` | Delay before retrying after a failed image load. Useful at boot time when the network may not be ready yet.<br>**Type:** `integer` (milliseconds) **Default:** `30000` (30 seconds) |
| `enableImageSaving` | When set to `true`, each satellite image is downloaded and saved to the `images/` subfolder inside the module directory. Currently only supported for the `meteosat` style. Files are named with the SLIDER timestamp (e.g., `globe_20260227123000.png`) so you can easily verify image updates or create timelapse animations. Duplicate timestamps are automatically skipped.<br>**Type:** `boolean` **Default:** `false` |

### Available styles

| Style | Satellite | Region | Source | Status |
|-------|-----------|--------|--------|--------|
| `meteosat` | Meteosat (0°) | Europe / Africa | [CIRA SLIDER](https://slider.cira.colostate.edu) | **Active** (updates every 15 min) |
| `geoColor` | Himawari-8 | Asia / Pacific | [RAMMB](http://rammb.cira.colostate.edu/ramsdis/online/himawari-8.asp) | Active |
| `natColor` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `airMass` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `fullBand` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `centralAmericaDiscNat` | GOES-16 | Americas | [NOAA STAR](https://www.star.nesdis.noaa.gov/GOES/) | Active |
| `europeDiscNat` | Meteosat MSG | Europe / Africa | EUMETSAT | **Discontinued** (Feb 2026) |
| `europeDiscSnow` | Meteosat MSG | Europe / Africa | EUMETSAT | **Discontinued** (Feb 2026) |

**Note:** If you were using `europeDiscNat` or `europeDiscSnow`, switch to `meteosat` — it provides the same Meteosat satellite view of Europe and Africa, with the bonus of a beautiful nighttime visualization.

## What changed compared to the original?

### New: Meteosat via CIRA SLIDER (`style: "meteosat"`)

The main reason for this fork. Uses the CIRA SLIDER API at Colorado State University as a backend for Meteosat full-disk GeoColor imagery. The implementation consists of two parts:

- **`node_helper.js`** queries the SLIDER API for the latest available timestamp (server-side, to avoid CORS restrictions in MagicMirror's Electron environment) and sends the constructed image URL to the frontend.
- **`MMM-Globe.js`** receives the URL and loads the image as before.

### Bugfixes from the original module

- **`europeDiscSnow` hi-res URL mismatch:** The original had a key mismatch between `imageUrls` (`europeDiscSnow`) and `hiResImageUrls` (`europePartSnow`). Using `europeDiscSnow` with `imageSize > 800` silently failed because the hi-res lookup returned `undefined`. Both keys are now consistent.
- **Mixed content (HTTP → HTTPS):** All RAMMB image URLs updated from `http://` to `https://` to prevent potential mixed-content issues in Electron.
- **Loose equality operators:** All `==` / `!=` comparisons replaced with strict `===` / `!==`.
- **Duplicate `var self = this`:** `socketNotificationReceived` declared the variable twice in separate branches. Consolidated to a single declaration.
- **`this.url` undefined for `meteosat` style:** When using `meteosat`, the URL lookup fell through to `this.imageUrls["meteosat"]` which returned `undefined`. Now cleanly skipped — `this.url` stays `""`.

### Housekeeping

- `.gitignore` consolidated: Visual Studio entries simplified to `/.vs/`, added `.DS_Store`
- Screenshot link changed from relative to absolute GitHub URL for compatibility with external viewers

### Fixed: Startup reliability

The original module loads satellite images inside `getDom()`, which is an async operation triggered by MagicMirror's rendering cycle. If the network isn't ready at boot time (common on Raspberry Pi), the image load fails silently and the module shows a blank area until the next `updateInterval` — which could be up to 60 minutes later.

This fork moves image loading to `start()` with an automatic retry mechanism. If a load fails, it retries after `retryDelay` (default: 30 seconds) until the image is successfully loaded.

### New: Image saving

When `enableImageSaving` is set to `true`, each satellite image is saved locally. This is primarily useful for debugging (verifying that the images actually change) and for creating timelapse animations from the saved sequence.

## Technical notes

The CIRA SLIDER API works as follows:

1. Query `https://slider.cira.colostate.edu/data/json/meteosat-0deg/full_disk/geocolor/latest_times.json` for available timestamps
2. Take the most recent timestamp (e.g., `20260227123000`)
3. Construct the tile URL: `https://slider.cira.colostate.edu/data/imagery/2026/02/27/meteosat-0deg---full_disk/geocolor/20260227123000/00/000_000.png`

Zoom level `00` returns the full disk as a single 464×464 PNG tile — perfect for MMM-Globe's CSS circle clipping.

## Special Thanks

- **[Luke Scheffler](https://github.com/LukeSkywalker92)** ([@lukecodewalker](https://forum.magicmirror.builders/user/lukecodewalker) on the MagicMirror forum) for creating MMM-Globe. The original module's design — a simple, elegant idea that turns satellite imagery into a globe using pure CSS — is what makes this module so appealing. This fork builds on his work.
- **[CIRA / RAMMB](https://rammb2.cira.colostate.edu/)** at Colorado State University for providing the SLIDER satellite imagery service, freely available to the public.

## License

MIT — see [LICENCE](LICENCE).
