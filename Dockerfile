FROM node:24-slim

RUN apt-get update && apt-get install -y curl git ca-certificates && rm -rf /var/lib/apt/lists/*
RUN curl -L https://foundry.paradigm.xyz | bash && /root/.foundry/bin/foundryup
ENV PATH="/root/.foundry/bin:${PATH}"

WORKDIR /app
COPY . .

RUN cd contracts && forge build
RUN cd app && npm ci --omit=dev

EXPOSE 8788
ENV PORT=8788
CMD ["node", "app/src/server.js"]
