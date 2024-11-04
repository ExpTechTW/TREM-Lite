const { ipcRenderer } = require("electron");

document.onkeydown = (e) => {
  if (e.key == "F11") ipcRenderer.send("toggleFullscreen");
  else if (e.key == "F12") ipcRenderer.send("openDevtool");
  else if (e.key == "Escape") ipcRenderer.send("hide");
  else if (e.ctrlKey && e.key.toLocaleLowerCase() == "r") ipcRenderer.send("reload");
  else if (e.key == "Tab") e.preventDefault();
};

document.querySelectorAll(".button").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelector(".setting-options-page.active")?.classList.remove("active");
    document.querySelector(".button.on")?.classList.remove("on");
    document.querySelector(`.${button.getAttribute("for")}`).classList.add("active");
    button.classList.add("on");
  }),
);

document.querySelector(".windows-wrapper").addEventListener("click", (event) => {
  const targetClass = event.target.classList;
  if (targetClass.contains("close"))
    window.close();
  else if (targetClass.contains("minimize"))
    ipcRenderer.send("minimize-window");
});