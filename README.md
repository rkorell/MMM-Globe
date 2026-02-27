# MMM-Globe

A module for [MagicMirror²](https://github.com/MagicMirrorOrg/MagicMirror) that displays live satellite imagery of our planet as a beautiful globe on your mirror.

> Fork of [LukeSkywalker92/MMM-Globe](https://github.com/LukeSkywalker92/MMM-Globe), originally created by [Luke Scheffler](https://github.com/LukeSkywalker92). His elegant idea of using CSS `clip-path: circle()` to turn square satellite images into a globe is the heart of this module. Thank you, Luke!

## Preview

![](https://github.com/rkorell/MMM-Globe/blob/master/screenshot.png?raw=true)

## Background: Why this fork?

The original MMM-Globe module has been unmaintained since 2021 but worked perfectly fine for years — until February 2026, when EUMETSAT discontinued their static image server at `eumetview.eumetsat.int`. This broke the European satellite styles (`europeDiscNat`, `europeDiscSnow`) that many European MagicMirror users relied on.

EUMETSAT migrated to a new dynamic platform at `view.eumetsat.int`, but this is a JavaScript web application — there are no static image URLs to point the module at. EUMETSAT does however offer a **WMS (Web Map Service)** endpoint that can deliver satellite images in geostationary projection — perfect for globe display (see [Using EUMETSAT WMS](#using-eumetsat-wms) below).

Additionally, the **CIRA SLIDER** service operated by [NOAA/RAMMB](https://rammb2.cira.colostate.edu/) at Colorado State University provides Meteosat full-disk imagery as PNG tiles, including the excellent **GeoColor** product — natural color during the day and city lights on a Blue Marble background at night. This makes for a particularly stunning globe display around sunrise and sunset.

This fork adds both options, plus a coastline/border overlay, image saving, and several bugfixes.

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
        style: "meteosat",       // see Available Styles below
        imageSize: 600,
        coastlines: "europe",    // optional: "europe", "americas", "asia"
        enableImageSaving: false
    }
},
```

### Options

| Option | Description |
|--------|-------------|
| `style` | Image style. See [Available styles](#available-styles) below.<br>**Type:** `string` **Default:** `"geoColor"` |
| `imageSize` | Size of the displayed image in pixels.<br>**Type:** `integer` **Default:** `600` |
| `updateInterval` | How often the image is refreshed (in milliseconds). Not used for `meteosat` (which auto-polls every 60s and only updates when a new image is available).<br>**Default:** `10 * 60 * 1000` (10 minutes) |
| `ownImagePath` | URL to a custom image. Overrides `style` when set. Works with any image URL, including EUMETSAT WMS (see [below](#using-eumetsat-wms)).<br>**Default:** `""` |
| `retryDelay` | Delay before retrying after a failed image load (milliseconds).<br>**Default:** `30000` (30 seconds) |
| `enableImageSaving` | Save each satellite image to the `images/` subfolder. For the `meteosat` style, files are named with the SLIDER timestamp (e.g., `globe_20260227123000.png`); for other styles, files are named with the local download time. Duplicate timestamps are automatically skipped.<br>**Type:** `boolean` **Default:** `false` |
| `coastlines` | Show a coastline and country border underlay beneath the satellite image. The underlay is subtle (semi-transparent white lines on black) and only visible where the satellite image is dark (night side), thanks to CSS `mix-blend-mode: lighten`. Choose the projection matching your satellite view.<br>**Values:** `false` (off), `"europe"` (0° longitude), `"americas"` (-75.2° longitude), `"asia"` (140.7° longitude)<br>**Default:** `false` |

### Available styles

| Style | Satellite | Region | Source | Status |
|-------|-----------|--------|--------|--------|
| `meteosat` | Meteosat (0°) | Europe / Africa | [CIRA SLIDER](https://slider.cira.colostate.edu) | **Active** (auto-polls every 60s) |
| `geoColor` | Himawari-8 | Asia / Pacific | [RAMMB](http://rammb.cira.colostate.edu/ramsdis/online/himawari-8.asp) | Active |
| `natColor` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `airMass` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `fullBand` | Himawari-8 | Asia / Pacific | RAMMB | Active |
| `centralAmericaDiscNat` | GOES-16 | Americas | [NOAA STAR](https://www.star.nesdis.noaa.gov/GOES/) | Active |
| `europeDiscNat` | Meteosat MSG | Europe / Africa | EUMETSAT | **Discontinued** (Feb 2026) |
| `europeDiscSnow` | Meteosat MSG | Europe / Africa | EUMETSAT | **Discontinued** (Feb 2026) |

**Note:** If you were using `europeDiscNat` or `europeDiscSnow`, switch to `meteosat` — it provides the same Meteosat satellite view of Europe and Africa, with the bonus of a beautiful nighttime visualization.

### Using EUMETSAT WMS

EUMETSAT's WMS endpoint at `view.eumetsat.int` can deliver satellite images in geostationary projection, which displays as a perfect globe with MMM-Globe's CSS circle clipping. Combined with the `coastlines: "europe"` underlay, this effectively recreates the discontinued `europeDiscNat` imagery — the old EUMETSAT static images had the same kind of coastline/border overlay baked in. Use the `ownImagePath` option with a WMS GetMap URL:

```js
config: {
    ownImagePath: "https://view.eumetsat.int/geoserver/wms?service=WMS&version=1.1.0&request=GetMap&layers=msg_fes:rgb_naturalenhncd&bbox=-6500000,-6500000,6500000,6500000&width=600&height=600&srs=AUTO:42003,9001,0,0&styles=&format=image/png&BGCOLOR=0x000000",
    imageSize: 600,
    updateInterval: 15 * 60 * 1000,
    coastlines: "europe"
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

The `coastlines` option adds a subtle underlay of coastlines and country borders beneath the satellite image. Three pre-rendered PNG overlays (1200×1200, downscaled for thinner lines) are included, each in the correct geostationary projection:

- `"europe"` — centered at 0° longitude (Meteosat perspective)
- `"americas"` — centered at -75.2° longitude (GOES-16 perspective)
- `"asia"` — centered at 140.7° longitude (Himawari-8 perspective)

The underlay uses CSS `mix-blend-mode: lighten`, which means the coastlines are only visible where the satellite image is dark (night side or black background). On the bright day side, the satellite image dominates completely. This creates a natural effect where borders fade in as the Earth rotates into night.

The coastline data comes from Natural Earth (`ne_10m_coastline` + `ne_boundary_lines_land`) via the EUMETSAT WMS background layers.

## Architecture

All image fetching runs in `node_helper.js` (server-side) for consistent logging in pm2 and to avoid CORS issues:

- **`meteosat` style:** Polls the CIRA SLIDER API every 60 seconds. Compares the latest timestamp with the previously known one and only sends a new image URL to the frontend when the timestamp changes. This ensures every new image is captured without wasteful re-downloads.
- **All other styles + `ownImagePath`:** Sends the image URL to the frontend at each `updateInterval` with a cache-busting parameter to ensure fresh content.
- **Image saving:** When `enableImageSaving` is `true`, the node_helper downloads and saves each image to the `images/` subfolder.

The frontend (`MMM-Globe.js`) only handles display: it receives image URLs from the backend, loads them into `<img>` elements, and renders them with CSS circle clipping.

## What changed compared to the original?

### New features

- **Meteosat via CIRA SLIDER** (`style: "meteosat"`): Full-disk GeoColor imagery of Europe/Africa with day/night visualization
- **EUMETSAT WMS support**: Use `ownImagePath` with WMS GetMap URLs in geostationary projection
- **Coastline/border underlay**: Optional overlay of coastlines and country borders (`coastlines` option)
- **Image saving for all styles**: `enableImageSaving` works for all styles, not just meteosat
- **Backend fetching with logging**: All image fetching moved to node_helper for pm2-visible logging
- **Smart SLIDER polling**: Polls every 60s but only downloads when a genuinely new image is available

### Bugfixes from the original module

- **`europeDiscSnow` hi-res URL mismatch:** The original had a key mismatch between `imageUrls` (`europeDiscSnow`) and `hiResImageUrls` (`europePartSnow`). Using `europeDiscSnow` with `imageSize > 800` silently failed. Both keys are now consistent.
- **Mixed content (HTTP → HTTPS):** All RAMMB image URLs updated from `http://` to `https://`.
- **Loose equality operators:** All `==` / `!=` replaced with strict `===` / `!==`.
- **Cache-buster for URLs with query string:** The original appended `?timestamp` as a cache-buster, which broke URLs that already contain a `?` (such as WMS URLs). Now correctly uses `&` when a query string is already present.
- **Startup reliability:** Image loading moved from `getDom()` to `start()` with automatic retry, so the globe appears even when the network isn't ready at boot time.

### Housekeeping

- `.gitignore` consolidated, `images/` directory excluded
- Screenshot link changed to absolute GitHub URL
- `package.json` updated for fork

## Technical notes

### CIRA SLIDER API

1. Query `https://slider.cira.colostate.edu/data/json/meteosat-0deg/full_disk/geocolor/latest_times.json` for available timestamps
2. Take the most recent timestamp (e.g., `20260227123000`)
3. Construct the tile URL: `https://slider.cira.colostate.edu/data/imagery/2026/02/27/meteosat-0deg---full_disk/geocolor/20260227123000/00/000_000.png`

Zoom level `00` returns the full disk as a single 464×464 PNG tile — perfect for MMM-Globe's CSS circle clipping.

### EUMETSAT WMS

The geostationary projection `AUTO:42003,9001,{lon},0` maps the visible Earth disk as seen from a geostationary satellite at the given longitude. This produces a circular Earth image that works perfectly with the module's `clip-path: circle()` styling.

## Special Thanks

- **[Luke Scheffler](https://github.com/LukeSkywalker92)** ([@lukecodewalker](https://forum.magicmirror.builders/user/lukecodewalker) on the MagicMirror forum) for creating MMM-Globe. The original module's design — a simple, elegant idea that turns satellite imagery into a globe using pure CSS — is what makes this module so appealing. This fork builds on his work.
- **[CIRA / RAMMB](https://rammb2.cira.colostate.edu/)** at Colorado State University for providing the SLIDER satellite imagery service, freely available to the public.
- **[EUMETSAT](https://www.eumetsat.int/)** for providing the WMS endpoint and Natural Earth background layers used for the coastline underlay.

## License

MIT — see [LICENCE](LICENCE).
