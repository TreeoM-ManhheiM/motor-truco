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
const VALORES = ['4', '5', '6', '7', 'Q', 'J', 'K', 'A', '2', '3'];
const PONTOS_PARA_VENCER = 12;
const PONTOS_INICIAIS_MAO = 1;
const PONTOS_TRUCO = [3, 6, 9, 12]; // Valores após cada pedido aceito

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
function compararCartas(carta1, carta2, manilhas) {
    // Verifica se é manilha
    const manilha1 = manilhas.find(m => m.naipe === carta1.naipe && m.valor === carta1.valor);
    const manilha2 = manilhas.find(m => m.naipe === carta2.naipe && m.valor === carta2.valor);

    if (manilha1 && !manilha2) return 1;
    if (!manilha1 && manilha2) return -1;
    if (manilha1 && manilha2) {
        const forcaNaipe = { 'paus': 4, 'copas': 3, 'espadas': 2, 'ouros': 1 };
        return forcaNaipe[carta1.naipe] - forcaNaipe[carta2.naipe];
    }

    // Nenhuma é manilha
    const forcaCarta = { '3': 10, '2': 9, 'A': 8, 'K': 7, 'J': 6, 'Q': 5, '7': 4, '6': 3, '5': 2, '4': 1 };
    return forcaCarta[carta1.valor] - forcaCarta[carta2.valor];
}

function passarVez(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    // Avança para o próximo jogador na ordem
    let indiceAtual = sala.ordemJogadores.indexOf(sala.jogadorAtual);
    let proximoIndice = (indiceAtual + 1) % sala.ordemJogadores.length;
    sala.jogadorAtual = sala.ordemJogadores[proximoIndice];
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadorAtual });
}

function iniciarRodada(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    sala.rodadaAtual++;
    sala.cartasNaMesa = [];
    // Define quem começa a rodada (geralmente quem ganhou a anterior ou o primeiro da mão)
    if (sala.rodadaAtual === 1) {
        sala.jogadorAtual = sala.ordemJogadores[0];
    } else {
        // O vencedor da rodada anterior começa (já está armazenado em sala.ultimoVencedorRodada)
        sala.jogadorAtual = sala.ultimoVencedorRodada || sala.ordemJogadores[0];
    }
    io.to(salaId).emit('novaRodada', { rodada: sala.rodadaAtual });
    io.to(salaId).emit('atualizarVez', { jogadorId: sala.jogadorAtual });
}

function determinarVencedorRodada(sala) {
    // Agrupa cartas por equipe e pega a maior de cada equipe
    let cartasPorEquipe = { 'A': [], 'B': [] };
    sala.cartasNaMesa.forEach(jogada => {
        cartasPorEquipe[jogada.equipe].push(jogada);
    });
    // Para cada equipe, encontra a carta mais forte jogada
    let melhorPorEquipe = {};
    for (let eq of ['A', 'B']) {
        if (cartasPorEquipe[eq].length > 0) {
            let melhor = cartasPorEquipe[eq][0];
            for (let i = 1; i < cartasPorEquipe[eq].length; i++) {
                if (compararCartas(cartasPorEquipe[eq][i].carta, melhor.carta, sala.manilhas) > 0) {
                    melhor = cartasPorEquipe[eq][i];
                }
            }
            melhorPorEquipe[eq] = melhor;
        }
    }
    // Compara as melhores cartas das equipes que jogaram
    if (melhorPorEquipe['A'] && melhorPorEquipe['B']) {
        let resultado = compararCartas(melhorPorEquipe['A'].carta, melhorPorEquipe['B'].carta, sala.manilhas);
        if (resultado > 0) return { equipe: 'A', jogadorId: melhorPorEquipe['A'].jogadorId };
        if (resultado < 0) return { equipe: 'B', jogadorId: melhorPorEquipe['B'].jogadorId };
        // Empate: ninguém vence a rodada ainda; a próxima carta decide
        return null;
    }
    return null;
}

