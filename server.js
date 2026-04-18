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

// Mapa de força para cartas NÃO manilhas (maior número = mais forte)
const FORCA_CARTA = {
    '4': 1, '5': 2, '6': 3, '7': 4,
    'Q': 5, 'J': 6, 'K': 7, 'A': 8, '2': 9, '3': 10
};
// Mapa de força para naipes (usado apenas para desempate de manilhas ou cartas iguais)
const FORCA_NAIPE = { 'paus': 4, 'copas': 3, 'espadas': 2, 'ouros': 1 };

let salas = {};

function criarBaralho() {
    let baralho = [];
    NAIPES.forEach(naipe => VALORES.forEach(valor => baralho.push({ naipe, valor })));
    return embaralhar(baralho);
}
function embaralhar(baralho) {
    for (let i = baralho.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [baralho[i], baralho[j]] = [baralho[j], baralho[i]];
    }
    return baralho;
}
function definirManilhas(vira) {
    let indiceVira = VALORES.indexOf(vira.valor);
    let valorManilha = VALORES[(indiceVira + 1) % VALORES.length];
    return NAIPES.map(naipe => ({ naipe, valor: valorManilha }));
}

// NOVA FUNÇÃO DE COMPARAÇÃO – ROBUSTA E CORRIGIDA
function compararCartas(carta1, carta2, manilhas) {
    // Verifica se cada carta é manilha
    const isManilha1 = manilhas.some(m => m.naipe === carta1.naipe && m.valor === carta1.valor);
    const isManilha2 = manilhas.some(m => m.naipe === carta2.naipe && m.valor === carta2.valor);

    // Se uma é manilha e a outra não, a manilha vence
    if (isManilha1 && !isManilha2) return 1;
    if (!isManilha1 && isManilha2) return -1;

    // Se ambas são manilhas, desempata pelo naipe
    if (isManilha1 && isManilha2) {
        return FORCA_NAIPE[carta1.naipe] - FORCA_NAIPE[carta2.naipe];
    }

    // Nenhuma é manilha: compara pela força da carta
    const forca1 = FORCA_CARTA[carta1.valor];
    const forca2 = FORCA_CARTA[carta2.valor];
    if (forca1 !== forca2) {
        return forca1 - forca2;
    }
    // Se as cartas têm o mesmo valor (ex: dois "Q"), desempata pelo naipe (regra comum)
    return FORCA_NAIPE[carta1.naipe] - FORCA_NAIPE[carta2.naipe];
}

function passarVez(salaId) {
    const sala = salas[salaId];
    let indiceAtual = sala.ordemJogadores.indexOf(sala.jogadorAtual);
    let proximo = (indiceAtual + 1) % sala.ordemJogadores.length;
    sala.jogadorAtual = sala.ordemJogadores[proximo];
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadorAtual });
}

