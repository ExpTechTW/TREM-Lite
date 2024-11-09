const Station_Wrapper = document.querySelector(".realtime-station");
const Station_Location = Station_Wrapper.querySelector(".location");
const Station_Select_Wrapper = Station_Wrapper.querySelector(".select-wrapper");
const Station_Local_Items = Station_Select_Wrapper.querySelector(".local");
const Station_Select = Station_Select_Wrapper.querySelector(".current-station");
const Station_Items = Station_Select_Wrapper.querySelector(".station");

function CreatEle(text, className, bgText, html, attr) {
  const element = document.createElement("div");
  element.textContent = text;
  if (className) element.classList = className;
  if (bgText) element.dataset.backgroundText = bgText;
  if (html) element.innerHTML = html;
  if (attr)
    Object.entries(attr).forEach(([key, value]) => {
      element.setAttribute(key, value);
    });
  return element;
}


/** 渲染即時測站下拉選項 **/
function RenderStationReg() {
  Station_Local_Items.innerHTML = "";
  const uniqueRegions = Array.from(
    new Set(constant.SETTING.STATION_REGION.map((city) => city.slice(0, -1))),
  ).sort();

  uniqueRegions.forEach((city) => {
    Station_Local_Items.appendChild(CreatEle(city));
  });
}