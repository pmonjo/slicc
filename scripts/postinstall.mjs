import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'

if (existsSync('packages/shared-ts')) {
  execSync('npm run build -w @slicc/shared-ts', { stdio: 'inherit' })
}
if (existsSync('packages/cloud-core')) {
  execSync('npm run build -w @slicc/cloud-core', { stdio: 'inherit' })
}
