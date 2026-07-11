const ElectronPackageAnalyzer = require('./analyzer');

async function analyze() {
  const analyzer = new ElectronPackageAnalyzer('./dist');
  await analyzer.analyze();
  analyzer.generateReport();
}

analyze();

// === Electron Package Size Analysis ===

// Total Size: 1022.16 MB

// Size by Category:
// executables: 700.42 MB (68.52%)
// asar: 148.41 MB (14.52%)
// locales: 80.50 MB (7.88%)
// dlls: 41.48 MB (4.06%)
// others: 33.99 MB (3.32%)
// html: 17.36 MB (1.70%)

// Largest Files:
// TREM-Lite-3.1.0-rc.4-win.exe: 183.68 MB
// win-unpacked\TREM-Lite.exe: 180.15 MB
// win-ia32-unpacked\TREM-Lite.exe: 152.18 MB
// TREM-Lite-3.1.0-rc.4-win-x64.exe: 94.85 MB
// TREM-Lite-3.1.0-rc.4-win-ia32.exe: 89.36 MB
// win-ia32-unpacked\resources\app.asar: 74.20 MB
// win-unpacked\resources\app.asar: 74.20 MB
// win-ia32-unpacked\icudtl.dat: 9.98 MB
// win-unpacked\icudtl.dat: 9.98 MB
// win-ia32-unpacked\LICENSES.chromium.html: 8.68 MB
