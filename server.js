const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const NAIPES = ['paus', 'copas', 'espadas', 'ouros'];
const VALORES = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
const PONTOS_PARA_VENCER = 12;
const VALORES_APOSTA = [1, 3, 6, 9, 12];

const FORCA_CARTA = { '4':1,'5':2,'6':3,'7':4,'Q':5,'J':6,'K':7,'A':8,'2':9,'3':10 };
const FORCA_NAIPE = { 'paus':4, 'copas':3, 'espadas':2, 'ouros':1 };

let salas = {};

function criarBaralho() {
    let baralho = [];
    NAIPES.forEach(n => VALORES.forEach(v => baralho.push({ naipe: n, valor: v })));
    return embaralhar(baralho);
}
function embaralhar(baralho) {
    for (let i = baralho.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [baralho[i], baralho[j]] = [baralho[j], baralho[i]];
    }
    return baralho;
}

function getValorManilha(vira) {
    if (!vira || !vira.valor) return null;
    let idx = VALORES.indexOf(vira.valor);
    return VALORES[(idx + 1) % VALORES.length];
}

function compararCartas(carta1, carta2, valorManilha) {
    if (!valorManilha) {
        const f1 = FORCA_CARTA[carta1.valor] || 0;
        const f2 = FORCA_CARTA[carta2.valor] || 0;
        return f1 - f2;
    }

    const v1 = carta1.valor;
    const v2 = carta2.valor;
    const n1 = carta1.naipe;
    const n2 = carta2.naipe;

    const manilha1 = (v1 === valorManilha);
    const manilha2 = (v2 === valorManilha);

    if (manilha1 && !manilha2) return 1;
    if (!manilha1 && manilha2) return -1;

    if (manilha1 && manilha2) {
        return FORCA_NAIPE[n1] - FORCA_NAIPE[n2];
    }

    const f1 = FORCA_CARTA[v1];
    const f2 = FORCA_CARTA[v2];
    if (f1 !== f2) return f1 - f2;

    return 0;
}

function passarVez(salaId) {
    const sala = salas[salaId];
    let idx = sala.ordemJogadores.indexOf(sala.jogadorAtual);
    let prox = (idx + 1) % sala.ordemJogadores.length;
    sala.jogadorAtual = sala.ordemJogadores[prox];
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadorAtual });
}

function verificarFimRodada(salaId) {
    const sala = salas[salaId];
    if (sala.cartasNaMesa.length < sala.ordemJogadores.length) {
        passarVez(salaId);
        return;
    }

    const valorManilha = getValorManilha(sala.vira);
    console.log(`[TRUCO] Sala ${salaId} - Rodada ${sala.rodadaAtual} - Vira: ${sala.vira.valor}${sala.vira.naipe} -> Manilha: ${valorManilha}`);

    let melhor = { A: null, B: null };
    sala.cartasNaMesa.forEach(j => {
        let atual = melhor[j.equipe];
        if (!atual || compararCartas(j.carta, atual.carta, valorManilha) > 0)
            melhor[j.equipe] = j;
    });

    const resultado = compararCartas(melhor.A.carta, melhor.B.carta, valorManilha);
    console.log(`[TRUCO] Resultado comparação: ${resultado} (${resultado > 0 ? 'A vence' : (resultado < 0 ? 'B vence' : 'Empate')})`);

    // Força fim da mão se passou da 3ª rodada (proteção extra)
    if (sala.rodadaAtual >= 3) {
        console.log(`[TRUCO] ⚠️ Rodada ${sala.rodadaAtual} excedeu limite! Forçando fim da mão por desempate.`);
        const nA = melhor.A.carta.naipe;
        const nB = melhor.B.carta.naipe;
        const vencedor = FORCA_NAIPE[nA] > FORCA_NAIPE[nB] ? 'A' : 'B';
        finalizarMao(salaId, vencedor);
        return;
    }

    if (resultado === 0) {
        console.log(`[TRUCO] Empate na rodada ${sala.rodadaAtual}`);
        if (sala.rodadaAtual === 3) {
            const nA = melhor.A.carta.naipe;
            const nB = melhor.B.carta.naipe;
            const vencedor = FORCA_NAIPE[nA] > FORCA_NAIPE[nB] ? 'A' : 'B';
            console.log(`[TRUCO] Desempate por naipe (3ª rodada): ${vencedor}`);
            sala.placarRodadas[vencedor]++;
            sala.ultimoVencedorRodada = melhor[vencedor].jogadorId;
            io.to(salaId).emit('atualizarPlacarRodadas', { rodadasA: sala.placarRodadas.A, rodadasB: sala.placarRodadas.B });
            finalizarMao(salaId, vencedor);
        } else {
            sala.ultimoVencedorRodada = sala.cartasNaMesa[sala.cartasNaMesa.length-1].jogadorId;
            iniciarRodada(salaId);
        }
        return;
    }

    const equipeVencedora = resultado > 0 ? 'A' : 'B';
    sala.placarRodadas[equipeVencedora]++;
    sala.ultimoVencedorRodada = melhor[equipeVencedora].jogadorId;
    console.log(`[TRUCO] Vencedor da rodada: ${equipeVencedora}. Placar de rodadas: ${sala.placarRodadas.A} x ${sala.placarRodadas.B}`);

    io.to(salaId).emit('atualizarPlacarRodadas', { rodadasA: sala.placarRodadas.A, rodadasB: sala.placarRodadas.B });

    const pontosA = sala.placarRodadas.A;
    const pontosB = sala.placarRodadas.B;
    const rodadaAtual = sala.rodadaAtual;

    if (pontosA >= 2 || pontosB >= 2) {
        console.log(`[TRUCO] Mão finalizada por 2 pontos.`);
        finalizarMao(salaId, equipeVencedora);
    } else if (rodadaAtual === 2 && (pontosA === 1 || pontosB === 1)) {
        console.log(`[TRUCO] Mão finalizada após 1ª rodada empatada e 2ª com vencedor.`);
        finalizarMao(salaId, equipeVencedora);
    } else {
        iniciarRodada(salaId);
    }
}

