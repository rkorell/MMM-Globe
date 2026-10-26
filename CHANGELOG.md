# Changelog

What changed compared to the original module, newest first. This history was part of
`README.md` until it moved here; the entries themselves are unchanged.

## v3.5.0 — Sync to the publication grid (Oct 2026)

- **New `syncDelay` parameter**: Locks the SLIDER polls onto the publication grid of the service. The module titrates the unknown phase in `syncDelay` steps, takes the first observed change plus `syncDelay` as the grid origin and then polls once per slot. The image reaches the mirror one to two `syncDelay` after publication, at one list request and one image per slot instead of one request per minute. Off by default. See [Synchronising to the publication grid](README.md#synchronising-to-the-publication-grid).
- **`sliderPollInterval` default is now `10 * 60 * 1000`** instead of 60 seconds. **If you have never set this option, your setup changes.** The 60 seconds only ever made sense as a brute-force substitute for knowing the phase: it polled fifteen times per image so that the newest one would never be more than a minute old. Ten minutes is the real cadence of GOES-19, GOES-18 and Himawari, and `geoColorEurope` wants `15 * 60 * 1000`. Without `syncDelay` the polls still run free, so an image can now be up to one interval old; for the three satellites whose cadence equals the new default, the phase even stands still and the delay stays wherever the start put it. Setting `syncDelay` removes that — it is the whole point of the pairing. Setups that already configure `sliderPollInterval` are unaffected.
- **Every interface error is retried now**: An HTTP error status and unreadable JSON on the list request used to wait a full poll interval instead of `retryDelay`, and an HTTP error, socket error or timeout on the image download was not retried at all. With 60 second polling that was invisible; with ten or fifteen minutes it costs a whole slot. All of them now retry — the list after `retryDelay` and never later than the next regular poll, the image through the existing 30 s / 90 s chain. An interface error never consumes a follow-up step and never moves the grid.
- **No new log noise**: the only new messages are ERROR lines for a configuration that cannot sync (cadence mismatch, `syncDelay` at or above the cadence) and the WARN of the existing clamp pattern. A missing slot is not logged.

## v3.4.1 — Two SLIDER polling defects (Oct 2026)

- **Poll chain no longer multiplies after a timeout**: `req.destroy()` in the timeout handler also emits an `error` event, so the timeout path and the error path each scheduled a successor — every timeout permanently doubled the number of running poll chains, and each one issued its own requests. All SLIDER paths now schedule through a single timer that is cleared before it is replaced, so exactly one poll is ever pending. Chains that already multiplied collapse back to one at the next poll, without needing a restart.
- **A failed image download no longer loses the slot**: the timestamp was marked as fetched before the download ran, and `downloadAndServe` reported neither success nor failure. If the image never arrived — validation failure, HTTP error, socket error, timeout, screen off, unwritable file — that image was skipped for good. The timestamp is now recorded only after the image has been written and handed to the frontend, so the next poll fetches the slot again.
- **No config changes**: `sliderPollInterval` keeps the meaning it has in v3.4.0, and the static styles are untouched.
- **Thanks** again to [@OberfragGER](https://github.com/OberfragGER), whose Pi-hole log in issue [#2](https://github.com/rkorell/MMM-Globe/issues/2) showed four to five requests per poll where there should have been two, which is what exposed the first defect.

## v3.4.0 — Configurable SLIDER poll interval (Oct 2026)

- **New `sliderPollInterval` parameter**: Sets how often the CIRA SLIDER API is asked for a new image, for the SLIDER styles (`geoColorEurope`/`USA`/`Pacific`/`Asia` and the `meteosat` alias). Previously hardcoded to 60 seconds. Since SLIDER publishes a new image only every 10–15 minutes, a longer interval such as `15 * 60 * 1000` costs nothing in freshness and reduces outbound requests to the same external host. Defaults to the previous 60 seconds, so existing setups are unaffected.
- **Minimum enforced at 60 seconds**: Lower values are clamped to 60 s and logged as a warning. SLIDER is a free third-party service and should not be polled harder than before.
- **Closes the gap to the static styles**: Those already took their cadence from `updateInterval`; the SLIDER path now has the same configurability.
- **Thanks** to [@OberfragGER](https://github.com/OberfragGER) for reporting the missing option and supplying a working patch in issue [#2](https://github.com/rkorell/MMM-Globe/issues/2), which this release is based on.

## v3.3.0 — Configurable clip radius, footer overlay removed (Aug 2026)

- **New `clipRadius` parameter**: Overrides the circular clip radius (in percent) of the displayed globe, applied inline to both the satellite image and the coastline underlay. Lets you crop away an image border or footer on any background — e.g. `clipRadius: 48.55` removes the EUMETSAT WMS footer bar. Defaults to `null` (unchanged per-style behaviour: 50%, or 44% for `centralAmericaDiscNat`).
- **Removed the black footer overlay**: The previous CSS `::after` black bar (added to mask the EUMETSAT footer) only worked on a black mirror background and left a visible black rectangle on custom backgrounds. It is replaced by the background-agnostic `clipRadius` crop. Existing setups relying on the bar for EUMETSAT should set `clipRadius: 48.55`.
- **Thanks** to [@Muffexx](https://github.com/Muffexx) for suggesting the clip-based approach in issue [#1](https://github.com/rkorell/MMM-Globe/issues/1), which motivated this release.

## v3.2.2 — Image content validation, retries, PSC integration (Jun 2026)

- **Magic-byte validation**: Every downloaded response is checked against known image signatures (PNG, JPEG, GIF) before being written to disk. Prevents XML error bodies (notably from EUMETSAT WMS under load) from polluting `current.png` or the saved image archive.
- **Automatic retry with backoff**: When a response fails validation, the module retries up to two times within the same poll cycle (30 s, then 90 s) before giving up and waiting for the next regular poll.
- **Optional PSC integration**: Passively listens for `MMM_PSC-SCREEN_POWERSTATUS` from [MMM-PresenceScreenControl](https://github.com/rkorell/MMM-PresenceScreenControl). When the screen is reported as off, retries are suspended (regular polling continues unchanged).
- **No new config parameters**: All retry behaviour is internal. The module works identically without PSC installed.
- **Lazy static-fallback indexing**: The `static/` directory is now scanned only when the stale-fallback feature is actually triggered for the first time, not eagerly at module startup. Reduces startup work for the (common) case where the fallback never fires.

## v3.2.1 — Seasonal sun phase adjustment (Apr 2026)

- **Seasonal archive image mapping**: New `archiveSunPhase` parameter compensates for seasonal daylight differences between archive images and the current date. Uses SunCalc (from MagicMirror's built-in modules) to compute today's sunrise/sunset and maps archive images proportionally via three-segment interpolation (pre-dawn night, daytime, post-dusk night). The day/night boundary on the globe now always matches the actual time of year.
- **Mirror location**: New `lat`/`lon` config parameters for SunCalc calculation (default: Berlin).

## v3.2.0 — Static fallback for stale images (Apr 2026)

- **Automatic stale detection**: Set `switchToStaticIfStale: true` to enable. When the live satellite feed has not updated for 90 minutes (checked via `Last-Modified` HTTP header, with hash-based fallback for servers without `Last-Modified`), the module automatically switches to pre-rendered static fallback images from the `static/` subfolder. Works with `europeDiscNat`, `ownImagePath`, and other static styles.
- **Time-matched fallback images**: Fallback images are named by UTC time (`HHMM.jpg`) and the module selects the one closest to the current time, so the displayed globe always shows a realistic day/night pattern.
- **Configurable visual marker**: A small dot (rendered server-side via Python/Pillow) or text label (rendered as DOM element) can indicate archive mode. Dot markers offer pixel-perfect positioning on the globe image; text markers appear below the globe and require no additional dependencies.
- **Automatic recovery**: When the live feed returns (fresh `Last-Modified` detected), the module seamlessly switches back to live operation.
- **EUMETSAT status update**: `europeDiscNat` and `europeDiscSnow` are back online as of April 2026 but remain unreliable — subject to extended outages without notice. The static fallback feature provides resilience for users of these styles.

## v3.1.0 — Multi-satellite SLIDER support (Mar 2026)

- **Four SLIDER perspectives**: GeoColor imagery from four geostationary satellites — `geoColorEurope` (Meteosat), `geoColorUSA` (GOES-19), `geoColorPacific` (GOES-18), `geoColorAsia` (Himawari). All provide the same beautiful day/night visualization with city lights.
- **Backwards compatible**: The old `meteosat` style name continues to work as an alias for `geoColorEurope`.
- **Frontend self-recovery**: The frontend now loads `current.png` immediately on start, providing instant display after browser refresh without waiting for the next backend poll cycle.
- **Coastlines for static styles only**: The `coastlines` overlay is automatically suppressed for SLIDER styles, which already have natural coastlines in the GeoColor imagery.

## v3.0.0 — Architecture refactoring (Feb 2026)

Complete refactoring of the module's internal architecture. The frontend and backend responsibilities are now cleanly separated:

- **Single download pipeline**: All image fetching consolidated into one shared `downloadAndServe()` method used by both SLIDER and static polling. Previously, different styles used different fetch paths with duplicated logic, and some paths downloaded images twice (once for display, once for saving).
- **Frontend is display-only**: The frontend (`MMM-Globe.js`) no longer fetches images, manages URLs, or knows about `enableImageSaving`. It receives a local file path from the backend and displays it. All polling, downloading, saving, and error handling runs in the backend (`node_helper.js`).
- **HTTP timeouts**: All HTTP requests now have timeouts (15s for API calls, 30s for image downloads). Previously, a stalled HTTP connection could block the entire polling chain indefinitely.
- **Configurable logging** (`logLevel`): Four levels (ERROR, WARN, INFO, DEBUG) with an unconditional startup message. Default is ERROR (silent operation). All logging happens in the backend (visible in pm2 logs), not in the Electron browser console.
- **Coastline/border underlay**: Configurable `coastlines` option with three pre-rendered overlays (europe, americas, asia) in the correct geostationary projection for each satellite view.

## v2.0.0 — New features (Feb 2026)

- **Meteosat via CIRA SLIDER** (`style: "meteosat"`): Full-disk GeoColor imagery of Europe/Africa with day/night visualization
- **EUMETSAT WMS support**: Use `ownImagePath` with WMS GetMap URLs in geostationary projection
- **Image saving for all styles**: `enableImageSaving` works for all styles, not just meteosat
- **Smart SLIDER polling**: Polls at a configurable interval (60s by default) but only downloads when a genuinely new image is available

## Bugfixes from the original module

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

## Housekeeping

- `.gitignore` consolidated, `images/` directory excluded
- Screenshot link changed to absolute GitHub URL
- `package.json` updated for fork
