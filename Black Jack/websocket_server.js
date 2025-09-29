const WebSocket = require('ws');
const http = require('http');
const os = require('os');

// Configuration
const PORT = 5555;
const HOST = '0.0.0.0';
const MAX_BET = 100000;
const START_BALANCE = 100;
const MIN_PLAYERS = 1;

// Game state
let players = new Map(); // nickname -> {ws, balance, hand, bet, status, result}
let gameState = {
    status: 'waiting', // waiting, betting, playing, dealer_turn, ended
    currentPlayer: null,
    dealerHand: [],
    revealDealer: false,
    deck: []
};

// Helper functions
function calculateHandValue(hand) {
    let value = 0;
    let aces = 0;
    
    for (const card of hand) {
        const v = card.split(' ')[0];
        if (['J', 'Q', 'K'].includes(v)) {
            value += 10;
        } else if (v === 'A') {
            value += 11;
            aces++;
        } else {
            value += parseInt(v);
        }
    }
    
    while (value > 21 && aces > 0) {
        value -= 10;
        aces--;
    }
    
    return value;
}

function createDeck() {
    const suits = ['Hearts', 'Diamonds', 'Clubs', 'Spades'];
    const values = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
    const deck = [];
    
    for (const suit of suits) {
        for (const value of values) {
            deck.push(`${value} of ${suit}`);
        }
    }
    
    // Shuffle the deck
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    
    return deck;
}

function drawCard() {
    if (gameState.deck.length === 0) {
        gameState.deck = createDeck();
    }
    return gameState.deck.pop();
}

function getPublicState() {
    const publicDealer = !gameState.revealDealer && gameState.dealerHand.length > 0
        ? ['[verdeckt]', ...gameState.dealerHand.slice(1)]
        : [...gameState.dealerHand];
    
    const dealerValue = gameState.revealDealer 
        ? calculateHandValue(gameState.dealerHand)
        : null;
    
    const playersState = {};
    const playerList = [];
    
    for (const [nickname, player] of players.entries()) {
        const playerState = {
            hand: player.hand || [],
            hand_value: calculateHandValue(player.hand || []),
            bet: player.bet || 0,
            balance: player.balance || START_BALANCE,
            status: player.status || 'waiting',
            result: player.result || '',
            is_current: gameState.currentPlayer === nickname
        };
        
        playersState[nickname] = playerState;
        playerList.push({
            nickname,
            ...playerState
        });
    }
    
    return {
        type: 'state',
        timestamp: Date.now(),
        rules: {
            max_bet: MAX_BET,
            start_balance: START_BALANCE,
            min_players: MIN_PLAYERS
        },
        players: playersState,
        player_list: playerList,
        game_state: {
            status: gameState.status,
            status_message: getStatusMessage(),
            current_player: gameState.currentPlayer,
            dealer_hand: publicDealer,
            dealer_value: dealerValue,
            player_count: players.size
        }
    };
}

function getStatusMessage() {
    switch (gameState.status) {
        case 'waiting':
            return `Warte auf Spieler (${players.size}/${MIN_PLAYERS} benötigt)`;
        case 'betting':
            return 'Einsatzphase - Bitte setzen';
        case 'playing':
            return `Dran: ${gameState.currentPlayer}`;
        case 'dealer_turn':
            return 'Dealer ist an der Reihe...';
        case 'ended':
            return 'Runde beendet';
        default:
            return '';
    }
}

function broadcastState() {
    const state = getPublicState();
    broadcast(state);
}

function broadcast(message, excludeWs = null) {
    const data = JSON.stringify(message);
    for (const [nickname, player] of players.entries()) {
        if (player.ws !== excludeWs && player.ws.readyState === WebSocket.OPEN) {
            player.ws.send(data);
        }
    }
}

function removePlayer(ws) {
    let leftPlayer = null;
    
    // Find the player
    for (const [nickname, player] of players.entries()) {
        if (player.ws === ws) {
            leftPlayer = { nickname, ...player };
            players.delete(nickname);
            break;
        }
    }
    
    if (!leftPlayer) return;
    
    console.log(`Player disconnected: ${leftPlayer.nickname}`);
    
    // Handle player leaving during game
    if (gameState.status === 'playing' && gameState.currentPlayer === leftPlayer.nickname) {
        nextPlayer();
    }
    
    // Notify other players
    broadcast({
        type: 'player_left',
        nickname: leftPlayer.nickname,
        message: `${leftPlayer.nickname} hat das Spiel verlassen`
    });
    
    broadcastState();
}

