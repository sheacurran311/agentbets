const JSZip = require('jszip');
const fs = require('fs');
const path = require('path');

const zip = new JSZip();
const baseDir = '/home/node/hackathon/solana/agentbets';
const outputPath = '/home/node/a0/workspace/8b2a6046-1a5f-4b5f-bb33-c94d0bac0c0c/workspace/outputs/agentbets-complete.zip';

// Directories and files to exclude
const excludePatterns = [
  'node_modules',
  '.git',
  '*.log',
  'create-zip.js',
  '.env',
  '.DS_Store'
];

function shouldExclude(filePath) {
  const basename = path.basename(filePath);
  return excludePatterns.some(pattern => {
    if (pattern.includes('*')) {
      const ext = pattern.replace('*', '');
      return basename.endsWith(ext);
    }
    return basename === pattern || filePath.includes(`/${pattern}/`);
  });
}

function addFilesToZip(dirPath, zipFolder) {
  const items = fs.readdirSync(dirPath);

  for (const item of items) {
    const fullPath = path.join(dirPath, item);
    const relativePath = path.relative(baseDir, fullPath);

    if (shouldExclude(fullPath)) {
      continue;
    }

    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      addFilesToZip(fullPath, zipFolder);
    } else {
      const content = fs.readFileSync(fullPath);
      zipFolder.file(relativePath, content);
    }
  }
}

async function createZip() {
  console.log('Creating zip file...');
  addFilesToZip(baseDir, zip);

  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(outputPath, content);
  console.log(`Zip created at: ${outputPath}`);

  const stats = fs.statSync(outputPath);
  console.log(`Size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
}

createZip().catch(console.error);