function verificarFimRodada(salaId) {
    const sala = salas[salaId];
    if (sala.cartasNaMesa.length < sala.ordemJogadores.length) {
        passarVez(salaId);
        return;
    }

    // Encontra a melhor carta de cada equipe na rodada
    let melhorPorEquipe = { 'A': null, 'B': null };
    sala.cartasNaMesa.forEach(jogada => {
        let melhor = melhorPorEquipe[jogada.equipe];
        if (!melhor || compararCartas(jogada.carta, melhor.carta, sala.manilhas) > 0)
            melhorPorEquipe[jogada.equipe] = jogada;
    });

    const resultado = compararCartas(melhorPorEquipe['A'].carta, melhorPorEquipe['B'].carta, sala.manilhas);

    // TRATAMENTO DE EMPATE
    if (resultado === 0) {
        console.log(`[Sala ${salaId}] Rodada ${sala.rodadaAtual} empatou.`);
        if (sala.rodadaAtual === 3) {
            // Terceira rodada: desempate por naipe já foi considerado em compararCartas (retornaria ≠0 se naipes diferentes)
            // Se chegou aqui com resultado 0, significa que as cartas são idênticas em valor e naipe? Impossível no baralho.
            // Mas por segurança, forçamos o desempate pelo naipe da carta mais alta de cada equipe.
            const naipeA = melhorPorEquipe['A'].carta.naipe;
            const naipeB = melhorPorEquipe['B'].carta.naipe;
            const equipeVencedora = FORCA_NAIPE[naipeA] > FORCA_NAIPE[naipeB] ? 'A' : 'B';
            console.log(`[Sala ${salaId}] Desempate por naipe: ${equipeVencedora} vence.`);
            sala.placarRodadas[equipeVencedora]++;
            sala.ultimoVencedorRodada = melhorPorEquipe[equipeVencedora].jogadorId;
            io.to(salaId).emit('atualizarPlacarRodadas', { rodadasA: sala.placarRodadas['A'], rodadasB: sala.placarRodadas['B'] });
            finalizarMao(salaId, equipeVencedora);
        } else {
            // Empate na 1ª ou 2ª rodada: passa para a próxima
            sala.ultimoVencedorRodada = sala.cartasNaMesa[sala.cartasNaMesa.length - 1].jogadorId;
            iniciarRodada(salaId);
        }
        return;
    }

    // HÁ UM VENCEDOR NA RODADA
    const equipeVencedora = resultado > 0 ? 'A' : 'B';
    sala.placarRodadas[equipeVencedora]++;
    sala.ultimoVencedorRodada = melhorPorEquipe[equipeVencedora].jogadorId;

    console.log(`[Sala ${salaId}] Rodada ${sala.rodadaAtual} vencida por ${equipeVencedora}. Placar de rodadas: ${sala.placarRodadas['A']} x ${sala.placarRodadas['B']}`);

    io.to(salaId).emit('atualizarPlacarRodadas', { rodadasA: sala.placarRodadas['A'], rodadasB: sala.placarRodadas['B'] });

    // VERIFICA SE A MÃO TERMINOU
    const totalRodadas = sala.rodadaAtual;
    const pontosA = sala.placarRodadas['A'];
    const pontosB = sala.placarRodadas['B'];

    // Condição 1: alguém fez 2 pontos (normal)
    if (pontosA >= 2 || pontosB >= 2) {
        console.log(`[Sala ${salaId}] Mão finalizada por 2 pontos.`);
        finalizarMao(salaId, equipeVencedora);
        return;
    }

    // Condição 2: estamos na 2ª rodada, a 1ª empatou (placar 0x0) e alguém venceu a 2ª (placar 1x0)
    // Isso é detectado por: totalRodadas === 2 && (pontosA === 1 || pontosB === 1) && antes estava 0x0.
    if (totalRodadas === 2 && (pontosA === 1 || pontosB === 1)) {
        console.log(`[Sala ${salaId}] Primeira rodada empatou, segunda rodada decide. Finalizando mão.`);
        finalizarMao(salaId, equipeVencedora);
        return;
    }

    // Condição 3: se por algum motivo a terceira rodada terminou com 1x1 (impossível aqui, pois já tratamos empate)
    // Apenas inicia próxima rodada se necessário
    iniciarRodada(salaId);
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

    console.log(`[Sala ${salaId}] Iniciando rodada ${sala.rodadaAtual}. Vez de ${sala.jogadorAtual}`);
    io.to(salaId).emit('novaRodada', { rodada: sala.rodadaAtual });
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadorAtual });
}

function finalizarMao(salaId, equipeVencedora) {
    const sala = salas[salaId];
    let pontos = sala.apostaAtual;
    sala.pontuacao[equipeVencedora] += pontos;
    console.log(`[Sala ${salaId}] Mão finalizada. Vencedor: ${equipeVencedora}. Pontos ganhos: ${pontos}. Total: ${sala.pontuacao['A']} x ${sala.pontuacao['B']}`);
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
    sala.manilhas = definirManilhas(sala.vira);
    sala.maos = {};
    sala.jogadores.forEach(j => sala.maos[j.id] = [sala.baralho.pop(), sala.baralho.pop(), sala.baralho.pop()]);
    sala.rodadaAtual = 0;
    sala.cartasNaMesa = [];
    sala.apostaAtual = 1;
    sala.placarRodadas = { 'A': 0, 'B': 0 };
    sala.ultimoVencedorRodada = null;
    sala.ordemJogadores = sala.jogadores.map(j => j.id);
    sala.truco = { pendente: false, desafiante: null, desafiado: null, valorProposto: 3 };
    if (sala.jogadorQueIniciaProximaMao === undefined) {
        sala.jogadorQueIniciaProximaMao = 0;
    }

    console.log(`[Sala ${salaId}] Nova mão. Vira: ${sala.vira.valor} de ${sala.vira.naipe}. Manilhas: ${sala.manilhas.map(m => m.valor + m.naipe.charAt(0)).join(', ')}`);

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

    if (sala.truco.pendente) {
        io.to(socketId).emit('erro', 'Já existe um pedido de truco aguardando resposta.');
        return;
    }

    const indiceAtual = VALORES_APOSTA.indexOf(sala.apostaAtual);
    if (indiceAtual === VALORES_APOSTA.length - 1) return;

    const proximoValor = VALORES_APOSTA[indiceAtual + 1];
    const adversarios = sala.jogadores.filter(j => j.equipe !== jogador.equipe);
    sala.truco = {
        pendente: true,
        desafiante: jogador.equipe,
        desafiado: adversarios.map(a => a.id),
        valorProposto: proximoValor
    };

    adversarios.forEach(adv => io.to(adv.id).emit('trucoPedido', { valor: proximoValor, de: jogador.nome }));
    io.to(socketId).emit('trucoPedidoEnviado', { valor: proximoValor });
}

