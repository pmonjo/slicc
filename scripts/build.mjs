import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const steps = [
  'npm run build -w @slicc/shared-ts',
  'npm run build -w @slicc/cloud-core',
  'npm run build -w @slicc/webapp',
  'npm run build -w @ai-ecoverse/cherry',
  'npm run build -w @slicc/node-server',
  'npm run build -w @slicc/chrome-extension',
  'npm run build -w @slicc/cloudflare-worker',
];

if (platform() === 'darwin') {
  steps.push('npm run build -w @slicc/swift-server', 'npm run build -w @slicc/swift-launcher');
}

for (const cmd of steps) {
  execSync(cmd, { stdio: 'inherit' });
}
