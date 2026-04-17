const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// --- Configurações do Truco Paulista ---
const NAIPES = ['paus', 'copas', 'espadas', 'ouros'];
const VALORES = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3']; // Ordem cíclica para definir manilha
const ORDEM_FORCA = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3']; // Ordem real da menor para a maior
const PONTOS_PARA_VENCER = 12;

let salas = {};

// --- Funções de Lógica do Jogo ---
function criarBaralho() {
    let baralho = [];
    NAIPES.forEach(naipe => {
        VALORES.forEach(valor => {
            baralho.push({ naipe, valor });
        });
    });
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

// Compara duas cartas. Retorna >0 se carta1 for maior, <0 se menor, 0 se empate.
function compararCartas(carta1, carta2, manilhas, cartaVirada) {
    // 1. Verifica se é manilha
    const manilha1 = manilhas.find(m => m.naipe === carta1.naipe && m.valor === carta1.valor);
    const manilha2 = manilhas.find(m => m.naipe === carta2.naipe && m.valor === carta2.valor);

    if (manilha1 && !manilha2) return 1;
    if (!manilha1 && manilha2) return -1;
    if (manilha1 && manilha2) {
        // Ambas são manilhas: compara por naipe (Paus > Copas > Espadas > Ouros)
        const forcaNaipe = { 'paus': 4, 'copas': 3, 'espadas': 2, 'ouros': 1 };
        return forcaNaipe[carta1.naipe] - forcaNaipe[carta2.naipe];
    }

    // 2. Nenhuma é manilha: compara pela ordem de força normal
    const forcaCarta = { '3': 10, '2': 9, 'A': 8, 'K': 7, 'J': 6, 'Q': 5, '7': 4, '6': 3, '5': 2, '4': 1 };
    return forcaCarta[carta1.valor] - forcaCarta[carta2.valor];
}

function passarVez(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    sala.jogadorAtual = (sala.jogadorAtual + 1) % sala.jogadores.length;
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadores[sala.jogadorAtual].id });
}

function proximaRodada(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    sala.rodada++;
    sala.cartasNaMesa = [];
    passarVez(salaId);
    io.to(salaId).emit('novaRodada', { rodada: sala.rodada });
}

function verificarFimDaMao(salaId) {
    const sala = salas[salaId];
    if (!sala) return;

    const vencedorRodada = determinarVencedorRodada(sala);
    if (vencedorRodada) {
        sala.placarRodadas[vencedorRodada.equipe]++;
        if (sala.placarRodadas[vencedorRodada.equipe] >= 2) {
            // Fim da mão
            finalizarMao(salaId, vencedorRodada.equipe);
        } else {
            proximaRodada(salaId);
        }
    }
}

function determinarVencedorRodada(sala) {
    if (sala.cartasNaMesa.length < 2) return null;
    const [jogada1, jogada2] = sala.cartasNaMesa;
    const resultado = compararCartas(jogada1.carta, jogada2.carta, sala.manilhas, sala.vira);
    if (resultado > 0) return { equipe: jogada1.equipe };
    if (resultado < 0) return { equipe: jogada2.equipe };
    return null; // Empate (aguarda a próxima carta)
}

function finalizarMao(salaId, equipeVencedora) {
    const sala = salas[salaId];
    if (!sala) return;
    let pontosGanhos = sala.apostaAtual || 1;
    sala.pontuacao[equipeVencedora] += pontosGanhos;
    
    const estado = {
        pontuacao: sala.pontuacao,
        vencedorMao: equipeVencedora,
        pontosGanhos: pontosGanhos
    };
    io.to(salaId).emit('fimDeMao', estado);

    if (sala.pontuacao[equipeVencedora] >= PONTOS_PARA_VENCER) {
        io.to(salaId).emit('fimDeJogo', { vencedor: equipeVencedora, pontuacao: sala.pontuacao });
        delete salas[salaId];
    } else {
        iniciarNovaMao(salaId);
    }
}

function iniciarNovaMao(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    sala.baralho = criarBaralho();
    sala.vira = sala.baralho.pop();
    sala.manilhas = definirManilhas(sala.vira);
    sala.maos = {};
    sala.jogadores.forEach(jogador => {
        sala.maos[jogador.id] = [sala.baralho.pop(), sala.baralho.pop(), sala.baralho.pop()];
    });
    sala.rodada = 1;
    sala.cartasNaMesa = [];
    sala.apostaAtual = 1;
    sala.placarRodadas = { 'A': 0, 'B': 0 };
    sala.jogadorAtual = 0;

    sala.jogadores.forEach(jogador => {
        io.to(jogador.id).emit('iniciarMao', {
            cartas: sala.maos[jogador.id],
            vira: sala.vira,
            manilhas: sala.manilhas,
            pontuacao: sala.pontuacao,
            equipe: jogador.equipe
        });
    });
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadores[0].id });
}

