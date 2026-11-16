# Pitwall dev container: Python 3.13 + Node 22 + Poetry 2.3.4.
# For building and testing. The extension itself runs in Windows Cursor on the host.
FROM node:22-bookworm AS node

FROM python:3.13-bookworm

# Node 22 (and npm/npx) copied from the official image
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

RUN apt-get update \
 && apt-get install -y --no-install-recommends git sudo \
 && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir poetry==2.3.4

# Keep the Linux venv out of the bind-mounted workspace so it can't clobber the host's Windows .venv
ENV POETRY_VIRTUALENVS_IN_PROJECT=false

# Passwordless sudo lets postCreateCommand hand the root-owned node_modules volume to vscode
RUN useradd -m -s /bin/bash vscode \
 && echo 'vscode ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/vscode \
 && chmod 0440 /etc/sudoers.d/vscode
USER vscode
