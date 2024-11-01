const close_button = document.querySelector("#close_btn");
const reportWrapper = document.querySelector(".report-wrapper");

close_button.addEventListener("click", () => {
  close_button.classList.toggle("off");
  reportWrapper.classList.toggle("hidden");
});