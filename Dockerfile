# Hosted deployment target for the Express API (server.js) only - this is
# what a future mobile app talks to over the network, since it can't spawn
# Puppeteer locally the way the Electron app does. The Electron app keeps
# using its own locally-spawned backend (see electron/main.js); this image
# is unrelated to that flow.
FROM node:20-slim

# Chromium + the OS-level libraries it needs (NSS, font rendering, etc.) for
# headless PDF export via Puppeteer. Installing the distro's `chromium`
# package pulls in its full dependency tree automatically via apt, instead
# of hand-listing the ~15 individual .so libs Puppeteer's own Chromium
# download needs - and PUPPETEER_SKIP_DOWNLOAD below stops Puppeteer from
# also fetching its own copy on top of that, keeping the image smaller.
# yt-dlp is installed for the audio-transcription fallback (src/transcript.js)
# used when a video has no captions; it's a soft dependency (only exercised
# if OPENAI_API_KEY is also set), but cheap enough to include for parity
# with local/dev behavior.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    fonts-liberation \
    ca-certificates \
    python3-pip \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp \
    && rm -rf /var/lib/apt/lists/*

ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production

WORKDIR /app

# src/templates/styles.css is compiled from Tailwind and committed to git
# (not gitignored) rather than built on install - see the performance-fix
# work that introduced it. --ignore-scripts skips the postinstall hook
# (`npm run build:css`), which would otherwise fail here: it needs the
# tailwindcss CLI, a devDependency, and --omit=dev never installs it. This
# also means only production dependencies are ever installed, so there's no
# separate prune step needed afterward.
COPY package*.json ./
COPY src ./src
RUN npm ci --omit=dev --ignore-scripts

COPY server.js generate-notes.js ./

EXPOSE 4500
CMD ["node", "server.js"]