// Create HTTP server
const server = http.createServer((req, res) => {
    // Simple HTTP response for browser requests
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Blackjack Server läuft. Bitte verwende den Python-Client, um dich zu verbinden.');
});

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    console.log('New connection');
    
    // Send nickname request
    ws.send(JSON.stringify({
        type: 'nick_request',
        message: 'Bitte gib deinen Nickname ein:'
    }));
    
    // Handle messages
    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            
            // Handle different message types
            if (data.type === 'nickname') {
                handleNickname(ws, data.nickname);
            } else if (data.type === 'chat') {
                handleChat(ws, data.text);
            } else if (data.type === 'bet') {
                handleBet(ws, data.amount);
            } else if (data.type === 'hit') {
                handleHit(ws);
            } else if (data.type === 'stand') {
                handleStand(ws);
            } else if (data.type === 'new_round') {
                handleNewRound(ws);
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });
    
    // Handle disconnection
    ws.on('close', () => {
        console.log('Client disconnected');
        removePlayer(ws);
    });
    
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        removePlayer(ws);
    });
});

// Game logic functions
function handleNickname(ws, nickname) {
    // Clean up nickname
    nickname = (nickname || '').replace(/[^\w\s-]/g, '').trim().substring(0, 20);
    
    if (!nickname) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Ungültiger Nickname. Bitte verwende nur Buchstaben, Zahlen und Leerzeichen.'
        }));
        return;
    }
    
    if (players.has(nickname)) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'Nickname bereits vergeben. Bitte wähle einen anderen.'
        }));
        return;
    }
    
    // Add new player
    players.set(nickname, {
        ws,
        balance: START_BALANCE,
        hand: [],
        bet: 0,
        status: 'waiting',
        result: ''
    });
    
    console.log(`Player connected: ${nickname}`);
    
    // Send initial state to the new player
    ws.send(JSON.stringify(getPublicState()));
    
    // Notify other players
    broadcast({
        type: 'player_joined',
        nickname: nickname,
        message: `${nickname} ist dem Spiel beigetreten`
    }, ws);
    
    // Start game if enough players
    if (players.size >= MIN_PLAYERS && gameState.status === 'waiting') {
        gameState.status = 'betting';
    }
    
    broadcastState();
}

function handleChat(ws, text) {
    if (typeof text !== 'string' || text.length > 500) return;
    
    // Find the sender
    let sender = null;
    for (const [nickname, player] of players.entries()) {
        if (player.ws === ws) {
            sender = nickname;
            break;
        }
    }
    
    if (!sender) return;
    
    // Broadcast chat message
    broadcast({
        type: 'chat',
        from: sender,
        text: text,
        timestamp: Date.now()
    });
}

function handleBet(ws, amount) {
    // Find the player
    let player = null;
    let nickname = null;
    
    for (const [n, p] of players.entries()) {
        if (p.ws === ws) {
            player = p;
            nickname = n;
            break;
        }
    }
    
    if (!player || gameState.status !== 'betting') return;
    
    amount = parseInt(amount);
    if (isNaN(amount) || amount <= 0 || amount > player.balance || amount > MAX_BET) {
        return;
    }
    
    player.bet = amount;
    player.status = 'ready';
    
    // Check if all players have bet
    const allReady = Array.from(players.values()).every(p => 
        p.status === 'ready' || p.status === 'playing' || p.status === 'stand' || p.status === 'bust'
    );
    
    if (allReady) {
        startRound();
    }
    
    broadcastState();
}

function startRound() {
    // Initialize game state
    gameState.deck = createDeck();
    gameState.dealerHand = [drawCard(), drawCard()];
    gameState.revealDealer = false;
    gameState.status = 'playing';
    
    // Deal cards to players
    const activePlayers = [];
    for (const [nickname, player] of players.entries()) {
        if (player.status === 'ready' && player.bet > 0) {
            player.hand = [drawCard(), drawCard()];
            player.status = 'playing';
            player.result = '';
            activePlayers.push(nickname);
        }
    }
    
    if (activePlayers.length === 0) {
        gameState.status = 'waiting';
        return;
    }
    
    // Set first player
    gameState.currentPlayer = activePlayers[0];
    
    broadcastState();
}

function handleHit(ws) {
    // Find the player
    let player = null;
    let nickname = null;
    
    for (const [n, p] of players.entries()) {
        if (p.ws === ws) {
            player = p;
            nickname = n;
            break;
        }
    }
    
    if (!player || gameState.status !== 'playing' || gameState.currentPlayer !== nickname) {
        return;
    }
    
    // Draw card
    player.hand.push(drawCard());
    
    // Check for bust
    const value = calculateHandValue(player.hand);
    if (value > 21) {
        player.status = 'bust';
        player.result = 'Bust!';
        player.balance -= player.bet;
        nextPlayer();
    }
    
    broadcastState();
}

