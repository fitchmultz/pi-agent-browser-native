# Local Crabbox Ubuntu/Linux target image for pi-agent-browser-native platform smoke.
# Build with npm run smoke:platform:ubuntu-image so the agent-browser version
# comes from scripts/agent-browser-capability-baseline.mjs.

FROM node:24-bookworm

ARG AGENT_BROWSER_VERSION

USER root
RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates chromium fonts-liberation git libvulkan1 mesa-vulkan-drivers openssh-client tar xvfb \
	&& npm install -g "agent-browser@${AGENT_BROWSER_VERSION}" \
	&& groupadd -g 1002 circleci \
	&& useradd -m -u 1001 -g 1002 -s /bin/bash circleci \
	&& mkdir -p /work/crabbox /home/circleci/.cache \
	&& chown -R circleci:circleci /work /home/circleci \
	&& rm -rf /var/lib/apt/lists/*

USER circleci
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV AGENT_BROWSER_PLATFORM_SMOKE_IMAGE=1
