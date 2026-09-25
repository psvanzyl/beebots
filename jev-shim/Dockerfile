# Jev shim: serves the TypeSafe `POST /v1/systemone` contract on top of a
# self-hosted llama.cpp decision endpoint, so beebots never calls a US-hosted
# model API. No dependencies — plain node + http/fetch.
FROM node:22-alpine

WORKDIR /app
COPY --chown=node:node server.cjs ./

ENV NODE_ENV=production
ENV JEV_SHIM_BIND=0.0.0.0
ENV JEV_SHIM_PORT=8787
USER node
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.cjs"]
