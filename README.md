# Mídia de divulgação — LORLER / R2L2 Engetech

Branch `midia` do repositório CEREBRO, separada do código (histórico próprio, sem relação com a branch principal).
Guarda os vídeos publicados nas redes sociais e o gerador que os cria.

- `render.py` — gera vídeos curtos (9x16, 4x5, 1x1) a partir de um roteiro JSON em `specs/`.
- `fontes/` — gravações de tela dos sistemas (dados de demonstração), logotipos LORLER e fonte Inter (SIL Open Font License).
- `videos/` — vídeos prontos. Endereço público usado pelo Metricool:
  `https://cdn.jsdelivr.net/gh/lealves05/CEREBRO@midia/videos/<arquivo>.mp4`

Trilha sonora: sintetizada pelo próprio `render.py` (sem música de terceiros).