function verificarFimDaRodada(salaId) {
    const sala = salas[salaId];
    if (!sala) return;
    
    // Verifica se todos os jogadores da rodada já jogaram (número de cartas igual ao número de jogadores)
    if (sala.cartasNaMesa.length === sala.ordemJogadores.length) {
        let vencedor = determinarVencedorRodada(sala);
        if (vencedor) {
            // Equipe venceu a rodada
            sala.placarRodadas[vencedor.equipe]++;
            sala.ultimoVencedorRodada = vencedor.jogadorId;
            
            io.to(salaId).emit('atualizarPlacarRodadas', {
                rodadasA: sala.placarRodadas['A'],
                rodadasB: sala.placarRodadas['B']
            });

            // Verifica se a mão terminou (2 rodadas vencidas)
            if (sala.placarRodadas['A'] >= 2 || sala.placarRodadas['B'] >= 2) {
                finalizarMao(salaId, sala.placarRodadas['A'] >= 2 ? 'A' : 'B');
            } else {
                // Inicia próxima rodada
                iniciarRodada(salaId);
            }
        } else {
            // Empate na rodada: a próxima rodada começa com quem jogou a última carta (regra opcional, mas comum)
            sala.ultimoVencedorRodada = sala.cartasNaMesa[sala.cartasNaMesa.length - 1].jogadorId;
            iniciarRodada(salaId);
        }
    } else {
        // Ainda não terminaram de jogar, passa a vez
        passarVez(salaId);
    }
}

