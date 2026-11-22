/* MMM-Globe — Source table
 *
 * Everything the module knows about a source is here. A new source is one more entry,
 * not one more branch in the cycle.
 *
 * Modified: [2026-11-02 21:17] - Created
 * Modified: [2026-11-11 14:38] - Taken over into MMM-Globus-Neu2; cadence and buffer now
 *                                apply to the own URL as well
 * Modified: [2026-11-12 11:01] - All comments in English
 */

const CIRA = "https://slider.cira.colostate.edu";

const MINUTE = 60 * 1000;

// Interval between two polls during titration, and margin added to every grid poll.
// Together they limit the delay to at most two minutes.
const SYNC_INTERVAL = 1 * MINUTE;
const BUFFER = 1 * MINUTE;

const SOURCES = {
	europe: { sat: "meteosat-0deg", cadence: 15 * MINUTE },
	americas: { sat: "goes-19", cadence: 10 * MINUTE },
	pacific: { sat: "goes-18", cadence: 10 * MINUTE },
	asia: { sat: "himawari", cadence: 10 * MINUTE }
};

/* Register: names the id of the latest publication, about 2.4 kB. */
function registerUrl (source) {
	return `${CIRA}/data/json/${source.sat}/full_disk/geocolor/latest_times.json`;
}

/* Id from the register response. */
function readId (json) {
	const list = json && json.timestamps_int;
	return Array.isArray(list) && list.length ? String(list[0]) : null;
}

/* Image address for an id. Date and folder name come from the same id; the three
 * hyphens before full_disk are not a typo. */
function imageUrl (source, id) {
	const date = `${id.slice(0, 4)}/${id.slice(4, 6)}/${id.slice(6, 8)}`;
	return `${CIRA}/data/imagery/${date}/${source.sat}---full_disk/geocolor/${id}/00/000_000.png`;
}

/* Id YYYYMMDDhhmmss -> file name YYYYMMDD-HHMM, UTC like the id itself. */
function fileStamp (id) {
	return `${id.slice(0, 8)}-${id.slice(8, 12)}`;
}

module.exports = { SOURCES, SYNC_INTERVAL, BUFFER, registerUrl, readId, imageUrl, fileStamp };
