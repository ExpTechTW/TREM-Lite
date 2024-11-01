const region = require("../../../resource/data/region.json");

const intensity_list = ["0", "1", "2", "3", "4", "5⁻", "5⁺", "6⁻", "6⁺", "7"];

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

function search_loc_name(int) {
  for (const city of Object.keys(region))
    for (const town of Object.keys(region[city]))
      if (region[city][town].code == int)
        return { city, town };
  return null;
}

function search_loc_code(str) {
  for (const city of Object.keys(region))
    for (const town of Object.keys(region[city]))
      if (`${city}${town}` == str)
        return region[city][town].code;
  return null;
}

function formatTimestamp(Timestamp) {
  const date = new Date(Timestamp);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${hours}:${minutes}`;
}

function intensity_float_to_int(float) {
  return float < 0 ? 0 : float < 4.5 ? Math.round(float) : float < 5 ? 5 : float < 5.5 ? 6 : float < 6 ? 7 : float < 6.5 ? 8 : 9;
}

module.exports = {
  formatTime,
  distance,
  formatTimestamp,
  search_loc_name,
  search_loc_code,
  intensity_float_to_int,
  intensity_list,
};