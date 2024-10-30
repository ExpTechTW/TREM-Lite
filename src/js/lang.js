function loadCSS(href) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.type = "text/css";
  link.href = href;
  document.head.appendChild(link);
}

loadCSS("../css/lang/zh-Hant/index.css");