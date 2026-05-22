#!/bin/bash
set -e

# Runtime env. (E2B v2 `setEnvs` is build-time only, so the template's runtime
# env has to be set here. node-server also has these as defaults when --hosted
# is passed, so these `export`s are belt-and-suspenders.)
export SLICC_HOSTED=1
export SLICC_SECRETS_FILE=/slicc/secrets.env
export CHROME_USER_DATA_DIR=/data/profile

# Tee stderr to /tmp/slicc-stderr.log AND keep it on container stderr so it
# surfaces in e2b build logs (otherwise build-time failures are blind).
# tee in a process-substitution preserves the exec's exit code.
exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open \
  2> >(tee /tmp/slicc-stderr.log >&2)
