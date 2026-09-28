# QA Crawler - container image for deployment.
# Uses the official Playwright image so Chromium + all OS deps are preinstalled.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the application source.
COPY . .

# The UI server listens on this port (override with -e PORT=xxxx).
ENV PORT=5177
EXPOSE 5177

# Start the web UI server.
CMD ["node", "src/server.js"]
