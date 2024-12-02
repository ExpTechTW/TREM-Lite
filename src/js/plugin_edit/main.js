const { ipcRenderer } = require('electron');
const jsyaml = require('js-yaml');

class PluginEditor {
  constructor() {
    this.editor = document.getElementById('editor');
    this.visualEditor = document.getElementById('visualEditor');
    this.yamlMode = document.getElementById('yamlMode');
    this.visualMode = document.getElementById('visualMode');
    this.jsonMode = document.getElementById('jsonMode');
    this.editorContainer = document.getElementById('editorContainer');
    this.yamlSection = document.getElementById('yamlSection');
    this.visualSection = document.getElementById('visualSection');
    this.jsonSection = document.getElementById('jsonSection');
    this.jsonEditor = document.getElementById('jsonEditor');
    this.status = document.getElementById('status');
    this.currentPath = '';
    this.saveTimeout = null;
    this.yamlObject = {};
    this.originalComments = {};
    this.init();
    this.updateLayout();
    this.renderVisualEditor();
  }

  init() {
    [this.visualMode, this.jsonMode].forEach((mode) => {
      mode.addEventListener('change', () => {
        const enabledModes = [this.visualMode, this.jsonMode]
          .filter((m) => m.checked).length;
        if (enabledModes === 0) {
          mode.checked = true;
          return;
        }
        this.updateLayout();
      });
    });

    this.editor.addEventListener('input', () => {
      try {
        const content = this.editor.value;
        this.originalComments = this.extractComments(content);
        this.yamlObject = jsyaml.load(content);
        this.jsonEditor.value = JSON.stringify(this.yamlObject, null, 2);
        this.renderVisualEditor();
      }
      catch (e) {
        this.showStatus(`YAML 解析錯誤: ${e.message}`, true);
      }
    });

    this.jsonEditor.addEventListener('input', () => {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
      }
      this.saveTimeout = setTimeout(this.updateFromJson, 500);
    });

    ipcRenderer.on('load-path', async (event, path) => {
      this.currentPath = path;
      try {
        const content = await ipcRenderer.invoke('read-yaml', path);
        this.originalComments = this.extractComments(content);
        this.editor.value = content;
        this.yamlObject = jsyaml.load(content);
        this.jsonEditor.value = JSON.stringify(this.yamlObject, null, 2);
        this.renderVisualEditor();
      }
      catch (error) {
        this.showStatus(`讀取錯誤: ${error.message}`, true);
      }
    });

