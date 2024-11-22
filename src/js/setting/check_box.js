class CheckBox {
  constructor() {
    this.checkBoxes = document.querySelectorAll('.switch input');
    this.config = require('./config');
    this.getSelected();
  }

  getSelected() {
    this.checkBoxes.forEach((checkbox) => {
      checkbox.addEventListener('change', (event) => {
        const { checked, id } = event.target;
        this.config.write({ STRING: { [id]: checked } });
      });
    });
  }
}

new CheckBox();