function responderTruco(salaId, socketId, aceitou, aumentar) {
    const sala = salas[salaId];
    if (!sala || !sala.truco.pendente) return;
    const jogador = sala.jogadores.find(j => j.id === socketId);
    if (!jogador) return;

    if (jogador.equipe === sala.truco.desafiante) {
        io.to(socketId).emit('erro', 'A resposta é da equipe adversária.');
        return;
    }

    const desafianteEquipe = sala.truco.desafiante;
    const valorProposto = sala.truco.valorProposto;

    if (aceitou) {
        sala.apostaAtual = valorProposto;
        sala.truco = { pendente: false, desafiante: null, desafiado: null, valorProposto: 0 };
        io.to(salaId).emit('trucoAceito', { novaAposta: sala.apostaAtual });
        io.to(salaId).emit('atualizarAposta', { aposta: sala.apostaAtual });
    } else if (aumentar) {
        const indiceAtual = VALORES_APOSTA.indexOf(valorProposto);
        if (indiceAtual === VALORES_APOSTA.length - 1) return;
        const novoValor = VALORES_APOSTA[indiceAtual + 1];
        const adversarios = sala.jogadores.filter(j => j.equipe !== jogador.equipe);
        sala.truco = {
            pendente: true,
            desafiante: jogador.equipe,
            desafiado: adversarios.map(a => a.id),
            valorProposto: novoValor
        };
        io.to(salaId).emit('trucoAumentado', { de: jogador.nome, valor: novoValor });
        adversarios.forEach(adv => io.to(adv.id).emit('trucoPedido', { valor: novoValor, de: jogador.nome }));
    } else {
        // Correr
        sala.truco = { pendente: false, desafiante: null, desafiado: null, valorProposto: 0 };
        finalizarMao(salaId, desafianteEquipe);
    }
}

// ---------- Socket ----------
io.on('connection', (socket) => {
    console.log('🃏 Conectado:', socket.id);

    socket.on('entrarSala', ({ apelido, sala: nomeSala, modo }) => {
        socket.join(nomeSala);
        socket.sala = nomeSala;
        socket.apelido = apelido;

        if (!salas[nomeSala]) {
            salas[nomeSala] = {
                jogadores: [], espectadores: [], modo: modo || '1x1', estado: 'aguardando',
                pontuacao: { 'A': 0, 'B': 0 }, jogadorQueIniciaProximaMao: 0
            };
        }
        const sala = salas[nomeSala];
        const capacidade = sala.modo === '2x2' ? 4 : 2;
        if (sala.jogadores.length >= capacidade) return socket.emit('erro', 'Sala cheia');

        const equipe = (sala.jogadores.filter(j => j.equipe === 'A').length <=
                       sala.jogadores.filter(j => j.equipe === 'B').length) ? 'A' : 'B';
        sala.jogadores.push({ id: socket.id, nome: apelido, equipe, pronto: false });
        io.to(nomeSala).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });
    });

    socket.on('marcarPronto', () => {
        const sala = salas[socket.sala];
        if (!sala) return;
        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (jogador) jogador.pronto = true;
        io.to(socket.sala).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });

        const capacidade = sala.modo === '2x2' ? 4 : 2;
        if (sala.jogadores.length === capacidade && sala.jogadores.every(j => j.pronto) && sala.estado === 'aguardando') {
            sala.estado = 'jogando';
            sala.pontuacao = { 'A': 0, 'B': 0 };
            io.to(socket.sala).emit('jogoIniciado');
            iniciarNovaMao(socket.sala);
        }
    });

    socket.on('jogarCarta', (carta) => {
        const sala = salas[socket.sala];
        if (!sala || sala.estado !== 'jogando') return;
        if (sala.jogadorAtual !== socket.id) return socket.emit('erro', 'Não é sua vez');

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        const mao = sala.maos[jogador.id];
        const index = mao.findIndex(c => c.naipe === carta.naipe && c.valor === carta.valor);
        if (index === -1) return socket.emit('erro', 'Carta inválida');

        mao.splice(index, 1);
        sala.cartasNaMesa.push({ jogadorId: jogador.id, equipe: jogador.equipe, carta });

        io.to(socket.sala).emit('cartaJogada', { jogadorId: jogador.id, carta, equipe: jogador.equipe });

        if (sala.cartasNaMesa.length === sala.ordemJogadores.length) {
            verificarFimRodada(socket.sala);
        } else {
            passarVez(socket.sala);
        }
    });

    socket.on('pedirTruco', () => pedirTruco(socket.sala, socket.id));

    socket.on('responderTruco', ({ aceitou, aumentar }) => {
        responderTruco(socket.sala, socket.id, aceitou, aumentar || false);
    });

    socket.on('desistir', () => {
        const sala = salas[socket.sala];
        if (!sala || sala.estado !== 'jogando') return;
        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (jogador) finalizarMao(socket.sala, jogador.equipe === 'A' ? 'B' : 'A');
    });

    socket.on('disconnect', () => {
        const sala = salas[socket.sala];
        if (!sala) return;
        sala.jogadores = sala.jogadores.filter(j => j.id !== socket.id);
        if (sala.jogadores.length === 0) delete salas[socket.sala];
        else io.to(socket.sala).emit('atualizarLobby', { jogadores: sala.jogadores, modo: sala.modo, estado: sala.estado });
    });
});

server.listen(process.env.PORT || 3000, () => console.log('🃏 Motor de Truco rodando'));
