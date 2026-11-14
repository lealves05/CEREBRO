#!/usr/bin/env bash
# LORLER — instala a VOZ LOCAL do Cérebro (JARVIS) na VPS: Whisper (ouvir) + Kokoro (falar).
# O áudio e o texto não saem da VPS. Pode rodar de novo quando quiser (atualiza e confere).
# Uso: sudo bash instalar-voz-local.sh [tiny|base|small|medium]   (padrão: small)
set -euo pipefail
G='\033[1;32m'; Y='\033[1;33m'; R='\033[1;31m'; N='\033[0m'
ok(){ echo -e "${G}✔${N} $*"; }; info(){ echo -e "${Y}›${N} $*"; }; morrer(){ echo -e "${R}✘ $*${N}"; exit 1; }
[ "$(id -u)" -eq 0 ] || morrer "Rode como root (sudo)."
TAM="${1:-small}"; case "$TAM" in tiny|base|small|medium) ;; *) morrer "Tamanho do Whisper inválido: $TAM";; esac
MODELO="Systran/faster-whisper-$TAM"
DIR=/opt/lorler/voz; CENV=/etc/lorler/cerebro.env
AQUI="$(cd "$(dirname "$0")" && pwd)"

# memória: Whisper small + Kokoro pedem ~3 GB livres
MEM=$(awk '/MemAvailable/ {print int($2/1024)}' /proc/meminfo)
info "Memória disponível: ${MEM} MB"
if [ "$MEM" -lt 2500 ] && [ "$TAM" != "tiny" ] && [ "$TAM" != "base" ]; then
  echo -e "${Y}Pouca memória para o Whisper '$TAM'. Usando 'base' (mais leve).${N}"; TAM=base; MODELO="Systran/faster-whisper-base"
fi

# Docker
if ! command -v docker >/dev/null; then
  info "Instalando o Docker..."
  apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker.io docker-compose-v2 >/dev/null || morrer "Não consegui instalar o Docker."
  systemctl enable --now docker >/dev/null 2>&1
fi
docker compose version >/dev/null 2>&1 || { DEBIAN_FRONTEND=noninteractive apt-get install -y -qq docker-compose-v2 >/dev/null || morrer "Falta o docker compose."; }
ok "Docker pronto"

mkdir -p "$DIR"; cp "$AQUI/docker-compose.yml" "$DIR/docker-compose.yml"
info "Baixando as imagens (a primeira vez demora: ~5 GB)..."
docker compose -f "$DIR/docker-compose.yml" pull -q
docker compose -f "$DIR/docker-compose.yml" up -d
ok "Serviços de voz no ar (só em 127.0.0.1)"

espera(){ for i in $(seq 1 90); do curl -fsS "$1" >/dev/null 2>&1 && return 0; sleep 4; done; return 1; }
info "Esperando o Whisper ligar..."; espera http://127.0.0.1:8000/health || morrer "O Whisper não respondeu. Veja: docker compose -f $DIR/docker-compose.yml logs ouvidos"
info "Baixando o modelo $MODELO..."
curl -fsS -X POST "http://127.0.0.1:8000/v1/models/$MODELO" >/dev/null || true
ok "Whisper pronto ($MODELO)"
info "Esperando o Kokoro ligar..."; espera http://127.0.0.1:8880/health || morrer "O Kokoro não respondeu. Veja: docker compose -f $DIR/docker-compose.yml logs boca"
VOZES=$(curl -fsS http://127.0.0.1:8880/v1/audio/voices 2>/dev/null | grep -o '"p[fm]_[a-z]*"' | tr -d '"' | tr '\n' ' ' || true)
ok "Kokoro pronto — vozes em português: ${VOZES:-pf_dora}"

# teste de ponta a ponta: fala uma frase e escuta de volta
info "Testando: Kokoro fala, Whisper escuta..."
TMP=$(mktemp -d)
curl -fsS -X POST http://127.0.0.1:8880/v1/audio/speech -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","voice":"pf_dora","input":"Olá Leandro, a voz local do Cérebro está funcionando.","response_format":"mp3"}' -o "$TMP/teste.mp3" || morrer "O Kokoro não gerou o áudio."
OUVIU=$(curl -fsS -X POST http://127.0.0.1:8000/v1/audio/transcriptions -F "file=@$TMP/teste.mp3" -F "model=$MODELO" -F language=pt | sed -n 's/.*"text":"\([^"]*\)".*/\1/p')
rm -rf "$TMP"
[ -n "$OUVIU" ] && ok "Ouvi: \"$OUVIU\"" || echo -e "${Y}O teste de escuta voltou vazio (o modelo pode ainda estar carregando). Rode de novo em 1 minuto.${N}"

# liga no Cérebro
if [ -f "$CENV" ]; then
  sed -i '/^LORLER_STT_URL=/d;/^LORLER_STT_MODEL=/d;/^LORLER_TTS_LOCAL_URL=/d' "$CENV"
  { echo "LORLER_STT_URL=http://127.0.0.1:8000"; echo "LORLER_STT_MODEL=$MODELO"; echo "LORLER_TTS_LOCAL_URL=http://127.0.0.1:8880"; } >> "$CENV"
  systemctl restart lorler-cerebro 2>/dev/null && ok "Cérebro reiniciado com a voz local" || echo -e "${Y}Reinicie o Cérebro: systemctl restart lorler-cerebro${N}"
else
  echo -e "${Y}Não achei $CENV. Coloque no .env do Cérebro:${N}"
  echo "LORLER_STT_URL=http://127.0.0.1:8000"; echo "LORLER_STT_MODEL=$MODELO"; echo "LORLER_TTS_LOCAL_URL=http://127.0.0.1:8880"
fi
echo
ok "Pronto. No Cérebro: Assistente › Voz › escolha 'Voz local (Kokoro)' e 'Ouvir pelo Whisper da VPS'."
