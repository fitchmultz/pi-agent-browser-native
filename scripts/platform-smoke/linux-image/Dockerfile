# Local Crabbox Ubuntu/Linux target image for pi-agent-browser-native platform smoke.
# Build with:
#   docker build -t pi-agent-browser-native-platform:node24-agent-browser0.27.1 \
#     --build-arg AGENT_BROWSER_VERSION=0.27.1 \
#     -f scripts/platform-smoke/linux-image/Dockerfile .

FROM node:24-bookworm

ARG AGENT_BROWSER_VERSION=0.27.1

USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation git openssh-client tar \
	&& npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
	&& groupadd -g 1002 circleci \
	&& useradd -m -u 1001 -g 1002 -s /bin/bash circleci \
	&& mkdir -p /work/crabbox /home/circleci/.cache \
	&& chown -R circleci:circleci /work /home/circleci \
	&& rm -rf /var/lib/apt/lists/*

USER circleci
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_PLATFORM_SMOKE_IMAGE=1