    window.addEventListener('beforeunload', async () => {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        await this.saveContent();
      }
    });
  }

  showStatus(message, isError = false) {
    this.status.textContent = message;
    this.status.className = `status ${isError ? 'error' : 'success'}`;
    setTimeout(() => {
      this.status.textContent = '';
      this.status.className = 'status';
    }, 3000);
  }

  getTypeString(value) {
    if (value === null) {
      return 'null';
    }
    if (Array.isArray(value)) {
      return 'array';
    }
    return typeof value;
  }

  extractComments(yamlText) {
    const lines = yamlText.split('\n');
    const comments = {};
    lines.forEach((line) => {
      const [content, ...commentParts] = line.split('#');
      if (commentParts.length > 0) {
        const key = content.split(':')[0].trim();
        if (key) {
          comments[key] = '#' + commentParts.join('#');
        }
      }
    });
    return comments;
  }

  createField(key, value, parent, path = '') {
    const field = document.createElement('div');
    field.className = 'field';
    const header = document.createElement('div');
    header.className = 'field-header';
    const label = document.createElement('div');
    label.className = 'field-label';
    label.textContent = key;
    const typeSpan = document.createElement('span');
    typeSpan.className = 'type-indicator';
    typeSpan.textContent = `(${this.getTypeString(value)})`;
    label.appendChild(typeSpan);
    header.appendChild(label);
    if (parent && key !== 'ver') {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'btn btn-remove';
      deleteBtn.textContent = '刪除';
      deleteBtn.onclick = () => {
        if (Array.isArray(parent)) {
          parent.splice(key, 1);
        }
        else {
          delete parent[key];
        }
        this.updateFromVisual();
      };
      header.appendChild(deleteBtn);
    }
    field.appendChild(header);
    const valueContainer = document.createElement('div');
    valueContainer.className = 'field-value';
    if (key === 'ver') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input';
      input.value = value;
      input.disabled = true;
      valueContainer.appendChild(input);
    }
    else if (value === null) {
      const nullSpan = document.createElement('span');
      nullSpan.textContent = 'null';
      valueContainer.appendChild(nullSpan);
    }
    else if (typeof value === 'boolean') {
      const toggle = document.createElement('label');
      toggle.className = 'toggle';
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = value;
      input.onchange = () => {
        if (Array.isArray(parent)) {
          parent[key] = input.checked;
        }
        else {
          parent[key] = input.checked;
        }
        this.updateFromVisual();
      };
      const slider = document.createElement('span');
      slider.className = 'slider';
      toggle.appendChild(input);
      toggle.appendChild(slider);
      valueContainer.appendChild(toggle);
    }
    else if (typeof value === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'input';
      input.value = value;
      input.step = 'any';
      input.onchange = () => {
        const newValue = input.value === '' ? null : Number(input.value);
        if (Array.isArray(parent)) {
          parent[key] = newValue;
        }
        else {
          parent[key] = newValue;
        }
        this.updateFromVisual();
      };
      valueContainer.appendChild(input);
    }
    else if (typeof value === 'string') {
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'input';
      input.value = value;

      input.oninput = () => {
        if (Array.isArray(parent)) {
          parent[key] = input.value;
        }
        else {
          parent[key] = input.value;
        }
        this.updateFromVisual();
      };
      valueContainer.appendChild(input);
    }
    else if (Array.isArray(value)) {
      const arrayContainer = document.createElement('div');
      value.forEach((item, index) => {
        const itemDiv = document.createElement('div');
        itemDiv.className = 'array-item';
        itemDiv.appendChild(this.createField(index, item, value, `${path}[${index}]`));
        arrayContainer.appendChild(itemDiv);
      });
      const addButton = document.createElement('button');
      addButton.className = 'btn btn-add';
      addButton.onclick = () => {
        if (value.length > 0) {
          const lastItem = value[value.length - 1];
          const newItem = typeof lastItem === 'object' ? null : '';
          value.push(newItem);
        }
        else {
          value.push('');
        }
        this.updateFromVisual();
      };
      arrayContainer.appendChild(addButton);
      valueContainer.appendChild(arrayContainer);
    }
    else if (typeof value === 'object' && value !== null) {
      const objectContainer = document.createElement('div');
      objectContainer.className = 'nested';
      Object.entries(value).forEach(([k, v]) => {
        objectContainer.appendChild(this.createField(k, v, value, `${path}.${k}`));
      });
      const addButton = document.createElement('button');
      addButton.className = 'btn btn-add';
      addButton.textContent = '添加欄位';
      addButton.onclick = () => {
        const newKey = prompt('輸入新欄位名稱：');
        if (newKey && !Object.prototype.hasOwnProperty.call(value, newKey)) {
          value[newKey] = '';
          this.updateFromVisual();
        }
      };
      objectContainer.appendChild(addButton);
      valueContainer.appendChild(objectContainer);
    }
    field.appendChild(valueContainer);
    return field;
  }

  renderVisualEditor() {
    this.visualEditor.innerHTML = '';
    if (!this.yamlObject) {
      return;
    }
    Object.entries(this.yamlObject).forEach(([key, value]) => {
      const field = this.createField(key, value, this.yamlObject, key);
      this.visualEditor.appendChild(field);
    });
    const addButton = document.createElement('button');
    addButton.className = 'btn btn-add root';
    addButton.onclick = () => {
      const newKey = prompt('輸入新欄位名稱：');
      if (newKey && !Object.prototype.hasOwnProperty.call(this.yamlObject, newKey)) {
        this.yamlObject[newKey] = '';
        this.updateFromVisual();
      }
    };
    this.visualEditor.appendChild(addButton);
  }

  updateLayout() {
    const enabledCount = [this.yamlMode, this.visualMode, this.jsonMode]
      .filter((mode) => mode.checked).length;
    this.editorContainer.style.gridTemplateColumns = `repeat(${enabledCount}, 1fr)`;
    this.yamlSection.classList.toggle('hidden', !this.yamlMode.checked);
    this.visualSection.classList.toggle('hidden', !this.visualMode.checked);
    this.jsonSection.classList.toggle('hidden', !this.jsonMode.checked);
  }

  updateFromVisual() {
    try {
      const newYaml = jsyaml.dump(this.yamlObject, {
        indent: 2,
        lineWidth: -1,
        noRefs: true,
        sortKeys: false,
      });
      const newLines = newYaml.split('\n');
      const finalLines = newLines.map((line) => {
        const key = line.split(':')[0].trim();
        const comment = this.originalComments[key];
        return comment ? `${line} ${comment}` : line;
      });
      this.editor.value = finalLines.join('\n');
      this.jsonEditor.value = JSON.stringify(this.yamlObject, null, 2);
      this.autoSave();
    }
    catch (e) {
      this.showStatus(`YAML 轉換錯誤: ${e.message}`, true);
    }
  }

  updateFromJson() {
    try {
      const jsonData = JSON.parse(this.jsonEditor.value);
      this.yamlObject = jsonData;
      this.updateFromVisual();
    }
    catch (e) {
      this.showStatus('JSON 格式錯誤', true);
      console.log(e);
    }
  }

  async saveContent() {
    if (!this.currentPath || !this.editor.value.trim()) {
      return;
    }

    try {
      await ipcRenderer.invoke('write-yaml', this.currentPath, this.editor.value);
      this.showStatus('已自動儲存');
    }
    catch (error) {
      this.showStatus(`儲存錯誤: ${error.message}`, true);
    }
  }

  autoSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(this.saveContent, 1000);
  }
}
new PluginEditor();
