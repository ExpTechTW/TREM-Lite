const { ipcRenderer } = require('electron');
const jsyaml = require('js-yaml');

const editor = document.getElementById('editor');
const visualEditor = document.getElementById('visualEditor');
const yamlMode = document.getElementById('yamlMode');
const visualMode = document.getElementById('visualMode');
const jsonMode = document.getElementById('jsonMode');
const editorContainer = document.getElementById('editorContainer');
const yamlSection = document.getElementById('yamlSection');
const visualSection = document.getElementById('visualSection');
const jsonSection = document.getElementById('jsonSection');
const jsonEditor = document.getElementById('jsonEditor');
const status = document.getElementById('status');

let currentPath = '';
let saveTimeout = null;
let yamlObject = null;
let originalComments = {};

function showStatus(message, isError = false) {
  status.textContent = message;
  status.className = `status ${isError ? 'error' : 'success'}`;
  setTimeout(() => {
    status.textContent = '';
    status.className = 'status';
  }, 3000);
}

function getTypeString(value) {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  return typeof value;
}

function extractComments(yamlText) {
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

function createField(key, value, parent, path = '') {
  const field = document.createElement('div');
  field.className = 'field';

  const header = document.createElement('div');
  header.className = 'field-header';

  const label = document.createElement('div');
  label.className = 'field-label';
  label.textContent = key;
  const typeSpan = document.createElement('span');
  typeSpan.className = 'type-indicator';
  typeSpan.textContent = `(${getTypeString(value)})`;
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
      updateFromVisual();
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
      updateFromVisual();
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
      updateFromVisual();
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
      updateFromVisual();
    };
    valueContainer.appendChild(input);
  }
  else if (Array.isArray(value)) {
    const arrayContainer = document.createElement('div');

    value.forEach((item, index) => {
      const itemDiv = document.createElement('div');
      itemDiv.className = 'array-item';
      itemDiv.appendChild(createField(index, item, value, `${path}[${index}]`));
      arrayContainer.appendChild(itemDiv);
    });

    const addButton = document.createElement('button');
    addButton.className = 'btn btn-add';
    addButton.textContent = '添加項目';
    addButton.onclick = () => {
      if (value.length > 0) {
        const lastItem = value[value.length - 1];
        const newItem = typeof lastItem === 'object' ? null : '';
        value.push(newItem);
      }
      else {
        value.push('');
      }
      updateFromVisual();
    };

    arrayContainer.appendChild(addButton);
    valueContainer.appendChild(arrayContainer);
  }
  else if (typeof value === 'object' && value !== null) {
    const objectContainer = document.createElement('div');
    objectContainer.className = 'nested';

    Object.entries(value).forEach(([k, v]) => {
      objectContainer.appendChild(createField(k, v, value, `${path}.${k}`));
    });

    const addButton = document.createElement('button');
    addButton.className = 'btn btn-add';
    addButton.textContent = '添加欄位';
    addButton.onclick = () => {
      const newKey = prompt('輸入新欄位名稱：');
      if (newKey && !Object.prototype.hasOwnProperty.call(value, newKey)) {
        value[newKey] = '';
        updateFromVisual();
      }
    };

    objectContainer.appendChild(addButton);
    valueContainer.appendChild(objectContainer);
  }

  field.appendChild(valueContainer);
  return field;
}

function renderVisualEditor() {
  visualEditor.innerHTML = '';
  if (!yamlObject) {
    return;
  }

  Object.entries(yamlObject).forEach(([key, value]) => {
    const field = createField(key, value, yamlObject, key);
    visualEditor.appendChild(field);
  });

  const addButton = document.createElement('button');
  addButton.className = 'btn btn-add';
  addButton.textContent = '添加根級欄位';
  addButton.onclick = () => {
    const newKey = prompt('輸入新欄位名稱：');
    if (newKey && !Object.prototype.hasOwnProperty.call(yamlObject, newKey)) {
      yamlObject[newKey] = '';
      updateFromVisual();
    }
  };
  visualEditor.appendChild(addButton);
}

function updateLayout() {
  const enabledCount = [yamlMode, visualMode, jsonMode]
    .filter((mode) => mode.checked).length;

  editorContainer.style.gridTemplateColumns = `repeat(${enabledCount}, 1fr)`;

  yamlSection.classList.toggle('hidden', !yamlMode.checked);
  visualSection.classList.toggle('hidden', !visualMode.checked);
  jsonSection.classList.toggle('hidden', !jsonMode.checked);
}

[visualMode, jsonMode].forEach((mode) => {
  mode.addEventListener('change', () => {
    const enabledModes = [visualMode, jsonMode]
      .filter((m) => m.checked).length;

    if (enabledModes === 0) {
      mode.checked = true;
      return;
    }

    updateLayout();
  });
});

function updateFromVisual() {
  try {
    const newYaml = jsyaml.dump(yamlObject, {
      indent: 2,
      lineWidth: -1,
      noRefs: true,
      sortKeys: false,
    });

    const newLines = newYaml.split('\n');
    const finalLines = newLines.map((line) => {
      const key = line.split(':')[0].trim();
      const comment = originalComments[key];
      return comment ? `${line} ${comment}` : line;
    });

    editor.value = finalLines.join('\n');
    jsonEditor.value = JSON.stringify(yamlObject, null, 2);
    autoSave();
  }
  catch (e) {
    showStatus(`YAML 轉換錯誤: ${e.message}`, true);
  }
}

function updateFromJson() {
  try {
    const jsonData = JSON.parse(jsonEditor.value);
    yamlObject = jsonData;

    updateFromVisual();
  }
  catch (e) {
    showStatus('JSON 格式錯誤', true);
    console.log(e);
  }
}

editor.addEventListener('input', () => {
  try {
    const content = editor.value;
    originalComments = extractComments(content);
    yamlObject = jsyaml.load(content);
    jsonEditor.value = JSON.stringify(yamlObject, null, 2);
    renderVisualEditor();
  }
  catch (e) {
    showStatus(`YAML 解析錯誤: ${e.message}`, true);
  }
});

jsonEditor.addEventListener('input', () => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(updateFromJson, 500);
});

async function saveContent() {
  if (!currentPath || !editor.value.trim()) {
    return;
  }

  try {
    await ipcRenderer.invoke('write-yaml', currentPath, editor.value);
    showStatus('已自動儲存');
  }
  catch (error) {
    showStatus(`儲存錯誤: ${error.message}`, true);
  }
}

function autoSave() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(saveContent, 1000);
}

ipcRenderer.on('load-path', async (event, path) => {
  currentPath = path;
  try {
    const content = await ipcRenderer.invoke('read-yaml', path);
    originalComments = extractComments(content);
    editor.value = content;
    yamlObject = jsyaml.load(content);
    jsonEditor.value = JSON.stringify(yamlObject, null, 2);
    renderVisualEditor();
  }
  catch (error) {
    showStatus(`讀取錯誤: ${error.message}`, true);
  }
});

window.addEventListener('beforeunload', async () => {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
    await saveContent();
  }
});

// 初始化
updateLayout();
yamlObject = {};
renderVisualEditor();