function iniciarRodada(salaId) {
    const sala = salas[salaId];
    sala.rodadaAtual++;
    sala.cartasNaMesa = [];
    if (sala.rodadaAtual === 1) {
        sala.jogadorAtual = sala.ordemJogadores[sala.jogadorQueIniciaProximaMao];
    } else {
        sala.jogadorAtual = sala.ultimoVencedorRodada;
    }
    console.log(`[TRUCO] Iniciando rodada ${sala.rodadaAtual}. Vez de ${sala.jogadorAtual}`);
    io.to(salaId).emit('novaRodada', { rodada: sala.rodadaAtual });
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadorAtual });
}

function finalizarMao(salaId, equipeVencedora) {
    const sala = salas[salaId];
    let pontos = sala.apostaAtual;
    sala.pontuacao[equipeVencedora] += pontos;
    console.log(`[TRUCO] 🏆 Fim da mão! Equipe ${equipeVencedora} ganhou ${pontos} ponto(s). Total: ${sala.pontuacao.A} x ${sala.pontuacao.B}`);
    io.to(salaId).emit('fimDeMao', { pontuacao: sala.pontuacao, vencedorMao: equipeVencedora, pontosGanhos: pontos });

    if (sala.pontuacao[equipeVencedora] >= PONTOS_PARA_VENCER) {
        io.to(salaId).emit('fimDeJogo', { vencedor: equipeVencedora, pontuacao: sala.pontuacao });
        sala.estado = 'aguardando';
        sala.jogadores.forEach(j => j.pronto = false);
        io.to(salaId).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });
    } else {
        sala.jogadorQueIniciaProximaMao = (sala.jogadorQueIniciaProximaMao + 1) % sala.ordemJogadores.length;
        iniciarNovaMao(salaId);
    }
}

function iniciarNovaMao(salaId) {
    const sala = salas[salaId];
    sala.baralho = criarBaralho();
    sala.vira = sala.baralho.pop();
    sala.maos = {};
    sala.jogadores.forEach(j => sala.maos[j.id] = [sala.baralho.pop(), sala.baralho.pop(), sala.baralho.pop()]);
    sala.rodadaAtual = 0;
    sala.cartasNaMesa = [];
    sala.apostaAtual = 1;
    sala.placarRodadas = { A:0, B:0 };
    sala.ultimoVencedorRodada = null;
    sala.ordemJogadores = sala.jogadores.map(j => j.id);
    sala.truco = { pendente: false, desafiante: null, desafiado: null, valorProposto: 3 };
    if (sala.jogadorQueIniciaProximaMao === undefined) sala.jogadorQueIniciaProximaMao = 0;

    sala.jogadores.forEach(j => {
        io.to(j.id).emit('iniciarMao', {
            cartas: sala.maos[j.id],
            vira: sala.vira,
            pontuacao: sala.pontuacao,
            equipe: j.equipe
        });
    });
    iniciarRodada(salaId);
    io.to(salaId).emit('atualizarAposta', { aposta: 1 });
}

