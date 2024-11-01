const { ipcRenderer } = require("electron");

document.onkeydown = (e) => {
  if (e.key == "F11") ipcRenderer.send("toggleFullscreen");
  else if (e.key == "F12") ipcRenderer.send("openDevtool");
  else if (e.key == "Escape") ipcRenderer.send("hide");
  else if (e.ctrlKey && e.key.toLocaleLowerCase() == "r") ipcRenderer.send("reload");
  else if (e.key == "Tab") e.preventDefault();
};

document.querySelector(".fab").addEventListener("click", function() {
  this.classList.toggle("open");
  document.querySelectorAll(".option").forEach(option => {
    option.classList.toggle("open");
  });
  document.querySelectorAll(".close").forEach(close => {
    close.classList.toggle("open");
  });
});