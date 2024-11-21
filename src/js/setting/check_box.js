class CheckBox {
  constructor() {
    this.checkBoxes = document.querySelectorAll('.switch input');
    this.getSelected();
  }

  getSelected() {
    this.checkBoxes.forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        const selected = Array.from(this.checkBoxes)
          .filter((box) => box.checked)
          .map((box) => box.id);
        console.log('Selected:', selected);
      });
    });
  }
}

new CheckBox();
