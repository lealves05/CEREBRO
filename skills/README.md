# Habilidades do Cérebro (JARVIS)

Cada pasta é **uma habilidade** com um arquivo `SKILL.md`. O Cérebro só aciona a habilidade quando o momento pede
(quando a frase bate com um dos `gatilhos`). Regra: **habilidade pequena, propósito gigante.**

| Habilidade | O que faz | Grava no cofre |
|---|---|---|
| `metricas` | mostra seus números | `outputs/metricas-AAAA-MM-DD.md` |
| `caixa-de-entrada` | o resumo da manhã | `outputs/resumo-AAAA-MM-DD.md` |
| `tendencias` | analisa o que está mudando (7 dias × 7 anteriores) | `outputs/tendencias-AAAA-MM-DD.md` |
| `plano-de-hoje` | escreve seu top 3 | `diario/AAAA-MM-DD.md` › Top 3 |
| `cofre` | lê e escreve memória ("lembre que…", "o que você sabe sobre…") | `wiki/` e `diario/` |
| `encerrar-dia` | fecha o dia, registra a reflexão e deixa amanhã na fila | `diario/AAAA-MM-DD.md` › Encerramento |

## Formato do SKILL.md
```
---
nome: metricas
titulo: Métricas
descricao: uma linha dizendo para que serve
gatilhos:
  - expressão regular (sem acento, minúscula) que aciona a habilidade
---
Instruções em texto livre: o jeito de responder. Vão junto para a IA quando a habilidade roda.
```
Mudou um gatilho ou a instrução? Basta editar o arquivo: o Cérebro relê as habilidades a cada minuto.
A parte que calcula (números, gravação no cofre) fica em `src/services/skills.js` — a IA nunca inventa número.
