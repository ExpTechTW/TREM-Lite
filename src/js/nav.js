document.querySelector(".fab").addEventListener("click", function() {
  this.classList.toggle("open");
  document.querySelectorAll(".option").forEach(option => {
    option.classList.toggle("open");
  });
  document.querySelectorAll(".close").forEach(close => {
    close.classList.toggle("open");
  });
});