// --- Eventos de Socket ---
io.on('connection', (socket) => {
    console.log('🃏 Novo jogador conectado:', socket.id);

    socket.on('entrarSala', ({ apelido, sala: nomeSala, modo }) => {
        socket.join(nomeSala);
        socket.sala = nomeSala;
        socket.apelido = apelido;

        if (!salas[nomeSala]) {
            salas[nomeSala] = {
                jogadores: [],
                espectadores: [],
                modo: modo || '1x1', // '1x1' ou '2x2'
                estado: 'aguardando',
                pontuacao: { 'A': 0, 'B': 0 }
            };
        }
        const sala = salas[nomeSala];

        if (sala.jogadores.length >= (sala.modo === '2x2' ? 4 : 2)) {
            socket.emit('erro', 'Esta sala já está cheia!');
            return;
        }

        const equipe = (sala.jogadores.length % 2 === 0) ? 'A' : 'B';
        sala.jogadores.push({ id: socket.id, nome: apelido, equipe });
        
        io.to(nomeSala).emit('atualizarLobby', {
            jogadores: sala.jogadores,
            modo: sala.modo,
            estado: sala.estado
        });

        const capacidade = sala.modo === '2x2' ? 4 : 2;
        if (sala.jogadores.length === capacidade) {
            sala.estado = 'jogando';
            io.to(nomeSala).emit('jogoIniciado');
            iniciarNovaMao(nomeSala);
        }
    });

    socket.on('jogarCarta', (carta) => {
        const sala = salas[socket.sala];
        if (!sala || sala.estado !== 'jogando') return;
        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador || sala.jogadores[sala.jogadorAtual].id !== socket.id) return;

        const cartaNaMao = sala.maos[jogador.id].find(c => c.naipe === carta.naipe && c.valor === carta.valor);
        if (!cartaNaMao) return;

        sala.maos[jogador.id] = sala.maos[jogador.id].filter(c => !(c.naipe === carta.naipe && c.valor === carta.valor));
        sala.cartasNaMesa.push({ jogadorId: jogador.id, equipe: jogador.equipe, carta });

        io.to(socket.sala).emit('cartaJogada', { jogadorId: jogador.id, carta });

        if (sala.cartasNaMesa.length === 2) {
            verificarFimDaMao(socket.sala);
        } else {
            passarVez(socket.sala);
        }
    });

    socket.on('pedirTruco', () => {
        const sala = salas[socket.sala];
        if (!sala || sala.estado !== 'jogando') return;
        const proximaAposta = (sala.apostaAtual || 1) + 3;
        if (proximaAposta > 12) return;

        const adversarios = sala.jogadores.filter(j => j.equipe !== sala.jogadores.find(j => j.id === socket.id).equipe);
        adversarios.forEach(adv => {
            io.to(adv.id).emit('trucoPedido', { valor: proximaAposta });
        });
    });

    socket.on('responderTruco', ({ aceitou }) => {
        const sala = salas[socket.sala];
        if (!sala) return;
        if (aceitou) {
            sala.apostaAtual += 3;
            io.to(socket.sala).emit('trucoAceito', { novaAposta: sala.apostaAtual });
        } else {
            const equipeVencedora = sala.jogadores.find(j => j.id === socket.id).equipe === 'A' ? 'B' : 'A';
            finalizarMao(socket.sala, equipeVencedora);
        }
    });

    socket.on('desistir', () => {
        const sala = salas[socket.sala];
        if (!sala || sala.estado !== 'jogando') return;
        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;
        const equipeVencedora = jogador.equipe === 'A' ? 'B' : 'A';
        finalizarMao(socket.sala, equipeVencedora);
    });

    socket.on('disconnect', () => {
        const nomeSala = socket.sala;
        if (!nomeSala || !salas[nomeSala]) return;
        const sala = salas[nomeSala];
        sala.jogadores = sala.jogadores.filter(j => j.id !== socket.id);
        if (sala.jogadores.length === 0) {
            delete salas[nomeSala];
        } else {
            io.to(nomeSala).emit('atualizarLobby', {
                jogadores: sala.jogadores,
                modo: sala.modo,
                estado: sala.estado
            });
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🃏 Motor de Truco rodando na porta ${PORT}`);
});
