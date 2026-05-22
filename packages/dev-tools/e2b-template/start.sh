#!/bin/sh
set -e

# Redirect node-server stderr to a known path so the CLI can surface it on
# create-failure timeouts.
exec /opt/slicc/node-server/index.js --hosted --port 5710 --no-open 2>/tmp/slicc-stderr.log
