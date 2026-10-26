# MMM-Globe

A module for [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) that displays live satellite imagery of our planet as a beautiful globe on your mirror.

> Fork of [LukeSkywalker92/MMM-Globe](https://github.com/LukeSkywalker92/MMM-Globe), originally created by [Luke Scheffler](https://github.com/LukeSkywalker92). His elegant idea of using CSS `clip-path: circle()` to turn square satellite images into a globe is the heart of this module. Thank you, Luke!

This file is ordered by what you are here for:

- **Setting it up** — [Installation](#installation), [Update](#update), [Configuration](#configuration), [Available styles](#available-styles), [MMM-PresenceScreenControl](#optional-integration-with-mmm-presencescreencontrol)
- **Running it** — [Synchronising to the publication grid](#synchronising-to-the-publication-grid), [Using EUMETSAT WMS](#using-eumetsat-wms), [Coastline underlay](#coastline-underlay), [Static fallback for stale images](#static-fallback-for-stale-images), [Reliability & error handling](#reliability--error-handling)
- **How it works inside** — [Architecture](#architecture), [Technical notes](#technical-notes)

The version history lives in [CHANGELOG.md](CHANGELOG.md).

## Preview

![](https://raw.githubusercontent.com/rkorell/MMM-Globe/master/screenshot.png)

**Four SLIDER perspectives** — GeoColor imagery from four geostationary satellites, each with day/night visualization and city lights:

![](https://raw.githubusercontent.com/rkorell/MMM-Globe/master/four_perspectives.jpg)

*From left to right: GOES-19 (Americas), Meteosat (Europe/Africa), GOES-18 (Pacific), Himawari (Asia/Australia)*

## Background: Why this fork?

The original MMM-Globe module has been unmaintained since 2021 but worked perfectly fine for years — until February 2026, when EUMETSAT discontinued their static image server at `eumetview.eumetsat.int`. This broke the European satellite styles (`europeDiscNat`, `europeDiscSnow`) that many European MagicMirror users relied on. Those URLs came back in April 2026 and are, as of October 2026, gone again — see [Available styles](#available-styles) for what is measured and what to use instead.

EUMETSAT migrated to a new dynamic platform at `view.eumetsat.int`, but this is a JavaScript web application — there are no static image URLs to point the module at. EUMETSAT does however offer a **WMS (Web Map Service)** endpoint that can deliver satellite images in geostationary projection — perfect for globe display (see [Using EUMETSAT WMS](#using-eumetsat-wms) below).

Additionally, the **CIRA SLIDER** service operated by [NOAA/RAMMB](https://rammb2.cira.colostate.edu/) at Colorado State University provides Meteosat full-disk imagery as PNG tiles, including the excellent **GeoColor** product — natural color during the day and city lights on a Blue Marble background at night. This makes for a particularly stunning globe display around sunrise and sunset.

This fork adds both options, plus a coastline/border overlay, image saving, configurable logging, and numerous bugfixes. The architecture has been completely refactored in v3.0.0: all image fetching now runs server-side in the node_helper, the frontend is a pure display layer, and all styles share a single download pipeline.

---

## Installation

Navigate into your MagicMirror's `modules` folder and execute:
```bash
cd ~/MagicMirror/modules
git clone https://github.com/rkorell/MMM-Globe.git
```

The module uses Node.js built-in modules plus **`suncalc`**, which it needs for the [seasonal sun phase adjustment](#seasonal-sun-phase-adjustment). `suncalc` is not declared in this module's `package.json`; it currently resolves from MagicMirror's own `node_modules`, because MagicMirror lists it as a dependency of its own. On a normal MagicMirror installation nothing else is required. If your setup does not provide it (a non-hoisting package manager, or MagicMirror dropping the dependency), the module's backend fails to load and the globe stays empty with a single `Error when loading MMM-Globe` line in the pm2 log; installing `suncalc` in the module folder fixes that.

**Optional:** The dot marker for the [static fallback](#static-fallback-for-stale-images) feature requires Python 3 with Pillow. Pillow is pre-installed on Raspberry Pi OS. On other systems:
```bash
cd MMM-Globe
pip install -r requirements.txt
```
Text markers and all other features work without Pillow.

## Update

To update the module to the latest version, navigate into the module folder and pull the latest changes:
```bash
cd ~/MagicMirror/modules/MMM-Globe
git pull
```
No `npm install` is needed — unless a release says so, which only happens when `package.json` or `package-lock.json` changed. In that case the order is: `rm -rf node_modules`, then `git pull`, then `npm install`.

## Configuration

Add the following to your `config.js`:
```js
{
    module: "MMM-Globe",
    position: "lower_third",
    config: {
        style: "geoColorEurope", // see Available Styles below
        imageSize: 600,
        enableImageSaving: false,
        logLevel: "ERROR"        // "ERROR", "WARN", "INFO", "DEBUG"
    }
},
```

For the Americas view with night city lights:
```js
config: {
    style: "geoColorUSA",
    imageSize: 600
}
```

Full configuration with all options:
```js
{
    module: "MMM-Globe",
    position: "lower_third",
    config: {
        style: "europeDiscNat",           // satellite image style (see Available Styles)
        imageSize: 600,                   // display size in pixels; >800 also switches to the hi-res source
        updateInterval: 10 * 60 * 1000,   // poll interval for static styles (10 min)
        sliderPollInterval: 10 * 60 * 1000, // SLIDER cadence (10 min; 15 min for meteosat-0deg)
        syncDelay: 0,                     // >0 (ms): lock the polls onto the publication grid
        retryDelay: 30 * 1000,            // retry delay on failed SLIDER list request (30s)
        ownImagePath: "",                 // custom image URL (overrides style, except for SLIDER styles)
        enableImageSaving: false,         // save images to images/ subfolder
        coastlines: "europe",             // coastline overlay: false, "europe", "americas", "asia"
        clipRadius: null,                 // null = per-style default; number = clip radius in percent
        logLevel: "ERROR",                // "ERROR", "WARN", "INFO", "DEBUG"
        switchToStaticIfStale: true,      // show archive images when the live feed goes stale
        staleFallbackMarker: "330:75:4:cornflowerblue",  // "off", "X:Y:Px:Color", or text label
        archiveSunPhase: "0730:1830",     // sunrise:sunset UTC of archive images (seasonal adjust)
        lat: 52.52,                       // mirror location latitude (for seasonal adjustment)
        lon: 13.405                       // mirror location longitude
    }
},
```

### Options

| Option | Description |
|--------|-------------|
| `style` | Image style. See [Available styles](#available-styles) below.<br>**Type:** `string` **Default:** `"geoColor"` |
| `imageSize` | Size of the displayed image in pixels. **A value above 800 also switches the download to the hi-res source** for the Himawari-8 and `centralAmericaDiscNat` styles — for `natColor` that is 36.8 MB per poll instead of 257 KB (measured 2026-10-26). `fullBand`, `europeDiscNat` and `europeDiscSnow` have no separate hi-res URL, so the value only affects their display size.<br>**Type:** `integer` **Default:** `600` |
| `updateInterval` | How often the image is refreshed (in milliseconds). Not used for SLIDER styles (`geoColorEurope`/`USA`/`Pacific`/`Asia` and the `meteosat` alias), which poll at `sliderPollInterval` and only update when a new image is available.<br>**Type:** `integer` **Default:** `10 * 60 * 1000` (10 minutes) |
| `sliderPollInterval` | How often the CIRA SLIDER API is asked for a new image (in milliseconds). Only applies to SLIDER styles; static styles use `updateInterval`. The value is read in two ways. Without `syncDelay` it is simply the poll rate, and the polls run free: a longer interval costs no images, but the one on screen can be up to one interval old, because the module cannot know when the satellite published it. With `syncDelay` set it is the **cadence of the satellite** and must match it exactly (see the cadence column under [Available styles](#available-styles)); a mismatch is reported and switches the sync off. Values below 60 seconds are rejected and clamped to the minimum (logged as a warning), since SLIDER is a third-party service.<br>**Type:** `integer` **Default:** `10 * 60 * 1000` (10 minutes; 60 seconds minimum) |
| `syncDelay` | Locks the polls onto the publication grid of the service (in milliseconds). `0` turns it off. When set, the module titrates the unknown publication phase in steps of this size, and from then on polls once per slot, shortly after a new image appears — one or two `syncDelay` after publication instead of up to a full interval. It is also the step size for the up to three follow-up attempts when a slot is late or missing. Values below 60 seconds are raised to 60 seconds; a value at or above the cadence switches the sync off and is reported. See [Synchronising to the publication grid](#synchronising-to-the-publication-grid).<br>**Type:** `integer` **Default:** `0` (off) |
| `ownImagePath` | URL to a custom image. Overrides `style` for all static styles. **It does not override the SLIDER styles** (`geoColorEurope`/`USA`/`Pacific`/`Asia`, `meteosat`): if one of those is configured, the module polls SLIDER and ignores `ownImagePath` without a log line. Works with any image URL, including EUMETSAT WMS (see [below](#using-eumetsat-wms)).<br>**Type:** `string` **Default:** `""` |
| `retryDelay` | Delay before retrying a failed SLIDER **list** request (milliseconds). It does not govern image downloads: a failed image download is retried twice with a fixed backoff of 30 s and then 90 s, for SLIDER and static styles alike (see [Reliability & error handling](#reliability--error-handling)).<br>**Type:** `integer` **Default:** `30000` (30 seconds) |
| `enableImageSaving` | Save each satellite image to the `images/` subfolder. For all four SLIDER styles (and the `meteosat` alias), files are named with the SLIDER timestamp (e.g., `globe_20260227123000.png`) and duplicates are skipped by filename. For static styles, files are named with the local download time and duplicate images are detected via content hash (identical images are not saved again).<br>**Type:** `boolean` **Default:** `false` |
| `coastlines` | Show a coastline and country border underlay beneath the satellite image. **Only applies to static styles** — SLIDER styles already have natural coastlines in the GeoColor imagery, so the underlay is suppressed there. See [Coastline underlay](#coastline-underlay) for how it is drawn and which projection to pick.<br>**Values:** `false` (off), `"europe"`, `"americas"`, `"asia"`<br>**Default:** `false` |
| `clipRadius` | Override the circular clip radius (in percent) of the displayed globe. Leave at `null` to keep the per-style default (50%, or 44% for `centralAmericaDiscNat`). Set a smaller value to crop away an unwanted image border or footer on **any** background. The override also applies to the `coastlines` underlay. Must be a number — a quoted `"48.55"` is silently ignored.<br>**Type:** `number` (or `null`) **Default:** `null` |
| `logLevel` | Controls logging verbosity in pm2 logs. `"ERROR"`: only errors. `"WARN"`: adds warnings (e.g., failed fetches). `"INFO"`: adds new images, saves, and entering or leaving archive mode. `"DEBUG"`: adds poll activity, startup details, and duplicate detection.<br>**Values:** `"ERROR"`, `"WARN"`, `"INFO"`, `"DEBUG"` **Default:** `"ERROR"` |
| `switchToStaticIfStale` | When `true`, automatically switches to pre-rendered static fallback images once the live satellite feed stops changing. Only applies to static styles (`europeDiscNat`, `ownImagePath`, etc.), not SLIDER styles. See [Static fallback for stale images](#static-fallback-for-stale-images) for the thresholds that actually apply.<br>**Type:** `boolean` **Default:** `false` |
| `staleFallbackMarker` | Visual marker to indicate archive mode on fallback images. See [Fallback marker](#fallback-marker) for the three formats and their dependencies.<br>**Type:** `string` **Default:** `"330:75:4:cornflowerblue"` |
| `archiveSunPhase` | Sunrise and sunset times (UTC) of the archive images, determined by visual inspection. Format: `"HHMM:HHMM"`, e.g. `"0730:1830"`. When set, the module adjusts archive image selection to compensate for seasonal daylight differences between the archive date and today. Requires `lat`/`lon` **and** `switchToStaticIfStale: true` — the value is only ever read while serving a fallback image, so without that switch it does nothing. Leave empty to disable (direct UTC matching).<br>**Type:** `string` **Default:** `""` |
| `lat` | Mirror location latitude. Used by `archiveSunPhase` for SunCalc sunrise/sunset calculation, and therefore only effective together with it.<br>**Type:** `number` **Default:** `52.52` (Berlin) |
| `lon` | Mirror location longitude. Same conditions as `lat`.<br>**Type:** `number` **Default:** `13.405` (Berlin) |

### Available styles

#### SLIDER styles (GeoColor with day/night visualization and city lights)

These styles use the [CIRA SLIDER](https://slider.cira.colostate.edu) API and poll at `sliderPollInterval`. They only download when a new image is available. The cadence column is measured, not assumed: over the 99 gaps between the 100 entries of `latest_times.json`, these values dominate (97 of 99 for Meteosat, 98 of 99 for the others); the remainder are single missing slots showing up as exactly double, plus one 601-second gap on GOES-19 (measured 2026-10-26).

| Style | Satellite | Region | Cadence | Status |
|-------|-----------|--------|---------|--------|
| `geoColorEurope` | Meteosat (0°) | Europe / Africa | 15 min | **Active** |
| `geoColorUSA` | GOES-19 (75.2°W) | North / South America | 10 min | **Active** |
| `geoColorPacific` | GOES-18 (137.0°W) | Pacific / West Americas | 10 min | **Active** |
| `geoColorAsia` | Himawari (140.7°E) | Asia / Australia | 10 min | **Active** |
| `meteosat` | *(alias for `geoColorEurope`)* | | 15 min | **Active** |

Set `sliderPollInterval` to the cadence of your satellite, and add `syncDelay` if you want the image as soon as it appears — see [Synchronising to the publication grid](#synchronising-to-the-publication-grid).

#### Static styles (polled at `updateInterval`)

Status measured 2026-10-26 by requesting each URL the way the module does it — without following redirects, because Node's `http.get` does not follow them and the module only accepts HTTP 200.

| Style | Satellite | Region | Source | Status |
|-------|-----------|--------|--------|--------|
| `geoColor` | Himawari-8 | Asia / Pacific | [RAMMB](https://rammb.cira.colostate.edu/ramsdis/online/himawari-8.asp) | **Frozen** — HTTP 200, but `Last-Modified: Thu, 09 Sep 2021`. The RAMMB `latest` feed has not moved in five years. This is the module's default style; use `geoColorAsia` for the same region live. |
| `natColor` | Himawari-8 | Asia / Pacific | RAMMB | **Frozen** — same feed, `Last-Modified: 09 Sep 2021` |
| `airMass` | Himawari-8 | Asia / Pacific | RAMMB | **Frozen** — same feed, `Last-Modified: 09 Sep 2021` |
| `fullBand` | Himawari-8 | Asia / Pacific | RAMMB | **Frozen** — same feed, `Last-Modified: 09 Sep 2021` |
| `centralAmericaDiscNat` | GOES-16 | Americas | [NOAA STAR](https://www.star.nesdis.noaa.gov/GOES/) | **Broken** — the GOES16 path answers `301` and points at the identical GOES19 path, which is live and current. The module does not follow the redirect, so no image arrives. |
| `europeDiscNat` | Meteosat MSG | Europe / Africa | EUMETSAT | **Discontinued** — `301` to `https://view.eumetsat.int/`, which serves a 709-byte web app, not an image. Use `geoColorEurope` or the [WMS route](#using-eumetsat-wms). |
| `europeDiscSnow` | Meteosat MSG | Europe / Africa | EUMETSAT | **Discontinued** — same as `europeDiscNat` |

**Note:** If you were using `europeDiscNat` or `europeDiscSnow`, switch to `geoColorEurope` — it provides the same Meteosat satellite view of Europe and Africa, with the bonus of a beautiful nighttime visualization — or to the `ownImagePath` WMS route described below. The old `meteosat` style name still works as an alias for `geoColorEurope`. For the four Himawari-8 styles, `geoColorAsia` covers the same region from the same satellite position and is live.

`switchToStaticIfStale` does not help with the `301` cases: the stale check only runs on a successful HTTP 200 response, so a redirect or a server error reaches neither the `Last-Modified` nor the hash path.

## Optional integration with MMM-PresenceScreenControl

MMM-Globe passively listens for the `MMM_PSC-SCREEN_POWERSTATUS` notification emitted by [MMM-PresenceScreenControl](https://github.com/rkorell/MMM-PresenceScreenControl).

If that module is installed and reports that the screen is currently off (no presence, or inside a configured cron-off window), MMM-Globe suspends its retry attempts on upstream failures. The regular polling cycle continues unchanged, so your image archive stays complete, but the module won't issue extra retry requests that nobody would see anyway.

This is purely an optional optimisation. MMM-Globe works exactly the same way without MMM-PresenceScreenControl installed — the notification is simply never received, and retries always run.

[MMM-PresenceScreenControl](https://github.com/rkorell/MMM-PresenceScreenControl) is a presence and screen-power management module for MagicMirror² with PIR/MQTT sensor support, cron-based on/off and always-on windows, click-to-wake, and a notification API for cross-module integration. If you run MagicMirror on a Raspberry Pi with a display that should turn on and off based on presence, it's worth a look.

---

## Synchronising to the publication grid

A satellite publishes on a fixed cadence, but the module has no way of knowing *where* in that cadence it currently is. Polling therefore starts wherever MagicMirror happened to start, and that phase is what decides how old the picture on your mirror is. Poll every minute and you are never more than a minute behind, at the price of 1440 requests a day for 96 images. Poll once per cadence and you make 96 requests — but the phase stands still, and if it happens to sit badly, every image reaches the mirror almost a full cadence late, for as long as the module runs.

`syncDelay` removes that trade-off by finding the phase instead of guessing it.

```js
config: {
    style: "geoColorEurope",
    sliderPollInterval: 15 * 60 * 1000,  // the cadence of Meteosat
    syncDelay: 60 * 1000                 // titrate the phase in 1-minute steps
}
```

With that configuration the module behaves like this:

| Time | What happens |
|------|--------------|
| 10:07 | Start. The list is fetched, the image is shown, the newest entry is noted as a reference. Its age is unknown, so it is not an event. |
| 10:08 – 10:12 | Titration: the list is fetched once a minute, nothing has changed. |
| 10:13 | The newest entry is a different one. This is the first observed publication, and the image is fetched. |
| 10:14 | Grid origin: the moment it was found, plus `syncDelay` as a buffer. |
| 10:29, 10:44, 10:59 … | One list request and one image per slot, nothing in between. |

The picture is then one to two `syncDelay` old when it reaches the mirror, instead of up to a full interval — at one request per slot instead of fifteen.

The grid is built purely from arrival times. The capture timestamp an entry carries is never read for it, and that is deliberate: between capture and availability sits a processing delay that is not constant. Measured on 2026-10-26 between 11:17 and 11:47 UTC, by polling `latest_times.json` once a minute and bracketing the moment a new entry appeared: Meteosat 39–44 minutes, GOES-19 14–17 minutes across three consecutive slots, Himawari 29–34 minutes. What *is* constant is the distance between two arrivals, and that distance is the cadence — so the arrival is the only thing worth measuring.

If a slot is late or missing, the module follows up three times at `syncDelay` and then waits for the next grid point. Missing slots are not rare enough to ignore and not frequent enough to worry about: 1 to 2 % of them in the measured lists, always single ones, showing up as exactly one doubled gap. And they are never delivered afterwards — a slot that has not arrived by the time the next one does is gone for good, which is why the module stops asking after three attempts instead of chasing it. Neither the follow-ups nor any interface error move the grid; once found, origin and cadence stay put until the module restarts.

The cadence is yours to set, and `sliderPollInterval` is where you set it. The module measures the gaps in the list only to check your value, and if the two disagree it says so and falls back to plain fixed-interval polling:

```
SLIDER sync: measured cadence 900s does not match sliderPollInterval 600s — sync
disabled, polling at the configured interval. Set sliderPollInterval: 900 * 1000 to sync.
```

The same happens if the operator ever changes the publishing rate — the check runs on every list fetch, so a changed cadence is reported instead of silently producing a wrong grid.

## Using EUMETSAT WMS

EUMETSAT's WMS endpoint at `view.eumetsat.int` can deliver satellite images in geostationary projection, which displays as a perfect globe with MMM-Globe's CSS circle clipping. Combined with the `coastlines: "europe"` underlay, this effectively recreates the discontinued `europeDiscNat` imagery — the old EUMETSAT static images had the same kind of coastline/border overlay baked in. Use the `ownImagePath` option with a WMS GetMap URL:

```js
config: {
    ownImagePath: "https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.1.0&request=GetMap&layers=msg_fes:rgb_naturalenhncd&bbox=-6500000,-6500000,6500000,6500000&width=600&height=600&srs=AUTO:42003,9001,0,0&styles=&format=image/png&BGCOLOR=0x000000",
    imageSize: 600,
    updateInterval: 15 * 60 * 1000,
    coastlines: "europe",
    logLevel: "INFO"             // see new images in pm2 logs
}
```

The key parameter is `srs=AUTO:42003,9001,{longitude},0` — this geostationary projection centered on the satellite's longitude produces a round Earth disc. Set `BGCOLOR=0x000000` for a black background.

**Footer bar:** Some EUMETSAT WMS layers and sizes carry a footer bar (logo + timestamp) at the bottom. `clipRadius: 48.55` crops it away, and that works on any mirror background, not just black. Check your own layer before setting it: on `msg_fes:rgb_naturalenhncd` at 600×600 and at 1200×1200, WMS 1.1.0 as well as 1.3.0, no footer was present when measured on 2026-10-26 — the bottom rows were pure black and the disc was centred. Thanks to [@Muffexx](https://github.com/Muffexx) for the idea ([#1](https://github.com/rkorell/MMM-Globe/issues/1)).

Some useful WMS layers:

| Layer | Description |
|-------|-------------|
| `msg_fes:rgb_naturalenhncd` | Natural enhanced color (day side only, best colors) |
| `mtg_fd:rgb_geocolour` | MTG GeoColour (full disk, brownish tint) |
| `mtg_fd:rgb_truecolour` | MTG True Colour (full disk) |

The `msg_fes` layers update every 15 minutes, `mtg_fd` layers every 10 minutes. Set `updateInterval` accordingly.

**The WMS tells you which slot it is serving.** Every GetMap response carries a header naming the nominal time of the image you just received:

```
warning: 99 Default value used: time=2026-10-25T11:15:00.000Z ISO8601 (msg_fes:rgb_naturalenhncd)
```

That is worth knowing for two reasons. It lets you see how far behind the live feed actually runs — at 11:37 UTC the server above was still serving the 11:15 slot. And the same header comes back for a request with `width=1&height=1`, which costs **70 bytes instead of 600 KB** while naming the identical slot (verified 2026-10-26: `content-length: 70`). So for WMS sources there is a cheap way to ask "is there anything new yet" without downloading a picture to find out — the equivalent of what `latest_times.json` is for the SLIDER styles. The module does not use this yet; `syncDelay` currently applies to the SLIDER styles only.

## Coastline underlay

The `coastlines` option adds a subtle underlay of coastlines and country borders beneath the satellite image. It applies to static styles only; for SLIDER styles it is suppressed, because the GeoColor imagery already carries its own coastlines.

Three pre-rendered PNG overlays (1200×1200, downscaled for thinner lines) are included, each in the correct geostationary projection:

- `"europe"` — centered at 0° longitude (Meteosat perspective)
- `"americas"` — centered at -75.2° longitude (GOES-16 perspective)
- `"asia"` — centered at 140.7° longitude (Himawari-8 perspective)

The underlay uses CSS `mix-blend-mode: lighten`, which means the coastlines are only visible where the satellite image is dark (night side or black background). On the bright day side, the satellite image dominates completely. This creates a natural effect where borders fade in as the Earth rotates into night.

The alignment of the overlay is calibrated for an MSG `rgb_naturalenhncd` image of 600×600 displayed at `imageSize: 750` (`MMM-Globe.css`, `.MMM-Globe-coastlines`). The vertical correction in that rule is an absolute pixel value, so at other `imageSize` values the overlay sits slightly off; adjust it in your `custom.css` if you use a markedly different size.

The coastline data comes from Natural Earth (`ne_10m_coastline` + `ne_boundary_lines_land`) via the EUMETSAT WMS background layers.

## Static fallback for stale images

EUMETSAT's data processing pipeline occasionally experiences extended outages (e.g., April 2026: >30 hours of stale imagery). During such events, the module would display the same frozen satellite image for hours or even days.

The static fallback feature addresses this: set **`switchToStaticIfStale: true`** in your config, and the module detects when the live feed has stopped changing and switches to pre-rendered archive images that match the current time of day. When the live feed recovers, the module switches back — no manual intervention needed.

Two limits are worth knowing before you rely on it. It only triggers on a **successful** download whose content has stopped changing: a server that answers with an error status, a redirect, or an HTML body instead of an image reaches neither detection path, and the mirror then keeps showing the last good image without a marker. And it applies to static styles only, not to the SLIDER styles.

### Enabling the feature

Add `switchToStaticIfStale: true` to your module config.

```js
config: {
    style: "europeDiscNat",
    imageSize: 600,
    switchToStaticIfStale: true,
    staleFallbackMarker: "330:75:4:cornflowerblue",
    archiveSunPhase: "0730:1830",
    lat: 52.52,
    lon: 13.405
}
```

### How stale detection works

There are two paths, and which one applies depends on the server:

1. **`Last-Modified` header present.** On each poll the module compares the header against the current time. If the image is older than **90 minutes**, it is considered stale and the module switches to a matching archive image.
2. **No `Last-Modified` header** (e.g. the EUMETSAT WMS). The module tracks content hashes instead and counts polls that return the identical image. It switches on the **tenth** such poll — the first one only records the reference hash, then nine identical ones follow. In elapsed time that is `9 × updateInterval`, so it matches the 90 minutes of the header path only at the default `updateInterval` of 10 minutes; at 15 minutes it takes 135 minutes, and at 30 minutes it takes 4.5 hours.

When the live feed recovers — a fresh `Last-Modified`, or a changed hash — the module automatically switches back to live operation.

### Preparing static fallback images

The `static/` subfolder should contain pre-rendered satellite images with coastline overlay, named by UTC time: `0000.jpg`, `0015.jpg`, ..., `2345.jpg` (15-minute intervals recommended, but any subset works). Only lowercase `.jpg` is recognised; `.JPG`, `.jpeg` and `.png` files are ignored. One example image (`1200.jpg`) is included in the repository. To create a full set:

1. Enable `enableImageSaving: true` in your config and let the module collect images over a full day
2. Use a tool like Python/Pillow to merge each saved image with the matching coastline overlay (the `coastlines_europe.png` file included in the module)
3. Name the merged images as `HHMM.jpg` (UTC time) and place them in the `static/` subfolder

The folder is scanned the first time the fallback actually triggers, not at startup, and the result is kept for the lifetime of the MagicMirror process — images added later are picked up after a restart. From that list the module takes the **latest image at or before** the target time, which is not necessarily the nearest one: with a gap in the grid, a target of 02:20 picks `0100.jpg` even when `0245.jpg` is 25 minutes away. If only one image is present, it is used regardless of the time.

### Seasonal sun phase adjustment

Archive images are captured on a specific date and reflect the day/night pattern of that date. As the seasons change, the actual sunrise and sunset times shift — the same UTC time may show a sunlit Europe in summer but a dark Europe in winter. Without correction, the archive images would show a noticeably wrong day/night boundary.

The **`archiveSunPhase`** parameter compensates for this. Set it to the approximate sunrise and sunset times (UTC) visible in your archive images, determined by visual inspection — look at the images and note when Germany (or your region of interest) first becomes illuminated and when it goes dark. For example, `"0730:1830"` means the archive images show sunrise around 07:30 UTC and sunset around 18:30 UTC.

The module then uses **SunCalc** to compute today's actual sunrise and sunset for your location (`lat`/`lon`) and maps the archive images proportionally:

- The archive sunrise image is shown at today's actual sunrise
- The archive sunset image is shown at today's actual sunset
- All images in between are proportionally redistributed
- Night images (before sunrise and after sunset) are adjusted inversely

This three-segment interpolation ensures the day/night boundary on the globe always looks plausible, regardless of when the archive images were originally captured.

The mapping works in minutes of the UTC day. That is correct for locations whose sunrise and sunset both fall on the same UTC date — Europe and Africa, roughly. Further east or west the daytime segment collapses and only night images are selected, and inside the polar circles SunCalc returns no sunrise or sunset at all and the mapping yields a constant image. If `archiveSunPhase` is left empty (the default), no seasonal adjustment is applied and archive images are selected by direct UTC time match.

### Fallback marker

An optional visual marker can indicate that the module is showing archive images instead of live data. Three formats are supported.

**Dot marker** — a small colored dot drawn at a specific pixel position on the globe image, rendered server-side via Python/Pillow:

```js
// Subtle blue dot on Germany (default)
staleFallbackMarker: "330:75:4:cornflowerblue"

// Larger red dot on Italy
staleFallbackMarker: "340:130:8:red"

// Format: "X:Y:Px:Color" — position, size, color
// Minimum: "X:Y" — uses defaults for size (4) and color (cornflowerblue)
```

The size value is the diameter the dot is drawn around its centre, and the drawing is inclusive on both sides, so `4` produces 5 pixels across and `4` and `5` give the same result. Coordinates are in the pixel space of the archive image (600×600 for the included one); a dot outside the circular clip is simply not visible.

**Text marker** — a small text label displayed below the globe as a DOM element, no additional dependencies needed:

```js
staleFallbackMarker: "Archivbild"
```

Any value that is not `off` and does not match the `digits:digits[:digits[:text]]` pattern becomes a text label. Note the consequence: a label like `"12:30"` matches the dot pattern and is drawn as a dot at pixel 12,30 — outside the visible circle, so neither a dot nor a label appears.

**No marker:**

```js
staleFallbackMarker: "off"
```

Both marker types disappear automatically when the live feed recovers. The dot is baked into the image file, so it survives a browser reload; the text label is sent alongside the image and reappears only with the next poll after a reload.

**Dependencies:** The dot marker format requires Python 3 with Pillow (`python3-pil` or `pip install Pillow`). Pillow is pre-installed on Raspberry Pi OS. If the call fails, the image is served without a marker and a warning is logged. Text markers and the stale detection itself have no additional dependencies.

## Reliability & error handling

Some upstream APIs (notably the EUMETSAT WMS GeoServer used via `ownImagePath`) occasionally respond with HTTP 200 but an OGC `<ServiceExceptionReport>` XML body instead of an image — typically during maintenance windows or transient connection-pool exhaustion.

Since v3.2.2, MMM-Globe validates every downloaded response against known image signatures (PNG, JPEG, GIF) before writing it to disk. Invalid responses (XML, HTML error pages, empty bodies) are discarded — the frontend keeps showing the last valid image rather than a broken one. Failed responses do not corrupt the `current.png` file shown on the mirror. Note that formats outside those three — WebP, AVIF, BMP, TIFF — are rejected as well, so a WMS configured with such a `format=` parameter never produces a visible image.

When an image download fails, the module retries the request up to two times with backoff (30 s, then 90 s) within the same poll cycle. Since v3.5.0 this covers every kind of failure — an HTTP error status, a socket error and a timeout as well as an invalid body; before, only the invalid body was retried, and with a poll interval of ten minutes or more that silently cost a whole slot. If all retries fail, a single line is emitted at WARN log level and the module waits for the next regular poll. Polling frequency itself is never reduced — your image archive (when `enableImageSaving` is on) continues to grow at the configured rate.

---

## Architecture

The module uses a clean backend/frontend separation. The frontend knows nothing about remote URLs, polling, or image saving — it only displays what the backend provides.

**Backend (`node_helper.js`)** — all image fetching runs server-side for consistent logging in pm2 and to avoid CORS issues. Five methods with clear responsibilities:

- **`pollSlider`** (SLIDER styles: geoColorEurope/USA/Pacific/Asia): Polls the CIRA SLIDER API at `sliderPollInterval` for the configured satellite, compares the latest timestamp with the previously known one, and triggers a download only when a new image is available. With `syncDelay` set it runs on a grid instead of a fixed rate: titrate the publication phase in `syncDelay` steps, take the first observed change plus `syncDelay` as the grid origin, then poll at origin + n × cadence, with up to three follow-ups at `syncDelay` on an empty grid point (`scheduleNextSliderPoll`, `scheduleSyncedPoll`). The cadence is the configured interval, verified against the gaps in the list on every fetch (`measureCadence`, `verifyCadence`). Every interface error — HTTP status, unreadable JSON, socket error, timeout — is retried after `retryDelay`, never later than the next regular poll, and never moves the grid (`scheduleAfterSliderError`).
- **`pollStatic`** (all other styles + `ownImagePath`): Triggers a download at each `updateInterval`. Covers all built-in static styles as well as custom URLs via `ownImagePath`.
- **`downloadAndServe`** (shared by both polling methods): Downloads the image, writes it to `images/current.png`, and sends the local file path to the frontend. When `enableImageSaving` is `true`, a timestamped copy is also saved. Duplicate detection uses SLIDER timestamps (filename-based) for the SLIDER styles and MD5 content hashes for all other styles. All HTTP requests have timeouts (15s for API calls, 30s for image downloads) to prevent stalled polling chains. For static styles with `switchToStaticIfStale` enabled, the `Last-Modified` header is checked before processing — if the image is older than 90 minutes, `serveStaticFallback` is called instead.
- **`serveStaticFallback`** (stale image handler): Selects a time-appropriate image from the `static/` subfolder, optionally draws a dot marker via Python/Pillow subprocess, writes it to `current.png`, and sends it to the frontend with a `fallbackText` field for text markers. When `archiveSunPhase` is configured, uses `mapToArchiveTime` for seasonal day/night adjustment.
- **`mapToArchiveTime`** (seasonal adjustment): Maps the current UTC time to an archive-equivalent time using three-segment linear interpolation based on SunCalc sunrise/sunset data.

**Frontend (`MMM-Globe.js`)** — pure display layer. On start, immediately loads `current.png` if it exists (instant recovery after browser refresh). Receives image path updates from the backend, loads them into an `<img>` element, and renders with CSS `clip-path: circle()`. Optionally adds a coastline underlay via CSS `mix-blend-mode: lighten` ([static styles only](#coastline-underlay)).

One MagicMirror limitation to be aware of: MagicMirror creates one `node_helper` per module *type*, not per instance. Two MMM-Globe entries in `config.js` therefore share one backend — the first one's configuration wins, the second one's is ignored, and both show the same image.

## Technical notes

### CIRA SLIDER API

The module polls the SLIDER API for four geostationary satellites:

| Style | Satellite path | Coverage |
|-------|---------------|----------|
| `geoColorEurope` | `meteosat-0deg` | Europe / Africa |
| `geoColorUSA` | `goes-19` | Americas |
| `geoColorPacific` | `goes-18` | Pacific |
| `geoColorAsia` | `himawari` | Asia / Australia |

The polling mechanism is identical for all satellites:

1. Query `https://slider.cira.colostate.edu/data/json/{sat}/full_disk/geocolor/latest_times.json` for available timestamps
2. Take the most recent timestamp (e.g., `20260227123000`)
3. Construct the tile URL: `https://slider.cira.colostate.edu/data/imagery/2026/02/27/{sat}---full_disk/geocolor/20260227123000/00/000_000.png`

Zoom level `00` returns the full disk as a single 464×464 PNG tile — perfect for MMM-Globe's CSS circle clipping. All four satellites provide the GeoColor product with natural daytime colors and city lights on a Blue Marble background at night.

### EUMETSAT WMS

The geostationary projection `AUTO:42003,9001,{lon},0` maps the visible Earth disk as seen from a geostationary satellite at the given longitude. This produces a circular Earth image that works perfectly with the module's `clip-path: circle()` styling. See [Using EUMETSAT WMS](#using-eumetsat-wms) for a working URL and the available layers.

---

## Version history

See [CHANGELOG.md](CHANGELOG.md) for what changed in each release, the bugfixes carried over from the original module, and the housekeeping notes.

## Special Thanks

- **[Luke Scheffler](https://github.com/LukeSkywalker92)** ([@lukecodewalker](https://forum.magicmirror.builders/user/lukecodewalker) on the MagicMirror forum) for creating MMM-Globe. The original module's design — a simple, elegant idea that turns satellite imagery into a globe using pure CSS — is what makes this module so appealing. This fork builds on his work.
- **[CIRA / RAMMB](https://rammb2.cira.colostate.edu/)** at Colorado State University for providing the SLIDER satellite imagery service, freely available to the public.
- **[EUMETSAT](https://www.eumetsat.int/)** for providing the WMS endpoint and Natural Earth background layers used for the coastline underlay.

## License

MIT — see [LICENSE](LICENSE).
