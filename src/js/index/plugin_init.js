const fs = require('fs-extra');
const path = require('path');
const { app } = require('@electron/remote');

async function copyMissingTremFiles() {
  try {
    const defaultPluginsPath = path.join(__dirname, '../../resource/plugins');
    const userPluginsPath = path.join(app.getPath('userData'), 'plugins');

    await fs.ensureDir(userPluginsPath);

    const defaultTremFiles = (await fs.readdir(defaultPluginsPath))
      .filter((file) => file.endsWith('.trem'));
    const userTremFiles = (await fs.readdir(userPluginsPath))
      .filter((file) => file.endsWith('.trem'));

    const missingFiles = defaultTremFiles.filter((file) => !userTremFiles.includes(file));

    for (const file of missingFiles) {
      const srcFile = path.join(defaultPluginsPath, file);
      const destFile = path.join(userPluginsPath, file);
      await fs.copy(srcFile, destFile);
      console.log(`Copied ${file} to user plugins directory`);
    }

    return missingFiles;
  }
  catch (error) {
    console.error('Error copying trem files:', error);
    throw error;
  }
}

module.exports = copyMissingTremFiles;
