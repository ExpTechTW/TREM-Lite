const { ipcRenderer } = require('electron');
const jsyaml = require('js-yaml');

class YamlEditor {
  constructor() {
    this.editor = document.getElementById('editor');
    this.status = document.getElementById('status');
    this.showStatus = this.showStatus.bind(this);
    this.saveContent = this.saveContent.bind(this);
    this.currentPath = '';
    this.saveTimeout = null;
    this.originalComments = {};
    this.init();
  }

  init() {
    this.editor.addEventListener('input', () => {
      try {
        const content = this.editor.value;
        this.originalComments = this.extractComments(content);
        jsyaml.load(content);
        this.autoSave();
      }
      catch (e) {
        this.showStatus('yaml-extract-error', true, e.message);
      }
    });

    ipcRenderer.on('load-path', async (event, path) => {
      this.currentPath = path;
      try {
        const content = await ipcRenderer.invoke('read-yaml', path);
        this.originalComments = this.extractComments(content);
        this.editor.value = content;
      }
      catch (error) {
        this.showStatus('load-error', true, error.message);
      }
    });

    window.addEventListener('beforeunload', async () => {
      if (this.saveTimeout) {
        clearTimeout(this.saveTimeout);
        await this.saveContent();
      }
    });
  }

  showStatus(message, isError = false, text) {
    this.status.className = `status ${isError ? 'error' : 'success'} ${message ? message : ''}`;
    this.status.textContent = text ? text : '';
    setTimeout(() => {
      this.status.className = 'status';
      this.status.textContent = '';
    }, 3000);
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

  async saveContent() {
    if (!this.currentPath || !this.editor.value.trim()) {
      return;
    }

    try {
      await ipcRenderer.invoke('write-yaml', this.currentPath, this.editor.value);
      this.showStatus('auto-save-success');
    }
    catch (error) {
      this.showStatus('auto-save-error', true, error.message);
    }
  }

  autoSave() {
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }
    this.saveTimeout = setTimeout(() => this.saveContent(), 1000);
  }
}

new YamlEditor();
