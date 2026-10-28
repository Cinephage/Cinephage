FROM node:26-trixie-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
		git \
		openssh-client \
		ffmpeg \
		libgtk-3-0 \
		libx11-xcb1 \
		libasound2 \
		xvfb \
		curl \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL https://github.com/kaegi/alass/releases/download/v2.0.0/alass-linux64 \
	-o /usr/local/bin/alass-cli \
	&& chmod +x /usr/local/bin/alass-cli

ENV ALASS_PATH=/usr/local/bin/alass-cli

COPY ./workspace-scripts/devcontainer-entrypoint.sh /usr/local/bin/devcontainer-entrypoint.sh
RUN chmod +x /usr/local/bin/devcontainer-entrypoint.sh
