# QA Crawler - container image for deployment.
# Uses the official Playwright image so Chromium + all OS deps are preinstalled.
FROM mcr.microsoft.com/playwright:v1.47.0-jammy

WORKDIR /app

# Install dependencies first (better layer caching).
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# Copy the application source.
COPY . .

# The server reads the PORT environment variable at runtime. On Render (and most
# cloud hosts) PORT is injected automatically, so we must NOT hardcode it here.
# For local Docker runs it falls back to 5177 (see src/server.js).
EXPOSE 5177

# Start the web UI server.
CMD ["node", "src/server.js"]
