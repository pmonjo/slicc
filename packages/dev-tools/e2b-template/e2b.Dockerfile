FROM e2bdev/code-interpreter:latest

RUN apt-get update && apt-get install -y \
    chromium fonts-liberation libnss3 libatk-bridge2.0-0 \
    libgtk-3-0 libxss1 libasound2 \
 && rm -rf /var/lib/apt/lists/*
# NOTE: The Chromium apt package name varies by base image. On Debian-derived
# images it is usually `chromium`; on Ubuntu it has historically been
# `chromium-browser`. If `apt-get install chromium` fails at template build
# time, swap to `chromium-browser` (and verify the binary path via
# `apt list --installed | grep -i chrom`, then update start.sh and
# chrome-launch.ts accordingly).

COPY dist/node-server  /opt/slicc/node-server
COPY dist/ui           /opt/slicc/ui
COPY packages/dev-tools/e2b-template/start.sh /usr/local/bin/slicc-start
RUN chmod +x /usr/local/bin/slicc-start

RUN mkdir -p /data/profile /slicc

ENV SLICC_HOSTED=1
ENV SLICC_SECRETS_FILE=/slicc/secrets.env
ENV CHROME_USER_DATA_DIR=/data/profile

EXPOSE 5710
