document.querySelectorAll(".button").forEach((button) =>
  button.addEventListener("click", () => {
    document.querySelector(".setting-options-page.active")?.classList.remove("active");
    document.querySelector(".button.on")?.classList.remove("on");
    document.querySelector(`.${button.getAttribute("for")}`).classList.add("active");
    button.classList.add("on");
  }),
);