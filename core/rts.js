/* eslint-disable no-undef */
const station = {};
const station_icon = {};
const detection_box = {};

let alert_state = false;
let alert_timestamp = 0;
let pga_up_timestamp = {};
let pga_up_level = {};

const detection_data = JSON.parse(fs.readFileSync(path.resolve(app.getAppPath(), "./resource/data/detection.json")).toString());

get_station_info();
async function get_station_info() {
	try {
		const controller = new AbortController();
		setTimeout(() => {
			controller.abort();
		}, 1500);
		let ans = await fetch("https://exptech.com.tw/api/v1/file?path=/resource/station.json", { signal: controller.signal })
			.catch((err) => void 0);
		if (controller.signal.aborted || !ans) {
			setTimeout(() => get_station_info(), 500);
			return;
		}
		ans = await ans.json();
		for (let i = 0; i < Object.keys(ans).length; i++) {
			const uuid = Object.keys(ans)[i];
			station[uuid.split("-")[2]] = ans[uuid];
		}
	} catch (err) {
		console.log(err);
		setTimeout(() => get_station_info(), 500);
	}
}

function on_rts_data(data) {
	if (!WS) return;
	let max_pga = 0;
	let max_intensity = 0;
	const detection_location = data.area ?? [];
	for (let i = 0; i < Object.keys(station_icon).length; i++) {
		const key = Object.keys(station_icon)[i];
		if (!data[key]) {
			station_icon[key].remove();
			delete station_icon[key];
			i--;
		}
	}
	let rts_sation_loc = " - - -  - - ";
	let rts_sation_pga = "--";
	let rts_sation_intensity = "--";
	let rts_sation_intensity_number = 0;
	const detection_list = data.box ?? {};
	for (let i = 0; i < Object.keys(detection_list).length; i++) {
		const key = Object.keys(detection_list)[i];
		if (max_intensity < detection_list[key]) max_intensity = detection_list[key];
	}

	for (let i = 0; i < Object.keys(data).length; i++) {
		const uuid = Object.keys(data)[i];
		if (!station[uuid]) continue;
		const info = station[uuid];
		const station_data = data[uuid];
		const intensity = intensity_float_to_int(station_data.i);
		if (station_data.v > max_pga) max_pga = station_data.v;
		let icon;
		if (data.Alert && station_data.alert)
			if (intensity == 0) icon = L.divIcon({
				className : `pga_dot intensity_${intensity}`,
				html      : "<span></span>",
				iconSize  : [10 + TREM.size, 10 + TREM.size],
			});
			else {
				let _up = false;
				if (!pga_up_level[uuid] || pga_up_level[uuid] < station_data.v) {
					pga_up_level[uuid] = station_data.v;
					pga_up_timestamp[uuid] = Date.now();
				}
				if (Date.now() - (pga_up_timestamp[uuid] ?? 0) < 5000) _up = true;
				icon = L.divIcon({
					className : `${(_up) ? "dot_max" : "dot"} intensity_${intensity}`,
					html      : `<span>${int_to_intensity(intensity)}</span>`,
					iconSize  : [20 + TREM.size, 20 + TREM.size],
				});
			}
		else icon = L.divIcon({
			className : `pga_dot pga_${station_data.i.toString().replace(".", "_")}`,
			html      : "<span></span>",
			iconSize  : [10 + TREM.size, 10 + TREM.size],
		});
		const station_info_text = `<div class='report_station_box'><div>??????: ${uuid}</div><div>??????: ${info.Loc}</div><div>??????: ${station_data.i}</div><div>PGA: ${station_data.v} gal</div></div>`;
		if (!station_icon[uuid]) station_icon[uuid] = L.marker([info.Lat, info.Long], { icon: icon })
			.bindTooltip(station_info_text, { opacity: 1 })
			.addTo(TREM.Maps.main);
		else {
			station_icon[uuid].setIcon(icon);
			station_icon[uuid].setTooltipContent(station_info_text);
		}
		if ((Object.keys(TREM.EQ_list).length && !station_data.alert) || TREM.report_epicenterIcon) station_icon[uuid].getElement().style.visibility = "hidden";
		else station_icon[uuid].getElement().style.visibility = "";
		station_icon[uuid].setZIndexOffset((intensity == 0) ? Math.round(station_data.v + 5) : intensity * 10);
		if (TREM.setting.rts_station.includes(uuid)) {
			rts_sation_loc = info.Loc;
			rts_sation_intensity = station_data.i;
			rts_sation_intensity_number = intensity;
			rts_sation_pga = station_data.v;
		}
	}
	document.getElementById("rts_location").innerHTML = rts_sation_loc;
	document.getElementById("rts_pga").innerHTML = `${get_lang_string("word.pga")} ${rts_sation_pga}`;
	document.getElementById("rts_intensity").innerHTML = `${get_lang_string("word.intensity")} ${rts_sation_intensity}`;
	const rts_intensity_level = document.getElementById("rts_intensity_level");
	rts_intensity_level.innerHTML = int_to_intensity(rts_sation_intensity_number);
	rts_intensity_level.className = `intensity_center intensity_${rts_sation_intensity_number}`;
	for (let i = 0; i < Object.keys(detection_box).length; i++) {
		const key = Object.keys(detection_box)[i];
		if (detection_list[key] == undefined) {
			detection_box[key].remove();
			delete detection_box[key];
		}
	}
	for (let i = 0; i < Object.keys(detection_list).length; i++) {
		const key = Object.keys(detection_list)[i];
		if (!detection_data[key]) continue;
		let passed = false;
		for (let Index = 0; Index < Object.keys(TREM.EQ_list).length; Index++) {
			const _key = Object.keys(TREM.EQ_list)[Index];
			const _data = TREM.EQ_list[_key].data;
			let SKIP = 0;
			for (let _i = 0; _i < 4; _i++) {
				const dist = Math.sqrt(pow((detection_data[key][_i][0] - _data.lat) * 111) + pow((detection_data[key][_i][1] - _data.lon) * 101));
				if (TREM.EQ_list[_key].dist / 1000 > dist) SKIP++;
			}
			if (SKIP >= 4) {
				passed = true;
				break;
			}
		}
		if (passed) {
			if (detection_box[key]) {
				detection_box[key].remove();
				delete detection_box[key];
			}
			continue;
		}
		TREM.rts_bounds.extend(detection_data[key]);
		if (!detection_box[key])
			detection_box[key] = L.polygon(detection_data[key], {
				color     : "transparent",
				fillColor : "transparent",
				_color    : (detection_list[key] >= 4) ? "#FF0000" : (detection_list[key] >= 2) ? "#F9F900" : "#28FF28",
			}).addTo(TREM.Maps.main);
	}
	const max_pga_text = document.getElementById("max_pga");
	const max_intensity_text = document.getElementById("max_intensity");
	const detection_location_1 = document.getElementById("detection_location_1");
	const detection_location_2 = document.getElementById("detection_location_2");
	if (data.Alert) {
		if (!alert_state) {
			show_screen("rts");
			alert_state = true;
			if (alert_timestamp && Date.now() - alert_timestamp < 300_000)
				add_info("fa-solid fa-triangle-exclamation fa-2x info_icon", "yellow", "?????????", "#E800E8", "?????????????????????<br>???????????????????????????");
		}
		alert_timestamp = Date.now();
		if (max_intensity > TREM.rts_audio.intensity && TREM.rts_audio.intensity != 10) {
			const loc = detection_location[0] ?? "????????????";
			if (max_intensity > 4) {
				TREM.rts_audio.intensity = 10;
				TREM.audio.minor.push("Shindo2");
				if (speecd_use) speech.speak({ text: `???????????????${loc}` });
				new Notification("???? ????????????", {
					body   : `${loc}`,
					icon   : "../TREM.ico",
					silent : win.isFocused(),
				});
				rts_screenshot();
			} else if (max_intensity > 1) {
				TREM.rts_audio.intensity = 4;
				TREM.audio.minor.push("Shindo1");
				if (speecd_use) speech.speak({ text: `???????????????${loc}` });
				new Notification("???? ????????????", {
					body   : `${loc}`,
					icon   : "../TREM.ico",
					silent : win.isFocused(),
				});
				rts_screenshot();
			} else {
				TREM.rts_audio.intensity = 1;
				TREM.audio.minor.push("Shindo0");
				if (speecd_use) speech.speak({ text: `????????????${loc}` });
				new Notification("???? ?????????", {
					body   : `${loc}`,
					icon   : "../TREM.ico",
					silent : win.isFocused(),
				});
				rts_screenshot();
			}
		}
		if (max_pga > TREM.rts_audio.pga && TREM.rts_audio.pga <= 250)
			if (max_pga > 250) {
				TREM.rts_audio.pga = max_pga;
				TREM.audio.minor.push("PGA2");
				rts_screenshot();
			} else if (max_pga > 8) {
				TREM.rts_audio.pga = 250;
				TREM.audio.minor.push("PGA1");
				rts_screenshot();
			}
		if (!Object.keys(TREM.EQ_list).length) {
			document.getElementById("eew_title_text").innerHTML = (max_intensity >= 4) ? get_lang_string("detection.high") : (max_intensity >= 2) ? get_lang_string("detection.middle") : get_lang_string("detection.low");
			document.getElementById("eew_box").style.backgroundColor = (max_intensity >= 4) ? "#E80002" : (max_intensity >= 2) ? "#C79A00" : "#149A4C";
			let _text_1 = "";
			let _text_2 = "";
			let count = 0;
			for (let i = 0; i < detection_location.length; i++) {
				const loc = detection_location[i];
				if (count < 4) _text_1 += `${loc}<br>`;
				else _text_2 += `${loc}<br>`;
				count++;
			}
			detection_location_1.innerHTML = _text_1;
			detection_location_2.innerHTML = _text_2;
			detection_location_1.className = "detection_location_text";
			detection_location_2.className = "detection_location_text";
		} else clear_eew_box(detection_location_1, detection_location_2);
	} else {
		pga_up_level = {};
		pga_up_timestamp = {};
		alert_state = false;
		TREM.rts_audio.intensity = -1;
		TREM.rts_audio.pga = 0;
		if (!Object.keys(TREM.EQ_list).length) document.getElementById("eew_title_text").innerHTML = get_lang_string("eew.null");
		max_intensity_text.innerHTML = "";
		max_intensity_text.className = "";
		if (!Object.keys(TREM.EQ_list).length) {
			document.getElementById("eew_box").style.backgroundColor = "#333439";
			clear_eew_box(detection_location_1, detection_location_2);
		}
	}
	if (max_intensity > 0 && data.Alert) {
		max_intensity_text.innerHTML = int_to_intensity(max_intensity);
		max_intensity_text.className = `intensity_center intensity_${max_intensity}`;
	}
	max_pga_text.innerHTML = `${max_pga} gal`;
	max_pga_text.className = `intensity_center intensity_${(!data.Alert || max_pga < 4) ? 0 : (max_pga < 5) ? 1 : pga_to_intensity(max_pga)}`;
	const intensity_list = document.getElementById("intensity_list");
	if (data.I && data.I.length) {
		intensity_list.innerHTML = "";
		intensity_list.style.visibility = "visible";
		for (let i = 0; i < data.I.length; i++) {
			if (i > 7) break;
			const intensity_list_item = document.createElement("intensity_list_item");
			intensity_list_item.className = "intensity_list_item";
			let loc = "";
			for (let index = 0; index < Object.keys(station).length; index++) {
				const uuid = Object.keys(station)[index];
				if (data.I[i].uuid.includes(uuid)) {
					loc = station[uuid].Loc;
					break;
				}
			}
			intensity_list_item.innerHTML = `<div class="intensity_${data.I[i].intensity} intensity_center" style="font-size: 14px;border-radius: 3px;width: 20%;">${int_to_intensity(data.I[i].intensity)}</div><div style="font-size: 14px;display: grid;align-items: center;padding-left: 2px;width: 80%;">${loc}</div>`;
			intensity_list.appendChild(intensity_list_item);
		}
	} else intensity_list.style.visibility = "hidden";
	if (Object.keys(TREM.EQ_list).length || data.Alert) show_icon(true, max_intensity);
	else if (!TREM.report_time) show_icon(false);
}

function clear_eew_box(detection_location_1, detection_location_2) {
	detection_location_1.innerHTML = "";
	detection_location_2.innerHTML = "";
	detection_location_1.className = "";
	detection_location_2.className = "";
}

function rts_screenshot() {
	screenshot_id = `rts_${Date.now()}`;
}