# Central de Decisões LORLER — imagem para servidor com disco persistente em /data
FROM node:22-slim
WORKDIR /app
COPY . .
RUN rm -rf data backups .env
ENV LORLER_ENV=production HOST=0.0.0.0 PORT=3700 LORLER_DB_FILE=/data/lorler.db LORLER_COOKIE_SECURE=true LORLER_TRUST_PROXY=true
VOLUME ["/data"]
EXPOSE 3700
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
