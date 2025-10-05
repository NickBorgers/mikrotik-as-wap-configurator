# MikroTik Network Configuration as Code
# Multi-stage build for minimal final image

FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci --only=production

# Final stage
FROM node:22-alpine

WORKDIR /app

# Copy application files
COPY --from=builder /app/node_modules ./node_modules
COPY apply-config.js ./
COPY mikrotik-no-vlan-filtering.js ./
COPY config.example.yaml ./

# Create volume mount point for config
VOLUME ["/config"]

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["help"]
