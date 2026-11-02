# Domínio Global 🌍

Jogo de estratégia por turnos no navegador: cada país do mapa-múndi é um território,
e os jogadores atacam fronteiras com seus exércitos até dominar o mundo.
Funciona **online, sem servidor próprio** — dá para hospedar direto no GitHub Pages.

## Como jogar

1. Uma pessoa abre o site, digita o nome e toca em **Criar sala**.
2. Os outros entram **lendo o QR code** com a câmera do celular, pelo link, ou digitando o **código da sala**.
3. O anfitrião pode adicionar bots, escolher o objetivo e tocar em **Iniciar partida** (2 a 6 jogadores).

Cada turno tem três fases:

| Fase | O que fazer |
|---|---|
| **Reforço** | Recebe `max(3, países ÷ 3)` exércitos + bônus por continente inteiro. Toque nos seus países para posicioná-los. 3 cartas iguais ou 3 diferentes (★ é curinga) podem ser trocadas por exércitos (4, 6, 8, 10, 12, 15, +5…). |
| **Ataque** | Toque num país seu (2+ exércitos) e depois num vizinho inimigo. Ataque usa até 3 dados, defesa até 2; empate é da defesa. "Até o fim" repete até vencer ou ficar com 1 exército. |
| **Remanejar** | Mova exércitos entre países seus que fazem fronteira. Cada exército só se move uma vez por turno. |

Quem conquistar pelo menos um país no turno ganha uma carta. Vence quem atingir a porcentagem
de países definida na sala (50% a 100%) ou eliminar todos os adversários.
Linhas tracejadas no mapa são rotas marítimas (ex.: Brasil–Senegal, Espanha–Marrocos, EUA–Rússia).

## Publicar no GitHub Pages

```bash
git init
git add .
git commit -m "Domínio Global"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/dominio-global.git
git push -u origin main
```

No GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch → `main` / `(root)`**.
Em 1–2 minutos o jogo fica em `https://SEU_USUARIO.github.io/dominio-global/`.
O QR code usa o endereço atual da página, então funciona sozinho depois de publicado.

## Rodar localmente

```bash
python3 -m http.server 8080   # ou: npm start
```

Abra `http://localhost:8080`. Para testar com o celular na mesma rede, use o IP do computador
(o QR code aponta para o endereço que estiver aberto no navegador do anfitrião).

## Como o online funciona

- Usa **WebRTC via [PeerJS](https://peerjs.com/)**. O servidor público gratuito do PeerJS só apresenta os
  navegadores; depois a partida trafega direto entre eles.
- O **anfitrião é o juiz**: valida todas as jogadas e envia o estado para os demais. Por isso a aba
  dele precisa ficar aberta durante a partida.
- Se o anfitrião recarregar a página, aparece **"Retomar minha sala"** e os jogadores reconectam sozinhos.
- Se um jogador cair, a vez dele é jogada por um bot após 15 s; ao voltar (mesmo navegador), ele reassume.
- Em algumas redes muito restritas (Wi-Fi corporativo, certas operadoras) o WebRTC pode não conectar.

## Estrutura

```
index.html          telas (início, sala de espera, jogo)
css/style.css       visual
js/main.js          interface, sala, papel de anfitrião/convidado
js/game.js          regras puras (sem DOM nem rede)
js/bot.js           IA dos bots
js/map.js           desenho do mapa (d3) com zoom
js/net.js           conexão P2P (PeerJS)
data/countries-110m.json   contornos dos países (world-atlas, Natural Earth)
data/world.json     territórios, fronteiras, continentes (gerado)
tools/build-map.mjs gera data/world.json
test/sim.test.mjs   simula partidas inteiras entre bots
```

Testes: `node test/sim.test.mjs`.
Para mudar fronteiras, rotas marítimas ou bônus: edite `tools/build-map.mjs` e rode
`cd tools && npm install && node build-map.mjs`.

Dados do mapa: [Natural Earth](https://www.naturalearthdata.com/) via
[world-atlas](https://github.com/topojson/world-atlas) (domínio público).