function finalizarMao(salaId, equipeVencedora) {
    const sala = salas[salaId];
    if (!sala) return;
    
    let pontosGanhos = sala.apostaAtual;
    sala.pontuacao[equipeVencedora] += pontosGanhos;
    
    io.to(salaId).emit('fimDeMao', {
        pontuacao: sala.pontuacao,
        vencedorMao: equipeVencedora,
        pontosGanhos: pontosGanhos
    });

    if (sala.pontuacao[equipeVencedora] >= PONTOS_PARA_VENCER) {
        io.to(salaId).emit('fimDeJogo', { vencedor: equipeVencedora, pontuacao: sala.pontuacao });
        // Resetar sala para lobby
        sala.estado = 'aguardando';
        sala.jogadores.forEach(j => j.pronto = false);
        io.to(salaId).emit('atualizarLobby', {
            jogadores: sala.jogadores,
            modo: sala.modo,
            estado: sala.estado
        });
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
        sala.maos[jogador.id] = [
            sala.baralho.pop(),
            sala.baralho.pop(),
            sala.baralho.pop()
        ];
    });
    sala.rodadaAtual = 0;
    sala.cartasNaMesa = [];
    sala.apostaAtual = PONTOS_INICIAIS_MAO;
    sala.placarRodadas = { 'A': 0, 'B': 0 };
    sala.ultimoVencedorRodada = null;
    
    // Define a ordem dos jogadores na mesa (sentido horário a partir do primeiro jogador da lista)
    // Para 2x2, a ordem natural (índices 0,1,2,3) já coloca parceiros intercalados se entradas forem A, B, A, B.
    sala.ordemJogadores = sala.jogadores.map(j => j.id);
    
    sala.jogadores.forEach(jogador => {
        io.to(jogador.id).emit('iniciarMao', {
            cartas: sala.maos[jogador.id],
            vira: sala.vira,
            pontuacao: sala.pontuacao,
            equipe: jogador.equipe
        });
    });
    
    // Inicia a primeira rodada
    iniciarRodada(salaId);
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
                modo: modo || '1x1',
                estado: 'aguardando',
                pontuacao: { 'A': 0, 'B': 0 }
            };
        }
        const sala = salas[nomeSala];
        const capacidade = sala.modo === '2x2' ? 4 : 2;

        if (sala.jogadores.length >= capacidade) {
            socket.emit('erro', 'Esta sala já está cheia!');
            return;
        }

        // Define equipe (alterna A, B, A, B...)
        const equipe = (sala.jogadores.filter(j => j.equipe === 'A').length <= 
                        sala.jogadores.filter(j => j.equipe === 'B').length) ? 'A' : 'B';
        
        const novoJogador = {
            id: socket.id,
            nome: apelido,
            equipe: equipe,
            pronto: false
        };
        sala.jogadores.push(novoJogador);
        
        io.to(nomeSala).emit('atualizarLobby', {
            jogadores: sala.jogadores,
            modo: sala.modo,
            estado: sala.estado
        });

        // Verifica se a sala está completa
        if (sala.jogadores.length === capacidade) {
            // Não inicia automaticamente; aguarda todos marcarem pronto
        }
    });

    socket.on('marcarPronto', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala) return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (jogador) jogador.pronto = true;

        io.to(nomeSala).emit('atualizarLobby', {
            jogadores: sala.jogadores,
            modo: sala.modo,
            estado: sala.estado
        });

        const capacidade = sala.modo === '2x2' ? 4 : 2;
        const todosProntos = sala.jogadores.length === capacidade && sala.jogadores.every(j => j.pronto);
        
        if (todosProntos && sala.estado === 'aguardando') {
            sala.estado = 'jogando';
            sala.pontuacao = { 'A': 0, 'B': 0 };
            io.to(nomeSala).emit('jogoIniciado');
            iniciarNovaMao(nomeSala);
        }
    });

    socket.on('jogarCarta', (carta) => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || sala.estado !== 'jogando') return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador || sala.jogadorAtual !== socket.id) return;

        // Verifica se a carta está na mão do jogador
        const mao = sala.maos[jogador.id];
        const indexCarta = mao.findIndex(c => c.naipe === carta.naipe && c.valor === carta.valor);
        if (indexCarta === -1) return;

        // Remove a carta da mão
        mao.splice(indexCarta, 1);
        
        // Adiciona à mesa
        sala.cartasNaMesa.push({
            jogadorId: jogador.id,
            equipe: jogador.equipe,
            carta: carta
        });

        io.to(nomeSala).emit('cartaJogada', {
            jogadorId: jogador.id,
            carta: carta,
            equipe: jogador.equipe
        });

        // Verifica se a rodada terminou
        verificarFimDaRodada(nomeSala);
    });

    socket.on('pedirTruco', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || sala.estado !== 'jogando') return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        const indiceAtual = PONTOS_TRUCO.indexOf(sala.apostaAtual);
        if (indiceAtual === -1) return; // Não está em estado de truco

        const proximoValor = PONTOS_TRUCO[indiceAtual + 1];
        if (!proximoValor) return; // Já está no máximo (12)

        // Envia pedido para a equipe adversária
        const adversarios = sala.jogadores.filter(j => j.equipe !== jogador.equipe);
        adversarios.forEach(adv => {
            io.to(adv.id).emit('trucoPedido', { valor: proximoValor, de: jogador.nome });
        });
    });

    socket.on('responderTruco', ({ aceitou }) => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || sala.estado !== 'jogando') return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        // Assume que a resposta é do primeiro adversário que recebeu o pedido
        if (aceitou) {
            const indiceAtual = PONTOS_TRUCO.indexOf(sala.apostaAtual);
            sala.apostaAtual = PONTOS_TRUCO[indiceAtual + 1];
            io.to(nomeSala).emit('trucoAceito', { novaAposta: sala.apostaAtual });
        } else {
            // Equipe que pediu ganha os pontos atuais (antes do aumento)
            const equipePediu = jogador.equipe === 'A' ? 'B' : 'A';
            finalizarMao(nomeSala, equipePediu);
        }
    });

    socket.on('desistir', () => {
        const nomeSala = socket.sala;
        const sala = salas[nomeSala];
        if (!sala || sala.estado !== 'jogando') return;

        const jogador = sala.jogadores.find(j => j.id === socket.id);
        if (!jogador) return;

        const equipeVencedora = jogador.equipe === 'A' ? 'B' : 'A';
        finalizarMao(nomeSala, equipeVencedora);
    });

    socket.on('disconnect', () => {
        const nomeSala = socket.sala;
        if (!nomeSala || !salas[nomeSala]) return;

        const sala = salas[nomeSala];
        sala.jogadores = sala.jogadores.filter(j => j.id !== socket.id);
        
        if (sala.jogadores.length === 0) {
            delete salas[nomeSala];
            console.log(`Sala ${nomeSala} removida.`);
        } else {
            io.to(nomeSala).emit('atualizarLobby', {
                jogadores: sala.jogadores,
                modo: sala.modo,
                estado: sala.estado
            });
            // Se estava em jogo, cancela a partida
            if (sala.estado === 'jogando') {
                sala.estado = 'aguardando';
                sala.jogadores.forEach(j => j.pronto = false);
                io.to(nomeSala).emit('fimDeJogo', { motivo: 'desconexao' });
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🃏 Motor de Truco rodando na porta ${PORT}`);
});
