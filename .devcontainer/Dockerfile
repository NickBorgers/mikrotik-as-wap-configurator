# Use the official Node.js LTS image as base
FROM mcr.microsoft.com/devcontainers/javascript-node:1-18-bullseye

# Set the working directory
WORKDIR /workspace

# Install global npm packages (only what's needed for Claude CLI)
RUN npm install -g @anthropic-ai/claude-code

# Set up git configuration
RUN git config --global init.defaultBranch main

# Switch to the non-root user
USER node
