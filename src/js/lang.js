const TREM = require("./constant");

function generateColorCSS() {
  let css = ":root {\n";

  Object.entries(TREM.constant.COLOR.RTS).forEach(([key, value]) => {
    const cssKey = key.replace("_", "-");
    css += `  --rts-${cssKey}: ${value};\n`;
  });

  Object.entries(TREM.constant.COLOR.INTENSITY).forEach(([key, value]) => {
    css += `  --intensity-${key}: ${value};\n`;
  });

  Object.entries(TREM.constant.COLOR.INTENSITY_TEXT).forEach(([key, value]) => {
    css += `  --intensity-text-${key}: ${value};\n`;
  });

  css += `  --eew-s-warn: ${TREM.constant.COLOR.EEW.S.WARN};\n`;
  css += `  --eew-s-alert: ${TREM.constant.COLOR.EEW.S.ALERT};\n`;
  css += `  --eew-p: ${TREM.constant.COLOR.EEW.P};\n`;

  css += "}\n";
  return css;
}

function injectColorStyles() {
  const style = document.createElement("style");
  style.textContent = generateColorCSS();
  document.head.appendChild(style);
}

function loadCSS(href) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = href;
  document.head.appendChild(link);
}

injectColorStyles();
loadCSS("../css/lang/zh-Hant/index.css");