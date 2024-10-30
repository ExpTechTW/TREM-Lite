function parseJSON(jsonString) {
	try {
		return JSON.parse(jsonString);
	} catch (err) {
		return null;
	}
}

function distance(latA, lngA) {
	return function(latB, lngB) {
		latA = latA * Math.PI / 180;
		lngA = lngA * Math.PI / 180;
		latB = latB * Math.PI / 180;
		lngB = lngB * Math.PI / 180;
		const sin_latA = Math.sin(Math.atan(Math.tan(latA)));
		const sin_latB = Math.sin(Math.atan(Math.tan(latB)));
		const cos_latA = Math.cos(Math.atan(Math.tan(latA)));
		const cos_latB = Math.cos(Math.atan(Math.tan(latB)));
		return Math.acos(sin_latA * sin_latB + cos_latA * cos_latB * Math.cos(lngA - lngB)) * 6371.008;
	};
}

function formatTime(timestamp) {
	const date = new Date(timestamp);
	const year = date.getFullYear();
	const month = (date.getMonth() + 1).toString().padStart(2, "0");
	const day = date.getDate().toString().padStart(2, "0");
	const hours = date.getHours().toString().padStart(2, "0");
	const minutes = date.getMinutes().toString().padStart(2, "0");
	const seconds = date.getSeconds().toString().padStart(2, "0");

	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

function search_loc_name(global_data, int) {
	for (const city of Object.keys(global_data.region))
		for (const town of Object.keys(global_data.region[city]))
			if (global_data.region[city][town].code == int)
				return `${city}${town}`;
	return undefined;
}

function search_loc_code(global_data, str) {
	for (const city of Object.keys(global_data.region))
		for (const town of Object.keys(global_data.region[city]))
			if (`${city}${town}` == str)
				return global_data.region[city][town].code;
	return undefined;
}

function includes_search_loc_code(global_data, str) {
	for (const city of Object.keys(global_data.region))
		for (const town of Object.keys(global_data.region[city]))
			if (str.includes(`${city}${town}`))
				return global_data.region[city][town].code;
	return undefined;
}

function formatTimestamp(Timestamp) {
	const date = new Date(Timestamp);
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	return `${hours}:${minutes}`;
}

async function fetchData(Logger, url, timeout = 1000) {
	const controller = new AbortController();
	const timeoutId = setTimeout(() => controller.abort(), timeout);
	try {
		const response = await fetch(url, { signal: controller.signal });
		clearTimeout(timeoutId);
		return response;
	} catch (error) {
		if (error.name === "AbortError") Logger.error(`[fetchData] => time out | ${url}`);
		else Logger.error(`[fetchData] => fetch error: ${error.message} | ${url}`);
		return null;
	}
}

module.exports = {
	parseJSON,
	formatTime,
	distance,
	formatTimestamp,
	search_loc_name,
	fetchData,
	search_loc_code,
	includes_search_loc_code,
};