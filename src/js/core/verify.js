const fs = require('fs-extra');
const path = require('path');
const crypto = require('crypto');

class PluginVerifier {
  constructor(officialKey) {
    this.officialKey = officialKey;
    this.publicKeys = new Map();
  }

  loadKeysFromDirectory(keysDir) {
    try {
      if (!fs.existsSync(keysDir)) {
        fs.mkdirSync(keysDir, { recursive: true });
        return;
      }

      const files = fs.readdirSync(keysDir);
      files.forEach((file) => {
        if (file.endsWith('.pem')) {
          try {
            const keyPath = path.join(keysDir, file);
            const keyContent = fs.readFileSync(keyPath, 'utf8');
            const keyId = path.basename(file, '.pem');
            this.publicKeys.set(keyId, keyContent);
          }
          catch (error) {
            console.error(`Failed to load key ${file}:`, error);
          }
        }
      });
    }
    catch (error) {
      console.error('Failed to load public keys:', error);
    }
  }

  normalizeContent(content) {
    return content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  }

  getAllFiles(dir, baseDir = dir) {
    let results = {};
    const list = fs.readdirSync(dir);

    for (const file of list) {
      if (file.startsWith('.') || file === 'signature.json') {
        continue;
      }

      const filePath = path.join(dir, file);
      const stat = fs.statSync(filePath);

      if (stat.isDirectory()) {
        Object.assign(results, this.getAllFiles(filePath, baseDir));
      }
      else {
        const relativePath = path.relative(baseDir, filePath).replace(/\\/g, '/');
        const content = this.normalizeContent(fs.readFileSync(filePath, 'utf8'));
        results[relativePath] = content;
      }
    }

    return results;
  }

  verify(pluginPath) {
    try {
      const signaturePath = path.join(pluginPath, 'signature.json');
      if (!fs.existsSync(signaturePath)) {
        return { valid: false, error: 'Missing signature.json' };
      }

      const signatureData = JSON.parse(fs.readFileSync(signaturePath));
      const { fileHashes, signature, keyId } = signatureData;

      if (!fileHashes || !signature) {
        return { valid: false, error: 'Invalid signature data format' };
      }

      const all_file_content = this.getAllFiles(pluginPath);

      for (const [file, content] of Object.entries(all_file_content)) {
        if (file == 'trem.json') {
          continue;
        }

        if (!fileHashes[file]) {
          return { valid: false, error: `Extra file: ${file}` };
        }

        const actualHash = crypto.createHash('sha256').update(content).digest('hex');

        if (actualHash != fileHashes[file]) {
          return { valid: false, error: `Modified file: ${file}` };
        }
      }

      let publicKey;
      if (!keyId || keyId == 'official') {
        publicKey = this.officialKey;
      }
      else {
        publicKey = this.publicKeys.get(keyId);
        if (!publicKey) {
          return { valid: false, error: `Unknown key ID: ${keyId}` };
        }
      }

      const verify = crypto.createVerify('SHA256');
      verify.write(JSON.stringify(fileHashes));
      verify.end();

      const isValid = verify.verify(publicKey, signature, 'base64');

      return {
        valid: isValid,
        error: isValid ? null : 'Invalid signature',
        keyId: keyId || 'official',
      };
    }
    catch (error) {
      return { valid: false, error: error.message };
    }
  }
}

module.exports = PluginVerifier;