function handleStand(ws) {
    // Find the player
    let player = null;
    let nickname = null;
    
    for (const [n, p] of players.entries()) {
        if (p.ws === ws) {
            player = p;
            nickname = n;
            break;
        }
    }
    
    if (!player || gameState.status !== 'playing' || gameState.currentPlayer !== nickname) {
        return;
    }
    
    player.status = 'stand';
    nextPlayer();
}

function nextPlayer() {
    const playing = [];
    for (const [nickname, player] of players.entries()) {
        if (player.status === 'playing') {
            playing.push(nickname);
        }
    }
    
    if (playing.length === 0) {
        gameState.status = 'dealer_turn';
        gameState.revealDealer = true;
        dealerPlay();
    } else {
        const currentIdx = playing.indexOf(gameState.currentPlayer);
        const nextIdx = (currentIdx + 1) % playing.length;
        gameState.currentPlayer = playing[nextIdx];
        broadcastState();
    }
}

async function dealerPlay() {
    gameState.status = 'dealer_turn';
    gameState.revealDealer = true;
    broadcastState();
    
    // Dealer draws until 17 or higher
    while (calculateHandValue(gameState.dealerHand) < 17) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        gameState.dealerHand.push(drawCard());
        broadcastState();
    }
    
    determineWinners();
}

function determineWinners() {
    const dealerValue = calculateHandValue(gameState.dealerHand);
    const dealerBust = dealerValue > 21;
    
    for (const [nickname, player] of players.entries()) {
        if (player.status !== 'bust' && player.status !== 'stand') continue;
        
        const playerValue = calculateHandValue(player.hand);
        
        if (dealerBust || playerValue > dealerValue) {
            player.result = 'Gewonnen!';
            player.balance += player.bet * 2; // Win double the bet
        } else if (playerValue === dealerValue) {
            player.result = 'Unentschieden';
            player.balance += player.bet; // Return bet
        } else {
            player.result = 'Verloren';
            // Bet is already subtracted on bust
            if (player.status !== 'bust') {
                player.balance -= player.bet;
            }
        }
    }
    
    gameState.status = 'ended';
    broadcastState();
}

function handleNewRound(ws) {
    // Find the player
    let player = null;
    
    for (const p of players.values()) {
        if (p.ws === ws) {
            player = p;
            break;
        }
    }
    
    if (!player || gameState.status !== 'ended') return;
    
    // Reset player for new round
    player.status = 'waiting';
    player.hand = [];
    player.bet = 0;
    player.result = '';
    
    // If all players are ready, start new betting round
    const allWaiting = Array.from(players.values()).every(p => 
        p.status === 'waiting' || p.status === 'ready'
    );
    
    if (allWaiting) {
        gameState.status = 'betting';
        gameState.dealerHand = [];
        gameState.revealDealer = false;
        gameState.currentPlayer = null;
    }
    
    broadcastState();
}

// Function to display connection information
function displayConnectionInfo(port) {
    const interfaces = os.networkInterfaces();
    
    console.log('\n' + '='.repeat(50));
    console.log('  🃏  BLACKJACK SERVER GESTARTET  🃏');
    console.log('='.repeat(50));
    
    console.log('\n🔹 LOKALER ZUGRIFF:');
    console.log(`   http://localhost:${port}`);
    
    console.log('\n🔹 NETZWERK-ZUGRIFF (andere Geräte im gleichen WLAN):');
    
    // Display all active network interfaces
    let foundAddress = false;
    Object.keys(interfaces).forEach(iface => {
        interfaces[iface].forEach(details => {
            // Check for IPv4 and non-internal addresses
            if (details.family === 'IPv4' && !details.internal) {
                console.log(`   http://${details.address}:${port}  (${iface})`);
                foundAddress = true;
            }
        });
    });
    
    if (!foundAddress) {
        console.log('   Keine Netzwerkverbindung gefunden!');
    }
    
    console.log('\n🔹 SO VERBINDEN SICH ANDERE SPIELER:');
    console.log('   1. Auf dem gleichen WLAN-Netzwerk anmelden');
    console.log('   2. Im Client die oben angezeigte IP-Adresse eingeben');
    console.log('   3. Einen einzigartigen Benutzernamen wählen');
    console.log('\n' + '='.repeat(50));
    console.log('   Warte auf Spieler... (Drücke STRG+C zum Beenden)');
    console.log('='.repeat(50) + '\n');
}

// Start the server
server.listen(PORT, HOST, () => {
    displayConnectionInfo(PORT);
});

// Handle process termination
process.on('SIGINT', () => {
    console.log('\nShutting down server...');
    // Notify all players
    for (const player of players.values()) {
        try {
            player.ws.send(JSON.stringify({
                type: 'server_message',
                message: 'Server wird heruntergefahren. Auf Wiedersehen!'
            }));
            player.ws.close();
        } catch (e) {
            console.error('Error disconnecting player:', e);
        }
    }
    process.exit();
});
