# MMM-Globe

A module for [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) that displays live satellite imagery of our planet as a beautiful globe on your mirror.

> Fork of [LukeSkywalker92/MMM-Globe](https://github.com/LukeSkywalker92/MMM-Globe), originally created by [Luke Scheffler](https://github.com/LukeSkywalker92). His elegant idea of using CSS `clip-path: circle()` to turn square satellite images into a globe is the heart of this module. Thank you, Luke!

## Preview

![](https://github.com/rkorell/MMM-Globe/blob/master/screenshot.png?raw=true)

**Four SLIDER perspectives** — GeoColor imagery from four geostationary satellites, each with day/night visualization and city lights:

![](https://github.com/rkorell/MMM-Globe/blob/master/four_perspectives.jpg?raw=true)

*From left to right: GOES-19 (Americas), Meteosat (Europe/Africa), GOES-18 (Pacific), Himawari (Asia/Australia)*

## Background: Why this fork?

The original MMM-Globe module has been unmaintained since 2021 but worked perfectly fine for years — until February 2026, when EUMETSAT discontinued their static image server at `eumetview.eumetsat.int`. This broke the European satellite styles (`europeDiscNat`, `europeDiscSnow`) that many European MagicMirror users relied on.

EUMETSAT migrated to a new dynamic platform at `view.eumetsat.int`, but this is a JavaScript web application — there are no static image URLs to point the module at. EUMETSAT does however offer a **WMS (Web Map Service)** endpoint that can deliver satellite images in geostationary projection — perfect for globe display (see [Using EUMETSAT WMS](#using-eumetsat-wms) below).

Additionally, the **CIRA SLIDER** service operated by [NOAA/RAMMB](https://rammb2.cira.colostate.edu/) at Colorado State University provides Meteosat full-disk imagery as PNG tiles, including the excellent **GeoColor** product — natural color during the day and city lights on a Blue Marble background at night. This makes for a particularly stunning globe display around sunrise and sunset.

This fork adds both options, plus a coastline/border overlay, image saving, configurable logging, and numerous bugfixes. The architecture has been completely refactored in v3.0.0: all image fetching now runs server-side in the node_helper, the frontend is a pure display layer, and all styles share a single download pipeline.

## Installation

Navigate into your MagicMirror's `modules` folder and execute:
```bash
cd ~/MagicMirror/modules
git clone https://github.com/rkorell/MMM-Globe.git
```

No npm dependencies are needed — the module uses only Node.js built-in modules.

**Optional:** The dot marker for the [static fallback](#static-fallback-for-stale-images) feature requires Python 3 with Pillow. Pillow is pre-installed on Raspberry Pi OS. On other systems:
```bash
cd MMM-Globe
pip install -r requirements.txt
```
Text markers and all other features work without Pillow.

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

### Options

| Option | Description |
|--------|-------------|
| `style` | Image style. See [Available styles](#available-styles) below.<br>**Type:** `string` **Default:** `"geoColor"` |
| `imageSize` | Size of the displayed image in pixels.<br>**Type:** `integer` **Default:** `600` |
| `updateInterval` | How often the image is refreshed (in milliseconds). Not used for `meteosat` (which auto-polls every 60s and only updates when a new image is available).<br>**Default:** `10 * 60 * 1000` (10 minutes) |
| `ownImagePath` | URL to a custom image. Overrides `style` when set. Works with any image URL, including EUMETSAT WMS (see [below](#using-eumetsat-wms)).<br>**Default:** `""` |
| `retryDelay` | Delay before retrying after a failed SLIDER API poll (milliseconds). For non-SLIDER styles, retries happen automatically at the next `updateInterval`.<br>**Default:** `30000` (30 seconds) |
| `enableImageSaving` | Save each satellite image to the `images/` subfolder. For the `meteosat` style, files are named with the SLIDER timestamp (e.g., `globe_20260227123000.png`) and duplicates are skipped automatically. For other styles, files are named with the local download time and duplicate images are detected via content hash (identical images are not saved again).<br>**Type:** `boolean` **Default:** `false` |
| `coastlines` | Show a coastline and country border underlay beneath the satellite image. **Only applies to static styles** — SLIDER styles (geoColor*) already have natural coastlines in the GeoColor imagery. The underlay is subtle (semi-transparent white lines on black) and only visible where the satellite image is dark (night side), thanks to CSS `mix-blend-mode: lighten`. Choose the projection matching your satellite view.<br>**Values:** `false` (off), `"europe"` (0° longitude), `"americas"` (-75.2° longitude), `"asia"` (140.7° longitude)<br>**Default:** `false` |
| `logLevel` | Controls logging verbosity in pm2 logs. `"ERROR"`: only errors. `"WARN"`: adds warnings (e.g., failed fetches). `"INFO"`: adds new images and saves. `"DEBUG"`: adds poll activity, startup details, and duplicate detection.<br>**Values:** `"ERROR"`, `"WARN"`, `"INFO"`, `"DEBUG"` **Default:** `"ERROR"` |
| `switchToStaticIfStale` | When `true`, automatically switches to pre-rendered static fallback images if the live satellite feed has not updated for 90 minutes. Only applies to static styles (`europeDiscNat`, `ownImagePath`, etc.), not SLIDER styles. See [Static Fallback for Stale Images](#static-fallback-for-stale-images) below.<br>**Type:** `boolean` **Default:** `false` |
| `staleFallbackMarker` | Visual marker to indicate archive mode on fallback images. Three formats:<br>• `"off"` — no marker<br>• `"X:Y"` or `"X:Y:Px"` or `"X:Y:Px:Color"` — draws a dot at pixel position X,Y with optional size (default 4px) and color (default `cornflowerblue`). Rendered server-side via Python/Pillow. Example: `"330:75:4:cornflowerblue"` places a subtle dot on Germany.<br>• Any other text (e.g. `"Archivbild"`) — displays the text as a small label below the globe. Rendered as a DOM element, no additional dependencies needed.<br>**Default:** `"330:75:4:cornflowerblue"` |

### Available styles

#### SLIDER styles (GeoColor with day/night visualization and city lights)

These styles use the [CIRA SLIDER](https://slider.cira.colostate.edu) API and auto-poll every 60 seconds. They only download when a new image is available (typically every 10-15 minutes depending on the satellite).

| Style | Satellite | Region | Status |
|-------|-----------|--------|--------|
| `geoColorEurope` | Meteosat (0°) | Europe / Africa | **Active** |
| `geoColorUSA` | GOES-19 (75.2°W) | North / South America | **Active** |
| `geoColorPacific` | GOES-18 (137.0°W) | Pacific / West Americas | **Active** |
| `geoColorAsia` | Himawari (140.7°E) | Asia / Australia | **Active** |
| `meteosat` | *(alias for `geoColorEurope`)* | | **Active** |

#### Static styles (polled at `updateInterval`)

| Style | Satellite | Region | Source | Status |
|-------|-----------|--------|--------|--------|
| `geoColor` | Himawari-8 | Asia / Pacific | [RAMMB](http://rammb.cira.colostate.edu/ramsdis/online/himawari-8.asp) | Active |
| `natColor` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `airMass` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `fullBand` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `centralAmericaDiscNat` | GOES-16 | Americas | [NOAA STAR](https://www.star.nesdis.noaa.gov/GOES/) | Active |
| `europeDiscNat` | Meteosat MSG | Europe / Africa | EUMETSAT | **Unreliable** — was offline Feb 2026, back online Apr 2026, but subject to extended outages without notice. Use `switchToStaticIfStale: true` for resilience. |
| `europeDiscSnow` | Meteosat MSG | Europe / Africa | EUMETSAT | **Unreliable** — same as `europeDiscNat` |

**Note:** If you were using `europeDiscNat` or `europeDiscSnow`, consider switching to `geoColorEurope` — it provides the same Meteosat satellite view of Europe and Africa, with the bonus of a beautiful nighttime visualization. The old `meteosat` style name still works as an alias. If you prefer to keep `europeDiscNat` (which is back online as of April 2026 but unreliable), enable `switchToStaticIfStale: true` to automatically fall back to archive images during EUMETSAT outages.

### Using EUMETSAT WMS

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

Some useful WMS layers:

| Layer | Description |
|-------|-------------|
| `msg_fes:rgb_naturalenhncd` | Natural enhanced color (day side only, best colors) |
| `mtg_fd:rgb_geocolour` | MTG GeoColour (full disk, brownish tint) |
| `mtg_fd:rgb_truecolour` | MTG True Colour (full disk) |

The `msg_fes` layers update every 15 minutes, `mtg_fd` layers every 10 minutes. Set `updateInterval` accordingly.

### Coastline underlay

**Note:** Coastlines are only applied for static styles. SLIDER styles (`geoColorEurope`, `geoColorUSA`, etc.) already include natural coastlines in their GeoColor imagery — the overlay is automatically suppressed.

The `coastlines` option adds a subtle underlay of coastlines and country borders beneath the satellite image. Three pre-rendered PNG overlays (1200×1200, downscaled for thinner lines) are included, each in the correct geostationary projection:

- `"europe"` — centered at 0° longitude (Meteosat perspective)
- `"americas"` — centered at -75.2° longitude (GOES-16 perspective)
- `"asia"` — centered at 140.7° longitude (Himawari-8 perspective)

The underlay uses CSS `mix-blend-mode: lighten`, which means the coastlines are only visible where the satellite image is dark (night side or black background). On the bright day side, the satellite image dominates completely. This creates a natural effect where borders fade in as the Earth rotates into night.

The coastline data comes from Natural Earth (`ne_10m_coastline` + `ne_boundary_lines_land`) via the EUMETSAT WMS background layers.

### Static Fallback for Stale Images

EUMETSAT's data processing pipeline occasionally experiences extended outages (e.g., April 2026: >30 hours of stale imagery). During such events, the module would display the same frozen satellite image for hours or even days. The static fallback feature addresses this by automatically switching to pre-rendered archive images that match the current time of day.

**How it works:**

1. On each poll, the module checks the `Last-Modified` HTTP header of the downloaded image
2. If the image is older than 90 minutes, it is considered stale
3. The module selects a matching static fallback image from the `static/` subfolder based on the current UTC time
4. An optional visual marker (configurable dot or text) is drawn on the fallback image to indicate archive mode
5. When the live feed recovers (fresh image detected), the module automatically switches back to live operation

**Preparing static fallback images:**

The `static/` subfolder should contain pre-rendered satellite images with coastline overlay, named by UTC time: `0000.jpg`, `0015.jpg`, ..., `2345.jpg` (15-minute intervals recommended, but any subset works). One example image (`1200.jpg`) is included in the repository. To create a full set:

1. Enable `enableImageSaving: true` in your config and let the module collect images over a full day
2. Use a tool like Python/Pillow to merge each saved image with the matching coastline overlay (the `coastlines_europe.png` file included in the module)
3. Name the merged images as `HHMM.jpg` (UTC time) and place them in the `static/` subfolder

The module scans the `static/` folder at startup and selects the image closest to the current UTC time. If only one image is present, it will be used regardless of the time.

**Fallback marker configuration examples:**

```js
// Subtle blue dot on Germany (default)
staleFallbackMarker: "330:75:4:cornflowerblue"

// Larger red dot on Italy
staleFallbackMarker: "340:130:8:red"

// Text label "archive" in bottom-right corner
staleFallbackMarker: "archive"

// No marker
staleFallbackMarker: "off"
```

**Note:** The dot marker is drawn directly onto the image by the backend using Python/Pillow for pixel-perfect positioning. Text markers are rendered as DOM elements by the frontend and require no additional dependencies. Both marker types disappear automatically when the live feed recovers.

**Dependencies:** The dot marker format (`"X:Y:Px:Color"`) requires Python 3 with Pillow (`python3-pil` or `pip install Pillow`). Pillow is pre-installed on Raspberry Pi OS. Text markers and the stale detection itself have no additional dependencies.

## Architecture

The module uses a clean backend/frontend separation. The frontend knows nothing about remote URLs, polling, or image saving — it only displays what the backend provides.

**Backend (`node_helper.js`)** — all image fetching runs server-side for consistent logging in pm2 and to avoid CORS issues. Three methods with clear responsibilities:

- **`pollSlider`** (SLIDER styles: geoColorEurope/USA/Pacific/Asia): Polls the CIRA SLIDER API every 60 seconds for the configured satellite, compares the latest timestamp with the previously known one, and triggers a download only when a new image is available. On error or timeout, retries after `retryDelay`.
- **`pollStatic`** (all other styles + `ownImagePath`): Triggers a download at each `updateInterval`. Covers all built-in styles (geoColor, natColor, airMass, fullBand, europeDisc*, centralAmericaDiscNat) as well as custom URLs via `ownImagePath`.
- **`downloadAndServe`** (shared by both polling methods): Downloads the image, writes it to `images/current.png`, and sends the local file path to the frontend. When `enableImageSaving` is `true`, a timestamped copy is also saved. Duplicate detection uses SLIDER timestamps (filename-based) for meteosat and MD5 content hashes for all other styles. All HTTP requests have timeouts (15s for API calls, 30s for image downloads) to prevent stalled polling chains. For static styles with `switchToStaticIfStale` enabled, the `Last-Modified` HTTP header is checked before processing — if the image is older than 90 minutes, `serveStaticFallback` is called instead.
- **`serveStaticFallback`** (stale image handler): Selects a time-appropriate image from the `static/` subfolder, optionally draws a dot marker via Python/Pillow subprocess, writes it to `current.png`, and sends it to the frontend with a `fallbackText` field for text markers. Called automatically when the live feed is detected as stale.

**Frontend (`MMM-Globe.js`)** — pure display layer. On start, immediately loads `current.png` if it exists (instant recovery after browser refresh). Receives image path updates from the backend, loads them into an `<img>` element, and renders with CSS `clip-path: circle()`. Optionally adds a coastline underlay via CSS `mix-blend-mode: lighten` (static styles only — SLIDER styles have natural coastlines).

## What changed compared to the original?

### v3.2.0 — Static fallback for stale images (Apr 2026)

- **Automatic stale detection**: When the live satellite feed has not updated for 90 minutes (checked via `Last-Modified` HTTP header), the module automatically switches to pre-rendered static fallback images from the `static/` subfolder. Works with `europeDiscNat`, `ownImagePath`, and other static styles.
- **Time-matched fallback images**: Fallback images are named by UTC time (`HHMM.jpg`) and the module selects the one closest to the current time, so the displayed globe always shows a realistic day/night pattern.
- **Configurable visual marker**: A small dot (rendered server-side via Python/Pillow) or text label (rendered as DOM element) can indicate archive mode. Dot markers offer pixel-perfect positioning on the globe image; text markers appear below the globe and require no additional dependencies.
- **Automatic recovery**: When the live feed returns (fresh `Last-Modified` detected), the module seamlessly switches back to live operation.
- **EUMETSAT status update**: `europeDiscNat` and `europeDiscSnow` are back online as of April 2026 but remain unreliable — subject to extended outages without notice. The static fallback feature provides resilience for users of these styles.

### v3.1.0 — Multi-satellite SLIDER support (Mar 2026)

- **Four SLIDER perspectives**: GeoColor imagery from four geostationary satellites — `geoColorEurope` (Meteosat), `geoColorUSA` (GOES-19), `geoColorPacific` (GOES-18), `geoColorAsia` (Himawari). All provide the same beautiful day/night visualization with city lights.
- **Backwards compatible**: The old `meteosat` style name continues to work as an alias for `geoColorEurope`.
- **Frontend self-recovery**: The frontend now loads `current.png` immediately on start, providing instant display after browser refresh without waiting for the next backend poll cycle.
- **Coastlines for static styles only**: The `coastlines` overlay is automatically suppressed for SLIDER styles, which already have natural coastlines in the GeoColor imagery.

### v3.0.0 — Architecture refactoring (Feb 2026)

Complete refactoring of the module's internal architecture. The frontend and backend responsibilities are now cleanly separated:

- **Single download pipeline**: All image fetching consolidated into one shared `downloadAndServe()` method used by both SLIDER and static polling. Previously, different styles used different fetch paths with duplicated logic, and some paths downloaded images twice (once for display, once for saving).
- **Frontend is display-only**: The frontend (`MMM-Globe.js`) no longer fetches images, manages URLs, or knows about `enableImageSaving`. It receives a local file path from the backend and displays it. All polling, downloading, saving, and error handling runs in the backend (`node_helper.js`).
- **HTTP timeouts**: All HTTP requests now have timeouts (15s for API calls, 30s for image downloads). Previously, a stalled HTTP connection could block the entire polling chain indefinitely.
- **Configurable logging** (`logLevel`): Four levels (ERROR, WARN, INFO, DEBUG) with an unconditional startup message. Default is ERROR (silent operation). All logging happens in the backend (visible in pm2 logs), not in the Electron browser console.
- **Coastline/border underlay**: Configurable `coastlines` option with three pre-rendered overlays (europe, americas, asia) in the correct geostationary projection for each satellite view.

### v2.0.0 — New features (Feb 2026)

- **Meteosat via CIRA SLIDER** (`style: "meteosat"`): Full-disk GeoColor imagery of Europe/Africa with day/night visualization
- **EUMETSAT WMS support**: Use `ownImagePath` with WMS GetMap URLs in geostationary projection
- **Image saving for all styles**: `enableImageSaving` works for all styles, not just meteosat
- **Smart SLIDER polling**: Polls every 60s but only downloads when a genuinely new image is available

### Bugfixes from the original module

- **`europeDiscSnow` hi-res URL mismatch:** The original had a key mismatch between `imageUrls` (`europeDiscSnow`) and `hiResImageUrls` (`europePartSnow`). Using `europeDiscSnow` with `imageSize > 800` silently failed. Both keys are now consistent.
- **Mixed content (HTTP → HTTPS):** All RAMMB image URLs updated from `http://` to `https://`.
- **Loose equality operators:** All `==` / `!=` replaced with strict `===` / `!==`.
- **Cache-buster for URLs with query string:** The original appended `?timestamp` as a cache-buster, which broke URLs that already contain a `?` (such as WMS URLs). Now correctly uses `&` when a query string is already present.
- **Startup reliability:** Image loading moved out of `getDom()` into the backend polling loop with automatic retry on failure, so the globe appears even when the network isn't ready at boot time.
- **Double image downloads:** When `enableImageSaving` was enabled, images were downloaded twice — once for display, once for saving. Now a single download serves both purposes.
- **No HTTP timeouts:** The original had no timeouts on HTTP requests. A stalled connection (e.g., unresponsive image server) would silently stop all polling. Now enforced at 15s/30s.
- **`loadImage` as global function:** The original's `loadImage()` function was defined in the global scope, risking name collisions with other modules. Now scoped as `_loadImage()` inside the module.
- **`europeDiscNat` height hack:** Removed a hard-coded height adjustment in `getDom()` that was specific to the discontinued `europeDiscNat` style's non-square image format.
- **Silent frontend failures:** Image load errors in the frontend were swallowed silently. Now logged via `Log.warn()`.

### Housekeeping

- `.gitignore` consolidated, `images/` directory excluded
- Screenshot link changed to absolute GitHub URL
- `package.json` updated for fork

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

The geostationary projection `AUTO:42003,9001,{lon},0` maps the visible Earth disk as seen from a geostationary satellite at the given longitude. This produces a circular Earth image that works perfectly with the module's `clip-path: circle()` styling.

## Special Thanks

- **[Luke Scheffler](https://github.com/LukeSkywalker92)** ([@lukecodewalker](https://forum.magicmirror.builders/user/lukecodewalker) on the MagicMirror forum) for creating MMM-Globe. The original module's design — a simple, elegant idea that turns satellite imagery into a globe using pure CSS — is what makes this module so appealing. This fork builds on his work.
- **[CIRA / RAMMB](https://rammb2.cira.colostate.edu/)** at Colorado State University for providing the SLIDER satellite imagery service, freely available to the public.
- **[EUMETSAT](https://www.eumetsat.int/)** for providing the WMS endpoint and Natural Earth background layers used for the coastline underlay.

## License

MIT — see [LICENCE](LICENCE).