// ---------- TRUCO ----------
function pedirTruco(salaId, socketId) {
    const sala = salas[salaId];
    if (!sala || sala.estado !== 'jogando') return;
    const jogador = sala.jogadores.find(j => j.id === socketId);
    if (!jogador) return;
    if (sala.truco.pendente) { io.to(socketId).emit('erro', 'Já existe truco pendente'); return; }
    const idx = VALORES_APOSTA.indexOf(sala.apostaAtual);
    if (idx === VALORES_APOSTA.length-1) return;
    const proximo = VALORES_APOSTA[idx+1];
    const adversarios = sala.jogadores.filter(j => j.equipe !== jogador.equipe);
    sala.truco = { pendente: true, desafiante: jogador.equipe, desafiado: adversarios.map(a=>a.id), valorProposto: proximo };
    adversarios.forEach(a => io.to(a.id).emit('trucoPedido', { valor: proximo, de: jogador.nome }));
    io.to(socketId).emit('trucoPedidoEnviado', { valor: proximo });
}
function responderTruco(salaId, socketId, aceitou, aumentar) {
    const sala = salas[salaId];
    if (!sala || !sala.truco.pendente) return;
    const jogador = sala.jogadores.find(j => j.id === socketId);
    if (!jogador) return;
    if (jogador.equipe === sala.truco.desafiante) { io.to(socketId).emit('erro', 'Resposta é do adversário'); return; }
    const desafiante = sala.truco.desafiante;
    const valor = sala.truco.valorProposto;
    if (aceitou) {
        sala.apostaAtual = valor;
        sala.truco = { pendente: false };
        io.to(salaId).emit('trucoAceito', { novaAposta: valor });
        io.to(salaId).emit('atualizarAposta', { aposta: valor });
    } else if (aumentar) {
        const idx = VALORES_APOSTA.indexOf(valor);
        if (idx === VALORES_APOSTA.length-1) return;
        const novo = VALORES_APOSTA[idx+1];
        const adversarios = sala.jogadores.filter(j => j.equipe !== jogador.equipe);
        sala.truco = { pendente: true, desafiante: jogador.equipe, desafiado: adversarios.map(a=>a.id), valorProposto: novo };
        io.to(salaId).emit('trucoAumentado', { de: jogador.nome, valor: novo });
        adversarios.forEach(a => io.to(a.id).emit('trucoPedido', { valor: novo, de: jogador.nome }));
    } else {
        sala.truco = { pendente: false };
        finalizarMao(salaId, desafiante);
    }
}

// ---------- Socket ----------
io.on('connection', socket => {
    console.log('🃏', socket.id);
    socket.on('entrarSala', ({ apelido, sala: nome, modo }) => {
        socket.join(nome); socket.sala = nome; socket.apelido = apelido;
        if (!salas[nome]) salas[nome] = { jogadores:[], espectadores:[], modo: modo||'1x1', estado:'aguardando', pontuacao:{A:0,B:0}, jogadorQueIniciaProximaMao:0 };
        const sala = salas[nome];
        const cap = sala.modo==='2x2'?4:2;
        if (sala.jogadores.length >= cap) return socket.emit('erro','Sala cheia');
        const equipe = (sala.jogadores.filter(j=>j.equipe==='A').length <= sala.jogadores.filter(j=>j.equipe==='B').length) ? 'A':'B';
        sala.jogadores.push({ id:socket.id, nome:apelido, equipe, pronto:false });
        io.to(nome).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });
    });
    socket.on('marcarPronto', () => {
        const sala = salas[socket.sala]; if (!sala) return;
        const jog = sala.jogadores.find(j=>j.id===socket.id); if (jog) jog.pronto = true;
        io.to(socket.sala).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });
        const cap = sala.modo==='2x2'?4:2;
        if (sala.jogadores.length === cap && sala.jogadores.every(j=>j.pronto) && sala.estado==='aguardando') {
            sala.estado = 'jogando'; sala.pontuacao = {A:0,B:0};
            io.to(socket.sala).emit('jogoIniciado');
            iniciarNovaMao(socket.sala);
        }
    });
    socket.on('jogarCarta', carta => {
        const sala = salas[socket.sala]; if (!sala || sala.estado!=='jogando') return;
        if (sala.jogadorAtual !== socket.id) return socket.emit('erro','Não é sua vez');
        const jog = sala.jogadores.find(j=>j.id===socket.id);
        const mao = sala.maos[jog.id];
        const idx = mao.findIndex(c=>c.naipe===carta.naipe && c.valor===carta.valor);
        if (idx===-1) return socket.emit('erro','Carta inválida');
        mao.splice(idx,1);
        sala.cartasNaMesa.push({ jogadorId: jog.id, equipe: jog.equipe, carta });
        io.to(socket.sala).emit('cartaJogada', { jogadorId: jog.id, carta, equipe: jog.equipe });
        if (sala.cartasNaMesa.length === sala.ordemJogadores.length) verificarFimRodada(socket.sala);
        else passarVez(socket.sala);
    });
    socket.on('pedirTruco', ()=>pedirTruco(socket.sala, socket.id));
    socket.on('responderTruco', ({aceitou, aumentar})=>responderTruco(socket.sala, socket.id, aceitou, aumentar||false));
    socket.on('desistir', ()=>{
        const sala = salas[socket.sala]; if (!sala) return;
        const jog = sala.jogadores.find(j=>j.id===socket.id);
        if (jog) finalizarMao(socket.sala, jog.equipe==='A'?'B':'A');
    });
    socket.on('disconnect', ()=>{
        const sala = salas[socket.sala]; if (!sala) return;
        sala.jogadores = sala.jogadores.filter(j=>j.id!==socket.id);
        if (sala.jogadores.length===0) delete salas[socket.sala];
        else io.to(socket.sala).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });
    });
});

server.listen(process.env.PORT || 3000, ()=>console.log('Truco no ar'));
